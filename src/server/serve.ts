/**
 * HTTP server for the emails dashboard.
 * Provides REST API and serves the static dashboard from dashboard/index.html.
 *
 * API route logic lives in api-routes.ts to keep this file thin.
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname, extname, isAbsolute, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { handleApiRequest } from "./api-routes.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const API_ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const API_ALLOWED_HEADERS = "Content-Type, Authorization";
const API_ALLOWED_HEADER_NAMES = new Set(["content-type", "authorization"]);
const UNSAFE_API_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface DashboardApiOriginAccess {
  allowed: boolean;
  origin?: string;
  reason?: string;
}

export function staticResponseHeaders(mimeType: string): Headers {
  return new Headers({
    "Content-Type": mimeType,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
  });
}

function configuredAllowedOrigins(): Set<string> {
  return new Set(
    (process.env["EMAILS_DASHBOARD_ALLOWED_ORIGINS"] ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isTrustedDashboardHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function requestHostAllowed(requestUrl: URL, allowedOrigins: Set<string>): boolean {
  return isTrustedDashboardHostname(requestUrl.hostname) || allowedOrigins.has(requestUrl.origin);
}

export function isDashboardApiPath(path: string): boolean {
  return path.startsWith("/api/");
}

export function dashboardApiOriginAccess(req: Request, requestUrl: URL): DashboardApiOriginAccess {
  const allowedOrigins = configuredAllowedOrigins();
  if (!requestHostAllowed(requestUrl, allowedOrigins)) {
    return { allowed: false, reason: "Dashboard API Host is not allowed." };
  }

  const origin = req.headers.get("Origin");
  if (!origin) {
    const fetchSite = req.headers.get("Sec-Fetch-Site")?.toLowerCase();
    if (fetchSite === "cross-site") {
      return { allowed: false, reason: "Cross-site browser requests to the dashboard API are not allowed." };
    }
    if (UNSAFE_API_METHODS.has(req.method.toUpperCase())) {
      return { allowed: false, reason: "Unsafe dashboard API requests require an Origin header." };
    }
    return { allowed: true };
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return { allowed: false, reason: "Invalid Origin header." };
  }

  if (originUrl.origin === requestUrl.origin) {
    return { allowed: true, origin: originUrl.origin };
  }

  if (allowedOrigins.has(originUrl.origin)) {
    return { allowed: true, origin: originUrl.origin };
  }

  return { allowed: false, reason: "Cross-origin dashboard API requests are not allowed." };
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", value);
    return;
  }
  const values = existing.split(",").map((part) => part.trim().toLowerCase());
  if (!values.includes(value.toLowerCase())) headers.set("Vary", `${existing}, ${value}`);
}

function requestedDashboardApiHeaders(req: Request): string {
  const requested = req.headers.get("Access-Control-Request-Headers");
  if (!requested) return API_ALLOWED_HEADERS;

  const allowed = requested
    .split(",")
    .map((header) => header.trim())
    .filter((header) => API_ALLOWED_HEADER_NAMES.has(header.toLowerCase()));

  return allowed.length ? allowed.join(", ") : API_ALLOWED_HEADERS;
}

function applyDashboardApiCorsHeaders(headers: Headers, access: DashboardApiOriginAccess, req: Request): void {
  if (!access.origin) return;
  headers.set("Access-Control-Allow-Origin", access.origin);
  headers.set("Access-Control-Allow-Methods", API_ALLOWED_METHODS);
  headers.set("Access-Control-Allow-Headers", requestedDashboardApiHeaders(req));
  appendVary(headers, "Origin");
}

export function dashboardApiForbiddenResponse(access: DashboardApiOriginAccess): Response {
  return new Response(JSON.stringify({ error: access.reason ?? "Dashboard API request not allowed." }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

export function dashboardApiPreflightResponse(req: Request, requestUrl: URL): Response {
  const access = dashboardApiOriginAccess(req, requestUrl);
  if (!access.allowed) return dashboardApiForbiddenResponse(access);

  const headers = new Headers();
  applyDashboardApiCorsHeaders(headers, access, req);
  return new Response(null, { status: 204, headers });
}

export function withDashboardApiCors(response: Response, access: DashboardApiOriginAccess, req: Request): Response {
  const headers = new Headers(response.headers);
  applyDashboardApiCorsHeaders(headers, access, req);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function resolveDashboardDir(): string {
  const candidates: string[] = [];

  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(scriptDir, "..", "dashboard"));
    candidates.push(join(scriptDir, "..", "..", "dashboard"));
  } catch {
    // import.meta.url may not be available in all contexts
  }

  if (process.argv[1]) {
    const mainDir = dirname(process.argv[1]);
    candidates.push(join(mainDir, "..", "dashboard"));
    candidates.push(join(mainDir, "..", "..", "dashboard"));
  }

  candidates.push(join(process.cwd(), "dashboard"));

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }

  return join(process.cwd(), "dashboard");
}

export function resolveDashboardStaticPath(dashboardDir: string, requestPath: string): string | null {
  const root = resolve(dashboardDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const requested = requestPath === "/" || requestPath === "/index.html"
    ? "index.html"
    : decoded.replace(/^\/+/, "");
  const filePath = resolve(root, requested);
  const rel = relative(root, filePath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  if (!extname(filePath)) {
    const htmlPath = `${filePath}.html`;
    const htmlRel = relative(root, htmlPath);
    if (!(htmlRel === ".." || htmlRel.startsWith(`..${sep}`) || isAbsolute(htmlRel)) && existsSync(htmlPath)) {
      return htmlPath;
    }
  }
  return filePath;
}

export async function handleDashboardRequest(req: Request, dashboardDir = resolveDashboardDir()): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // ─── Dashboard API CORS preflight ──────────────────────────────────────
  if (method === "OPTIONS") {
    if (isDashboardApiPath(path)) return dashboardApiPreflightResponse(req, url);
    return new Response(null, { status: 204 });
  }

  // ─── API ROUTES ────────────────────────────────────────────────────────
  if (path.startsWith("/api/") || path.startsWith("/track/") || path.startsWith("/webhook/") || path.startsWith("/open/") || path.startsWith("/click/")) {
    const apiOriginAccess = isDashboardApiPath(path) ? dashboardApiOriginAccess(req, url) : null;
    if (apiOriginAccess && !apiOriginAccess.allowed) return dashboardApiForbiddenResponse(apiOriginAccess);
    const apiResponse = await handleApiRequest(req, url, path, method);
    if (apiResponse !== null) {
      return apiOriginAccess ? withDashboardApiCors(apiResponse, apiOriginAccess, req) : apiResponse;
    }
  }

  // ─── STATIC DASHBOARD ────────────────────────────────────────────────
  if (method === "GET") {
    const filePath = resolveDashboardStaticPath(dashboardDir, path);

    if (filePath && existsSync(filePath)) {
      const ext = extname(filePath);
      const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";
      return new Response(readFileSync(filePath), {
        headers: staticResponseHeaders(mimeType),
      });
    }

    // SPA fallback
    const indexPath = join(dashboardDir, "index.html");
    if (existsSync(indexPath)) {
      return new Response(readFileSync(indexPath), {
        headers: staticResponseHeaders("text/html; charset=utf-8"),
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
}

export async function startServer(port = 3900, hostname = "127.0.0.1"): Promise<void> {
  const dashboardDir = resolveDashboardDir();

  // Safety: the dashboard /api/* routes are unauthenticated and assume a trusted
  // loopback caller. Refuse to bind a non-loopback interface (exposing them to
  // the LAN/internet) unless the operator explicitly opts in.
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  if (!isLoopback && process.env["EMAILS_ALLOW_REMOTE"] !== "1") {
    throw new Error(
      `Refusing to bind ${hostname}: the dashboard /api/* routes are unauthenticated. ` +
      `Set EMAILS_ALLOW_REMOTE=1 to override (put it behind an authenticating proxy / firewall first).`,
    );
  }

  const server = Bun.serve({
    port,
    hostname,
    fetch: (req) => handleDashboardRequest(req, dashboardDir),
  });

  console.log(`\nMailery dashboard running at http://${hostname}:${server.port}`);
  console.log(`API available at http://${hostname}:${server.port}/api`);
  console.log(`Press Ctrl+C to stop\n`);
}
