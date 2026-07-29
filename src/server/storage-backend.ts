// WHICH INTERNAL STORE `emails-serve` USES, decided from operator STORAGE configuration
// and from nothing else.
//
// The server has exactly two internal stores and there will only ever be two: the local
// SQLite file behind the dashboard, or operator-owned PostgreSQL behind the `/v1` API. So
// the only question this module answers is "which one did the operator configure?", and the
// answer follows from one setting:
//
//   | EMAILS_DATABASE_URL | result                                        |
//   |---------------------|-----------------------------------------------|
//   | unset / blank       | sqlite — the SQLite dashboard on loopback     |
//   | set                 | postgresql — the operator `/v1` API           |
//
// WHAT THIS REPLACES, and why the replacement is a deletion rather than a rename. Until
// this module existed the same choice was made by a DEPLOYMENT WORD whose two values
// selected an entire product variant. That word had to stop deciding for a reason no amount
// of documentation fixes: it meant OPPOSITE things in the two shipped binaries. In the
// `emails` CLI, `self_hosted` means "become an HTTP client of somebody else's server"; here
// it meant "become a PostgreSQL server". One variable, two contradictory semantics, and a
// deployment that set it for one binary silently reconfigured the other. Storage
// configuration cannot contradict itself that way: a database URL is either present or it is
// not, and whichever binary reads it reaches the same conclusion.
//
// NO VALUE IS EVER QUOTED BACK. `EMAILS_DATABASE_URL` routinely carries a password in its
// userinfo, and a boot failure is the single most likely thing to be captured in a log
// group, a CI transcript or a pasted terminal buffer. Messages name KEYS only, which is the
// same rule `StoreConfigurationError` follows on the client side.

/** The setting that names operator-owned PostgreSQL. Presence selects the `/v1` API. */
export const SERVER_DATABASE_URL_SETTING = "EMAILS_DATABASE_URL";

/**
 * The retired deployment-word settings, in both spellings that ever selected a server
 * variant. Named here once; every other site in the tree reads them by role rather than
 * spelling them again.
 */
export const RETIRED_SERVER_MODE_SETTINGS = Object.freeze(["EMAILS_MODE", "HASNA_EMAILS_MODE"] as const);

/**
 * The two values the retired setting could historically hold on a server, mapped to the
 * store each one used to select.
 *
 * This map is the whole reason the retired setting is not simply refused, and the reason is
 * measured rather than assumed. THE CLIENT HALF OF THIS AXIS IS STILL LIVE — sixteen `emails`
 * CLI families still route on the word — so a single shell legitimately exports it for the
 * client and then runs the server from the same place. Three independent instances of exactly
 * that shape exist in this repository today: the hermetic test harness exports the local value
 * for every test and several of those tests spawn `emails-serve` with the inherited
 * environment; the container runtime smoke did the same; and `docs/SELF_HOSTED_RUNTIME.md`
 * shows a client block and a service block an operator would paste into one shell. A hard
 * refusal would break all three, which is not "failing closed" — it is failing on a
 * configuration that works, to punish vocabulary.
 *
 * So a value that AGREES with the storage configuration is tolerated and announced; a value
 * that CONTRADICTS it is refused; and a value that was never valid here is refused. When the
 * client families land and nothing needs the word, the tolerance goes with them.
 */
const RETIRED_VALUE_BACKENDS: ReadonlyMap<string, ServerStorageBackend> = new Map([
  ["local", "sqlite"],
  ["self_hosted", "postgresql"],
]);

/**
 * The server's internal store. A two-arm union on purpose — an exhaustive `switch` over it
 * means a THIRD arm would be a `tsc` error, which is what pins "exactly two stores"
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
 * Blank counts as absent because the deploy path writes `EMAILS_DATABASE_URL` from a secret
 * reference, and an unresolved secret arrives as the empty string rather than missing.
 * Treating `""` as "PostgreSQL is configured" would take the API arm with no connection
 * string and fail several layers later, in the connection pool's words instead of the
 * operator's.
 */
function configured(env: NodeJS.ProcessEnv, key: string): string | null {
  const trimmed = env[key]?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

/** The one-line notice emitted when a retired setting is present but no longer decides. */
export function retiredSettingNotice(settings: readonly string[]): string {
  return `${settings.join(" and ")} no longer selects anything in emails-serve and is IGNORED: `
    + `this server's internal store follows ${SERVER_DATABASE_URL_SETTING} alone. Delete `
    + `${settings.join(" and ")} — set ${SERVER_DATABASE_URL_SETTING} to serve the operator /v1 `
    + "API from your own PostgreSQL, or leave it unset to serve the local SQLite dashboard.";
}

/**
 * Emitted once per process, so a long-lived service does not repeat the notice on every
 * pool acquisition while a one-shot command still gets it.
 */
let noticeEmitted = false;

/** Test seam: forget that the notice was emitted. Never called by product code. */
export function resetRetiredSettingNoticeForTests(): void {
  noticeEmitted = false;
}

/**
 * Decide which internal store this server configuration means, or throw.
 *
 * Pure apart from the one-shot stderr notice: it reads the environment it is handed and
 * touches nothing else, so a boot path and a test reach the same answer from the same input.
 */
export function resolveServerStorageBackend(
  env: NodeJS.ProcessEnv = process.env,
  options: { announce?: (message: string) => void } = {},
): ServerStorageBackend {
  const backend: ServerStorageBackend =
    configured(env, SERVER_DATABASE_URL_SETTING) === null ? "sqlite" : "postgresql";

  const present = RETIRED_SERVER_MODE_SETTINGS.filter((key) => configured(env, key) !== null);
  if (present.length === 0) return backend;

  for (const key of present) {
    const value = (configured(env, key) as string).toLowerCase();
    const historical = RETIRED_VALUE_BACKENDS.get(value);
    if (historical === undefined) {
      throw new ServerStorageConfigurationError(
        `${key} holds a value that never selected anything in emails-serve. The deployment-mode `
          + "switch has been removed — there is no cloud, remote, hybrid, or hyphenated variant, and "
          + `there is no longer anything for a value to select. Delete ${key}: this server's internal `
          + `store follows ${SERVER_DATABASE_URL_SETTING} alone, set to serve the operator /v1 API `
          + "from your own PostgreSQL and unset to serve the local SQLite dashboard.",
        [key, SERVER_DATABASE_URL_SETTING],
      );
    }
    if (historical !== backend) {
      // THE CONTRADICTION, which is refused rather than resolved by precedence. A winner picked
      // for the operator is a deployment switch with the switch position inferred instead of
      // declared, and the failure mode is mail read from or written to the store they did not
      // mean. The only honest answer is to name both settings and stop.
      throw new ServerStorageConfigurationError(
        `${key} asks for the ${historical} store while ${SERVER_DATABASE_URL_SETTING} `
          + `${backend === "postgresql" ? "configures PostgreSQL" : "is unset, which means SQLite"} — `
          + "two answers to where this server keeps its mail and no way to tell which one you meant. "
          + `${key} is retired and decides nothing, so DELETE IT and let `
          + `${SERVER_DATABASE_URL_SETTING} say which store you want. There is deliberately no `
          + "precedence rule.",
        [key, SERVER_DATABASE_URL_SETTING],
      );
    }
  }

  // Present, historically valid, and in agreement: it decides nothing, and saying so is the
  // difference between removing the word and removing the word's last reader. An unannounced
  // ignore is the same hole with a smaller symptom — the next operator sets it, nothing reads
  // it, nothing complains, and they believe they configured something.
  if (!noticeEmitted) {
    noticeEmitted = true;
    const announce = options.announce ?? ((message: string) => console.error(message));
    announce(retiredSettingNotice(present));
  }
  return backend;
}
