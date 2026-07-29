// `emails inbox explain` on the LOCAL arm, which is the one consumer of the collapsed alias
// family whose call shape changed structurally rather than gaining an `await`.
//
// WHY THIS FILE EXISTS. `src/db/aliases.ts` collapsed onto the store seam, so every export is
// asynchronous. Three consumers absorbed that with a bare `await` inside handlers that were
// already async. This one did not: `inbox explain` became an `async` action, its per-recipient
// map became a `Promise.all`, and it now builds a store from the `Database` it already holds
// (`createSqliteEmailStore({ database: db })`) so the alias it reports comes from the SAME rows
// as the ownership and readiness facts printed beside it.
//
// Nothing executed that handler. `src/cli/commands/inbox.test.ts` has the only other `explain`
// case and it drives the facade under an API configuration, where this arm's `explain` is not the
// code that runs. Adversarial review found the gap: the sibling suite added an explicit
// missed-await detector for exactly this shape and the handler that actually changed shape had
// none.
//
// WHAT THE ASSERTIONS ARE FOR. `alias_target` is asserted BY VALUE, never for truthiness — an
// un-awaited promise is truthy, so `expect(...).toBeTruthy()` would pass on the bug this file
// exists to catch, and the structured payload would carry a promise where the CLI prints a
// string. The recipient ORDER is asserted too, because `Promise.all` preserves it and a
// hand-rolled loop over settled promises need not.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "../../db/database.js";
import { createAlias, createCatchAll } from "../../db/aliases.js";
import { createSqliteEmailStore } from "../../store-sqlite/index.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../../store-resolution.js";
import { startV1StoreApi } from "../../test-support/v1-store-api.js";
import { registerInboxCommands } from "./inbox.local.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
let db: Database;

function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}

function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

/**
 * The local SQLite file, and nothing else.
 *
 * A database path AND an API together are a hard boot error with deliberately no precedence rule,
 * so a stray inherited API setting would turn this into that error rather than into a local run.
 */
function configureLocalStore(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
  process.env["EMAILS_DB_PATH"] = ":memory:";
}

async function runInboxCommand(args: string[]): Promise<{ data: unknown; out: string }> {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerInboxCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

interface ExplainPayload {
  recipients: Array<{ recipient: string; alias_target: string | null }>;
}

beforeEach(() => {
  captureInheritedProcessEnv();
  configureLocalStore();
  resetDatabase();
  db = getDatabase();
});

afterEach(() => {
  closeDatabase();
  restoreInheritedProcessEnv();
});

/** One inbound message with two recipients, in a deliberate order. */
function seedInbound(): void {
  db.run(
    `INSERT INTO inbound_emails (id, from_address, to_addresses, subject, text_body, received_at, created_at, is_sent)
     VALUES ('inbound-explain-1', 'sender@elsewhere.test',
             '["hello@acme.example","nobody@unknown.example"]', 'Hello', 'body',
             datetime('now'), datetime('now'), 0)`,
  );
  // `inbound_recipients` is DERIVED by an AFTER INSERT trigger. It is asserted rather than
  // assumed, because an absent recipient row would make the payload below shorter and the case
  // would pass over less than it claims.
  const recipients = db
    .query("SELECT address FROM inbound_recipients WHERE inbound_email_id = 'inbound-explain-1' ORDER BY address")
    .all() as Array<{ address: string }>;
  expect(recipients.map((row) => row.address)).toEqual(["hello@acme.example", "nobody@unknown.example"]);
}

describe("inbox explain (local arm)", () => {
  it("resolves each recipient's alias through the collapsed family, by value and in order", async () => {
    seedInbound();
    const store = createSqliteEmailStore({ database: db, detail: "inbox explain fixture" });
    await createAlias("hello@acme.example", "ops@acme.example", store);

    const result = await runInboxCommand(["inbox", "explain", "inbound-explain-1"]);
    const payload = result.data as ExplainPayload;

    // BY VALUE, not by truthiness: a promise is truthy, so this is the assertion a missed
    // `await` in the handler cannot satisfy.
    expect(payload.recipients.map((r) => [r.recipient, r.alias_target])).toEqual([
      ["hello@acme.example", "ops@acme.example"],
      ["nobody@unknown.example", null],
    ]);
    expect(result.out).toContain("ops@acme.example");
  });

  it("reports the domain catch-all, and null for a recipient no alias covers", async () => {
    seedInbound();
    const store = createSqliteEmailStore({ database: db, detail: "inbox explain fixture" });
    await createCatchAll("acme.example", "inbox@acme.example", store);

    const payload = (await runInboxCommand(["inbox", "explain", "inbound-explain-1"])).data as ExplainPayload;

    expect(payload.recipients.map((r) => r.alias_target)).toEqual(["inbox@acme.example", null]);
  });

  it("resolves the alias against ITS OWN handle, not against the configured store", async () => {
    // THE PROPERTY THE HANDLER'S COMMENT CLAIMS, asserted rather than described. Every other fact
    // on this page — recipient ownership, domain readiness, provider names — is read from the
    // `Database` this arm holds. If the alias came from the CONFIGURED store instead, an
    // installation with an API configured would print one page assembled from two datasets with no
    // way for a reader to tell. A mutation run showed the claim was untested: dropping the store
    // argument survived, because in every other case here the configured store and the handle are
    // the same rows and the answer is identical either way.
    //
    // THE DISCRIMINATOR IS THE REQUEST COUNT, not a differing dataset. The `/v1` service below is
    // backed by this same database on purpose — so the ANSWER is the same whichever store the
    // handler used, and only the traffic tells them apart. That makes this a check on WHICH store
    // was consulted rather than on which rows exist, which is the property at issue. A fixture
    // over a second dataset would also work and would prove less: it would pass for a handler
    // that happened to read the right rows for the wrong reason.
    seedInbound();
    const store = createSqliteEmailStore({ database: db, detail: "inbox explain fixture" });
    await createAlias("hello@acme.example", "ops@acme.example", store);

    // The handle stays open inside the fixture, so the database path can leave the environment —
    // a path and an API together are a hard boot error with no precedence rule.
    const other = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "configured" }) });
    try {
      for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
      process.env[API_BASE_URL_SETTING] = other.baseUrl;
      process.env[API_CREDENTIAL_SETTINGS[2] as string] = other.apiKey;

      const before = other.requestCount();
      const payload = (await runInboxCommand(["inbox", "explain", "inbound-explain-1"])).data as ExplainPayload;

      expect(payload.recipients.map((r) => r.alias_target)).toEqual(["ops@acme.example", null]);
      // The configured store was never consulted — which is the whole assertion.
      expect(other.requestCount(), "the configured store was consulted").toBe(before);
      // And the control that it WOULD have answered had it been asked, so `before === after` is
      // not passing because the service is unreachable.
      expect(before).toBe(0);
      const reachable = await fetch(`${other.baseUrl}/v1/aliases`, {
        headers: { authorization: `Bearer ${other.apiKey}` },
      });
      expect(reachable.status).toBe(200);
      expect(other.requestCount()).toBeGreaterThan(before);
    } finally {
      other.stop();
    }
  });

  it("reports null for every recipient when nothing routes them", async () => {
    // The negative control. The migration seeds a protected global catch-all with an EMPTY
    // target, and an empty target must fall through rather than be reported as a route — so
    // "no alias configured" has to answer null here, not "".
    seedInbound();

    const payload = (await runInboxCommand(["inbox", "explain", "inbound-explain-1"])).data as ExplainPayload;

    expect(payload.recipients.map((r) => r.alias_target)).toEqual([null, null]);
  });
});
