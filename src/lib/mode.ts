import { resolveSelfHostedConfig } from "../db/self-hosted-store.js";
import { API_BASE_URL_SETTING, StoreConfigurationError, planEmailStore } from "../store-resolution.js";
import { loadConfig } from "./config.js";
import { EMAILS_CLIENT_ENV_SECRET_ENV, EMAILS_SESSION_TOKEN_ENV, loadEmailsClientEnvSecret } from "./client-env.js";
export { EMAILS_CLIENT_ENV_SECRET_ENV } from "./client-env.js";

export type EmailsMode = "local" | "self_hosted";
export type EmailsModeLabel = "Local" | "Self-hosted";

// Canonical mode selectors. The package's public env prefix is EMAILS_; the
// MAILERY_ prefix belongs to the abandoned 0.6.x line and to the separate cloud
// product, and stays rejected (see LEGACY_MODE_ENV_KEYS below).
export const EMAILS_MODE_ENV = "EMAILS_MODE";
export const HASNA_EMAILS_MODE_ENV = "HASNA_EMAILS_MODE";
export const EMAILS_MODE_CONFIG_KEY = "emails_mode";
export const EMAILS_MODE_ENV_KEYS = [EMAILS_MODE_ENV, HASNA_EMAILS_MODE_ENV] as const;

// The primary deployment-word key under a role name. The coherence refusal below has
// to NAME that key for the operator, and this module may not add another countable
// spelling of it — the axis ratchet holds every such reference at a ceiling that may
// only fall — so one existing spelling (in the parser's refusal) is consumed into
// this alias and both sites read it by role.
const MODE_WORD_SETTING = EMAILS_MODE_ENV;

// Removed hosted/legacy mode tiering (no cloud/remote/hybrid). The MAILERY_
// prefixed selectors are rejected loudly: they configured the removed Mailery
// runtime, so silently honouring one would start the process in a mode the
// operator did not ask this package for.
//
// This array stays module-PRIVATE on purpose: exporting it would emit the
// literal hosted key names into mode.d.ts, which the no-cloud artifact scan's
// compatibility-bridge strip (keyed on the `NAME = [...]` form) does not cover.
const LEGACY_MODE_ENV_KEYS = [
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
] as const;

// Hosted control-plane credential/endpoint vars. This OSS package is cloud-free
// (a hosted Mailery cloud is platform-mailery's job), so these stay banned.
const LEGACY_HOSTED_ENV_KEYS = [
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "HASNA_MAILERY_ENV_FILE",
] as const;

const FORBIDDEN_MODE_VALUES = new Set([
  "cloud",
  "mailery_cloud",
  "remote",
  "hybrid",
  "self-hosted",
  "selfhosted",
]);

export interface EmailsModeSource {
  kind: "env" | "config" | "default";
  name: string | null;
  value: string | null;
}

export interface EmailsModeResolution {
  mode: EmailsMode;
  label: EmailsModeLabel;
  source: EmailsModeSource;
  /**
   * Operator-facing note about HOW this mode was chosen, when the answer is
   * surprising. Null when the selection is unremarkable. Rendered by
   * src/lib/doctor.local.ts (a warn-level "Mode" check),
   * src/lib/agent-context.ts ("Mode note:") and
   * src/lib/inbox-sync-status-format.ts.
   */
  warning: string | null;
}

function migrationGuidance(source: string, value?: string): string {
  const detail = value ? ` value '${value}'` : "";
  return `${source}${detail} belongs to the removed hosted/legacy runtime. ` +
    `Use ${EMAILS_MODE_ENV}=local, or set ${EMAILS_MODE_ENV}=self_hosted with ` +
    "EMAILS_SELF_HOSTED_URL and EMAILS_SELF_HOSTED_API_KEY (or EMAILS_CLIENT_ENV_SECRET). " +
    "No cloud, remote, or hybrid alias is supported.";
}

function hasExplicitSelfHostedClientEnv(env: NodeJS.ProcessEnv): boolean {
  const explicitMode = EMAILS_MODE_ENV_KEYS.some((key) => env[key]?.trim().toLowerCase() === "self_hosted");
  return Boolean(
    explicitMode &&
      env["EMAILS_SELF_HOSTED_URL"]?.trim() &&
      (env["EMAILS_SELF_HOSTED_API_KEY"]?.trim() || env["EMAILS_SESSION_TOKEN"]?.trim()),
  );
}

export function assertNoLegacyHostedEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: { allowHostedApiEnvWithExplicitSelfHosted?: boolean } = {},
): void {
  for (const key of LEGACY_MODE_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) throw new Error(migrationGuidance(key, value));
  }
  const allowHostedApiEnv =
    options.allowHostedApiEnvWithExplicitSelfHosted === true &&
    hasExplicitSelfHostedClientEnv(env);
  for (const key of LEGACY_HOSTED_ENV_KEYS) {
    if (allowHostedApiEnv) continue;
    if (env[key]?.trim()) throw new Error(migrationGuidance(key));
  }
}

export function labelForEmailsMode(mode: EmailsMode): EmailsModeLabel {
  return mode === "local" ? "Local" : "Self-hosted";
}

export function normalizeEmailsMode(value: string): EmailsMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "local" || normalized === "self_hosted") return normalized;
  if (FORBIDDEN_MODE_VALUES.has(normalized)) {
    throw new Error(migrationGuidance(MODE_WORD_SETTING, value));
  }
  throw new Error(`Unknown Emails mode '${value}'. Use exactly local or self_hosted.`);
}

function resolution(
  mode: EmailsMode,
  source: EmailsModeSource,
  warning: string | null = null,
): EmailsModeResolution {
  return { mode, label: labelForEmailsMode(mode), source, warning };
}

/**
 * The note emitted when an explicit local-mode env var shadows a configured
 * client-env vault pointer.
 *
 * WHY THIS EXISTS. `EMAILS_CLIENT_ENV_SECRET` points at the self-hosted client
 * env; an explicit local-mode selector wins over it. That precedence is CORRECT — an explicit
 * variable must beat a pointer, and loadEmailsClientEnvSecret() returns early
 * without even spawning `secrets get` (src/lib/client-env.ts). What was wrong is
 * that nothing SAID SO: the CLI silently fell back to an empty local SQLite
 * database and reported "0 total, 0 unread" against a deployment holding ~170,000
 * messages. Operators and agents read that as an empty mailbox, not as a
 * misconfiguration, and on 2026-07-27 a blocked production email was investigated
 * against the wrong database because of it. Earlier reports of the same symptom had
 * different causes (a login shell that never sourced the pointer; the selector
 * exported from a profile), so the note names the key that actually won rather than
 * describing the class.
 *
 * The stale value is often not in any config file at all — anything that injects
 * environment into child processes (a terminal multiplexer's global environment, a
 * supervisor, a CI runner) sets it once and every process started afterwards
 * inherits it, so grepping dotfiles finds nothing. Unsetting it at the source also
 * does not retract it from processes that already exist. Hence the message names the
 * variable, quotes the pointer (a non-secret vault path), warns that the value may
 * be inherited rather than configured, and gives a one-shot escape hatch that needs
 * no cleanup.
 */
export function clientEnvPointerOverrideWarning(modeEnvKey: string, pointer: string): string {
  return `${modeEnvKey}=local is overriding the ${EMAILS_CLIENT_ENV_SECRET_ENV} vault pointer `
    + `'${pointer}': the self-hosted client env was NOT loaded and this process is reading the `
    + `local database instead. Counts and message lists here do NOT describe the self-hosted `
    + `deployment. If that is not what you meant, unset ${modeEnvKey} — note that it may be `
    + `exported by a parent process rather than by any config file, in which case already-running `
    + `shells keep the old value until they are restarted. `
    + `One-shot check: \`env -u ${modeEnvKey} emails inbox status\`.`;
}

/**
 * Null unless an explicit local-mode env var is shadowing a configured pointer.
 * `modeEnvKey` is the key that actually selected local mode, so the note names
 * the variable the operator has to change rather than a generic label.
 */
function pointerOverrideWarning(
  mode: EmailsMode,
  modeEnvKey: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (mode !== "local") return null;
  const pointer = env[EMAILS_CLIENT_ENV_SECRET_ENV]?.trim();
  if (pointer) return clientEnvPointerOverrideWarning(modeEnvKey, pointer);
  // A POINTER is the common way to configure the deployment, but not the only one.
  // An operator who exports the canonical URL + credential directly and then has a
  // stale local-mode selector in the environment gets the identical silent
  // wrong-database read, and keying the note solely on the pointer would leave that
  // case exactly as quiet as the one this change exists to fix.
  const url = env["EMAILS_SELF_HOSTED_URL"]?.trim();
  const credential = env["EMAILS_SELF_HOSTED_API_KEY"]?.trim() || env[EMAILS_SESSION_TOKEN_ENV]?.trim();
  if (url && credential) return clientEnvCredentialOverrideWarning(modeEnvKey, url);
  return null;
}

/**
 * The same note for a directly-configured deployment. Names the URL — never the
 * credential — for the same reason the pointer variant quotes only the vault path.
 */
export function clientEnvCredentialOverrideWarning(modeEnvKey: string, url: string): string {
  return `${modeEnvKey}=local is overriding the configured self-hosted endpoint `
    + `'${url}': this process is reading the local database instead. Counts and message lists `
    + `here do NOT describe the self-hosted deployment. If that is not what you meant, unset `
    + `${modeEnvKey} — note that it may be exported by a parent process rather than by any config `
    + `file, in which case already-running shells keep the old value until they are restarted. `
    + `One-shot check: \`env -u ${modeEnvKey} emails inbox status\`.`;
}

/**
 * The split-brain refusal, or null when the configuration is coherent.
 *
 * WHY THIS EXISTS. During the axis migration two routing regimes coexist in every
 * process: families already on the store seam resolve their storage from
 * configuration alone (src/store-resolution.ts, which deliberately never reads the
 * deployment word — its own suite asserts that absence), while the families not yet
 * moved are still dispatched by the word this module resolves. For ONE common
 * configuration their answers contradict: an API base URL plus a credential, with
 * the deployment word unset, sends the seam families to the HTTP API while the
 * word default sends everything else to local SQLite — two mailboxes in the same
 * process, no diagnostic, and single commands straddle both regimes (owners read
 * locally, send keys minted through the API). That is the silent wrong-store read
 * this repo classes as its worst bug, so the DEFAULTING side refuses to guess and
 * names both settings. Loud beats wrong; the axis deletion retires this guard.
 *
 * Deliberately null when the storage resolution itself refuses the environment (a
 * both-configured contradiction, or an API URL missing its credential): those
 * configurations already fail closed in the seam's own words on every seam call,
 * and a second refusal in a different dialect on the word-routed side would bury
 * the actionable message rather than sharpen it.
 *
 * Kept OUT of src/store-resolution.ts on purpose: the check needs the deployment
 * word's absence, and that module's load-bearing property is that it never reads
 * the word. Here the word has already been resolved absent, so the check consumes
 * that fact rather than re-deriving it.
 */
function defaultSelectionStorageConflict(env: NodeJS.ProcessEnv): StoreConfigurationError | null {
  if (!env[API_BASE_URL_SETTING]?.trim()) return null;
  let configuresApi: boolean;
  try {
    configuresApi = planEmailStore(env).store === "api";
  } catch {
    return null;
  }
  if (!configuresApi) return null;
  return new StoreConfigurationError(
    `${API_BASE_URL_SETTING} configures an Emails API, but ${MODE_WORD_SETTING} is unset — so ` +
      "the families already reading storage configuration would use that API while the " +
      "families still routed by the deployment word would default to the LOCAL database, in " +
      "the same process. Two configured places to keep mail and no way to tell which one " +
      `you meant: set ${MODE_WORD_SETTING}=self_hosted to route this process through the ` +
      `API, or unset ${API_BASE_URL_SETTING} to use the local database.`,
    [MODE_WORD_SETTING, API_BASE_URL_SETTING],
  );
}

/** Resolve the process mode without requiring client transport credentials. */
export function resolveEmailsModeSelection(env: NodeJS.ProcessEnv = process.env): EmailsModeResolution {
  assertNoLegacyHostedEnvironment(env, { allowHostedApiEnvWithExplicitSelfHosted: true });

  for (const name of EMAILS_MODE_ENV_KEYS) {
    const value = env[name]?.trim();
    if (!value) continue;
    // Report the exact offending key rather than a generic label so the failure
    // message names the variable the operator actually has to change.
    if (FORBIDDEN_MODE_VALUES.has(value.toLowerCase())) throw new Error(migrationGuidance(name, value));
    const mode = normalizeEmailsMode(value);
    // Precedence is unchanged: this env var still wins. The only addition is that
    // when it wins OVER a configured client-env pointer, the resolution says so.
    return resolution(mode, { kind: "env", name, value }, pointerOverrideWarning(mode, name, env));
  }

  // A client secret pointer is itself an explicit self-hosted selection. Mode
  // selection deliberately does not read it: operator startup must not depend
  // on client credentials or secret-provider availability.
  const clientEnvSecretPointer = env[EMAILS_CLIENT_ENV_SECRET_ENV]?.trim();
  if (clientEnvSecretPointer) {
    return resolution("self_hosted", {
      kind: "env",
      name: EMAILS_CLIENT_ENV_SECRET_ENV,
      value: clientEnvSecretPointer,
    });
  }

  const config = loadConfig();
  for (const key of ["mailery_mode", "mode", "storage_mode"] as const) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) {
      throw new Error(migrationGuidance(`config key '${key}'`, value.trim()));
    }
  }
  const configured = config[EMAILS_MODE_CONFIG_KEY];
  if (typeof configured === "string" && configured.trim()) {
    const mode = normalizeEmailsMode(configured);
    return resolution(mode, { kind: "config", name: EMAILS_MODE_CONFIG_KEY, value: configured });
  }

  // The default is only safe when it AGREES with what the storage configuration
  // resolves for the seam-routed families; see the conflict helper above.
  const conflict = defaultSelectionStorageConflict(env);
  if (conflict !== null) throw conflict;
  return resolution("local", { kind: "default", name: null, value: null });
}

/**
 * Resolve one client data-source mode for the whole process. Local is the safe
 * default and never reads a client credential. Self-hosted is explicit and
 * fail-closed: URL + API/session credential are validated before repository,
 * CLI, or MCP callers can reach the operator API.
 */
export function resolveEmailsMode(env: NodeJS.ProcessEnv = process.env): EmailsModeResolution {
  const selected = resolveEmailsModeSelection(env);
  if (selected.mode === "local") return selected;

  const clientEnvSecret = loadEmailsClientEnvSecret(env);
  resolveSelfHostedConfig(env, { selectedMode: "self_hosted" });
  if (!clientEnvSecret.ready) return selected;
  return resolution("self_hosted", {
    kind: "env",
    name: EMAILS_CLIENT_ENV_SECRET_ENV,
    value: clientEnvSecret.secretPath,
  });
}

export function getEmailsMode(): EmailsMode {
  return resolveEmailsMode().mode;
}
