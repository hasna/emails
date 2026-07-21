import { createPgPool, createQueryClient, type PoolQueryClient } from "../../storage-kit/index.js";
import { assertNoLegacyHostedEnvironment } from "../../lib/mode.js";

// API-key app slug. The canonical slug moved "emails" -> "mailery" (brand
// rename). Keys already issued under "emails" keep working: the verifier accepts
// both (see SELF_HOSTED_APP_ALIASES + serve.ts).
export const SELF_HOSTED_APP = "mailery";
export const SELF_HOSTED_APP_ALIASES = ["emails"] as const;
export const SELF_HOSTED_MODE_ENV = "EMAILS_MODE";
export const SELF_HOSTED_DATABASE_ENV = "EMAILS_DATABASE_URL";
export const SELF_HOSTED_SIGNING_ENV = "EMAILS_API_SIGNING_KEY";

// Removed hosted-runtime vars kept rejected. The plain MODE keys (MAILERY_MODE /
// HASNA_MAILERY_MODE) are NO LONGER here — they are canonical mode selectors now.
const REMOVED_ENV_KEYS = [
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_DATABASE_URL",
  "HASNA_MAILERY_API_SIGNING_KEY",
] as const;

export interface SelfHostedPool {
  client: PoolQueryClient;
  connectionSource: string;
}

export function assertSelfHostedEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  assertNoLegacyHostedEnvironment(env);
  for (const key of REMOVED_ENV_KEYS) {
    if (env[key]?.trim()) {
      throw new Error(
        `${key} belongs to the removed Mailery/cloud runtime. ` +
          `Use EMAILS_MODE=self_hosted, ${SELF_HOSTED_DATABASE_ENV}, and ${SELF_HOSTED_SIGNING_ENV}.`,
      );
    }
  }
  const mode = env[SELF_HOSTED_MODE_ENV]?.trim();
  if (mode !== "self_hosted") {
    throw new Error(
      `Emails self-hosted service requires ${SELF_HOSTED_MODE_ENV}=self_hosted exactly; ` +
        "cloud, remote, and hybrid aliases are not supported.",
    );
  }
  if (!env[SELF_HOSTED_DATABASE_ENV]?.trim()) {
    throw new Error(`Emails self-hosted service requires ${SELF_HOSTED_DATABASE_ENV}.`);
  }
}

export function isSelfHostedMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env[SELF_HOSTED_MODE_ENV]?.trim();
  if (!mode || mode === "local") return false;
  if (mode !== "self_hosted") {
    throw new Error(
      `Unsupported Emails mode '${mode}'. Use exactly local or self_hosted; ` +
        "cloud, remote, and hybrid aliases were removed.",
    );
  }
  return true;
}

export function requireSigningSecret(env: NodeJS.ProcessEnv = process.env): string {
  assertSelfHostedEnvironment(env);
  const secret = env[SELF_HOSTED_SIGNING_ENV]?.trim();
  if (!secret) throw new Error(`Emails self-hosted service requires ${SELF_HOSTED_SIGNING_ENV}.`);
  if (secret.length < 32) throw new Error(`${SELF_HOSTED_SIGNING_ENV} must contain at least 32 characters.`);
  return secret;
}

let cachedPool: SelfHostedPool | null = null;

export function getSelfHostedPool(env: NodeJS.ProcessEnv = process.env): SelfHostedPool {
  assertSelfHostedEnvironment(env);
  if (!cachedPool) {
    const connectionString = env[SELF_HOSTED_DATABASE_ENV]!.trim();
    const pool = createPgPool({
      connectionString,
      env,
      applicationName: "emails-serve",
      max: Number(env["EMAILS_PG_POOL_MAX"] ?? "10") || 10,
    });
    cachedPool = { client: createQueryClient(pool), connectionSource: SELF_HOSTED_DATABASE_ENV };
  }
  return cachedPool;
}

export async function closeSelfHostedPool(): Promise<void> {
  if (cachedPool) {
    await cachedPool.client.close();
    cachedPool = null;
  }
}
