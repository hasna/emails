// Self-hosted HTTP storage bridge. It is selected only by an explicit
// EMAILS_MODE=self_hosted setting plus an operator-supplied URL and API key.
//
//   list   -> GET    /v1/<resource>            -> { <resource>: [...] }
//   get    -> GET    /v1/<resource>/<id>       -> { <singular>: <entity> } | 404
//   create -> POST   /v1/<resource>            -> { <singular>: <entity> }
//   update -> PATCH  /v1/<resource>/<id>       -> { <singular>: <entity> }
//   delete -> DELETE /v1/<resource>/<id>       -> void (200/204/404 => ok)
//
// The repository functions are synchronous (CLI, MCP and serve all call them
// without an await), so this bridge performs the HTTP call synchronously via a
// spawned `curl`. Bun has no synchronous `fetch`.
//
// SAFETY: the API key and request body are NEVER placed on process argv or in
// local temp files. They are passed to `curl -K -` over stdin, and the key value
// is never logged or embedded in an error.

import { spawnSync } from "node:child_process";
import { EMAILS_SESSION_TOKEN_ENV, loadEmailsClientEnvSecret } from "../lib/client-env.js";

const APP = "emails";

export class SelfHostedHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly bodyText: string,
  ) {
    super(`Self-hosted ${method} ${path} failed: HTTP ${status}${bodyText ? ` — ${bodyText.slice(0, 300)}` : ""}`);
    this.name = "SelfHostedHttpError";
  }
}

export interface SelfHostedConfig {
  baseUrl: string; // `<origin>/v1`
  /**
   * Bearer credential threaded into BOTH transports. A user session token
   * (emss_…) when present, otherwise the operator API key. The client never
   * sends a tenant — the server derives it from this credential.
   */
  credential: string;
}

function toV1BaseUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API URL must use http or https.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("EMAILS_SELF_HOSTED_URL must use https except for a loopback development URL.");
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) path = path.slice(0, -"/v1".length);
  url.pathname = `${path}/v1`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

let _cachedSignature: string | null = null;
let _cachedConfig: SelfHostedConfig | null = null;

const CONFIG_HELP =
  "Configure the client via EMAILS_CLIENT_ENV_SECRET (an encrypted client env file), " +
  "or set EMAILS_MODE=self_hosted with EMAILS_SELF_HOSTED_URL and EMAILS_SELF_HOSTED_API_KEY.";

/**
 * Resolve strict client configuration. This client is self-hosted-ONLY: a fully
 * configured self_hosted endpoint (base URL + API key) is MANDATORY. Missing or
 * partial configuration fails loud — there is no local fallback and no endpoint
 * is ever inferred by the package.
 */
export function resolveSelfHostedConfig(env: NodeJS.ProcessEnv = process.env): SelfHostedConfig {
  loadEmailsClientEnvSecret(env);
  const modeRaw = env["EMAILS_MODE"]?.trim() ?? env["HASNA_EMAILS_MODE"]?.trim();
  const apiUrl = env["EMAILS_SELF_HOSTED_URL"]?.trim();
  const apiKey = env["EMAILS_SELF_HOSTED_API_KEY"]?.trim();
  const sessionToken = env[EMAILS_SESSION_TOKEN_ENV]?.trim();
  // Prefer a user session token over the operator API key; the server maps
  // whichever credential to its tenant. Tenant is never sent by the client.
  const credential = sessionToken || apiKey;

  const signature = `${modeRaw ?? ""}|${apiUrl ?? ""}|${sessionToken ? "s" : ""}${apiKey ? "k" : ""}`;
  if (signature === _cachedSignature && _cachedConfig) return _cachedConfig;

  const config = computeConfig(modeRaw, apiUrl, credential);
  _cachedSignature = signature;
  _cachedConfig = config;
  return config;
}

function assertSupportedMode(modeRaw: string | undefined): void {
  if (modeRaw && modeRaw !== "self_hosted") {
    throw new Error(
      `${APP}: unsupported EMAILS_MODE '${modeRaw}'. This client is self-hosted-only and the ` +
        `only supported mode is self_hosted. ${CONFIG_HELP}`,
    );
  }
}

function computeConfig(
  modeRaw: string | undefined,
  apiUrl: string | undefined,
  credential: string | undefined,
): SelfHostedConfig {
  assertSupportedMode(modeRaw);
  if (!apiUrl || !credential) {
    const missing = [
      !apiUrl ? "EMAILS_SELF_HOSTED_URL" : null,
      !credential ? "EMAILS_SELF_HOSTED_API_KEY or EMAILS_SESSION_TOKEN" : null,
    ].filter(Boolean).join(" and ");
    throw new Error(
      `${APP}: the self-hosted client is not configured (${missing} missing). ${CONFIG_HELP}`,
    );
  }
  return { baseUrl: toV1BaseUrl(apiUrl), credential };
}

/**
 * Resolve the `<origin>/v1` base URL WITHOUT requiring a credential. Used only
 * by the unauthenticated auth endpoints (signup/login), where the caller may not
 * hold a credential yet. A vault load failure caused solely by a missing
 * credential is tolerated as long as the URL is present.
 */
function resolveSelfHostedBaseUrlLenient(env: NodeJS.ProcessEnv = process.env): string {
  let loadError: unknown;
  try {
    loadEmailsClientEnvSecret(env);
  } catch (error) {
    loadError = error;
  }
  assertSupportedMode(env["EMAILS_MODE"]?.trim() ?? env["HASNA_EMAILS_MODE"]?.trim());
  const apiUrl = env["EMAILS_SELF_HOSTED_URL"]?.trim();
  if (!apiUrl) {
    if (loadError) throw loadError;
    throw new Error(
      `${APP}: the self-hosted client is not configured (EMAILS_SELF_HOSTED_URL missing). ${CONFIG_HELP}`,
    );
  }
  return toV1BaseUrl(apiUrl);
}

/** Reset the memoized config (tests flip env between cases). */
export function resetSelfHostedConfigCache(): void {
  _cachedSignature = null;
  _cachedConfig = null;
}

/**
 * Compatibility shim. This client is self-hosted-ONLY, so this is always true.
 * Retained only so external modules (e.g. the self-hosted server env/migrate)
 * that still reference it keep compiling; new client code must not branch on it.
 */
export function isSelfHostedMode(): boolean {
  return true;
}

interface CurlResult {
  status: number;
  body: string;
}

// Bounded timeouts so a slow/unreachable operator endpoint fails fast.
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
// Resolved per-call so an env override always applies (and tests can shorten it).
function connectTimeoutSeconds(): number { return positiveIntEnv("EMAILS_SELF_HOSTED_HTTP_CONNECT_TIMEOUT", 10); }
function maxTimeSeconds(): number { return positiveIntEnv("EMAILS_SELF_HOSTED_HTTP_TIMEOUT", 30); }

/**
 * Thrown when the curl transport itself fails (DNS/connect failure or a timeout)
 * — i.e. NO HTTP status was received. Distinct from SelfHostedHttpError (a real HTTP
 * status the server returned). Never carries the API key.
 */
export class SelfHostedTransportError extends Error {
  constructor(readonly method: string, readonly path: string, detail: string) {
    super(`Cannot reach the Emails self-hosted service for ${method} ${path}: ${detail}`);
    this.name = "SelfHostedTransportError";
  }
}

function curlConfigValue(value: string): string {
  return JSON.stringify(value);
}

const CURL_ENV_ALLOWLIST = [
  "PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "CURL_CA_BUNDLE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

function curlProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CURL_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function httpRequest(config: SelfHostedConfig, method: string, path: string, body?: unknown): CurlResult {
  const url = `${config.baseUrl}${path}`;
  const connectTimeout = connectTimeoutSeconds();
  const maxTime = maxTimeSeconds();
  const lines = [
    `url = ${curlConfigValue(url)}`,
    `request = ${curlConfigValue(method)}`,
    `header = ${curlConfigValue("Accept: application/json")}`,
    // Bounded, fail-loud transport (never hang indefinitely).
    `connect-timeout = ${connectTimeout}`,
    `max-time = ${maxTime}`,
    `silent`,
    `show-error`,
  ];
  // Omit the Authorization header entirely when no credential is available (the
  // unauthenticated /v1/auth/signup|login path); never send an empty Bearer.
  if (config.credential) {
    lines.push(`header = ${curlConfigValue(`Authorization: Bearer ${config.credential}`)}`);
  }
  if (body !== undefined) {
    lines.push(`header = ${curlConfigValue("Content-Type: application/json")}`);
    lines.push(`data-binary = ${curlConfigValue(JSON.stringify(body))}`);
  }

  const proc = spawnSync("curl", ["-q", "-K", "-", "-w", "\n%{http_code}"], {
    encoding: "utf-8",
    env: curlProcessEnv(),
    input: lines.join("\n"),
    maxBuffer: 128 * 1024 * 1024,
    // Hard ceiling in case curl itself wedges: kill just past its own max-time.
    timeout: (maxTime + connectTimeout + 5) * 1000,
  });
  if (proc.error) {
    // spawnSync's own timeout (ETIMEDOUT) or a spawn failure — surface as a
    // transport error, not a mysterious throw.
    throw new SelfHostedTransportError(method, path, (proc.error as Error).message || "curl could not run");
  }
  const out = proc.stdout ?? "";
  const nl = out.lastIndexOf("\n");
  const statusStr = nl >= 0 ? out.slice(nl + 1).trim() : out.trim();
  const bodyText = nl >= 0 ? out.slice(0, nl) : "";
  const status = Number.parseInt(statusStr, 10);
  // http_code 000 (or unparseable) means curl never got an HTTP response:
  // connect failure or the connect/max-time budget elapsed. Fail LOUD so a
  // read never silently degrades to an empty list with a success exit code.
  if (!Number.isFinite(status) || status === 0) {
    const stderr = (proc.stderr || "").trim();
    const detail = proc.status === 28
      ? `timed out after ${maxTime}s`
      : (stderr || `curl exited ${proc.status ?? "unknown"}`);
    throw new SelfHostedTransportError(method, path, detail);
  }
  return { status, body: bodyText };
}

function parseJson(text: string): unknown {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const LIST_KEYS = ["items", "data", "results", "rows", "records"];

function extractList(raw: unknown, resource: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of [resource, ...LIST_KEYS]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

/**
 * Unwrap a single-entity response. The emails API wraps entities as
 * `{ <singular>: entity }` (e.g. `{ domain: {...} }`); other apps return the
 * entity directly. Handles both.
 */
function unwrapSingle(raw: unknown, singular: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const wrapped = obj[singular];
  if (wrapped && typeof wrapped === "object") return wrapped as Record<string, unknown>;
  // Fall back: single-key envelope wrapping an object with an id.
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const val = obj[keys[0]!];
    if (val && typeof val === "object" && !Array.isArray(val) && "id" in (val as object)) {
      return val as Record<string, unknown>;
    }
  }
  return obj;
}

function singularOf(resource: string): string {
  const r = resource.replace(/^\/+|\/+$/g, "");
  return r.endsWith("es") && (r.endsWith("sses") || r.endsWith("ches") || r.endsWith("xes"))
    ? r.slice(0, -2)
    : r.endsWith("s")
      ? r.slice(0, -1)
      : r;
}

export interface SelfHostedResourceStore {
  readonly resource: string;
  readonly baseUrl: string;
  list(query?: Record<string, string | number | boolean | undefined>): Record<string, unknown>[];
  get(id: string): Record<string, unknown> | null;
  create(body: unknown): Record<string, unknown>;
  update(id: string, patch: unknown, method?: "PATCH" | "PUT"): Record<string, unknown>;
  /** Delete by id. Returns true if the entity existed (2xx), false on 404. */
  del(id: string): boolean;
}

function encodeQuery(query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * Return a self-hosted store for `resource`. This client is self-hosted-only, so
 * this always returns a store; missing/invalid configuration throws (fail loud)
 * via resolveSelfHostedConfig().
 */
export function selfHostedStoreFor(resource: string): SelfHostedResourceStore {
  const config = resolveSelfHostedConfig();
  const clean = resource.replace(/^\/+|\/+$/g, "");
  const base = `/${clean}`;
  const singular = singularOf(clean);

  return {
    resource: clean,
    baseUrl: config.baseUrl,
    list(query) {
      const { status, body } = httpRequest(config, "GET", `${base}${encodeQuery(query)}`);
      if (status < 200 || status >= 300) throw new SelfHostedHttpError(status, "GET", base, body);
      return extractList(parseJson(body), clean) as Record<string, unknown>[];
    },
    get(id) {
      const { status, body } = httpRequest(config, "GET", `${base}/${encodeURIComponent(id)}`);
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw new SelfHostedHttpError(status, "GET", `${base}/${id}`, body);
      return unwrapSingle(parseJson(body), singular);
    },
    create(body) {
      const res = httpRequest(config, "POST", base, body);
      if (res.status < 200 || res.status >= 300) throw new SelfHostedHttpError(res.status, "POST", base, res.body);
      return unwrapSingle(parseJson(res.body), singular) ?? {};
    },
    update(id, patch, method = "PATCH") {
      const res = httpRequest(config, method, `${base}/${encodeURIComponent(id)}`, patch);
      if (res.status < 200 || res.status >= 300) {
        throw new SelfHostedHttpError(res.status, method, `${base}/${id}`, res.body);
      }
      return unwrapSingle(parseJson(res.body), singular) ?? {};
    },
    del(id) {
      const { status, body } = httpRequest(config, "DELETE", `${base}/${encodeURIComponent(id)}`);
      if (status === 404) return false;
      if (status < 200 || status >= 300) throw new SelfHostedHttpError(status, "DELETE", `${base}/${id}`, body);
      return true;
    },
  };
}

// ---- bespoke /v1 endpoints (auth, keys, me) -------------------------------
//
// Auth/session/key-management endpoints are NOT generic CRUD resources: they
// return status-dependent shapes (401/403, needs_tenant, unverified, a token
// shown once) that the CLI must branch on. This helper performs a single
// authenticated (or, for signup/login, unauthenticated) call and returns the
// raw status + parsed JSON. The Bearer credential is threaded from
// resolveSelfHostedConfig and never logged.

export interface SelfHostedApiResult {
  status: number;
  json: unknown;
  bodyText: string;
}

export interface SelfHostedApiRequestOptions {
  /**
   * When false, resolve only the base URL and send no Authorization header —
   * for the unauthenticated auth endpoints (signup/login). Defaults to true.
   */
  requireCredential?: boolean;
}

export function selfHostedApiRequest(
  method: string,
  path: string,
  body?: unknown,
  options: SelfHostedApiRequestOptions = {},
): SelfHostedApiResult {
  const requireCredential = options.requireCredential !== false;
  let config: SelfHostedConfig;
  if (requireCredential) {
    config = resolveSelfHostedConfig();
  } else {
    // resolveSelfHostedBaseUrlLenient loads the vault entry, so env carries any
    // available credential afterwards. Send it if present; otherwise none.
    const baseUrl = resolveSelfHostedBaseUrlLenient();
    const credential = process.env[EMAILS_SESSION_TOKEN_ENV]?.trim() || process.env["EMAILS_SELF_HOSTED_API_KEY"]?.trim() || "";
    config = { baseUrl, credential };
  }
  const { status, body: text } = httpRequest(config, method, path, body);
  return { status, json: parseJson(text), bodyText: text };
}

// ---- id resolution (self-hosted) ------------------------------------------
//
// Replaces the deleted local resolvePartialId family. A full 36-char id is
// verified with a single GET; a shorter prefix is matched against a bounded
// recent scan of the resource. All resolution routes to the /v1 API — never a
// local island.

const RESOLVE_SCAN_CAP = 1000;

export function resolveResourceId(resource: string, partialId: string): string | null {
  const value = partialId.trim();
  if (!value) return null;
  const store = selfHostedStoreFor(resource);
  if (value.length >= 36) {
    return store.get(value) ? value : null;
  }
  const matches = store
    .list({ limit: RESOLVE_SCAN_CAP })
    .map((row) => String((row as { id?: unknown }).id ?? ""))
    .filter((id) => id.startsWith(value));
  return matches.length === 1 ? matches[0]! : null;
}

export function listResourceIdMatches(resource: string, partialId: string, limit = 6): string[] {
  const value = partialId.trim();
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 6;
  const store = selfHostedStoreFor(resource);
  return store
    .list({ limit: RESOLVE_SCAN_CAP })
    .map((row) => String((row as { id?: unknown }).id ?? ""))
    .filter((id) => id.startsWith(value))
    .slice(0, safeLimit);
}

export function resolveResourceIdOrThrow(resource: string, partialId: string): string {
  const value = partialId.trim();
  if (!value) throw new Error(`Missing ID for resource '${resource}'.`);
  const id = resolveResourceId(resource, value);
  if (id) return id;
  const matches = listResourceIdMatches(resource, value, 6);
  if (matches.length === 0) {
    throw new Error(`Could not resolve ID '${value}' in resource '${resource}'.`);
  }
  const preview = matches.slice(0, 5).join(", ");
  const count = matches.length >= 6 ? "at least 6" : String(matches.length);
  throw new Error(`Ambiguous ID '${value}' in resource '${resource}' (${count} matches): ${preview}`);
}
