import { resolveSelfHostedConfig } from "../db/self-hosted-store.js";
import { loadConfig } from "./config.js";
import { EMAILS_CLIENT_ENV_SECRET_ENV, loadEmailsClientEnvSecret } from "./client-env.js";
export { EMAILS_CLIENT_ENV_SECRET_ENV } from "./client-env.js";

export type EmailsMode = "local" | "self_hosted";
export type EmailsModeLabel = "Local" | "Self-hosted";

// Canonical mode selectors. The package's public prefix moved EMAILS_ -> MAILERY_
// (repo/brand rename to mailery). Both prefixes are accepted; MAILERY_ is
// canonical and wins when both are set (dual-read, prefer new). The EMAILS_
// names remain as back-compat aliases so existing installs keep working.
export const EMAILS_MODE_ENV = "EMAILS_MODE";
export const HASNA_EMAILS_MODE_ENV = "HASNA_EMAILS_MODE";
export const MAILERY_MODE_ENV = "MAILERY_MODE";
export const HASNA_MAILERY_MODE_ENV = "HASNA_MAILERY_MODE";
export const EMAILS_MODE_CONFIG_KEY = "emails_mode";
export const EMAILS_MODE_ENV_KEYS = [
  MAILERY_MODE_ENV,
  HASNA_MAILERY_MODE_ENV,
  EMAILS_MODE_ENV,
  HASNA_EMAILS_MODE_ENV,
] as const;

// Removed *storage-mode* tiering (no cloud/remote/hybrid). Both prefixes are
// rejected loudly. The plain MODE keys are deliberately NOT here: MAILERY_MODE /
// EMAILS_MODE are the supported selectors and only accept local|self_hosted
// (a cloud/remote/hybrid VALUE is still rejected by FORBIDDEN_MODE_VALUES).
//
// These arrays stay module-PRIVATE on purpose: exporting them would emit the
// literal hosted key names into mode.d.ts, which the no-cloud artifact scan's
// compatibility-bridge strip (keyed on the `NAME = [...]` form) does not cover.
// The env-compat shim consumes the derived Set below instead.
const LEGACY_MODE_ENV_KEYS = [
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
] as const;

// Hosted control-plane credential/endpoint vars. This OSS package is cloud-free
// (a hosted Mailery cloud is platform-mailery's job), so these stay banned — the
// MAILERY_* env compat shim never bridges them.
const LEGACY_HOSTED_ENV_KEYS = [
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "HASNA_MAILERY_ENV_FILE",
] as const;

// MAILERY_-prefixed env names the compat shim must NEVER mirror onto an EMAILS_
// alias (hosted control-plane creds + removed runtime knobs). Exported as an
// opaque ReadonlySet VALUE so the .d.ts carries a type, not the literals. The
// two HASNA_ self-hosted vars mirror env.ts REMOVED_ENV_KEYS (their canonical
// HASNA_ rename is intentionally deferred).
export const MAILERY_ENV_BRIDGE_DENYLIST: ReadonlySet<string> = new Set<string>([
  ...LEGACY_HOSTED_ENV_KEYS,
  ...LEGACY_MODE_ENV_KEYS,
  "HASNA_MAILERY_DATABASE_URL",
  "HASNA_MAILERY_API_SIGNING_KEY",
]);

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
  warning: null;
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
    throw new Error(migrationGuidance(EMAILS_MODE_ENV, value));
  }
  throw new Error(`Unknown Emails mode '${value}'. Use exactly local or self_hosted.`);
}

function resolution(mode: EmailsMode, source: EmailsModeSource): EmailsModeResolution {
  return { mode, label: labelForEmailsMode(mode), source, warning: null };
}

/** Resolve the process mode without requiring client transport credentials. */
export function resolveEmailsModeSelection(env: NodeJS.ProcessEnv = process.env): EmailsModeResolution {
  assertNoLegacyHostedEnvironment(env, { allowHostedApiEnvWithExplicitSelfHosted: true });

  for (const name of EMAILS_MODE_ENV_KEYS) {
    const value = env[name]?.trim();
    if (!value) continue;
    // Report the exact offending key (e.g. MAILERY_MODE=cloud) rather than a
    // generic label so the failure message is actionable.
    if (FORBIDDEN_MODE_VALUES.has(value.toLowerCase())) throw new Error(migrationGuidance(name, value));
    const mode = normalizeEmailsMode(value);
    return resolution(mode, { kind: "env", name, value });
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
