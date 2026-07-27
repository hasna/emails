// Store resolution: all four quadrants of (database path set?) x (API base URL set?),
// and the proof that the contradiction is a THROWN boot error rather than a value.
//
// WHY THE BOTH-CONFIGURED CASE IS THE POINT OF THIS FILE. A resolver that answered
// "the API wins" would pass a test that only checked the three unambiguous quadrants,
// and would then quietly read an operator's mail out of the wrong store forever. So
// the assertion here is `toThrow`, not "returns the API plan": a returned value —
// however documented — is a precedence rule, and a precedence rule is the deployment
// switch this program is deleting, wearing a different hat.
//
// EVERY TEST BUILDS ITS OWN ENVIRONMENT OBJECT and never mutates `process.env`. The
// hermetic runner sets `EMAILS_DB_PATH=:memory:` for the whole suite, so a test that
// read the ambient environment could not express the "nothing configured" quadrant at
// all — and would have silently tested three quadrants while claiming four.

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, defaultDatabasePath, resetDatabase } from "./db/database.js";
import { HTTP_STORE_CAPABILITIES } from "./store-http/index.js";
import { SQLITE_STORE_CAPABILITIES } from "./store-sqlite/index.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
  StoreConfigurationError,
  createConfiguredEmailStore,
  planEmailStore,
} from "./store-resolution.js";

/** An environment with nothing this resolver reads, so a quadrant is exactly stated. */
function bare(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides };
}

const A_URL = "https://mail.example.test";
const A_TOKEN = "emss_conformance_session_token";

describe("configured store resolution — the four quadrants", () => {
  it("defaults to the local SQLite database when nothing is configured", () => {
    const plan = planEmailStore(bare());
    expect(plan.store).toBe("sqlite");
    if (plan.store !== "sqlite") return;
    // The DOCUMENTED default, named from the database layer rather than re-spelled, so
    // this asserts the two agree instead of asserting a literal twice.
    expect(plan.databasePath).toBe(defaultDatabasePath());
    // ...and it ends where the operator is told it ends.
    expect(plan.databasePath.endsWith(join(".hasna", "emails", "emails.db"))).toBe(true);
    // `setting: null` is how a diagnostic tells "defaulted" from "configured", and it
    // is the reason the field is nullable rather than a string.
    expect(plan.setting).toBeNull();
  });

  it("uses the configured database path, and the documented setting wins", () => {
    const first = DATABASE_PATH_SETTINGS[0];
    const second = DATABASE_PATH_SETTINGS[1];
    // Precedence is pinned by name, not by index, so a reordering of the constant is a
    // failure here rather than a silent change of behaviour.
    expect(first).toBe("HASNA_EMAILS_DB_PATH");
    expect(second).toBe("EMAILS_DB_PATH");

    const lower = planEmailStore(bare({ [second]: "/tmp/lower.db" }));
    expect(lower.store).toBe("sqlite");
    if (lower.store !== "sqlite") return;
    expect(lower.databasePath).toBe("/tmp/lower.db");
    expect(lower.setting).toBe(second);

    // BOTH database settings set is NOT a contradiction — they configure the same
    // thing, and the precedence between them is documented in the database layer.
    const both = planEmailStore(bare({ [first]: "/tmp/higher.db", [second]: "/tmp/lower.db" }));
    expect(both.store).toBe("sqlite");
    if (both.store !== "sqlite") return;
    expect(both.databasePath, `${first} must be read before ${second}`).toBe("/tmp/higher.db");
    expect(both.setting).toBe(first);
  });

  it("uses the API when only the base URL is configured", () => {
    const plan = planEmailStore(bare({ [API_BASE_URL_SETTING]: A_URL, [API_CREDENTIAL_SETTINGS[0]]: A_TOKEN }));
    expect(plan.store).toBe("api");
    if (plan.store !== "api") return;
    expect(plan.baseUrl).toBe(A_URL);
    expect(plan.setting).toBe(API_BASE_URL_SETTING);
    expect(plan.credentialSetting).toBe(API_CREDENTIAL_SETTINGS[0]);
    // THE PLAN MUST NOT CARRY THE CREDENTIAL. It names the setting instead, because a
    // plan is the object most likely to reach a log line.
    expect(JSON.stringify(plan)).not.toContain(A_TOKEN);
  });

  it("prefers the session token over the operator API key, and says which it used", () => {
    expect(API_CREDENTIAL_SETTINGS[0]).toBe("EMAILS_SESSION_TOKEN");
    expect(API_CREDENTIAL_SETTINGS[1]).toBe("EMAILS_SELF_HOSTED_API_KEY");
    const keyOnly = planEmailStore(bare({ [API_BASE_URL_SETTING]: A_URL, [API_CREDENTIAL_SETTINGS[1]]: "hasna_k" }));
    expect(keyOnly.store === "api" && keyOnly.credentialSetting).toBe(API_CREDENTIAL_SETTINGS[1]);
    const bothCredentials = planEmailStore(
      bare({
        [API_BASE_URL_SETTING]: A_URL,
        [API_CREDENTIAL_SETTINGS[0]]: A_TOKEN,
        [API_CREDENTIAL_SETTINGS[1]]: "hasna_k",
      }),
    );
    expect(bothCredentials.store === "api" && bothCredentials.credentialSetting).toBe(API_CREDENTIAL_SETTINGS[0]);
  });

  it("REFUSES TO START when both a database path and an API base URL are configured", () => {
    for (const databaseSetting of DATABASE_PATH_SETTINGS) {
      const env = bare({
        [databaseSetting]: "/tmp/local.db",
        [API_BASE_URL_SETTING]: A_URL,
        [API_CREDENTIAL_SETTINGS[0]]: A_TOKEN,
      });
      // A THROW, not an outcome. `planEmailStore` returns a value for every resolvable
      // configuration, so a returned answer here would be indistinguishable from a
      // precedence rule to every caller.
      expect(() => planEmailStore(env)).toThrow(StoreConfigurationError);
      let thrown: unknown;
      try {
        planEmailStore(env);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(StoreConfigurationError);
      const error = thrown as StoreConfigurationError;
      // The message must NAME BOTH offending settings — an operator who is told only
      // "conflicting configuration" has to go looking for which two.
      expect(error.message).toContain(databaseSetting);
      expect(error.message).toContain(API_BASE_URL_SETTING);
      // ...and it must tell them what to do about it.
      expect(error.message.toLowerCase()).toContain("unset one");
      // The machine-readable half, so a boot path can report the keys without parsing
      // English.
      expect([...error.settings].sort()).toEqual([databaseSetting, API_BASE_URL_SETTING].sort());
      // No value is ever quoted, because one of these settings can be a credential.
      expect(error.message).not.toContain(A_TOKEN);
      expect(error.message).not.toContain("/tmp/local.db");
    }
  });

  it("names EVERY offending setting when all three are configured at once", () => {
    let thrown: unknown;
    try {
      planEmailStore(
        bare({
          [DATABASE_PATH_SETTINGS[0]]: "/tmp/a.db",
          [DATABASE_PATH_SETTINGS[1]]: "/tmp/b.db",
          [API_BASE_URL_SETTING]: A_URL,
          [API_SETTINGS_POINTER]: "vault://emails/client",
          [API_CREDENTIAL_SETTINGS[0]]: A_TOKEN,
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StoreConfigurationError);
    expect([...(thrown as StoreConfigurationError).settings].sort()).toEqual(
      [...DATABASE_PATH_SETTINGS, API_BASE_URL_SETTING, API_SETTINGS_POINTER].sort(),
    );
  });
});

describe("configured store resolution — configurations it will not guess at", () => {
  it("refuses an API base URL with no credential instead of building a store that 401s", () => {
    let thrown: unknown;
    try {
      planEmailStore(bare({ [API_BASE_URL_SETTING]: A_URL }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StoreConfigurationError);
    const error = thrown as StoreConfigurationError;
    for (const setting of API_CREDENTIAL_SETTINGS) expect(error.message).toContain(setting);
    // A credential-less API store answers 401 on every operation, which is
    // indistinguishable from a store that legitimately declines everything.
    expect(error.settings).toContain(API_BASE_URL_SETTING);
  });

  it("refuses a vault pointer whose settings were never loaded, rather than falling back to SQLite", () => {
    // The silent-wrong-store case that has no contradiction to detect: the pointer
    // names an API, the URL it delivers is absent, and a resolver that ignored the
    // pointer would hand back local SQLite to an operator configured for the API.
    let thrown: unknown;
    try {
      planEmailStore(bare({ [API_SETTINGS_POINTER]: "vault://emails/client" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StoreConfigurationError);
    const error = thrown as StoreConfigurationError;
    expect(error.message).toContain(API_SETTINGS_POINTER);
    expect(error.message).toContain(API_BASE_URL_SETTING);
    expect([...error.settings].sort()).toEqual([API_SETTINGS_POINTER, API_BASE_URL_SETTING].sort());
  });

  it("treats a blank setting as unset in every position", () => {
    // `FOO=` in a compose file, an unset shell variable expanded into an env block, and
    // a whitespace-only value are all "not configured". Without this, an empty
    // `EMAILS_SELF_HOSTED_URL` beside a database path would be a boot error for a
    // configuration that names exactly one store.
    for (const blank of ["", "   ", "\t\n"]) {
      const plan = planEmailStore(bare({ [DATABASE_PATH_SETTINGS[1]]: "/tmp/x.db", [API_BASE_URL_SETTING]: blank }));
      expect(plan.store, `${JSON.stringify(blank)} must not configure an API`).toBe("sqlite");
      const defaulted = planEmailStore(bare({ [DATABASE_PATH_SETTINGS[1]]: blank }));
      expect(defaulted.store === "sqlite" && defaulted.setting, `${JSON.stringify(blank)} must not name a path`).toBe(
        null,
      );
      // ...and a blank pointer is not an unloaded pointer.
      expect(() => planEmailStore(bare({ [API_SETTINGS_POINTER]: blank }))).not.toThrow();
    }
  });
});

describe("the store the resolution actually hands back", () => {
  afterEach(() => {
    closeDatabase();
  });

  it("builds the SQLite store for a configured database path", () => {
    resetDatabase();
    const store = createConfiguredEmailStore(bare({ [DATABASE_PATH_SETTINGS[1]]: ":memory:" }));
    // Identified by the capability set it DECLARES, not by a label a caller branches
    // on — `descriptor.kind` is `string` on the seam precisely so this cannot become a
    // switch (see src/store/descriptor.ts).
    expect(store.capabilities).toEqual(SQLITE_STORE_CAPABILITIES);
    expect(store.descriptor.detail).toContain(":memory:");
  });

  it("builds the API store for a configured base URL, and leaks no credential", () => {
    const store = createConfiguredEmailStore(
      bare({
        [API_BASE_URL_SETTING]: `https://operator:${A_TOKEN}@mail.example.test/v1?t=1`,
        [API_CREDENTIAL_SETTINGS[0]]: A_TOKEN,
      }),
    );
    expect(store.capabilities).toEqual(HTTP_STORE_CAPABILITIES);
    // The two capability sets differ, so the assertion above actually discriminates.
    expect(HTTP_STORE_CAPABILITIES).not.toEqual(SQLITE_STORE_CAPABILITIES);
    // The diagnostics string is the one most likely to reach a log, and the configured
    // URL here carries userinfo and a query string on purpose.
    expect(store.descriptor.detail).not.toContain(A_TOKEN);
    expect(store.descriptor.detail).not.toContain("operator");
    expect(store.descriptor.detail).toBe("Emails API at https://mail.example.test");
  });

  it("throws instead of building anything when the configuration contradicts itself", () => {
    // The construction path must not resolve what the plan refused to. A store built
    // here would be a working store for one of the two configured places to keep mail.
    expect(() =>
      createConfiguredEmailStore(
        bare({
          [DATABASE_PATH_SETTINGS[1]]: ":memory:",
          [API_BASE_URL_SETTING]: A_URL,
          [API_CREDENTIAL_SETTINGS[0]]: A_TOKEN,
        }),
      ),
    ).toThrow(StoreConfigurationError);
  });
});

describe("what the resolver is not allowed to read", () => {
  it("reads storage configuration and never a deployment-mode word", () => {
    // STRUCTURAL, not conventional. The resolution has to follow from which storage
    // setting is present; a resolver that consulted a deployment word would rebuild the
    // coupling the store seam exists to remove, and would take a dependency on a module
    // that is scheduled for deletion. Asserted against the source text because that is
    // the only check that survives someone adding the import back "just for a default".
    const source = readFileSync(join(import.meta.dir, "store-resolution.ts"), "utf8");
    expect(source).not.toContain("lib/mode");
    // The mode module's readers, spelled by construction so this file contributes
    // nothing to the axis ratchet it sits inside.
    for (const reader of ["getEmails", "resolveEmails", "normalizeEmails", "isSelfHosted"]) {
      expect(source, `${reader}… must not appear in the resolver`).not.toContain(`${reader}Mode`);
    }
    // The variable itself, assembled rather than written, for the same reason.
    expect(source).not.toContain(["EMAILS", "MODE"].join("_"));
    // POSITIVE CONTROL: the assertions above would pass over an empty read or a
    // mistyped path, which is how a guard in this repo once blessed an empty tarball.
    expect(source.length).toBeGreaterThan(4_000);
    expect(source).toContain("DATABASE_PATH_SETTINGS");
    expect(source).toContain(["EMAILS", "SELF", "HOSTED", "URL"].join("_"));
  });
});
