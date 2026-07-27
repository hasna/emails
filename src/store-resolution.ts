// WHICH OF THE TWO STORES A CLIENT GETS, decided from operator STORAGE configuration
// and from nothing else.
//
// There are exactly two client stores and there will only ever be two: the local
// SQLite file, or a client of an Emails `/v1` API. So the only question this module
// answers is "which one did the operator configure?", and the answer follows from
// which storage setting is present:
//
//   | database path | API base URL | result                                        |
//   |---------------|--------------|-----------------------------------------------|
//   | unset         | unset        | SQLite at the documented default path         |
//   | set           | unset        | SQLite at that path                           |
//   | unset         | set          | the API client                                |
//   | SET           | SET          | **HARD BOOT ERROR** — see below               |
//
// BOTH CONFIGURED IS A BOOT ERROR, NOT A PRECEDENCE RULE, and this is the whole
// reason the module exists. A precedence rule answers "which one wins?" when the
// question the operator actually asked was "which one did you mean?" — and it answers
// it SILENTLY. Two configured sources with a documented winner is not a safer design
// than a deployment switch; it *is* a deployment switch, with the switch position
// inferred instead of declared, and the failure mode is mail written to, or read from,
// the store the operator did not mean. The only honest answer to a contradiction is to
// refuse to start and name both settings.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT READ: any deployment-mode variable, and any
// module that resolves one. Selection here is a fact about STORAGE configuration. A
// resolver that consulted a deployment word would re-create the coupling that the
// store seam exists to remove, and would make this file depend on a module that is
// scheduled for deletion. Grep this file for a mode read and you will find none;
// that absence is asserted by src/store-resolution.test.ts.
//
// CONSTRUCTION IS THE ONLY PLACE THE ANSWER IS VISIBLE. `StorePlan` is a two-arm
// discriminated union on purpose — an exhaustive `switch` over it means a THIRD arm
// would be a `tsc` error, which is the property that pins "exactly two stores"
// structurally rather than by comment. The `EmailStore` handed back carries no such
// discriminant: after construction nobody may ask what kind of store they have (see
// src/store/descriptor.ts for what happened the last time a label like that existed).

import { defaultDatabasePath, getDatabasePath } from "./db/database.js";
import { EMAILS_CLIENT_ENV_SECRET_ENV, EMAILS_SESSION_TOKEN_ENV } from "./lib/client-env.js";
import type { EmailStore } from "./store/email-store.js";
import { createHttpEmailStore } from "./store-http/index.js";
import { createSqliteEmailStore } from "./store-sqlite/index.js";

/**
 * The settings that name a local SQLite file, in the precedence order the database
 * layer already applies: `HASNA_EMAILS_DB_PATH` is read BEFORE `EMAILS_DB_PATH`
 * (src/db/database.ts, `getDbPath`). Listed here so the resolution and the database
 * layer cannot disagree about which one wins, and so an error message can name the
 * key the operator actually has to change.
 */
export const DATABASE_PATH_SETTINGS = Object.freeze(["HASNA_EMAILS_DB_PATH", "EMAILS_DB_PATH"] as const);

/** The setting that names an Emails API origin. */
export const API_BASE_URL_SETTING = "EMAILS_SELF_HOSTED_URL";

/**
 * The settings that carry the API credential, in precedence order. A user session
 * token wins over an operator API key, matching the existing client.
 */
export const API_CREDENTIAL_SETTINGS = Object.freeze([
  EMAILS_SESSION_TOKEN_ENV,
  "EMAILS_SELF_HOSTED_API_KEY",
] as const);

/**
 * The vault pointer that DELIVERS the two settings above rather than being one.
 *
 * It is read here for one reason: a pointer that is set while the settings it delivers
 * are absent from the environment is a configuration this module cannot decide from.
 * Ignoring it would make the resolution fall through to local SQLite and serve local
 * rows to an operator who configured an API — the silent wrong-store pick this module
 * exists to prevent. So it is a boot error, and the message says to load the client
 * environment first.
 */
export const API_SETTINGS_POINTER = EMAILS_CLIENT_ENV_SECRET_ENV;

/**
 * A configuration that cannot be resolved to exactly one store.
 *
 * A distinct class rather than a bare `Error` so a boot path can tell "the operator
 * has to change a setting" from a genuine fault, and `settings` carries the KEYS at
 * fault — never their values, because one of them can be a credential.
 */
export class StoreConfigurationError extends Error {
  readonly settings: readonly string[];

  constructor(message: string, settings: readonly string[]) {
    super(message);
    this.name = "StoreConfigurationError";
    this.settings = Object.freeze([...settings]);
  }
}

/**
 * The resolved decision. Consumed by `createConfiguredEmailStore` and by tests, and
 * by nothing else — it is not a runtime label for callers to branch on.
 */
export type StorePlan =
  | {
      readonly store: "sqlite";
      /**
       * The configured path AS GIVEN, or the documented default when nothing named one.
       * Safe to print. Not necessarily canonical: the database layer resolves symlinks
       * and relative segments when it opens the file, so this is what the operator wrote
       * rather than what the connection ends up bound to.
       */
      readonly databasePath: string;
      /** Which setting supplied it, or null when it is the documented default. */
      readonly setting: string | null;
    }
  | {
      readonly store: "api";
      /** The configured origin, as given. Normalised by the store itself. */
      readonly baseUrl: string;
      readonly setting: string;
      /** Which setting carries the credential. NEVER the credential itself. */
      readonly credentialSetting: string;
    };

/** A setting is configured when it is present and not blank. */
function configured(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : value;
}

/** Every database-path setting that is configured, in precedence order. */
function databasePathSettings(env: NodeJS.ProcessEnv): string[] {
  return DATABASE_PATH_SETTINGS.filter((key) => configured(env, key) !== null);
}

/**
 * Decide which store this configuration means, or throw.
 *
 * Pure apart from the default-path branch, which resolves (and, as the database layer
 * always has, creates) the data directory.
 */
export function planEmailStore(env: NodeJS.ProcessEnv = process.env): StorePlan {
  const databaseKeys = databasePathSettings(env);
  const apiBaseUrl = configured(env, API_BASE_URL_SETTING);
  const pointer = configured(env, API_SETTINGS_POINTER);

  // 1. THE CONTRADICTION, checked first and never resolved by precedence.
  if (databaseKeys.length > 0 && (apiBaseUrl !== null || pointer !== null)) {
    const apiKeys = [
      ...(apiBaseUrl === null ? [] : [API_BASE_URL_SETTING]),
      ...(pointer === null ? [] : [API_SETTINGS_POINTER]),
    ];
    const offenders = [...databaseKeys, ...apiKeys];
    throw new StoreConfigurationError(
      `${databaseKeys.join(" and ")} configure a local database and ` +
        `${apiKeys.join(" and ")} configure an Emails API, so this installation has ` +
        "two configured places to keep its mail and no way to tell which one you meant. " +
        `UNSET ONE: keep ${apiKeys.join("/")} to read and write through the API, or ` +
        `${databaseKeys.join("/")} to use the local database. There is deliberately no ` +
        "precedence rule — a winner picked for you would silently send your mail to the " +
        "store you did not mean.",
      offenders,
    );
  }

  // 2. A pointer whose payload has not been loaded. Refusing to guess, rather than
  //    falling through to SQLite under a configuration that names an API.
  if (apiBaseUrl === null && pointer !== null) {
    throw new StoreConfigurationError(
      `${API_SETTINGS_POINTER} is set, but ${API_BASE_URL_SETTING} is not present in this ` +
        "environment. That pointer only DELIVERS the API settings; load the client " +
        `environment it names before resolving a store, or unset ${API_SETTINGS_POINTER} to ` +
        "use the local database.",
      [API_SETTINGS_POINTER, API_BASE_URL_SETTING],
    );
  }

  // 3. The API, which needs a credential. A URL with no credential cannot produce a
  //    working store, and answering 401 on every operation would look exactly like a
  //    store that legitimately declines everything.
  if (apiBaseUrl !== null) {
    const credentialSetting = API_CREDENTIAL_SETTINGS.find((key) => configured(env, key) !== null);
    if (credentialSetting === undefined) {
      throw new StoreConfigurationError(
        `${API_BASE_URL_SETTING} configures an Emails API but no credential is set. ` +
          `Set ${API_CREDENTIAL_SETTINGS.join(" or ")} (a user session token wins over an ` +
          `operator API key), or unset ${API_BASE_URL_SETTING} to use the local database.`,
        [API_BASE_URL_SETTING, ...API_CREDENTIAL_SETTINGS],
      );
    }
    return Object.freeze({
      store: "api" as const,
      baseUrl: apiBaseUrl,
      setting: API_BASE_URL_SETTING,
      credentialSetting,
    });
  }

  // 4. The default: the local database. `setting` is null when nothing named it, which
  //    is the case a `doctor` line has to be able to report as "defaulted".
  const setting = databaseKeys[0] ?? null;
  const databasePath = setting === null ? defaultDatabasePath() : (configured(env, setting) as string);
  return Object.freeze({ store: "sqlite" as const, databasePath, setting });
}

/**
 * Build the store this process's configuration means.
 *
 * NO `env` PARAMETER, unlike `planEmailStore`, and the asymmetry is deliberate. This
 * function acquires PROCESS-WIDE resources — `getDatabase()` memoises one SQLite
 * connection per process — so a caller who handed in a different environment object
 * would get a store bound to whatever the process had already opened, with diagnostics
 * naming the file it asked for. A store whose `detail` points at the wrong database is
 * worse than no diagnostics at all, so the affordance is not offered: `planEmailStore`
 * is the injectable, side-effect-light half, and this half reads the real environment.
 *
 * The `switch` is exhaustive over `StorePlan`, so a third store arm would fail to
 * compile here — which is the intended structural limit, not an oversight.
 */
export function createConfiguredEmailStore(): EmailStore {
  const plan = planEmailStore(process.env);
  switch (plan.store) {
    case "sqlite":
      // `plan.databasePath` is NOT passed through. `getDatabase()` applies the same
      // precedence this resolution reads, and it additionally canonicalises the value and
      // memoises the connection — so the path it reports is the one the store's rows
      // actually come from, and `plan.databasePath` (what the operator wrote) is not.
      return createSqliteEmailStore({ detail: `SQLite at ${getDatabasePath()}` });
    case "api":
      // `detail` is left to the store, which strips userinfo, query and fragment out of
      // the origin before it is printed. The credential is read here and never stored
      // anywhere this module can print it.
      return createHttpEmailStore({
        baseUrl: plan.baseUrl,
        credential: configured(process.env, plan.credentialSetting) as string,
      });
  }
}
