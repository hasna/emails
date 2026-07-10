// Environment bootstrap for the Emails self-hosted service.
//
// In self-hosted service mode the serve process reads and writes the shared
// cloud/Postgres database directly.
//
// The deploy platform (hasna-app Terraform module) can inject the DSN and the
// API-key signing material under generic names (DATABASE_URL /
// API_KEY_SIGNING_SECRET). The vendored storage kit and @hasna/contracts/auth
// resolve app-scoped keys (HASNA_EMAILS_DATABASE_URL /
// HASNA_EMAILS_API_SIGNING_KEY). `normalizeCloudEnv()` bridges generic env
// names into the canonical Emails-specific variables.

import { createCloudPoolFromEnv, type CloudPoolFromEnv } from "../../generated/storage-kit/index.js";

/** Storage/auth app slug for env-key resolution (HASNA_EMAILS_*). */
export const CLOUD_APP = "emails";

const SIGNING_ENV = "HASNA_EMAILS_API_SIGNING_KEY";
const SHARED_SIGNING_ENV = "HASNA_API_SIGNING_KEY";
const APP_DSN_ENV = "HASNA_EMAILS_DATABASE_URL";
const MODE_ENV = "HASNA_EMAILS_STORAGE_MODE";

/**
 * Fill the canonical HASNA_EMAILS_* keys from generic platform-injected env vars
 * when they are absent, and default the service storage seam once a DSN is
 * present. Idempotent; never overwrites an explicit value.
 */
export function normalizeCloudEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (!env[APP_DSN_ENV]) {
    env[APP_DSN_ENV] = env["DATABASE_URL"];
  }
  if (!env[SIGNING_ENV] && !env[SHARED_SIGNING_ENV]) {
    env[SIGNING_ENV] = env["API_KEY_SIGNING_SECRET"];
  }
  // A DSN is only meaningful for the self-hosted service; default the service
  // storage seam so operators don't have to set both the URL and the mode.
  if (env[APP_DSN_ENV] && !env[MODE_ENV]) {
    env[MODE_ENV] = "cloud";
  }
}

/**
 * True when the service should run as the self-hosted API instead of the local
 * SQLite dashboard. The service mode requires a database URL.
 */
export function isCloudMode(env: NodeJS.ProcessEnv = process.env): boolean {
  normalizeCloudEnv(env);
  const mode = (env[MODE_ENV] ?? "").trim().toLowerCase();
  const cloudMode = mode === "cloud" || mode === "self_hosted";
  return cloudMode && Boolean(env[APP_DSN_ENV]);
}

/** Resolve the HMAC signing secret for API-key verification. Throws if unset. */
export function requireSigningSecret(env: NodeJS.ProcessEnv = process.env): string {
  normalizeCloudEnv(env);
  const secret = (env[SIGNING_ENV] ?? env[SHARED_SIGNING_ENV] ?? "").trim();
  if (!secret) {
    throw new Error(
      `Emails self-hosted service requires an API-key signing secret. Set ${SIGNING_ENV} ` +
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
      applicationName: "emails-serve",
      max: Number(env["HASNA_EMAILS_PG_POOL_MAX"] ?? "10") || 10,
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
