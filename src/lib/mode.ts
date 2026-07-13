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

const LOCAL_CONFIG_MODE_KEYS = ["mailery_mode", "mode", "storage_mode", EMAILS_MODE_CONFIG_KEY] as const;

function migrationGuidance(source: string, value?: string): string {
  const detail = value ? ` value '${value}'` : "";
  return `${source}${detail} belongs to the removed hosted/legacy runtime. ` +
    `Use ${EMAILS_MODE_ENV}=local, or set ${EMAILS_MODE_ENV}=self_hosted with ` +
    "EMAILS_SELF_HOSTED_URL and EMAILS_SELF_HOSTED_API_KEY. No cloud, remote, or hybrid alias is supported.";
}

function selfHostedConfigGuidance(source: string, value: string): string {
  return `${source} value '${value}' cannot select self_hosted from local config. ` +
    "Self-hosted clients must be API-only and configured through EMAILS_CLIENT_ENV_SECRET or " +
    `${EMAILS_MODE_ENV}/${HASNA_EMAILS_MODE_ENV} with EMAILS_SELF_HOSTED_URL and EMAILS_SELF_HOSTED_API_KEY. ` +
    `Remove the local config value, or set ${EMAILS_MODE_ENV}=local for explicit local config.`;
}

export function assertLocalConfigModeValueAllowed(key: string, value: unknown): void {
  if (!LOCAL_CONFIG_MODE_KEYS.includes(key as typeof LOCAL_CONFIG_MODE_KEYS[number])) return;
  if (typeof value !== "string" || !value.trim()) return;
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === "local") return;
  if (normalized === "self_hosted") {
    throw new Error(selfHostedConfigGuidance(`config key '${key}'`, trimmed));
  }
  throw new Error(migrationGuidance(`config key '${key}'`, trimmed));
}

export function assertLocalConfigAccessAllowed(command: string, env: NodeJS.ProcessEnv = process.env): void {
  const resolution = resolveEmailsMode(env);
  if (resolution.mode !== "self_hosted") return;
  throw new Error(
    `\`${command}\` reads or writes local config and is disabled in self_hosted API-only mode. ` +
      "Use EMAILS_CLIENT_ENV_SECRET or canonical EMAILS_MODE/HASNA_EMAILS_MODE with " +
      "EMAILS_SELF_HOSTED_URL and EMAILS_SELF_HOSTED_API_KEY for self_hosted clients. " +
      "Set EMAILS_MODE=local only when intentionally managing explicit local config.",
  );
}

export function assertNoLegacyHostedEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  _options: { allowHostedApiEnvWithExplicitSelfHosted?: boolean } = {},
): void {
  for (const key of LEGACY_MODE_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) throw new Error(migrationGuidance(key, value));
  }
  // Legacy hosted URL/key variables are intentionally ignored. They must not
  // select self_hosted, redirect a local run, or poison hermetic tests when
  // present in a developer shell. Only canonical EMAILS_* client env controls
  // the current local/self_hosted runtime.
  for (const key of LEGACY_HOSTED_ENV_KEYS) {
    void env[key];
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

export function resolveEmailsMode(env: NodeJS.ProcessEnv = process.env): EmailsModeResolution {
  const clientEnvSecret = loadEmailsClientEnvSecret(env);
  assertNoLegacyHostedEnvironment(env, { allowHostedApiEnvWithExplicitSelfHosted: true });

  for (const name of EMAILS_MODE_ENV_KEYS) {
    const value = env[name]?.trim();
    if (!value) continue;
    const mode = normalizeEmailsMode(value);
    return {
      mode,
      label: labelForEmailsMode(mode),
      source: {
        kind: "env",
        name: clientEnvSecret.ready ? EMAILS_CLIENT_ENV_SECRET_ENV : name,
        value: clientEnvSecret.ready ? clientEnvSecret.secretPath : value,
      },
      warning: null,
    };
  }

  const config = loadConfig();
  let localConfigSource: EmailsModeSource | null = null;
  for (const key of ["mailery_mode", "mode", "storage_mode"] as const) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) {
      const trimmed = value.trim();
      if (trimmed.toLowerCase() === "local") {
        localConfigSource ??= { kind: "config", name: key, value: trimmed };
        continue;
      }
      if (trimmed.toLowerCase() === "self_hosted") {
        throw new Error(selfHostedConfigGuidance(`config key '${key}'`, trimmed));
      }
      throw new Error(migrationGuidance(`config key '${key}'`, trimmed));
    }
  }
  const configured = config[EMAILS_MODE_CONFIG_KEY];
  if (typeof configured === "string" && configured.trim()) {
    const value = configured.trim();
    const normalized = value.toLowerCase();
    if (normalized === "self_hosted") {
      throw new Error(selfHostedConfigGuidance(`config key '${EMAILS_MODE_CONFIG_KEY}'`, value));
    }
    if (FORBIDDEN_MODE_VALUES.has(normalized)) {
      throw new Error(migrationGuidance(`config key '${EMAILS_MODE_CONFIG_KEY}'`, value));
    }
    if (normalized !== "local") {
      throw new Error(`Unknown Emails mode '${value}' in config key '${EMAILS_MODE_CONFIG_KEY}'. Use local config only for local mode.`);
    }
    return {
      mode: "local",
      label: "Local",
      source: { kind: "config", name: EMAILS_MODE_CONFIG_KEY, value },
      warning: null,
    };
  }
  if (localConfigSource) {
    return {
      mode: "local",
      label: "Local",
      source: localConfigSource,
      warning: null,
    };
  }

  return {
    mode: "local",
    label: "Local",
    source: { kind: "default", name: null, value: null },
    warning: null,
  };
}

export function getEmailsMode(): EmailsMode {
  return resolveEmailsMode().mode;
}
