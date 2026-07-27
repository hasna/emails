// The persisted digest-ROW family has ONE implementation, and every read and write it
// performs goes through the store seam.
//
// The family used to be a facade over two modules. TWO of its six routed exports were
// PURE — the period parser and the period label table were byte-for-byte identical in both
// arms — so the deployment word decided nothing about them except that they existed twice
// and were free to drift. The other four are where the arms disagreed, and not only about
// who ran the SQL:
//
//   * the HTTP arm asked for ONE page of 1000 rows, which the service clamps to 500, and
//     then picked the newest of what came back. Above 500 stored digests it published the
//     newest of an arbitrary 500 as "the newest" with nothing in the answer to say so.
//     There is a 520-row test for exactly that, carrying the control that a single clamped
//     page really does miss the row.
//   * the HTTP arm handed the service PRE-SERIALIZED JSON strings for the four json
//     columns, which the service JSON-encodes again behind a `::jsonb` cast. There is a
//     recording-store test that the collapsed writer sends the raw array and the raw
//     object.
//   * only SQLite constrains `period`, `provider` and `status`; the self-hosted Postgres
//     migration drops all three CHECKs. So an out-of-enum value was refused by one store
//     and written by the other, and the written row was then unreadable, because every
//     mapper in this family validates the enum on the way out. The collapsed writer
//     refuses it before either store is touched, and that is asserted with no store at all.
//
// WHAT IS TESTED HARDEST, and why:
//
//   1. A SHORT PAGE IS NOT THE END OF THE TABLE. Both surviving reads need the WHOLE
//      filtered set — one to pick a maximum, one to sort and slice — so both page to an
//      EMPTY page, and a scan that cannot be finished THROWS. A partial read sliced to
//      twenty rows is not "the newest twenty".
//   2. "NEWEST" IS DECIDED HERE. Neither store's list order can answer it (SQLite orders
//      these rows by `created_at`, the service by `completed_at`, and neither ordering is
//      part of the seam's contract), so there is a test whose fixture makes the two
//      orderings DISAGREE, carrying the control that the store's own first row is the
//      wrong one.
//   3. A REFUSAL IS NEVER AN ANSWER. `getLatestEmailDigest` returning `null` is acted on
//      by `loadEmailDigest`, which GENERATES a digest — so a refused or truncated read
//      answering `null` would silently replace a digest nobody could see. Every such path
//      throws, and the positive control that `null` is still reachable for a genuinely
//      empty period is asserted beside it.
//
// EVERY BEHAVIOURAL CASE THAT CAN RUN AGAINST A STORE RUNS TWICE: once against a real
// SQLite store and once against an `HttpEmailStore` talking to a `/v1` service over real
// HTTP. That fixture stores nothing itself — it translates HTTP into the same seam — so a
// field this module mis-maps fails rather than being handed back. `src/test-support/v1-stub.ts`
// is deliberately NOT used: its generic list handler ignores equality filters and it serves
// no `/v1/openapi.json`, which the HTTP store validates every filter and every write column
// against.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "./database.js";
import {
  emailDigestPeriodLabel,
  getEmailDigest,
  getLatestEmailDigest,
  listEmailDigests,
  normalizeEmailDigestPeriod,
  saveEmailDigest,
  type EmailDigestPeriod,
  type SaveEmailDigestInput,
} from "./email-digests.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome } from "../store/outcome.js";
import type { ResourceInput, ResourceRow } from "../store/records.js";
import { startV1StoreApi, type V1StoreApi } from "../test-support/v1-store-api.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../store-resolution.js";

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

/**
 * Leave exactly ONE store configured, so the cases that pass no store can resolve.
 *
 * The settings are named through the resolution's OWN exported constants rather than
 * copied as literals: this is the list that decides which store a caller with no
 * injected store gets, and a second copy of it here would go stale the first time the
 * resolution learned another setting.
 *
 * This matters because "a database path AND an API are both configured" is a HARD BOOT
 * ERROR with deliberately no precedence rule, so a stray inherited API setting turns
 * every default-path case into that error. The suite runner scrubs them; this makes the
 * file independent of that.
 */
function configureExactlyOneStore(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
  process.env["EMAILS_DB_PATH"] = ":memory:";
}

beforeEach(() => {
  captureInheritedProcessEnv();
  configureExactlyOneStore();
  resetDatabase();
  db = getDatabase();
  // The `/v1` service the HTTP store talks to. Every row it serves comes out of this same
  // database through the seam, so both store variants below read one dataset.
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "digest row fixture" }) });
});

afterEach(() => {
  api.stop();
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (email-digests test)" });
}

function httpStore(): EmailStore {
  return createHttpEmailStore({ baseUrl: api.baseUrl, credential: api.apiKey });
}

const STORE_VARIANTS: ReadonlyArray<[string, () => EmailStore]> = [
  ["SQLite store", sqliteStore],
  ["HTTP store over /v1", httpStore],
];

const CAPABILITY_REFUSAL = {
  ok: false,
  code: "capability_unavailable",
  message: "the test store does not serve digest rows",
  status: 501,
} as const;

function digestInput(overrides: Partial<SaveEmailDigestInput> = {}): SaveEmailDigestInput {
  return {
    period: "today",
    since: "2026-06-18T00:00:00.000Z",
    until: "2026-06-18T12:00:00.000Z",
    provider: "local",
    model: "store-inbox-digest-v1",
    status: "ok",
    message_count: 3,
    summary: "3 inbound messages",
    highlights: ["Contract from legal"],
    action_items: ["Reply to legal"],
    important_email_ids: ["email-1"],
    label_counts: { important: 2, receipts: 1 },
    error: null,
    ...overrides,
  };
}

/** A stored row read through the seam rather than through this module. */
async function storedRows(store: EmailStore): Promise<ResourceRow[]> {
  const listed = await store.emailDigests.list({ limit: 500 });
  if (!listed.ok) throw new Error(`could not read the stored digest rows: ${listed.message}`);
  return listed.value;
}

/**
 * The real store with ONE method replaced — the neutering pattern the store suites use.
 * A hand-rolled partial store cast to `EmailStore` would let a signature drift without
 * `tsc` noticing; this cannot, because `base` is checked against the seam.
 */
function storeWithDigestList(list: EmailStore["emailDigests"]["list"]): EmailStore {
  const base = sqliteStore();
  return { ...base, emailDigests: { ...base.emailDigests, list } };
}

function storeWithDigestGet(get: EmailStore["emailDigests"]["get"]): EmailStore {
  const base = sqliteStore();
  return { ...base, emailDigests: { ...base.emailDigests, get } };
}

function storeWithDigestCreate(create: EmailStore["emailDigests"]["create"]): EmailStore {
  const base = sqliteStore();
  return { ...base, emailDigests: { ...base.emailDigests, create } };
}

/** A synthetic stored row, complete enough for the mapper to accept it. */
function syntheticRow(n: number, overrides: Record<string, unknown> = {}): ResourceRow {
  const stamp = new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
  return {
    id: `synthetic-${String(n).padStart(6, "0")}`,
    period: "today",
    since: "2026-01-01T00:00:00.000Z",
    until: "2026-01-02T00:00:00.000Z",
    provider: "local",
    model: "synthetic",
    status: "ok",
    message_count: 0,
    summary: null,
    highlights_json: "[]",
    action_items_json: "[]",
    important_email_ids_json: "[]",
    label_counts_json: "{}",
    error: null,
    started_at: stamp,
    completed_at: stamp,
    created_at: stamp,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------
// The two pure exports. PARITY GUARDS, not change-detectors: both deleted arms held
// identical copies, and these assert the surviving one still answers the same way.
// ---------------------------------------------------------------------------------

describe("normalizeEmailDigestPeriod (pure, one copy)", () => {
  it("accepts every alias the deleted arms accepted", () => {
    const cases: Array<[string | undefined, EmailDigestPeriod]> = [
      [undefined, "today"],
      ["today", "today"],
      ["  TODAY  ", "today"],
      ["yesterday", "yesterday"],
      ["last7", "last7"],
      ["last-7", "last7"],
      ["last_7", "last7"],
      ["last 7 days", "last7"],
      ["lastseven", "last7"],
      ["week", "last7"],
      ["month", "month"],
      ["this month", "month"],
      ["This_Month", "month"],
    ];
    for (const [input, expected] of cases) expect(normalizeEmailDigestPeriod(input)).toBe(expected);
  });

  it("refuses a period it does not know rather than defaulting to one", () => {
    for (const input of ["fortnight", "last30", "", "   ", "todayish"]) {
      expect(() => normalizeEmailDigestPeriod(input)).toThrow(/Digest period must be/);
    }
  });
});

describe("emailDigestPeriodLabel (pure, one copy)", () => {
  it("labels every period, and every label is distinct", () => {
    const periods: EmailDigestPeriod[] = ["today", "yesterday", "last7", "month"];
    const labels = periods.map(emailDigestPeriodLabel);
    expect(labels).toEqual(["Today", "Yesterday", "Last 7 Days", "This Month"]);
    expect(new Set(labels).size).toBe(periods.length);
  });
});

// ---------------------------------------------------------------------------------
// The write.
// ---------------------------------------------------------------------------------

describe("saveEmailDigest", () => {
  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`round-trips every field through the ${name}`, async () => {
      const store = makeStore();
      const saved = await saveEmailDigest(digestInput(), store);
      expect(saved.id).toBeTruthy();
      expect(saved).toMatchObject({
        period: "today",
        since: "2026-06-18T00:00:00.000Z",
        until: "2026-06-18T12:00:00.000Z",
        provider: "local",
        model: "store-inbox-digest-v1",
        status: "ok",
        message_count: 3,
        summary: "3 inbound messages",
        highlights: ["Contract from legal"],
        action_items: ["Reply to legal"],
        important_email_ids: ["email-1"],
        label_counts: { important: 2, receipts: 1 },
        error: null,
      });
      // Read back through the SAME facade, so the write and the read agree rather than
      // the write merely echoing its own input.
      expect(await getEmailDigest(saved.id, store)).toEqual(saved);
    });

    it(`normalizes arrays and counts the way both deleted arms did, on the ${name}`, async () => {
      const store = makeStore();
      const saved = await saveEmailDigest(digestInput({
        message_count: -4,
        highlights: ["  a   line  ", "a line", "", "second"],
        action_items: Array.from({ length: 20 }, (_, i) => `item ${i}`),
        important_email_ids: Array.from({ length: 40 }, (_, i) => `email-${i}`),
        label_counts: { "  Mixed Case  ": 2, zero: 0, negative: -1, nan: Number.NaN },
      }), store);
      // Whitespace collapsed, duplicates and empties dropped, order kept.
      expect(saved.highlights).toEqual(["a line", "second"]);
      // The three caps: 12 highlights, 12 action items, 30 important ids.
      expect(saved.action_items).toHaveLength(12);
      expect(saved.important_email_ids).toHaveLength(30);
      // Label keys lower-cased and hyphenated; zero, negative and non-finite dropped.
      expect(saved.label_counts).toEqual({ "mixed-case": 2 });
      // A negative count is floored at zero rather than stored.
      expect(saved.message_count).toBe(0);
    });
  }

  it("refuses an out-of-enum period, provider or status before any store is touched", async () => {
    // ONLY SQLITE CONSTRAINS THESE COLUMNS — the self-hosted Postgres migration drops all
    // three CHECKs — so without this the same input is a refusal on one store and an
    // accepted, unreadable row on the other. No store is passed and none is configured to
    // be reachable: the refusal must not depend on having one.
    const bad: Array<[Partial<SaveEmailDigestInput>, RegExp]> = [
      [{ period: "fortnight" as EmailDigestPeriod }, /Digest period must be/],
      [{ provider: "smtp" as "local" }, /Digest provider must be/],
      [{ status: "pending" as "ok" }, /Digest status must be/],
      // A non-numeric count belongs with the enums: both deleted arms wrote
      // `Math.max(0, Math.trunc(NaN))` — i.e. `NaN` — straight into the row, leaving a count
      // no reader can return. Refused before the write, so the table never holds it.
      [{ message_count: Number.NaN }, /Digest message_count must be a finite number/],
      [{ message_count: "3" as unknown as number }, /Digest message_count must be a finite number/],
    ];
    for (const [overrides, message] of bad) {
      await expect(saveEmailDigest(digestInput(overrides))).rejects.toThrow(message);
    }
    // And nothing was written by any of the three.
    expect(await storedRows(sqliteStore())).toEqual([]);
  });

  it("sends the four json columns RAW, and sends neither an id nor a created_at", async () => {
    // WHY EACH HALF MATTERS.
    //
    // RAW JSON: the service JSON-encodes a `json: true` column itself and binds it behind
    // a `::jsonb` cast (`src/server/self-hosted/store.ts`, `encodeColumn` /
    // `createResource`). The deleted HTTP arm pre-serialized these four, so they landed as
    // jsonb STRING SCALARS rather than as an array and an object — readable only by that
    // arm's own parser, and by nothing that queried the jsonb.
    //
    // NO id / NO created_at: `/v1`'s published request schema is
    // `additionalProperties: false` over the fifteen declared columns, so naming either
    // one makes the HTTP store REFUSE the write. This is observed at the seam rather than
    // inferred, because a refusal at that layer would surface here as an unrelated error.
    const seen: ResourceInput[] = [];
    const base = sqliteStore();
    const store = storeWithDigestCreate(async (input) => {
      seen.push(input);
      return base.emailDigests.create(input);
    });
    const saved = await saveEmailDigest(digestInput(), store);
    expect(seen).toHaveLength(1);
    const input = seen[0] as ResourceInput;
    expect(Array.isArray(input["highlights_json"])).toBe(true);
    expect(Array.isArray(input["action_items_json"])).toBe(true);
    expect(Array.isArray(input["important_email_ids_json"])).toBe(true);
    expect(typeof input["label_counts_json"]).toBe("object");
    expect(Array.isArray(input["label_counts_json"])).toBe(false);
    expect(Object.keys(input)).not.toContain("id");
    expect(Object.keys(input)).not.toContain("created_at");
    // Every key sent IS a declared writable column of the resource, checked against the
    // service's own registry rather than against a list copied into this test.
    const { SELF_HOSTED_RESOURCES } = await import("../server/self-hosted/resources.js");
    const spec = SELF_HOSTED_RESOURCES.find((resource) => resource.path === "email-digests");
    expect(spec).toBeDefined();
    const declared = new Set((spec?.columns ?? []).map((column) => column.name));
    expect(Object.keys(input).filter((key) => !declared.has(key))).toEqual([]);
    // The store minted the id, and it is the one the caller got back.
    expect(saved.id).toBeTruthy();
  });

  it("stamps created_at with the store's own clock, not with a backdated completed_at", async () => {
    // Both deleted arms set `created_at = completed_at`. `created_at` is not a writable
    // column of the resource, so the store stamps it — which is what the name says, and
    // which a caller reading `created_at` as a synonym for `completed_at` will now notice.
    //
    // NO STORE IS INJECTED HERE, deliberately. Every case that hands in a store is only weak
    // evidence against the deleted implementation, which ignored the second argument unless it
    // was a SQLite handle; this one runs down the SAME default path the old code did, against
    // the same database, so the difference it asserts is behavioural rather than structural.
    const backdated = "2020-01-01T00:00:00.000Z";
    const saved = await saveEmailDigest(digestInput({ completed_at: backdated }));
    expect(saved.completed_at).toBe(backdated);
    expect(saved.created_at).not.toBe(backdated);
    expect(Date.parse(saved.created_at)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("throws when the store refuses the write, and writes nothing", async () => {
    const store = storeWithDigestCreate(async () => CAPABILITY_REFUSAL);
    await expect(saveEmailDigest(digestInput(), store)).rejects.toThrow(
      /cannot store a digest row \(capability_unavailable, 501\)/,
    );
    expect(await storedRows(sqliteStore())).toEqual([]);
  });

  it("throws when the store accepts the write and answers with a different row", async () => {
    // The service's generic route ACCEPTS a body key the resource has no column for and
    // drops it silently. Both stores refuse an unknown column today; this is what notices
    // if one ever stops, and it is the reason the returned row is checked rather than the
    // input echoed.
    const store = storeWithDigestCreate(async () => ({
      ok: true,
      value: syntheticRow(1, { message_count: 999 }),
    }));
    await expect(saveEmailDigest(digestInput(), store)).rejects.toThrow(/answered with a different row/);
  });

  it("throws when the stored row comes back with no id", async () => {
    // The guard's FIRST clause, given a case of its own. A row that matches on every field the
    // write asked for but carries no id is a row the caller cannot address again — it can
    // neither be re-read nor updated — so reporting the digest as saved would hand back a
    // reference to nothing. Split out because a mutation that disabled only this clause left
    // every other case green: the other clauses were carrying it.
    const store = storeWithDigestCreate(async (input) => ({
      ok: true,
      value: { ...syntheticRow(1), ...input, id: "" },
    }));
    await expect(saveEmailDigest(digestInput(), store)).rejects.toThrow(/answered with a different row/);
  });

  it("accepts the store's own row when it does match — the control for the check above", async () => {
    // Without this the round-trip guard could be satisfied by a check that always throws.
    const base = sqliteStore();
    const store = storeWithDigestCreate(async (input) => base.emailDigests.create(input));
    const saved = await saveEmailDigest(digestInput(), store);
    expect(saved.message_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------------
// getEmailDigest
// ---------------------------------------------------------------------------------

describe("getEmailDigest", () => {
  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`answers null for an id the ${name} does not hold`, async () => {
      expect(await getEmailDigest("no-such-digest", makeStore())).toBeNull();
    });
  }

  it("throws when the store refuses the read rather than answering null", async () => {
    // `null` from this function means the store looked and found nothing. A refusal
    // answered as `null` would turn "I could not look" into "there is no such digest".
    const store = storeWithDigestGet(async () => CAPABILITY_REFUSAL);
    await expect(getEmailDigest("some-id", store)).rejects.toThrow(
      /cannot read a stored digest row \(capability_unavailable, 501\)/,
    );
  });

  it("throws when a read by id answers with a different row", async () => {
    const store = storeWithDigestGet(async () => ({ ok: true, value: syntheticRow(7) }));
    await expect(getEmailDigest("asked-for-this-one", store)).rejects.toThrow(
      /answered a digest read by id with a different row/,
    );
  });

  it("returns the row when the id does match — the control for the check above", async () => {
    const store = storeWithDigestGet(async () => ({ ok: true, value: syntheticRow(7) }));
    const digest = await getEmailDigest("synthetic-000007", store);
    expect(digest?.id).toBe("synthetic-000007");
  });

  it("throws on a stored row whose period, status or provider is outside the enum", async () => {
    // Corrupt stored data is a FAULT, not a value. Both deleted arms threw for `period` and
    // `status`; `provider` joins them here because only ONE of the two stores constrains that
    // column, both deleted mappers answered such a row with a provider the row does not hold,
    // and the TUI prints that field next to the digest.
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ period: "fortnight" }, /Invalid digest period in database/],
      [{ status: "pending" }, /Invalid digest status in database/],
      [{ provider: "smtp" }, /Invalid digest provider in database/],
    ];
    for (const [overrides, message] of cases) {
      const store = storeWithDigestGet(async () => ({ ok: true, value: syntheticRow(1, { id: "x", ...overrides }) }));
      await expect(getEmailDigest("x", store)).rejects.toThrow(message);
    }
    // CONTROL: the same harness with all three enum values in range returns the row, so the
    // three assertions above are not satisfied by a mapper that rejects everything.
    const good = storeWithDigestGet(async () => ({ ok: true, value: syntheticRow(1, { id: "x" }) }));
    expect((await getEmailDigest("x", good))?.provider).toBe("local");
  });

  it("throws on a stored row with no readable message_count rather than reporting zero", async () => {
    // ABSENT IS NOT ZERO. `message_count` is `NOT NULL` in both schemas and projected by both
    // read paths, so a row without one is not a digest row — and "a digest of 0 messages" is
    // the most misleading sentence this mapper could produce about a count it could not read.
    for (const value of [null, undefined, "not a number"]) {
      const store = storeWithDigestGet(async () => ({
        ok: true,
        value: syntheticRow(1, { id: "x", message_count: value }),
      }));
      await expect(getEmailDigest("x", store)).rejects.toThrow(/no readable message_count/);
    }
    // CONTROL: a real zero really is reportable, so the check above cannot be satisfied by
    // rejecting every zero-message digest.
    const zero = storeWithDigestGet(async () => ({
      ok: true,
      value: syntheticRow(1, { id: "x", message_count: 0 }),
    }));
    expect((await getEmailDigest("x", zero))?.message_count).toBe(0);
  });

  it("reads a json column whichever shape the store hands it back in", async () => {
    // SQLite holds these as TEXT and returns the JSON string; the service holds them as
    // jsonb and returns a native array. Both are accepted rather than one being assumed —
    // which is also what lets a row written by the DELETED HTTP arm, as a jsonb string
    // scalar, still be read.
    const asStrings = storeWithDigestGet(async () => ({
      ok: true,
      value: syntheticRow(1, {
        id: "x",
        highlights_json: '["from a string"]',
        label_counts_json: '{"important":4}',
      }),
    }));
    expect((await getEmailDigest("x", asStrings))?.highlights).toEqual(["from a string"]);
    expect((await getEmailDigest("x", asStrings))?.label_counts).toEqual({ important: 4 });

    const asNative = storeWithDigestGet(async () => ({
      ok: true,
      value: syntheticRow(1, {
        id: "x",
        highlights: ["from an array"],
        label_counts: { important: 4 },
        highlights_json: undefined,
        label_counts_json: undefined,
      }),
    }));
    expect((await getEmailDigest("x", asNative))?.highlights).toEqual(["from an array"]);
    expect((await getEmailDigest("x", asNative))?.label_counts).toEqual({ important: 4 });
  });
});

// ---------------------------------------------------------------------------------
// getLatestEmailDigest
// ---------------------------------------------------------------------------------

describe("getLatestEmailDigest", () => {
  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`answers null for a period the ${name} holds no digest for`, async () => {
      // THE POSITIVE CONTROL for every throwing case below: `null` is still reachable, so
      // the suite cannot be satisfied by an implementation that never answers "none".
      await saveEmailDigest(digestInput({ period: "month" }), makeStore());
      expect(await getLatestEmailDigest("today", makeStore())).toBeNull();
    });

    it(`ignores other periods and non-ok rows, on the ${name}`, async () => {
      const store = makeStore();
      await saveEmailDigest(digestInput({ period: "yesterday", completed_at: "2026-06-19T00:00:00.000Z" }), store);
      await saveEmailDigest(digestInput({ status: "error", completed_at: "2026-06-19T00:00:00.000Z" }), store);
      const wanted = await saveEmailDigest(digestInput({ completed_at: "2026-06-18T00:00:00.000Z" }), store);
      expect((await getLatestEmailDigest("today", store))?.id).toBe(wanted.id);
    });

    it(`picks the newest by completed_at, not the store's first row, on the ${name}`, async () => {
      // THE FIXTURE MAKES THE TWO ORDERINGS DISAGREE. Rows are seeded through the SQLite
      // store directly — the only one that accepts an explicit `id` and `created_at` — so
      // the store's own page order is deterministic and the control below is not a coin
      // flip. Both variants then READ the same three rows.
      const seed = sqliteStore();
      const rows: Array<[string, string]> = [
        ["oldest-written", "2026-06-20T00:00:00.000Z"],
        ["middle-written", "2026-06-18T00:00:00.000Z"],
        ["newest-written", "2026-06-19T00:00:00.000Z"],
      ];
      for (const [index, [id, completedAt]] of rows.entries()) {
        const created = await seed.emailDigests.create({
          ...syntheticRow(index, { id, completed_at: completedAt }),
        });
        expect(created.ok).toBe(true);
      }
      // CONTROL: the store's own first row is NOT the newest by `completed_at`. Without
      // this the assertion below would also pass on an implementation that simply took the
      // first row the store handed back.
      const storeOrder = await storedRows(sqliteStore());
      expect(storeOrder).toHaveLength(3);
      expect(storeOrder[0]?.["id"]).not.toBe("oldest-written");

      expect((await getLatestEmailDigest("today", makeStore()))?.id).toBe("oldest-written");
    });
  }

  it("breaks a completed_at tie deterministically rather than arbitrarily", async () => {
    // `completed_at` is unique on neither store, and two digests generated inside one
    // millisecond share it — at which point the deleted `ORDER BY completed_at DESC LIMIT 1`
    // returned whichever row the query planner reached first.
    //
    // THE FIXTURE IS ARRANGED SO ONLY THE EXPLICIT TIEBREAKER CAN ANSWER IT, and getting that
    // wrong the first time is why the arrangement is spelled out. `Array.prototype.sort` is
    // STABLE, so with the tiebreaker removed the answer falls back to the ENUMERATION's input
    // order — the store's own `created_at DESC, id DESC`. Seeding both rows with the same
    // `created_at` therefore made the store's id-descending order produce the asserted answer
    // by itself, and the assertion could not fail. Here the two rows are given DISTINCT
    // `created_at` values ordered OPPOSITE to their ids.
    const seed = sqliteStore();
    const tie = "2026-06-18T00:00:00.000Z";
    for (const [index, id] of ["digest-zzz", "digest-aaa"].entries()) {
      const created = await seed.emailDigests.create({ ...syntheticRow(index, { id, completed_at: tie }) });
      expect(created.ok).toBe(true);
    }
    // CONTROL: the store's own order really does put the OTHER row first, so the assertion
    // below is a test of this module's tiebreaker and not of the store's ordering.
    expect((await storedRows(seed))[0]?.["id"]).toBe("digest-aaa");
    expect((await getLatestEmailDigest("today", sqliteStore()))?.id).toBe("digest-zzz");
  });

  it("throws when the row scan is refused rather than answering null", async () => {
    // `null` HERE IS ACTED ON: `loadEmailDigest` reads it as "no digest exists for this
    // period" and generates one, overwriting nothing it could see. A refusal answered as
    // `null` therefore silently replaces a stored digest.
    const store = storeWithDigestList(async () => CAPABILITY_REFUSAL);
    await expect(getLatestEmailDigest("today", store)).rejects.toThrow(
      /cannot read this installation's stored digests \(capability_unavailable, 501\)/,
    );
  });

  it("throws when the row scan faults rather than answering null", async () => {
    const store = storeWithDigestList(async () => {
      throw new Error("transport collapsed");
    });
    await expect(getLatestEmailDigest("today", store)).rejects.toThrow(/faulted.*transport collapsed/);
  });

  it("throws when the row scan cannot be paged to the end", async () => {
    // A SHORT PAGE IS NOT THE END OF THE TABLE. This store serves three rows a page,
    // correctly anchored, and never an empty one — the table it models is unbounded. An
    // implementation that stopped on a short page would read three rows as the whole table
    // and publish the newest of them.
    const store = storeWithDigestList(async (opts) => ({
      ok: true,
      value: [0, 1, 2].map((i) => syntheticRow((opts?.offset ?? 0) + i)),
    }));
    await expect(getLatestEmailDigest("today", store)).rejects.toThrow(
      /could not be read to the end \(pages: 200,/,
    );
  });

  it("throws when the row scan is unstable rather than answering from a subset", async () => {
    // The same three rows on every page: the window is not advancing, so the rows read are
    // a strict subset of the table and `rows.length` is not a total.
    const store = storeWithDigestList(async () => ({
      ok: true,
      value: [0, 1, 2].map((i) => syntheticRow(i)),
    }));
    await expect(getLatestEmailDigest("today", store)).rejects.toThrow(/could not be read to the end/);
  });

  it("keeps paging past a page that yields nothing new", async () => {
    // THE CONTROL for the two cases above: the terminating condition really is an EMPTY
    // page and not merely a short or a zero-yield one. This store serves the same anchor
    // row again — zero fresh rows on a NON-empty page — and only then empties.
    let calls = 0;
    const store = storeWithDigestList(async () => {
      calls += 1;
      if (calls === 1) return { ok: true, value: [syntheticRow(1, { completed_at: "2026-06-18T00:00:00.000Z" })] };
      if (calls === 2) return { ok: true, value: [syntheticRow(1, { completed_at: "2026-06-18T00:00:00.000Z" })] };
      return { ok: true, value: [] };
    });
    expect((await getLatestEmailDigest("today", store))?.id).toBe("synthetic-000001");
    expect(calls).toBe(2);
  });

  it("treats a row outside the filter as a broken store, not as a value", async () => {
    // The service's generic list route IGNORES a query parameter it does not declare and
    // answers with the UNFILTERED list — a superset presented as a filtered result. That is
    // a wrong result, not a value.
    const store = storeWithDigestList(async (opts) => {
      const page = (opts?.offset ?? 0) === 0
        ? [syntheticRow(1, { period: "month" })]
        : [];
      return { ok: true, value: page };
    });
    await expect(getLatestEmailDigest("today", store)).rejects.toThrow(/rows outside the filter/);
  });

  it("passes the period and status filters down to the store", async () => {
    // THE CONTROL for the case above: the filter is really asked for, so the re-assertion
    // is a second line of defence rather than the only one.
    const seen: Array<Record<string, string> | undefined> = [];
    const base = sqliteStore();
    const store = storeWithDigestList(async (opts) => {
      seen.push(opts?.filters);
      return base.emailDigests.list(opts);
    });
    await getLatestEmailDigest("last7", store);
    expect(seen[0]).toEqual({ period: "last7", status: "ok" });
  });

  it("finds the newest digest even when it lies beyond one clamped page", async () => {
    // THE DELETED HTTP ARM'S BUG, reproduced against the real clamp. It asked for one page
    // of 1000 rows; both stores clamp a page to 500. Above 500 stored digests it published
    // the newest of an arbitrary 500 as "the newest", with nothing in the answer to say so.
    //
    // The fixture is seeded through the SQLite store with explicit ids and `created_at`
    // values, so the store's own page order is deterministic: `created_at DESC` puts the
    // LAST-written row first, and the row carrying the maximum `completed_at` is written
    // FIRST — which places it at position 520 of the store's order, outside the clamp.
    const seed = sqliteStore();
    const total = 520;
    for (let i = 0; i < total; i += 1) {
      // i = 0 carries the newest `completed_at` and is written first.
      const completedAt = new Date(Date.UTC(2026, 5, 30) - i * 60_000).toISOString();
      const created = await seed.emailDigests.create({
        ...syntheticRow(i, { id: `bulk-${String(i).padStart(4, "0")}`, completed_at: completedAt }),
      });
      if (!created.ok) throw new Error(`could not seed row ${i}: ${created.message}`);
    }

    // CONTROL: one page really is clamped to 500, and the newest row really is missing
    // from it. Without this the assertion below would prove nothing about the clamp.
    const onePage = await seed.emailDigests.list({ limit: 1000 });
    if (!onePage.ok) throw new Error(`could not read one page: ${onePage.message}`);
    expect(onePage.value).toHaveLength(500);
    expect(onePage.value.map((row) => row["id"])).not.toContain("bulk-0000");

    expect((await getLatestEmailDigest("today", sqliteStore()))?.id).toBe("bulk-0000");
    expect((await getLatestEmailDigest("today", httpStore()))?.id).toBe("bulk-0000");
    // And the newest-first page is the three newest, in order, across the same clamp.
    expect((await listEmailDigests({ limit: 3 }, sqliteStore())).map((digest) => digest.id))
      .toEqual(["bulk-0000", "bulk-0001", "bulk-0002"]);
  });
});

// ---------------------------------------------------------------------------------
// listEmailDigests
// ---------------------------------------------------------------------------------

describe("listEmailDigests", () => {
  async function seedThree(store: EmailStore): Promise<void> {
    const seed = sqliteStore();
    const rows: Array<[string, string, string, string]> = [
      ["row-a", "today", "ok", "2026-06-20T00:00:00.000Z"],
      ["row-b", "today", "error", "2026-06-19T00:00:00.000Z"],
      ["row-c", "month", "ok", "2026-06-18T00:00:00.000Z"],
    ];
    for (const [index, [id, period, status, completedAt]] of rows.entries()) {
      const created = await seed.emailDigests.create({
        ...syntheticRow(index, { id, period, status, completed_at: completedAt }),
      });
      if (!created.ok) throw new Error(`could not seed ${id}: ${created.message}`);
    }
    expect(await storedRows(store)).toHaveLength(3);
  }

  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`answers newest first on the ${name}`, async () => {
      const store = makeStore();
      await seedThree(store);
      expect((await listEmailDigests({}, store)).map((digest) => digest.id)).toEqual(["row-a", "row-b", "row-c"]);
    });

    it(`honours the period and status filters on the ${name}`, async () => {
      const store = makeStore();
      await seedThree(store);
      expect((await listEmailDigests({ period: "today" }, store)).map((digest) => digest.id))
        .toEqual(["row-a", "row-b"]);
      expect((await listEmailDigests({ status: "ok" }, store)).map((digest) => digest.id))
        .toEqual(["row-a", "row-c"]);
      expect((await listEmailDigests({ period: "today", status: "ok" }, store)).map((digest) => digest.id))
        .toEqual(["row-a"]);
      expect(await listEmailDigests({ period: "yesterday" }, store)).toEqual([]);
    });

    it(`clamps limit and offset the way both deleted arms did, on the ${name}`, async () => {
      const store = makeStore();
      await seedThree(store);
      // A limit of zero or a negative one falls back to the shared `safeLimit` floor of 1
      // rather than answering an empty page.
      expect(await listEmailDigests({ limit: 0 }, store)).toHaveLength(1);
      expect(await listEmailDigests({ limit: -5 }, store)).toHaveLength(1);
      // 200 is the family's cap; asking for more does not raise it, and asking for fewer
      // is honoured.
      expect(await listEmailDigests({ limit: 10_000 }, store)).toHaveLength(3);
      expect((await listEmailDigests({ limit: 2 }, store)).map((digest) => digest.id)).toEqual(["row-a", "row-b"]);
      // A negative offset is clamped to zero rather than shifting the page backwards.
      expect((await listEmailDigests({ offset: -3, limit: 1 }, store)).map((digest) => digest.id)).toEqual(["row-a"]);
      expect((await listEmailDigests({ offset: 1, limit: 1 }, store)).map((digest) => digest.id)).toEqual(["row-b"]);
      expect(await listEmailDigests({ offset: 99 }, store)).toEqual([]);
    });
  }

  it("pages a completed_at tie without repeating or dropping a row", async () => {
    // Same arrangement as the tie case in `getLatestEmailDigest`, and for the same reason:
    // the three rows get DISTINCT `created_at` values ordered OPPOSITE to their ids, so the
    // store's own order is `tie-aaa, tie-bbb, tie-ccc` and only this module's explicit
    // tiebreaker can produce the reverse. A stable sort over a same-`created_at` fixture would
    // have made the assertion unfalsifiable.
    const seed = sqliteStore();
    const tie = "2026-06-18T00:00:00.000Z";
    for (const [index, id] of ["tie-ccc", "tie-bbb", "tie-aaa"].entries()) {
      const created = await seed.emailDigests.create({ ...syntheticRow(index, { id, completed_at: tie }) });
      if (!created.ok) throw new Error(`could not seed ${id}: ${created.message}`);
    }
    // CONTROL: the store's own order is the reverse of what is asserted below.
    expect((await storedRows(seed)).map((row) => row["id"])).toEqual(["tie-aaa", "tie-bbb", "tie-ccc"]);
    const store = sqliteStore();
    const first = await listEmailDigests({ limit: 2 }, store);
    const second = await listEmailDigests({ limit: 2, offset: 2 }, store);
    expect(first.map((digest) => digest.id)).toEqual(["tie-ccc", "tie-bbb"]);
    expect(second.map((digest) => digest.id)).toEqual(["tie-aaa"]);
    expect(new Set([...first, ...second].map((digest) => digest.id)).size).toBe(3);
  });

  it("throws when the row scan is refused rather than answering an empty page", async () => {
    const store = storeWithDigestList(async () => CAPABILITY_REFUSAL);
    await expect(listEmailDigests({}, store)).rejects.toThrow(
      /cannot list this installation's stored digests \(capability_unavailable, 501\)/,
    );
  });

  it("throws when the row scan cannot be paged to the end rather than slicing a subset", async () => {
    // A slice taken from part of the table is not "the newest twenty" — it is twenty rows
    // presented as the newest twenty, which is exactly the class of answer this seam exists
    // to stop.
    const store = storeWithDigestList(async (opts) => ({
      ok: true,
      value: [0, 1, 2].map((i) => syntheticRow((opts?.offset ?? 0) + i)),
    }));
    await expect(listEmailDigests({ limit: 1 }, store)).rejects.toThrow(/could not be read to the end/);
  });

  it("asks the store for no filter at all when none was requested", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const base = sqliteStore();
    const store = storeWithDigestList(async (opts) => {
      seen.push(opts?.filters);
      return base.emailDigests.list(opts);
    });
    await listEmailDigests({}, store);
    expect(seen[0]).toBeUndefined();
    seen.length = 0;
    await listEmailDigests({ status: "error" }, store);
    expect(seen[0]).toEqual({ status: "error" });
  });
});

// ---------------------------------------------------------------------------------
// The DEFAULT path — no store injected.
// ---------------------------------------------------------------------------------

describe("with no store passed", () => {
  it("reaches the store the storage configuration selects, and round-trips a digest through it", async () => {
    // COVERAGE THIS SUITE OTHERWISE HAS NONE OF. Every behavioural case above injects a store,
    // which is right for testing what the seam does and says nothing about the default. This
    // one exercises `createConfiguredEmailStore()` end to end: the row is written, found as the
    // period's newest, read back by id, and listed — all through whichever store the
    // configuration resolves, which under this suite's settings is the same in-memory SQLite
    // database the assertions below read directly.
    //
    // A PARITY GUARD, not a change-detector: this is the path the deleted arms served and it
    // still answers the same way.
    const saved = await saveEmailDigest(digestInput({ completed_at: "2026-06-18T09:00:00.000Z" }));
    const older = await saveEmailDigest(digestInput({ completed_at: "2026-06-17T09:00:00.000Z" }));
    expect(saved.id).not.toBe(older.id);
    expect((await getLatestEmailDigest("today"))?.id).toBe(saved.id);
    expect((await getEmailDigest(saved.id))?.summary).toBe("3 inbound messages");
    expect((await listEmailDigests({ period: "today" })).map((digest) => digest.id))
      .toEqual([saved.id, older.id]);
    expect(await getEmailDigest("no-such-digest")).toBeNull();
    expect(await getLatestEmailDigest("yesterday")).toBeNull();
    // And the rows really are in the database this suite opened, rather than somewhere else.
    expect(await storedRows(sqliteStore())).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------
// Nothing here asks which store it holds.
// ---------------------------------------------------------------------------------

describe("the collapsed module", () => {
  it("names no deployment-mode symbol and reaches into no arm", async () => {
    const source = await Bun.file(new URL("./email-digests.ts", import.meta.url)).text();
    // Named indirectly on purpose: this file is inside the ratchet's own scanned corpus.
    for (const fragment of [
      ["isSelfHosted", "Mode"].join(""),
      ["get", "EmailsMode"].join(""),
      ["EMAILS", "_MODE"].join(""),
      ["email-digests", ".local.js"].join(""),
      ["email-digests", ".remote.js"].join(""),
    ]) {
      expect(source).not.toContain(fragment);
    }
    // And there is exactly one implementation: both arm modules are gone.
    for (const arm of ["email-digests.local.ts", "email-digests.remote.ts"]) {
      expect(await Bun.file(new URL(`./${arm}`, import.meta.url)).exists()).toBe(false);
    }
  });
});
