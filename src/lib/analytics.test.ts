// Analytics, checked against ONE question: can the report be observed to say only what
// the store was actually asked and actually answered?
//
// The old local arm was four SQL aggregates, so every number it published was a TOTAL by
// construction. The seam has no aggregate, so every number is now a client-side bounded
// enumeration — and the failure this file is written against is not a wrong count. It is
// a count that CANNOT DETECT ITS OWN INCOMPLETENESS: a `0` from a refused read, a `[]`
// from a truncated one, a green delivery rate computed from two lower bounds. Each of
// those is indistinguishable from good news at the point of use.
//
// So the shape of every case below is: seed real rows, read them through a real store as
// a POSITIVE CONTROL, then degrade exactly one thing about the store and assert the
// report SAYS SO. A suite in which every field is null passes vacuously; a suite in which
// every field is a number cannot tell a total from a lower bound. Both are checked here.
//
// The stores that refuse, truncate, or ignore a filter are INJECTED. There is no way to
// reach a capability refusal, an exhausted page budget, or a server that drops an equality
// filter from a healthy local database — and faking the ANSWER rather than the STORE would
// test the test.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.local.js";
import { createSentEmailLedger } from "./sent-ledger.local.js";
import { createEvent } from "../db/events.local.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { startV1StoreApi, type V1StoreApi } from "../test-support/v1-store-api.js";
import { formatAnalytics, getAnalytics, type AnalyticsData } from "./analytics.js";
import type { EmailStore } from "../store/email-store.js";
import type { MessageListRecord, Page, ResourceRow } from "../store/records.js";
import type { Outcome } from "../store/outcome.js";

const DB_PATH_ENV = "EMAILS_DB_PATH";
const TOUCHED_ENV = [
  DB_PATH_ENV,
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
] as const;

let saved: Array<readonly [string, string | undefined]> = [];

beforeEach(() => {
  saved = TOUCHED_ENV.map((key) => [key, process.env[key]] as const);
  for (const key of TOUCHED_ENV) delete process.env[key];
  process.env[DB_PATH_ENV] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ── fixture ──────────────────────────────────────────────────────────────────

/**
 * Two send days inside the window, one message outside it, and delivery events for both
 * in-window days.
 *
 * `createEmail` stamps the send column with the wall clock, so the timestamps are
 * rewritten afterwards — the rows are still the shape the CLI writes, with the one column
 * this report buckets on placed where the test needs it.
 *
 * ONE EVENT IS DELIBERATELY IN THE OTHER TIMESTAMP FORMAT: `YYYY-MM-DD HH:MM:SS`, the
 * shape a column default produces, rather than an ISO string. Both forms really are in
 * this database and a naive string compare between them is not chronological.
 */
const DAY_ONE = "2026-07-20";
const DAY_TWO = "2026-07-21";
const OUTSIDE = "2020-01-05";

interface Fixture {
  store: EmailStore;
  providerId: string;
}

async function seed(): Promise<Fixture> {
  const db = getDatabase();
  const provider = createProvider({ name: "SES production", type: "ses" }, db);

  const stamp = (id: string, sentAt: string): void => {
    db.run("UPDATE emails SET sent_at = ?, created_at = ? WHERE id = ?", [sentAt, sentAt, id]);
  };

  // DAY_ONE: two sends, one of them to two recipients (so `ops@` outranks `dev@`).
  const first = await createSentEmailLedger(
    provider.id,
    { from: "hi@alpha.example", to: ["ops@alpha.example", "dev@alpha.example"], subject: "one", text: "x" },
    "pm-1",
    db,
  );
  stamp(first.id, `${DAY_ONE}T09:15:00.000Z`);
  const second = await createSentEmailLedger(
    provider.id,
    { from: "hi@alpha.example", to: ["ops@alpha.example"], subject: "two", text: "x" },
    "pm-2",
    db,
  );
  stamp(second.id, `${DAY_ONE}T09:40:00.000Z`);

  // DAY_TWO: one send, a different hour.
  const third = await createSentEmailLedger(
    provider.id,
    { from: "hi@alpha.example", to: ["ops@alpha.example"], subject: "three", text: "x" },
    "pm-3",
    db,
  );
  stamp(third.id, `${DAY_TWO}T17:05:00.000Z`);

  // Outside the window entirely — it must not appear in any bucket.
  const stale = await createSentEmailLedger(
    provider.id,
    { from: "hi@alpha.example", to: ["ancient@alpha.example"], subject: "stale", text: "x" },
    "pm-0",
    db,
  );
  stamp(stale.id, `${OUTSIDE}T01:00:00.000Z`);

  createEvent(
    { email_id: first.id, provider_id: provider.id, type: "delivered", occurred_at: `${DAY_ONE}T09:16:00.000Z` },
    db,
  );
  createEvent(
    { email_id: second.id, provider_id: provider.id, type: "bounced", occurred_at: `${DAY_ONE}T09:41:00.000Z` },
    db,
  );
  // Column-default timestamp shape, on purpose. See the note above.
  createEvent({ email_id: third.id, provider_id: provider.id, type: "delivered", occurred_at: `${DAY_TWO} 17:06:00` }, db);
  // An event well outside the window; excluded by the client-side window because the
  // events resource has no range filter to push down.
  createEvent(
    { email_id: stale.id, provider_id: provider.id, type: "delivered", occurred_at: `${OUTSIDE}T01:01:00.000Z` },
    db,
  );

  return { store: createSqliteEmailStore({ database: db, detail: "SQLite (test)" }), providerId: provider.id };
}

/** A period wide enough to hold the fixture's in-window days and exclude `OUTSIDE`. */
function windowDays(): string {
  const days = Math.ceil((Date.now() - Date.parse(`${DAY_ONE}T00:00:00.000Z`)) / 86400000) + 1;
  return `${days}d`;
}

// ── injected stores ──────────────────────────────────────────────────────────

function refusal(code: "capability_unavailable" | "invalid_input", status: 501 | 422, message: string) {
  return { ok: false as const, code, message, status };
}

function withMessages(base: EmailStore, listMessages: EmailStore["messages"]["listMessages"]): EmailStore {
  return { ...base, messages: { ...base.messages, listMessages } };
}

function withEvents(base: EmailStore, list: EmailStore["events"]["list"]): EmailStore {
  return { ...base, events: { ...base.events, list } };
}

function messageRow(index: number, date: string): MessageListRecord {
  return {
    id: `msg-${String(index).padStart(6, "0")}`,
    direction: "outbound",
    from_addr: "hi@alpha.example",
    to_addrs: ["ops@alpha.example"],
    cc_addrs: [],
    subject: "generated",
    status: "sent",
    provider_message_id: null,
    message_id: null,
    in_reply_to: null,
    received_at: `${date}T10:00:00.000Z`,
    is_read: true,
    is_starred: false,
    labels: [],
    source_id: null,
    send_state: "sent",
    send_started_at: null,
    created_at: `${date}T10:00:00.000Z`,
    updated_at: `${date}T10:00:00.000Z`,
    snippet: null,
    attachment_count: 0,
  };
}

/**
 * A message list that NEVER ends: every page is full and every page hands back a cursor.
 * That is what an installation larger than the page budget looks like from here, and it
 * is the only way to reach the lower-bound path.
 */
function endlessMessages(pageRows: number): EmailStore["messages"]["listMessages"] {
  let issued = 0;
  return async (): Promise<Outcome<Page<MessageListRecord>>> => {
    const items = Array.from({ length: pageRows }, (_, index) => messageRow(issued + index, DAY_ONE));
    issued += pageRows;
    return { ok: true, value: { items, next_cursor: `cursor-${issued}` } };
  };
}

// ── the positive control ─────────────────────────────────────────────────────

describe("getAnalytics over a real store", () => {
  it("publishes exact totals, per-day and per-hour buckets, and a ranked recipient list", async () => {
    const { store } = await seed();
    const data = await getAnalytics(undefined, windowDays(), { store });

    expect(data.sent_read.answered).toBe(true);
    expect(data.sent_read.exact, data.sent_read.reason ?? "").toBe(true);
    expect(data.events_read.answered).toBe(true);
    expect(data.events_read.exact, data.events_read.reason ?? "").toBe(true);
    expect(data.store).toBe("SQLite (test)");

    // Two in-window days, the out-of-window send excluded by the store's own filter.
    expect(data.dailyVolume).toEqual([
      { date: DAY_ONE, count: 2 },
      { date: DAY_TWO, count: 1 },
    ]);
    // One count per message/recipient pair, count DESC then address ASC.
    expect(data.topRecipients).toEqual([
      { email: "ops@alpha.example", count: 3 },
      { email: "dev@alpha.example", count: 1 },
    ]);
    expect(data.busiestHours).toEqual([
      { hour: 9, count: 2 },
      { hour: 17, count: 1 },
    ]);
    expect(data.deliveryTrend).toEqual([
      { date: DAY_ONE, sent: 2, delivered: 1, bounced: 1, delivered_rate_pct: 50 },
      { date: DAY_TWO, sent: 1, delivered: 1, bounced: 0, delivered_rate_pct: 100 },
    ]);
  });

  it("excludes an out-of-window delivery event even though the events resource cannot filter by range", async () => {
    const { store } = await seed();
    const data = await getAnalytics(undefined, windowDays(), { store });
    // The fixture holds a fourth `delivered` event dated 2020. If the client-side window
    // were dropped it would still not land in either published day — so the assertion
    // that catches it is the ROW COUNT of the read, which counts only windowed rows.
    expect(data.events_read.rows).toBe(3);
    expect(data.deliveryTrend?.some((day) => day.date === OUTSIDE)).toBe(false);
  });

  it("reads a column-default timestamp as the same day an ISO timestamp would be", async () => {
    const { store } = await seed();
    const data = await getAnalytics(undefined, windowDays(), { store });
    // DAY_TWO's delivery event is stored as `YYYY-MM-DD HH:MM:SS`, not as an ISO string.
    // A reader that only understood one of the two formats would drop it and report the
    // day as 0 delivered out of 1 sent — a 0% delivery rate on a delivered message.
    const dayTwo = data.deliveryTrend?.find((day) => day.date === DAY_TWO);
    expect(dayTwo?.delivered).toBe(1);
    expect(dayTwo?.delivered_rate_pct).toBe(100);
  });
});

// ── the honesty cases ────────────────────────────────────────────────────────

describe("a refused read is reported as absent, never as zero", () => {
  it("nulls every aggregate when the message list is refused", async () => {
    const { store } = await seed();
    const degraded = withMessages(store, async () =>
      refusal("capability_unavailable", 501, "this store cannot page messages"),
    );
    const data = await getAnalytics(undefined, windowDays(), { store: degraded });

    // NULL, not []. An empty array renders as "No data" in every consumer that forgets
    // to read the flag beside it, which is the same sentence a healthy empty install
    // produces.
    expect(data.dailyVolume).toBeNull();
    expect(data.topRecipients).toBeNull();
    expect(data.busiestHours).toBeNull();
    expect(data.deliveryTrend).toBeNull();
    expect(data.sent_read).toMatchObject({ answered: false, exact: false, rows: 0 });
    expect(data.sent_read.reason).toContain("capability_unavailable");
    expect(data.sent_read.reason).toContain("this store cannot page messages");
    // The event read is not attempted, and says so rather than reporting an empty table.
    expect(data.events_read.answered).toBe(false);
  });

  it("nulls delivered and bounced when the event list is refused, and still publishes send volume", async () => {
    const { store } = await seed();
    const degraded = withEvents(store, async () => refusal("invalid_input", 422, "no such filter column"));
    const data = await getAnalytics(undefined, windowDays(), { store: degraded });

    // Send volume is a DIFFERENT read and survives.
    expect(data.dailyVolume).toEqual([
      { date: DAY_ONE, count: 2 },
      { date: DAY_TWO, count: 1 },
    ]);
    expect(data.sent_read.exact).toBe(true);
    expect(data.events_read.answered).toBe(false);
    expect(data.deliveryTrend?.length).toBe(2);
    for (const day of data.deliveryTrend ?? []) {
      expect(day.delivered).toBeNull();
      expect(day.bounced).toBeNull();
      // A rate over an unknown numerator is not 0% and not 100%.
      expect(day.delivered_rate_pct).toBeNull();
    }
  });

  it("nulls every aggregate when the message read throws rather than refusing", async () => {
    const { store } = await seed();
    const degraded = withMessages(store, async () => {
      throw new Error("connection reset by peer");
    });
    const data = await getAnalytics(undefined, windowDays(), { store: degraded });
    expect(data.dailyVolume).toBeNull();
    expect(data.sent_read.answered).toBe(false);
    expect(data.sent_read.reason).toContain("connection reset by peer");
  });
});

describe("a truncated read is reported as a lower bound, never as a total", () => {
  it("marks the send counts inexact when the page budget runs out", async () => {
    const { store } = await seed();
    const degraded = withMessages(store, endlessMessages(500));
    const data = await getAnalytics(undefined, windowDays(), { store: degraded });

    expect(data.sent_read.answered).toBe(true);
    expect(data.sent_read.exact).toBe(false);
    expect(data.sent_read.reason).toContain("lower bound");
    // 40 pages of 500 is the declared budget; the rows really were read, so they are
    // published — as a lower bound.
    expect(data.sent_read.pages).toBe(40);
    expect(data.dailyVolume?.[0]?.count).toBe(20_000);
    expect(formatAnalytics(data)).toContain("≥20000");
  });

  it("suppresses the delivery rate when the SEND count is a lower bound", async () => {
    const { store } = await seed();
    const degraded = withMessages(store, endlessMessages(500));
    const data = await getAnalytics(undefined, windowDays(), { store: degraded });
    // THE CASE THIS WHOLE FILE EXISTS FOR. `delivered` here is exact and `sent` is a
    // lower bound, so their ratio is not a bound in either direction — the old formatter
    // would have printed a confident rate for a number it could not compute.
    for (const day of data.deliveryTrend ?? []) expect(day.delivered_rate_pct).toBeNull();
    const out = formatAnalytics(data);
    expect(out).toContain("rate:unknown");
    expect(out).not.toContain("%");
  });

  it("suppresses the delivery rate when the EVENT count is a lower bound", async () => {
    const { store } = await seed();
    let calls = 0;
    // A full page that never empties: `enumerateStoreRows` requires an EMPTY page to call
    // a table finished, so this exhausts its budget the way a table larger than the
    // budget does.
    const degraded = withEvents(store, async (): Promise<Outcome<ResourceRow[]>> => {
      calls += 1;
      return {
        ok: true,
        value: Array.from({ length: 500 }, (_, index) => ({
          id: `ev-${calls}-${index}`,
          type: "delivered",
          occurred_at: `${DAY_ONE}T09:16:00.000Z`,
        })),
      };
    });
    const data = await getAnalytics(undefined, windowDays(), { store: degraded });

    expect(data.sent_read.exact).toBe(true);
    expect(data.events_read.answered).toBe(true);
    expect(data.events_read.exact).toBe(false);
    expect(data.events_read.reason).toContain("lower bounds");
    for (const day of data.deliveryTrend ?? []) expect(day.delivered_rate_pct).toBeNull();
  });

  it("counts a message whose timestamp neither stored format explains, instead of dropping it", async () => {
    const { store } = await seed();
    const degraded = withMessages(store, async (): Promise<Outcome<Page<MessageListRecord>>> => ({
      ok: true,
      value: {
        items: [
          messageRow(1, DAY_ONE),
          { ...messageRow(2, DAY_ONE), received_at: "not-a-timestamp", created_at: "not-a-timestamp" },
        ],
        next_cursor: null,
      },
    }));
    const data = await getAnalytics(undefined, windowDays(), { store: degraded });

    // The bucketed row is published; the unbucketable one is not silently gone — it makes
    // the per-day counts lower bounds and names itself in the reason.
    expect(data.dailyVolume).toEqual([{ date: DAY_ONE, count: 1 }]);
    expect(data.sent_read.exact).toBe(false);
    expect(data.sent_read.reason).toContain("1 message(s) carry no timestamp");
    // It was still READ — the row count is the honest two, not the bucketable one.
    expect(data.sent_read.rows).toBe(2);
  });

  it("reports a duplicated message id as a disproof of the store's total-order claim", async () => {
    const { store } = await seed();
    let page = 0;
    const degraded = withMessages(store, async (): Promise<Outcome<Page<MessageListRecord>>> => {
      page += 1;
      // The same row on both pages: under a total order this cannot happen, so at least
      // one unseen row exists.
      return {
        ok: true,
        value: { items: [messageRow(1, DAY_ONE)], next_cursor: page < 2 ? "c1" : null },
      };
    });
    const data = await getAnalytics(undefined, windowDays(), { store: degraded });
    expect(data.sent_read.exact).toBe(false);
    expect(data.sent_read.reason).toContain("total-order claim");
    expect(data.dailyVolume).toEqual([{ date: DAY_ONE, count: 1 }]);
  });
});

describe("a request the seam cannot express is refused, not approximated", () => {
  it("rejects a provider-scoped report and names the missing contract field", async () => {
    const { store, providerId } = await seed();
    // The seam has no provider column on the message list record and no provider filter
    // on the list options, so three of the four sections would silently cover EVERY
    // provider. A report that looks provider-specific and is not is worse than none.
    await expect(getAnalytics(providerId, windowDays(), { store })).rejects.toThrow(
      /provider-scoped analytics cannot be produced from the store seam/,
    );
    await expect(getAnalytics(providerId, windowDays(), { store })).rejects.toThrow(/no provider filter/);
  });

  it("treats a blank provider filter as absent rather than as a refusal", async () => {
    const { store } = await seed();
    // An option named without a value arrives as an empty string; refusing on that would
    // break the unscoped report for a caller that passed nothing meaningful.
    const data = await getAnalytics("   ", windowDays(), { store });
    expect(data.sent_read.answered).toBe(true);
    expect(data.dailyVolume?.length).toBe(2);
  });
});

describe("the event read does not trust a server-side filter it cannot verify", () => {
  it("pushes the type filter down AND re-checks it, so a server that ignores it still counts correctly", async () => {
    const { store } = await seed();
    const seenFilters: Array<Record<string, string> | undefined> = [];
    // EXACTLY WHAT `src/test-support/v1-stub.ts` DOES: apply the paging clamps, ignore the
    // equality filter, hand back every row. A client that trusted the filter would count
    // this page's bounce as a delivery and its delivery as a bounce.
    const degraded = withEvents(store, async (opts): Promise<Outcome<ResourceRow[]>> => {
      seenFilters.push(opts?.filters);
      if ((opts?.offset ?? 0) > 0) return { ok: true, value: [] };
      return {
        ok: true,
        value: [
          { id: "ev-1", type: "delivered", occurred_at: `${DAY_ONE}T09:16:00.000Z` },
          { id: "ev-2", type: "bounced", occurred_at: `${DAY_ONE}T09:41:00.000Z` },
        ],
      };
    });
    const data = await getAnalytics(undefined, windowDays(), { store: degraded });

    // The filter WAS pushed down — both types, once each.
    expect(seenFilters.map((filters) => filters?.["type"])).toContain("delivered");
    expect(seenFilters.map((filters) => filters?.["type"])).toContain("bounced");
    // And the arithmetic survived the server ignoring it.
    const dayOne = data.deliveryTrend?.find((day) => day.date === DAY_ONE);
    expect(dayOne?.delivered).toBe(1);
    expect(dayOne?.bounced).toBe(1);
  });
});

// ── cross-store parity, over the real /v1 wire ───────────────────────────────

describe("getAnalytics over the API store answers exactly as the local store does", () => {
  let api: V1StoreApi | null = null;

  afterEach(() => {
    api?.stop();
    api = null;
  });

  it("produces a byte-identical report from the same rows read over HTTP", async () => {
    // THE PARITY CHECK, and it is the one assertion that a collapsed family most needs:
    // the two stores are the two arms this PR deleted, so if the surviving implementation
    // quietly favoured one of them, THIS is where it shows. The fixture is
    // `src/test-support/v1-store-api.ts` — the service's own OpenAPI document plus the
    // resource registry's declared equality filters — backed by the SAME SQLite store the
    // local half of this test reads, so any difference in the report is the client's.
    const { store: sqlite } = await seed();
    const local = await getAnalytics(undefined, windowDays(), { store: sqlite });

    api = startV1StoreApi({ store: sqlite });
    const http = createHttpEmailStore({
      baseUrl: api.baseUrl,
      credential: api.apiKey,
      detail: "Emails API (fixture)",
    });
    const overWire = await getAnalytics(undefined, windowDays(), { store: http });

    expect(overWire.store).toBe("Emails API (fixture)");
    expect(overWire.sent_read.answered).toBe(true);
    expect(overWire.sent_read.exact, overWire.sent_read.reason ?? "").toBe(true);
    expect(overWire.events_read.exact, overWire.events_read.reason ?? "").toBe(true);

    // Every aggregate, not a sampled one: a per-field comparison is what catches an arm
    // preference in ONE section.
    expect(overWire.dailyVolume).toEqual(local.dailyVolume);
    expect(overWire.topRecipients).toEqual(local.topRecipients);
    expect(overWire.busiestHours).toEqual(local.busiestHours);
    expect(overWire.deliveryTrend).toEqual(local.deliveryTrend);
    // And the values are the seeded ones, so the equality above is not two identical
    // empties agreeing with each other.
    expect(overWire.dailyVolume).toEqual([
      { date: DAY_ONE, count: 2 },
      { date: DAY_TWO, count: 1 },
    ]);
    expect(overWire.deliveryTrend?.[0]).toEqual({
      date: DAY_ONE,
      sent: 2,
      delivered: 1,
      bounced: 1,
      delivered_rate_pct: 50,
    });
  });

  it("reports the delivery trend as unread, not as zero, when the service cannot serve the filter contract", async () => {
    // `src/test-support/v1-stub.ts` serves no `/v1/openapi.json`, and the HTTP store
    // validates every supplied filter against that document — so a filtered generic list
    // FAULTS there rather than answering. That is the honest outcome and it is asserted
    // here rather than discovered in the field: send volume still publishes, and the
    // trend says it was never read instead of reporting nought delivered.
    const stub: V1Stub = await startV1Stub();
    try {
      const http = createHttpEmailStore({
        baseUrl: stub.baseUrl,
        credential: stub.apiKey,
        detail: "Emails API (stub)",
      });
      // The stub holds no messages, so volume is a genuine empty total; what matters is
      // the EVENT read's verdict.
      const data = await getAnalytics(undefined, windowDays(), { store: http });
      expect(data.sent_read.answered).toBe(true);
      expect(data.events_read.answered).toBe(false);
      expect(data.events_read.reason).toContain("faulted");
      expect(data.events_read.reason).toContain("openapi");
      // Volume is [] because the store really holds nothing; the trend is [] because
      // volume is, and neither of those is the event read claiming zero deliveries.
      expect(data.deliveryTrend).toEqual([]);
    } finally {
      stub.stop();
    }
  });
});

// ── rendering ────────────────────────────────────────────────────────────────

describe("formatAnalytics", () => {
  const READ_EXACT = { answered: true, exact: true, reason: null, rows: 3, pages: 1 };
  const READ_TRUNCATED = { answered: true, exact: false, reason: "the scan stopped early", rows: 3, pages: 40 };
  const READ_REFUSED = { answered: false, exact: false, reason: "the store refused: no capability", rows: 0, pages: 1 };

  function report(overrides: Partial<AnalyticsData> = {}): AnalyticsData {
    return {
      dailyVolume: [],
      topRecipients: [],
      busiestHours: [],
      deliveryTrend: [],
      period: "30d",
      since: "2026-06-26T00:00:00.000Z",
      store: "SQLite (test)",
      sent_read: READ_EXACT,
      events_read: READ_EXACT,
      ...overrides,
    };
  }

  it("formats an empty but complete report as no data", () => {
    const out = formatAnalytics(report());
    expect(out).toContain("Daily Send Volume");
    expect(out).toContain("Top Recipients");
    expect(out).toContain("Busiest Hours");
    expect(out).toContain("Delivery Trend");
    expect(out).toContain("No data");
    // A COMPLETE empty read is genuinely zero, so it must NOT be dressed up as unknown.
    expect(out).not.toContain("not available");
    expect(out).not.toContain("≥");
  });

  it("formats a complete report with values", () => {
    const out = formatAnalytics(
      report({
        dailyVolume: [{ date: "2025-01-15", count: 10 }],
        topRecipients: [{ email: "user@test.com", count: 5 }],
        busiestHours: [{ hour: 14, count: 8 }],
        deliveryTrend: [{ date: "2025-01-15", sent: 10, delivered: 9, bounced: 1, delivered_rate_pct: 90 }],
      }),
    );
    expect(out).toContain("2025-01-15");
    expect(out).toContain("user@test.com");
    expect(out).toContain("5 emails");
    expect(out).toContain("14:00");
    expect(out).toContain("sent:10");
    expect(out).toContain("delivered:9");
    expect(out).toContain("bounced:1");
    expect(out).toContain("90.0%");
    // No lower-bound marker anywhere on an exact read.
    expect(out).not.toContain("≥");
  });

  it("refuses to print the empty-table sentence for a section a truncated read left empty", () => {
    // THE DEFECT AN ADVERSARIAL PASS OVER THIS RENDERER FOUND, before the PR opened. The
    // branch order was `null -> not available` then `length === 0 -> "No data"`, so an
    // EMPTY array from a read that never finished printed the same words a healthy empty
    // installation prints. Every nullable field above exists to stop that sentence being
    // said without evidence, and the renderer was saying it anyway.
    const out = formatAnalytics(
      report({
        dailyVolume: [],
        topRecipients: [],
        busiestHours: [],
        deliveryTrend: [],
        sent_read: READ_TRUNCATED,
      }),
    );
    expect(out).not.toContain("No data");
    expect(out).toContain("nothing in the rows read");
    expect(out).toContain("not proof there is none");
    expect(out).toContain("the scan stopped early");
    // All four sections, not just the first: the fix had to be applied per section and a
    // check on one of them would have passed with three still wrong.
    expect(out.match(/nothing in the rows read/g)?.length).toBe(4);
  });

  it("renders a refused read as not available rather than as no data", () => {
    const out = formatAnalytics(
      report({
        dailyVolume: null,
        topRecipients: null,
        busiestHours: null,
        deliveryTrend: null,
        sent_read: READ_REFUSED,
      }),
    );
    expect(out).toContain("not available");
    expect(out).toContain("no capability");
    // THE DISTINCTION THIS RENDERING EXISTS FOR: an unread table must not print the
    // sentence an empty table prints.
    expect(out).not.toContain("No data");
  });

  it("marks every count on a truncated read as a lower bound and drops the rate", () => {
    const out = formatAnalytics(
      report({
        dailyVolume: [{ date: "2025-01-15", count: 10 }],
        topRecipients: [{ email: "user@test.com", count: 5 }],
        busiestHours: [{ hour: 14, count: 8 }],
        deliveryTrend: [{ date: "2025-01-15", sent: 10, delivered: 9, bounced: 1, delivered_rate_pct: null }],
        sent_read: READ_TRUNCATED,
      }),
    );
    expect(out).toContain("lower bounds only");
    expect(out).toContain("the scan stopped early");
    expect(out).toContain("≥10");
    expect(out).toContain("≥5 emails");
    expect(out).toContain("≥8");
    expect(out).toContain("sent:≥10");
    expect(out).toContain("rate:unknown");
    expect(out).not.toContain("%");
    // A truncated read makes the ranking partial, which is a stronger claim than "these
    // numbers are low" and is stated separately.
    expect(out).toContain("partial ranking");
  });

  it("prints unknown, not zero, for delivery counts that were never read", () => {
    const out = formatAnalytics(
      report({
        dailyVolume: [{ date: "2025-01-15", count: 10 }],
        deliveryTrend: [{ date: "2025-01-15", sent: 10, delivered: null, bounced: null, delivered_rate_pct: null }],
        events_read: READ_REFUSED,
      }),
    );
    expect(out).toContain("delivered:unknown");
    expect(out).toContain("bounced:unknown");
    expect(out).not.toContain("delivered:0");
  });

  it("shows last 14 days of volume only", () => {
    const days = [];
    for (let i = 0; i < 20; i++) {
      days.push({ date: `2025-01-${String(i + 1).padStart(2, "0")}`, count: i + 1 });
    }
    const out = formatAnalytics(report({ dailyVolume: days }));
    // Should contain last 14 days (7-20) but not day 1-6
    expect(out).toContain("2025-01-20");
    expect(out).toContain("2025-01-07");
    expect(out).not.toContain("2025-01-06");
  });

  it("shows last 7 days of delivery trend only", () => {
    const trend = [];
    for (let i = 0; i < 10; i++) {
      trend.push({
        date: `2025-01-${String(i + 1).padStart(2, "0")}`,
        sent: 10,
        delivered: 9,
        bounced: 1,
        delivered_rate_pct: 90,
      });
    }
    const out = formatAnalytics(report({ deliveryTrend: trend }));
    expect(out).toContain("2025-01-10");
    expect(out).toContain("2025-01-04");
    expect(out).not.toContain("2025-01-03");
  });
});
