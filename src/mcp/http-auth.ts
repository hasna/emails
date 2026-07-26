import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Authorization + DNS-rebinding guard for the emails MCP Streamable HTTP
 * transport.
 *
 * The HTTP transport exposes the whole tool graph (send_email,
 * add_forwarding_rule, set_config, create_send_key, ...). A loopback bind is
 * not a security boundary: any local process can reach it, and a browser page
 * can reach it too by re-resolving its own hostname to 127.0.0.1 (DNS
 * rebinding), at which point the request is same-origin and CORS does not
 * apply. So the transport requires (a) a bearer token on `/mcp` and (b) a
 * `Host`/`Origin` allowlist on every path.
 *
 * The MCP SDK's own `allowedHosts`/`enableDnsRebindingProtection` transport
 * options are deprecated in favour of "external middleware", and are not
 * reachable through `@hasna/mcp-harness` anyway — so the checks live here, in
 * front of the harness handler.
 */

export const MCP_HTTP_TOKEN_ENV = "EMAILS_MCP_HTTP_TOKEN";
export const MCP_HTTP_ALLOWED_HOSTS_ENV = "EMAILS_MCP_ALLOWED_HOSTS";
export const MCP_HTTP_ALLOWED_ORIGINS_ENV = "EMAILS_MCP_ALLOWED_ORIGINS";

/** Shortest accepted token. Long enough that guessing is not a strategy. */
export const MCP_HTTP_TOKEN_MIN_LENGTH = 16;

export interface McpHttpGuard {
  token: string;
  allowedHosts: string[];
  allowedOrigins: string[];
}

export function missingTokenMessage(): string {
  return [
    `Refusing to start the MCP HTTP transport without a bearer token.`,
    `The HTTP transport exposes every emails MCP tool (send_email, add_forwarding_rule,`,
    `set_config, create_send_key, ...) to anything that can reach the port.`,
    ``,
    `Set ${MCP_HTTP_TOKEN_ENV} to a secret of at least ${MCP_HTTP_TOKEN_MIN_LENGTH} characters`,
    `and send it as "Authorization: Bearer <token>", or use the stdio transport`,
    `(the default) instead:`,
    ``,
    `  emails-mcp --stdio`,
    `  EMAILS_MCP_HTTP_TOKEN="$(openssl rand -hex 32)" emails-mcp --http`,
  ].join("\n");
}

export function weakTokenMessage(): string {
  return `${MCP_HTTP_TOKEN_ENV} must be at least ${MCP_HTTP_TOKEN_MIN_LENGTH} characters.`;
}

/** Read the configured token, treating blank as unset. */
export function resolveHttpToken(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env[MCP_HTTP_TOKEN_ENV];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function assertUsableToken(token: string | undefined): string {
  if (!token) throw new Error(missingTokenMessage());
  if (token.length < MCP_HTTP_TOKEN_MIN_LENGTH) throw new Error(weakTokenMessage());
  return token;
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOrigin(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, "");
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;

/**
 * Host header values a legitimate loopback client can send. A rebound page
 * sends `Host: attacker.example:<port>`, which is not on this list.
 */
export function defaultAllowedHosts(hostname: string, port: number): string[] {
  const names = new Set<string>(LOOPBACK_HOSTS.map(normalizeHost));
  const bound = normalizeHost(hostname);
  // A wildcard bind has no single legitimate Host value; the operator must
  // spell out the allowlist via the env var.
  if (bound && bound !== "0.0.0.0" && bound !== "::" && bound !== "[::]") names.add(bound);

  const out = new Set<string>();
  for (const name of names) {
    out.add(`${name}:${port}`);
    // HTTP omits the port when it is the scheme default.
    if (port === 80) out.add(name);
  }
  return [...out];
}

export function defaultAllowedOrigins(port: number): string[] {
  return LOOPBACK_HOSTS.map((name) => `http://${name}:${port}`);
}

export function resolveAllowedHosts(
  hostname: string,
  port: number,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const configured = splitList(env[MCP_HTTP_ALLOWED_HOSTS_ENV]).map(normalizeHost);
  return configured.length > 0 ? configured : defaultAllowedHosts(hostname, port);
}

export function resolveAllowedOrigins(
  port: number,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const configured = splitList(env[MCP_HTTP_ALLOWED_ORIGINS_ENV]).map(normalizeOrigin);
  return configured.length > 0 ? configured : defaultAllowedOrigins(port);
}

export function parseBearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^bearer[ \t]+(\S.*)$/i.exec(header.trim());
  const value = match?.[1]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Constant-time comparison over SHA-256 digests, so neither the token bytes
 * nor its length are observable through response timing.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function requestHost(req: Request): string {
  const header = req.headers.get("host");
  if (header) return normalizeHost(header);
  try {
    return normalizeHost(new URL(req.url).host);
  } catch {
    return "";
  }
}

/**
 * DNS-rebinding protection. Returns a 403 when the `Host` header is not on the
 * allowlist, or when an `Origin` header is present and not on the allowlist.
 * Non-browser MCP clients send no `Origin` at all, which stays allowed.
 */
export function rejectDisallowedOrigin(req: Request, guard: McpHttpGuard): Response | undefined {
  const host = requestHost(req);
  if (!guard.allowedHosts.includes(host)) {
    return forbidden(`Host "${host}" is not allowed. Allowed: ${guard.allowedHosts.join(", ")} (override with ${MCP_HTTP_ALLOWED_HOSTS_ENV}).`);
  }

  // An absent Origin is the native-MCP-client case and stays allowed. A PRESENT
  // one must be on the allowlist — including the literal `null`, which is the
  // opaque-origin marker a sandboxed iframe, a `data:`/`file:` document, or
  // certain redirect chains send. Those are attacker-reachable browser contexts,
  // so treating `null` as "no Origin" would disable this check exactly where it
  // needs to bite.
  const origin = req.headers.get("origin");
  if (origin !== null && origin.trim() !== "") {
    if (!guard.allowedOrigins.includes(normalizeOrigin(origin))) {
      return forbidden(`Origin "${origin}" is not allowed (override with ${MCP_HTTP_ALLOWED_ORIGINS_ENV}).`);
    }
  }

  return undefined;
}

/** Bearer-token check for the tool-bearing `/mcp` endpoint. */
export function rejectUnauthorized(req: Request, guard: McpHttpGuard): Response | undefined {
  const presented = parseBearerToken(req.headers.get("authorization"));
  if (presented !== undefined && tokensMatch(presented, guard.token)) return undefined;
  return unauthorized();
}

function jsonRpcError(status: number, code: number, message: string, headers?: Record<string, string>): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status, headers },
  );
}

function forbidden(message: string): Response {
  return jsonRpcError(403, -32000, `Forbidden: ${message}`);
}

function unauthorized(): Response {
  return jsonRpcError(
    401,
    -32001,
    `Unauthorized: send "Authorization: Bearer <token>" matching ${MCP_HTTP_TOKEN_ENV}.`,
    { "WWW-Authenticate": `Bearer realm="emails-mcp"` },
  );
}
