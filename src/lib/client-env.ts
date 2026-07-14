import { spawnSync } from "node:child_process";

export const EMAILS_CLIENT_ENV_SECRET_ENV = "EMAILS_CLIENT_ENV_SECRET";

/** The bearer credential a user session persists (see multi-tenancy design §7). */
export const EMAILS_SESSION_TOKEN_ENV = "EMAILS_SESSION_TOKEN";

// Structural keys the vault entry MUST carry (endpoint + mode). A credential is
// required too, but a session token OR the API key satisfies it — see
// CLIENT_ENV_CREDENTIAL_KEYS — so neither credential is individually mandatory.
const CLIENT_ENV_REQUIRED_KEYS = [
  "EMAILS_MODE",
  "EMAILS_SELF_HOSTED_URL",
] as const;

// At least one of these must be present. A session token (emss_…) is preferred
// over the operator API key by resolveSelfHostedConfig; an operator with only
// the API key keeps working unchanged.
const CLIENT_ENV_CREDENTIAL_KEYS = [
  "EMAILS_SELF_HOSTED_API_KEY",
  EMAILS_SESSION_TOKEN_ENV,
] as const;

// Every key the vault entry may carry (loaded into env whenever present).
const CLIENT_ENV_KEYS = [
  ...CLIENT_ENV_REQUIRED_KEYS,
  ...CLIENT_ENV_CREDENTIAL_KEYS,
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

function hasClientEnvCredential(env: NodeJS.ProcessEnv): boolean {
  return CLIENT_ENV_CREDENTIAL_KEYS.some((key) => Boolean(env[key]?.trim()));
}

function hasCompleteCanonicalClientEnv(env: NodeJS.ProcessEnv): boolean {
  return CLIENT_ENV_REQUIRED_KEYS.every((key) => Boolean(env[key]?.trim())) && hasClientEnvCredential(env);
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
  for (const key of CLIENT_ENV_KEYS) {
    const value = loaded[key]?.trim();
    if (value) env[key] = value;
  }
  const missing: string[] = [];
  for (const key of CLIENT_ENV_REQUIRED_KEYS) {
    if (!env[key]?.trim()) missing.push(key);
  }
  if (!hasClientEnvCredential(env)) missing.push(CLIENT_ENV_CREDENTIAL_KEYS.join(" or "));
  if (missing.length > 0) {
    throw new Error(
      `${EMAILS_CLIENT_ENV_SECRET_ENV} '${secretPath}' must contain ${CLIENT_ENV_REQUIRED_KEYS.join(", ")} ` +
        `and a credential (${CLIENT_ENV_CREDENTIAL_KEYS.join(" or ")}); missing ${missing.join(", ")}.`,
    );
  }

  loadedClientEnvSecrets.set(env, secretPath);
  return { secretPath, loaded: true, ready: true };
}

// ── session-token persistence (login/logout write the vault entry) ──────────
//
// A user session token is persisted so subsequent invocations authenticate as
// that user. It is written to BOTH the in-process env (so the current command is
// immediately authed) and — when the EMAILS_CLIENT_ENV_SECRET pointer is set —
// merged into that vault entry so it survives across processes. The token value
// is never logged or embedded in an error (only the failing subcommand name is).

export interface SessionTokenPersistResult {
  /** "vault" when the durable entry was updated; "process" when env-only. */
  scope: "vault" | "process";
  secretPath: string | null;
}

function runSecretsCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { status: number; stdout: string } {
  const result = spawnSync("secrets", args as string[], {
    encoding: "utf8",
    env: secretsCommandEnv(env),
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    // Never include argv (which may carry the token value) in the message.
    throw new Error(`secrets ${args[0]} failed: ${result.error.message}`);
  }
  return { status: result.status ?? 0, stdout: result.stdout ?? "" };
}

/** Read the current vault entry as a string map, or null if it cannot be read. */
function readClientEnvSecretMap(secretPath: string, env: NodeJS.ProcessEnv): Record<string, string> | null {
  const result = runSecretsCommand(["get", secretPath], env);
  if (result.status !== 0) return null;
  return parseClientEnvSecret(result.stdout ?? "");
}

function writeClientEnvSecretMap(secretPath: string, map: Record<string, string>, env: NodeJS.ProcessEnv): void {
  // The value carries secrets; it is passed as an argv arg to the `secrets` CLI
  // (its documented `set <key> <value>` interface) and is never logged here.
  const result = runSecretsCommand(["set", secretPath, JSON.stringify(map)], env);
  if (result.status !== 0) {
    throw new Error(`secrets set failed for the EMAILS_CLIENT_ENV_SECRET entry (exit ${result.status}).`);
  }
}

/**
 * Persist a user session token: always into the in-process env, and — when a
 * vault pointer is configured — durably into that entry. Callers must reset the
 * self-hosted config cache afterwards so the new credential takes effect.
 */
export function persistClientEnvSessionToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionTokenPersistResult {
  env[EMAILS_SESSION_TOKEN_ENV] = token;
  const secretPath = env[EMAILS_CLIENT_ENV_SECRET_ENV]?.trim();
  if (!secretPath) return { scope: "process", secretPath: null };
  const current = readClientEnvSecretMap(secretPath, env);
  if (!current) return { scope: "process", secretPath };
  current[EMAILS_SESSION_TOKEN_ENV] = token;
  writeClientEnvSecretMap(secretPath, current, env);
  return { scope: "vault", secretPath };
}

/** Remove the persisted session token from env and (if present) the vault entry. */
export function clearClientEnvSessionToken(env: NodeJS.ProcessEnv = process.env): SessionTokenPersistResult {
  delete env[EMAILS_SESSION_TOKEN_ENV];
  const secretPath = env[EMAILS_CLIENT_ENV_SECRET_ENV]?.trim();
  if (!secretPath) return { scope: "process", secretPath: null };
  const current = readClientEnvSecretMap(secretPath, env);
  if (current && EMAILS_SESSION_TOKEN_ENV in current) {
    delete current[EMAILS_SESSION_TOKEN_ENV];
    writeClientEnvSecretMap(secretPath, current, env);
    return { scope: "vault", secretPath };
  }
  return { scope: "process", secretPath };
}
