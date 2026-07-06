// Bootstraps and runs the Mailery self_hosted cloud service (Bun.serve).
//
// Wires the vendored storage-kit Postgres pool, the API-key verifier
// (@hasna/contracts/auth), the migration set, and the request handler together.

import { verifyApiKey, ApiKeyStore, type ApiKeyVerifier } from "@hasna/contracts/auth";
import { getCloudPool, requireSigningSecret, CLOUD_APP } from "./env.js";
import { maileryCloudMigrations } from "./migrations.js";
import { MaileryCloudStore } from "./store.js";
import { handleCloudRequest, type CloudServiceDeps } from "./service.js";

/** Assemble the service dependencies from the environment. */
export function buildCloudService(version: string): CloudServiceDeps {
  const { client } = getCloudPool();
  const signingSecret = requireSigningSecret();
  const keys = new ApiKeyStore(client);
  const verifier: ApiKeyVerifier = verifyApiKey({
    app: CLOUD_APP,
    signingSecret,
    isRevoked: keys.isRevoked,
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
    store: new MaileryCloudStore(client),
    verifier,
    migrations: maileryCloudMigrations(),
    version,
  };
}

/** Start the cloud HTTP server. Binds 0.0.0.0 by default (behind the ALB). */
export async function startCloudServer(
  version: string,
  port = Number(process.env["PORT"] ?? "8080") || 8080,
  hostname = process.env["HOST"] ?? "0.0.0.0",
): Promise<{ port: number; stop: () => void }> {
  const deps = buildCloudService(version);

  const server = Bun.serve({
    port,
    hostname,
    fetch: async (req) => {
      const response = await handleCloudRequest(deps, req);
      if (response) return response;
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  console.log(`Mailery cloud service (self_hosted, PURE REMOTE) listening on http://${hostname}:${server.port}`);
  console.log(`  probes: GET /health  GET /ready  GET /version`);
  console.log(`  api:    /v1/domains  /v1/addresses  /v1/messages  (x-api-key required)`);

  return {
    port: server.port ?? port,
    stop: () => server.stop(true),
  };
}
