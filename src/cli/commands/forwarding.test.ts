// The `emails forwarding` command, driven for real against BOTH stores.
//
// This file used to drive the command against `src/test-support/v1-stub.ts` only, because
// the repository behind it routed every read and write to `/v1/forwarding` when the
// deployment word said so. The family has one implementation now and reaches storage
// through the store seam, so the command is exercised against a local SQLite store AND
// against an `HttpEmailStore` talking to a `/v1` service over real HTTP — the fixture from
// `src/test-support/v1-store-api.ts`, which stores nothing itself and translates HTTP into
// the same seam. `v1-stub.ts` is not used: its generic list handler ignores equality filters
// and it serves no `/v1/openapi.json`, which the HTTP store validates every filter and every
// write column against.
//
// `forwarding run` NO LONGER ASSERTS A LOUD FAILURE, and that is a strengthening rather
// than a removal. The old assertion was that the pipeline refuses in the self-hosted client;
// what is asserted now is that the pipeline RUNS against local storage and reaches the
// collapsed `listPendingForwarding` / `recordForwardingDelivery` through the facade — the
// consumer swap this collapse required, end to end.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "../../db/database.js";
import { listForwardingRules } from "../../db/forwarding.js";
import { createSqliteEmailStore } from "../../store-sqlite/index.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../../store-resolution.js";
import { startV1StoreApi, type V1StoreApi } from "../../test-support/v1-store-api.js";
import { registerForwardingCommands } from "./forwarding.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
let db: Database;
let api: V1StoreApi;

function clearStoreSettings(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
}

/** Local SQLite, which is also what `resolveId` reads. */
function configureLocalStore(): void {
  clearStoreSettings();
  process.env["EMAILS_DB_PATH"] = ":memory:";
}

/**
 * The `/v1` API, and NO database path — both configured at once is a hard boot error with
 * deliberately no precedence rule.
 */
function configureApiStore(): void {
  clearStoreSettings();
  process.env[API_BASE_URL_SETTING] = api.baseUrl;
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = api.apiKey;
}

beforeEach(() => {
  INHERITED_PROCESS_ENV = { ...process.env };
  configureLocalStore();
  resetDatabase();
  db = getDatabase();
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "forwarding CLI fixture" }) });
});

afterEach(() => {
  api.stop();
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
});

async function runForwardingCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerForwardingCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

async function runForwardingCommandExpectingError(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  const errors: string[] = [];
  const originalError = console.error;
  const originalExit = process.exit;
  console.error = ((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as typeof process.exit;
  registerForwardingCommands(program, () => {});
  try {
    await program.parseAsync(["node", "emails", ...args]);
  } catch {
    // handleError exits via the stubbed process.exit (or commander throws).
  } finally {
    console.error = originalError;
    process.exit = originalExit;
  }
  return errors.join("\n");
}

const STORE_CONFIGURATIONS: ReadonlyArray<[string, () => void]> = [
  ["local SQLite store", configureLocalStore],
  ["/v1 API store", configureApiStore],
];

describe("forwarding command", () => {
  for (const [name, configure] of STORE_CONFIGURATIONS) {
    it(`creates and lists app-level forwarding rules through the ${name}`, async () => {
      configure();
      const add = await runForwardingCommand(["forwarding", "add", "User@Example.com", "archive@example.net"]);
      const list = await runForwardingCommand(["forwarding", "list"]);

      expect(add.data).toMatchObject({
        source_address: "user@example.com",
        target_address: "archive@example.net",
        mode: "app-copy",
        enabled: true,
      });
      expect(list.out).toContain("user@example.com -> archive@example.net");
      expect(await listForwardingRules()).toHaveLength(1);
      // And the row really is in storage, read through the seam rather than through the
      // command that wrote it.
      const stored = await createSqliteEmailStore({ database: db }).forwarding.list({ limit: 10 });
      expect(stored.ok).toBe(true);
      if (stored.ok) expect(stored.value.map((row) => row["source_address"])).toEqual(["user@example.com"]);
    });

    it(`filters the list by --enabled and --disabled through the ${name}`, async () => {
      configure();
      await runForwardingCommand(["forwarding", "add", "a@x.com", "t@x.com"]);
      await runForwardingCommand(["forwarding", "add", "b@x.com", "t@x.com", "--disabled"]);

      const enabled = await runForwardingCommand(["forwarding", "list", "--enabled"]);
      const disabled = await runForwardingCommand(["forwarding", "list", "--disabled"]);
      expect(enabled.out).toContain("a@x.com -> t@x.com");
      expect(enabled.out).not.toContain("b@x.com");
      expect(disabled.out).toContain("b@x.com -> t@x.com");
      expect(disabled.out).not.toContain("a@x.com");
    });
  }

  it("enables, disables and removes a rule through the local store", async () => {
    // `resolveId` reads local SQLite for a partial id, so the id-resolving subcommands are
    // exercised in the configuration that supports them.
    configureLocalStore();
    const add = await runForwardingCommand(["forwarding", "add", "user@example.com", "archive@example.net"]);
    const id = (add.data as { id: string }).id;

    expect((await runForwardingCommand(["forwarding", "disable", id.slice(0, 8)])).out).toContain("disabled");
    expect((await listForwardingRules())[0]?.enabled).toBe(false);
    expect((await runForwardingCommand(["forwarding", "enable", id.slice(0, 8)])).out).toContain("enabled");
    expect((await listForwardingRules())[0]?.enabled).toBe(true);

    expect((await runForwardingCommand(["forwarding", "remove", id.slice(0, 8)])).out).toContain("removed");
    expect(await listForwardingRules()).toEqual([]);
  });

  it("REFUSES `forwarding run` at the command level when the mail lives behind the API", async () => {
    // THE REFUSAL HAS TO REACH THE OPERATOR, not just the function. `emails forwarding run` is the
    // path an operator actually takes, and the wrong outcome here is not an exception — it is a
    // cheerful "forwarding: 0 sent, 0 failed, 0 skipped (0 attempted)" for an inbox this side
    // never looked at. Asserted through the CLI's own error channel, and the setting to unset is
    // asserted too, because a refusal an operator cannot act on is a dead end.
    configureApiStore();
    const errors = await runForwardingCommandExpectingError(["forwarding", "run"]);
    expect(errors).toContain("reads its mail through an Emails API");
    expect(errors).toContain(API_BASE_URL_SETTING);
    // The positive control: nothing was recorded, so the refusal really did precede every read
    // and every write rather than aborting halfway through a run.
    const ledger = db.query("SELECT COUNT(*) AS n FROM forwarding_deliveries").get() as { n: number };
    expect(ledger.n).toBe(0);
  });

  it("reports a bad address as an error rather than creating a rule", async () => {
    configureLocalStore();
    const errors = await runForwardingCommandExpectingError(["forwarding", "add", "not-an-address", "t@x.com"]);
    expect(errors).toContain("Invalid email address");
    expect(await listForwardingRules()).toEqual([]);
  });

  it("runs the forwarding pipeline against local storage", async () => {
    // END TO END THROUGH THE CONSUMER SWAP. `emails forwarding run` reaches
    // `src/lib/forwarding.ts` — itself now ONE implementation, with both of its arms deleted —
    // which imports the collapsed `src/db/forwarding` facade and calls both local-storage
    // operations with the `Database` it already threads. Reaching this at all also exercises
    // that pipeline's storage-configuration gate on its passing side, because
    // `configureLocalStore()` names a local database.
    configureLocalStore();
    const empty = await runForwardingCommand(["forwarding", "run"]);
    expect(empty.data).toMatchObject({ attempted: 0, sent: 0, failed: 0, skipped: 0 });

    await runForwardingCommand(["forwarding", "add", "user@example.com", "archive@example.net"]);
    db.run(
      `INSERT INTO inbound_emails (id, from_address, to_addresses, subject, text_body, received_at, created_at, is_sent)
       VALUES ('inbound-1', 'sender@elsewhere.test', '["user@example.com"]', 'Hello', 'body',
               datetime('now', '+1 hour'), datetime('now'), 0)`,
    );
    // `inbound_recipients` is DERIVED from `to_addresses` by an AFTER INSERT trigger, so this
    // is `OR IGNORE`, and the row is asserted rather than assumed — the pending-forward join
    // is on this table, and a silently absent recipient would make the run below report zero
    // and pass for the wrong reason.
    db.run(
      "INSERT OR IGNORE INTO inbound_recipients (inbound_email_id, address, domain) VALUES ('inbound-1', 'user@example.com', 'example.com')",
    );
    const recipients = db
      .query("SELECT COUNT(*) AS n FROM inbound_recipients WHERE inbound_email_id = 'inbound-1'")
      .get() as { n: number };
    expect(recipients.n).toBe(1);

    // No provider is configured, so the pipeline records a FAILED delivery rather than
    // sending anything — which is the path that proves `recordForwardingDelivery` is reached
    // through the facade.
    const run = await runForwardingCommand(["forwarding", "run"]);
    expect(run.data).toMatchObject({ attempted: 1, sent: 0, failed: 1, skipped: 0 });
    const ledger = db.query("SELECT status, error FROM forwarding_deliveries").all() as Array<{
      status: string;
      error: string | null;
    }>;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.status).toBe("failed");
    expect(ledger[0]?.error).toContain("No active provider");
  });
});
