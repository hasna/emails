// Environment bootstrap for the Mailery self_hosted cloud service.
//
// Amendment A1 (PURE REMOTE): in `cloud` mode the serve process reads AND writes
// the shared cloud Postgres directly — there is no sync engine or local cache.
//
// The deploy platform (hasna-app Terraform module) can inject the DSN and the
// API-key signing material under generic names (DATABASE_URL /
// API_KEY_SIGNING_SECRET). The vendored storage kit and @hasna/contracts/auth
// resolve app-scoped keys (HASNA_MAILERY_DATABASE_URL /
// HASNA_MAILERY_API_SIGNING_KEY). `normalizeCloudEnv()` bridges the two so the
// service works no matter which convention the environment uses.

import { createCloudPoolFromEnv, type CloudPoolFromEnv } from "../../generated/storage-kit/index.js";

/** Storage/auth app slug for env-key resolution (HASNA_MAILERY_*). */
export const CLOUD_APP = "mailery";

const SIGNING_ENV = "HASNA_MAILERY_API_SIGNING_KEY";
const SHARED_SIGNING_ENV = "HASNA_API_SIGNING_KEY";
const APP_DSN_ENV = "HASNA_MAILERY_DATABASE_URL";
const MODE_ENV = "HASNA_MAILERY_STORAGE_MODE";

/**
 * Fill the canonical HASNA_MAILERY_* keys from the generic platform-injected
 * env vars when they are absent, and default the storage mode to `cloud` once a
 * DSN is present. Idempotent; never overwrites an explicit value.
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
    env[MODE_ENV] = "cloud";
  }
}

/**
 * True when the service should run as the PURE-REMOTE cloud API (Postgres) as
 * opposed to the local SQLite dashboard. Cloud mode requires a database URL.
 */
export function isCloudMode(env: NodeJS.ProcessEnv = process.env): boolean {
  normalizeCloudEnv(env);
  const mode = (env[MODE_ENV] ?? "").trim().toLowerCase();
  const cloudMode = mode === "cloud" || mode === "remote" || mode === "self_hosted" || mode === "hybrid";
  return cloudMode && Boolean(env[APP_DSN_ENV]);
}

/** Resolve the HMAC signing secret for API-key verification. Throws if unset. */
export function requireSigningSecret(env: NodeJS.ProcessEnv = process.env): string {
  normalizeCloudEnv(env);
  const secret = (env[SIGNING_ENV] ?? env[SHARED_SIGNING_ENV] ?? "").trim();
  if (!secret) {
    throw new Error(
      `Mailery cloud service requires an API-key signing secret. Set ${SIGNING_ENV} ` +
        `(or the shared ${SHARED_SIGNING_ENV}).`,
    );
  }
  return secret;
}

let cachedPool: CloudPoolFromEnv | null = null;

/** Build (once) the cloud Postgres pool from the environment. */
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
