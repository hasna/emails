// The `emails alias` commands over the collapsed alias family.
//
// `src/db/aliases.ts` used to be a facade over two arm modules, and which one served a command
// depended on the process-wide deployment word. It is now one implementation over the store
// seam, so these cases drive the REAL commands against a store chosen by STORAGE configuration
// and nothing else — a `/v1` service over real HTTP for the API variant, and the local SQLite
// file for the other. Both variants run the same assertions, which is what makes "the CLI does
// the same thing either way" a checked claim rather than a hope.
//
// WHY THE COMMANDS HAD TO CHANGE AT ALL: every export on the seam is asynchronous, so each
// action handler now awaits. That is the shape of bug this suite exists to catch — an
// un-awaited promise is TRUTHY, so a missed `await` in the `resolve` handler would print a
// target for a recipient that has none, and the structured payload would carry a promise. The
// `resolve` cases below assert the payload exactly rather than merely that something printed.
//
// `src/test-support/v1-stub.ts` IS DELIBERATELY NOT USED any more. Its generic list handler
// ignores equality filters and it serves `/v1/openapi.json` only on request, and the real HTTP
// store validates every filter and every write column against that document — so a suite built
// on it cannot exercise the filter push-down or the write-column contract that this family now
// depends on. `src/test-support/v1-store-api.ts` translates HTTP into the same store seam
// instead, so a mis-mapped field fails rather than being handed back.
//
// THE SQLITE MIGRATION SEEDS A PROTECTED GLOBAL CATCH-ALL and the self-hosted schema does not.
// Here both variants read one SQLite database — the API variant reaches it over HTTP — so the
// seeded row is present either way, and `alias list` calls `ensureDefaultCatchAll()` itself.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "../../db/database.js";
import { createAlias, ensureDefaultCatchAll } from "../../db/aliases.js";
import { createSqliteEmailStore } from "../../store-sqlite/index.js";
import type { EmailStore } from "../../store/email-store.js";
import { startV1StoreApi, type V1StoreApi } from "../../test-support/v1-store-api.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../../store-resolution.js";
import { registerAliasCommands } from "./alias.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
let db: Database;
let api: V1StoreApi;

function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}

function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

function clearStoreSettings(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
}

/**
 * The local SQLite file, and nothing else.
 *
 * "A database path AND an API are both configured" is a HARD BOOT ERROR with deliberately no
 * precedence rule, so each variant has to leave exactly one setting standing.
 */
function configureLocalStore(): void {
  clearStoreSettings();
  process.env["EMAILS_DB_PATH"] = ":memory:";
}

/**
 * The `/v1` API, and nothing else.
 *
 * The service is backed by the same in-memory database, so the fixtures below are visible to
 * both variants; what differs is the transport the command's own store resolution picks.
 */
function configureApiStore(): void {
  clearStoreSettings();
  process.env[API_BASE_URL_SETTING] = api.baseUrl;
  process.env[API_CREDENTIAL_SETTINGS[2] as string] = api.apiKey;
}

async function runAliasCommand(args: string[]): Promise<{ data: unknown; out: string }> {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerAliasCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

/** The store the FIXTURES are written through, always the local one. */
function fixtureStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "alias command fixture" });
}

beforeEach(() => {
  captureInheritedProcessEnv();
  configureLocalStore();
  resetDatabase();
  db = getDatabase();
  api = startV1StoreApi({ store: fixtureStore() });
});

afterEach(() => {
  api.stop();
  closeDatabase();
  restoreInheritedProcessEnv();
});

const STORE_VARIANTS: ReadonlyArray<[string, () => void]> = [
  ["local SQLite store", configureLocalStore],
  ["/v1 API store", configureApiStore],
];

describe("alias commands", () => {
  for (const [name, configure] of STORE_VARIANTS) {
    it(`paginates aliases for human and structured output, on the ${name}`, async () => {
      await ensureDefaultCatchAll(fixtureStore());
      await createAlias("b@x.com", "t@x.com", fixtureStore());
      await createAlias("a@x.com", "t@x.com", fixtureStore());
      await createAlias("a@y.com", "t@y.com", fixtureStore());
      configure();

      const result = await runAliasCommand(["alias", "list", "--limit", "2", "--offset", "1"]);
      const data = result.data as Array<{ local_part: string; domain: string }>;

      expect(data.map((alias) => `${alias.local_part}@${alias.domain}`)).toEqual(["a@x.com", "b@x.com"]);
      expect(result.out).toContain("a@x.com");
      expect(result.out).not.toContain("*@*");
    });

    it(`paginates domain-filtered aliases, on the ${name}`, async () => {
      for (const alias of ["c@x.com", "a@x.com", "b@x.com"]) {
        await createAlias(alias, "t@x.com", fixtureStore());
      }
      await createAlias("a@y.com", "t@y.com", fixtureStore());
      configure();

      const result = await runAliasCommand(["alias", "list", "--domain", "x.com", "--limit", "2", "--offset", "1"]);
      const data = result.data as Array<{ local_part: string; domain: string }>;

      expect(data.map((alias) => `${alias.local_part}@${alias.domain}`)).toEqual(["b@x.com", "c@x.com"]);
      expect(result.out).not.toContain("a@y.com");
    });

    it(`adds, resolves and removes an alias, on the ${name}`, async () => {
      configure();
      const created = await runAliasCommand(["alias", "add", "hello@acme.com", "ops@acme.com"]);
      const alias = created.data as { id: string; target_address: string };
      expect(alias.target_address).toBe("ops@acme.com");
      expect(alias.id).toBeTruthy();

      // THE MISSED-AWAIT DETECTOR. A promise is truthy, so an un-awaited resolution would take
      // the "found" branch and print an object; the structured payload is asserted exactly.
      const resolved = await runAliasCommand(["alias", "resolve", "hello@acme.com"]);
      expect(resolved.data).toEqual({ recipient: "hello@acme.com", target: "ops@acme.com" });
      expect(resolved.out).toContain("ops@acme.com");

      const missing = await runAliasCommand(["alias", "resolve", "nobody@nowhere.example"]);
      expect(missing.data).toEqual({ recipient: "nobody@nowhere.example", target: null });
      expect(missing.out).toContain("no alias");

      await runAliasCommand(["alias", "remove", alias.id]);
      const gone = await runAliasCommand(["alias", "resolve", "hello@acme.com"]);
      expect(gone.data).toEqual({ recipient: "hello@acme.com", target: null });
    });

    it(`sets a domain catch-all and the protected global one, on the ${name}`, async () => {
      configure();
      const catchAll = await runAliasCommand(["alias", "catch-all", "acme.com", "inbox@acme.com"]);
      expect(catchAll.data).toMatchObject({ domain: "acme.com", local_part: "*", target_address: "inbox@acme.com" });
      expect(catchAll.out).toContain("catch-all *@acme.com");

      const global = await runAliasCommand(["alias", "global", "inbox@hq.com"]);
      expect(global.data).toMatchObject({ domain: "*", local_part: "*", target_address: "inbox@hq.com" });

      // A recipient with no specific alias lands on the domain catch-all, and one on an unknown
      // domain lands on the global one.
      expect((await runAliasCommand(["alias", "resolve", "whoever@acme.com"])).data)
        .toEqual({ recipient: "whoever@acme.com", target: "inbox@acme.com" });
      expect((await runAliasCommand(["alias", "resolve", "whoever@other.example"])).data)
        .toEqual({ recipient: "whoever@other.example", target: "inbox@hq.com" });
    });
  }

  it("really does drive the two variants through different transports", async () => {
    // THE CONTROL for the variant list above. Without it "both variants passed" is also
    // consistent with the API variant silently falling back to the local file, which is the one
    // failure that would make every case above prove half as much as it claims.
    configureApiStore();
    const before = api.requestCount();
    await runAliasCommand(["alias", "add", "hello@acme.com", "ops@acme.com"]);
    expect(api.requestCount()).toBeGreaterThan(before);

    configureLocalStore();
    const afterLocal = api.requestCount();
    await runAliasCommand(["alias", "add", "second@acme.com", "ops@acme.com"]);
    expect(api.requestCount()).toBe(afterLocal);
  });
});
