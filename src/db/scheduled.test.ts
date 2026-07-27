// The schedule, checked against ONE question: can a read be observed to say only what
// the store was actually asked and actually answered?
//
// THIS FAMILY SHIPPED THE DEFECT THIS FILE IS WRITTEN AGAINST. `schedule list --offset 500`
// returned ZERO ROWS with exit 0 — indistinguishable from "nothing scheduled" — and
// `--limit 600` returned 500, because the read asked for one oversized page from a route
// that clamps every list to 500 rows and then windowed it locally. `getDueEmails` had the
// same shape, so a scheduler tick over a schedule larger than the clamp silently never
// looked at the rows past it: those emails were not delayed, they were never sent.
//
// So the shape of this suite is:
//
//   1. EVERY behavioural case runs over BOTH stores — SQLite directly, and the HTTP client
//      against `src/test-support/v1-store-api.ts`, which is a translation layer over the
//      SAME SQLite store. A difference in any answer is therefore the client's, and
//      "passes against its own mock" is not available as an explanation.
//      `src/test-support/v1-stub.ts` is deliberately NOT used: its generic list handler
//      IGNORES equality filters and it serves no `/v1/openapi.json`, which the HTTP store
//      validates every filter against — so a filtered generic list cannot even reach it.
//   2. The 600-row cases sit exactly at the clamp, and the fixture is ADVERSARIAL: rows are
//      seeded so the store's own page order is the exact REVERSE of due order. A read that
//      asks the store for `limit + offset` rows and sorts them locally then returns a
//      plausible WRONG page, and says so here rather than in production.
//   3. A store that refuses, truncates, or drops a filter is INJECTED. None of those states
//      is reachable from a healthy local database, and faking the ANSWER rather than the
//      STORE would be testing the test.
//
// WHY THE FIXTURE WRITES SOME ROWS IN SQL. `created_at` is not a writable column on the
// generic resource contract, and it is the column the SQLite store orders on — so the
// adversarial ordering above cannot be produced through `createScheduledEmail` at all. The
// same is true of the malformed-JSON row, which no valid write can create. Those rows are
// inserted directly and named as fixtures; every row whose CREATION is under test goes
// through the public function.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "./database.js";
import { createProvider } from "./providers.local.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { startV1StoreApi, type V1StoreApi } from "../test-support/v1-store-api.js";
import { STORE_LIST_PAGE_MAX } from "../lib/status-facts-enumeration.js";
import type { EmailStore } from "../store/email-store.js";
import type { ListOptions, ResourceRow } from "../store/records.js";
import type { Outcome } from "../store/outcome.js";
import {
  createScheduledEmail,
  getScheduledEmail,
  listScheduledEmails,
  listScheduledEmailSummaries,
  cancelScheduledEmail,
  getDueEmails,
  markSent,
  markFailed,
} from "./scheduled.js";

/** 600: one hundred rows past the page every list route clamps to. */
const OVER_CLAMP = STORE_LIST_PAGE_MAX + 100;

const DB_PATH_ENV = "EMAILS_DB_PATH";
/**
 * Every setting `planEmailStore` reads, cleared before each case.
 *
 * All of them, not just the database path: an inherited API pointer makes a local database
 * path a CONTRADICTION the resolver refuses outright (there is deliberately no precedence),
 * so a developer whose shell carries one would see this file fail for a reason that has
 * nothing to do with the schedule.
 */
const TOUCHED_ENV = [
  DB_PATH_ENV,
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "EMAILS_CLIENT_ENV_SECRET",
  "EMAILS_SESSION_TOKEN",
] as const;

let saved: Array<readonly [string, string | undefined]> = [];
let api: V1StoreApi | null = null;
let providerId = "";

beforeEach(() => {
  saved = TOUCHED_ENV.map((key) => [key, process.env[key]] as const);
  for (const key of TOUCHED_ENV) delete process.env[key];
  process.env[DB_PATH_ENV] = ":memory:";
  resetDatabase();
  // `scheduled_emails.provider_id` is a real foreign key and `PRAGMA foreign_keys` is ON,
  // so every fixture row needs a provider that exists.
  providerId = createProvider({ name: "schedule-fixture", type: "sandbox" }, getDatabase()).id;
});

afterEach(() => {
  api?.stop();
  api = null;
  closeDatabase();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ── the two stores ───────────────────────────────────────────────────────────

/**
 * The HTTP client, talking to a `/v1` service backed by the SAME SQLite store the local
 * case reads. Any difference between the two arms of a case is the client's mapping.
 */
function overTheWire(): EmailStore {
  const sqlite = createSqliteEmailStore();
  api = startV1StoreApi({ store: sqlite });
  return createHttpEmailStore({ baseUrl: api.baseUrl, credential: api.apiKey, detail: "Emails API (fixture)" });
}

const STORES: Array<readonly [string, () => EmailStore]> = [
  ["the SQLite store", () => createSqliteEmailStore()],
  ["the Emails API store", overTheWire],
];

// ── fixtures ─────────────────────────────────────────────────────────────────

const SCHEDULED_COLUMNS =
  "id, provider_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, " +
  "attachments_json, template_vars, scheduled_at, status, created_at";

/**
 * `count` rows whose STORE ORDER IS THE REVERSE OF DUE ORDER.
 *
 * `scheduled_at` rises with the index (so due order is `sched-0000` first) while
 * `created_at` rises with it too — and the SQLite store orders this family
 * `created_at DESC, id DESC`, so its first page is the LAST hundred due rows. A read that
 * bounded its request at `limit + offset` and sorted the result would answer
 * `{ limit: 10 }` with rows 590-599 while claiming they are the ten earliest.
 *
 * Written in SQL because `created_at` is not writable through the seam — see the header.
 */
function seedReversedSchedule(db: Database, count: number, dueAt?: (index: number) => string): string[] {
  const ids: string[] = [];
  const insert = db.query(
    `INSERT INTO scheduled_emails (${SCHEDULED_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let index = 0; index < count; index++) {
    const id = `sched-${String(index).padStart(4, "0")}`;
    ids.push(id);
    insert.run(
      id,
      providerId,
      "ops@example.com",
      JSON.stringify([`c${index}@example.com`]),
      "[]",
      "[]",
      `S${index}`,
      "[]",
      null,
      dueAt ? dueAt(index) : new Date(Date.UTC(2030, 7, 1, 0, 0, index)).toISOString(),
      "pending",
      // Ascending with the index, so `created_at DESC` is descending in the index.
      new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
    );
  }
  return ids;
}

function scheduleOne(overrides: Partial<Parameters<typeof createScheduledEmail>[0]> = {}) {
  return {
    provider_id: providerId,
    from_address: "sender@example.com",
    to_addresses: ["alice@example.com"],
    subject: "Test Subject",
    scheduled_at: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── the behavioural suite, over both stores ──────────────────────────────────

for (const [name, build] of STORES) {
  describe(`the schedule over ${name}`, () => {
    it("creates a scheduled email and reads every field back", async () => {
      const store = build();
      const scheduled = await createScheduledEmail(
        scheduleOne({
          cc_addresses: ["bob@example.com"],
          bcc_addresses: ["charlie@example.com"],
          reply_to: "reply@example.com",
          html: "<p>Hello</p>",
          text_body: "Hello",
          attachments_json: [{ filename: "a.txt", content: "x" }],
          template_name: "welcome",
          template_vars: { name: "Alice" },
        }),
        store,
      );

      // The store mints the id, and it is a uuid on both sides — this used to be minted
      // client-side, which the API store's contract check would now refuse.
      expect(scheduled.id).toHaveLength(36);
      expect(scheduled.provider_id).toBe(providerId);
      expect(scheduled.from_address).toBe("sender@example.com");
      expect(scheduled.to_addresses).toEqual(["alice@example.com"]);
      expect(scheduled.cc_addresses).toEqual(["bob@example.com"]);
      expect(scheduled.bcc_addresses).toEqual(["charlie@example.com"]);
      expect(scheduled.reply_to).toBe("reply@example.com");
      expect(scheduled.subject).toBe("Test Subject");
      expect(scheduled.html).toBe("<p>Hello</p>");
      expect(scheduled.text_body).toBe("Hello");
      expect(scheduled.attachments_json).toEqual([{ filename: "a.txt", content: "x" }]);
      expect(scheduled.template_name).toBe("welcome");
      expect(scheduled.template_vars).toEqual({ name: "Alice" });
      expect(scheduled.status).toBe("pending");
      expect(scheduled.scheduled_at).toBe("2030-01-01T00:00:00.000Z");
      expect(scheduled.error).toBeNull();
      expect(scheduled.created_at).not.toBe("");

      // And it round-trips: the created row is not a shape this client assembled locally.
      const found = await getScheduledEmail(scheduled.id, store);
      expect(found).toEqual(scheduled);
    });

    it("returns null for an unknown id, rather than raising", async () => {
      expect(await getScheduledEmail("nonexistent", build())).toBeNull();
    });

    it("coerces malformed recipient, attachment, and template JSON", async () => {
      const db = getDatabase();
      db.run(
        `INSERT INTO scheduled_emails (${SCHEDULED_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "sched-bad",
          providerId,
          "sender@example.com",
          "{}",
          "{}",
          "{}",
          "Bad JSON",
          "not-json",
          "not-json",
          "2030-01-01T00:00:00.000Z",
          "pending",
          "2026-01-01T00:00:00.000Z",
        ],
      );

      const found = await getScheduledEmail("sched-bad", build());
      expect(found?.to_addresses).toEqual([]);
      expect(found?.cc_addresses).toEqual([]);
      expect(found?.bcc_addresses).toEqual([]);
      expect(found?.attachments_json).toEqual([]);
      expect(found?.template_vars).toEqual({});
    });

    it("returns an empty list for an empty schedule", async () => {
      expect(await listScheduledEmails({}, build())).toEqual([]);
    });

    it("orders the list by due time, not by the store's own page order", async () => {
      // The whole point of the reversed fixture: both stores hand back their own order and
      // the two orders DISAGREE with each other, so neither can be passed through.
      const ids = seedReversedSchedule(getDatabase(), 5);
      const all = await listScheduledEmails({}, build());
      expect(all.map((row) => row.id)).toEqual(ids);
    });

    it("filters by status, and the filter survives the round trip", async () => {
      const store = build();
      const first = await createScheduledEmail(scheduleOne({ subject: "One" }), store);
      await createScheduledEmail(scheduleOne({ subject: "Two", scheduled_at: "2030-01-02T00:00:00.000Z" }), store);
      await markSent(first.id, store);

      const pending = await listScheduledEmails({ status: "pending" }, store);
      expect(pending.map((row) => row.subject)).toEqual(["Two"]);

      const sent = await listScheduledEmails({ status: "sent" }, store);
      expect(sent.map((row) => row.subject)).toEqual(["One"]);
    });

    it("windows the page AFTER the status filter", async () => {
      const store = build();
      for (let i = 0; i < 5; i++) {
        await createScheduledEmail(
          scheduleOne({ subject: `Pending ${i}`, scheduled_at: `2030-01-0${i + 1}T00:00:00.000Z` }),
          store,
        );
      }
      const sent = await createScheduledEmail(
        scheduleOne({ subject: "Sent", scheduled_at: "2030-01-01T12:00:00.000Z" }),
        store,
      );
      await markSent(sent.id, store);

      const page = await listScheduledEmails({ status: "pending", limit: 2, offset: 1 }, store);
      expect(page.map((row) => row.subject)).toEqual(["Pending 1", "Pending 2"]);
    });

    it("omits bodies, attachments, and template vars from the summary shape", async () => {
      const store = build();
      await createScheduledEmail(
        scheduleOne({
          subject: "Large scheduled payload",
          html: `<p>${"large html ".repeat(200)}</p>`,
          text_body: "large text ".repeat(200),
          attachments_json: [{ filename: "large.txt", content: "secret attachment".repeat(100) }],
          template_name: "welcome",
          template_vars: { secret: "large template vars".repeat(100) },
        }),
        store,
      );

      const [summary] = await listScheduledEmailSummaries({ limit: 1 }, store);

      expect(summary).toBeDefined();
      expect(summary?.subject).toBe("Large scheduled payload");
      expect(summary?.template_name).toBe("welcome");
      expect("html" in summary!).toBe(false);
      expect("text_body" in summary!).toBe(false);
      expect("attachments_json" in summary!).toBe(false);
      expect("template_vars" in summary!).toBe(false);
      expect(JSON.stringify(summary)).not.toContain("secret attachment");
      expect(JSON.stringify(summary)).not.toContain("large template vars");
    });

    it("cancels a pending email, and refuses a sent or already-cancelled one", async () => {
      const store = build();
      const pending = await createScheduledEmail(scheduleOne(), store);
      expect(await cancelScheduledEmail(pending.id, store)).toBe(true);
      expect((await getScheduledEmail(pending.id, store))?.status).toBe("cancelled");
      // Idempotent in the answer, not merely in the effect: a second cancel reports false
      // rather than reporting success for a write it did not perform.
      expect(await cancelScheduledEmail(pending.id, store)).toBe(false);
      expect((await getScheduledEmail(pending.id, store))?.status).toBe("cancelled");

      const sent = await createScheduledEmail(scheduleOne(), store);
      await markSent(sent.id, store);
      expect(await cancelScheduledEmail(sent.id, store)).toBe(false);
      expect((await getScheduledEmail(sent.id, store))?.status).toBe("sent");

      // An id that never existed is `false` — the row is not cancellable — and NOT a throw.
      expect(await cancelScheduledEmail("nonexistent", store)).toBe(false);
    });

    it("returns only pending rows whose due instant has passed", async () => {
      const store = build();
      await createScheduledEmail(scheduleOne({ subject: "Past", scheduled_at: "2000-01-01T00:00:00.000Z" }), store);
      await createScheduledEmail(scheduleOne({ subject: "Future", scheduled_at: "2099-01-01T00:00:00.000Z" }), store);
      const sent = await createScheduledEmail(
        scheduleOne({ subject: "Sent", scheduled_at: "2000-01-01T00:00:00.000Z" }),
        store,
      );
      const cancelled = await createScheduledEmail(
        scheduleOne({ subject: "Cancelled", scheduled_at: "2000-01-01T00:00:00.000Z" }),
        store,
      );
      await markSent(sent.id, store);
      await cancelScheduledEmail(cancelled.id, store);

      const due = await getDueEmails(undefined, store);
      expect(due.map((row) => row.subject)).toEqual(["Past"]);
    });

    it("limits a due batch to the EARLIEST rows, so consecutive ticks make progress", async () => {
      const store = build();
      const past = (index: number) => new Date(Date.UTC(2000, 0, index + 1)).toISOString();
      seedReversedSchedule(getDatabase(), 5, past);

      const due = await getDueEmails({ limit: 2 }, store);
      expect(due.map((row) => row.id)).toEqual(["sched-0000", "sched-0001"]);
    });

    it("marks a row sent, and marks one failed with its reason", async () => {
      const store = build();
      const scheduled = await createScheduledEmail(scheduleOne(), store);
      await markSent(scheduled.id, store);
      expect((await getScheduledEmail(scheduled.id, store))?.status).toBe("sent");

      const failing = await createScheduledEmail(scheduleOne(), store);
      await markFailed(failing.id, "Connection timeout", store);
      const updated = await getScheduledEmail(failing.id, store);
      expect(updated?.status).toBe("failed");
      expect(updated?.error).toBe("Connection timeout");
    });

    it("RAISES rather than reporting success when the row to mark does not exist", async () => {
      const store = build();
      // The deleted local arm ran `UPDATE ... WHERE id = ?`, changed zero rows, and told the
      // caller nothing — so a send was recorded against a row that was not there.
      await expect(markSent("nonexistent", store)).rejects.toThrow(/no such row/);
      await expect(markFailed("nonexistent", "boom", store)).rejects.toThrow(/no such row/);
    });

    // ── the clamp ────────────────────────────────────────────────────────────

    it(`reads all ${OVER_CLAMP} rows for a window that asks for them`, async () => {
      const store = build();
      const ids = seedReversedSchedule(getDatabase(), OVER_CLAMP);

      const rows = await listScheduledEmailSummaries({ limit: OVER_CLAMP }, store);

      // Not merely the count: the exact rows, in due order. A count alone would pass for a
      // read that returned 600 of the wrong rows.
      expect(rows).toHaveLength(OVER_CLAMP);
      expect(rows.map((row) => row.id)).toEqual(ids);
    }, 60_000);

    it("returns the page PAST the clamp instead of an empty list", async () => {
      const store = build();
      seedReversedSchedule(getDatabase(), OVER_CLAMP);

      const page = await listScheduledEmailSummaries({ limit: 100, offset: STORE_LIST_PAGE_MAX }, store);

      // This is the exact call that shipped as zero rows with exit 0.
      expect(page).toHaveLength(100);
      expect(page[0]?.id).toBe("sched-0500");
      expect(page[99]?.id).toBe("sched-0599");
    }, 60_000);

    it("answers a SMALL window with the earliest rows, not the store's first page", async () => {
      const store = build();
      seedReversedSchedule(getDatabase(), OVER_CLAMP);

      const page = await listScheduledEmailSummaries({ limit: 10 }, store);

      // The fixture's store order begins at `sched-0599`. A read that bounded its request at
      // `limit + offset` and sorted the result would answer `sched-0590..0599` here and look
      // entirely plausible doing it.
      expect(page.map((row) => row.id)).toEqual([
        "sched-0000", "sched-0001", "sched-0002", "sched-0003", "sched-0004",
        "sched-0005", "sched-0006", "sched-0007", "sched-0008", "sched-0009",
      ]);
    }, 60_000);

    it("keeps a status filter honest across the clamp", async () => {
      const db = getDatabase();
      seedReversedSchedule(db, OVER_CLAMP);
      db.run("UPDATE scheduled_emails SET status = 'cancelled' WHERE id = ?", ["sched-0300"]);
      const store = build();

      const pending = await listScheduledEmailSummaries({ status: "pending", limit: OVER_CLAMP + 1 }, store);

      expect(pending).toHaveLength(OVER_CLAMP - 1);
      expect(pending.every((row) => row.status === "pending")).toBe(true);
      expect(pending.map((row) => row.id)).not.toContain("sched-0300");
    }, 60_000);

    it(`sees a due row that sits past the clamp, and all ${OVER_CLAMP} when all are due`, async () => {
      const store = build();
      // Only the LAST row is due. A read that stops at the clamp reports an empty batch and
      // the scheduler silently never sends it.
      seedReversedSchedule(getDatabase(), OVER_CLAMP, (index) =>
        index === OVER_CLAMP - 1
          ? "2020-01-01T00:00:00.000Z"
          : new Date(Date.UTC(2099, 0, 1, 0, 0, index)).toISOString(),
      );

      expect((await getDueEmails({ limit: 10 }, store)).map((row) => row.id)).toEqual(["sched-0599"]);
    }, 60_000);

    it(`gives a tick every one of ${OVER_CLAMP} due rows, in due order`, async () => {
      const store = build();
      const past = (index: number) => new Date(Date.UTC(2000, 0, 1, 0, 0, index)).toISOString();
      const ids = seedReversedSchedule(getDatabase(), OVER_CLAMP, past);

      const unbounded = await getDueEmails(undefined, store);
      const bounded = await getDueEmails({ limit: OVER_CLAMP }, store);

      expect(unbounded.map((row) => row.id)).toEqual(ids);
      expect(bounded.map((row) => row.id)).toEqual(ids);
      // A tick that took the first 500 would leave exactly these hundred unsent forever.
      expect(unbounded.map((row) => row.id).slice(STORE_LIST_PAGE_MAX)).toHaveLength(100);
    }, 60_000);
  });
}

// ── ties, so a window is reproducible ────────────────────────────────────────

describe("rows sharing a due instant", () => {
  it("are ordered by id, so paging cannot repeat or skip one", async () => {
    const db = getDatabase();
    const insert = db.query(
      `INSERT INTO scheduled_emails (${SCHEDULED_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Inserted in DESCENDING id order at the SAME due instant. `ORDER BY scheduled_at ASC`
    // alone — which is what the deleted list arms used — leaves these in whatever order the
    // store happens to produce, and the two stores produce different ones.
    for (const id of ["tie-c", "tie-b", "tie-a"]) {
      insert.run(
        id, providerId, "ops@example.com", "[]", "[]", "[]", id, "[]", null,
        "2030-05-05T00:00:00.000Z", "pending", "2026-01-01T00:00:00.000Z",
      );
    }
    // NO injected store. This case is deliberately driven through the configured one so it
    // detects the BEHAVIOUR and not the new signature: the deleted list arms ordered by
    // `scheduled_at` alone, so against this fixture they answer in insertion order
    // (tie-c, tie-b, tie-a) and this assertion fails on them for the right reason.
    const all = await listScheduledEmails({});
    expect(all.map((row) => row.id)).toEqual(["tie-a", "tie-b", "tie-c"]);

    // And the two halves of a split window are disjoint and complete, which is the property
    // a total order buys.
    const first = await listScheduledEmails({ limit: 2, offset: 0 });
    const second = await listScheduledEmails({ limit: 2, offset: 2 });
    expect([...first, ...second].map((row) => row.id)).toEqual(["tie-a", "tie-b", "tie-c"]);
  });
});

// ── stores that cannot answer ────────────────────────────────────────────────

/** A store whose scheduled list returns one typed refusal. */
function refusingStore(): EmailStore {
  const store = createSqliteEmailStore();
  return {
    ...store,
    scheduled: {
      ...store.scheduled,
      list: async (): Promise<Outcome<ResourceRow[]>> => ({
        ok: false,
        code: "capability_unavailable",
        message: "this store does not list the schedule",
        status: 501,
      }),
    },
  };
}

/** A store whose scheduled list throws — a transport fault, not a refusal. */
function faultingStore(): EmailStore {
  const store = createSqliteEmailStore();
  return {
    ...store,
    scheduled: {
      ...store.scheduled,
      list: async (): Promise<Outcome<ResourceRow[]>> => {
        throw new Error("connection reset while listing the schedule");
      },
    },
  };
}

/**
 * A store whose list NEVER empties: every page comes back full, of fresh rows. The
 * enumeration's end-of-table rule is an EMPTY page, so this one runs the budget out — the
 * state a schedule larger than 20 000 rows really produces.
 */
function endlessStore(): EmailStore {
  const store = createSqliteEmailStore();
  let minted = 0;
  return {
    ...store,
    scheduled: {
      ...store.scheduled,
      list: async (opts?: ListOptions & { filters?: Record<string, string> }): Promise<Outcome<ResourceRow[]>> => {
        const size = opts?.limit ?? STORE_LIST_PAGE_MAX;
        const rows: ResourceRow[] = [];
        for (let i = 0; i < size; i++) {
          minted += 1;
          rows.push({
            id: `endless-${String(minted).padStart(8, "0")}`,
            provider_id: providerId,
            from_address: "ops@example.com",
            to_addresses: "[]",
            cc_addresses: "[]",
            bcc_addresses: "[]",
            subject: "endless",
            attachments_json: "[]",
            scheduled_at: "2000-01-01T00:00:00.000Z",
            status: "pending",
            created_at: "2026-01-01T00:00:00.000Z",
          });
        }
        return { ok: true, value: rows };
      },
    },
  };
}

/**
 * A store that ACCEPTS the status filter and ignores it, answering with the unfiltered
 * list. This is not hypothetical: `src/test-support/v1-stub.ts`'s generic list handler
 * does exactly that, recording the query string and serving every row.
 */
function filterIgnoringStore(): EmailStore {
  const store = createSqliteEmailStore();
  return {
    ...store,
    scheduled: {
      ...store.scheduled,
      list: async (opts?: ListOptions & { filters?: Record<string, string> }): Promise<Outcome<ResourceRow[]>> => {
        const { filters: _dropped, ...paging } = opts ?? {};
        return store.scheduled.list(paging);
      },
    },
  };
}

describe("a store that cannot answer", () => {
  it("makes a refused list a THROW naming the refusal, never an empty schedule", async () => {
    const store = refusingStore();
    await expect(listScheduledEmails({}, store)).rejects.toThrow(/capability_unavailable/);
    await expect(listScheduledEmailSummaries({}, store)).rejects.toThrow(
      /does not list the schedule/,
    );
    await expect(getDueEmails({ limit: 5 }, store)).rejects.toThrow(/capability_unavailable/);
  });

  it("makes a faulted list a THROW naming the fault", async () => {
    const store = faultingStore();
    await expect(listScheduledEmails({}, store)).rejects.toThrow(/faulted.*connection reset/);
    await expect(getDueEmails(undefined, store)).rejects.toThrow(/faulted/);
  });

  it("refuses a schedule it could not enumerate to the end, rather than serving a page of it", async () => {
    const store = endlessStore();
    // A short page is NOT the end of the table, so this read pages until its budget runs
    // out and then declines to answer. Returning the first window would publish a truncated
    // read as the list — the defect this family shipped.
    await expect(listScheduledEmails({ limit: 10 }, store)).rejects.toThrow(/budget ran out/);
    await expect(listScheduledEmails({ limit: 10 }, store)).rejects.toThrow(/LOWER BOUND/);
    await expect(getDueEmails({ limit: 10 }, store)).rejects.toThrow(/budget ran out/);
  }, 60_000);

  it("refuses a row with no due time rather than reporting it as due now", async () => {
    // ABSENT IS NOT EMPTY AND NOT EARLIEST. The coercion cannot tell an absent column from
    // an empty one, and "" sorts before every real instant while satisfying `"" <= now` —
    // so such a row would head the schedule and read as due immediately. Unreachable
    // through either store (the column is NOT NULL in SQLite and required by the published
    // item schema), so the row is injected.
    const store = createSqliteEmailStore();
    const broken: EmailStore = {
      ...store,
      scheduled: {
        ...store.scheduled,
        list: async (opts?: ListOptions & { filters?: Record<string, string> }): Promise<Outcome<ResourceRow[]>> => {
          const real = await store.scheduled.list(opts);
          if (!real.ok) return real;
          if ((opts?.offset ?? 0) > 0) return real;
          return { ok: true, value: [{ id: "sched-no-time", status: "pending", scheduled_at: null }, ...real.value] };
        },
      },
    };

    await expect(listScheduledEmails({}, broken)).rejects.toThrow(/has no scheduled_at/);
    await expect(getDueEmails(undefined, broken)).rejects.toThrow(/cannot be placed in due order/);
  });

  it("still answers correctly when the store drops the status filter it accepted", async () => {
    const db = getDatabase();
    seedReversedSchedule(db, 6);
    db.run("UPDATE scheduled_emails SET status = 'sent' WHERE id IN ('sched-0001', 'sched-0004')");

    const pending = await listScheduledEmails({ status: "pending" }, filterIgnoringStore());

    // The client re-check is what keeps this right: without it, two sent rows would be
    // reported as pending and a tick would try to send them again.
    expect(pending.map((row) => row.id)).toEqual(["sched-0000", "sched-0002", "sched-0003", "sched-0005"]);
    expect(pending.every((row) => row.status === "pending")).toBe(true);
  });
});

// ── the configured store ─────────────────────────────────────────────────────

describe("with no store handed in", () => {
  it("resolves one from storage configuration and reads the same rows", async () => {
    // NO injected store: this exercises `createConfiguredEmailStore()`, and therefore the
    // resolver, rather than only the injectable seam.
    const created = await createScheduledEmail(scheduleOne({ subject: "Configured" }));
    expect((await getScheduledEmail(created.id))?.subject).toBe("Configured");
    expect((await listScheduledEmails({ limit: 10 })).map((row) => row.subject)).toEqual(["Configured"]);
    expect(await cancelScheduledEmail(created.id)).toBe(true);
    expect((await listScheduledEmails({ status: "cancelled", limit: 10 })).map((row) => row.id)).toEqual([created.id]);
  });

  it("RAISES on a mark for a row that does not exist", async () => {
    // Also through the configured store, and also to detect behaviour rather than signature:
    // the deleted local arm ran `UPDATE ... WHERE id = ?`, changed zero rows, and returned
    // normally — so it reported a send recorded against a row that was not there.
    await expect(markSent("nonexistent")).rejects.toThrow(/no such row/);
    await expect(markFailed("nonexistent", "boom")).rejects.toThrow(/no such row/);
  });
});
