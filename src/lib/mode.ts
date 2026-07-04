import { loadConfig, saveConfig } from "./config.js";

export type MaileryMode = "local" | "cloud";
export type MaileryModeLabel = "Local" | "Mailery Cloud";

export const MAILERY_MODE_ENV = "MAILERY_MODE";
export const HASNA_EMAILS_MODE_ENV = "HASNA_EMAILS_MODE";
export const LEGACY_STORAGE_MODE_ENV = "HASNA_EMAILS_STORAGE_MODE";
export const LEGACY_STORAGE_MODE_FALLBACK_ENV = "EMAILS_STORAGE_MODE";
export const MAILERY_MODE_CONFIG_KEY = "mailery_mode";
export const LEGACY_MODE_CONFIG_KEYS = ["mode", "storage_mode"] as const;
export const MAILERY_MODE_ENV_KEYS = [
  MAILERY_MODE_ENV,
  HASNA_EMAILS_MODE_ENV,
] as const;

export interface MaileryModeSource {
  kind: "env" | "config" | "default";
  name: string | null;
  value: string | null;
}

export interface MaileryModeResolution {
  mode: MaileryMode;
  label: MaileryModeLabel;
  source: MaileryModeSource;
  deprecatedAlias: string | null;
  migratedConfig: boolean;
  warning: string | null;
}

export interface ResolveMaileryModeOptions {
  migrateConfig?: boolean;
}

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function labelForMaileryMode(mode: MaileryMode): MaileryModeLabel {
  switch (mode) {
    case "local":
      return "Local";
    case "cloud":
      return "Mailery Cloud";
  }
}

// There are exactly two modes: `local` (SQLite) and `cloud` (API client — a
// self-hosted server is just `cloud` pointed at a private base URL). The legacy
// `self_hosted` / `remote` / `hybrid` values are accepted as deprecated aliases
// for `cloud`.
export function normalizeMaileryMode(value: string): { mode: MaileryMode; deprecatedAlias: string | null } {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "local") return { mode: "local", deprecatedAlias: null };
  if (normalized === "cloud" || normalized === "mailery_cloud") return { mode: "cloud", deprecatedAlias: null };
  if (normalized === "self_hosted" || normalized === "remote" || normalized === "hybrid") {
    return { mode: "cloud", deprecatedAlias: normalized };
  }
  throw new Error(`Unknown Mailery mode: ${value}. Use local or cloud.`);
}

function findConfiguredMode(config: Record<string, unknown>): { key: string; value: string } | null {
  const keys = [MAILERY_MODE_CONFIG_KEY, ...LEGACY_MODE_CONFIG_KEYS];
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) return { key, value: value.trim() };
  }
  return null;
}

function warningFor(source: MaileryModeSource, deprecatedAlias: string | null, migratedConfig: boolean, mode: MaileryMode): string | null {
  if (!deprecatedAlias && !migratedConfig) return null;
  const oldValue = deprecatedAlias ?? source.value ?? "";
  if (source.kind === "config") {
    if (migratedConfig && deprecatedAlias) {
      return `Migrated deprecated Mailery mode '${oldValue}' from config to '${MAILERY_MODE_CONFIG_KEY}=${mode}'.`;
    }
    if (migratedConfig) {
      return `Migrated deprecated Mailery mode config key '${source.name}' to '${MAILERY_MODE_CONFIG_KEY}=${mode}'.`;
    }
    return `Deprecated Mailery mode '${oldValue}' in config is treated as '${mode}'.`;
  }
  if (source.kind === "env") {
    return `Deprecated Mailery mode '${oldValue}' from ${source.name} is treated as '${mode}'. Set ${MAILERY_MODE_ENV}=${mode} instead.`;
  }
  return null;
}

function defaultMode(): MaileryMode {
  return "local";
}

export function resolveMaileryMode(opts: ResolveMaileryModeOptions = {}): MaileryModeResolution {
  for (const name of MAILERY_MODE_ENV_KEYS) {
    const value = readEnv(name);
    if (!value) continue;
    const normalized = normalizeMaileryMode(value);
    const source = { kind: "env" as const, name, value };
    return {
      ...normalized,
      label: labelForMaileryMode(normalized.mode),
      source,
      migratedConfig: false,
      warning: warningFor(source, normalized.deprecatedAlias, false, normalized.mode),
    };
  }

  const config = loadConfig();
  const configured = findConfiguredMode(config);
  if (configured) {
    const normalized = normalizeMaileryMode(configured.value);
    let migratedConfig = false;
    if (opts.migrateConfig && (configured.key !== MAILERY_MODE_CONFIG_KEY || normalized.deprecatedAlias)) {
      const next = { ...config };
      next[MAILERY_MODE_CONFIG_KEY] = normalized.mode;
      for (const key of LEGACY_MODE_CONFIG_KEYS) delete next[key];
      saveConfig(next);
      migratedConfig = true;
    }
    const source = { kind: "config" as const, name: configured.key, value: configured.value };
    return {
      ...normalized,
      label: labelForMaileryMode(normalized.mode),
      source,
      migratedConfig,
      warning: warningFor(source, normalized.deprecatedAlias, migratedConfig, normalized.mode),
    };
  }

  const mode = defaultMode();
  return {
    mode,
    label: labelForMaileryMode(mode),
    source: { kind: "default", name: null, value: null },
    deprecatedAlias: null,
    migratedConfig: false,
    warning: null,
  };
}

export function getMaileryMode(): MaileryMode {
  return resolveMaileryMode().mode;
}
