// The `sendkey` command, over the collapsed send-key family.
//
// WHY THIS SUITE NO LONGER DRIVES THE `/v1` STUB. It used to, because the family's second arm
// talked to `/v1` through a `curl` bridge and the command reached it by setting the deployment
// word. `src/db/send-keys.ts` has collapsed onto the store seam and resolves its store from
// STORAGE CONFIGURATION — and so, now, does `src/db/owners.ts`, which this command also uses
// to turn a name into an id and ids back into names. The owner-name provenance split this
// header used to record (divergence 8 in src/db/send-keys.ts) is CLOSED: both families
// resolve the same configured store, so a name and a key cannot come from different datasets
// in any configuration.
//
// This suite still configures exactly ONE store, the local SQLite file, because what is left
// for it is the COMMAND — formatting, paging arguments, discarded answers — and the owners
// family's own both-store suite (src/db/owners.test.ts) is where the storage routing is
// proven against a real HTTP store.
//
// The send-key operations themselves are covered against BOTH shipped stores in
// `src/db/send-keys.test.ts`. What is left for this file is the COMMAND: its formatting, its
// paging arguments, and the two answers it used to discard.
//
// CREDENTIAL DISCIPLINE: no assertion reads or compares a token VALUE, only its `esk_` shape.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { registerSendKeyCommands } from "./sendkey.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../../store-resolution.js";

const OWNER_ID = "owner-sendkey-agent";
const PROVIDER_ID = "provider-sendkey";

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
 * Leave exactly ONE store configured.
 *
 * Named through the resolution's OWN exported constants rather than copied as literals. A
 * database path AND an API together are a hard boot error with deliberately no precedence
 * rule, so a stray inherited API setting would turn every case here into that error.
 */
function configureExactlyOneStore(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
  process.env[DATABASE_PATH_SETTINGS[1]] = ":memory:";
}

let db: ReturnType<typeof getDatabase>;

async function runSendKeyCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerSendKeyCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

/** An ISO instant `seconds` after a fixed epoch, so seeded order is unambiguous. */
function stamp(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
}

/**
 * A send key written straight into the table.
 *
 * `key_hash` is NOT A HASH: the column is `NOT NULL UNIQUE`, so the seed has to put something
 * unique there, and obvious filler is the honest choice. Nothing asserts on it.
 */
function seedKey(
  id: string,
  ownerId: string,
  createdAt: string,
  overrides: { label?: string | null; prefix?: string; revoked_at?: string | null } = {},
): void {
  db.run(
    `INSERT INTO send_keys (id, owner_id, key_hash, prefix, label, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ownerId,
      `not-a-hash-${id}`,
      overrides.prefix ?? "esk_00000000",
      overrides.label ?? null,
      createdAt,
      overrides.revoked_at ?? null,
    ],
  );
}

/**
 * A `/v1` service that serves ONE send key with a null `owner_id`, and nothing else.
 *
 * Deliberately tiny and local: the shared store-backed fixture
 * (`src/test-support/v1-store-api.ts`) translates every request into a real store, and both
 * real stores available in a test process are backed by the SQLite schema, whose
 * `send_keys.owner_id` is `NOT NULL`. This row is legal in the self-hosted Postgres schema
 * and cannot be produced by either of them, so it is served directly. It answers the
 * `{ items: [...] }` envelope and the empty second page that the enumeration terminates on,
 * both taken from the real route contract.
 */
function startNullOwnerSendKeyService(): { baseUrl: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/v1/send-keys") return Response.json({ error: "not found" }, { status: 404 });
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const items = offset === 0
        ? [{
            id: "sk-orphan",
            owner_id: null,
            prefix: "esk_00000000",
            label: "orphan",
            last_used_at: null,
            revoked_at: null,
            created_at: stamp(1),
            updated_at: stamp(1),
          }]
        : [];
      return Response.json({ items });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

beforeEach(() => {
  captureInheritedProcessEnv();
  configureExactlyOneStore();
  resetDatabase();
  db = getDatabase();
  db.run("INSERT INTO providers (id, name, type, active) VALUES (?, ?, 'sandbox', 1)", [PROVIDER_ID, PROVIDER_ID]);
  db.run("INSERT INTO owners (id, type, name, created_at, updated_at) VALUES (?, 'agent', ?, ?, ?)", [
    OWNER_ID,
    "sendkey-agent",
    stamp(0),
    stamp(0),
  ]);
});

afterEach(() => {
  closeDatabase();
  restoreInheritedProcessEnv();
});

describe("sendkey list command", () => {
  it("paginates send keys and displays owner names without leaking hashes", async () => {
    for (let i = 0; i < 5; i += 1) {
      seedKey(`sk-${i}`, OWNER_ID, stamp(i + 1), { label: `key-${i}`, prefix: `pf${i}` });
    }

    const result = await runSendKeyCommand(["sendkey", "list", "--owner", "sendkey-agent", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<Record<string, unknown> & { label: string | null; owner_id: string | null }>;

    expect(data.map((key) => key.label)).toEqual(["key-3", "key-2"]);
    expect(data.every((key) => key.owner_id === OWNER_ID)).toBe(true);
    expect(data.every((key) => !("key_hash" in key))).toBe(true);
    expect(result.out).toContain("sendkey-agent");
    expect(result.out).not.toContain("key-4");
  });

  it("renders a key whose owner is gone as '(no owner)' rather than blank", async () => {
    // A MEASURED SCHEMA ASYMMETRY, and the reason this one case configures an API instead of
    // the local file. `send_keys.owner_id` is `TEXT NOT NULL` in the local SQLite schema
    // (src/db/database.ts) and plain `TEXT` — NULLABLE — in the self-hosted Postgres schema
    // (src/server/self-hosted/migrations.ts), so a key that outlived its owner is unreachable
    // through one store and perfectly ordinary through the other. The seam types it
    // `string | null` for exactly that reason, and the command used to call `.slice(0, 8)` on
    // it unconditionally. A key bound to nobody is the row a revocation review most needs to
    // see, so it has to render as something a reader can act on.
    //
    // The service is a few lines rather than the shared fixture because the shared fixture is
    // backed by the same SQLite schema, so it cannot serve this row either.
    const service = startNullOwnerSendKeyService();
    try {
      process.env[DATABASE_PATH_SETTINGS[1]] = "";
      delete process.env[DATABASE_PATH_SETTINGS[1]];
      process.env[API_BASE_URL_SETTING] = service.baseUrl;
      process.env[API_CREDENTIAL_SETTINGS[2]] = "test-credential";

      const result = await runSendKeyCommand(["sendkey", "list"]);

      expect(result.out).toContain("(no owner)");
      expect(result.out).toContain("orphan");
      const rows = result.data as Array<{ owner_id: string | null }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.owner_id).toBeNull();
    } finally {
      service.stop();
    }
  });

  it("says so plainly when there are no keys", async () => {
    const result = await runSendKeyCommand(["sendkey", "list"]);

    expect(result.data).toEqual([]);
    expect(result.out).toContain("No send keys.");
  });
});

describe("sendkey create command", () => {
  it("mints a send key and returns the token once", async () => {
    const result = await runSendKeyCommand(["sendkey", "create", "sendkey-agent", "--label", "ci"]);
    const data = result.data as { id: string; token: string; owner_id: string; label: string | null };

    expect(data.token).toMatch(/^esk_/);
    expect(data.owner_id).toBe(OWNER_ID);
    expect(data.label).toBe("ci");
    expect(data.id.length).toBeGreaterThan(0);
    expect(result.out).toContain("Store it now");

    const list = await runSendKeyCommand(["sendkey", "list", "--owner", "sendkey-agent"]);
    const keys = list.data as Array<Record<string, unknown> & { id: string }>;
    expect(keys.map((k) => k.id)).toContain(data.id);
    expect(keys.every((k) => !("key_hash" in k))).toBe(true);
    // The listing NEVER carries the token, on any surface.
    expect(list.out).not.toContain(data.token);
  });
});

describe("sendkey revoke command", () => {
  it("reports a revocation only when one happened", async () => {
    // THE ANSWER USED TO BE DISCARDED: the command called `revokeSendKey(id)` and printed the
    // success line unconditionally, so re-revoking reported a revocation that did not happen
    // and stamped nothing.
    seedKey("sk-live", OWNER_ID, stamp(1), { label: "live" });

    const first = await runSendKeyCommand(["sendkey", "revoke", "sk-live"]);
    expect(first.out).toContain("Revoked send key");
    expect((first.data as { revoked: boolean }).revoked).toBe(true);

    const second = await runSendKeyCommand(["sendkey", "revoke", "sk-live"]);
    expect(second.out).toContain("already revoked");
    expect(second.out).not.toContain("✓ Revoked send key");
    expect((second.data as { revoked: boolean }).revoked).toBe(false);
  });
});

describe("sendkey check command", () => {
  it("answers the scope question from the configured store", async () => {
    db.run(
      `INSERT INTO addresses (id, provider_id, email, status, verified, owner_id, administrator_id, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
      ["a1", PROVIDER_ID, "ops@x.com", OWNER_ID, OWNER_ID, stamp(0), stamp(0)],
    );

    const allowed = await runSendKeyCommand(["sendkey", "check", "sendkey-agent", "ops@x.com"]);
    expect((allowed.data as { authorized: boolean }).authorized).toBe(true);
    expect(allowed.out).toContain("may send from");

    const denied = await runSendKeyCommand(["sendkey", "check", "sendkey-agent", "other@x.com"]);
    expect((denied.data as { authorized: boolean }).authorized).toBe(false);
    expect(denied.out).toContain("may NOT send from");
  });
});
