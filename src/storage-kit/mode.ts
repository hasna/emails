// Emails-owned mode adapter for the product Postgres helpers.
// The product has exactly two modes and intentionally accepts no aliases.

export const STORAGE_MODES = ["local", "self_hosted"] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];
export type Env = Record<string, string | undefined>;

export interface StorageModeResolution {
  mode: StorageMode;
  source: string;
  databaseUrlPresent: boolean;
  databaseUrlSource: string | null;
}

export function normalizeStorageMode(value: string): StorageMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "local" || normalized === "self_hosted") return normalized;
  throw new Error(
    `Unknown Emails mode '${value}'. Use exactly local or self_hosted; ` +
      "cloud, remote, and hybrid aliases are not supported.",
  );
}

export function resolveStorageMode(_name: string, env: Env = process.env): StorageModeResolution {
  const raw = env["EMAILS_MODE"]?.trim() ?? env["HASNA_EMAILS_MODE"]?.trim();
  const mode = raw ? normalizeStorageMode(raw) : "local";
  const databaseUrlPresent = Boolean(env["EMAILS_DATABASE_URL"]?.trim());
  return {
    mode,
    source: raw ? (env["EMAILS_MODE"] ? "EMAILS_MODE" : "HASNA_EMAILS_MODE") : "default",
    databaseUrlPresent,
    databaseUrlSource: databaseUrlPresent ? "EMAILS_DATABASE_URL" : null,
  };
}

export function resolveDatabaseUrl(_name: string, env: Env = process.env): string | null {
  return env["EMAILS_DATABASE_URL"]?.trim() || null;
}
