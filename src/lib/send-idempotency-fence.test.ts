// `--idempotency-key` promises "Prevent duplicate sends — returns existing email if
// key was used before". On the local send path the only fence used to live in
// `createSentEmailLedger`, which runs AFTER `sendWithFailover` has already invoked
// the provider — so the same key twice meant TWO deliveries, ONE ledger row (keeping
// the first provider message id), and a second provider message id recorded nowhere.
// The recipient got two copies and the ledger showed one message.
//
// The fence must run BEFORE the provider call: same key twice = one delivery, one
// ledger row, and the second attempt returns the FIRST outcome.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "../db/database.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../store-resolution.js";
import { createProvider } from "../db/providers.local.js";
import { listSandboxEmails } from "../db/sandbox.js";
import { sendComposed } from "../cli/tui/data.local.js";
import { sendWithFailover } from "./send.local.js";

let db: Database;
let providerId: string;
let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;

/** Leave exactly ONE store configured — the in-memory SQLite this suite resets. */
function configureLocalStoreOnly(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
  process.env["EMAILS_DB_PATH"] = ":memory:";
}

beforeEach(() => {
  INHERITED_PROCESS_ENV = { ...process.env };
  configureLocalStoreOnly();
  resetDatabase();
  db = getDatabase();
  providerId = createProvider({ name: "sandbox", type: "sandbox", active: true }).id;
});

afterEach(() => {
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
});

function ledgerCount(): number {
  return (db.query("SELECT count(*) AS n FROM emails").get() as { n: number }).n;
}

describe("local send idempotency fences the PROVIDER call, not just the ledger row", () => {
  it("delivers once, ledgers once, and returns the first outcome for a repeated key", async () => {
    const input = {
      from: "agent@acme.com",
      to: "client@ext.com",
      subject: "hello",
      body: "body",
      idempotencyKey: "fence-key",
      providerId,
    };

    const first = await sendComposed(input, db);
    expect(await listSandboxEmails(providerId, 10, 0)).toHaveLength(1);
    expect(ledgerCount()).toBe(1);

    const second = await sendComposed(input, db);

    // ONE delivery: the provider must not have been invoked a second time.
    expect(await listSandboxEmails(providerId, 10, 0)).toHaveLength(1);
    // ONE ledger row.
    expect(ledgerCount()).toBe(1);
    // The second attempt returns the FIRST outcome — same ledger id, same
    // provider message id. A fresh provider message id here is the evidence of a
    // second provider invocation recorded nowhere.
    expect(second.id).toBe(first.id);
    expect(second.messageId).toBe(first.messageId);
  });

  it("does not fence sends that carry different keys or no key", async () => {
    const base = { from: "agent@acme.com", to: "client@ext.com", subject: "s", body: "b", providerId };
    await sendComposed({ ...base, idempotencyKey: "key-one" }, db);
    await sendComposed({ ...base, idempotencyKey: "key-two" }, db);
    await sendComposed(base, db);
    await sendComposed(base, db);

    expect(await listSandboxEmails(providerId, 10, 0)).toHaveLength(4);
    expect(ledgerCount()).toBe(4);
  });

  it("fences sendWithFailover itself, so every local caller inherits the guarantee", async () => {
    const opts = {
      provider_id: providerId,
      from: "agent@acme.com",
      to: "client@ext.com",
      subject: "direct",
      text: "body",
      idempotency_key: "direct-key",
    };
    const first = await sendWithFailover(providerId, opts, db);
    // Record the first outcome the way every production caller does.
    const { createSentEmailLedger } = await import("./sent-ledger.local.js");
    await createSentEmailLedger(first.providerId, opts, first.messageId, db);

    const second = await sendWithFailover(providerId, opts, db);

    expect(await listSandboxEmails(providerId, 10, 0)).toHaveLength(1);
    expect(second.messageId).toBe(first.messageId);
    expect(second.providerId).toBe(first.providerId);
  });
});
