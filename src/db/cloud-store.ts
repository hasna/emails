// HTTP storage bridge — makes `self_hosted` mode real for the client.
//
// When the client-flip contract resolves to self_hosted
// (HASNA_MAILERY_API_URL + HASNA_MAILERY_API_KEY are set, with optional
// HASNA_MAILERY_STORAGE_MODE=self_hosted), the repository layer (src/db/*.ts)
// routes ALL reads AND writes to the app's self-hosted HTTP API
// (`<API_URL>/v1/<resource>`) with the bearer key — NOT the local SQLite store,
// NOT a DSN. This mirrors the resource-CRUD vocabulary of the Hasna Service
// Contract v1 that `@hasna/contracts`'s `createHasnaStorageClient` speaks:
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
const TOKEN = "MAILERY";

export class CloudHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly bodyText: string,
  ) {
    super(`Cloud ${method} ${path} failed: HTTP ${status}${bodyText ? ` — ${bodyText.slice(0, 300)}` : ""}`);
    this.name = "CloudHttpError";
  }
}

interface CloudConfig {
  baseUrl: string; // `<origin>/v1`
  apiKey: string;
}

const REMOVED_PRODUCT_MODES = new Set(["cloud", "mailery_cloud", "remote", "hybrid"]);

function firstEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeMode(raw: string | undefined): "self_hosted" | "local" | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/-/g, "_");
  if (v === "local") return "local";
  if (v === "self_hosted" || v === "selfhosted") return "self_hosted";
  if (REMOVED_PRODUCT_MODES.has(v)) {
    throw new Error(
      `${APP}: unsupported mode '${raw}'. Cloud, remote, and hybrid product modes were removed from Hasna OSS. ` +
        "Use self_hosted with an API URL and API key, or use local.",
    );
  }
  throw new Error(`${APP}: unknown mode '${raw}'. Use local or self_hosted.`);
}

function toV1BaseUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API URL must use http or https.");
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) path = path.slice(0, -"/v1".length);
  url.pathname = `${path}/v1`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

let _cachedSignature: string | null = null;
let _cachedConfig: CloudConfig | null | undefined;

/**
 * Resolve the self-hosted API config from the client-flip env, or null for local mode.
 * Fail-closed: if self_hosted is requested but the API URL or key is missing,
 * this THROWS rather than silently reading local data.
 */
export function resolveCloudConfig(): CloudConfig | null {
  const modeRaw = firstEnv([
    `HASNA_${TOKEN}_STORAGE_MODE`,
    `HASNA_${TOKEN}_MODE`,
    `${TOKEN}_STORAGE_MODE`,
    `${TOKEN}_MODE`,
    // Mailery's internal mode env (the app is also known as "emails").
    "HASNA_EMAILS_STORAGE_MODE",
    "HASNA_EMAILS_MODE",
  ]);
  const apiUrl = firstEnv([`HASNA_${TOKEN}_API_URL`, `${TOKEN}_API_URL`]);
  const apiKey = firstEnv([`HASNA_${TOKEN}_API_KEY`, `${TOKEN}_API_KEY`]);

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
): CloudConfig | null {
  const mode = normalizeMode(modeRaw);

  // Explicit `local` mode always uses the local SQLite store, even when API
  // URL/key happen to be present in the environment.
  if (mode === "local") return null;

  // Engage the self-hosted API client when the mode is explicitly self_hosted,
  // OR when any API URL/key setting is present. Missing pieces fail closed so a
  // shared deployment never silently drifts onto the machine-local SQLite store.
  const selfHostedRequested = mode === "self_hosted" || Boolean(apiUrl || apiKey);
  if (!selfHostedRequested) return null;

  if (!apiKey) {
    throw new Error(
      `${APP}: self_hosted API URL is set (HASNA_${TOKEN}_API_URL) but no API key. ` +
        `Set HASNA_${TOKEN}_API_KEY to route to self_hosted, or unset the URL to use local.`,
    );
  }
  if (!apiUrl) {
    throw new Error(
      `${APP}: self_hosted API key is set (HASNA_${TOKEN}_API_KEY) but no API URL. ` +
        `Set HASNA_${TOKEN}_API_URL to the self-hosted API base URL.`,
    );
  }

  return { baseUrl: toV1BaseUrl(apiUrl), apiKey };
}

/** True when the client is flipped to the self-hosted HTTP API. */
export function isCloudMode(): boolean {
  return resolveCloudConfig() !== null;
}

/** Reset the memoized config (tests flip env between cases). */
export function resetCloudConfigCache(): void {
  _cachedSignature = null;
  _cachedConfig = undefined;
}

interface CurlResult {
  status: number;
  body: string;
}

// Bounded timeouts so a slow/unreachable self-hosted endpoint FAILS FAST and
// LOUD instead of hanging until an external wall (the "17 then 0 / 2-minute
// wall / nondeterministic empty" bug). Overridable for very large tenants.
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
// Resolved per-call so an env override always applies (and tests can shorten it).
function connectTimeoutSeconds(): number { return positiveIntEnv("HASNA_MAILERY_HTTP_CONNECT_TIMEOUT", 10); }
function maxTimeSeconds(): number { return positiveIntEnv("HASNA_MAILERY_HTTP_TIMEOUT", 30); }

/**
 * Thrown when the curl transport itself fails (DNS/connect failure or a timeout)
 * — i.e. NO HTTP status was received. Distinct from CloudHttpError (a real HTTP
 * status the server returned) so callers never confuse "couldn't reach the
 * cloud" with "the cloud returned empty". Never carries the API key.
 */
export class CloudTransportError extends Error {
  constructor(readonly method: string, readonly path: string, detail: string) {
    super(`Cannot reach emails self_hosted API for ${method} ${path}: ${detail}`);
    this.name = "CloudTransportError";
  }
}

function httpRequest(config: CloudConfig, method: string, path: string, body?: unknown): CurlResult {
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
      throw new CloudTransportError(method, path, (proc.error as Error).message || "curl could not run");
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
      throw new CloudTransportError(method, path, detail);
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
 * Unwrap a single-entity response. The mailery API wraps entities as
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

export interface CloudResourceStore {
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
 * Return a cloud-backed store for `resource`, or null when the client is in
 * local mode. Throws (fail-closed) if cloud is requested but misconfigured.
 */
export function cloudStoreFor(resource: string): CloudResourceStore | null {
  const config = resolveCloudConfig();
  if (!config) return null;
  const clean = resource.replace(/^\/+|\/+$/g, "");
  const base = `/${clean}`;
  const singular = singularOf(clean);

  return {
    resource: clean,
    baseUrl: config.baseUrl,
    list(query) {
      const { status, body } = httpRequest(config, "GET", `${base}${encodeQuery(query)}`);
      if (status < 200 || status >= 300) throw new CloudHttpError(status, "GET", base, body);
      return extractList(parseJson(body), clean) as Record<string, unknown>[];
    },
    get(id) {
      const { status, body } = httpRequest(config, "GET", `${base}/${encodeURIComponent(id)}`);
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw new CloudHttpError(status, "GET", `${base}/${id}`, body);
      return unwrapSingle(parseJson(body), singular);
    },
    create(body) {
      const res = httpRequest(config, "POST", base, body);
      if (res.status < 200 || res.status >= 300) throw new CloudHttpError(res.status, "POST", base, res.body);
      return unwrapSingle(parseJson(res.body), singular) ?? {};
    },
    update(id, patch, method = "PATCH") {
      const res = httpRequest(config, method, `${base}/${encodeURIComponent(id)}`, patch);
      if (res.status < 200 || res.status >= 300) {
        throw new CloudHttpError(res.status, method, `${base}/${id}`, res.body);
      }
      return unwrapSingle(parseJson(res.body), singular) ?? {};
    },
    del(id) {
      const { status, body } = httpRequest(config, "DELETE", `${base}/${encodeURIComponent(id)}`);
      if (status === 404) return false;
      if (status < 200 || status >= 300) throw new CloudHttpError(status, "DELETE", `${base}/${id}`, body);
      return true;
    },
  };
}
