// WHICH INTERNAL STORAGE `emails-serve` USES, decided from operator STORAGE
// configuration and from nothing else.
//
// The server has exactly two internal stores and there will only ever be two: the local
// SQLite file behind the dashboard, or operator-owned PostgreSQL behind the `/v1` API.
// So the only question this module answers is "which one did the operator configure?",
// and the answer follows from one setting:
//
//   | EMAILS_DATABASE_URL | result                                        |
//   |---------------------|-----------------------------------------------|
//   | unset / blank       | sqlite — the SQLite dashboard on loopback     |
//   | set                 | postgresql — the operator `/v1` API           |
//
// WHAT THIS REPLACES, and why the replacement is a deletion rather than a rename. Until
// this module existed the same choice was made by a DEPLOYMENT WORD, `EMAILS_MODE`, whose
// two values selected an entire product variant. That word had to go for a reason no
// amount of documentation fixes: it meant OPPOSITE things in the two shipped binaries. In
// the `emails` CLI `self_hosted` means "become an HTTP client of somebody else's server";
// in `emails-serve` it meant "become a PostgreSQL server". One variable, two contradictory
// semantics, and a deployment that set it for one binary silently reconfigured the other.
// Storage configuration cannot contradict itself that way: a database URL is either
// present or it is not, and whichever binary reads it reaches the same conclusion.
//
// THE WORD IS REFUSED, NOT IGNORED, and that is the whole point of the module rather than
// a nicety. Deleting a variable's last reader and leaving the variable accepted removes
// the word and keeps the hole: the next operator sets `EMAILS_MODE=local` on a PostgreSQL
// deployment, nothing reads it, nothing complains, and they believe they have configured
// something. Worse, the values that were always wrong — `cloud`, `remote`, `hybrid` — would
// become silently harmless instead of loudly refused. So any presence of the retired
// setting is a boot error that names the setting to delete AND the setting to use.
//
// NO VALUE IS EVER QUOTED BACK. `EMAILS_DATABASE_URL` routinely carries a password in its
// userinfo, and a boot failure is the single most likely thing to be captured in a
// CloudWatch log group, a CI transcript or a pasted terminal buffer. The refusal names
// KEYS only, which is the same rule `StoreConfigurationError` follows on the client side.

/** The setting that names operator-owned PostgreSQL. Presence selects the `/v1` API. */
export const SERVER_DATABASE_URL_SETTING = "EMAILS_DATABASE_URL";

/**
 * The retired deployment-word settings, in every spelling that ever selected a server
 * variant. Both are refused: `HASNA_`-prefixed and bare, because a deployment that
 * exports one and not the other must not get a different answer from a bare typo.
 */
export const RETIRED_SERVER_MODE_SETTINGS = Object.freeze(["EMAILS_MODE", "HASNA_EMAILS_MODE"] as const);

/**
 * The server's internal storage. A two-arm union on purpose — an exhaustive `switch` over
 * it means a THIRD arm would be a `tsc` error, which is what pins "exactly two stores"
 * structurally rather than by comment.
 */
export type ServerStorageBackend = "sqlite" | "postgresql";

/**
 * A server configuration that cannot be resolved to exactly one internal store.
 *
 * A distinct class rather than a bare `Error` so a boot path can tell "the operator has to
 * change a setting" from a genuine fault, and `settings` carries the KEYS at fault — never
 * their values, because one of them is a database URL with a password in it.
 */
export class ServerStorageConfigurationError extends Error {
  readonly settings: readonly string[];

  constructor(message: string, settings: readonly string[]) {
    super(message);
    this.name = "ServerStorageConfigurationError";
    this.settings = Object.freeze([...settings]);
  }
}

/**
 * A setting is configured when it is present and not blank.
 *
 * Blank counts as absent because the deploy path writes `EMAILS_DATABASE_URL` from a
 * secret reference, and an unresolved secret arrives as the empty string rather than
 * missing. Treating `""` as "PostgreSQL is configured" would take the API arm with no
 * connection string and fail several layers later, in the connection pool's words instead
 * of in the operator's.
 */
function configured(env: NodeJS.ProcessEnv, key: string): string | null {
  const trimmed = env[key]?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

/**
 * Decide which internal store this server configuration means, or throw.
 *
 * Pure: it reads the environment it is handed and touches nothing else, so a boot path
 * and a test reach the same answer from the same input.
 */
export function resolveServerStorageBackend(
  env: NodeJS.ProcessEnv = process.env,
): ServerStorageBackend {
  const retired = RETIRED_SERVER_MODE_SETTINGS.filter((key) => configured(env, key) !== null);
  if (retired.length > 0) {
    throw new ServerStorageConfigurationError(
      `${retired.join(" and ")} ${retired.length > 1 ? "are" : "is"} set. The deployment-mode ` +
        "switch has been removed: this server no longer has a mode, it has an internal store, " +
        `and the store follows ${SERVER_DATABASE_URL_SETTING} alone. DELETE ` +
        `${retired.join(" and ")} — set ${SERVER_DATABASE_URL_SETTING} to run the operator /v1 ` +
        "API against your own PostgreSQL, or leave it unset to run the local SQLite dashboard. " +
        "No cloud, remote, hybrid, or self-hosted value is accepted, because there is no longer " +
        "anything for a value to select.",
      retired,
    );
  }

  return configured(env, SERVER_DATABASE_URL_SETTING) === null ? "sqlite" : "postgresql";
}
