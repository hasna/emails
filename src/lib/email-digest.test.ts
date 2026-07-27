// The email-digest family has ONE implementation, and every read and write it performs
// goes through the store seam.
//
// The family used to be a facade over two modules. Half its routed surface was PURE —
// `resolveEmailDigestWindow` and `formatEmailDigest` were byte-for-byte identical in both
// arms — so the deployment word decided nothing about them except that a date-window
// calculation and a report formatter existed twice and were free to drift. The other
// half is where the arms disagreed about MEANING: one read SQLite and one threw.
//
// WHAT IS TESTED HARDEST HERE, and why each one:
//
//   1. A DIGEST ROW IS CACHED. `loadEmailDigest` serves the newest stored `ok` row, so a
//      refused message read written out as `message_count: 0` would not be wrong once —
//      it would be served as this period's authoritative answer until something replaced
//      it. Every refusal path therefore throws AND leaves the digest table untouched,
//      and both halves are asserted.
//   2. WHAT THE DIGEST COVERS. The deleted arm summarised every inbound message in the
//      window with no folder exclusion. `InboundRepository.listInbound` defaults the
//      folder to `inbox`, so inheriting it would have silently turned "everything that
//      arrived" into "everything still in the inbox". There is an end-to-end proof that
//      archived, spam and trash mail is still covered, carrying a POSITIVE CONTROL that
//      shows the folder default really does narrow.
//   3. THE WINDOW'S UPPER EDGE. The seam has a `since` filter and NO `until`, so a
//      "yesterday" read also returns everything received today. Asserted directly.
//   4. A BOUNDED READ PUBLISHES LOWER BOUNDS. With a positive control that a complete
//      read publishes none, so the assertion cannot be satisfied by always hedging.
//
// EVERY BEHAVIOURAL CASE RUNS TWICE, once against a real SQLite store and once against
// an `HttpEmailStore` talking to a `/v1` service over real HTTP. The fixture stores
// nothing itself — it translates HTTP into the same seam — so a field this module
// mis-maps fails rather than being handed back.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "../db/database.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome } from "../store/outcome.js";
import type { MessageListRecord, Page, ResourceRow } from "../store/records.js";
import { startV1StoreApi, type V1StoreApi } from "../test-support/v1-store-api.js";
import {
  formatEmailDigest,
  generateEmailDigest,
  loadEmailDigest,
  resolveEmailDigestWindow,
} from "./email-digest.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;

function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}

function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

let db: Database;
let api: V1StoreApi;

beforeEach(() => {
  captureInheritedProcessEnv();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  db = getDatabase();
  // The `/v1` service the HTTP store talks to. Every row it serves comes out of this
  // same database through the seam, so both store variants below read one dataset.
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "digest fixture" }) });
});

afterEach(() => {
  api.stop();
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (email-digest test)" });
}

function httpStore(): EmailStore {
  return createHttpEmailStore({ baseUrl: api.baseUrl, credential: api.apiKey });
}

/**
 * The real store with ONE method replaced — the neutering pattern the store suites use.
 * A hand-rolled partial store cast to `EmailStore` would let a signature drift without
 * `tsc` noticing; this cannot, because `base` is checked against the seam.
 */
function storeListingMessagesWith(answer: Outcome<Page<MessageListRecord>>): EmailStore {
  const base = sqliteStore();
  return { ...base, messages: { ...base.messages, listMessages: async () => answer } };
}

function storeListingDigestsWith(answer: Outcome<ResourceRow[]>): EmailStore {
  const base = sqliteStore();
  return { ...base, emailDigests: { ...base.emailDigests, list: async () => answer } };
}

const CAPABILITY_REFUSAL = {
  ok: false,
  code: "capability_unavailable",
  message: "the test store does not provide keysetPagination",
  status: 501,
} as const;

interface SeedInput {
  subject?: string;
  from?: string;
  received_at: string;
  read?: boolean;
  starred?: boolean;
  /** Topic labels. Folder state is applied with `folder` instead — see `seedMessage`. */
  labels?: string[];
  /**
   * `archived`, `spam` or `trash`. Applied with `addInboundLabel` rather than through
   * `createMessage({ labels })` because of a KNOWN, UNFIXED STORE DEFECT one layer down:
   * the SQLite table's `AFTER INSERT` trigger re-derives `is_spam` / `is_trash` from the
   * label list the insert has just stripped, so `createMessage({ labels: ["spam"] })`
   * produces a row with NO labels at all. Measured, not assumed: `archived` survives that
   * path and `spam` / `trash` do not. `addInboundLabel` writes the label list directly and
   * the store's folder predicate reads BOTH places, so all three land the same way. Not
   * this PR's defect to fix.
   */
  folder?: "archived" | "spam" | "trash";
  direction?: "inbound" | "outbound";
}

async function seedMessage(store: EmailStore, input: SeedInput): Promise<string> {
  const created = await store.messages.createMessage({
    direction: input.direction ?? "inbound",
    from_addr: input.from ?? "sender@upstream.test",
    to_addrs: ["me@example.test"],
    subject: input.subject ?? "A subject",
    body_text: "body",
    received_at: input.received_at,
    is_read: input.read ?? false,
    is_starred: input.starred ?? false,
    labels: input.labels ?? [],
  });
  if (!created.ok) throw new Error(`could not seed the message: ${created.message}`);
  if (input.folder) {
    const filed = await store.inbound.addInboundLabel(created.value.id, input.folder);
    if (!filed.ok) throw new Error(`could not file the message: ${filed.message}`);
  }
  return created.value.id;
}

/** Digest rows currently stored, read through the seam rather than through this module. */
async function storedDigests(store: EmailStore): Promise<ResourceRow[]> {
  const listed = await store.emailDigests.list({ limit: 500 });
  if (!listed.ok) throw new Error(`could not read the stored digests: ${listed.message}`);
  return listed.value;
}

/**
 * Timestamps around a window, derived FROM the window rather than hard-coded, so the
 * suite is exact in every timezone — `resolveEmailDigestWindow` works in local time.
 */
function around(period: string, at: Date): { since: string; until: string; inside: string; older: string; newer: string } {
  const window = resolveEmailDigestWindow(period, at);
  const since = Date.parse(window.since);
  const until = Date.parse(window.until);
  return {
    since: window.since,
    until: window.until,
    inside: new Date(Math.floor((since + until) / 2)).toISOString(),
    older: new Date(since - 60_000).toISOString(),
    newer: new Date(until + 60_000).toISOString(),
  };
}

const AT = new Date("2026-06-18T15:30:00.000Z");

describe("resolveEmailDigestWindow (pure, one copy)", () => {
  // PARITY GUARD, not a change-detector: both deleted arms held identical copies of this
  // function and this asserts the surviving one still bounds every period the same way.
  it("resolves every period to a window that ends no earlier than it starts", () => {
    expect(resolveEmailDigestWindow("today", AT)).toMatchObject({
      period: "today",
      until: "2026-06-18T15:30:00.000Z",
    });
    for (const period of ["today", "yesterday", "last7", "month"]) {
      const window = resolveEmailDigestWindow(period, AT);
      expect(window.period).toBe(period);
      expect(new Date(window.since).getTime()).toBeLessThan(new Date(window.until).getTime());
    }
    // Yesterday is the only period whose upper edge is in the PAST, which is the case
    // that makes the seam's missing `until` filter observable.
    expect(resolveEmailDigestWindow("yesterday", AT).until)
      .toBe(resolveEmailDigestWindow("today", AT).since);
  });

  it("rejects a period it does not know rather than defaulting to one", () => {
    expect(() => resolveEmailDigestWindow("fortnight", AT)).toThrow(/Digest period must be/);
  });
});

describe("formatEmailDigest (pure, one copy)", () => {
  function digest(overrides: Record<string, unknown> = {}) {
    return {
      id: "d1",
      period: "today" as const,
      since: "2026-06-18T00:00:00.000Z",
      until: "2026-06-18T12:00:00.000Z",
      provider: "local" as const,
      model: "store-inbox-digest-v1",
      status: "ok" as const,
      message_count: 2,
      summary: "2 inbound messages",
      highlights: ["Important contract"],
      action_items: ["Reply to legal"],
      important_email_ids: ["email-1"],
      label_counts: { important: 1 },
      error: null,
      started_at: "2026-06-18T12:00:00.000Z",
      completed_at: "2026-06-18T12:00:00.000Z",
      created_at: "2026-06-18T12:00:00.000Z",
      ...overrides,
    };
  }

  // PARITY GUARD: the rendering both deleted formatters produced.
  it("renders a readable digest", () => {
    const out = formatEmailDigest(digest());
    expect(out).toContain("Today digest");
    expect(out).toContain("2 inbound messages");
    expect(out).toContain("Important contract");
    expect(out).toContain("Reply to legal");
    expect(out).toContain("email-1");
  });

  // CHANGE: both deleted formatters dropped `error` on the floor, so a row recording WHY
  // its numbers are floors — or recording a failed generation — rendered identically to a
  // complete one.
  it("prints the row's note, so a recorded caveat is visible", () => {
    const out = formatEmailDigest(digest({ error: "sample_bounded: counts are lower bounds" }));
    expect(out).toContain("Note: sample_bounded: counts are lower bounds");
  });

  it("prints no note line when there is nothing to report", () => {
    expect(formatEmailDigest(digest())).not.toContain("Note:");
  });
});

for (const [kind, makeStore] of [["SQLite", sqliteStore], ["Emails API", httpStore]] as const) {
  describe(`generateEmailDigest over the ${kind} store`, () => {
    it("summarises the window's inbound mail and stores the row", async () => {
      const store = makeStore();
      const at = around("today", AT);
      await seedMessage(store, { subject: "Contract review", received_at: at.inside, labels: ["work"] });
      await seedMessage(store, { subject: "Invoice", received_at: at.inside, read: true, labels: ["work", "billing"] });
      await seedMessage(store, { subject: "Urgent ping", received_at: at.inside, starred: true });

      const digest = await generateEmailDigest({ period: "today", now: AT, store });

      expect(digest.id).not.toBe("");
      expect(digest.period).toBe("today");
      expect(digest.status).toBe("ok");
      expect(digest.message_count).toBe(3);
      expect(digest.summary).toContain("3 inbound messages");
      expect(digest.summary).toContain("2 unread");
      expect(digest.summary).toContain("1 marked important");
      expect(digest.label_counts).toEqual({ work: 2, billing: 1 });
      expect(digest.highlights.some((line) => line.includes("Contract review"))).toBe(true);
      expect(digest.since).toBe(at.since);
      expect(digest.until).toBe(at.until);
      // The row really is in the store, read back independently of this module.
      expect((await storedDigests(store)).length).toBe(1);
    });

    // CHANGE-DETECTOR for the sharpest call in the diff. The deleted arm filtered on
    // `is_sent = 0` and NOTHING else; `listInbound` would have excluded all three of
    // these.
    it("covers archived, spam and trash mail, which the inbox folder default excludes", async () => {
      const store = makeStore();
      const at = around("today", AT);
      await seedMessage(store, { subject: "Still in the inbox", received_at: at.inside });
      await seedMessage(store, { subject: "Filed away", received_at: at.inside, folder: "archived" });
      await seedMessage(store, { subject: "Marked spam", received_at: at.inside, folder: "spam" });
      await seedMessage(store, { subject: "In the trash", received_at: at.inside, folder: "trash" });

      const digest = await generateEmailDigest({ period: "today", now: AT, store });
      expect(digest.message_count).toBe(4);

      // POSITIVE CONTROL. Without this the assertion above would still pass on a store
      // that simply had no folder state, and would prove nothing about the default that
      // `listInbound` applies.
      const inbox = await store.inbound.listInbound({ limit: 500 });
      if (!inbox.ok) throw new Error(inbox.message);
      expect(inbox.value.items.length).toBe(1);
      expect(inbox.value.items[0]?.subject).toBe("Still in the inbox");
    });

    // CHANGE-DETECTOR: the three folder labels are folded INTO `labels` by the store's
    // own mapper. Counting them would report a folder as a topic.
    it("counts topic labels and not the folder state the store folds into them", async () => {
      const store = makeStore();
      const at = around("today", AT);
      await seedMessage(store, { subject: "Filed", received_at: at.inside, labels: ["work"], folder: "archived" });

      const digest = await generateEmailDigest({ period: "today", now: AT, store });
      expect(digest.message_count).toBe(1);
      expect(digest.label_counts).toEqual({ work: 1 });
    });

    // The seam has NO `until`, so the window's upper edge exists only because this module
    // re-asserts it.
    it("excludes mail received after the window's upper edge", async () => {
      const store = makeStore();
      const at = around("yesterday", AT);
      await seedMessage(store, { subject: "Yesterday's mail", received_at: at.inside });
      await seedMessage(store, { subject: "Today's mail", received_at: at.newer });
      await seedMessage(store, { subject: "Older mail", received_at: at.older });

      const digest = await generateEmailDigest({ period: "yesterday", now: AT, store });
      expect(digest.message_count).toBe(1);
      expect(digest.highlights.join("\n")).toContain("Yesterday's mail");
      expect(digest.highlights.join("\n")).not.toContain("Today's mail");
    });

    it("excludes sent mail from a digest of received mail", async () => {
      const store = makeStore();
      const at = around("today", AT);
      await seedMessage(store, { subject: "Received", received_at: at.inside });
      await seedMessage(store, { subject: "Sent", received_at: at.inside, direction: "outbound" });

      const digest = await generateEmailDigest({ period: "today", now: AT, store });
      expect(digest.message_count).toBe(1);
      expect(digest.highlights.join("\n")).not.toContain("Sent");
    });

    // CHANGE-DETECTOR. The deleted arm applied its `limit` as a SQL `LIMIT` and published
    // the clamped row count as `message_count` with nothing to say it was clamped.
    it("publishes lower bounds when the sample is bounded, and records why on the row", async () => {
      const store = makeStore();
      const at = around("today", AT);
      for (let index = 0; index < 5; index += 1) {
        await seedMessage(store, { subject: `Message ${index}`, received_at: at.inside });
      }

      const digest = await generateEmailDigest({ period: "today", limit: 2, now: AT, store });
      expect(digest.message_count).toBe(2);
      expect(digest.summary).toContain("at least 2 inbound messages");
      expect(digest.summary).toContain("lower bounds");
      expect(digest.error).toMatch(/^sample_bounded: /);
      // Recorded AND visible: a caveat nobody can see is not a caveat.
      expect(formatEmailDigest(digest)).toContain("Note: sample_bounded");
      expect(digest.status).toBe("ok");
    });

    // POSITIVE CONTROL for the case above: the hedge must not be unconditional.
    it("publishes plain totals and no note when the window was read to the end", async () => {
      const store = makeStore();
      const at = around("today", AT);
      await seedMessage(store, { subject: "Only one", received_at: at.inside });

      const digest = await generateEmailDigest({ period: "today", limit: 2, now: AT, store });
      expect(digest.message_count).toBe(1);
      expect(digest.summary).toContain("1 inbound message,");
      expect(digest.summary).not.toContain("at least");
      expect(digest.error).toBeNull();
      expect(formatEmailDigest(digest)).not.toContain("Note:");
    });

    it("reports an empty window as empty when it really did read to the end", async () => {
      const store = makeStore();
      const at = around("today", AT);
      await seedMessage(store, { subject: "Out of window", received_at: at.older });

      const digest = await generateEmailDigest({ period: "today", now: AT, store });
      expect(digest.message_count).toBe(0);
      expect(digest.summary).toContain("no inbound messages");
      expect(digest.error).toBeNull();
    });

    // CHANGE-DETECTOR: the seam's `received_at` is nullable and the deleted arm's
    // `received_at >= ?` predicate dropped a null one. SQLite's `since` filter compares
    // the store's ordering key, `COALESCE(received_at, created_at)`, so such a row passes
    // the store's filter and only this module's re-assertion excludes it.
    it("excludes a message with no received timestamp", async () => {
      const store = makeStore();
      const at = around("today", AT);
      await seedMessage(store, { subject: "Timed", received_at: at.inside });
      const created = await store.messages.createMessage({
        direction: "inbound",
        from_addr: "sender@upstream.test",
        to_addrs: ["me@example.test"],
        subject: "Untimed",
        body_text: "body",
        received_at: null,
      });
      if (!created.ok) throw new Error(created.message);

      const digest = await generateEmailDigest({ period: "today", now: AT, store });
      expect(digest.message_count).toBe(1);
      expect(digest.highlights.join("\n")).toContain("Timed");
    });

    it("records which computation produced the row", async () => {
      const store = makeStore();
      const at = around("today", AT);
      await seedMessage(store, { subject: "One", received_at: at.inside });

      const digest = await generateEmailDigest({ period: "today", now: AT, store });
      // NOT the deleted arm's `local-emails-digest`: that name described a computation
      // that read per-message AI classification out of `email_agent_runs`, and the store
      // seam models no agent-run family, so this one cannot. Two different computations
      // must not be indistinguishable in storage.
      expect(digest.model).toBe("store-inbox-digest-v1");
      expect(digest.provider).toBe("local");
    });

    it("accepts a bare period as its first argument, as both deleted arms did", async () => {
      const store = makeStore();
      const at = around("today", AT);
      await seedMessage(store, { subject: "One", received_at: at.inside });

      const digest = await generateEmailDigest("today", { now: AT, store });
      expect(digest.period).toBe("today");
      expect(digest.message_count).toBe(1);
    });
  });

  describe(`loadEmailDigest over the ${kind} store`, () => {
    it("returns the newest stored digest for the period", async () => {
      const store = makeStore();
      const at = around("today", AT);
      await seedMessage(store, { subject: "One", received_at: at.inside });
      const first = await generateEmailDigest({ period: "today", now: AT, store });
      const second = await generateEmailDigest({ period: "today", now: AT, store });
      expect(second.id).not.toBe(first.id);

      const loaded = await loadEmailDigest({ period: "today", now: AT, store });
      expect([first.id, second.id]).toContain(loaded.id);
      expect(loaded.completed_at.localeCompare(first.completed_at)).toBeGreaterThanOrEqual(0);
      // No new row: a cache hit must not generate.
      expect((await storedDigests(store)).length).toBe(2);
    });

    // NEITHER STORE'S LIST ORDER CAN ANSWER "WHICH IS NEWEST". The SQLite resource path
    // orders these rows by `created_at` and the service orders them by `completed_at`, and
    // neither ordering is part of the seam's contract. This seeds rows whose two orderings
    // DISAGREE, so an implementation that took the store's first row loses.
    it("picks the newest by completed_at rather than by the store's list order", async () => {
      const store = makeStore();
      const rows = [
        { completed_at: "2026-06-18T09:00:00.000Z", summary: "older" },
        { completed_at: "2026-06-18T18:00:00.000Z", summary: "newest" },
        { completed_at: "2026-06-18T11:00:00.000Z", summary: "middle" },
      ];
      for (const row of rows) {
        const created = await store.emailDigests.create({
          period: "today",
          since: "2026-06-18T00:00:00.000Z",
          until: "2026-06-18T23:00:00.000Z",
          provider: "local",
          model: "seeded",
          status: "ok",
          message_count: 1,
          summary: row.summary,
          highlights_json: [],
          action_items_json: [],
          important_email_ids_json: [],
          label_counts_json: {},
          error: null,
          started_at: row.completed_at,
          completed_at: row.completed_at,
        });
        if (!created.ok) throw new Error(`could not seed the digest row: ${created.message}`);
        // `created_at` is stamped by the store and is not writable through the API's
        // generic route, so the rows are spaced in real time to make the SQLite path's
        // `created_at` ordering deterministic rather than a same-millisecond tie broken
        // by a random uuid.
        await Bun.sleep(2);
      }

      const loaded = await loadEmailDigest({ period: "today", now: AT, store });
      expect(loaded.summary).toBe("newest");
      expect((await storedDigests(store)).length).toBe(3);

      // POSITIVE CONTROL: the store's own list order really does disagree with
      // `completed_at`, so the assertion above is discriminating rather than incidental.
      // "middle" comes first because the SQLite resource path orders these rows by
      // `created_at DESC` — insertion order reversed.
      //
      // TRUE OF BOTH VARIANTS HERE, AND WORTH STATING PRECISELY: the `/v1` fixture stores
      // nothing itself, so its list order is the SQLite one too. The REAL service orders
      // `email-digests` by `completed_at DESC` (`src/server/self-hosted/resources.ts`), so
      // against it taking the first row would happen to be right — which is exactly why
      // "newest" is decided here instead of being trusted to a store's ordering that the
      // seam does not specify. This fixture cannot exercise that divergence; the reason
      // the selection is client-side is that the two orderings differ at all.
      expect((await storedDigests(store))[0]?.["summary"]).toBe("middle");
    });

    it("ignores digests for other periods and digests that failed", async () => {
      const store = makeStore();
      const at = around("today", AT);
      await seedMessage(store, { subject: "One", received_at: at.inside });
      for (const seed of [
        { period: "month", status: "ok", summary: "another period" },
        { period: "today", status: "error", summary: "a failed run" },
      ]) {
        const created = await store.emailDigests.create({
          period: seed.period,
          since: "2026-06-01T00:00:00.000Z",
          until: "2026-06-18T23:00:00.000Z",
          provider: "local",
          model: "seeded",
          status: seed.status,
          message_count: 99,
          summary: seed.summary,
          highlights_json: [],
          action_items_json: [],
          important_email_ids_json: [],
          label_counts_json: {},
          error: null,
          started_at: "2026-06-18T12:00:00.000Z",
          completed_at: "2026-06-18T12:00:00.000Z",
        });
        if (!created.ok) throw new Error(`could not seed the digest row: ${created.message}`);
      }

      const loaded = await loadEmailDigest({ period: "today", now: AT, store });
      expect(loaded.message_count).toBe(1);
      expect(loaded.model).toBe("store-inbox-digest-v1");
      expect((await storedDigests(store)).length).toBe(3);
    });

    it("generates a digest when the period has none stored", async () => {
      const store = makeStore();
      const at = around("today", AT);
      await seedMessage(store, { subject: "One", received_at: at.inside });

      expect((await storedDigests(store)).length).toBe(0);
      const loaded = await loadEmailDigest({ period: "today", now: AT, store });
      expect(loaded.message_count).toBe(1);
      expect((await storedDigests(store)).length).toBe(1);
    });

    it("bypasses the stored row when fresh is requested", async () => {
      const store = makeStore();
      const at = around("today", AT);
      await seedMessage(store, { subject: "One", received_at: at.inside });
      const first = await generateEmailDigest({ period: "today", now: AT, store });

      const fresh = await loadEmailDigest({ period: "today", fresh: true, now: AT, store });
      expect(fresh.id).not.toBe(first.id);
      expect((await storedDigests(store)).length).toBe(2);
    });
  });
}

// THE SERVER-SIDE PAGE CLAMP, CHECKED RATHER THAN ASSUMED, on both stores.
//
// A stub more permissive than production hides defects no test can see: elsewhere in this
// program a `/v1` fixture served a route without the 500-row clamp its own generic handler
// applied, and a paged read shipped returning 0 rows with exit 0. So this asserts the
// clamp is real on BOTH paths with more than a page of rows actually present, and then
// asserts the digest built over that clamp is published as a floor rather than a total.
describe("a clamped page is not a total", () => {
  const ROWS = 520;

  it("clamps a page to 500 on both stores and publishes the clamped digest as a lower bound", async () => {
    const seedStore = sqliteStore();
    const at = around("today", AT);
    for (let index = 0; index < ROWS; index += 1) {
      await seedMessage(seedStore, { subject: `Bulk ${index}`, received_at: at.inside });
    }

    for (const store of [sqliteStore(), httpStore()]) {
      const asked = await store.messages.listMessages({ direction: "inbound", limit: 1000 });
      if (!asked.ok) throw new Error(asked.message);
      // Asked for 1000 with 520 present: a store without the clamp would answer 520 and
      // a null cursor, and this module would then have read the window to the end.
      expect(asked.value.items.length).toBe(500);
      expect(asked.value.next_cursor).not.toBeNull();
    }

    const digest = await generateEmailDigest({ period: "today", limit: 500, now: AT, store: sqliteStore() });
    expect(digest.message_count).toBe(500);
    expect(digest.summary).toContain("at least 500 inbound messages");
    expect(digest.error).toMatch(/^sample_bounded: /);
  }, 120_000);

  // A PAGE THAT CONTRIBUTES NOTHING MUST NOT END THE SCAN. Rows above the window's upper
  // edge are returned by the store (no `until` on the seam) and dropped here, so the first
  // page of a "yesterday" read on a busy day is entirely out-of-window. An implementation
  // that stopped when a page yielded no in-window rows — or that read one page and called
  // it the window — would report this window as EMPTY, complete, with no hedge at all.
  it("keeps paging past pages that contribute no in-window rows", async () => {
    const store = sqliteStore();
    const at = around("yesterday", AT);
    for (let index = 0; index < 150; index += 1) {
      await seedMessage(store, { subject: `Today ${index}`, received_at: at.newer });
    }
    for (let index = 0; index < 5; index += 1) {
      await seedMessage(store, { subject: `Yesterday ${index}`, received_at: at.inside });
    }

    const digest = await generateEmailDigest({ period: "yesterday", limit: 100, now: AT, store });
    expect(digest.message_count).toBe(5);
    expect(digest.summary).toContain("5 inbound messages");
    expect(digest.summary).not.toContain("at least");
    expect(digest.error).toBeNull();
    expect(digest.highlights.join("\n")).toContain("Yesterday");
    expect(digest.highlights.join("\n")).not.toContain("Today ");
  }, 120_000);
});

describe("a store that cannot answer is never reported as an empty digest", () => {
  it("throws when the message read is refused, and writes no digest row", async () => {
    const store = storeListingMessagesWith(CAPABILITY_REFUSAL);
    await expect(generateEmailDigest({ period: "today", now: AT, store })).rejects.toThrow(
      /cannot read the inbound mail in a digest window \(capability_unavailable, 501\)/,
    );
    // THE HALF THAT MATTERS MOST. A digest row is cached and served, so a fabricated
    // empty one would answer for this period until something replaced it.
    expect(await storedDigests(sqliteStore())).toEqual([]);
  });

  it("throws when the message read faults, and writes no digest row", async () => {
    const base = sqliteStore();
    const store: EmailStore = {
      ...base,
      messages: {
        ...base.messages,
        listMessages: async () => {
          throw new Error("transport collapsed");
        },
      },
    };
    await expect(generateEmailDigest({ period: "today", now: AT, store })).rejects.toThrow(/transport collapsed/);
    expect(await storedDigests(sqliteStore())).toEqual([]);
  });

  it("throws when the digest row read is refused, and does not generate instead", async () => {
    const store = storeListingDigestsWith(CAPABILITY_REFUSAL);
    await expect(loadEmailDigest({ period: "today", now: AT, store })).rejects.toThrow(
      /cannot read this installation's stored digests \(capability_unavailable, 501\)/,
    );
    expect(await storedDigests(sqliteStore())).toEqual([]);
  });

  it("throws when the digest write is refused", async () => {
    const base = sqliteStore();
    const store: EmailStore = {
      ...base,
      emailDigests: { ...base.emailDigests, create: async () => CAPABILITY_REFUSAL },
    };
    await expect(generateEmailDigest({ period: "today", now: AT, store })).rejects.toThrow(
      /cannot store a generated digest \(capability_unavailable, 501\)/,
    );
  });

  // The generic resource route IGNORES a filter it does not declare and answers with the
  // unfiltered list — a superset presented as a filtered result. `loadEmailDigest` asks
  // for one period's `ok` rows, so a row outside that answer is a broken store, not a
  // value.
  it("throws when a filtered digest read answers with rows outside the filter", async () => {
    const store = storeListingDigestsWith({
      ok: true,
      value: [
        {
          id: "d-other",
          period: "month",
          status: "ok",
          since: "2026-06-01T00:00:00.000Z",
          until: "2026-06-18T00:00:00.000Z",
          provider: "local",
          model: "seeded",
          message_count: 7,
          summary: "another period",
          highlights_json: "[]",
          action_items_json: "[]",
          important_email_ids_json: "[]",
          label_counts_json: "{}",
          error: null,
          started_at: "2026-06-18T12:00:00.000Z",
          completed_at: "2026-06-18T12:00:00.000Z",
          created_at: "2026-06-18T12:00:00.000Z",
        },
      ],
    });
    await expect(loadEmailDigest({ period: "today", now: AT, store })).rejects.toThrow(
      /rows outside the filter/,
    );
  });

  // A row set that never runs out is the store's own "I could not finish looking", and
  // answering `null` there would turn it into "no digest exists" and generate a row that
  // silently replaces one nobody could see.
  it("throws when the stored digests cannot be paged to the end", async () => {
    const base = sqliteStore();
    const page = (offset: number): ResourceRow[] =>
      Array.from({ length: 500 }, (_unused, index) => ({
        id: `d-${offset + index}`,
        period: "today",
        status: "ok",
        since: "2026-06-18T00:00:00.000Z",
        until: "2026-06-18T23:00:00.000Z",
        provider: "local",
        model: "seeded",
        message_count: 1,
        summary: "endless",
        highlights_json: "[]",
        action_items_json: "[]",
        important_email_ids_json: "[]",
        label_counts_json: "{}",
        error: null,
        started_at: "2026-06-18T12:00:00.000Z",
        completed_at: "2026-06-18T12:00:00.000Z",
        created_at: "2026-06-18T12:00:00.000Z",
      }));
    const store: EmailStore = {
      ...base,
      emailDigests: {
        ...base.emailDigests,
        list: async (opts) => ({ ok: true, value: page(opts?.offset ?? 0) }),
      },
    };
    await expect(loadEmailDigest({ period: "today", now: AT, store })).rejects.toThrow(
      /could not be read to the end/,
    );
  });

  // The scan never reached the window, so it has no evidence about how much mail the
  // window holds. "This period has no inbound messages" is the single most misleading
  // sentence this module can write.
  it("throws rather than reporting an empty window it never reached", async () => {
    const at = around("yesterday", AT);
    const row: MessageListRecord = {
      id: "m-newer",
      direction: "inbound",
      from_addr: "sender@upstream.test",
      to_addrs: ["me@example.test"],
      cc_addrs: [],
      subject: "Newer than the window",
      status: "received",
      provider_message_id: null,
      message_id: null,
      in_reply_to: null,
      received_at: at.newer,
      is_read: false,
      is_starred: false,
      labels: [],
      source_id: null,
      send_state: "none",
      send_started_at: null,
      created_at: at.newer,
      updated_at: at.newer,
      snippet: null,
      attachment_count: 0,
      policy_denial: null,
    };
    // Every page is full, every row is above the window's upper edge, and the cursor
    // never runs out.
    const store = storeListingMessagesWith({
      ok: true,
      value: { items: Array.from({ length: 500 }, (_unused, index) => ({ ...row, id: `m-${index}` })), next_cursor: "more" },
    });
    await expect(generateEmailDigest({ period: "yesterday", now: AT, store })).rejects.toThrow(
      /refusing to report it as empty/,
    );
    expect(await storedDigests(sqliteStore())).toEqual([]);
  });

  // THE STORE'S OWN FILTERS ARE THE CHEAP NARROWING, NOT THE ANSWER. `direction:
  // "inbound"` is asked for, and both stores honour it — so without a store that IGNORES
  // it, the re-assertion in `inWindow` would be untested code and the "excludes sent mail"
  // case above would be a test of the store's filter rather than of this module. A sent
  // message in a digest of received mail is the same class of defect as a foreign
  // recipient's verification code: the caller asked a narrower question than the answer.
  it("drops a sent message from a store whose direction filter is ignored", async () => {
    const at = around("today", AT);
    const base = sqliteStore();
    const store: EmailStore = {
      ...base,
      messages: {
        ...base.messages,
        // The filter is dropped, so the read answers the whole stream — a superset
        // presented as a filtered result.
        listMessages: (opts) => base.messages.listMessages({ ...opts, direction: undefined }),
      },
    };
    await seedMessage(base, { subject: "Received", received_at: at.inside });
    await seedMessage(base, { subject: "Sent", received_at: at.inside, direction: "outbound" });

    // POSITIVE CONTROL: the neutered store really does hand back the sent row.
    const unfiltered = await store.messages.listMessages({ direction: "inbound", limit: 500 });
    if (!unfiltered.ok) throw new Error(unfiltered.message);
    expect(unfiltered.value.items.some((row) => row.direction === "outbound")).toBe(true);

    const digest = await generateEmailDigest({ period: "today", now: AT, store });
    expect(digest.message_count).toBe(1);
    expect(digest.highlights.join("\n")).toContain("Received");
    expect(digest.highlights.join("\n")).not.toContain("Sent");
  });

  // The generic resource route ACCEPTS a body key the resource has no column for and
  // drops it silently. Both stores refuse an unknown column up front; this notices if one
  // ever stops.
  it("throws when the digest write is accepted and answers with a different row", async () => {
    const base = sqliteStore();
    const store: EmailStore = {
      ...base,
      emailDigests: {
        ...base.emailDigests,
        create: async (input) => ({
          ok: true,
          value: { ...(input as ResourceRow), id: "d-1", message_count: 999, created_at: "2026-06-18T12:00:00.000Z" },
        }),
      },
    };
    await expect(generateEmailDigest({ period: "today", now: AT, store })).rejects.toThrow(
      /answered with a different row/,
    );
  });
});
