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
// SAFETY: the API key is NEVER placed on the process argv (it would leak into
// `ps`/monitoring). It is written to a 0600 curl config file that is deleted
// immediately after the call. The key value is never logged or embedded in an
// error.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  apiKey: string;
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
let _cachedConfig: SelfHostedConfig | null | undefined;
let _resourceRoutingDisabledDepth = 0;

/**
 * Resolve strict client configuration. Credentials never imply a mode and no
 * endpoint is supplied by the package.
 */
export function resolveSelfHostedConfig(env: NodeJS.ProcessEnv = process.env): SelfHostedConfig | null {
  if (_resourceRoutingDisabledDepth > 0) return null;
  const modeRaw = env["EMAILS_MODE"]?.trim() ?? env["HASNA_EMAILS_MODE"]?.trim();
  const apiUrl = env["EMAILS_SELF_HOSTED_URL"]?.trim();
  const apiKey = env["EMAILS_SELF_HOSTED_API_KEY"]?.trim();

  const signature = `${modeRaw ?? ""}|${apiUrl ?? ""}|${apiKey ? "k" : ""}`;
  if (signature === _cachedSignature && _cachedConfig !== undefined) return _cachedConfig ?? null;

  const config = computeConfig(modeRaw, apiUrl, apiKey);
  _cachedSignature = signature;
  _cachedConfig = config;
  return config;
}

function computeConfig(
  modeRaw: string | undefined,
  apiUrl: string | undefined,
  apiKey: string | undefined,
): SelfHostedConfig | null {
  if (!modeRaw || modeRaw === "local") {
    if (apiUrl || apiKey) {
      throw new Error(
        "Self-hosted credentials were supplied without EMAILS_MODE=self_hosted. " +
          "Set the mode explicitly or remove EMAILS_SELF_HOSTED_URL and EMAILS_SELF_HOSTED_API_KEY.",
      );
    }
    return null;
  }
  if (modeRaw !== "self_hosted") {
    throw new Error(
      `Unsupported Emails mode '${modeRaw}'. Use exactly local or self_hosted; cloud, remote, and hybrid aliases were removed.`,
    );
  }
  if (!apiKey) {
    throw new Error(
      `${APP}: self_hosted mode requires EMAILS_SELF_HOSTED_API_KEY.`,
    );
  }
  if (!apiUrl) {
    throw new Error(
      `${APP}: self_hosted mode requires an operator-supplied EMAILS_SELF_HOSTED_URL.`,
    );
  }

  return { baseUrl: toV1BaseUrl(apiUrl), apiKey };
}

/** True only for explicit, completely configured self-hosted mode. */
export function isSelfHostedMode(): boolean {
  return resolveSelfHostedConfig() !== null;
}

/** Reset the memoized config (tests flip env between cases). */
export function resetSelfHostedConfigCache(): void {
  _cachedSignature = null;
  _cachedConfig = undefined;
}

/** Run synchronous repository reads against local config even in self_hosted mode. */
export function withSelfHostedResourceRoutingDisabled<T>(fn: () => T): T {
  _resourceRoutingDisabledDepth += 1;
  try {
    return fn();
  } finally {
    _resourceRoutingDisabledDepth -= 1;
  }
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

function httpRequest(config: SelfHostedConfig, method: string, path: string, body?: unknown): CurlResult {
  const url = `${config.baseUrl}${path}`;
  const connectTimeout = connectTimeoutSeconds();
  const maxTime = maxTimeSeconds();
  const dir = mkdtempSync(join(tmpdir(), "emails-self-hosted-"));
  const cfgPath = join(dir, "curl.cfg");
  try {
    const lines = [
      `url = "${url}"`,
      `request = "${method}"`,
      `header = "Authorization: Bearer ${config.apiKey}"`,
      `header = "Accept: application/json"`,
      // Bounded, fail-loud transport (never hang indefinitely).
      `connect-timeout = ${connectTimeout}`,
      `max-time = ${maxTime}`,
      `silent`,
      `show-error`,
    ];
    if (body !== undefined) {
      lines.push(`header = "Content-Type: application/json"`);
      lines.push(`data-binary = "@${join(dir, "body.json")}"`);
      writeFileSync(join(dir, "body.json"), JSON.stringify(body), { mode: 0o600 });
    }
    writeFileSync(cfgPath, lines.join("\n"), { mode: 0o600 });

    const proc = spawnSync("curl", ["-K", cfgPath, "-w", "\n%{http_code}"], {
      encoding: "utf-8",
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
 * Return a self-hosted store for `resource`, or null in local mode. Invalid or
 * incomplete self-hosted configuration fails closed.
 */
export function selfHostedStoreFor(resource: string): SelfHostedResourceStore | null {
  const config = resolveSelfHostedConfig();
  if (!config) return null;
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
