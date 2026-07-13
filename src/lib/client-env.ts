import { spawnSync } from "node:child_process";

export const EMAILS_CLIENT_ENV_SECRET_ENV = "EMAILS_CLIENT_ENV_SECRET";

const CLIENT_ENV_KEYS = [
  "EMAILS_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
] as const;

const MODE_ENV_KEYS = ["EMAILS_MODE", "HASNA_EMAILS_MODE"] as const;

const SECRETS_COMMAND_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "HASNA_HOME",
  "CODEWITH_HOME",
] as const;

export interface EmailsClientEnvSecretLoad {
  secretPath: string | null;
  loaded: boolean;
  ready: boolean;
}

const loadedClientEnvSecrets = new WeakMap<NodeJS.ProcessEnv, string>();

function parseClientEnvSecret(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    }
  } catch {
    // Fall through to dotenv-style parsing.
  }

  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1];
    if (!key) continue;
    let value = (match[2] ?? "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function hasCompleteCanonicalClientEnv(env: NodeJS.ProcessEnv): boolean {
  return CLIENT_ENV_KEYS.every((key) => Boolean(env[key]?.trim()));
}

function hasExplicitLocalMode(env: NodeJS.ProcessEnv): boolean {
  return MODE_ENV_KEYS.some((key) => env[key]?.trim().toLowerCase() === "local");
}

// The `secrets` CLI needs its OWN backend configuration to resolve a vault path.
// In a cloud-vault setup that means HASNA_SECRETS_STORAGE_MODE / HASNA_SECRETS_API_URL
// / HASNA_SECRETS_API_KEY; other backends use similarly-prefixed vars. Stripping
// these silently downgrades `secrets get` to the empty local store and the pointer
// fails to load ("Not found"). Pass through the secrets-tooling config namespaces
// (and only those) so the loader works regardless of the configured backend.
const SECRETS_COMMAND_ENV_PREFIXES = ["HASNA_SECRETS_", "SECRETS_", "HASNA_VAULT_"] as const;

function secretsCommandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of SECRETS_COMMAND_ENV_ALLOWLIST) {
    const value = env[key] ?? (key === "PATH" ? process.env["PATH"] : undefined);
    if (value !== undefined) childEnv[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SECRETS_COMMAND_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      childEnv[key] = value;
    }
  }
  return childEnv;
}

/**
 * Load the canonical client-env secret pointer into canonical process env.
 *
 * The pointer is a non-secret vault path. Loaded values are never logged here;
 * callers should report only presence/shape and continue using the canonical
 * EMAILS_* names.
 */
export function loadEmailsClientEnvSecret(env: NodeJS.ProcessEnv = process.env): EmailsClientEnvSecretLoad {
  const secretPath = env[EMAILS_CLIENT_ENV_SECRET_ENV]?.trim() ?? null;
  if (!secretPath) return { secretPath: null, loaded: false, ready: false };
  if (hasExplicitLocalMode(env)) return { secretPath, loaded: false, ready: false };

  if (hasCompleteCanonicalClientEnv(env)) {
    return {
      secretPath,
      loaded: false,
      ready: loadedClientEnvSecrets.get(env) === secretPath,
    };
  }

  const result = spawnSync("secrets", ["get", secretPath], {
    encoding: "utf8",
    env: secretsCommandEnv(env),
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`${EMAILS_CLIENT_ENV_SECRET_ENV} failed to load '${secretPath}' from the secrets vault: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${EMAILS_CLIENT_ENV_SECRET_ENV} failed to load '${secretPath}' from the secrets vault.`);
  }

  const loaded = parseClientEnvSecret(result.stdout ?? "");
  const missing: string[] = [];
  for (const key of CLIENT_ENV_KEYS) {
    const value = loaded[key]?.trim();
    if (value) env[key] = value;
    else if (!env[key]?.trim()) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `${EMAILS_CLIENT_ENV_SECRET_ENV} '${secretPath}' must contain ${CLIENT_ENV_KEYS.join(", ")}; missing ${missing.join(", ")}.`,
    );
  }

  loadedClientEnvSecrets.set(env, secretPath);
  return { secretPath, loaded: true, ready: true };
}
