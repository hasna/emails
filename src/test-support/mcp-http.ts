import { startHttpServer, type StartHttpServerOptions } from "../mcp/http.js";

/**
 * Shared fixture for tests that drive the MCP Streamable HTTP transport.
 *
 * The transport requires a bearer token and an allowlisted `Host`, so tests
 * cannot just point a client at the port anymore — they go through here so the
 * token stays in one place and every test exercises the real guard.
 */
export const MCP_TEST_HTTP_TOKEN = "emails-mcp-test-token-0123456789";

export function startTestMcpHttpServer(
  options: Omit<StartHttpServerOptions, "token" | "log"> = {},
): ReturnType<typeof startHttpServer> {
  return startHttpServer({ port: 0, ...options, token: MCP_TEST_HTTP_TOKEN, log: () => {} });
}

/** `requestInit` for `StreamableHTTPClientTransport` carrying the test token. */
export function mcpTestRequestInit(token: string = MCP_TEST_HTTP_TOKEN): { requestInit: RequestInit } {
  return { requestInit: { headers: { Authorization: `Bearer ${token}` } } };
}
