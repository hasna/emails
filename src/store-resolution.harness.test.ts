// A CONSUMER RESOLVING ITS STORE FROM CONFIGURATION, UNDER THE REAL TEST HARNESS.
//
// src/store-resolution.test.ts covers the resolver by building its own environment
// objects, and that is right for a unit test of `planEmailStore`. It also means that
// suite could be entirely green while NO CALLER COULD ADOPT THE RESOLVER, which is
// exactly what happened: `scripts/run-hermetic-tests.sh` sets a database path for the
// whole suite, `V1Stub.applyEnv()` then added an API base URL and left the database
// path in place, and every self-hosted test therefore ran with TWO configured places to
// keep its mail. `planEmailStore` refuses that configuration — correctly, and that
// refusal must never be softened into a precedence rule — so any product code that
// called `createConfiguredEmailStore()` threw a boot error instead of running, in 73
// test files.
//
// The resolver was right; the HELPER was the thing configuring two stores. This file is
// the test the fix has to satisfy, and it is deliberately written so it cannot pass
// vacuously:
//
//   * the ambient database path is not assumed to be present — it is READ OUT OF THE
//     HARNESS SCRIPT and installed by `beforeEach`, so this file reproduces the exact
//     two-store condition whether it was launched by `bun run test` or by `bun test` on
//     its own, and a harness that stopped configuring a local store fails the guard
//     below rather than quietly making these tests trivial;
//   * the FIRST test asserts the ambient configuration on its own resolves to SQLite.
//     Without that positive control, "the API store came back" would also be satisfied
//     by a harness that never configured a local store, and the fix would be unproven;
//   * the consumer test does a real round trip through the returned store to the stub
//     and asserts the ROWS came from there, because a constructed HTTP store that never
//     reached the service would satisfy a capabilities check alone.
//
// The save/restore symmetry gets its own tests because bun runs every file in ONE
// process: a database path removed and not put back is a cross-file contamination bug
// that surfaces as a baffling failure in some later file, and "restored" to an empty
// string is not the same environment as absent.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HTTP_STORE_CAPABILITIES } from "./store-http/index.js";
import { SQLITE_STORE_CAPABILITIES } from "./store-sqlite/index.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  DATABASE_PATH_SETTINGS,
  StoreConfigurationError,
  createConfiguredEmailStore,
  planEmailStore,
} from "./store-resolution.js";
import { startV1Stub, type V1Stub } from "./test-support/v1-stub.js";

/**
 * The database path the hermetic harness configures for the whole suite, read out of
 * the harness itself.
 *
 * NOT restated here on purpose. This value is the first half of the two-store
 * contradiction, so a copy of it in this file could drift from the harness and leave
 * these tests exercising a condition production runs no longer have. Reading it also
 * makes the guard below meaningful: if the harness ever stops configuring a local
 * store, `harnessDatabaseSetting()` throws and this file goes red, instead of every
 * test in it passing over a contradiction that no longer exists.
 */
function harnessDatabaseSetting(): { setting: string; value: string } {
  const harness = readFileSync(join(import.meta.dir, "..", "scripts", "run-hermetic-tests.sh"), "utf8");
  const found: Array<{ setting: string; value: string }> = [];
  for (const setting of DATABASE_PATH_SETTINGS) {
    const assignment = new RegExp(String.raw`^\s*${setting}=(\S+?)\s*\\?$`, "m").exec(harness);
    if (assignment?.[1]) found.push({ setting, value: assignment[1] });
  }
  if (found.length !== 1) {
    throw new Error(
      `expected the hermetic harness to configure exactly one of ${DATABASE_PATH_SETTINGS.join("/")}, found ` +
        `${found.length} (${found.map((entry) => entry.setting).join(", ") || "none"})`,
    );
  }
  return found[0]!;
}

const HARNESS_DATABASE = harnessDatabaseSetting();

/** The higher-precedence setting, which a fix that handled only one of them would leave set. */
const HIGHER_PRECEDENCE_SETTING = DATABASE_PATH_SETTINGS[0];
const HIGHER_PRECEDENCE_VALUE = ":memory:";

/**
 * The settings whose VALUES may appear in a failure message: the two database paths and
 * the API origin. None of them can carry a credential, and they are the ones a reviewer
 * has to be able to read when this file goes red.
 */
const PRINTABLE_SETTINGS: ReadonlySet<string> = new Set<string>([
  ...DATABASE_PATH_SETTINGS,
  API_BASE_URL_SETTING,
]);

/**
 * The whole environment as a comparable value, with every value that is NOT in
 * `PRINTABLE_SETTINGS` replaced by a digest of itself.
 *
 * WHY NOT `{ ...process.env }`. A failed `toEqual` prints both operands, the hermetic
 * harness scrubs only the variables this product reads, and the ambient environment of a
 * real test run carries unrelated live credentials — so a raw whole-environment
 * comparison turns any regression here into a secret disclosure in a CI log. Digesting
 * is not a weakening: the KEY SET is still compared exactly, which is what catches a
 * leaked or stripped variable, and a digest changes whenever a value changes, which is
 * what catches a wrong restore. It only refuses to say what the value was.
 */
function comparableEnv(): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const key of Object.keys(process.env).sort()) {
    const value = process.env[key] ?? "";
    facts[key] = PRINTABLE_SETTINGS.has(key)
      ? value
      : `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
  }
  return facts;
}

/** Every database-path setting is gone from the environment. */
function noDatabasePathIsConfigured(): void {
  for (const setting of DATABASE_PATH_SETTINGS) {
    expect(
      Object.prototype.hasOwnProperty.call(process.env, setting),
      `${setting} is still configured while the API is`,
    ).toBe(false);
  }
}

let stub: V1Stub;
let inherited: NodeJS.ProcessEnv;

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => {
  stub.stop();
});

beforeEach(async () => {
  inherited = { ...process.env };
  await stub.reset();
  // Reproduce the harness's ambient local-store configuration exactly, so the
  // contradiction under test is present however this file was launched.
  process.env[HARNESS_DATABASE.setting] = HARNESS_DATABASE.value;
});

afterEach(() => {
  stub.clearEnv();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(inherited, key)) delete process.env[key];
  }
  Object.assign(process.env, inherited);
});

describe("the ambient test environment configures exactly one store", () => {
  it("resolves to the local database before a stub points it anywhere else", () => {
    // POSITIVE CONTROL for every test below. The ambient environment really does
    // configure a local store; so "the API store came back after applyEnv()" is a fact
    // about applyEnv() removing it, and not about it never having been there.
    expect(process.env[HARNESS_DATABASE.setting]).toBe(HARNESS_DATABASE.value);
    const plan = planEmailStore(process.env);
    expect(plan.store).toBe("sqlite");
    if (plan.store !== "sqlite") return;
    expect(plan.setting).toBe(HARNESS_DATABASE.setting);
    expect(plan.databasePath).toBe(HARNESS_DATABASE.value);
    // ...and the API is genuinely not configured yet, so this is one store and not two.
    expect(process.env[API_BASE_URL_SETTING]).toBeUndefined();
  });

  it("would refuse to boot if a stub added an API without removing the database path", () => {
    // The blocker itself, stated as a test rather than as prose: this is what every
    // self-hosted test looked like, and it is what `applyEnv()` must no longer produce.
    // The refusal names the KEYS at fault and never a value.
    const contradiction = {
      ...process.env,
      [API_BASE_URL_SETTING]: stub.baseUrl,
      [API_CREDENTIAL_SETTINGS[2]]: stub.apiKey,
    };
    let thrown: unknown;
    try {
      planEmailStore(contradiction);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StoreConfigurationError);
    expect((thrown as StoreConfigurationError).settings).toContain(HARNESS_DATABASE.setting);
    expect((thrown as StoreConfigurationError).settings).toContain(API_BASE_URL_SETTING);
    expect(String((thrown as Error).message)).not.toContain(stub.apiKey);
  });
});

describe("a consumer calling createConfiguredEmailStore() under a self-hosted test", () => {
  it("reaches the API store and serves rows from the configured service", async () => {
    await stub.seed({
      domains: [
        { id: "domain-harness-1", domain: "harness.example.test", status: "ready", verified: true },
      ],
    });
    stub.applyEnv();

    // PRODUCT CODE. No injected environment, no injected base URL: the same call a CLI
    // or MCP boot path makes. On unmodified main this line throws StoreConfigurationError.
    const store = createConfiguredEmailStore();

    // Identified by the capability set it DECLARES rather than by a label a caller
    // branches on (see src/store/descriptor.ts).
    expect(store.capabilities).toEqual(HTTP_STORE_CAPABILITIES);
    // ...and the two sets differ, so that assertion actually discriminates.
    expect(HTTP_STORE_CAPABILITIES).not.toEqual(SQLITE_STORE_CAPABILITIES);
    expect(store.descriptor.detail).toBe(`Emails API at ${stub.baseUrl}`);
    expect(store.descriptor.detail).not.toContain(stub.apiKey);

    // THE ROUND TRIP. A constructed HTTP store that never reached the service would
    // satisfy everything above, so the proof is that the rows came out of the stub.
    const answer = await store.domains.listDomains();
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.map((row) => row.domain)).toEqual(["harness.example.test"]);
    expect(answer.value[0]?.id).toBe("domain-harness-1");
    // The request was made SERVER-side against the stub, not synthesized locally.
    expect((await stub.listQueries("domains")).length).toBeGreaterThan(0);
  });

  it("removes both database-path settings, not only the lower-precedence one", () => {
    // A fix that unset `EMAILS_DB_PATH` and left `HASNA_EMAILS_DB_PATH` set would leave
    // the HIGHER-precedence setting configured and the boot error exactly where it was.
    process.env[HIGHER_PRECEDENCE_SETTING] = HIGHER_PRECEDENCE_VALUE;
    expect(planEmailStore(process.env).store).toBe("sqlite");

    stub.applyEnv();

    noDatabasePathIsConfigured();
    const plan = planEmailStore(process.env);
    expect(plan.store).toBe("api");
    if (plan.store !== "api") return;
    expect(plan.baseUrl).toBe(stub.baseUrl);
    expect(() => createConfiguredEmailStore()).not.toThrow();
  });
});

describe("the local-store configuration comes back exactly as it was", () => {
  it("restores every managed setting to its prior value", () => {
    process.env[HIGHER_PRECEDENCE_SETTING] = HIGHER_PRECEDENCE_VALUE;
    const before = comparableEnv();

    stub.applyEnv();
    // The restore is only worth asserting if something was actually removed. Without
    // this line the test would pass over a helper that never touched the database path.
    noDatabasePathIsConfigured();
    stub.clearEnv();

    // Whole-environment equality, not a key-by-key spot check: a leaked variable is a
    // cross-file contamination bug and the leak is not always the one being tested.
    expect(comparableEnv()).toEqual(before);
    const plan = planEmailStore(process.env);
    expect(plan.store).toBe("sqlite");
    if (plan.store !== "sqlite") return;
    // The higher-precedence setting wins again, which it cannot do if it came back
    // missing or blank.
    expect(plan.setting).toBe(HIGHER_PRECEDENCE_SETTING);
    expect(plan.databasePath).toBe(HIGHER_PRECEDENCE_VALUE);
  });

  it("restores an absent setting as absent rather than as an empty string", () => {
    delete process.env[HIGHER_PRECEDENCE_SETTING];
    const before = comparableEnv();

    stub.applyEnv();
    noDatabasePathIsConfigured();
    stub.clearEnv();

    expect(comparableEnv()).toEqual(before);
    // `""` and absent are different environments, and `comparableEnv` digests both to
    // the digest of the empty string — so the difference is asserted on the KEY, which
    // is the form that catches it. `planEmailStore` treats blank as unset, so an
    // empty-string restore would ALSO resolve to the default path rather than to the
    // harness's, which is why the plan is checked as well.
    expect(Object.prototype.hasOwnProperty.call(process.env, HIGHER_PRECEDENCE_SETTING)).toBe(false);
    const plan = planEmailStore(process.env);
    expect(plan.store).toBe("sqlite");
    if (plan.store !== "sqlite") return;
    expect(plan.setting).toBe(HARNESS_DATABASE.setting);
    expect(plan.databasePath).toBe(HARNESS_DATABASE.value);
  });

  it("does not re-snapshot on a second applyEnv, so clearEnv still restores the original", () => {
    const before = comparableEnv();

    stub.applyEnv();
    // A re-snapshot here would record this helper's OWN writes — the database path
    // already deleted — and clearEnv() would then "restore" it as deleted, leaking a
    // missing database path into every file that runs after this one.
    stub.applyEnv();
    noDatabasePathIsConfigured();
    stub.clearEnv();

    expect(comparableEnv()).toEqual(before);
    expect(process.env[HARNESS_DATABASE.setting]).toBe(HARNESS_DATABASE.value);
  });

  it("leaves the environment untouched when clearEnv runs without an applyEnv", () => {
    const before = comparableEnv();

    // Nothing was installed, so there is nothing to undo. Deleting the managed keys
    // here would strip a database path this helper never set — the same leak from the
    // other direction.
    stub.clearEnv();

    expect(comparableEnv()).toEqual(before);
    expect(process.env[HARNESS_DATABASE.setting]).toBe(HARNESS_DATABASE.value);
    expect(planEmailStore(process.env).store).toBe("sqlite");
  });
});
