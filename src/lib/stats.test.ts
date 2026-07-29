// Delivery statistics, checked against ONE question: can the store this installation
// configured actually be OBSERVED to say what the report claims?
//
// THE DEFECT THIS FILE IS WRITTEN AGAINST is not a wrong number. It is a number that
// cannot detect what it claims: a count of rows nobody finished reading, published as a
// total; a percentage computed over an arbitrary prefix of a table, published as a rate;
// a `0` where the honest answer is "the store has no way to answer that". The seam
// publishes no period-scoped aggregate, so EVERY figure here comes from a bounded
// client-side enumeration — which means every one of them can be wrong in exactly that
// way, and the cases below are mostly about that boundary rather than about arithmetic.
//
// SO EVERY REFUSAL CASE IS PAIRED WITH A POSITIVE CONTROL: the same field, on the same
// seeded rows, measured through a store that CAN answer it. A suite in which every field
// is null passes vacuously, and that is the failure mode this file guards against.
//
// AND THE MEASUREMENT SUITE IS RUN TWICE, once against the local SQLite store and once
// against an Emails API store over real HTTP, with the SAME rows behind both and the SAME
// numbers required out of both. That pairing is the actual claim of this change: the two
// deleted sibling modules differed by WHO RAN THE READ, and a difference in who runs a
// read must not be a difference in what a statistic means.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "../db/database.js";
import { createProvider } from "../db/providers.local.js";
import { createSentEmailLedger } from "./sent-ledger.local.js";
import { createEvent } from "../db/events.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { startV1StoreApi, type V1StoreApi } from "../test-support/v1-store-api.js";
import { statusGapClass, statusReasonCode } from "./status-availability.js";
import { formatStatsTable, getLocalStats, type StatsReport } from "./stats.js";
import type { EmailStore } from "../store/email-store.js";
import type { EventType } from "../types/index.js";
import type { Outcome, Refusal } from "../store/outcome.js";
import type { MessageListRecord, Page, ResourceRow } from "../store/records.js";

const DB_PATH_ENV = "EMAILS_DB_PATH";
const TOUCHED_ENV = [
  DB_PATH_ENV,
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
] as const;

let saved: Array<readonly [string, string | undefined]> = [];
let db: Database;
let api: V1StoreApi | null = null;

beforeEach(() => {
  saved = TOUCHED_ENV.map((key) => [key, process.env[key]] as const);
  for (const key of TOUCHED_ENV) delete process.env[key];
  process.env[DB_PATH_ENV] = ":memory:";
  resetDatabase();
  db = getDatabase();
});

afterEach(() => {
  if (api !== null) {
    api.stop();
    api = null;
  }
  closeDatabase();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const DAY = 24 * 60 * 60 * 1000;

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/**
 * Two providers, two outbound rows in the legacy ledger, and delivery events split
 * across both providers and both sides of a 30-day window.
 *
 * The two events dated 60 and 90 days back are load-bearing: without rows OUTSIDE the
 * window the windowed and unwindowed counts would be identical, and the window predicate
 * could be deleted with this suite still green.
 */
async function seed(): Promise<{ alpha: string; beta: string }> {
  const alpha = createProvider({ name: "alpha", type: "sandbox" }, db).id;
  const beta = createProvider({ name: "beta", type: "sandbox" }, db).id;

  // The legacy provider-scoped ledger. `createEmail` stamps `sent_at` from the clock, so
  // these are inside any window; the out-of-window outbound row is written through the
  // seam below, where the timestamp is an input.
  await createSentEmailLedger(alpha, { from: "a@x.test", to: "one@y.test", subject: "one", text: "t" }, "pm-1", db);
  await createSentEmailLedger(beta, { from: "b@x.test", to: "two@y.test", subject: "two", text: "t" }, "pm-2", db);

  const events: Array<[string, EventType, number]> = [
    [alpha, "delivered", 1 * DAY],
    [alpha, "delivered", 2 * DAY],
    [alpha, "opened", 3 * DAY],
    [alpha, "bounced", 4 * DAY],
    [beta, "delivered", 5 * DAY],
    [beta, "complained", 6 * DAY],
    [beta, "clicked", 7 * DAY],
    [alpha, "delivered", 60 * DAY],
    [beta, "bounced", 90 * DAY],
  ];
  for (const [provider, type, age] of events) {
    await createEvent({ provider_id: provider, type, recipient: "r@y.test", occurred_at: isoAgo(age) }, db);
  }
  return { alpha, beta };
}

/**
 * Two outbound rows in the UNIFIED table: one inside the window, one well outside it.
 *
 * Seeded through the seam on purpose. The deleted local sibling counted only the legacy
 * ledger, so a fixture that used `createEmail` alone could not tell the corrected
 * outbound population from the old one — `createMessage` with an outbound direction is
 * what puts a row in the other half of the union (src/store-sqlite/messages.ts).
 */
async function seedUnifiedOutbound(store: EmailStore): Promise<void> {
  const inWindow = await store.messages.createMessage({
    from_addr: "c@x.test",
    to_addrs: ["three@y.test"],
    subject: "three",
    direction: "outbound",
    received_at: isoAgo(2 * DAY),
  });
  expect(inWindow.ok, "fixture: the in-window outbound row must really be written").toBe(true);
  const outOfWindow = await store.messages.createMessage({
    from_addr: "d@x.test",
    to_addrs: ["four@y.test"],
    subject: "four",
    direction: "outbound",
    received_at: isoAgo(120 * DAY),
  });
  expect(outOfWindow.ok, "fixture: the out-of-window outbound row must really be written").toBe(true);
  // AN INBOUND ROW INSIDE THE WINDOW, and it is here because of a mutation check rather
  // than for symmetry: with only outbound rows seeded, deleting the outbound scoping from
  // the message read changed no assertion in this file, so the scoping was untested. This
  // row makes `sent` over-count the moment that filter is dropped.
  const inbound = await store.messages.createMessage({
    from_addr: "sender@outside.test",
    to_addrs: ["ops@x.test"],
    subject: "received, not sent",
    direction: "inbound",
    received_at: isoAgo(DAY),
  });
  expect(inbound.ok, "fixture: the inbound row must really be written").toBe(true);
}

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite (test)" });
}

/** The same rows, served over real HTTP by the service's own router. */
function httpStore(): EmailStore {
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "fixture" }) });
  return createHttpEmailStore({ baseUrl: api.baseUrl, credential: api.apiKey });
}

/** A store that is healthy except for the one repository handed in. */
function storeExcept(base: EmailStore, patch: Partial<EmailStore>): EmailStore {
  return { ...base, ...patch };
}

function refusal(code: Refusal["code"], status: Refusal["status"], message: string): Refusal {
  return { ok: false, code, message, status };
}

function eventRows(count: number, type = "delivered"): ResourceRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `ev-${String(index).padStart(6, "0")}`,
    provider_id: "alpha",
    type,
    recipient: "r@y.test",
    metadata: "{}",
    occurred_at: isoAgo(DAY),
    created_at: isoAgo(DAY),
  }));
}

function messageRows(count: number): MessageListRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${String(index).padStart(6, "0")}`,
    direction: "outbound",
    from_addr: "a@x.test",
    to_addrs: ["b@y.test"],
    cc_addrs: [],
    subject: `s${index}`,
    status: "sent",
    provider_message_id: null,
    message_id: null,
    in_reply_to: null,
    received_at: isoAgo(DAY),
    is_read: true,
    is_starred: false,
    labels: [],
    source_id: null,
    send_state: "none",
    send_started_at: null,
    created_at: isoAgo(DAY),
    updated_at: isoAgo(DAY),
    snippet: null,
    attachment_count: 0,
    policy_denial: null,
  }));
}

/**
 * An offset list that serves `pageRows` at a time NO MATTER what limit is asked for, and
 * ends with an empty page. This is the shape of a store that clamps below the requested
 * limit — indistinguishable, page for page, from a small table.
 */
function shortPagedEvents(all: ResourceRow[], pageRows: number) {
  return async (opts?: { limit?: number; offset?: number }): Promise<Outcome<ResourceRow[]>> => {
    const offset = opts?.offset ?? 0;
    return { ok: true, value: all.slice(offset, offset + pageRows) };
  };
}

/**
 * A message list whose cursor NEVER runs out, serving DISTINCT rows every page.
 *
 * Distinct on purpose: identical pages would be caught as duplicates instead, which is a
 * different bound with a different reason, and this fixture is for the budget one.
 */
function endlessMessagePages(): () => Promise<Outcome<Page<MessageListRecord>>> {
  let served = 0;
  return async () => {
    const items = messageRows(500).map((row) => ({ ...row, id: `${row.id}-p${served}` }));
    served += 1;
    return { ok: true, value: { items, next_cursor: `page-${served}` } };
  };
}

// ── the two stores, same rows, same numbers ────────────────────────────────────

const IMPLEMENTATIONS: Array<[string, () => Promise<EmailStore>]> = [
  [
    "the local SQLite store",
    async () => {
      const store = sqliteStore();
      await seedUnifiedOutbound(store);
      return store;
    },
  ],
  [
    "an Emails API store over HTTP",
    async () => {
      await seedUnifiedOutbound(sqliteStore());
      return httpStore();
    },
  ],
];

describe.each(IMPLEMENTATIONS)("delivery statistics measured through %s", (_label, open) => {
  it("POSITIVE CONTROL: every count is a total, every rate is a number, and nothing is refused", async () => {
    await seed();
    const store = await open();
    const stats = await getLocalStats(undefined, "30d", store);

    // Three outbound rows inside the window: two in the legacy ledger, one in the unified
    // table. The fourth unified row is 120 days old and must not be counted.
    expect(stats.sent).toBe(3);
    expect(stats.delivered).toBe(3);
    expect(stats.bounced).toBe(1);
    expect(stats.complained).toBe(1);
    expect(stats.opened).toBe(1);
    expect(stats.clicked).toBe(1);
    expect(stats.delivery_rate).toBe(100);
    expect(stats.bounce_rate).toBe(33.3);
    expect(stats.open_rate).toBe(33.3);
    // Nothing may be null in the healthy case: a report where everything is null is the
    // vacuous pass this file exists to prevent.
    expect(stats.gaps).toEqual({});
    expect(stats.sent_availability.complete).toBe(true);
    expect(stats.events_availability.complete).toBe(true);
    expect(stats.sent_availability.basis).toBe("client_enumeration");
    expect(stats.events_availability.basis).toBe("client_enumeration");
    // Provenance names the store that answered, so a report cannot be read as coming from
    // somewhere it did not.
    expect(stats.sent_availability.source).toContain(store.descriptor.kind);
    expect(stats.events_availability.source).toContain(store.descriptor.kind);
  });

  it("applies the period window to both inventories rather than counting the whole table", async () => {
    await seed();
    const store = await open();
    // Three days: only the 1d and 2d delivered events; the outbound side keeps the two
    // ledger rows stamped now plus the 2d unified row.
    const narrow = await getLocalStats(undefined, "3d", store);
    expect(narrow.delivered).toBe(2);
    expect(narrow.bounced).toBe(0);
    expect(narrow.clicked).toBe(0);
    expect(narrow.sent).toBe(3);

    // A year admits the rows a 30-day window excluded, in BOTH inventories.
    const wide = await getLocalStats(undefined, "365d", store);
    expect(wide.delivered).toBe(4);
    expect(wide.bounced).toBe(2);
    expect(wide.sent).toBe(4);
  });

  it("refuses the SENT count when a provider is named, and does not answer with the unfiltered one", async () => {
    const { alpha } = await seed();
    const store = await open();
    const stats = await getLocalStats(alpha, "30d", store);

    // The event counts ARE provider-scoped: those rows carry a provider column.
    expect(stats.delivered).toBe(2);
    expect(stats.bounced).toBe(1);
    expect(stats.opened).toBe(1);
    expect(stats.complained).toBe(0);
    expect(stats.provider_id).toBe(alpha);

    // `sent` is not, and the answer is a refusal rather than the unscoped number — which
    // is 3, asserted above, so this also proves it was not quietly substituted.
    expect(stats.sent).toBeNull();
    expect(stats.gaps["sent"]?.reason).toContain("no_provider_on_message_stream");
    expect(statusGapClass(stats.gaps["sent"]?.reason)).toBe("structural");

    // The two rates that divide by it go with it. `open_rate` does not: both of its
    // operands are event counts.
    expect(stats.delivery_rate).toBeNull();
    expect(stats.bounce_rate).toBeNull();
    expect(stats.open_rate).toBe(50);
    expect(Object.keys(stats.gaps).sort()).toEqual(["bounce_rate", "delivery_rate", "sent"]);
  });

  it("reports a MEASURED zero as zero, and refuses only the rate that has no denominator", async () => {
    // Kept as its own case so that "never publish a zero" is not mistaken for "never
    // publish a measured zero". Nothing is seeded except the one unified outbound row.
    const store = await open();
    const stats = await getLocalStats(undefined, "30d", store);
    expect(stats.delivered).toBe(0);
    expect(stats.bounced).toBe(0);
    expect(stats.sent).toBe(1);
    expect(stats.events_availability.available).toBe(true);
    expect(stats.events_availability.complete).toBe(true);
    // 0/1 is a real rate; opened/delivered is 0/0 and is not.
    expect(stats.delivery_rate).toBe(0);
    expect(stats.open_rate).toBeNull();
    expect(stats.gaps["open_rate"]?.reason).toContain("no_denominator");
  });
});

// ── refusals and faults: nothing was read, so nothing is published ─────────────

describe("a read that did not happen is never published as a zero", () => {
  it("turns a declared-false capability into nulls with a structural reason", async () => {
    await seed();
    const base = sqliteStore();
    await seedUnifiedOutbound(base);
    const store = storeExcept(base, {
      events: {
        ...base.events,
        list: async () => refusal("capability_unavailable", 501, "this store cannot list events"),
      },
    });
    const stats = await getLocalStats(undefined, "30d", store);

    for (const field of ["delivered", "bounced", "complained", "opened", "clicked"] as const) {
      expect(stats[field], `${field} must be null, not 0`).toBeNull();
      expect(statusReasonCode(stats.gaps[field]?.reason)).toBe("not_modelled_on_store");
    }
    // POSITIVE CONTROL inside the same report: the inventory that DID answer still does.
    expect(stats.sent).toBe(3);
    expect(stats.sent_availability.available).toBe(true);
  });

  it("classifies a NON-capability refusal as a live failure rather than a limitation", async () => {
    const base = sqliteStore();
    const store = storeExcept(base, {
      events: { ...base.events, list: async () => refusal("invalid_input", 422, "unknown filter column") },
    });
    const stats = await getLocalStats(undefined, "30d", store);
    expect(stats.delivered).toBeNull();
    expect(statusReasonCode(stats.events_availability.reason)).toBe("source_unreachable");
    expect(statusGapClass(stats.events_availability.reason)).toBe("failure");
  });

  it("turns a thrown transport fault into nulls carrying the fault text", async () => {
    const base = sqliteStore();
    const store = storeExcept(base, {
      events: {
        ...base.events,
        list: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:9");
        },
      },
      messages: {
        ...base.messages,
        listMessages: async () => {
          throw new Error("socket hang up");
        },
      },
    });
    const stats = await getLocalStats(undefined, "30d", store);
    expect(stats.delivered).toBeNull();
    expect(stats.sent).toBeNull();
    expect(stats.events_availability.reason).toContain("ECONNREFUSED");
    expect(stats.gaps["sent"]?.reason).toContain("socket hang up");
    expect(stats.delivery_rate).toBeNull();
  });

  it("refuses the sent count when the message list is behind a capability the store denies", async () => {
    await seed();
    const base = sqliteStore();
    const store = storeExcept(base, {
      messages: {
        ...base.messages,
        listMessages: async () => refusal("capability_unavailable", 501, "keysetPagination is unavailable"),
      },
    });
    const stats = await getLocalStats(undefined, "30d", store);
    expect(stats.sent).toBeNull();
    expect(statusReasonCode(stats.gaps["sent"]?.reason)).toBe("not_modelled_on_store");
    // POSITIVE CONTROL: the event counts are unaffected and are still totals.
    expect(stats.delivered).toBe(3);
    expect(stats.events_availability.complete).toBe(true);
  });

  it("reports a contradictory storage configuration instead of throwing", async () => {
    // `emails stats` must not itself fail while trying to say why it cannot measure.
    process.env["EMAILS_DB_PATH"] = "/tmp/emails-stats-contradiction.db";
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://mail.example.test";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "k";
    const stats = await getLocalStats(undefined, "30d");
    expect(stats.sent).toBeNull();
    expect(stats.delivered).toBeNull();
    expect(stats.delivery_rate).toBeNull();
    expect(statusReasonCode(stats.gaps["sent"]?.reason)).toBe("source_unreachable");
    expect(stats.gaps["sent"]?.reason).toContain("store_unresolved");
    // The setting KEYS are named so an operator can act; no value is echoed.
    expect(stats.gaps["sent"]?.reason).toContain("EMAILS_SELF_HOSTED_URL");
    expect(stats.gaps["sent"]?.reason).not.toContain("mail.example.test");
  });
});

// ── truncation: a bounded read is a lower bound, never a total ─────────────────

describe("a bounded read is published as a lower bound", () => {
  it("bounds the event counts when the page budget runs out, and does NOT report zero", async () => {
    const base = sqliteStore();
    // A list that never returns an empty page: the enumeration can only stop by
    // exhausting its budget.
    const endless = eventRows(100_000);
    const store = storeExcept(base, {
      events: { ...base.events, list: shortPagedEvents(endless, 500) },
    });
    const stats = await getLocalStats(undefined, "30d", store);

    expect(stats.delivered).toBeGreaterThan(0);
    expect(stats.events_availability.available).toBe(true);
    expect(stats.events_availability.complete).toBe(false);
    expect(statusReasonCode(stats.events_availability.reason)).toBe("enumeration_cap_exceeded");
    expect(statusGapClass(stats.events_availability.reason)).toBe("bound");
    // A ratio of a bounded numerator to any denominator is not a rate.
    expect(stats.open_rate).toBeNull();
    expect(stats.delivery_rate).toBeNull();
    expect(statusReasonCode(stats.gaps["delivery_rate"]?.reason)).toBe("enumeration_cap_exceeded");
  });

  it("A SHORT PAGE IS NOT THE END OF THE TABLE", async () => {
    // The whole defect in one case: a store that serves 200 rows for a 500-row request is
    // indistinguishable, page for page, from a table with 200 rows in it. If a short page
    // ended the enumeration this would count 200 and publish it as a total.
    const base = sqliteStore();
    const all = eventRows(700);
    const store = storeExcept(base, {
      events: { ...base.events, list: shortPagedEvents(all, 200) },
    });
    const stats = await getLocalStats(undefined, "30d", store);
    expect(stats.delivered).toBe(700);
    expect(stats.events_availability.complete).toBe(true);
  });

  it("keeps paging a SHORT message page that still carries a cursor", async () => {
    const base = sqliteStore();
    const all = messageRows(450);
    let calls = 0;
    const store = storeExcept(base, {
      messages: {
        ...base.messages,
        listMessages: async (opts): Promise<Outcome<Page<MessageListRecord>>> => {
          // 150 rows per page — far short of the 500 asked for — with an honest cursor.
          const offset = opts?.cursor === undefined ? 0 : Number(opts.cursor);
          calls += 1;
          const items = all.slice(offset, offset + 150);
          const next = offset + items.length;
          return { ok: true, value: { items, next_cursor: next >= all.length ? null : String(next) } };
        },
      },
    });
    const stats = await getLocalStats(undefined, "30d", store);
    expect(stats.sent).toBe(450);
    expect(stats.sent_availability.complete).toBe(true);
    expect(calls).toBe(3);
  });

  it("bounds the sent count when the message cursor never runs out", async () => {
    const base = sqliteStore();
    const store = storeExcept(base, {
      messages: { ...base.messages, listMessages: endlessMessagePages() },
    });
    const stats = await getLocalStats(undefined, "30d", store);
    // 40 pages of 500 distinct rows: a real number, and explicitly NOT a total.
    expect(stats.sent).toBe(20_000);
    expect(stats.sent_availability.available).toBe(true);
    expect(stats.sent_availability.complete).toBe(false);
    expect(statusReasonCode(stats.sent_availability.reason)).toBe("enumeration_cap_exceeded");
    expect(statusReasonCode(stats.gaps["delivery_rate"]?.reason)).toBe("enumeration_cap_exceeded");
    expect(stats.delivery_rate).toBeNull();
    expect(stats.bounce_rate).toBeNull();
  });

  it("treats a repeated message row as proof that rows were skipped", async () => {
    const base = sqliteStore();
    const page = messageRows(4);
    let served = 0;
    const store = storeExcept(base, {
      messages: {
        ...base.messages,
        listMessages: async (): Promise<Outcome<Page<MessageListRecord>>> => {
          served += 1;
          // The same four rows twice, then the end. A total keyset order cannot do that,
          // so the count is a lower bound even though the end WAS reached.
          return { ok: true, value: { items: page, next_cursor: served >= 2 ? null : "next" } };
        },
      },
    });
    const stats = await getLocalStats(undefined, "30d", store);
    expect(stats.sent).toBe(4);
    expect(stats.sent_availability.complete).toBe(false);
    expect(statusReasonCode(stats.sent_availability.reason)).toBe("enumeration_unstable");
    expect(stats.delivery_rate).toBeNull();
  });

  it("does not claim the end of the stream when a store promises more rows and serves none", async () => {
    // A contract violation (`next_cursor` non-null with an empty page) must terminate
    // without looping AND without being read as the end of the table.
    const base = sqliteStore();
    const store = storeExcept(base, {
      messages: {
        ...base.messages,
        listMessages: async (): Promise<Outcome<Page<MessageListRecord>>> => ({
          ok: true,
          value: { items: [], next_cursor: "more-really" },
        }),
      },
    });
    const stats = await getLocalStats(undefined, "30d", store);
    expect(stats.sent).toBe(0);
    expect(stats.sent_availability.complete).toBe(false);
    expect(stats.delivery_rate).toBeNull();
  });

  it("bounds the event counts when a row's timestamp cannot be placed in the window", async () => {
    const base = sqliteStore();
    const rows: ResourceRow[] = [
      ...eventRows(3),
      { id: "ev-bad", provider_id: "alpha", type: "delivered", occurred_at: "not a timestamp" },
    ];
    const store = storeExcept(base, {
      events: { ...base.events, list: shortPagedEvents(rows, 500) },
    });
    const stats = await getLocalStats(undefined, "30d", store);
    // The three readable rows are counted; the fourth is neither counted nor ignored.
    expect(stats.delivered).toBe(3);
    expect(stats.events_availability.complete).toBe(false);
    expect(stats.events_availability.reason).toContain("unreadable occurred_at");
    expect(stats.open_rate).toBeNull();
  });
});

// ── rates ─────────────────────────────────────────────────────────────────────

describe("a rate is published only when every count it divides is a total", () => {
  it("refuses a rate whose DENOMINATOR is a lower bound even though its numerator is exact", async () => {
    await seed();
    const base = sqliteStore();
    const store = storeExcept(base, {
      messages: { ...base.messages, listMessages: endlessMessagePages() },
    });
    const stats = await getLocalStats(undefined, "30d", store);
    expect(stats.events_availability.complete).toBe(true);
    expect(stats.delivered).toBe(3);
    expect(stats.sent_availability.complete).toBe(false);
    expect(stats.delivery_rate).toBeNull();
    // POSITIVE CONTROL: the rate that does NOT divide by the bounded count survives.
    expect(stats.open_rate).toBe(33.3);
  });

  it("refuses a zero-denominator rate instead of reporting it as 0%", async () => {
    // The deleted local sibling returned 0 here, i.e. "0% of your mail was delivered" for
    // an installation that has sent nothing at all.
    const base = sqliteStore();
    const store = storeExcept(base, {
      messages: {
        ...base.messages,
        listMessages: async (): Promise<Outcome<Page<MessageListRecord>>> => ({
          ok: true,
          value: { items: [], next_cursor: null },
        }),
      },
    });
    const stats = await getLocalStats(undefined, "30d", store);
    expect(stats.sent).toBe(0);
    expect(stats.sent_availability.complete).toBe(true);
    expect(stats.delivery_rate).toBeNull();
    expect(stats.bounce_rate).toBeNull();
    expect(statusReasonCode(stats.gaps["delivery_rate"]?.reason)).toBe("not_applicable");
    expect(stats.gaps["delivery_rate"]?.reason).toContain("no_denominator");
  });
});

// ── the renderer ──────────────────────────────────────────────────────────────

const AVAILABLE = {
  available: true as const,
  reason: null,
  source: "s:events",
  basis: "client_enumeration" as const,
  complete: true,
};

function unavailable(reason: string, source: string) {
  return { available: false as const, reason, source, basis: null, complete: null };
}

function report(over: Partial<StatsReport> = {}): StatsReport {
  return {
    provider_id: "test-provider",
    period: "30d",
    sent: 100,
    delivered: 95,
    bounced: 3,
    complained: 1,
    opened: 60,
    clicked: 20,
    delivery_rate: 95,
    bounce_rate: 3,
    open_rate: 63.2,
    sent_availability: { ...AVAILABLE, source: "s:messages" },
    events_availability: AVAILABLE,
    gaps: {},
    ...over,
  };
}

describe("formatStatsTable", () => {
  it("PRESERVED: an exact report still renders as plain counts and percentages", () => {
    // A parity guard rather than a change detector: the table's labels, its period line
    // and its bare numbers are the shape operators and scripts already read.
    const output = formatStatsTable(report());
    expect(output).toContain("100");
    expect(output).toContain("95");
    expect(output).toContain("Sent");
    expect(output).toContain("Delivered");
    expect(output).toContain("Bounced");
    expect(output).toContain("30d");
    expect(output).toContain("(95.0%)");
    // No bound marker anywhere, because nothing here is a bound.
    expect(output).not.toContain("≥");
    // ...and no footer either: a report with nothing to warn about must not print a
    // warning section, or the section stops carrying information.
    expect(output).not.toContain("Lower bounds");
    expect(output).not.toContain("Not measured");
  });

  it("marks a LOWER BOUND with ≥ instead of printing it as a total", () => {
    const bound = "enumeration_cap_exceeded:40 pages — the count is a lower bound, not a total";
    const output = formatStatsTable(report({
      sent: 500,
      sent_availability: {
        available: true,
        reason: bound,
        source: "s:messages",
        basis: "client_enumeration",
        complete: false,
      },
      delivery_rate: null,
      gaps: { delivery_rate: unavailable(bound, "s:messages") },
    }));
    expect(output).toContain("≥500");
    // The bound must not ALSO appear as a bare total on its own line.
    expect(output).not.toMatch(/Sent:\s+500/);
    expect(output).toContain("rate unavailable");
    expect(output).toContain("enumeration_cap_exceeded");
    // THE REASON REACHES THE OPERATOR, not just the marker. A `≥` says a number is not a
    // total; only the footer says why, and a formatter that dropped the note would still
    // satisfy every assertion above.
    expect(output).toContain("Lower bounds");
    expect(output).toContain("outbound messages: enumeration_cap_exceeded");
    expect(output).toContain("the count is a lower bound, not a total");
  });

  it("prints an unmeasured count as its reason, never as a number", () => {
    const reason = "not_modelled_on_store:no_provider_on_message_stream — no provider on the stream";
    const output = formatStatsTable(report({
      sent: null,
      sent_availability: unavailable(reason, "s:messages"),
      delivery_rate: null,
      bounce_rate: null,
      gaps: { sent: unavailable(reason, "s:messages") },
    }));
    expect(output).toContain("unavailable");
    expect(output).toContain("no_provider_on_message_stream");
    expect(output).not.toMatch(/Sent:\s+\d/);
    expect(output).toContain("Not measured (1)");
    expect(output).toContain("sent: not_modelled_on_store");
    // The FIELD line carries the code and nothing more; the prose belongs to the footer,
    // once. Printing the whole reason on every field made the real command's table
    // unreadable when nine fields shared one cause.
    expect(output).toMatch(/Sent:\s+unavailable \(not_modelled_on_store\)$/m);
    expect(output.match(/no provider on the stream/g)).toHaveLength(1);
  });

  it("prints the truncation note for a bounded EVENT read, which no count line carries", async () => {
    // The footer is the only place a bounded event enumeration can be explained: the three
    // event count lines print `≥N` and the rate lines print their own gap, so a formatter
    // that dropped the inventory's reason would lose it entirely.
    const base = sqliteStore();
    const store = storeExcept(base, {
      events: { ...base.events, list: shortPagedEvents(eventRows(100_000), 500) },
    });
    const output = formatStatsTable(await getLocalStats(undefined, "30d", store));
    expect(output).toContain("Lower bounds");
    expect(output).toContain("delivery events: enumeration_cap_exceeded");
    expect(output).toContain("lower bounds, not totals");
  });
});
