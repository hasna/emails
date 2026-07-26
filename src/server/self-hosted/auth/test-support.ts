// Shared test fixtures for the multi-tenancy auth wiring.
//
// The self-hosted unit tests build a fake in-memory query client and drive
// `handleSelfHostedRequest`. After multi-tenancy, `resolveRequestContext` maps an
// API key -> tenant via `api_key_tenants`, so the fake client must answer that
// lookup. This helper wraps a fake client so the api-key path resolves to the
// default tenant, and assembles the auth-related deps (authStore/keyStore/
// signingSecret/rateLimiter/mailer) those tests do not otherwise care about.
//
// This is imported ONLY by *.test.ts files. It is deliberately small and pure.

import type { PoolQueryClient, TypedQueryClient } from "../../../storage-kit/index.js";
import { DEFAULT_TENANT_ID } from "../migrations.js";
import { EmailsSelfHostedStore } from "../store.js";
import { AuthStore } from "./store.js";
import { RateLimiter } from "./rate-limit.js";
import { buildAuthMailerConfig, type AuthMailerConfig } from "./mailer.js";
import { ALLOWED_EMAIL_DOMAINS_ENV } from "./allowed-email.js";
import type { SelfHostedKeyStore } from "../keys.js";

/**
 * A tenant-scoped store bound to the default tenant whose `forTenant()` returns
 * ITSELF. Handlers call `deps.store.forTenant(ctx.tenantId)`, so this lets a unit
 * test both (a) drive the real scoped methods against a fake client and (b) patch
 * a method (`d.store.listMessages = …`) and have the handler observe the patch —
 * without threading the tenant through every fake-client query. It is typed as the
 * base store because that is what SelfHostedServiceDeps.store expects; the extra
 * data methods are only reached at runtime (tests are not type-checked).
 */
export function selfScopedStore(client: TypedQueryClient): EmailsSelfHostedStore {
  const scoped = new EmailsSelfHostedStore(client, { allowUnsafeTestTransactions: true }).forTenant(DEFAULT_TENANT_ID);
  (scoped as unknown as { forTenant: () => unknown }).forTenant = () => scoped;
  return scoped as unknown as EmailsSelfHostedStore;
}

/** A key store stub — the data-route tests never mint/list/revoke keys. */
export const STUB_KEY_STORE: SelfHostedKeyStore = {
  insertMinted: async () => {},
  list: async () => [],
  revoke: async () => false,
};

/**
 * Wrap a fake client so the `api_key_tenants` resolution returns the default
 * tenant (every other query delegates unchanged). Used to build the AuthStore for
 * unit tests that only exercise the API-key data path.
 */
export function withDefaultTenantResolution(client: TypedQueryClient): TypedQueryClient {
  return {
    ...client,
    async get<T extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      if (typeof sql === "string" && sql.includes("api_key_tenants")) {
        return { tenant_id: DEFAULT_TENANT_ID } as unknown as T;
      }
      return client.get<T>(sql, params);
    },
  };
}

// The service ships NO default sender identity (auth/mailer.ts) and NO default
// signup allowlist (auth/allowed-email.ts) — both are required operator config, so
// every fixture must declare them. RFC 2606 documentation domains are used so no
// real domain appears in the suite.

/** Fixture auth sender identity (`EMAILS_AUTH_FROM` in a real deployment). */
export const TEST_AUTH_FROM = "auth@example.com";

/** Fixture signup/login/invite allowlist covering every test address. */
export const TEST_ALLOWED_EMAIL_DOMAINS = "example.com";

/** `process.env` plus the auth configuration the service requires, `extra` last. */
export function testAuthEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, [ALLOWED_EMAIL_DOMAINS_ENV]: TEST_ALLOWED_EMAIL_DOMAINS, ...extra };
}

/** The mailer config a fixture deployment would build from `testAuthEnv()`. */
export function testAuthMailer(): AuthMailerConfig {
  return buildAuthMailerConfig({ EMAILS_AUTH_FROM: TEST_AUTH_FROM });
}

/** The multi-tenancy auth deps for a fake-client unit test. */
export function testAuthDeps(client: TypedQueryClient, signingSecret: string) {
  return {
    authStore: new AuthStore(withDefaultTenantResolution(client) as unknown as PoolQueryClient),
    keyStore: STUB_KEY_STORE,
    signingSecret,
    rateLimiter: new RateLimiter(),
    mailer: testAuthMailer(),
    env: testAuthEnv(),
  };
}
