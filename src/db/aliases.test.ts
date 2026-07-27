// Per-domain ALIASES and catch-all routing has ONE implementation, and every operation
// reaches storage through the store seam.
//
// The family used to be a facade over a SQLite arm and a `curl`-bridge arm, with a
// compatibility shim in the middle because the two did not agree on the ARGUMENT ORDER of
// `listAliases`. Where they disagreed about BEHAVIOUR — and it was not only about who ran the
// SQL — is what this suite is built around:
//
//   * SIX OPERATIONS READ ONE CLAMPED PAGE AND CALLED IT THE TABLE. The deleted HTTP arm
//     answered `resolveAlias`, `getGlobalCatchAll`, `listAliases`, `listAliasesByTargets` and
//     both upsert dedup reads out of a single `list({ limit: 1000 })`, which both stores and
//     the service clamp to 500. There are 520-alias cases below for the two that matter most —
//     an alias that cannot be resolved is mail delivered to the wrong place, and an upsert that
//     cannot see the existing row attempts an insert both schemas' uniqueness rejects — and
//     each carries the CONTROL that one clamped page really does miss the row.
//   * ORDER. SQLite's generic resource path orders `aliases` by `updated_at DESC, id DESC`; the
//     service orders them `domain ASC, local_part ASC`. Both arms published "global catch-all
//     first, then domain, then local-part", so a limit/offset push-down returns the first N of
//     the STORE's order, re-sorted. There is a case whose fixture makes the two orderings
//     DISAGREE, carrying the control that the store's own first row is the wrong one.
//   * THE TWO ARMS SORTED WITH DIFFERENT COLLATIONS — SQL BINARY versus `localeCompare`, the
//     latter locale-dependent. Code-unit order is asserted directly.
//   * UNDECLARED WRITE COLUMNS. The deleted HTTP arm sent `id`/`created_at`/`updated_at` on
//     create and `updated_at` on update; `/v1/aliases` declares FOUR writable columns behind
//     `additionalProperties: false`, so the real HTTP store refuses all four. A recording-store
//     case pins exactly which columns this implementation sends.
//   * `protected` COMES BACK AS AN INTEGER OR A BOOLEAN, and the deleted coercions guessed in
//     opposite directions on strings. Both real shapes are accepted and everything else is a
//     fault — this is the flag that decides whether the catch-all preventing mail loss can be
//     deleted.
//   * ABSENT IS NOT `now()`. The deleted HTTP arm read both timestamps through a coercion that
//     fabricates the current time for a MISSING value.
//   * `target_address` MAY BE EMPTY AND MAY NOT BE ABSENT. `''` is the global catch-all's
//     documented target; a missing column is a store that stopped projecting it, and both
//     deleted mappers turned the two into the same empty string.
//
// EVERY BEHAVIOURAL CASE THAT CAN RUN AGAINST A STORE RUNS TWICE: once against a real SQLite
// store and once against an `HttpEmailStore` talking to a `/v1` service over real HTTP. That
// fixture stores nothing itself — it translates HTTP into the same seam — so a field this
// module mis-maps fails rather than being handed back. `src/test-support/v1-stub.ts` is
// deliberately NOT used: its generic list handler ignores equality filters and it serves
// `/v1/openapi.json` only on request, and the HTTP store validates every filter and every write
// column against that document.
//
// THE SQLITE MIGRATION SEEDS A PROTECTED GLOBAL CATCH-ALL and the self-hosted schema does not,
// so a freshly migrated database here already holds exactly one alias. That is a STORE fact
// rather than a module one and it is pinned below rather than hidden; cases that need an empty
// table delete it explicitly through `clearAliases()`, which is a raw SQL write and says so.
//
// TWO CASES PIN A DEFECT RATHER THAN A GUARANTEE, and they are named as defects so nobody
// "fixes" them silently in either direction: `setGlobalCatchAll` and `ensureDefaultCatchAll`
// both leave an already-unprotected global catch-all unprotected. Both deleted arms behaved
// identically, so there is no stronger arm to resolve toward, and changing what a published
// write does to a column the caller did not name is a product decision.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "./database.js";
import {
  ALL_DOMAINS,
  CATCH_ALL,
  createAlias,
  createCatchAll,
  ensureDefaultCatchAll,
  getAlias,
  getGlobalCatchAll,
  listAliases,
  listAliasesByTargets,
  removeAlias,
  resolveAlias,
  setGlobalCatchAll,
} from "./aliases.js";
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
 * The settings are named through the resolution's OWN exported constants rather than copied as
 * literals. This matters because "a database path AND an API are both configured" is a HARD
 * BOOT ERROR with deliberately no precedence rule, so a stray inherited API setting turns every
 * default-store case into that error.
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
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "aliases fixture" }) });
});

afterEach(() => {
  api.stop();
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (aliases test)" });
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
  message: "the test store does not serve aliases",
  status: 501,
} as const;

/**
 * The real store with ONE method replaced — the neutering pattern the store suites use. A
 * hand-rolled partial store cast to `EmailStore` would let a signature drift without `tsc`
 * noticing; this cannot, because `base` is checked against the seam.
 */
function storeWithAliases(patch: Partial<EmailStore["aliases"]>): EmailStore {
  const base = sqliteStore();
  return { ...base, aliases: { ...base.aliases, ...patch } };
}

/**
 * Delete every stored alias, including the one the migration seeded.
 *
 * Raw SQL on purpose: `removeAlias` REFUSES to delete a protected row, which is the behaviour
 * this suite checks elsewhere, so a fixture cannot go through it.
 */
function clearAliases(): void {
  db.run("DELETE FROM aliases");
}

/** A stored alias row, complete enough for the mapper to accept it. */
function syntheticRow(n: number, overrides: Record<string, unknown> = {}): ResourceRow {
  const stamp = new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
  return {
    id: `synthetic-${String(n).padStart(6, "0")}`,
    domain: "example.com",
    local_part: `local-${String(n).padStart(6, "0")}`,
    target_address: "ops@example.net",
    protected: 0,
    created_at: stamp,
    updated_at: stamp,
    ...overrides,
  };
}

/** Alias rows read through the seam rather than through this module. */
async function storedRows(store: EmailStore, limit = 500): Promise<ResourceRow[]> {
  const listed = await store.aliases.list({ limit });
  if (!listed.ok) throw new Error(`could not read the stored aliases: ${listed.message}`);
  return listed.value;
}

/**
 * Seed `count` aliases straight into SQLite, with a deliberately stamped `updated_at`.
 *
 * THE STAMP IS NOT DECORATION. Rows written in a tight loop share `updated_at` to the
 * millisecond, and SQLite's resource order is `updated_at DESC, id DESC` — so the store's own
 * order would fall through to a random uuid and any control assertion about "the row the first
 * page misses" would hold only most of the time, while stealing an unrelated case's evidence.
 * `src/db/forwarding.test.ts` records that exact flake being found by mutation testing.
 */
function seedAliases(count: number, domain: string): void {
  const insert = db.query(
    "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
      + " VALUES (?, ?, ?, ?, 0, ?, ?)",
  );
  for (let index = 0; index < count; index += 1) {
    const key = String(index).padStart(6, "0");
    const stamp = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    insert.run(`seeded-${key}`, domain, `local-${key}`, `bulk-${key}@example.net`, stamp, stamp);
  }
}

// ---------------------------------------------------------------------------------
// The upserts.
// ---------------------------------------------------------------------------------

describe("createAlias / createCatchAll / setGlobalCatchAll", () => {
  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`lower-cases the address and round-trips every field through the ${name}`, async () => {
      const store = makeStore();
      const alias = await createAlias("Hello@Acme.COM", "OPS@Acme.com", store);

      expect(alias.id).toBeTruthy();
      expect(alias).toMatchObject({
        domain: "acme.com",
        local_part: "hello",
        target_address: "ops@acme.com",
        protected: false,
      });
      // Neither timestamp is invented and neither is empty: both come from the store.
      expect(alias.created_at).toBeTruthy();
      expect(alias.updated_at).toBeTruthy();
      expect(await resolveAlias("HELLO@ACME.COM", store)).toBe("ops@acme.com");
    });

    it(`updates in place on (domain, local_part) rather than inserting twice, on the ${name}`, async () => {
      const store = makeStore();
      const first = await createAlias("hello@acme.com", "a@acme.com", store);
      const second = await createAlias("hello@acme.com", "b@acme.com", store);

      expect(second.id).toBe(first.id);
      expect(await resolveAlias("hello@acme.com", store)).toBe("b@acme.com");
      expect(await listAliases("acme.com", undefined, store)).toHaveLength(1);
    });

    it(`uses the sentinel local-part for a domain catch-all, on the ${name}`, async () => {
      const store = makeStore();
      const catchAll = await createCatchAll("Acme.com", "Inbox@acme.com", store);
      expect(catchAll.local_part).toBe(CATCH_ALL);
      expect(catchAll.domain).toBe("acme.com");
      expect(catchAll.target_address).toBe("inbox@acme.com");
      expect(catchAll.protected).toBe(false);
    });

    it(`creates the global catch-all protected, on the ${name}`, async () => {
      clearAliases();
      const store = makeStore();
      const global = await setGlobalCatchAll("Inbox@HQ.com", store);
      expect(global.domain).toBe(ALL_DOMAINS);
      expect(global.local_part).toBe(CATCH_ALL);
      expect(global.target_address).toBe("inbox@hq.com");
      expect(global.protected).toBe(true);
    });

    it(`splits on the LAST @, so a multi-@ local part survives, on the ${name}`, async () => {
      // Both deleted arms used `lastIndexOf("@")`, and nothing in the tree pinned it — an
      // adversarial reviewer's probe showed that `indexOf` survived every case here, which would
      // silently reparse `a@b@c.com` as `a` @ `b@c.com` and route a different recipient. A local
      // part containing `@` is legal in a quoted address and is exactly the input that separates
      // the two.
      const store = makeStore();
      const alias = await createAlias("a@b@c.com", "ops@c.com", store);
      expect(alias.local_part).toBe("a@b");
      expect(alias.domain).toBe("c.com");
      expect(await resolveAlias("a@b@c.com", store)).toBe("ops@c.com");
      // And the control: the other reading is NOT what happens.
      expect(alias.local_part).not.toBe("a");
      expect(alias.domain).not.toBe("b@c.com");
    });

    it(`answers absence for a blank id rather than faulting, on the ${name}`, async () => {
      // The SQLite arm answered `null`/`false` (`WHERE id = ''` matches nothing). An API store
      // instead requests `GET /v1/aliases/`, the service strips the trailing slash and dispatches
      // the LIST route, and the envelope that comes back is not a row — so the mapper faulted
      // where the stronger arm answered. Reachable from `emails alias remove ""` and MCP
      // `remove_alias {alias_id: ""}`. Adversarial review caught it.
      const store = makeStore();
      await createAlias("a@x.com", "t@x.com", store);
      expect(await getAlias("", store)).toBeNull();
      expect(await removeAlias("", store)).toBe(false);
      // And nothing was removed by the attempt.
      expect(await listAliases("x.com", undefined, store)).toHaveLength(1);
    });

    it(`refuses an unparseable alias address before touching the ${name}`, async () => {
      const store = makeStore();
      await expect(createAlias("acme.com", "ops@acme.com", store)).rejects.toThrow(
        /Invalid email address \(expected local@domain\): acme\.com/,
      );
      await expect(createAlias("hello@", "ops@acme.com", store)).rejects.toThrow(/Invalid email address/);
      // An EMPTY local part is its own rejection and needs its own case: the guard is
      // `at <= 0`, and a mutation run showed that weakening it to `at < 0` — which still
      // rejects an address with no `@` at all — survived every other case here.
      await expect(createAlias("@acme.com", "ops@acme.com", store)).rejects.toThrow(/Invalid email address/);
    });
  }

  it("refuses the unparseable address without reading or writing the store at all", async () => {
    // THE CONTROL for the case above: "it threw" is also consistent with the store refusing
    // the write, which would be a different guarantee and a slower failure.
    let touched = 0;
    const store = storeWithAliases({
      async list(): Promise<Outcome<ResourceRow[]>> {
        touched += 1;
        return { ok: true, value: [] };
      },
      async create(): Promise<Outcome<ResourceRow>> {
        touched += 1;
        return CAPABILITY_REFUSAL;
      },
    });
    await expect(createAlias("acme.com", "ops@acme.com", store)).rejects.toThrow(/Invalid email address/);
    expect(touched).toBe(0);
  });

  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`refuses to WRITE an alias with no domain, and writes nothing, on the ${name}`, async () => {
      // A REGRESSION THIS FAMILY SHIPPED FOR ONE COMMIT, found by adversarial review and pinned
      // here. `requiredText` faults on an empty `domain` on the way OUT, so a write that stored
      // one committed a row this module then refused to read — and because `getAlias` maps the
      // row, `removeAlias` could not delete it either: one `emails alias catch-all ""` made
      // `emails alias list` fail forever with no published way to recover. `createAlias` cannot
      // produce it and neither can `setGlobalCatchAll`; `createCatchAll("")` could, and so could
      // MCP `add_catch_all` with an empty domain.
      clearAliases();
      const store = makeStore();
      await expect(createCatchAll("", "ops@x.com", store)).rejects.toThrow(
        /An alias needs a domain and a local part; received "\*"@""\./,
      );
      // THE HALF THAT MATTERS: nothing was written. A throw AFTER the insert is what the
      // regression was.
      expect(await storedRows(store)).toEqual([]);
      // And the family still answers, rather than faulting on a row it left behind.
      expect(await listAliases(undefined, undefined, store)).toEqual([]);
    });
  }

  it("can DELETE a row it refuses to report, so an older version's write is recoverable", async () => {
    // The companion to the case above, for a database that already holds such a row: the guard
    // stops NEW ones, and this is the only way out for an old one. `removeAlias` therefore reads
    // the row without mapping it and needs only the protected flag to decide.
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('poison', '', '*', 'ops@x.com', 0, '2026-01-01', '2026-01-01')",
    );
    const store = sqliteStore();
    // It is genuinely unreportable — the control that this case is about a row the mapper rejects.
    await expect(getAlias("poison", store)).rejects.toThrow(/has no readable domain/);
    await expect(listAliases(undefined, undefined, store)).rejects.toThrow(/has no readable domain/);

    expect(await removeAlias("poison", store)).toBe(true);
    // And the family answers again.
    expect(await listAliases(undefined, undefined, store)).toEqual([]);
  });

  it("still refuses to delete a row whose protected flag cannot be read", async () => {
    // The negative control for the case above: reading the row without mapping it must not
    // become a way to delete something that might be the global catch-all.
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('odd-flag', 'x.com', 'a', 'ops@x.com', 'no', '2026-01-01', '2026-01-01')",
    );
    const store = sqliteStore();
    await expect(removeAlias("odd-flag", store)).rejects.toThrow(/refusing to guess whether it can be deleted/);
    expect(await storedRows(store)).toHaveLength(1);
  });

  it("sends ONLY the four writable columns, and never id or either timestamp", async () => {
    // THE DELETED HTTP ARM SENT `id`, `created_at` AND `updated_at` on create and `updated_at`
    // on update. `/v1/aliases` declares four writable columns behind
    // `additionalProperties: false`, so the real HTTP store REFUSES a write that names any of
    // them — the `curl` bridge did not validate. This records what is actually sent.
    const created: ResourceInput[] = [];
    const updated: ResourceInput[] = [];
    const base = sqliteStore();
    const recording: EmailStore = {
      ...base,
      aliases: {
        ...base.aliases,
        async create(input) {
          created.push(input);
          return base.aliases.create(input);
        },
        async update(id, patch) {
          updated.push(patch);
          return base.aliases.update(id, patch);
        },
      },
    };

    await createAlias("hello@acme.com", "a@acme.com", recording);
    await createAlias("hello@acme.com", "b@acme.com", recording);

    expect(created).toHaveLength(1);
    expect(Object.keys(created[0] as ResourceInput).sort()).toEqual([
      "domain",
      "local_part",
      "protected",
      "target_address",
    ]);
    expect(updated).toHaveLength(1);
    // The upsert's update names the target and nothing else. It does NOT name `updated_at`
    // (both stores stamp it themselves) and it does NOT name `protected` — which is the
    // inherited defect the module header records, pinned again further down.
    expect(Object.keys(updated[0] as ResourceInput)).toEqual(["target_address"]);
    for (const write of [...created, ...updated]) {
      for (const forbidden of ["id", "created_at", "updated_at"]) {
        expect(Object.hasOwn(write, forbidden), `a write named ${forbidden}`).toBe(false);
      }
    }
  });

  it("finds an existing alias that sits beyond the store's single-page clamp", async () => {
    // THE 520-ALIAS CASE. The deleted HTTP arm looked for the row to update inside one
    // `list({ limit: 1000 })`, which is clamped to 500 — so above 500 aliases it MISSED the row
    // and attempted an insert that `UNIQUE(domain, local_part)` rejects.
    clearAliases();
    seedAliases(520, "bulk.example");
    const store = httpStore();

    // THE CONTROL, first: one page really does stop at 500, and the row this case is about
    // really is outside it. Without this the case below is consistent with there being no clamp.
    //
    // WHICH row the page misses depends on the STORE's own order, and that is header note 2 in
    // one assertion: SQLite serves these rows `updated_at DESC, id DESC`, so the newest seeded
    // alias is on the first page and the OLDEST is the one that falls off. The service orders
    // them `domain ASC, local_part ASC` and would drop the other end. Neither ordering is
    // knowable from the seam, which is exactly why nothing here pushes a page down.
    const onePage = await store.aliases.list({ limit: 1000 });
    expect(onePage.ok).toBe(true);
    if (onePage.ok) {
      expect(onePage.value).toHaveLength(500);
      expect(onePage.value.some((row) => row["local_part"] === "local-000000")).toBe(false);
      expect(onePage.value.some((row) => row["local_part"] === "local-000519")).toBe(true);
    }

    const updated = await createAlias("local-000000@bulk.example", "moved@example.net", store);
    expect(updated.id).toBe("seeded-000000");
    expect(updated.target_address).toBe("moved@example.net");
    // And no second row was inserted for the same key.
    expect(await listAliases("bulk.example", undefined, store)).toHaveLength(520);
  });
});

// ---------------------------------------------------------------------------------
// listAliases.
// ---------------------------------------------------------------------------------

describe("listAliases", () => {
  /** Three aliases plus the seeded global catch-all, in a deliberately unsorted insert order. */
  async function seedFour(store: EmailStore): Promise<void> {
    await createAlias("b@x.com", "t@x.com", store);
    await createAlias("a@x.com", "t@x.com", store);
    await createAlias("a@y.com", "t@y.com", store);
  }

  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`puts the global catch-all first, then domain, then local-part, on the ${name}`, async () => {
      const store = makeStore();
      await seedFour(store);
      expect((await listAliases(undefined, undefined, store)).map((a) => `${a.local_part}@${a.domain}`)).toEqual([
        "*@*",
        "a@x.com",
        "b@x.com",
        "a@y.com",
      ]);
    });

    it(`filters by domain, lower-casing the argument, on the ${name}`, async () => {
      const store = makeStore();
      await seedFour(store);
      expect((await listAliases("X.com", undefined, store)).map((a) => a.local_part)).toEqual(["a", "b"]);
    });

    it(`treats an EMPTY domain as no filter, on the ${name}`, async () => {
      // BOTH DELETED ARMS TESTED THE ARGUMENT FOR TRUTHINESS, so `""` meant "the whole table".
      // Testing for `undefined` instead made this answer `[]` — reachable through
      // `emails alias list --domain ""` and the MCP tool — and the two arms AGREED here, so
      // there was no stronger arm to resolve toward. Found by adversarial review.
      const store = makeStore();
      await seedFour(store);
      expect(await listAliases("", undefined, store)).toHaveLength(4);
      expect(await listAliases("", undefined, store)).toEqual(await listAliases(undefined, undefined, store));
    });

    it(`windows the sorted set and ignores an offset with no limit, on the ${name}`, async () => {
      const store = makeStore();
      await seedFour(store);
      // offset 1 skips the global catch-all.
      expect((await listAliases(undefined, { limit: 2, offset: 1 }, store)).map((a) => `${a.local_part}@${a.domain}`))
        .toEqual(["a@x.com", "b@x.com"]);
      // An offset with no limit is ignored, which is both deleted arms' behaviour.
      expect(await listAliases(undefined, { offset: 3 }, store)).toHaveLength(4);
    });
  }

  it("proves the store's own list order really is the wrong answer", async () => {
    // THE CONTROL FOR THE ORDERING CASE. Without it "the module returned them sorted" is
    // consistent with the module doing nothing at all. `updated_at` is stamped explicitly for
    // the reason `seedAliases` records.
    const store = sqliteStore();
    await seedFour(store);
    db.run("UPDATE aliases SET updated_at = '2026-01-04 00:00:00' WHERE domain = 'y.com'");
    db.run("UPDATE aliases SET updated_at = '2026-01-03 00:00:00' WHERE domain = 'x.com' AND local_part = 'b'");
    db.run("UPDATE aliases SET updated_at = '2026-01-02 00:00:00' WHERE domain = 'x.com' AND local_part = 'a'");
    db.run("UPDATE aliases SET updated_at = '2026-01-01 00:00:00' WHERE domain = '*'");

    const raw = (await storedRows(store)).map((row) => `${String(row["local_part"])}@${String(row["domain"])}`);
    const sorted = (await listAliases(undefined, undefined, store)).map((a) => `${a.local_part}@${a.domain}`);
    expect(raw).toEqual(["a@y.com", "b@x.com", "a@x.com", "*@*"]);
    expect(sorted).toEqual(["*@*", "a@x.com", "b@x.com", "a@y.com"]);
    expect(raw).not.toEqual(sorted);
  });

  it("puts the global catch-all first even before a domain that sorts below the sentinel", async () => {
    // THE GLOBAL-FIRST TERM IS SEPARATE FROM THE DOMAIN COMPARISON, and this is the case that
    // proves it carries its own weight. Under code-unit order `*` (42) already sorts below every
    // letter and digit, so for a syntactically valid domain the term is redundant — a mutation
    // run showed that deleting it survived the ordering case above. A stored domain beginning
    // with a lower code unit is a row the mapper accepts and only another writer can produce,
    // and it is exactly where the term decides the answer.
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('g', '*', '*', 'hq@x.com', 1, '2026-01-01', '2026-01-01'),"
        + "        ('odd', '!odd.example', 'a', 't@x.com', 0, '2026-01-01', '2026-01-01')",
    );
    expect((await listAliases(undefined, undefined, sqliteStore())).map((a) => a.domain))
      .toEqual(["*", "!odd.example"]);
    // The control: the domain comparison alone really would have answered the other way round.
    expect(["*", "!odd.example"].slice().sort()).toEqual(["!odd.example", "*"]);
  });

  it("sorts in code-unit order rather than by the process locale", async () => {
    // The deleted HTTP arm used `localeCompare`, which is locale-dependent and orders `A`
    // AFTER `a` in most locales; SQLite's BINARY collation — the arm this resolves toward —
    // puts every upper-case code unit first. Uppercase rows can only arrive from another
    // writer, so they are seeded directly.
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('u', 'x.com', 'Beta', 't@x.com', 0, '2026-01-01', '2026-01-01'),"
        + "        ('l', 'x.com', 'alpha', 't@x.com', 0, '2026-01-01', '2026-01-01')",
    );
    expect((await listAliases("x.com", undefined, sqliteStore())).map((a) => a.local_part)).toEqual(["Beta", "alpha"]);
    // The control: `localeCompare` really would have answered the other way round.
    expect(["Beta", "alpha"].slice().sort((a, b) => a.localeCompare(b))).toEqual(["alpha", "Beta"]);
  });

  it("pushes the domain filter down, and the HTTP store really does accept it", async () => {
    // THE CONTROL FOR THE PUSH-DOWN. `/v1/aliases` declares `domain`, `local_part` and
    // `target_address`; if that ever narrows, this fails and the push-down has to go.
    const store = httpStore();
    for (const filter of ["domain", "local_part", "target_address"]) {
      const accepted = await store.aliases.list({ filters: { [filter]: "x.com" } });
      expect(accepted.ok, `/v1/aliases stopped filtering on ${filter}`).toBe(true);
    }
    // And a filter it does NOT declare is refused up front rather than answered with the
    // unfiltered list.
    const refused = await store.aliases.list({ filters: { protected: "1" } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("invalid_input");
      expect(refused.message).toContain("does not filter on protected");
    }
  });

  it("throws rather than serving a slice of a table it could not read to the end", async () => {
    // A SHORT PAGE IS NOT THE END OF THE TABLE, and neither is a full one. This store hands
    // back a non-empty page forever, so the enumeration exhausts its budget and the answer is
    // an exception — a slice of a partial set is not "the first two aliases", it is two rows
    // presented as the first two. The store is a WELL-BEHAVED offset pager over an endless
    // table, so the enumeration is stable and un-shifted: the only reason it cannot finish is
    // the page budget. A stub that merely looked shifted would have thrown for the wrong reason.
    let pages = 0;
    const store = storeWithAliases({
      async list(opts): Promise<Outcome<ResourceRow[]>> {
        pages += 1;
        const offset = opts?.offset ?? 0;
        return { ok: true, value: [syntheticRow(offset), syntheticRow(offset + 1)] };
      },
    });
    await expect(listAliases(undefined, { limit: 2 }, store)).rejects.toThrow(
      /could not be read to the end[\s\S]*refusing to answer from part of the table/,
    );
    await expect(listAliases(undefined, { limit: 2 }, store)).rejects.toThrow(/duplicates: 0, shifted: false/);
    expect(pages).toBeGreaterThan(2);
  });

  it("treats a SHORT page as a page and not as the end of the table", async () => {
    // THE POSITIVE CONTROL for the case above. This store holds three rows and serves at most
    // TWO per request no matter how many are asked for — exactly what a clamping list route
    // looks like — so the first page is SHORT. The end of the table is the empty page after
    // them, and the answer is all three rows rather than a truncated two.
    const table = [syntheticRow(3), syntheticRow(1), syntheticRow(2)];
    const shortPage = 2;
    const served: number[] = [];
    const store = storeWithAliases({
      async list(opts): Promise<Outcome<ResourceRow[]>> {
        const offset = opts?.offset ?? 0;
        const page = table.slice(offset, offset + shortPage);
        served.push(page.length);
        return { ok: true, value: page };
      },
    });
    expect((await listAliases(undefined, undefined, store)).map((a) => a.local_part)).toEqual([
      "local-000001",
      "local-000002",
      "local-000003",
    ]);
    // The control on the control: every page was SHORTER than the 500 rows the pager asked
    // for, and the enumeration went on regardless — three requests, the last holding only the
    // anchor row, which is the end-of-table signal. A pager that read the first short page as
    // the end would have answered two rows.
    expect(served).toEqual([shortPage, shortPage, 1]);
    for (const length of served) expect(length).toBeLessThan(500);
  });

  it("treats a filtered read answered with rows outside the filter as a fault", async () => {
    // The service's generic list route IGNORES a query parameter it does not declare and
    // answers with the UNFILTERED list — a superset presented as a filtered result. The HTTP
    // store refuses an undeclared filter up front, but a store that accepts the filter and then
    // does not apply it is not something a type can rule out.
    const store = storeWithAliases({
      async list(opts): Promise<Outcome<ResourceRow[]>> {
        return opts?.filters
          ? { ok: true, value: [syntheticRow(1, { domain: "somewhere-else.example" })] }
          : { ok: true, value: [] };
      },
    });
    await expect(listAliases("x.com", undefined, store)).rejects.toThrow(/rows outside the filter/);
  });

  it("checks EVERY row of a filtered read, not just the first", async () => {
    // A one-row fixture cannot tell "every row is checked" from "the first row is checked", and an
    // adversarial reviewer's probe showed exactly that: narrowing the re-assertion to the first row
    // survived. The superset a service returns for a filter it ignores is the WHOLE table, so the
    // in-filter rows come first as often as not.
    // A WELL-BEHAVED offset pager over a two-row table, so the enumeration COMPLETES and the
    // failure is the filter check rather than a shifted window — the fault this case is not about.
    const table = [
      // In-filter, so a first-row-only check passes here …
      syntheticRow(1, { domain: "x.com", local_part: "a" }),
      // … and never looks at this one.
      syntheticRow(2, { domain: "somewhere-else.example", local_part: "b" }),
    ];
    const store = storeWithAliases({
      async list(opts): Promise<Outcome<ResourceRow[]>> {
        const offset = opts?.offset ?? 0;
        return { ok: true, value: table.slice(offset, offset + (opts?.limit ?? table.length)) };
      },
    });
    await expect(listAliases("x.com", undefined, store)).rejects.toThrow(/rows outside the filter/);
  });
});

// ---------------------------------------------------------------------------------
// listAliasesByTargets.
// ---------------------------------------------------------------------------------

describe("listAliasesByTargets", () => {
  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`matches on the target and keeps the published order, on the ${name}`, async () => {
      const store = makeStore();
      await createAlias("support@x.com", "ops@x.com", store);
      await createCatchAll("y.com", "ops@x.com", store);
      await createAlias("sales@x.com", "sales@x.com", store);

      const matched = await listAliasesByTargets(["OPS@x.com", "  ops@x.com  ", ""], store);
      expect(matched.map((a) => `${a.local_part}@${a.domain}`)).toEqual(["support@x.com", "*@y.com"]);

      // TRIMMING ON ITS OWN. The list above also contains an already-matching entry, so it
      // cannot tell whether the padded one was trimmed — a mutation run showed exactly that.
      const padded = await listAliasesByTargets(["\t ops@x.com \n"], store);
      expect(padded.map((a) => `${a.local_part}@${a.domain}`)).toEqual(["support@x.com", "*@y.com"]);
    });

    it(`answers [] for an empty target set, on the ${name}`, async () => {
      const store = makeStore();
      await createAlias("support@x.com", "ops@x.com", store);
      expect(await listAliasesByTargets([], store)).toEqual([]);
      expect(await listAliasesByTargets(["", "   "], store)).toEqual([]);
    });
  }

  it("answers [] for an empty target set without touching the store", async () => {
    // "No targets were asked about" is a value; it is not the same as an empty answer from a
    // store that was never consulted about a real question.
    let reads = 0;
    const store = storeWithAliases({
      async list(): Promise<Outcome<ResourceRow[]>> {
        reads += 1;
        return { ok: true, value: [] };
      },
    });
    expect(await listAliasesByTargets([], store)).toEqual([]);
    expect(reads).toBe(0);
  });

  it("matches a target the store holds in mixed case, which a filter push-down would miss", async () => {
    // BOTH DELETED ARMS MATCHED THE STORED TARGET CASE-INSENSITIVELY, and the seam's
    // `target_address` filter is exact equality — so pushing the lower-cased target down would
    // silently drop this row. Mixed-case targets can only come from another writer, so the row
    // is seeded directly.
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('mixed', 'x.com', 'support', 'Ops@X.com', 0, '2026-01-01', '2026-01-01')",
    );
    const store = sqliteStore();
    expect((await listAliasesByTargets(["ops@x.com"], store)).map((a) => a.id)).toEqual(["mixed"]);

    // THE CONTROL: the push-down this module declines really would have answered nothing.
    const pushedDown = await store.aliases.list({ filters: { target_address: "ops@x.com" } });
    expect(pushedDown.ok).toBe(true);
    if (pushedDown.ok) expect(pushedDown.value).toEqual([]);
  });

  it("reports a store refusal as a refusal rather than as no matching aliases", async () => {
    const store = storeWithAliases({
      async list(): Promise<Outcome<ResourceRow[]>> {
        return CAPABILITY_REFUSAL;
      },
    });
    await expect(listAliasesByTargets(["ops@x.com"], store)).rejects.toThrow(
      /cannot list this installation's aliases by target \(capability_unavailable, 501\)/,
    );
  });
});

// ---------------------------------------------------------------------------------
// getAlias / removeAlias.
// ---------------------------------------------------------------------------------

describe("getAlias / removeAlias", () => {
  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`answers null for an id that is not there, on the ${name}`, async () => {
      expect(await getAlias("no-such-alias", makeStore())).toBeNull();
    });

    it(`removes once and reports false the second time, on the ${name}`, async () => {
      const store = makeStore();
      const alias = await createAlias("a@x.com", "t@x.com", store);
      expect(await removeAlias(alias.id, store)).toBe(true);
      expect(await getAlias(alias.id, store)).toBeNull();
      expect(await removeAlias(alias.id, store)).toBe(false);
      expect(await resolveAlias("a@x.com", store)).toBeNull();
    });

    it(`refuses to delete the protected global catch-all, on the ${name}`, async () => {
      clearAliases();
      const store = makeStore();
      const global = await setGlobalCatchAll("inbox@hq.com", store);
      expect(global.protected).toBe(true);
      await expect(removeAlias(global.id, store)).rejects.toThrow(/protected and cannot be deleted/i);
      expect(await getAlias(global.id, store)).not.toBeNull();
    });
  }

  it("refuses to report another row as the requested alias", async () => {
    const store = storeWithAliases({
      async get(): Promise<Outcome<ResourceRow | null>> {
        return { ok: true, value: syntheticRow(7) };
      },
    });
    await expect(getAlias("some-other-id", store)).rejects.toThrow(/a different row/);
  });

  it("refuses to DELETE a row the store answered a by-id read with instead", async () => {
    // `removeAlias` reads the row itself rather than going through `getAlias` (so a row this
    // module cannot report is still deletable), which means it needs its OWN id re-assertion —
    // otherwise a store that answered a by-id read with another row would have that other row
    // deleted, and the caller could not tell. A mutation run found this uncovered.
    let deleted: string | null = null;
    const store = storeWithAliases({
      async get(): Promise<Outcome<ResourceRow | null>> {
        return { ok: true, value: syntheticRow(7) };
      },
      async remove(id): Promise<Outcome<boolean>> {
        deleted = id;
        return { ok: true, value: true };
      },
    });
    await expect(removeAlias("some-other-id", store)).rejects.toThrow(
      /answered an alias read by id with a different row[\s\S]*refusing to delete it/,
    );
    expect(deleted, "the wrong alias was deleted").toBeNull();
  });

  it("reports a refused DELETE as refused rather than as an alias that was already gone", async () => {
    const store = storeWithAliases({
      async remove(): Promise<Outcome<boolean>> {
        return CAPABILITY_REFUSAL;
      },
    });
    const alias = await createAlias("a@x.com", "t@x.com", sqliteStore());
    await expect(removeAlias(alias.id, store)).rejects.toThrow(
      /cannot remove an alias \(capability_unavailable, 501\)/,
    );
    // And the row is still there, so `false` really would have been a lie.
    expect(await getAlias(alias.id, sqliteStore())).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------
// resolveAlias.
// ---------------------------------------------------------------------------------

describe("resolveAlias", () => {
  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`prefers a specific alias, then the domain catch-all, then the global one, on the ${name}`, async () => {
      const store = makeStore();
      await setGlobalCatchAll("global@hq.com", store);
      await createCatchAll("acme.com", "acme-inbox@hq.com", store);
      await createAlias("ceo@acme.com", "ceo@hq.com", store);

      expect(await resolveAlias("ceo@acme.com", store)).toBe("ceo@hq.com");
      expect(await resolveAlias("random@acme.com", store)).toBe("acme-inbox@hq.com");
      expect(await resolveAlias("x@other.example", store)).toBe("global@hq.com");
    });

    it(`answers null when nothing matches, on the ${name}`, async () => {
      clearAliases();
      const store = makeStore();
      await createCatchAll("acme.com", "inbox@acme.com", store);
      expect(await resolveAlias("nobody@other.example", store)).toBeNull();
      expect(await resolveAlias("whatever@acme.com", store)).toBe("inbox@acme.com");
    });

    it(`answers null for a recipient with no local part or no domain, on the ${name}`, async () => {
      const store = makeStore();
      // A real answer rather than a swallowed error: every stored alias has both halves, so an
      // address with neither cannot match one. The write path still refuses the same input,
      // which is what makes this a routing answer and not a validation hole.
      expect(await resolveAlias("acme.com", store)).toBeNull();
      expect(await resolveAlias("hello@", store)).toBeNull();
      await expect(createAlias("acme.com", "ops@acme.com", store)).rejects.toThrow(/Invalid email address/);
    });

    it(`falls through an alias whose target is empty, on the ${name}`, async () => {
      clearAliases();
      const store = makeStore();
      await createCatchAll("acme.com", "inbox@acme.com", store);
      // An alias with an empty target does NOT stop the search — both arms chained their three
      // lookups with `||`, and the global catch-all's own empty target is what that is for.
      await createAlias("hello@acme.com", "", store);
      expect(await resolveAlias("hello@acme.com", store)).toBe("inbox@acme.com");
      // And the seeded-style empty global catch-all resolves to null rather than to "".
      await createCatchAll("acme.com", "", store);
      expect(await resolveAlias("hello@acme.com", store)).toBeNull();
    });
  }

  it("resolves a recipient whose alias sits beyond the store's single-page clamp", async () => {
    // THE HEADLINE CASE. The deleted HTTP arm answered this question out of one
    // `list({ limit: 1000 })` clamped to 500, so above 500 aliases it reported "no alias" for a
    // recipient whose alias existed — mail delivered as-is instead of being routed.
    clearAliases();
    seedAliases(520, "bulk.example");
    const store = httpStore();

    // THE CONTROL: one page really does stop at 500 and really does miss this row. It is the
    // OLDEST seeded alias, because SQLite serves this table newest-first; the service's own
    // order would strand the other end of the range instead.
    const onePage = await store.aliases.list({ limit: 1000 });
    expect(onePage.ok).toBe(true);
    if (onePage.ok) {
      expect(onePage.value).toHaveLength(500);
      expect(onePage.value.some((row) => row["local_part"] === "local-000000")).toBe(false);
    }

    expect(await resolveAlias("local-000000@bulk.example", store)).toBe("bulk-000000@example.net");
  });

  it("throws rather than answering null when the store REFUSES the lookup", async () => {
    // "I could not determine this recipient's alias" and "this recipient has no alias" are
    // different facts, and a null cannot express the first one. The deleted arms had no way to
    // tell them apart at all.
    const store = storeWithAliases({
      async list(): Promise<Outcome<ResourceRow[]>> {
        return CAPABILITY_REFUSAL;
      },
    });
    await expect(resolveAlias("hello@acme.com", store)).rejects.toThrow(
      /cannot resolve a recipient's alias \(capability_unavailable, 501\)/,
    );
  });

  it("throws rather than answering null when the lookup could not be read to the end", async () => {
    // TWO rows a page, and a different pair every time: a store that served the SAME row at
    // every offset would be correctly read as the end of the table by the pager's anchor, and
    // the case would prove nothing about truncation.
    const store = storeWithAliases({
      async list(opts): Promise<Outcome<ResourceRow[]>> {
        const offset = opts?.offset ?? 0;
        return {
          ok: true,
          value: [
            syntheticRow(offset, { domain: "acme.com", local_part: "hello" }),
            syntheticRow(offset + 1, { domain: "acme.com", local_part: "hello" }),
          ],
        };
      },
    });
    await expect(resolveAlias("hello@acme.com", store)).rejects.toThrow(
      /could not be read to the end[\s\S]*refusing to answer from part of the table/,
    );
  });

  it("throws rather than answering null when the lookup FAULTS", async () => {
    const store = storeWithAliases({
      async list(): Promise<Outcome<ResourceRow[]>> {
        throw new Error("the transport gave up");
      },
    });
    await expect(resolveAlias("hello@acme.com", store)).rejects.toThrow(
      /faulted while it resolve a recipient's alias: the transport gave up/,
    );
  });

  it("does not ask the store the same question twice", async () => {
    // A recipient of `*@acme.com` makes the specific lookup and the domain catch-all lookup
    // IDENTICAL, and `x@*` makes the domain and global lookups identical. Both deleted arms
    // issued the duplicate read; the answer is the same either way.
    const asked: Array<Record<string, string> | undefined> = [];
    const base = sqliteStore();
    const store: EmailStore = {
      ...base,
      aliases: {
        ...base.aliases,
        async list(opts) {
          if ((opts?.offset ?? 0) === 0) asked.push(opts?.filters);
          return base.aliases.list(opts);
        },
      },
    };
    clearAliases();
    expect(await resolveAlias("*@acme.com", store)).toBeNull();
    // Two distinct questions, not three: `(acme.com, *)` once and `(*, *)` once.
    expect(asked).toEqual([
      { domain: "acme.com", local_part: "*" },
      { domain: "*", local_part: "*" },
    ]);
  });
});

// ---------------------------------------------------------------------------------
// The global catch-all.
// ---------------------------------------------------------------------------------

describe("ensureDefaultCatchAll / getGlobalCatchAll", () => {
  it("finds the global catch-all the SQLite migration seeded", async () => {
    // A STORE FACT, pinned rather than hidden: the local migration seeds this row and the
    // self-hosted schema does not, so the two stores genuinely start in different states. This
    // suite's SQLite database is the seeded one.
    const seeded = await getGlobalCatchAll(sqliteStore());
    expect(seeded).toMatchObject({
      id: "global-catch-all",
      domain: ALL_DOMAINS,
      local_part: CATCH_ALL,
      target_address: "",
      protected: true,
    });
  });

  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`is idempotent and answers the same row twice, on the ${name}`, async () => {
      clearAliases();
      const store = makeStore();
      const first = await ensureDefaultCatchAll(store);
      const second = await ensureDefaultCatchAll(store);
      expect(second.id).toBe(first.id);
      expect(first.protected).toBe(true);
      expect(first.target_address).toBe("");
      expect((await listAliases(undefined, undefined, store)).filter((a) => a.domain === ALL_DOMAINS)).toHaveLength(1);
    });

    it(`answers null when this installation has no global catch-all, on the ${name}`, async () => {
      clearAliases();
      expect(await getGlobalCatchAll(makeStore())).toBeNull();
    });

    it(`returns an existing global catch-all as stored, without resetting its target, on the ${name}`, async () => {
      clearAliases();
      const store = makeStore();
      await setGlobalCatchAll("inbox@hq.com", store);
      const ensured = await ensureDefaultCatchAll(store);
      expect(ensured.target_address).toBe("inbox@hq.com");
    });
  }

  it("does NOT protect an already-unprotected global catch-all — an inherited defect, pinned deliberately", async () => {
    // BOTH DELETED ARMS BEHAVED THIS WAY, so there is no stronger arm to resolve toward, and
    // changing what a published write does to a column the caller did not name is a product
    // decision rather than a mode-axis refactor. The harm is real and is why this is pinned
    // rather than merely preserved: after either call below reports the row as the protected
    // global catch-all, `removeAlias` will still delete it, and every unmatched recipient's
    // mail stops being caught. The fix is one field on the update patch.
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('unprotected-global', '*', '*', 'old@hq.com', 0, '2026-01-01', '2026-01-01')",
    );
    const store = sqliteStore();

    const set = await setGlobalCatchAll("new@hq.com", store);
    expect(set.target_address).toBe("new@hq.com");
    expect(set.protected, "setGlobalCatchAll does not protect an existing row").toBe(false);

    const ensured = await ensureDefaultCatchAll(store);
    expect(ensured.protected, "ensureDefaultCatchAll does not protect an existing row").toBe(false);

    // The consequence, asserted rather than described.
    expect(await removeAlias("unprotected-global", store)).toBe(true);
  });

  it("reports a refusal as a refusal rather than as no global catch-all", async () => {
    const store = storeWithAliases({
      async list(): Promise<Outcome<ResourceRow[]>> {
        return CAPABILITY_REFUSAL;
      },
    });
    await expect(getGlobalCatchAll(store)).rejects.toThrow(
      /cannot read this installation's global catch-all \(capability_unavailable, 501\)/,
    );
    await expect(ensureDefaultCatchAll(store)).rejects.toThrow(
      /cannot read this installation's global catch-all \(capability_unavailable, 501\)/,
    );
  });
});

// ---------------------------------------------------------------------------------
// The mapper.
// ---------------------------------------------------------------------------------

describe("reading a stored alias row", () => {
  for (const [name, makeStore] of STORE_VARIANTS) {
    it(`accepts protected as a SQLite integer and as a service boolean, on the ${name}`, async () => {
      clearAliases();
      const store = makeStore();
      await setGlobalCatchAll("inbox@hq.com", store);
      await createAlias("a@x.com", "t@x.com", store);
      const flags = (await listAliases(undefined, undefined, store)).map((a) => a.protected);
      expect(flags).toEqual([true, false]);
    });
  }

  it("faults on a protected value that is neither, instead of guessing", async () => {
    // SQLite's INTEGER affinity leaves a non-numeric string as TEXT, so this is reachable
    // through the real store rather than only through a stub. The deleted coercions disagreed
    // about exactly this input.
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('odd', 'x.com', 'a', 't@x.com', 'no', '2026-01-01', '2026-01-01')",
    );
    expect(db.query("SELECT typeof(protected) AS t FROM aliases WHERE id = 'odd'").get()).toEqual({ t: "text" });
    await expect(getAlias("odd", sqliteStore())).rejects.toThrow(
      /has no readable protected flag \("no"\); refusing to guess whether it can be deleted/,
    );
    await expect(listAliases(undefined, undefined, sqliteStore())).rejects.toThrow(/refusing to guess/);
  });

  it("faults on an out-of-range protected integer rather than treating it as true", async () => {
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('two', 'x.com', 'a', 't@x.com', 2, '2026-01-01', '2026-01-01')",
    );
    await expect(getAlias("two", sqliteStore())).rejects.toThrow(/no readable protected flag \(2\)/);
  });

  it("faults on an absent required column rather than reporting the current time", async () => {
    // The deleted HTTP arm read both timestamps through a coercion that answers
    // `new Date().toISOString()` for a MISSING value, so a row whose `created_at` could not be
    // read was reported as having been created at the moment it was read.
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('blank', 'x.com', 'a', 't@x.com', 0, '', '2026-01-01')",
    );
    await expect(getAlias("blank", sqliteStore())).rejects.toThrow(
      /has no readable created_at; refusing to report it as an alias/,
    );
  });

  it("faults on an unreadable domain or local part rather than reporting a routeless alias", async () => {
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('nodomain', '', 'a', 't@x.com', 0, '2026-01-01', '2026-01-01')",
    );
    await expect(getAlias("nodomain", sqliteStore())).rejects.toThrow(/has no readable domain/);
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('nolocal', 'x.com', '', 't@x.com', 0, '2026-01-01', '2026-01-01')",
    );
    await expect(getAlias("nolocal", sqliteStore())).rejects.toThrow(/has no readable local_part/);
  });

  it("keeps an EMPTY target empty and faults on an ABSENT one", async () => {
    // The two are not the same fact and both deleted mappers turned them into the same empty
    // string. `''` is the global catch-all's documented target; a missing column is a store
    // that stopped projecting it, which would report every alias as forwarding nowhere.
    clearAliases();
    const kept = await ensureDefaultCatchAll(sqliteStore());
    expect(kept.target_address).toBe("");

    const withoutColumn = storeWithAliases({
      async get(): Promise<Outcome<ResourceRow | null>> {
        const row = syntheticRow(1);
        delete row["target_address"];
        return { ok: true, value: row };
      },
    });
    await expect(getAlias("synthetic-000001", withoutColumn)).rejects.toThrow(
      /has no target_address column at all/,
    );

    const nullColumn = storeWithAliases({
      async get(): Promise<Outcome<ResourceRow | null>> {
        return { ok: true, value: syntheticRow(1, { target_address: null }) };
      },
    });
    await expect(getAlias("synthetic-000001", nullColumn)).rejects.toThrow(
      /has a null target_address, which neither schema admits/,
    );
  });
});

// ---------------------------------------------------------------------------------
// Through the CONFIGURED store — no store argument at all.
// ---------------------------------------------------------------------------------

/**
 * Every case above hands the module a store, which is what makes them checkable against both
 * implementations. These pass NO store, so the module resolves one from STORAGE configuration —
 * the path every real caller takes, and the only path whose behaviour can be compared with what
 * this family did before it was collapsed.
 *
 * They are deliberately built on corruption a raw SQL write can produce in the real table, not
 * on a stubbed store, so each of them RUNS on the pre-collapse implementation and gets a
 * different answer rather than failing to load. `expect(...).rejects` is avoided on purpose: it
 * reports "this was not a promise" for a synchronous implementation, which is a fact about a
 * signature. The try/catch below asks the question that matters — was this a fault or a value.
 */
describe("through the configured store", () => {
  async function faultOf(run: () => Promise<unknown>): Promise<{ error: unknown; answer: unknown }> {
    let error: unknown = null;
    let answer: unknown = "not called";
    try {
      answer = await run();
    } catch (thrown) {
      error = thrown;
    }
    return { error, answer };
  }

  it("resolves an alias it just created, with no store argument", async () => {
    // THE CONTROL FOR EVERY CASE BELOW. Without it, a fault could be coming from a store that
    // could not be resolved at all rather than from the row the case corrupted — and the cases
    // would pass while proving nothing about the mapper.
    const created = await createAlias("hello@acme.com", "ops@acme.com");
    expect(created.target_address).toBe("ops@acme.com");
    expect(await resolveAlias("hello@acme.com")).toBe("ops@acme.com");
    expect((await listAliases("acme.com")).map((a) => a.local_part)).toEqual(["hello"]);
  });

  it("faults on a stored protected flag that is neither an integer nor a boolean", async () => {
    // SQLite's INTEGER affinity leaves a non-numeric string as TEXT, so this is a row the real
    // table can hold. A bare double-negation reports it as `true` and the HTTP arm's coercion
    // reports it as `false`; either way the answer decides whether the catch-all that keeps
    // unmatched mail from being dropped can be deleted.
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('odd', 'x.com', 'a', 't@x.com', 'no', '2026-01-01', '2026-01-01')",
    );
    const { error, answer } = await faultOf(() => getAlias("odd"));
    expect(error, `a corrupt protected flag answered ${JSON.stringify(answer)}`).toBeInstanceOf(Error);
    expect(String(error)).toContain("refusing to guess whether it can be deleted");
  });

  it("faults on a stored protected integer outside 0 and 1", async () => {
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('two', 'x.com', 'a', 't@x.com', 2, '2026-01-01', '2026-01-01')",
    );
    const { error, answer } = await faultOf(() => getAlias("two"));
    expect(error, `protected = 2 answered ${JSON.stringify(answer)}`).toBeInstanceOf(Error);
    expect(String(error)).toContain("no readable protected flag (2)");
  });

  it("faults on an unreadable timestamp rather than reporting a time", async () => {
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('blank', 'x.com', 'a', 't@x.com', 0, '', '2026-01-01')",
    );
    const { error, answer } = await faultOf(() => getAlias("blank"));
    expect(error, `an empty created_at answered ${JSON.stringify(answer)}`).toBeInstanceOf(Error);
    expect(String(error)).toContain("has no readable created_at");
  });

  it("faults on an unreadable route rather than listing an alias with no domain", async () => {
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('nodomain', '', 'a', 't@x.com', 0, '2026-01-01', '2026-01-01')",
    );
    const { error, answer } = await faultOf(() => listAliases());
    expect(error, `an empty domain answered ${JSON.stringify(answer)}`).toBeInstanceOf(Error);
    expect(String(error)).toContain("has no readable domain");
  });

  it("faults on an unreadable local part rather than resolving through it", async () => {
    clearAliases();
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES ('nolocal', 'x.com', '', 't@x.com', 0, '2026-01-01', '2026-01-01')",
    );
    const { error, answer } = await faultOf(() => listAliases("x.com"));
    expect(error, `an empty local_part answered ${JSON.stringify(answer)}`).toBeInstanceOf(Error);
    expect(String(error)).toContain("has no readable local_part");
  });
});

// ---------------------------------------------------------------------------------
// A refusal is never an answer.
// ---------------------------------------------------------------------------------

describe("a store that refuses", () => {
  function refusingStore(): EmailStore {
    return storeWithAliases({
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
  }

  it("makes every alias operation throw, naming the refusal, and never answers empty", async () => {
    const store = refusingStore();
    const operations: Array<[string, () => Promise<unknown>]> = [
      ["createAlias", () => createAlias("a@x.com", "t@x.com", store)],
      ["createCatchAll", () => createCatchAll("x.com", "t@x.com", store)],
      ["setGlobalCatchAll", () => setGlobalCatchAll("t@x.com", store)],
      ["ensureDefaultCatchAll", () => ensureDefaultCatchAll(store)],
      ["getGlobalCatchAll", () => getGlobalCatchAll(store)],
      ["getAlias", () => getAlias("some-id", store)],
      ["listAliases", () => listAliases(undefined, undefined, store)],
      ["listAliasesByTargets", () => listAliasesByTargets(["t@x.com"], store)],
      ["removeAlias", () => removeAlias("some-id", store)],
      ["resolveAlias", () => resolveAlias("a@x.com", store)],
    ];
    // Every published export is here, so a new one cannot be added without a refusal path.
    expect(operations).toHaveLength(10);
    for (const [label, run] of operations) {
      let error: unknown = null;
      let answer: unknown = "not called";
      try {
        answer = await run();
      } catch (thrown) {
        error = thrown;
      }
      expect(error, `${label} answered ${JSON.stringify(answer)} instead of refusing`).toBeInstanceOf(Error);
      expect(String(error), label).toContain("capability_unavailable, 501");
      expect(String(error), label).toContain("the test store does not serve aliases");
    }
  });

  it("names no setting and no command in the refusal it reports", async () => {
    // A refusal that tells the caller which variable to flip is a refusal documenting its own
    // bypass.
    let error: unknown = null;
    try {
      await listAliases(undefined, undefined, refusingStore());
    } catch (thrown) {
      error = thrown;
    }
    const message = String(error);
    expect(message).toContain("This installation's store cannot");
    for (const forbidden of ["EMAILS_", "export ", "--", "emails alias"]) {
      expect(message.includes(forbidden), `the refusal named ${forbidden}`).toBe(false);
    }
  });

  it("reports a refused WRITE as refused rather than as an alias that was saved", async () => {
    const base = sqliteStore();
    const store = storeWithAliases({
      async list(opts) {
        return base.aliases.list(opts);
      },
      async create(): Promise<Outcome<ResourceRow>> {
        return CAPABILITY_REFUSAL;
      },
    });
    await expect(createAlias("a@x.com", "t@x.com", store)).rejects.toThrow(
      /cannot store an alias \(capability_unavailable, 501\)/,
    );
    // Nothing was written, so a returned alias really would have been a fabrication.
    expect(await listAliases("x.com", undefined, sqliteStore())).toEqual([]);
  });

  it("names the alias rather than re-inserting it when the update target has vanished", async () => {
    const existing = await createAlias("a@x.com", "t@x.com", sqliteStore());
    const store = storeWithAliases({
      async update(): Promise<Outcome<ResourceRow | null>> {
        return { ok: true, value: null };
      },
      async create(): Promise<Outcome<ResourceRow>> {
        throw new Error("a vanished row must not be re-inserted");
      },
    });
    await expect(createAlias("a@x.com", "other@x.com", store)).rejects.toThrow(
      new RegExp(`Alias not found: ${existing.id}`),
    );
  });

  it("refuses to report a write the store answered with a different row, on EACH field", async () => {
    // ONE STUB PER FIELD, and that is a correction rather than thoroughness for its own sake. A
    // single stub whose row differed in all three fields killed the whole comparison but let
    // each individual term be deleted — a mutation run showed all three surviving, because the
    // other two still caught that row. Each case below differs in exactly ONE field.
    const differences: Array<[string, Record<string, unknown>]> = [
      ["domain", { domain: "other.example", local_part: "a", target_address: "t@x.com" }],
      ["local part", { domain: "x.com", local_part: "b", target_address: "t@x.com" }],
      ["target", { domain: "x.com", local_part: "a", target_address: "elsewhere@x.com" }],
    ];
    for (const [field, overrides] of differences) {
      const store = storeWithAliases({
        async create(): Promise<Outcome<ResourceRow>> {
          return { ok: true, value: syntheticRow(9, overrides) };
        },
      });
      let error: unknown = null;
      let answer: unknown = "not called";
      try {
        answer = await createAlias("a@x.com", "t@x.com", store);
      } catch (thrown) {
        error = thrown;
      }
      expect(error, `a row differing only in its ${field} answered ${JSON.stringify(answer)}`)
        .toBeInstanceOf(Error);
      expect(String(error), field).toContain("answered with a different row");
    }
  });

  it("reports a store fault as a fault rather than as an empty list", async () => {
    const store = storeWithAliases({
      async list(): Promise<Outcome<ResourceRow[]>> {
        throw new Error("the socket closed");
      },
    });
    await expect(listAliases(undefined, undefined, store)).rejects.toThrow(
      /faulted while it list this installation's aliases: the socket closed/,
    );
  });

  it("refuses to choose between two rows that claim the same route", async () => {
    // Unreachable through either store — `(domain, local_part)` is UNIQUE on SQLite and
    // `(tenant_id, domain, local_part)` on Postgres — so this is the guard that would notice a
    // schema which lost the constraint. Routing mail to one of two candidates silently is the
    // failure it prevents.
    // A WELL-BEHAVED offset pager over a two-row table. A stub that answered `[]` for every
    // offset above zero would look like a SHIFTED window to the pager and throw the truncation
    // fault instead, so the ambiguity guard would never be reached.
    const table = [
      syntheticRow(1, { domain: "acme.com", local_part: "hello", target_address: "one@x.com" }),
      syntheticRow(2, { domain: "acme.com", local_part: "hello", target_address: "two@x.com" }),
    ];
    const store = storeWithAliases({
      async list(opts): Promise<Outcome<ResourceRow[]>> {
        const offset = opts?.offset ?? 0;
        return { ok: true, value: table.slice(offset, offset + (opts?.limit ?? table.length)) };
      },
    });
    await expect(resolveAlias("hello@acme.com", store)).rejects.toThrow(
      /holds 2 aliases for hello@acme\.com[\s\S]*refusing to choose which one routes the mail/,
    );
  });
});

// ---------------------------------------------------------------------------------
// The collapsed module.
// ---------------------------------------------------------------------------------

describe("the collapsed module", () => {
  const dbDir = import.meta.dir;

  it("has no arm modules left", () => {
    // TWO POSITIVE CONTROLS BEFORE THE NEGATIVE ONES, because a negative `existsSync` is
    // satisfied by a directory that does not exist at all — a resolution that stopped working
    // would report the arms deleted no matter what the tree held.
    expect(existsSync(join(dbDir, "database.ts")), "the src/db directory did not resolve").toBe(true);
    // The floor: the facade itself is still there under the same name, so consumers' import
    // paths did not move — and it is a real module rather than an empty file.
    expect(existsSync(join(dbDir, "aliases.ts"))).toBe(true);
    expect(readFileSync(join(dbDir, "aliases.ts"), "utf8").length).toBeGreaterThan(4000);

    expect(existsSync(join(dbDir, "aliases.local.ts"))).toBe(false);
    expect(existsSync(join(dbDir, "aliases.remote.ts"))).toBe(false);
  });

  it("reads no deployment-mode variable and imports no routing helper", () => {
    const source = readFileSync(join(dbDir, "aliases.ts"), "utf8");
    // Comments in this module discuss the axis by role, so the check is on IMPORTS and CALLS
    // rather than on prose.
    for (const forbidden of [
      /from "\.\/self-hosted-store\.js"/,
      /from "\.\/self-hosted-resource\.js"/,
      /from "\.\/database-routing\.js"/,
      /from "\.\/aliases\.(local|remote)\.js"/,
      /from "\.\/database\.js"/,
      /selfHostedResource\(/,
      /process\.env\[/,
    ]) {
      expect(forbidden.test(source), `aliases.ts still matches ${String(forbidden)}`).toBe(false);
    }
    // And the positive control that the file really was read.
    expect(source).toContain("createConfiguredEmailStore");
    expect(source.length).toBeGreaterThan(4000);
  });

  it("leaves every consumer importing the facade rather than a deleted arm", () => {
    const consumers = [
      ["cli", "commands", "alias.ts"],
      ["cli", "commands", "domain.ts"],
      ["cli", "commands", "inbox.local.ts"],
      ["mcp", "tools", "domains-impl.ts"],
      ["lib", "delivery-doctor.ts"],
    ];
    for (const parts of consumers) {
      const source = readFileSync(join(dbDir, "..", ...parts), "utf8");
      expect(source, parts.join("/")).toMatch(/from ["'](?:\.\.\/)+db\/aliases\.js["']/);
      expect(/aliases\.(local|remote)\.js/.test(source), `${parts.join("/")} imports a deleted arm`).toBe(false);
    }
  });
});
