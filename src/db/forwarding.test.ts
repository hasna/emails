// App-level inbound FORWARDING has one implementation, and the five rule operations reach
// storage through the store seam.
//
// The family used to be a facade over `forwarding.local.ts` (SQLite) and
// `forwarding.remote.ts` (the `curl` bridge), with a compatibility shim in the middle
// because the two arms did not even agree on the ARGUMENT ORDER of
// `listPendingForwarding`. Where the arms disagreed about behaviour — and it was not only
// about who ran the SQL — is what this suite is built around:
//
//   * ORDER. SQLite's generic resource path orders `forwarding_rules` by `updated_at DESC,
//     id DESC`; the service orders them `source_address ASC, target_address ASC`. Both arms
//     published "by source then target", so a limit/offset push-down returns the first N of
//     the STORE's order, re-sorted. There is a case below whose fixture makes the two
//     orderings DISAGREE, carrying the control that the store's own first row is the wrong
//     one.
//   * THE UPSERT'S DEDUP READ WAS ONE CLAMPED PAGE. The deleted HTTP arm looked for the
//     existing rule inside a single `list({ limit: 1000 })`, which the service clamps to
//     500. There is a 520-rule case, carrying the control that a single clamped page really
//     does miss the row — above 500 rules that arm attempted an insert both schemas'
//     `UNIQUE(source_address, target_address, mode)` rejects.
//   * `enabled` IS NOT A SERVER FILTER. The service declares `source_address`,
//     `target_address` and `mode`. So `enabled` is applied client-side, and there is a case
//     that the HTTP store REFUSES it as a push-down — the control that filtering here is
//     necessary rather than merely convenient.
//   * UNDECLARED WRITE COLUMNS. The deleted HTTP arm sent `id`/`created_at`/`updated_at` on
//     create and `updated_at` on update; `/v1/forwarding` declares six writable columns
//     behind `additionalProperties: false`, so the real HTTP store refuses all four. A
//     recording-store case pins exactly which columns this implementation sends.
//   * ONLY SQLITE CONSTRAINS `mode`. The self-hosted migration drops
//     `forwarding_rules_mode_check`, so an out-of-enum mode was refused by one store and
//     accepted by the other — and both arms then CAST it into a field the CLI prints. It is
//     refused on the way in and faulted on the way out here.
//   * `enabled` COMES BACK AS AN INTEGER OR A BOOLEAN, and the deleted coercions guessed:
//     `!!"no"` is `true`, `cbool("TRUE")` is `false`. Both real shapes are accepted and
//     everything else is a fault.
//   * ABSENT IS NOT `now()`. The deleted HTTP arm read both timestamps through `ciso`,
//     which fabricates the current time for a MISSING value.
//
// EVERY BEHAVIOURAL CASE THAT CAN RUN AGAINST A STORE RUNS TWICE: once against a real
// SQLite store and once against an `HttpEmailStore` talking to a `/v1` service over real
// HTTP. That fixture stores nothing itself — it translates HTTP into the same seam — so a
// field this module mis-maps fails rather than being handed back. `src/test-support/v1-stub.ts`
// is deliberately NOT used: its generic list handler ignores equality filters and it serves
// no `/v1/openapi.json`, which the HTTP store validates every filter and every write column
// against.
//
// THE TWO LOCAL-ONLY OPERATIONS are tested against SQLite and only SQLite, because that is
// the only place their data exists: `forwarding_deliveries` and the pending-forward join
// over `inbound_recipients` / `inbound_emails` have no seam repository, no `/v1` route and
// no table in the self-hosted Postgres schema. Their `Database` parameter is REQUIRED, so
// "an API-configured installation reads an empty local file and is told its inbox is fully
// forwarded" is a compile error rather than a test case.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "./database.js";
import {
  createForwardingRule,
  getForwardingRule,
  listForwardingRules,
  listPendingForwarding,
  recordForwardingDelivery,
  removeForwardingRule,
  setForwardingRuleEnabled,
  type ForwardingMode,
} from "./forwarding.js";
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
 * The settings are named through the resolution's OWN exported constants rather than copied
 * as literals. This matters because "a database path AND an API are both configured" is a
 * HARD BOOT ERROR with deliberately no precedence rule, so a stray inherited API setting
 * turns every default-store case into that error.
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
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "forwarding fixture" }) });
});

afterEach(() => {
  api.stop();
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (forwarding test)" });
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
  message: "the test store does not serve forwarding rules",
  status: 501,
} as const;

/**
 * The real store with ONE method replaced — the neutering pattern the store suites use. A
 * hand-rolled partial store cast to `EmailStore` would let a signature drift without `tsc`
 * noticing; this cannot, because `base` is checked against the seam.
 */
function storeWithForwarding(patch: Partial<EmailStore["forwarding"]>): EmailStore {
  const base = sqliteStore();
  return { ...base, forwarding: { ...base.forwarding, ...patch } };
}

/** A stored rule row, complete enough for the mapper to accept it. */
function syntheticRow(n: number, overrides: Record<string, unknown> = {}): ResourceRow {
  const stamp = new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
  return {
    id: `synthetic-${String(n).padStart(6, "0")}`,
    source_address: `source-${String(n).padStart(6, "0")}@example.com`,
    target_address: "archive@example.net",
    mode: "app-copy",
    provider_id: null,
    from_address: null,
    enabled: 1,
    created_at: stamp,
    updated_at: stamp,
    ...overrides,
  };
}

/** Rule rows read through the seam rather than through this module. */
async function storedRows(store: EmailStore, limit = 500): Promise<ResourceRow[]> {
  const listed = await store.forwarding.list({ limit });
  if (!listed.ok) throw new Error(`could not read the stored forwarding rules: ${listed.message}`);
  return listed.value;
}

// ---------------------------------------------------------------------------------
// The upsert.
// ---------------------------------------------------------------------------------

describe("createForwardingRule", () => {
  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`normalizes the addresses and round-trips every field through the ${name}`, async () => {
      const store = makeStore();
      const rule = await createForwardingRule({
        source_address: "  User@Example.COM ",
        target_address: "Archive@Example.NET",
        from_address: "Sender@Example.com",
      }, store);

      expect(rule.id).toBeTruthy();
      expect(rule).toMatchObject({
        source_address: "user@example.com",
        target_address: "archive@example.net",
        from_address: "sender@example.com",
        mode: "app-copy",
        provider_id: null,
        enabled: true,
      });
      // Both timestamps come from the STORE, not from this client, and both are non-empty —
      // the deleted HTTP arm read them through a helper that fabricates `now()` for a value
      // it cannot find.
      expect(rule.created_at).toBeTruthy();
      expect(rule.updated_at).toBeTruthy();
      // Read back through the SAME facade, so the write and the read agree rather than the
      // write merely echoing its own input.
      expect(await getForwardingRule(rule.id, store)).toEqual(rule);
    });

    it(`updates in place on (source, target, mode) rather than inserting twice, on the ${name}`, async () => {
      const store = makeStore();
      const first = await createForwardingRule({
        source_address: "user@example.com",
        target_address: "archive@example.net",
        from_address: "user@example.com",
      }, store);
      const second = await createForwardingRule({
        source_address: "USER@example.com",
        target_address: " archive@example.net ",
        enabled: false,
      }, store);

      expect(second.id).toBe(first.id);
      expect(second.enabled).toBe(false);
      // The update carried no `from_address`, and both deleted arms wrote `null` through
      // rather than merging — preserved, and asserted so a "helpful" merge is a failure
      // rather than a silent behaviour change.
      expect(second.from_address).toBeNull();
      expect(await listForwardingRules({}, store)).toHaveLength(1);
      expect(await storedRows(store)).toHaveLength(1);
    });

    it(`refuses an unparseable address before touching the ${name}`, async () => {
      const store = makeStore();
      await expect(createForwardingRule({
        source_address: "not-an-address",
        target_address: "archive@example.net",
      }, store)).rejects.toThrow(/Invalid email address: not-an-address/);
      expect(await storedRows(store)).toEqual([]);
    });
  }

  it("sends ONLY the six writable columns, and never id or either timestamp", async () => {
    // THE DELETED HTTP ARM SENT `id`, `created_at` AND `updated_at` on create and
    // `updated_at` on update. `/v1/forwarding` declares six writable columns behind
    // `additionalProperties: false`, so the real HTTP store REFUSES a write that names any
    // of them — the `curl` bridge did not validate. This records what is actually sent.
    const created: ResourceInput[] = [];
    const updated: ResourceInput[] = [];
    const base = sqliteStore();
    const recording: EmailStore = {
      ...base,
      forwarding: {
        ...base.forwarding,
        async create(input) {
          created.push(input);
          return base.forwarding.create(input);
        },
        async update(id, patch) {
          updated.push(patch);
          return base.forwarding.update(id, patch);
        },
      },
    };

    const rule = await createForwardingRule({
      source_address: "user@example.com",
      target_address: "archive@example.net",
    }, recording);
    await createForwardingRule({
      source_address: "user@example.com",
      target_address: "archive@example.net",
      enabled: false,
    }, recording);
    await setForwardingRuleEnabled(rule.id, true, recording);

    expect(created).toHaveLength(1);
    expect(Object.keys(created[0] as ResourceInput).sort()).toEqual([
      "enabled",
      "from_address",
      "mode",
      "provider_id",
      "source_address",
      "target_address",
    ]);
    expect(updated).toHaveLength(2);
    // The upsert's update names three columns; the enable/disable write names one. Neither
    // names `updated_at`, and both stores stamp it themselves.
    expect(Object.keys(updated[0] as ResourceInput).sort()).toEqual(["enabled", "from_address", "provider_id"]);
    expect(Object.keys(updated[1] as ResourceInput)).toEqual(["enabled"]);
    for (const write of [...created, ...updated]) {
      for (const forbidden of ["id", "created_at", "updated_at"]) {
        expect(Object.hasOwn(write, forbidden), `a write named ${forbidden}`).toBe(false);
      }
    }
  });

  it("refuses an out-of-enum mode before any store is touched", async () => {
    // ONLY SQLITE CONSTRAINS THIS COLUMN — the self-hosted migration DROPS
    // `forwarding_rules_mode_check` — so without this the same input is a refusal on one
    // store and an accepted, unreadable row on the other. No store is passed: the refusal
    // must not depend on having one.
    for (const mode of ["relay", "", "APP-COPY"]) {
      await expect(createForwardingRule({
        source_address: "user@example.com",
        target_address: "archive@example.net",
        mode: mode as ForwardingMode,
      })).rejects.toThrow(/Forwarding mode must be app-copy/);
    }
    // The positive control: the one legal mode is still accepted, and is still the default.
    const store = sqliteStore();
    expect((await createForwardingRule({
      source_address: "user@example.com",
      target_address: "archive@example.net",
      mode: "app-copy",
    }, store)).mode).toBe("app-copy");
  });

  it("finds an existing rule that sits beyond the store's single-page clamp", async () => {
    // THE DELETED HTTP ARM'S DEDUP READ WAS ONE `list({ limit: 1000 })`, which the service
    // clamps to 500. 520 rules are seeded through the seam (not through this module, which
    // would be 520 enumerations), then the module upserts one whose row is NOT in the first
    // page of the store's own order.
    const store = sqliteStore();
    for (let n = 0; n < 520; n += 1) {
      const written = await store.forwarding.create({
        source_address: `source-${String(n).padStart(4, "0")}@example.com`,
        target_address: "archive@example.net",
        mode: "app-copy",
        provider_id: null,
        from_address: null,
        enabled: true,
      });
      if (!written.ok) throw new Error(`seeding rule ${n} failed: ${written.message}`);
    }
    const target = "source-0000@example.com";
    // THE STORE'S OWN ORDER IS FORCED TO BE DETERMINISTIC, and finding out why this is
    // necessary was worth the trouble: 520 rules written in a tight loop share an
    // `updated_at` to the millisecond, so SQLite's `updated_at DESC, id DESC` falls through
    // to a RANDOM uuid and which 500 land in the first page is chance. The control below
    // ("the target is not in the first page") then held only ~500/520 of the time — a 4%
    // flake that also made this test steal an unrelated mutant's kill during mutation
    // testing. Stamping `updated_at` from the source address puts the target provably last.
    db.run(
      `UPDATE forwarding_rules
          SET updated_at = datetime('2026-01-01 00:00:00', '+' || CAST(substr(source_address, 8, 4) AS INTEGER) || ' seconds')`,
    );

    // THE CONTROL. A single clamped page really does miss the row, so the case is not
    // vacuous: without it, "the upsert found the row" would prove nothing.
    const onePage = await storedRows(store, 1000);
    expect(onePage).toHaveLength(500);
    expect(onePage.some((row) => row["source_address"] === target)).toBe(false);

    const upserted = await createForwardingRule({
      source_address: target,
      target_address: "archive@example.net",
      enabled: false,
    }, store);
    expect(upserted.enabled).toBe(false);
    // 520 rules, not 521: the row was UPDATED. On both schemas an insert here violates
    // `UNIQUE(source_address, target_address, mode)`.
    expect(await listForwardingRules({}, store)).toHaveLength(520);
  });
});

// ---------------------------------------------------------------------------------
// The reads.
// ---------------------------------------------------------------------------------

/**
 * Three rules whose "by source then target" order is NOT the order either store lists them
 * in. Written newest-last, so SQLite's `updated_at DESC, id DESC` returns them reversed.
 */
async function seedThree(store: EmailStore): Promise<void> {
  // WRITE ORDER MATTERS HERE. SQLite's generic list serves `updated_at DESC, id DESC`, so it
  // hands these back newest-first — and this write order makes that reversal DIFFER from
  // "by source then target", which an insertion order of (b@t, a@z, a@t) would not have
  // done: reversing that happens to produce the sorted answer, and the ordering control
  // below would then have passed against a module that did no sorting at all.
  await createForwardingRule({ source_address: "a@x.com", target_address: "t@x.com" }, store);
  await createForwardingRule({ source_address: "b@x.com", target_address: "t@x.com" }, store);
  await createForwardingRule({ source_address: "a@x.com", target_address: "z@x.com", enabled: false }, store);
}

describe("listForwardingRules", () => {
  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`orders by source then target on the ${name}, which is not the store's own order`, async () => {
      const store = makeStore();
      await seedThree(store);

      expect((await listForwardingRules({}, store)).map((r) => [r.source_address, r.target_address])).toEqual([
        ["a@x.com", "t@x.com"],
        ["a@x.com", "z@x.com"],
        ["b@x.com", "t@x.com"],
      ]);
    });

    it(`filters by source and by enabled on the ${name}`, async () => {
      const store = makeStore();
      await seedThree(store);

      expect((await listForwardingRules({ source_address: "A@X.com" }, store)).map((r) => r.target_address))
        .toEqual(["t@x.com", "z@x.com"]);
      expect((await listForwardingRules({ enabled: false }, store)).map((r) => r.target_address))
        .toEqual(["z@x.com"]);
      expect((await listForwardingRules({ enabled: true }, store)).map((r) => r.source_address))
        .toEqual(["a@x.com", "b@x.com"]);
      // A source nobody forwards from is an empty list, not everything.
      expect(await listForwardingRules({ source_address: "nobody@x.com" }, store)).toEqual([]);
    });

    it(`windows the sorted set on the ${name}, and ignores an offset with no limit`, async () => {
      const store = makeStore();
      await seedThree(store);

      expect((await listForwardingRules({ limit: 2 }, store)).map((r) => r.target_address))
        .toEqual(["t@x.com", "z@x.com"]);
      expect((await listForwardingRules({ limit: 2, offset: 1 }, store)).map((r) => r.target_address))
        .toEqual(["z@x.com", "t@x.com"]);
      expect(await listForwardingRules({ limit: 2, offset: 99 }, store)).toEqual([]);
      // NO LIMIT MEANS EVERY ROW AND THE OFFSET IS IGNORED. Both deleted arms did this (the
      // local one appended `LIMIT ? OFFSET ?` only when a limit was present; the HTTP one
      // returned the unsliced array), and it is preserved rather than tidied — an offset
      // that started working on its own would silently change what a caller sees.
      expect(await listForwardingRules({ offset: 2 }, store)).toHaveLength(3);
    });
  }

  it("proves the store's own list order really is the wrong answer", async () => {
    // THE CONTROL FOR THE ORDERING CASE. Without it "the module returned them sorted" is
    // consistent with the module doing nothing at all.
    const store = sqliteStore();
    await seedThree(store);
    // `updated_at` IS STAMPED EXPLICITLY, and finding out why is worth recording: three rules
    // written in the same millisecond share an `updated_at`, so SQLite's `updated_at DESC,
    // id DESC` falls through to a RANDOM uuid and the store's own order is not merely
    // different from this module's — it is not stable between runs. Stamping it makes the
    // divergence deterministic instead of leaving the control flaky.
    db.run("UPDATE forwarding_rules SET updated_at = '2026-01-03 00:00:00' WHERE target_address = 't@x.com' AND source_address = 'a@x.com'");
    db.run("UPDATE forwarding_rules SET updated_at = '2026-01-02 00:00:00' WHERE source_address = 'b@x.com'");
    db.run("UPDATE forwarding_rules SET updated_at = '2026-01-01 00:00:00' WHERE target_address = 'z@x.com'");

    const raw = (await storedRows(store)).map((row) => [row["source_address"], row["target_address"]]);
    const sorted = (await listForwardingRules({}, store)).map((rule) => [rule.source_address, rule.target_address]);
    expect(raw).toEqual([["a@x.com", "t@x.com"], ["b@x.com", "t@x.com"], ["a@x.com", "z@x.com"]]);
    expect(sorted).toEqual([["a@x.com", "t@x.com"], ["a@x.com", "z@x.com"], ["b@x.com", "t@x.com"]]);
    expect(raw).not.toEqual(sorted);
  });

  it("cannot push `enabled` down to the HTTP store, which is why it is applied here", async () => {
    // THE CONTROL FOR CLIENT-SIDE FILTERING. `/v1/forwarding` declares `source_address`,
    // `target_address` and `mode` as filters and nothing else, so the HTTP store refuses
    // `enabled` up front rather than accepting a superset. If that ever changes, this fails
    // and the push-down becomes available.
    const store = httpStore();
    const refused = await store.forwarding.list({ filters: { enabled: "true" } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("invalid_input");
      expect(refused.message).toContain("does not filter on enabled");
    }
    // `source_address` IS declared, so the push-down this module does use is available.
    const accepted = await store.forwarding.list({ filters: { source_address: "user@example.com" } });
    expect(accepted.ok).toBe(true);
  });

  it("throws rather than serving a slice of a table it could not read to the end", async () => {
    // A SHORT PAGE IS NOT THE END OF THE TABLE, and neither is a full one. This store hands
    // back a non-empty page forever, so the enumeration exhausts its budget and the answer
    // is an exception — a slice of a partial set is not "the first two rules", it is two
    // rows presented as the first two.
    // The store is a WELL-BEHAVED offset pager over an endless table, so the enumeration is
    // stable and un-shifted: the only reason it cannot finish is that it ran out of page
    // budget. That matters — a stub that merely looked shifted would have thrown for the
    // wrong reason and the case would not have covered truncation at all.
    let pages = 0;
    const store = storeWithForwarding({
      async list(opts): Promise<Outcome<ResourceRow[]>> {
        pages += 1;
        const offset = opts?.offset ?? 0;
        return { ok: true, value: [syntheticRow(offset), syntheticRow(offset + 1)] };
      },
    });
    await expect(listForwardingRules({ limit: 2 }, store)).rejects.toThrow(
      /could not be read to the end[\s\S]*refusing to answer from part of the table/,
    );
    await expect(listForwardingRules({ limit: 2 }, store)).rejects.toThrow(/duplicates: 0, shifted: false/);
    expect(pages).toBeGreaterThan(2);
  });

  it("treats a SHORT page as a page and not as the end of the table", async () => {
    // THE POSITIVE CONTROL for the case above. This store holds three rows and serves at
    // most TWO per request no matter how many are asked for — exactly what a clamping list
    // route looks like — so the first page is SHORT. The end of the table is the empty page
    // after them, and the answer is all three rows rather than an exception.
    const table = [syntheticRow(3), syntheticRow(1), syntheticRow(2)];
    const shortPage = 2;
    const served: number[] = [];
    const store = storeWithForwarding({
      async list(opts): Promise<Outcome<ResourceRow[]>> {
        const offset = opts?.offset ?? 0;
        const page = table.slice(offset, offset + shortPage);
        served.push(page.length);
        return { ok: true, value: page };
      },
    });
    const rules = await listForwardingRules({}, store);
    expect(rules.map((rule) => rule.source_address)).toEqual([
      "source-000001@example.com",
      "source-000002@example.com",
      "source-000003@example.com",
    ]);
    // The control on the control. Every page this store served was SHORTER than the 500 rows
    // the pager asked for, and the enumeration still went on: three requests, and the last
    // one came back holding only the anchor row — no FRESH rows — which is the end-of-table
    // signal. A pager that read the first short page as the end would have answered two rows.
    expect(served).toEqual([shortPage, shortPage, 1]);
    for (const length of served) expect(length).toBeLessThan(500);
  });

  it("treats a filtered read answered with rows outside the filter as a fault", async () => {
    // The service's generic list route IGNORES a query parameter it does not declare and
    // answers with the UNFILTERED list — a superset presented as a filtered result. The
    // HTTP store refuses an undeclared filter up front, but a store that accepts the filter
    // and then does not apply it is not something a type can rule out.
    const store = storeWithForwarding({
      async list(opts): Promise<Outcome<ResourceRow[]>> {
        return opts?.filters
          ? { ok: true, value: [syntheticRow(1, { source_address: "someone-else@example.com" })] }
          : { ok: true, value: [] };
      },
    });
    await expect(listForwardingRules({ source_address: "user@example.com" }, store)).rejects.toThrow(
      /rows outside the filter/,
    );
  });
});

describe("getForwardingRule", () => {
  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`answers null for an id that is not there, on the ${name}`, async () => {
      const store = makeStore();
      await createForwardingRule({ source_address: "user@example.com", target_address: "archive@example.net" }, store);
      expect(await getForwardingRule("no-such-rule", store)).toBeNull();
    });
  }

  it("refuses to report another row as the requested rule", async () => {
    const store = storeWithForwarding({
      async get(): Promise<Outcome<ResourceRow | null>> {
        return { ok: true, value: syntheticRow(1, { id: "a-different-rule" }) };
      },
    });
    await expect(getForwardingRule("the-one-i-asked-for", store)).rejects.toThrow(
      /answered a forwarding-rule read by id with a different row/,
    );
  });
});

// ---------------------------------------------------------------------------------
// The stored-row mapper. These are the divergences only one store can produce.
// ---------------------------------------------------------------------------------

describe("reading a stored rule", () => {
  function storeServing(row: ResourceRow): EmailStore {
    return storeWithForwarding({
      async get(): Promise<Outcome<ResourceRow | null>> {
        return { ok: true, value: row };
      },
    });
  }

  it("accepts `enabled` as a SQLite integer and as a service boolean", async () => {
    for (const [value, expected] of [[1, true], [0, false], [true, true], [false, false]] as const) {
      const rule = await getForwardingRule("r", storeServing(syntheticRow(1, { id: "r", enabled: value })));
      expect(rule?.enabled, `enabled: ${JSON.stringify(value)}`).toBe(expected);
    }
  });

  it("faults on an `enabled` value that is neither, instead of guessing", async () => {
    // THE DELETED ARMS BOTH GUESSED, in opposite directions: `!!"no"` is `true` and
    // `cbool("TRUE")` is `false`. This flag decides whether mail is copied to a third
    // party, so a guess is not acceptable.
    for (const value of ["no", "TRUE", "", null, undefined, 2, "1"]) {
      await expect(
        getForwardingRule("r", storeServing(syntheticRow(1, { id: "r", enabled: value }))),
        `enabled: ${JSON.stringify(value)}`,
      ).rejects.toThrow(/no readable enabled flag/);
    }
  });

  it("faults on a mode the type does not admit rather than casting it", async () => {
    // Reachable on the service side ONLY: its migration drops the mode CHECK that SQLite
    // keeps. Both deleted mappers cast it, into a field `emails forwarding list` prints.
    await expect(getForwardingRule("r", storeServing(syntheticRow(1, { id: "r", mode: "relay" }))))
      .rejects.toThrow(/Invalid forwarding mode in database: relay/);
    await expect(getForwardingRule("r", storeServing(syntheticRow(1, { id: "r", mode: null }))))
      .rejects.toThrow(/Invalid forwarding mode in database: \(empty\)/);
  });

  it("faults on an absent required column rather than reporting the current time", async () => {
    // `ciso` (the deleted HTTP arm's reader) answers `new Date().toISOString()` for a value
    // it cannot find, so a rule whose `created_at` was unreadable was reported as having
    // been created at the moment it was read. All five of these are `NOT NULL` in both
    // schemas and projected by both read paths.
    for (const column of ["id", "source_address", "target_address", "created_at", "updated_at"]) {
      const row = syntheticRow(1, { id: "r" });
      delete row[column];
      await expect(getForwardingRule("r", storeServing(row)), `absent ${column}`)
        .rejects.toThrow(/has no readable/);
    }
  });

  it("keeps a null provider and an empty from-address null, and does not invent them", async () => {
    const rule = await getForwardingRule("r", storeServing(syntheticRow(1, {
      id: "r",
      provider_id: null,
      from_address: "",
    })));
    expect(rule?.provider_id).toBeNull();
    expect(rule?.from_address).toBeNull();
  });
});

// ---------------------------------------------------------------------------------
// The writes.
// ---------------------------------------------------------------------------------

describe("setForwardingRuleEnabled", () => {
  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`toggles a rule and reports the store's own row, on the ${name}`, async () => {
      const store = makeStore();
      const rule = await createForwardingRule({
        source_address: "user@example.com",
        target_address: "archive@example.net",
      }, store);
      expect(rule.enabled).toBe(true);

      expect((await setForwardingRuleEnabled(rule.id, false, store)).enabled).toBe(false);
      expect((await getForwardingRule(rule.id, store))?.enabled).toBe(false);
      expect((await setForwardingRuleEnabled(rule.id, true, store)).enabled).toBe(true);
      expect((await listForwardingRules({}, store))[0]?.enabled).toBe(true);
    });

    it(`names the missing rule rather than inventing one, on the ${name}`, async () => {
      await expect(setForwardingRuleEnabled("no-such-rule", true, makeStore()))
        .rejects.toThrow(/Forwarding rule not found: no-such-rule/);
    });
  }
});

describe("removeForwardingRule", () => {
  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`removes once and reports false the second time, on the ${name}`, async () => {
      const store = makeStore();
      const rule = await createForwardingRule({
        source_address: "user@example.com",
        target_address: "archive@example.net",
      }, store);
      expect(await removeForwardingRule(rule.id, store)).toBe(true);
      expect(await removeForwardingRule(rule.id, store)).toBe(false);
      expect(await listForwardingRules({}, store)).toEqual([]);
      expect(await storedRows(store)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------
// A refusal is never an answer.
// ---------------------------------------------------------------------------------

describe("a store that refuses", () => {
  it("makes every rule operation throw, naming the refusal, and never answers empty", async () => {
    const store = storeWithForwarding({
      async list(): Promise<Outcome<ResourceRow[]>> {
        return CAPABILITY_REFUSAL;
      },
      async get(): Promise<Outcome<ResourceRow | null>> {
        return CAPABILITY_REFUSAL;
      },
      async create(): Promise<Outcome<ResourceRow>> {
        return CAPABILITY_REFUSAL;
      },
      async update(): Promise<Outcome<ResourceRow | null>> {
        return CAPABILITY_REFUSAL;
      },
      async remove(): Promise<Outcome<boolean>> {
        return CAPABILITY_REFUSAL;
      },
    });

    // EVERY ONE OF THESE HAS A COMFORTABLE WRONG ANSWER available — `[]`, `null`, `false`,
    // "not found" — and a refusal must not be reported as any of them. The refusal's own
    // code and status are carried through so a caller can tell 501 from 404.
    await expect(listForwardingRules({}, store)).rejects.toThrow(
      /cannot list this installation's forwarding rules \(capability_unavailable, 501\)/,
    );
    await expect(getForwardingRule("r", store)).rejects.toThrow(
      /cannot read a forwarding rule \(capability_unavailable, 501\)/,
    );
    await expect(createForwardingRule({
      source_address: "user@example.com",
      target_address: "archive@example.net",
    }, store)).rejects.toThrow(/cannot read this installation's forwarding rules \(capability_unavailable, 501\)/);
    await expect(setForwardingRuleEnabled("r", true, store)).rejects.toThrow(
      /cannot update a forwarding rule \(capability_unavailable, 501\)/,
    );
    await expect(removeForwardingRule("r", store)).rejects.toThrow(
      /cannot remove a forwarding rule \(capability_unavailable, 501\)/,
    );
  });

  it("names no setting and no command in the refusal it reports", async () => {
    // A refusal that tells the caller which variable to flip is a refusal documenting its
    // own bypass.
    const store = storeWithForwarding({
      async remove(): Promise<Outcome<boolean>> {
        return CAPABILITY_REFUSAL;
      },
    });
    const message = await removeForwardingRule("r", store).then(
      () => "it did not refuse",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(message).toContain("capability_unavailable");
    expect(message).not.toMatch(/EMAILS_|HASNA_|export |emails forwarding/);
  });

  it("reports a refused WRITE as refused rather than as a rule that was saved", async () => {
    // #121 found a refused write reported to the CLI as done. The READ succeeds here, so the
    // upsert gets as far as the write and the refusal is the only thing between the caller
    // and a fabricated success.
    const store = storeWithForwarding({
      async create(): Promise<Outcome<ResourceRow>> {
        return CAPABILITY_REFUSAL;
      },
    });
    await expect(createForwardingRule({
      source_address: "user@example.com",
      target_address: "archive@example.net",
    }, store)).rejects.toThrow(/cannot store a forwarding rule \(capability_unavailable, 501\)/);
    // And nothing was stored, so the refusal is not a partial write reported as a refusal.
    expect(await storedRows(sqliteStore())).toEqual([]);
  });

  it("refuses to report a write the store answered with a different row", async () => {
    // The service's generic route ACCEPTS a body key the resource has no column for and
    // drops it silently. Both stores refuse an unknown column today; this is what notices
    // if one stops.
    const base = sqliteStore();
    const store = storeWithForwarding({
      async create(input): Promise<Outcome<ResourceRow>> {
        return base.forwarding.create({ ...input, target_address: "somewhere-else@example.net" });
      },
    });
    await expect(createForwardingRule({
      source_address: "user@example.com",
      target_address: "archive@example.net",
    }, store)).rejects.toThrow(/answered with a different row/);
  });

  it("refuses to report an update the store answered with a different row", async () => {
    const base = sqliteStore();
    const rule = await createForwardingRule({
      source_address: "user@example.com",
      target_address: "archive@example.net",
    }, base);
    const store = storeWithForwarding({
      async update(id): Promise<Outcome<ResourceRow | null>> {
        // Accept the write and answer with the row UNCHANGED — the "accepted and dropped"
        // class in its purest form.
        return base.forwarding.get(id);
      },
    });
    await expect(setForwardingRuleEnabled(rule.id, false, store)).rejects.toThrow(
      /answered a forwarding-rule update and answered with a different row|accepted a forwarding-rule update/,
    );
  });

  it("names the rule rather than re-inserting it when the update target has vanished", async () => {
    // The upsert READ the row and then the UPDATE answered `null`, which means the row was
    // deleted underneath it. Retrying as an insert would race the same deletion again and,
    // when it lost, violate `UNIQUE(source_address, target_address, mode)` — so the vanished
    // row is REPORTED. Nothing else in this suite can reach that branch, because it needs the
    // read and the write to disagree.
    const base = sqliteStore();
    const rule = await createForwardingRule({
      source_address: "user@example.com",
      target_address: "archive@example.net",
    }, base);
    const store = storeWithForwarding({
      async update(): Promise<Outcome<ResourceRow | null>> {
        return { ok: true, value: null };
      },
    });
    await expect(createForwardingRule({
      source_address: "user@example.com",
      target_address: "archive@example.net",
      enabled: false,
    }, store)).rejects.toThrow(new RegExp(`Forwarding rule not found: ${rule.id}`));
    // And the row is untouched: the failed upsert did not insert a second one.
    expect(await listForwardingRules({}, base)).toHaveLength(1);
  });

  it("reports a store fault as a fault rather than as an empty list", async () => {
    const store = storeWithForwarding({
      async list(): Promise<Outcome<ResourceRow[]>> {
        throw new Error("the connection went away");
      },
    });
    await expect(listForwardingRules({}, store)).rejects.toThrow(
      /faulted while it list this installation's forwarding rules: the connection went away/,
    );
  });
});

// ---------------------------------------------------------------------------------
// The two operations whose data exists in local SQLite only.
// ---------------------------------------------------------------------------------

/**
 * One inbound message addressed to `to`, with an explicit `received_at`.
 *
 * Seeded with SQL rather than through `src/db/inbound.*`, which is a DIFFERENT family and
 * still has arms: importing one of them here would put this suite behind a module that is
 * scheduled for deletion, and importing its facade would make the fixture depend on the
 * deployment word this programme is removing.
 */
function seedInbound(to: string, receivedAt: string, opts: { isSent?: boolean } = {}): string {
  const id = `inbound-${to}-${receivedAt}`;
  db.run(
    `INSERT INTO inbound_emails (id, from_address, to_addresses, subject, text_body, received_at, created_at, is_sent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, "sender@elsewhere.test", JSON.stringify([to]), "Hello", "body", receivedAt, receivedAt, opts.isSent ? 1 : 0],
  );
  // `inbound_recipients` is DERIVED from `to_addresses` by an AFTER INSERT trigger, so this
  // is `OR IGNORE` rather than a plain insert — and the row is asserted rather than assumed,
  // because the pending-forward join is on this table and a silently absent recipient would
  // make every case below pass by returning nothing.
  db.run(
    "INSERT OR IGNORE INTO inbound_recipients (inbound_email_id, address, domain) VALUES (?, ?, ?)",
    [id, to, to.split("@")[1] ?? ""],
  );
  const recipient = db
    .query("SELECT COUNT(*) AS n FROM inbound_recipients WHERE inbound_email_id = ? AND address = ?")
    .get(id, to) as { n: number };
  if (recipient.n !== 1) throw new Error(`inbound fixture ${id} has ${recipient.n} recipient rows for ${to}`);
  return id;
}

/**
 * A rule whose `created_at` is set explicitly, so the backfill gate can be exercised.
 *
 * NO STORE IS INJECTED, deliberately: the configured store is the same in-memory SQLite
 * database, so this fixture works under the collapsed signature AND under the deleted
 * facade's — which is what lets the behavioural cases below run against `main` and DETECT a
 * wrong answer there instead of dying on a signature mismatch.
 */
async function seedRule(source: string, createdAt: string, opts: { enabled?: boolean } = {}): Promise<string> {
  const rule = await createForwardingRule({
    source_address: source,
    target_address: "archive@example.net",
    enabled: opts.enabled ?? true,
  });
  db.run("UPDATE forwarding_rules SET created_at = ? WHERE id = ?", [createdAt, rule.id]);
  return rule.id;
}

/**
 * Force a value into `forwarding_rules` that its CHECK constraint forbids.
 *
 * This is how the SERVICE's side of the asymmetry is reproduced locally: the self-hosted
 * Postgres migration DROPS `forwarding_rules_mode_check`, so a row the SQLite writer can
 * never produce is an ordinary row over there. Suspending the constraint is the only way to
 * put such a row in front of this module's read path without standing up Postgres.
 */
function forceRuleColumn(id: string, column: "mode" | "enabled", value: string): void {
  db.run("PRAGMA ignore_check_constraints = ON");
  try {
    db.run(`UPDATE forwarding_rules SET ${column} = ? WHERE id = ?`, [value, id]);
  } finally {
    db.run("PRAGMA ignore_check_constraints = OFF");
  }
  const stored = db.query(`SELECT ${column} AS v FROM forwarding_rules WHERE id = ?`).get(id) as { v: unknown };
  if (String(stored.v) !== value) {
    throw new Error(`fixture could not force ${column} to ${value}; stored ${String(stored.v)}`);
  }
}

describe("listPendingForwarding (local storage only)", () => {
  it("lists inbound mail an enabled rule has not copied yet, once", async () => {
    const ruleId = await seedRule("user@example.com", "2026-01-01 00:00:00");
    const inboundId = seedInbound("user@example.com", "2026-01-02 00:00:00");

    const pending = listPendingForwarding(100, db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.inbound_email_id).toBe(inboundId);
    // The rule carried on the pending item is the FULLY MAPPED rule, from the same mapper
    // the seam reads use — not a partial row.
    expect(pending[0]?.rule).toMatchObject({
      id: ruleId,
      source_address: "user@example.com",
      target_address: "archive@example.net",
      mode: "app-copy",
      enabled: true,
      created_at: "2026-01-01 00:00:00",
    });

    recordForwardingDelivery({ rule_id: ruleId, inbound_email_id: inboundId, status: "sent" }, db);
    expect(listPendingForwarding(100, db)).toEqual([]);
  });

  it("re-offers a delivery that FAILED, and never one that was sent", async () => {
    const ruleId = await seedRule("user@example.com", "2026-01-01 00:00:00");
    const inboundId = seedInbound("user@example.com", "2026-01-02 00:00:00");

    recordForwardingDelivery({
      rule_id: ruleId,
      inbound_email_id: inboundId,
      status: "failed",
      error: "no provider",
    }, db);
    expect(listPendingForwarding(100, db)).toHaveLength(1);

    recordForwardingDelivery({ rule_id: ruleId, inbound_email_id: inboundId, status: "sent" }, db);
    expect(listPendingForwarding(100, db)).toEqual([]);
  });

  it("excludes mail received before the rule existed unless backfill is asked for", async () => {
    await seedRule("user@example.com", "2026-01-10 00:00:00");
    const historical = seedInbound("user@example.com", "2026-01-01 00:00:00");

    expect(listPendingForwarding(100, db)).toEqual([]);
    expect(listPendingForwarding(100, db, { backfill: true }).map((p) => p.inbound_email_id))
      .toEqual([historical]);
  });

  it("excludes a disabled rule and mail this app itself sent", async () => {
    await seedRule("disabled@example.com", "2026-01-01 00:00:00", { enabled: false });
    seedInbound("disabled@example.com", "2026-01-02 00:00:00");
    await seedRule("outbound@example.com", "2026-01-01 00:00:00");
    seedInbound("outbound@example.com", "2026-01-02 00:00:00", { isSent: true });

    expect(listPendingForwarding(100, db)).toEqual([]);
    // The positive control: with the rule ENABLED and the message not self-sent, the same
    // fixture does produce a pending item — so the empty answer above is the gate working
    // rather than the fixture being wrong.
    await seedRule("live@example.com", "2026-01-01 00:00:00");
    seedInbound("live@example.com", "2026-01-02 00:00:00");
    expect(listPendingForwarding(100, db)).toHaveLength(1);
  });

  it("faults on a locally stored rule the shared mapper cannot read", async () => {
    // THE PENDING SCAN USES THE SAME MAPPER THE SEAM READS DO, so a local row that is not a
    // readable forwarding rule is a fault here too rather than only on the other path. An
    // empty `created_at` is the reachable case: it is `NOT NULL` but not non-empty, and
    // `datetime('')` is NULL — so the row is invisible to the received-at gate and only shows
    // up under `--backfill`, which is exactly where a lax mapper would hand a caller a rule
    // with no creation time.
    const id = await seedRule("user@example.com", "2026-01-01 00:00:00");
    const inboundId = seedInbound("user@example.com", "2026-01-02 00:00:00");
    db.run("UPDATE forwarding_rules SET created_at = '' WHERE id = ?", [id]);

    expect(() => listPendingForwarding(100, db, { backfill: true })).toThrow(/has no readable created_at/);
    // THE POSITIVE CONTROL: with a readable `created_at` the same fixture yields the pending
    // item, so the fault above is the mapper and not the fixture.
    db.run("UPDATE forwarding_rules SET created_at = '2026-01-01 00:00:00' WHERE id = ?", [id]);
    expect(listPendingForwarding(100, db, { backfill: true }).map((p) => p.inbound_email_id)).toEqual([inboundId]);
  });

  it("refuses a non-finite limit instead of silently returning the whole table", async () => {
    // `Math.trunc(NaN)` is `NaN`, which binds as SQL NULL — and `LIMIT NULL` in SQLite
    // means NO LIMIT. So the deleted arm's clamp turned a bad limit into an unbounded read.
    await seedRule("user@example.com", "2026-01-01 00:00:00");
    for (let n = 0; n < 3; n += 1) seedInbound("user@example.com", `2026-01-02 00:00:0${n}`);

    expect(() => listPendingForwarding(Number.NaN, db)).toThrow(/limit must be a finite number/);
    expect(() => listPendingForwarding(Number.POSITIVE_INFINITY, db)).toThrow(/limit must be a finite number/);
    // The clamp itself is preserved exactly: a finite limit still bounds the page, and a
    // limit below one is still floored at one rather than becoming "no rows".
    expect(listPendingForwarding(2, db)).toHaveLength(2);
    expect(listPendingForwarding(0, db)).toHaveLength(1);
    expect(listPendingForwarding(3, db)).toHaveLength(3);
  });
});

describe("recordForwardingDelivery (local storage only)", () => {
  it("keeps one ledger row per (rule, inbound message) and reports the stored row", async () => {
    const ruleId = await seedRule("user@example.com", "2026-01-01 00:00:00");
    const inboundId = seedInbound("user@example.com", "2026-01-02 00:00:00");

    const failed = recordForwardingDelivery({
      rule_id: ruleId,
      inbound_email_id: inboundId,
      status: "failed",
      error: "no active provider",
    }, db);
    expect(failed).toMatchObject({
      rule_id: ruleId,
      inbound_email_id: inboundId,
      status: "failed",
      error: "no active provider",
      sent_email_id: null,
    });
    expect(failed.id).toBeTruthy();
    // The timestamp comes from the database, not from this client.
    expect(failed.created_at).toBeTruthy();

    const sent = recordForwardingDelivery({ rule_id: ruleId, inbound_email_id: inboundId, status: "sent" }, db);
    expect(sent.id).toBe(failed.id);
    expect(sent.status).toBe("sent");
    expect(sent.error).toBeNull();
    const rows = db.query("SELECT COUNT(*) AS n FROM forwarding_deliveries").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("lets a later FAILURE overwrite an earlier SUCCESS — a live defect, pinned deliberately", async () => {
    // THIS TEST ASSERTS THE WRONG ANSWER ON PURPOSE, so that neither direction of change is
    // silent. `INSERT OR REPLACE` is keyed on `(rule_id, inbound_email_id)` and the pending join
    // excludes a pair only for `status = 'sent'`, so replacing a `sent` row with a `failed` one
    // makes the pair PENDING AGAIN and the next run calls the provider a second time. The
    // pipeline cannot normally reach that order — a `sent` row hides the pair from the scan — but
    // two concurrent runs can, and any direct caller of the export can.
    //
    // It is inherited rather than fixed because changing what a published write does with an
    // already-successful delivery is a product decision, not a mode-axis refactor; the fix
    // belongs in the idempotency-fenced ledger the seam widening would bring, where `sent` is
    // TERMINAL for a pair. WIDENING THE JOIN INSTEAD WOULD BE WRONG: it would strand every
    // genuine retry, which the case above this one exists to protect.
    const ruleId = await seedRule("user@example.com", "2026-01-01 00:00:00");
    const inboundId = seedInbound("user@example.com", "2026-01-02 00:00:00");

    recordForwardingDelivery({ rule_id: ruleId, inbound_email_id: inboundId, status: "sent" }, db);
    expect(listPendingForwarding(100, db)).toEqual([]);

    recordForwardingDelivery({ rule_id: ruleId, inbound_email_id: inboundId, status: "failed", error: "later" }, db);
    // The defect, stated as an assertion: the successful delivery is GONE from the ledger and the
    // message is offered for forwarding again.
    const ledger = db.query("SELECT status FROM forwarding_deliveries WHERE rule_id = ?").all(ruleId) as Array<{ status: string }>;
    expect(ledger.map((r) => r.status)).toEqual(["failed"]);
    expect(listPendingForwarding(100, db)).toHaveLength(1);
  });

  it("refuses an out-of-enum status BEFORE writing anything", async () => {
    const ruleId = await seedRule("user@example.com", "2026-01-01 00:00:00");
    const inboundId = seedInbound("user@example.com", "2026-01-02 00:00:00");

    expect(() => recordForwardingDelivery({
      rule_id: ruleId,
      inbound_email_id: inboundId,
      status: "pending" as "sent",
    }, db)).toThrow(/status must be sent or failed/);
    const rows = db.query("SELECT COUNT(*) AS n FROM forwarding_deliveries").get() as { n: number };
    expect(rows.n).toBe(0);
    // The positive control: a legal status still writes.
    expect(recordForwardingDelivery({ rule_id: ruleId, inbound_email_id: inboundId, status: "sent" }, db).status)
      .toBe("sent");
  });
});

// ---------------------------------------------------------------------------------
// The divergences a stored row can carry, read through the CONFIGURED store.
//
// These three inject no store, so they run unchanged against the deleted two-arm facade —
// which is the point. Every other behavioural case in this file dies on `main` with "is not
// a function", a SIGNATURE failure that proves nothing about behaviour; these three make
// `main` produce a WRONG ANSWER and fail on it.
// ---------------------------------------------------------------------------------

describe("a stored rule the type does not admit", () => {
  it("is a fault rather than a mode cast into a field the CLI prints", async () => {
    const id = await seedRule("user@example.com", "2026-01-01 00:00:00");
    forceRuleColumn(id, "mode", "relay");

    // The deleted mappers both did `row.mode as ForwardingMode` and handed "relay" to
    // `emails forwarding list`, which prints it. Reachable for real on the service side,
    // whose migration drops the CHECK this fixture suspends.
    await expect(getForwardingRule(id)).rejects.toThrow(/Invalid forwarding mode in database: relay/);
    await expect(listForwardingRules()).rejects.toThrow(/Invalid forwarding mode in database: relay/);
    // THE POSITIVE CONTROL: with a legal mode the same row reads back fine, so the fixture
    // is not simply breaking every read.
    forceRuleColumn(id, "mode", "app-copy");
    expect((await getForwardingRule(id))?.mode).toBe("app-copy");
  });

  it("is a fault rather than a guessed `enabled` flag", async () => {
    const id = await seedRule("user@example.com", "2026-01-01 00:00:00");
    // SQLite is loosely typed, so a non-integer really can land in this column — and
    // `!!"no"` (the deleted local mapper) is `true`. A rule that copies mail to a third
    // party must not have its switch guessed.
    forceRuleColumn(id, "enabled", "no");

    await expect(getForwardingRule(id)).rejects.toThrow(/no readable enabled flag/);
    await expect(listForwardingRules()).rejects.toThrow(/no readable enabled flag/);
    forceRuleColumn(id, "enabled", "1");
    expect((await getForwardingRule(id))?.enabled).toBe(true);
  });
});

describe("a bad pending-forward limit", () => {
  it("is refused rather than turned into an unbounded read", async () => {
    // `Math.trunc(NaN)` is `NaN`, which binds as SQL NULL, and `LIMIT NULL` in SQLite means
    // NO LIMIT — so the deleted arm's clamp silently returned the whole table for a limit it
    // could not read. Six pending messages make that visible rather than academic.
    await seedRule("user@example.com", "2026-01-01 00:00:00");
    for (let n = 0; n < 6; n += 1) seedInbound("user@example.com", `2026-01-02 00:00:0${n}`);

    expect(() => listPendingForwarding(Number.NaN, db)).toThrow(/limit must be a finite number/);
    // THE CONTROL that the fixture really does hold more rows than the bounded page, so
    // "returns the whole table" and "returns the page" are distinguishable answers.
    expect(listPendingForwarding(2, db)).toHaveLength(2);
    expect(listPendingForwarding(100, db)).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------------
// Module shape. WEAK detectors — they prove the arms are gone, not that anything works.
// ---------------------------------------------------------------------------------

describe("the collapsed module", () => {
  const dbDir = import.meta.dir;

  it("has no arm modules left", () => {
    expect(existsSync(join(dbDir, "forwarding.local.ts"))).toBe(false);
    expect(existsSync(join(dbDir, "forwarding.remote.ts"))).toBe(false);
    // The floor: the facade itself is still there under the same name, so consumers' import
    // paths did not move.
    expect(existsSync(join(dbDir, "forwarding.ts"))).toBe(true);
  });

  it("reads no deployment-mode variable and imports no routing helper", () => {
    const source = readFileSync(join(dbDir, "forwarding.ts"), "utf8");
    // Comments in this module discuss the axis by role, so the check is on IMPORTS and CALLS
    // rather than on prose.
    for (const forbidden of [
      /from "\.\/self-hosted-store\.js"/,
      /from "\.\/self-hosted-resource\.js"/,
      /from "\.\/database-routing\.js"/,
      /from "\.\/forwarding\.(local|remote)\.js"/,
      /selfHostedResource\(/,
      /process\.env\[/,
    ]) {
      expect(forbidden.test(source), `forwarding.ts still matches ${String(forbidden)}`).toBe(false);
    }
    // And the positive control that the file really was read.
    expect(source).toContain("createConfiguredEmailStore");
    expect(source.length).toBeGreaterThan(4000);
  });

  it("leaves the forwarding pipeline importing the facade rather than a deleted arm", () => {
    // THE PATH MOVED, and the guard did not weaken. When this was written the pipeline was
    // `src/lib/forwarding.local.ts`, an arm of a family that had not collapsed yet; that family
    // has since collapsed too, so the module that must not import a deleted arm is the ONE
    // implementation at `src/lib/forwarding.ts`. Both assertions still hold against it and both
    // still mean what they meant.
    const pipeline = readFileSync(join(dbDir, "..", "lib", "forwarding.ts"), "utf8");
    expect(pipeline).toContain('from "../db/forwarding.js"');
    expect(pipeline).not.toContain('from "../db/forwarding.local.js"');
    // Positive control that the file really was read, so a path that stops resolving cannot
    // satisfy the negative assertion by handing back an empty string.
    expect(pipeline.length).toBeGreaterThan(4000);
  });
});
