import { healthPayload } from "@hasna/mcp-harness";
import { handleMcpHttpRequest as harnessHandleMcpHttpRequest } from "@hasna/mcp-harness/bun";
import {
  assertUsableToken,
  MCP_HTTP_TOKEN_ENV,
  type McpHttpGuard,
  rejectDisallowedOrigin,
  rejectUnauthorized,
  resolveAllowedHosts,
  resolveAllowedOrigins,
  resolveHttpToken,
} from "./http-auth.js";
import { DEFAULT_MCP_HTTP_PORT, isHttpMode, isStdioMode, MCP_NAME, resolveHttpPort } from "./options.js";

export { DEFAULT_MCP_HTTP_PORT, isHttpMode, isStdioMode, MCP_NAME, resolveHttpPort };
export {
  MCP_HTTP_ALLOWED_HOSTS_ENV,
  MCP_HTTP_ALLOWED_ORIGINS_ENV,
  MCP_HTTP_TOKEN_ENV,
  type McpHttpGuard,
} from "./http-auth.js";

// emails MCP HTTP transport — hand-wired onto `@hasna/mcp-harness` (the
// hand-rolled `WebStandardStreamableHTTPServerTransport` wiring + health
// payload shape are now shared). `./server.js` stays a dynamic import so
// `--help`/`--version` and the health check never pull in the full tool graph.
//
// Every request passes an authorization + DNS-rebinding guard first (see
// `./http-auth.ts`): `/mcp` requires `Authorization: Bearer <token>` matching
// EMAILS_MCP_HTTP_TOKEN, and every path requires an allowlisted `Host` (plus
// `Origin`, when the client sends one).
export async function handleMcpHttpRequest(req: Request, guard: McpHttpGuard): Promise<Response> {
  const url = new URL(req.url);

  // Host/Origin validation runs before routing so it also covers /health and
  // the 404 fallthrough — a rebound page must not be able to probe the port.
  const disallowedOrigin = rejectDisallowedOrigin(req, guard);
  if (disallowedOrigin) return disallowedOrigin;

  if (url.pathname === "/health" && req.method === "GET") {
    // Deliberately unauthenticated: the payload is the static `{status,name}`
    // liveness probe and it is already behind the Host allowlist above.
    // Nothing tenant-, config-, or credential-derived is exposed here.
    return Response.json(healthPayload(MCP_NAME));
  }

  if (url.pathname === "/mcp") {
    const unauthorized = rejectUnauthorized(req, guard);
    if (unauthorized) return unauthorized;
    const { buildServer } = await import("./server.js");
    return harnessHandleMcpHttpRequest(req, buildServer);
  }

  return new Response("Not Found", { status: 404 });
}

export interface StartHttpServerOptions {
  port?: number;
  hostname?: string;
  log?: (message: string) => void;
  /** Bearer token required on `/mcp`. Defaults to `EMAILS_MCP_HTTP_TOKEN`. */
  token?: string;
  /** Allowed `Host` header values. Defaults to loopback names at the bound port. */
  allowedHosts?: string[];
  /** Allowed `Origin` header values. Defaults to loopback origins at the bound port. */
  allowedOrigins?: string[];
}

export function startHttpServer(options: StartHttpServerOptions = {}): ReturnType<typeof Bun.serve> {
  const port = options.port ?? DEFAULT_MCP_HTTP_PORT;
  const hostname = options.hostname ?? "127.0.0.1";
  const log = options.log ?? console.error;
  // Fail closed before the socket is bound: an unauthenticated listener over
  // the full tool graph is never an acceptable fallback.
  const token = assertUsableToken(options.token ?? resolveHttpToken());

  // The guard needs the *bound* port (callers pass 0 for an ephemeral port), so
  // it is filled in right after `Bun.serve` returns and before any request can
  // be dispatched.
  let guard: McpHttpGuard | undefined;

  const server = Bun.serve({
    // The self-hosted data source pages the self_hosted /v1 API client-side (no
    // server-side filter/count), so `inbox status`/`search_inbound` tool calls
    // can take tens of seconds against a large mailbox. Bun's default
    // idleTimeout is 10s, which silently closes the streamable-HTTP connection
    // mid-call ("socket connection closed unexpectedly"). Raise it to Bun's max
    // (255s) so slow self_hosted-backed tool calls and the long-lived MCP event
    // stream survive.
    idleTimeout: 255,
    port,
    hostname,
    fetch: (req) => handleMcpHttpRequest(req, guard as McpHttpGuard),
  });

  const boundPort = server.port ?? port;
  guard = {
    token,
    allowedHosts: options.allowedHosts ?? resolveAllowedHosts(hostname, boundPort, process.env),
    allowedOrigins: options.allowedOrigins ?? resolveAllowedOrigins(boundPort, process.env),
  };

  const address = `http://${hostname}:${server.port}`;
  log(`${MCP_NAME}-mcp HTTP listening on ${address}/mcp (health: ${address}/health)`);
  log(`${MCP_NAME}-mcp HTTP requires "Authorization: Bearer <${MCP_HTTP_TOKEN_ENV}>"; allowed Host values: ${guard.allowedHosts.join(", ")}`);
  return server;
}
