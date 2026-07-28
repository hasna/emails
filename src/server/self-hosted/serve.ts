// Bootstraps and runs the Emails self-hosted service (Bun.serve).
//
// Wires the product-owned Postgres pool, the API-key verifier
// (@hasna/contracts/auth), the migration set, and the request handler together.

import { ApiKeyStore, type ApiKeyVerifier } from "@hasna/contracts/auth";
import { assertServingRoleCannotBypassRls } from "./rls-guard.js";
import { getSelfHostedPool, requireSigningSecret, SELF_HOSTED_APP, SELF_HOSTED_APP_ALIASES } from "./env.js";
import { verifyApiKeyWithAliases } from "./api-key-verifier.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { EmailsSelfHostedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { buildSelfHostedSender } from "./sender.js";
import { AuthStore } from "./auth/store.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { buildAuthMailerConfig } from "./auth/mailer.js";
import { assertAllowedEmailDomainsConfigured } from "./auth/allowed-email.js";
import { buildIdpAuthenticatorFromEnv } from "./auth/idp-token.js";

/** Assemble the service dependencies from the environment. */
export function buildSelfHostedService(version: string): SelfHostedServiceDeps {
  const { client } = getSelfHostedPool();
  const signingSecret = requireSigningSecret();
  // Fail closed at BOOT, before any request can reach the auth gates, and BEFORE
  // any pool/sender/verifier is built: neither the signup/login/invite allowlist
  // nor the auth sender identity has a default. An unconfigured deployment would
  // otherwise reject its own operators with a deliberately opaque 403 that looks
  // like a broken login. Both are resolved here, together, so an operator missing
  // both does not need two boot cycles to learn the second variable's name.
  assertAllowedEmailDomainsConfigured();
  const mailer = buildAuthMailerConfig();
  const keys = new ApiKeyStore(client);
  // Accept the canonical "emails" app slug AND every back-compat alias so
  // keys minted while the unreleased "mailery" rename was deployed keep
  // authenticating (see env.ts).
  const verifier: ApiKeyVerifier = verifyApiKeyWithAliases(
    {
      signingSecret,
      isRevoked: keys.statusChecker(),
      audit: (e) => {
        // Structured, secret-free audit line (kid + outcome only).
        console.log(
          `[api-auth] ${e.outcome} app=${e.app} kid=${e.kid ?? "-"} reason=${e.reason ?? "-"} ` +
            `${e.method ?? "-"} ${e.path ?? "-"} status=${e.status}`,
        );
      },
    },
    [SELF_HOSTED_APP, ...SELF_HOSTED_APP_ALIASES],
  );
  // Idp-token credential class (ADR-0001 Phase 1): built only when the
  // operator configures the IdP's JWKS URL; otherwise the class is refused with
  // a typed error (fail closed). An invalid URL throws here, at boot, loudly.
  const idpAuthenticator = buildIdpAuthenticatorFromEnv(
    process.env,
    [SELF_HOSTED_APP, ...SELF_HOSTED_APP_ALIASES],
    (event) => {
      // Secret-free JWKS observability (host + kids only).
      console.log(
        `[idp-jwks] ${event.type} host=${event.urlHost}` +
          (event.kids ? ` kids=${event.kids.join(",")}` : "") +
          (event.error ? ` error=${event.error}` : ""),
      );
    },
  );
  console.log(
    `[emails-self-hosted] idp auth ${idpAuthenticator ? `jwks=${new URL(idpAuthenticator.jwksUrl).host}` : "disabled (no JWKS configured; idp tokens refused)"}`,
  );
  const sender = buildSelfHostedSender();
  // Secret-free boot line: WHICH identity outbound mail is signed with. Without
  // it, "the SES credentials are configured" was unverifiable from the running
  // service — the 2026-07-25 sends went out under the deployment role while an
  // operator believed a configured provider was in use.
  console.log(
    `[emails-self-hosted] outbound provider=${sender.provider} credentials=${sender.credentialSource ?? "unknown"}`,
  );
  return {
    client,
    store: new EmailsSelfHostedStore(client),
    verifier,
    sender,
    migrations: emailsSelfHostedMigrations(),
    version,
    // ---- multi-tenancy + auth (WI-2) ----
    // AuthStore needs the pool client (transactions for signup/invite/reset).
    authStore: new AuthStore(client),
    keyStore: keys,
    signingSecret,
    rateLimiter: new RateLimiter(),
    mailer,
    env: process.env,
    idpAuthenticator,
    // Structured, secret-free idp audit line (sub/jti/kid + outcome only).
    idpAudit: (e) => {
      console.log(
        `[idp-auth] ${e.outcome} sub=${e.sub ?? "-"} jti=${e.jti ?? "-"} kid=${e.kid ?? "-"} ` +
          `reason=${e.reason ?? "-"} ${e.method ?? "-"} ${e.path ?? "-"} status=${e.status}`,
      );
    },
  };
}

// The RLS boot guard now lives in a light standalone module so the headless
// ingest worker can reuse it without importing the request-server graph. Kept
// re-exported here for existing importers (e.g. rls.integration.test.ts).
export { assertServingRoleCannotBypassRls };

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
    fetch: async (req, bunServer) => {
      // The socket peer address is the only client identity a request cannot
      // forge; the auth rate limits are anchored on it (see auth/client-ip.ts).
      const response = await handleSelfHostedRequest(deps, req, {
        socketAddress: bunServer.requestIP(req)?.address ?? null,
      });
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
