// The scoped send-key family, over the store seam — against BOTH shipped stores.
//
// WHAT CHANGED AND WHY THE FIXTURE CHANGED WITH IT. This suite used to drive the
// out-of-process `/v1` stub (`src/test-support/v1-stub.ts`), because the family's second arm
// talked to `/v1` through a `curl` bridge. `src/db/send-keys.ts` has collapsed onto the store
// seam, so the same operations now reach `/v1` through the REAL `HttpEmailStore`. That stub's
// generic list handler IGNORES equality filters and clamps `limit` only when a client sends
// one, so it is weaker than production in exactly the places this family's defects lived; its
// own header points at `src/test-support/v1-store-api.ts` for filtered or paged store-seam
// work, and that is what this file uses — a `/v1` service that stores NOTHING and translates
// every request into the same store seam, backed by the same in-memory database the SQLite
// variant reads. Both variants therefore answer from ONE dataset, and a client that mis-maps a
// column fails here rather than being handed its own mistake back.
//
// CREDENTIAL DISCIPLINE, because this family is the one that mints them. No assertion below
// reads, prints or compares a token VALUE. What is asserted is its SHAPE (the `esk_` prefix
// and a length floor), that two mints differ, and that it round-trips through verification.
// The seeded `key_hash` column holds obvious non-secret filler; it is never a real hash and is
// never asserted on. The published record carries NO hash at all, and there is a case for that.

import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import {
  createSendKey,
  getSendKey,
  verifySendKey,
  listSendKeys,
  listSendKeySummaries,
  listSendKeysByOwners,
  listSendKeySummariesByOwners,
  revokeSendKey,
  canOwnerSendFrom,
  assertSendAuthorized,
} from "./send-keys.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome } from "../store/outcome.js";
import type { ListOptions, SendKeyRecord } from "../store/records.js";
import { startV1StoreApi, type V1StoreApi } from "../test-support/v1-store-api.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../store-resolution.js";

const PROVIDER_ID = "provider-ses";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;

function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}

function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

/**
 * Leave exactly ONE store configured, so the cases that pass no store can resolve.
 *
 * The settings are named through the resolution's OWN exported constants rather than copied as
 * literals: this is the list that decides which store a caller with no injected store gets,
 * and a second copy here would go stale the first time the resolution learned another setting.
 * A database path AND an API together are a hard boot error with deliberately no precedence
 * rule, so a stray inherited API setting would turn every default-store case into that error.
 */
function configureExactlyOneStore(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
  process.env[DATABASE_PATH_SETTINGS[1]] = ":memory:";
}

let db: ReturnType<typeof getDatabase>;
let api: V1StoreApi | null = null;

/**
 * The running `/v1` fixture, or a clear failure.
 *
 * The handle is nullable so a `beforeEach` that dies before it is assigned reports its own
 * error rather than a `TypeError` from the teardown; this is the accessor every case uses, so
 * "not started" can never read as "started and empty".
 */
function service(): V1StoreApi {
  if (api === null) throw new Error("the /v1 fixture was not started");
  return api;
}

beforeEach(() => {
  captureInheritedProcessEnv();
  configureExactlyOneStore();
  resetDatabase();
  db = getDatabase();
  db.run("INSERT INTO providers (id, name, type, active) VALUES (?, ?, 'sandbox', 1)", [PROVIDER_ID, PROVIDER_ID]);
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "send-key row fixture" }) });
});

afterEach(() => {
  api?.stop();
  api = null;
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (send-key test)" });
}

function httpStore(): EmailStore {
  return createHttpEmailStore({ baseUrl: service().baseUrl, credential: service().apiKey });
}

const STORE_VARIANTS: ReadonlyArray<[string, () => EmailStore]> = [
  ["SQLite store", sqliteStore],
  ["HTTP store over /v1", httpStore],
];

/** An ISO instant `seconds` after a fixed epoch, so seeded order is unambiguous. */
function stamp(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
}

/**
 * A send key written STRAIGHT INTO THE TABLE.
 *
 * Neither store lets a caller name a key's id or its creation instant on a mint, so a case
 * that needs to know which id a row has, or that needs two rows to share a timestamp exactly,
 * or that needs more rows than one page holds, has to seed. Both store variants read this same
 * database, so a seeded row is visible through both.
 *
 * `key_hash` is NOT A HASH and is never asserted on: the column is `NOT NULL UNIQUE`, so the
 * seed has to put something unique there, and obvious filler is the honest choice. No token
 * corresponds to a seeded row — every case that verifies a token mints it.
 */
function seedKey(
  id: string,
  ownerId: string,
  createdAt: string,
  overrides: { label?: string | null; prefix?: string; revoked_at?: string | null; last_used_at?: string | null } = {},
): void {
  db.run(
    `INSERT INTO send_keys (id, owner_id, key_hash, prefix, label, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ownerId,
      `not-a-hash-${id}`,
      overrides.prefix ?? "esk_00000000",
      overrides.label ?? null,
      createdAt,
      overrides.last_used_at ?? null,
      overrides.revoked_at ?? null,
    ],
  );
}

function seedOwner(id: string, name: string, type: "agent" | "human" = "agent"): void {
  db.run("INSERT INTO owners (id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
    id,
    type,
    name,
    stamp(0),
    stamp(0),
  ]);
}

function seedAddress(
  id: string,
  email: string,
  ownership: { owner_id?: string | null; administrator_id?: string | null } = {},
): void {
  db.run(
    `INSERT INTO addresses (id, provider_id, email, status, verified, owner_id, administrator_id, created_at, updated_at)
     VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
    [id, PROVIDER_ID, email, ownership.owner_id ?? null, ownership.administrator_id ?? null, stamp(0), stamp(0)],
  );
}

/** Rows as the TABLE holds them, read without going through this module. */
function tableKeys(): Array<Record<string, unknown>> {
  return db.query("SELECT * FROM send_keys ORDER BY id ASC").all() as Array<Record<string, unknown>>;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw, and it resolved");
}

/**
 * A store whose send-key listing is replaced, and nothing else.
 *
 * Used to drive the answers no real store produces on demand — a refusal, a fault, a window
 * that never empties — because those are the branches whose WRONG implementations return an
 * empty list or a plausible `false`, and only a driven store can reach them.
 */
function withSendKeyList(
  store: EmailStore,
  list: (opts?: ListOptions) => Promise<Outcome<SendKeyRecord[]>>,
): EmailStore {
  return { ...store, sendKeys: { ...store.sendKeys, listSendKeys: list } };
}

/**
 * A driven listing over a FIXED set of rows, paged the way a real store pages.
 *
 * `{ limit, offset }` is honoured exactly. That matters more than it looks: the enumeration
 * ANCHORS — every page after the first re-requests the last row already read and requires it
 * back — so a naive fixture that answers the whole set for offset 0 and nothing afterwards is
 * read as a window that MOVED, and the listing refuses instead of reaching the case's subject.
 */
function pagedList(rows: readonly SendKeyRecord[]): (opts?: ListOptions) => Promise<Outcome<SendKeyRecord[]>> {
  return async (opts) => {
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? rows.length;
    return { ok: true, value: rows.slice(offset, offset + limit) };
  };
}

/** One filler send-key row, for a driven listing. */
function fillerKey(n: number, ownerId: string): SendKeyRecord {
  return {
    id: `k-${n}`,
    owner_id: ownerId,
    prefix: "esk_00000000",
    label: null,
    last_used_at: null,
    revoked_at: null,
    created_at: stamp(n),
    updated_at: stamp(n),
  };
}

// ── behaviour, against both shipped stores ──────────────────────────────────────────────

for (const [label, makeStore] of STORE_VARIANTS) {
  describe(`send keys — ${label}`, () => {
    describe("createSendKey", () => {
      it("mints through the store, returns the token once, and publishes NO hash", async () => {
        const store = makeStore();
        seedOwner("agent-1", "minter");

        const { token, key } = await createSendKey("agent-1", "ci", store);

        expect(token).toMatch(/^esk_/);
        expect(token.length).toBeGreaterThan(20);
        expect(key.owner_id).toBe("agent-1");
        expect(key.label).toBe("ci");
        expect(key.prefix).not.toBeNull();
        // Divergence 5: the field is ABSENT, not `""`. `""` was the deleted HTTP arm's
        // fabricated credential value, and a consumer comparing a hash against it never
        // matched and never found out.
        expect("key_hash" in key).toBe(false);
        expect(Object.keys(key)).not.toContain("key_hash");

        // The row really is in the table, and what the table holds did not come back.
        const rows = tableKeys();
        expect(rows).toHaveLength(1);
        expect(rows[0]!["id"]).toBe(key.id);
        expect(typeof rows[0]!["key_hash"]).toBe("string");
      });

      it("mints a DIFFERENT token each time", async () => {
        const store = makeStore();
        seedOwner("agent-1", "minter");

        const first = await createSendKey("agent-1", undefined, store);
        const second = await createSendKey("agent-1", undefined, store);

        expect(first.token).not.toBe(second.token);
        expect(first.key.id).not.toBe(second.key.id);
      });

      it("refuses to mint for an owner that does not exist", async () => {
        const store = makeStore();

        const error = await rejection(createSendKey("no-such-owner", "ci", store));

        expect(error.message).toMatch(/cannot issue a send key/);
        expect(tableKeys()).toHaveLength(0);
      });

      it("mints on a configuration where the deleted arm refused outright", async () => {
        // Divergence 7. The deleted SQLite arm FAILED LOUD rather than minting whenever its
        // own deployment branch decided it was not really the local arm, so on one
        // configuration `sendkey create` could not work at all.
        const store = makeStore();
        seedOwner("agent-1", "minter");

        const { token } = await createSendKey("agent-1", "ci", store);

        expect(token).toMatch(/^esk_/);
      });
    });

    describe("verifySendKey", () => {
      it("resolves a minted token to its key and stamps last_used_at", async () => {
        const store = makeStore();
        seedOwner("agent-1", "verifier");
        const { token, key } = await createSendKey("agent-1", undefined, store);

        const resolved = await verifySendKey(token, store);

        expect(resolved).not.toBeNull();
        expect(resolved!.id).toBe(key.id);
        expect(resolved!.owner_id).toBe("agent-1");
        expect("key_hash" in resolved!).toBe(false);
        expect(resolved!.last_used_at).not.toBeNull();
      });

      it("answers null for an unknown, a malformed and a revoked token alike", async () => {
        const store = makeStore();
        seedOwner("agent-1", "verifier");
        const { token, key } = await createSendKey("agent-1", undefined, store);

        expect(await verifySendKey("esk_0000000000000000", store)).toBeNull();
        expect(await verifySendKey("not-even-prefixed", store)).toBeNull();
        // THE EMPTY TOKEN IS THE ONE THE TWO STORES DISAGREED ABOUT: SQLite answers `null`,
        // the service answers 422 `invalid_input`, which the HTTP store surfaces as a refusal.
        // Running this case against BOTH variants is what makes the resolution visible.
        expect(await verifySendKey("", store)).toBeNull();

        expect(await revokeSendKey(key.id, store)).toBe(true);
        expect(await verifySendKey(token, store)).toBeNull();
      });
    });

    describe("getSendKey", () => {
      it("reads one key by id, hash-free, and answers null for an unknown id", async () => {
        const store = makeStore();
        seedOwner("agent-1", "reader");
        seedKey("k1", "agent-1", stamp(1), { label: "ci", prefix: "esk_abcdefgh" });

        const key = await getSendKey("k1", store);

        expect(key).not.toBeNull();
        expect(key!.owner_id).toBe("agent-1");
        expect(key!.prefix).toBe("esk_abcdefgh");
        expect(key!.label).toBe("ci");
        expect("key_hash" in key!).toBe(false);
        expect(await getSendKey("missing", store)).toBeNull();
      });
    });

    describe("revokeSendKey", () => {
      it("revokes once and reports false for the second call and for an unknown id", async () => {
        const store = makeStore();
        seedOwner("agent-1", "revoker");
        seedKey("k1", "agent-1", stamp(1));

        expect(await revokeSendKey("k1", store)).toBe(true);
        expect(await revokeSendKey("k1", store)).toBe(false);
        expect(await revokeSendKey("missing", store)).toBe(false);
        expect((await getSendKey("k1", store))!.revoked_at).not.toBeNull();
      });

      it("does NOT re-stamp a key that was already revoked", async () => {
        // Divergence 6. The seam's HTTP `revokeSendKey` PATCHes `revoked_at` UNCONDITIONALLY,
        // so a second revocation through it would move a recorded revocation instant. The
        // facade reads first and never reaches the write for a key that is already revoked.
        const store = makeStore();
        seedOwner("agent-1", "revoker");
        seedKey("k1", "agent-1", stamp(1), { revoked_at: stamp(5) });

        expect(await revokeSendKey("k1", store)).toBe(false);

        expect(tableKeys()[0]!["revoked_at"]).toBe(stamp(5));
        expect((await getSendKey("k1", store))!.revoked_at).toBe(stamp(5));
      });
    });

    describe("listSendKeys", () => {
      it("orders newest first and breaks a tie on the id, descending", async () => {
        // Divergence 3. The two stores order this family with OPPOSITE tiebreaks — SQLite
        // `id DESC`, the service `id ASC` — so a page taken from either store's own order
        // would disagree with the other. Three of these share one instant exactly.
        const store = makeStore();
        seedOwner("agent-1", "lister");
        seedKey("k-b", "agent-1", stamp(10), { label: "tie-b" });
        seedKey("k-a", "agent-1", stamp(10), { label: "tie-a" });
        seedKey("k-c", "agent-1", stamp(10), { label: "tie-c" });
        seedKey("k-newest", "agent-1", stamp(99), { label: "newest" });
        seedKey("k-oldest", "agent-1", stamp(1), { label: "oldest" });

        const keys = await listSendKeys("agent-1", undefined, store);

        expect(keys.map((key) => key.label)).toEqual(["newest", "tie-c", "tie-b", "tie-a", "oldest"]);
      });

      it("windows the ORDERED set rather than the store's own page", async () => {
        const store = makeStore();
        seedOwner("agent-1", "lister");
        for (let i = 0; i < 5; i += 1) seedKey(`k-${i}`, "agent-1", stamp(i + 1), { label: `key-${i}` });

        const page = await listSendKeys("agent-1", { limit: 2, offset: 1 }, store);

        expect(page.map((key) => key.label)).toEqual(["key-3", "key-2"]);
      });

      it("returns EVERY row and ignores the offset when no limit is given", async () => {
        // Both deleted arms did this: no limit meant no LIMIT/OFFSET clause at all locally and
        // an untouched list remotely. Surprising, preserved, and pinned so it cannot drift.
        const store = makeStore();
        seedOwner("agent-1", "lister");
        for (let i = 0; i < 5; i += 1) seedKey(`k-${i}`, "agent-1", stamp(i + 1), { label: `key-${i}` });

        const all = await listSendKeys("agent-1", { offset: 3 }, store);

        expect(all).toHaveLength(5);
        expect(all[0]!.label).toBe("key-4");
      });

      it("filters on the owner EXACTLY, client-side", async () => {
        const store = makeStore();
        seedOwner("agent-1", "one");
        seedOwner("agent-10", "ten");
        seedKey("k1", "agent-1", stamp(1), { label: "mine" });
        seedKey("k2", "agent-10", stamp(2), { label: "theirs" });

        expect((await listSendKeys("agent-1", undefined, store)).map((key) => key.label)).toEqual(["mine"]);
        expect((await listSendKeys("agent-10", undefined, store)).map((key) => key.label)).toEqual(["theirs"]);
        expect((await listSendKeys(undefined, undefined, store)).map((key) => key.label)).toEqual(["theirs", "mine"]);
      });

      it("reads PAST the 500-row page clamp instead of publishing one page as the table", async () => {
        // Divergence 2, and the defect that mattered most: an owner whose keys sorted past the
        // clamp got an EMPTY list, indistinguishable from "this owner has no keys". 520 rows,
        // so the first page is short of the table by 20.
        const store = makeStore();
        seedOwner("agent-1", "bulk");
        for (let i = 0; i < 520; i += 1) seedKey(`k-${String(i).padStart(4, "0")}`, "agent-1", stamp(i + 1));

        const keys = await listSendKeys("agent-1", undefined, store);

        expect(keys).toHaveLength(520);
        expect(new Set(keys.map((key) => key.id)).size).toBe(520);

        // THE PAGE PAST THE CLAMP, which is where the defect was visible without counting.
        // Measured on unmodified main against a stub that clamps exactly as production does,
        // this window came back EMPTY — a revocation review of the oldest keys shown nothing
        // and given no reason to doubt it.
        const lastPage = await listSendKeys("agent-1", { limit: 10, offset: 515 }, store);
        expect(lastPage).toHaveLength(5);
        expect(lastPage[0]!.id).toBe("k-0004");
      });

      it("CONTROL: one 1000-row request really does come back holding 500 of the 520", async () => {
        // The clamp the case above defeats, proved through the same store rather than asserted.
        // Without this, "520" could just mean the clamp was never in the way.
        const store = makeStore();
        seedOwner("agent-1", "bulk");
        for (let i = 0; i < 520; i += 1) seedKey(`k-${String(i).padStart(4, "0")}`, "agent-1", stamp(i + 1));

        const onePage = await store.sendKeys.listSendKeys({ limit: 1000, offset: 0 });

        expect(onePage.ok).toBe(true);
        expect(onePage.ok ? onePage.value : []).toHaveLength(500);
      });
    });

    describe("listSendKeySummaries", () => {
      it("answers the same rows as listSendKeys, hash-free", async () => {
        const store = makeStore();
        seedOwner("agent-1", "lister");
        seedKey("k1", "agent-1", stamp(1), { label: "one" });
        seedKey("k2", "agent-1", stamp(2), { label: "two" });

        const summaries = await listSendKeySummaries("agent-1", { limit: 2, offset: 0 }, store);

        expect(summaries.map((key) => key.label)).toEqual(["two", "one"]);
        expect(summaries.every((key) => !("key_hash" in key))).toBe(true);
      });
    });

    describe("listSendKeysByOwners / listSendKeySummariesByOwners", () => {
      it("selects the named owners only, de-duplicating and trimming the request", async () => {
        const store = makeStore();
        for (const id of ["first", "second", "other"]) seedOwner(id, id);
        seedKey("kf", "first", stamp(1), { label: "first" });
        seedKey("ks", "second", stamp(2), { label: "second" });
        seedKey("ko", "other", stamp(3), { label: "other" });

        expect((await listSendKeysByOwners(["first", "second", "first"], store)).map((k) => k.id).sort())
          .toEqual(["kf", "ks"]);
        const summaries = await listSendKeySummariesByOwners([" first ", "second"], store);
        expect(summaries.map((key) => key.id).sort()).toEqual(["kf", "ks"]);
        expect(summaries.every((key) => !("key_hash" in key))).toBe(true);
      });

      it("answers an empty list for an empty owner set WITHOUT reading the store", async () => {
        // A complete answer to "the keys of no owners", so it must not be able to raise —
        // which is what a store that refuses every listing proves.
        const refusing = withSendKeyList(makeStore(), async () => ({
          ok: false,
          code: "capability_unavailable",
          message: "no",
          status: 501,
        }));

        expect(await listSendKeysByOwners([], refusing)).toEqual([]);
        expect(await listSendKeySummariesByOwners(["", "  "], refusing)).toEqual([]);
      });

      it("reads PAST the 500-row page clamp", async () => {
        // The deleted HTTP arm asked for `list({ limit: 1000 })` — one request, clamped to 500
        // — and filtered the answer. These 520 rows are split across two owners so that the one
        // sorting last is the one that used to vanish entirely.
        const store = makeStore();
        seedOwner("early", "early");
        seedOwner("late", "late");
        for (let i = 0; i < 519; i += 1) seedKey(`k-${String(i).padStart(4, "0")}`, "late", stamp(i + 2));
        seedKey("k-earliest", "early", stamp(1));

        const keys = await listSendKeysByOwners(["early"], store);

        expect(keys.map((key) => key.id)).toEqual(["k-earliest"]);
      });
    });

    describe("canOwnerSendFrom", () => {
      it("authorizes an address the owner owns and refuses every other", async () => {
        const store = makeStore();
        seedOwner("agent-1", "Brutus");
        seedAddress("a1", "ops@x.com", { owner_id: "agent-1", administrator_id: "agent-1" });
        seedAddress("a2", "other@x.com");

        expect(await canOwnerSendFrom("agent-1", "ops@x.com", store)).toBe(true);
        expect(await canOwnerSendFrom("agent-1", "other@x.com", store)).toBe(false);
        expect(await canOwnerSendFrom("agent-1", "unregistered@x.com", store)).toBe(false);
      });

      it("authorizes an address the owner ADMINISTERS for someone else", async () => {
        const store = makeStore();
        seedOwner("human-1", "Morgan", "human");
        seedOwner("agent-1", "Tiberius");
        seedAddress("a1", "morgan@x.com", { owner_id: "human-1", administrator_id: "agent-1" });

        expect(await canOwnerSendFrom("agent-1", "morgan@x.com", store)).toBe(true);
        expect(await canOwnerSendFrom("human-1", "morgan@x.com", store)).toBe(true);
      });

      it("does NOT authorize an administrator of an address that has no owner", async () => {
        // An INHERITED RULE, not an omission: both deleted arms went through an ownership read
        // that answered null whenever `owner_id` was falsy, so this row authorized nobody.
        const store = makeStore();
        seedOwner("agent-1", "Tiberius");
        seedAddress("a1", "orphan@x.com", { owner_id: null, administrator_id: "agent-1" });

        expect(await canOwnerSendFrom("agent-1", "orphan@x.com", store)).toBe(false);
      });

      it("denies a From carrying a second angle-addr even when the first is owned", async () => {
        const store = makeStore();
        seedOwner("agent-1", "Galba");
        seedAddress("a1", "ops@x.com", { owner_id: "agent-1", administrator_id: "agent-1" });

        expect(await canOwnerSendFrom("agent-1", "x <ops@x.com> <victim@y.com>", store)).toBe(false);
      });

      it("matches case-insensitively and through a display name", async () => {
        const store = makeStore();
        seedOwner("agent-1", "Otho");
        seedAddress("a1", "ops@x.com", { owner_id: "agent-1", administrator_id: "agent-1" });

        expect(await canOwnerSendFrom("agent-1", "OPS@X.COM", store)).toBe(true);
        expect(await canOwnerSendFrom("agent-1", "Ops Team <Ops@X.com>", store)).toBe(true);
      });

      it("does not match a DIFFERENT address that merely contains the target", async () => {
        // Nothing filters address rows on the seam, so the exactness is the facade's own job —
        // and both stores implement their message `from` filter as a SUBSTRING match, which is
        // the looseness a reader could inherit here by accident.
        const store = makeStore();
        seedOwner("agent-1", "Otho");
        seedAddress("a1", "xceo@acme.com", { owner_id: "agent-1", administrator_id: "agent-1" });

        expect(await canOwnerSendFrom("agent-1", "ceo@acme.com", store)).toBe(false);
      });

      it("answers false for a blank owner id", async () => {
        const store = makeStore();
        seedOwner("agent-1", "Otho");
        seedAddress("a1", "ops@x.com", { owner_id: "agent-1", administrator_id: "agent-1" });

        expect(await canOwnerSendFrom("", "ops@x.com", store)).toBe(false);
      });
    });

    describe("assertSendAuthorized", () => {
      it("returns the owner for an in-scope From", async () => {
        const store = makeStore();
        seedOwner("agent-1", "sender");
        seedAddress("a1", "ops@x.com", { owner_id: "agent-1", administrator_id: "agent-1" });
        const { token } = await createSendKey("agent-1", undefined, store);

        const owner = await assertSendAuthorized(token, "ops@x.com", store);

        expect(owner.id).toBe("agent-1");
        expect(owner.name).toBe("sender");
        expect(owner.type).toBe("agent");
      });

      it("names the owner when the From is out of scope", async () => {
        const store = makeStore();
        seedOwner("agent-1", "sender");
        seedAddress("a1", "ops@x.com", { owner_id: "agent-1", administrator_id: "agent-1" });
        seedAddress("a2", "other@x.com");
        const { token } = await createSendKey("agent-1", undefined, store);

        const error = await rejection(assertSendAuthorized(token, "other@x.com", store));

        expect(error.message).toMatch(/not authorized/i);
        expect(error.message).toContain("sender");
        expect(error.message).toContain("other@x.com");
      });

      it("rejects an invalid and a revoked token before looking at the From", async () => {
        const store = makeStore();
        seedOwner("agent-1", "sender");
        seedAddress("a1", "ops@x.com", { owner_id: "agent-1", administrator_id: "agent-1" });
        const { token, key } = await createSendKey("agent-1", undefined, store);

        expect((await rejection(assertSendAuthorized("esk_bogus", "ops@x.com", store))).message)
          .toMatch(/invalid or revoked/i);

        await revokeSendKey(key.id, store);
        expect((await rejection(assertSendAuthorized(token, "ops@x.com", store))).message)
          .toMatch(/invalid or revoked/i);
      });

      it("loses the key entirely when its owner is deleted locally — the cascade, measured", async () => {
        // A FINDING, recorded because it bounds what the case after this one can prove.
        // `send_keys.owner_id` is `REFERENCES owners(id) ON DELETE CASCADE` locally, so deleting
        // an owner deletes their keys with it: the "key outlived its owner" state is NOT
        // reachable through this store, and a test that tried to build it that way would be
        // asserting on a token that no longer resolves. The branch is reachable on a dataset
        // whose foreign key differs, which is why it is driven rather than seeded.
        const store = makeStore();
        seedOwner("agent-1", "sender");
        const { token, key } = await createSendKey("agent-1", undefined, store);
        db.run("DELETE FROM owners WHERE id = ?", ["agent-1"]);

        expect(await getSendKey(key.id, store)).toBeNull();
        expect((await rejection(assertSendAuthorized(token, "nobody@x.com", store))).message)
          .toMatch(/invalid or revoked/i);
      });
    });
  });
}

// ── the branches only a driven store can reach ──────────────────────────────────────────

describe("send keys — what an incomplete or refusing store produces", () => {
  it("propagates a listing REFUSAL rather than answering with an empty list", async () => {
    const store = withSendKeyList(sqliteStore(), async () => ({
      ok: false,
      code: "capability_unavailable",
      message: "this store cannot list send keys",
      status: 501,
    }));

    const error = await rejection(listSendKeys(undefined, undefined, store));

    expect(error.message).toContain("capability_unavailable");
    expect(error.message).toContain("501");
    expect(error.message).toContain("list this installation's send keys");
  });

  it("imposes its OWN tiebreak on a store that ordered ties the other way", async () => {
    // MUTATION TESTING FOUND THIS GAP, and it is worth stating why the obvious version of this
    // case proves nothing. Both variants above are ultimately answered by the SQLite store,
    // whose own `ORDER BY created_at DESC, id DESC` already presents ties in the order this
    // module wants — and `Array.prototype.sort` is STABLE, so removing the facade's tiebreaker
    // entirely leaves those results unchanged. The service orders ties the OPPOSITE way
    // (`resourceListOrderBy` appends `id ASC`), which is the input that can tell the two
    // apart, and no store available in a test process produces it.
    const ascendingTies: SendKeyRecord[] = ["k-a", "k-b", "k-c"].map((id) => ({
      ...fillerKey(10, "agent-1"),
      id,
      created_at: stamp(10),
      updated_at: stamp(10),
    }));
    const store = withSendKeyList(sqliteStore(), pagedList(ascendingTies));

    const keys = await listSendKeys("agent-1", undefined, store);

    expect(keys.map((key) => key.id)).toEqual(["k-c", "k-b", "k-a"]);
  });

  it("propagates a listing FAULT rather than answering with an empty list", async () => {
    const store = withSendKeyList(sqliteStore(), async () => {
      throw new Error("connection reset");
    });

    const error = await rejection(listSendKeySummaries("agent-1", undefined, store));

    expect(error.message).toContain("faulted");
    expect(error.message).toContain("connection reset");
  });

  it("REFUSES a window rather than cutting one out of a page budget that ran out", async () => {
    // A store that never serves an empty page. `enumerateStoreRows` stops on its budget, and a
    // window taken from that read would be a plausible page of the wrong keys.
    let served = 0;
    const store = withSendKeyList(sqliteStore(), async (opts) => {
      served += 1;
      const offset = opts?.offset ?? 0;
      return {
        ok: true,
        value: Array.from({ length: opts?.limit ?? 1 }, (_v, i) => fillerKey(offset + i, "agent-1")),
      };
    });

    const error = await rejection(listSendKeys("agent-1", { limit: 2, offset: 0 }, store));

    expect(error.message).toContain("enumeration budget ran out");
    expect(error.message).toContain("LOWER BOUND");
    expect(served).toBeGreaterThan(1);
  });

  it("REFUSES a by-owner listing on the same evidence, naming the empty-list hazard", async () => {
    const store = withSendKeyList(sqliteStore(), async (opts) => ({
      ok: true,
      value: Array.from({ length: opts?.limit ?? 1 }, (_v, i) => fillerKey((opts?.offset ?? 0) + i, "someone-else")),
    }));

    const error = await rejection(listSendKeysByOwners(["agent-1"], store));

    expect(error.message).toContain("reported as holding none");
  });

  it("REFUSES a listing that carries a key with no creation instant", async () => {
    // `''` sorts after every real instant under a descending compare, so an unreadable key
    // would be published as the OLDEST one. Reachable from the SQLite store, whose mapper
    // answers `""` for an absent column.
    const store = withSendKeyList(
      sqliteStore(),
      pagedList([{ ...fillerKey(1, "agent-1"), created_at: "", updated_at: "" }]),
    );

    const error = await rejection(listSendKeys(undefined, undefined, store));

    expect(error.message).toContain("no creation instant");
  });

  it("REFUSES a listing that carries a key with no id", async () => {
    const store = withSendKeyList(sqliteStore(), pagedList([{ ...fillerKey(1, "agent-1"), id: "" }]));

    const error = await rejection(listSendKeys(undefined, undefined, store));

    expect(error.message).toContain("carrying no id");
  });

  it("REFUSES rather than reporting a send unauthorized when the address scan ran out", async () => {
    // The fabricated denial. A truncated scan that answered `false` would report "this owner
    // may not send from that address" for an owner who may, and a reader would act on it by
    // widening the key's scope.
    const base = sqliteStore();
    const store: EmailStore = {
      ...base,
      addresses: {
        ...base.addresses,
        listAddresses: async (opts) => ({
          ok: true,
          value: Array.from({ length: opts?.limit ?? 1 }, (_v, i) => ({
            id: `a-${(opts?.offset ?? 0) + i}`,
            email: `filler-${(opts?.offset ?? 0) + i}@x.com`,
            domain: "x.com",
            display_name: null,
            status: "active",
            verified: true,
            daily_quota: null,
            owner_id: null,
            administrator_id: null,
            created_at: stamp(1),
            updated_at: stamp(1),
          })),
        }),
      },
    };

    const error = await rejection(canOwnerSendFrom("agent-1", "ops@x.com", store));

    expect(error.message).toContain("could not be determined");
    expect(error.message).toContain("refusing to report it as unauthorized");
  });

  it("answers TRUE from a truncated scan when the authorizing row was already found", async () => {
    // Positive evidence is conclusive; the budget only bounds how long it takes to fail to
    // find one. Without this the refusal above would also block a legitimate send.
    const base = sqliteStore();
    const store: EmailStore = {
      ...base,
      addresses: {
        ...base.addresses,
        listAddresses: async (opts) => ({
          ok: true,
          value: Array.from({ length: opts?.limit ?? 1 }, (_v, i) => {
            const n = (opts?.offset ?? 0) + i;
            return {
              id: `a-${n}`,
              email: n === 0 ? "ops@x.com" : `filler-${n}@x.com`,
              domain: "x.com",
              display_name: null,
              status: "active",
              verified: true,
              daily_quota: null,
              owner_id: n === 0 ? "agent-1" : null,
              administrator_id: n === 0 ? "agent-1" : null,
              created_at: stamp(1),
              updated_at: stamp(1),
            };
          }),
        }),
      },
    };

    expect(await canOwnerSendFrom("agent-1", "ops@x.com", store)).toBe(true);
  });

  it("answers false for a blank owner id WITHOUT reading a store that never finishes", async () => {
    // The short-circuit is not an optimisation. Without it a blank owner id would reach the
    // truncation refusal above and RAISE, where the answer — nobody is not an owner — was
    // knowable without reading anything.
    const base = sqliteStore();
    let served = 0;
    const store: EmailStore = {
      ...base,
      addresses: {
        ...base.addresses,
        listAddresses: async (opts) => {
          served += 1;
          return {
            ok: true,
            value: Array.from({ length: opts?.limit ?? 1 }, (_v, i) => ({
              id: `a-${(opts?.offset ?? 0) + i}`,
              email: "ops@x.com",
              domain: "x.com",
              display_name: null,
              status: "active",
              verified: true,
              daily_quota: null,
              owner_id: null,
              administrator_id: null,
              created_at: stamp(1),
              updated_at: stamp(1),
            })),
          };
        },
      },
    };

    expect(await canOwnerSendFrom("", "ops@x.com", store)).toBe(false);
    expect(served).toBe(0);
  });

  it("refuses to report a revocation the store did not actually make", async () => {
    // A write echo that comes back NOT revoked is a store contradicting itself. Reporting
    // `true` there would tell an operator a credential is dead when it is still live, which is
    // the worst direction for this particular lie.
    const base = sqliteStore();
    seedOwner("agent-1", "revoker");
    seedKey("k1", "agent-1", stamp(1));
    const store: EmailStore = {
      ...base,
      sendKeys: {
        ...base.sendKeys,
        revokeSendKey: async () => ({ ok: true, value: { ...fillerKey(1, "agent-1"), id: "k1" } }),
      },
    };

    const error = await rejection(revokeSendKey("k1", store));

    expect(error.message).toContain("refusing to report it as revoked");
  });

  it("propagates an address REFUSAL rather than reporting a send unauthorized", async () => {
    const base = sqliteStore();
    const store: EmailStore = {
      ...base,
      addresses: {
        ...base.addresses,
        listAddresses: async () => ({
          ok: false,
          code: "capability_unavailable",
          message: "this store cannot list addresses",
          status: 501,
        }),
      },
    };

    const error = await rejection(canOwnerSendFrom("agent-1", "ops@x.com", store));

    expect(error.message).toContain("capability_unavailable");
    expect(error.message).toContain("sender addresses");
  });

  it("reports a missing owner BEFORE reporting an authorization failure", async () => {
    // Divergence 9. A key whose owner row is gone must say so rather than report a scope
    // failure it cannot explain — and the From here is one no owner ever held, so a wrong
    // ordering would answer "not authorized" instead. The owner read is driven because the
    // local foreign key cascades the key away with its owner (see the case above).
    const base = sqliteStore();
    seedOwner("agent-1", "sender");
    const { token } = await createSendKey("agent-1", undefined, base);
    const store: EmailStore = {
      ...base,
      owners: { ...base.owners, get: async () => ({ ok: true, value: null }) },
    };

    const error = await rejection(assertSendAuthorized(token, "nobody@x.com", store));

    expect(error.message).toMatch(/owner no longer exists/i);
  });

  it("treats a key bound to NO owner as an owner that no longer exists", async () => {
    const base = sqliteStore();
    seedOwner("agent-1", "sender");
    seedAddress("a1", "ops@x.com", { owner_id: "agent-1", administrator_id: "agent-1" });
    const { token } = await createSendKey("agent-1", undefined, base);
    const store: EmailStore = {
      ...base,
      sendKeys: {
        ...base.sendKeys,
        verifySendKey: async () => ({ ok: true, value: { ...fillerKey(1, "agent-1"), owner_id: null } }),
      },
    };

    const error = await rejection(assertSendAuthorized(token, "ops@x.com", store));

    expect(error.message).toMatch(/owner no longer exists/i);
  });

  it("propagates a verification REFUSAL rather than reading it as an invalid token", async () => {
    // A refusal and a `null` mean different things — "this store cannot verify tokens" is not
    // "your token authorizes nothing" — and collapsing the first into the second would report
    // every holder of a perfectly good key as holding a revoked one.
    const base = sqliteStore();
    const store: EmailStore = {
      ...base,
      sendKeys: {
        ...base.sendKeys,
        verifySendKey: async () => ({
          ok: false,
          code: "capability_unavailable",
          message: "this store cannot verify send keys",
          status: 501,
        }),
      },
    };

    const error = await rejection(assertSendAuthorized("esk_whatever", "ops@x.com", store));

    expect(error.message).toContain("capability_unavailable");
    expect(error.message).toContain("verify a send key");
    expect(error.message).not.toMatch(/invalid or revoked/i);
  });

  it("faults on an owner row this module cannot read, rather than fabricating its fields", async () => {
    // NEITHER deleted arm did this: one cast the raw row straight to the owner type, so a
    // missing column arrived as `undefined` in a field typed `string`; the other FABRICATED
    // the current instant for an absent `created_at`.
    const base = sqliteStore();
    seedOwner("agent-1", "sender");
    seedAddress("a1", "ops@x.com", { owner_id: "agent-1", administrator_id: "agent-1" });
    const { token } = await createSendKey("agent-1", undefined, base);
    const store: EmailStore = {
      ...base,
      owners: { ...base.owners, get: async () => ({ ok: true, value: { id: "agent-1", type: "agent" } }) },
    };

    const error = await rejection(assertSendAuthorized(token, "ops@x.com", store));

    expect(error.message).toContain("carrying no name");
  });

  it("reads an owner kind that is not 'agent' as 'human' — an inherited coercion", async () => {
    // The deleted HTTP arm's coercion, preserved deliberately and pinned so neither direction
    // can change silently. The local table constrains the column, so only a drifted operator
    // dataset reaches it, and this module makes no decision from the answer.
    const base = sqliteStore();
    seedOwner("agent-1", "sender");
    seedAddress("a1", "ops@x.com", { owner_id: "agent-1", administrator_id: "agent-1" });
    const { token } = await createSendKey("agent-1", undefined, base);
    const store: EmailStore = {
      ...base,
      owners: {
        ...base.owners,
        get: async () => ({
          ok: true,
          value: { id: "agent-1", type: "robot", name: "sender", created_at: stamp(1), updated_at: stamp(1) },
        }),
      },
    };

    expect((await assertSendAuthorized(token, "ops@x.com", store)).type).toBe("human");
  });
});

// ── the configured store, with nothing injected ─────────────────────────────────────────

describe("send keys — the configured store", () => {
  it("resolves the store from storage configuration when none is injected", async () => {
    seedOwner("agent-1", "configured");
    seedKey("k1", "agent-1", stamp(1), { label: "from-configuration" });

    const keys = await listSendKeys("agent-1");

    expect(keys.map((key) => key.label)).toEqual(["from-configuration"]);
  });

  it("refuses to resolve a store when a database path AND an API are both configured", async () => {
    process.env[API_BASE_URL_SETTING] = service().baseUrl;
    process.env[API_CREDENTIAL_SETTINGS[2]] = service().apiKey;

    const error = await rejection(listSendKeys("agent-1"));

    expect(error.name).toBe("StoreConfigurationError");
  });
});
