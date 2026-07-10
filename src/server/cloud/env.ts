// Environment bootstrap for the Emails self_hosted service.
//
// In `self_hosted` mode the serve process reads AND writes the shared Postgres
// directly — there is no sync engine or local cache.
//
// The deploy platform (hasna-app Terraform module) can inject the DSN and the
// API-key signing material under generic names (DATABASE_URL /
// API_KEY_SIGNING_SECRET). The vendored storage kit and @hasna/contracts/auth
// resolve app-scoped keys (HASNA_MAILERY_DATABASE_URL /
// HASNA_MAILERY_API_SIGNING_KEY). `normalizeCloudEnv()` bridges the two so the
// service works no matter which convention the environment uses.

import { createCloudPoolFromEnv, normalizeStorageMode, type CloudPoolFromEnv } from "../../generated/storage-kit/index.js";

/** Storage/auth app slug for env-key resolution (HASNA_MAILERY_*). */
export const CLOUD_APP = "mailery";

const SIGNING_ENV = "HASNA_MAILERY_API_SIGNING_KEY";
const SHARED_SIGNING_ENV = "HASNA_API_SIGNING_KEY";
const APP_DSN_ENV = "HASNA_MAILERY_DATABASE_URL";
const MODE_ENV = "HASNA_MAILERY_STORAGE_MODE";

/**
 * Fill the canonical HASNA_MAILERY_* keys from the generic platform-injected
 * env vars when they are absent, and default the storage mode to `self_hosted`
 * once a DSN is present. Idempotent; never overwrites an explicit value.
 */
export function normalizeCloudEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (!env[APP_DSN_ENV] && env["DATABASE_URL"]) {
    env[APP_DSN_ENV] = env["DATABASE_URL"];
  }
  if (!env[SIGNING_ENV] && !env[SHARED_SIGNING_ENV] && env["API_KEY_SIGNING_SECRET"]) {
    env[SIGNING_ENV] = env["API_KEY_SIGNING_SECRET"];
  }
  // A DSN is only meaningful in cloud mode; default it so operators don't have
  // to set both the URL and the mode.
  if (env[APP_DSN_ENV] && !env[MODE_ENV]) {
    env[MODE_ENV] = "self_hosted";
  }
}

/**
 * True when the service should run as the self_hosted API (Postgres) as opposed
 * to the local SQLite dashboard. self_hosted mode requires a database URL.
 */
export function isCloudMode(env: NodeJS.ProcessEnv = process.env): boolean {
  normalizeCloudEnv(env);
  const rawMode = (env[MODE_ENV] ?? "").trim();
  if (!rawMode) return false;
  const { mode } = normalizeStorageMode(rawMode);
  if (mode === "local") return false;
  if (!env[APP_DSN_ENV]) {
    throw new Error(`${CLOUD_APP} self_hosted mode requires ${APP_DSN_ENV} (or DATABASE_URL).`);
  }
  return true;
}

/** Resolve the HMAC signing secret for API-key verification. Throws if unset. */
export function requireSigningSecret(env: NodeJS.ProcessEnv = process.env): string {
  normalizeCloudEnv(env);
  const secret = (env[SIGNING_ENV] ?? env[SHARED_SIGNING_ENV] ?? "").trim();
  if (!secret) {
    throw new Error(
      `Emails self_hosted service requires an API-key signing secret. Set ${SIGNING_ENV} ` +
        `(or the shared ${SHARED_SIGNING_ENV}).`,
    );
  }
  return secret;
}

let cachedPool: CloudPoolFromEnv | null = null;

/** Build (once) the self-hosted Postgres pool from the environment. */
export function getCloudPool(env: NodeJS.ProcessEnv = process.env): CloudPoolFromEnv {
  normalizeCloudEnv(env);
  if (!cachedPool) {
    cachedPool = createCloudPoolFromEnv(CLOUD_APP, {
      env,
      applicationName: "mailery-serve",
      max: Number(env["HASNA_MAILERY_PG_POOL_MAX"] ?? "10") || 10,
    });
  }
  return cachedPool;
}

/** Close the cached pool (tests / graceful shutdown). */
export async function closeCloudPool(): Promise<void> {
  if (cachedPool) {
    await cachedPool.client.close();
    cachedPool = null;
  }
}
