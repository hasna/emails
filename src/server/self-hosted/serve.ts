// Bootstraps and runs the Emails self-hosted service (Bun.serve).
//
// Wires the product-owned Postgres pool, the API-key verifier
// (@hasna/contracts/auth), the migration set, and the request handler together.

import { verifyApiKey, ApiKeyStore, type ApiKeyVerifier } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { getSelfHostedPool, requireSigningSecret, SELF_HOSTED_APP } from "./env.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { EmailsSelfHostedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { buildSelfHostedSender } from "./sender.js";
import { AuthStore } from "./auth/store.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { buildAuthMailerConfig } from "./auth/mailer.js";

/** Assemble the service dependencies from the environment. */
export function buildSelfHostedService(version: string): SelfHostedServiceDeps {
  const { client } = getSelfHostedPool();
  const signingSecret = requireSigningSecret();
  const keys = new ApiKeyStore(client);
  const verifier: ApiKeyVerifier = verifyApiKey({
    app: SELF_HOSTED_APP,
    signingSecret,
    isRevoked: keys.statusChecker(),
    audit: (e) => {
      // Structured, secret-free audit line (kid + outcome only).
      console.log(
        `[api-auth] ${e.outcome} app=${e.app} kid=${e.kid ?? "-"} reason=${e.reason ?? "-"} ` +
          `${e.method ?? "-"} ${e.path ?? "-"} status=${e.status}`,
      );
    },
  });
  return {
    client,
    store: new EmailsSelfHostedStore(client),
    verifier,
    sender: buildSelfHostedSender(),
    migrations: emailsSelfHostedMigrations(),
    version,
    // ---- multi-tenancy + auth (WI-2) ----
    // AuthStore needs the pool client (transactions for signup/invite/reset).
    authStore: new AuthStore(client),
    keyStore: keys,
    signingSecret,
    rateLimiter: new RateLimiter(),
    mailer: buildAuthMailerConfig(),
    env: process.env,
  };
}

/**
 * Boot-time defense so Row-Level Security (migration 0013) can NEVER be silently
 * off: `FORCE ROW LEVEL SECURITY` is a no-op for a role that bypasses RLS (a
 * superuser or a `BYPASSRLS` role), which would leave Layer 2 disabled while the
 * server believes the backstop exists. If the serving role can bypass RLS we
 * refuse to start, loudly, rather than serve with the backstop disabled.
 *
 * The serving role `emails_app` is deliberately `NOSUPERUSER NOBYPASSRLS` (and
 * owns the tables, so FORCE subjects it to its own policies). This asserts that
 * invariant at every boot. A role can always read its own `pg_roles` row.
 */
export async function assertServingRoleCannotBypassRls(client: TypedQueryClient): Promise<void> {
  const row = await client.get<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  if (!row) {
    throw new Error(
      "RLS boot assertion failed: could not read the serving DB role's attributes (pg_roles).",
    );
  }
  if (row.rolsuper || row.rolbypassrls) {
    throw new Error(
      `RLS boot assertion FAILED: serving DB role '${row.rolname}' can bypass Row-Level Security ` +
        `(rolsuper=${row.rolsuper}, rolbypassrls=${row.rolbypassrls}). FORCE ROW LEVEL SECURITY is a ` +
        `silent no-op for such a role, so tenant isolation Layer 2 would be OFF. Refusing to start. ` +
        `Point EMAILS_DATABASE_URL at a NOSUPERUSER, NOBYPASSRLS serving role (design §6 Layer 2 / H1).`,
    );
  }
}

/** Start the self-hosted HTTP server. */
export async function startSelfHostedServer(
  version: string,
  port = Number(process.env["PORT"] ?? "8080") || 8080,
  hostname = process.env["HOST"] ?? "0.0.0.0",
): Promise<{ port: number; stop: () => void }> {
  const deps = buildSelfHostedService(version);
  // Defense-in-depth: never serve with the RLS backstop silently disabled.
  await assertServingRoleCannotBypassRls(deps.client);

  const server = Bun.serve({
    port,
    hostname,
    fetch: async (req) => {
      const response = await handleSelfHostedRequest(deps, req);
      if (response) return response;
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  console.log(`Emails self-hosted service listening on http://${hostname}:${server.port}`);
  console.log(`  probes: GET /health  GET /ready  GET /version`);
  console.log(`  api:    /v1/domains  /v1/addresses  /v1/messages  /v1/messages/send  (x-api-key required)`);
  console.log(`  alias:  /api/v1/* is accepted as an alias for /v1/* (native client compatibility)`);

  return {
    port: server.port ?? port,
    stop: () => server.stop(true),
  };
}
