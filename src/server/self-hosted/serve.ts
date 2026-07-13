// Bootstraps and runs the Emails self-hosted service (Bun.serve).
//
// Wires the product-owned Postgres pool, the API-key verifier
// (@hasna/contracts/auth), the migration set, and the request handler together.

import { verifyApiKey, ApiKeyStore, type ApiKeyVerifier } from "@hasna/contracts/auth";
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

/** Start the self-hosted HTTP server. */
export async function startSelfHostedServer(
  version: string,
  port = Number(process.env["PORT"] ?? "8080") || 8080,
  hostname = process.env["HOST"] ?? "0.0.0.0",
): Promise<{ port: number; stop: () => void }> {
  const deps = buildSelfHostedService(version);

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

  return {
    port: server.port ?? port,
    stop: () => server.stop(true),
  };
}
