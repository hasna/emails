import { resolveSelfHostedConfig } from "../db/self-hosted-store.js";
import { loadConfig } from "./config.js";
import { EMAILS_CLIENT_ENV_SECRET_ENV, loadEmailsClientEnvSecret } from "./client-env.js";
export { EMAILS_CLIENT_ENV_SECRET_ENV } from "./client-env.js";

export type EmailsMode = "local" | "self_hosted";
export type EmailsModeLabel = "Local" | "Self-hosted";

export const EMAILS_MODE_ENV = "EMAILS_MODE";
export const HASNA_EMAILS_MODE_ENV = "HASNA_EMAILS_MODE";
export const EMAILS_MODE_CONFIG_KEY = "emails_mode";
export const EMAILS_MODE_ENV_KEYS = [EMAILS_MODE_ENV, HASNA_EMAILS_MODE_ENV] as const;

const LEGACY_MODE_ENV_KEYS = [
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
] as const;

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

/**
 * Resolve one storage mode for the whole process. Local is the safe default and
 * never reads a client-env secret or self-hosted credential. Self-hosted mode is
 * explicit and fail-closed: selecting it validates URL + credential before any
 * caller can reach a repository.
 */
export function resolveEmailsMode(env: NodeJS.ProcessEnv = process.env): EmailsModeResolution {
  assertNoLegacyHostedEnvironment(env, { allowHostedApiEnvWithExplicitSelfHosted: true });

  for (const name of EMAILS_MODE_ENV_KEYS) {
    const value = env[name]?.trim();
    if (!value) continue;
    const mode = normalizeEmailsMode(value);
    if (mode === "local") return resolution(mode, { kind: "env", name, value });

    const clientEnvSecret = loadEmailsClientEnvSecret(env);
    resolveSelfHostedConfig(env);
    return resolution(mode, {
      kind: "env",
      name: clientEnvSecret.ready ? EMAILS_CLIENT_ENV_SECRET_ENV : name,
      value: clientEnvSecret.ready ? clientEnvSecret.secretPath : value,
    });
  }

  // A secret pointer is itself an explicit self-hosted selection. Expand it
  // only when local was not selected, then validate the resulting canonical env.
  if (env[EMAILS_CLIENT_ENV_SECRET_ENV]?.trim()) {
    const clientEnvSecret = loadEmailsClientEnvSecret(env);
    const mode = normalizeEmailsMode(env[EMAILS_MODE_ENV]?.trim() ?? "self_hosted");
    if (mode !== "self_hosted") {
      throw new Error(`${EMAILS_CLIENT_ENV_SECRET_ENV} may only configure ${EMAILS_MODE_ENV}=self_hosted.`);
    }
    resolveSelfHostedConfig(env);
    return resolution(mode, {
      kind: "env",
      name: EMAILS_CLIENT_ENV_SECRET_ENV,
      value: clientEnvSecret.secretPath,
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
    if (mode === "self_hosted") resolveSelfHostedConfig(env);
    return resolution(mode, { kind: "config", name: EMAILS_MODE_CONFIG_KEY, value: configured });
  }

  return resolution("local", { kind: "default", name: null, value: null });
}

export function getEmailsMode(): EmailsMode {
  return resolveEmailsMode().mode;
}
