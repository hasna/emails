import { resolveSelfHostedConfig } from "../db/self-hosted-store.js";
import { EMAILS_CLIENT_ENV_SECRET_ENV, loadEmailsClientEnvSecret } from "./client-env.js";
export { EMAILS_CLIENT_ENV_SECRET_ENV } from "./client-env.js";

// This client is self-hosted-ONLY. There is a single mode; the local/SQLite
// runtime has been removed. `EmailsMode` remains a named type so the many
// call sites that reference it keep compiling.
export type EmailsMode = "self_hosted";
export type EmailsModeLabel = "Self-hosted";

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
    `This client is self-hosted-only: set ${EMAILS_MODE_ENV}=self_hosted with ` +
    "EMAILS_SELF_HOSTED_URL and EMAILS_SELF_HOSTED_API_KEY (or configure EMAILS_CLIENT_ENV_SECRET).";
}

/**
 * Reject legacy hosted/cloud environment variables. Kept for callers that guard
 * their entrypoints (src/storage.ts, the self-hosted server env). Legacy hosted
 * URL/key variables are intentionally ignored (never select or redirect a run).
 */
export function assertNoLegacyHostedEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  _options: { allowHostedApiEnvWithExplicitSelfHosted?: boolean } = {},
): void {
  for (const key of LEGACY_MODE_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) throw new Error(migrationGuidance(key, value));
  }
  for (const key of LEGACY_HOSTED_ENV_KEYS) {
    void env[key];
  }
}

export function labelForEmailsMode(_mode: EmailsMode): EmailsModeLabel {
  return "Self-hosted";
}

export function normalizeEmailsMode(value: string): EmailsMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "self_hosted") return "self_hosted";
  throw new Error(
    `Unsupported ${EMAILS_MODE_ENV} '${value}'. This client is self-hosted-only; ` +
      "the only supported mode is self_hosted.",
  );
}

/**
 * Resolve the client mode. The client is self-hosted-ONLY, so this validates
 * that a complete self-hosted endpoint (EMAILS_SELF_HOSTED_URL +
 * EMAILS_SELF_HOSTED_API_KEY, or EMAILS_CLIENT_ENV_SECRET) is configured and
 * throws a loud, actionable error otherwise.
 */
export function resolveEmailsMode(env: NodeJS.ProcessEnv = process.env): EmailsModeResolution {
  const clientEnvSecret = loadEmailsClientEnvSecret(env);
  assertNoLegacyHostedEnvironment(env);
  const modeRaw = env[EMAILS_MODE_ENV]?.trim() ?? env[HASNA_EMAILS_MODE_ENV]?.trim();
  if (modeRaw) normalizeEmailsMode(modeRaw);
  // Mandatory configuration. Throws with EMAILS_CLIENT_ENV_SECRET / URL+KEY guidance.
  resolveSelfHostedConfig(env);
  return {
    mode: "self_hosted",
    label: "Self-hosted",
    source: {
      kind: "env",
      name: clientEnvSecret.ready ? EMAILS_CLIENT_ENV_SECRET_ENV : EMAILS_MODE_ENV,
      value: clientEnvSecret.ready ? clientEnvSecret.secretPath : (modeRaw ?? "self_hosted"),
    },
    warning: null,
  };
}

export function getEmailsMode(): EmailsMode {
  return resolveEmailsMode().mode;
}
