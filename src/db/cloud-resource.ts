// Shared client-side cloud routing for the resource repositories.
//
// The STANDARD (single Store, no per-command local fallback) requires that in
// cloud mode EVERY list/read routes to the app's `/v1` API — never the local
// SQLite island. Historically only `domains` and `addresses` did this; the other
// resource repos (contacts, providers, templates, groups, sequences, owners,
// scheduled, send-keys, sent-mail) read local SQLite unconditionally, so a
// flipped client silently returned LOCAL data for `contact list`, `provider
// list`, etc. — the split-brain bug this module closes.
//
// Fail-closed: when the client is flipped to cloud but the endpoint does not yet
// exist server-side, `cloudStoreFor(...).list()` gets an HTTP 404 and THROWS
// (CloudHttpError). It never silently degrades to the local store. Once the
// matching `/v1/<resource>` endpoint is deployed, the same call returns cloud
// data. Local mode (isCloudMode() === false) is entirely unaffected.

import { cloudStoreFor, isCloudMode, type CloudResourceStore } from "./cloud-store.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";

/**
 * Return a cloud-backed store for `resource` when the client is flipped to
 * cloud, else null (local mode — caller uses SQLite). An explicit local `db`
 * handle is intentionally ignored for routing: the CLI passes an explicit
 * `getDatabase()` to every repo call, so keying on it would defeat cloud
 * routing. Tests never set the cloud env, so this is null under test.
 */
export function cloudResource(resource: string): CloudResourceStore | null {
  if (!isCloudMode()) return null;
  return cloudStoreFor(resource);
}

export interface CloudPageOptions {
  limit?: number;
  offset?: number;
}

/** Build a bounded `{limit, offset}` query for a cloud list call. */
export function cloudListQuery(opts?: CloudPageOptions): {
  query: Record<string, string | number | boolean | undefined>;
  limit: number | null;
  offset: number;
} {
  const query: Record<string, string | number | boolean | undefined> = {};
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  if (limit !== null) query["limit"] = limit;
  if (offset) query["offset"] = offset;
  return { query, limit, offset };
}

/** Apply the same limit/offset window locally after a cloud list, for parity. */
export function cloudPage<T>(rows: T[], limit: number | null, offset: number): T[] {
  if (limit === null) return rows;
  return rows.slice(offset, offset + limit);
}

// ---- value coercion (cloud JSON -> local typed columns) --------------------

export function cstr(v: unknown): string {
  return v == null ? "" : String(v);
}

export function cstrOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}

export function cnum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function cbool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v === "true" || v === "1" || v === "t";
  return Boolean(v);
}

export function cstrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    } catch {
      return [v];
    }
  }
  return [];
}

export function carray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function cobj(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

/** now() fallback for a missing timestamp so mapped rows are always valid. */
export function ciso(v: unknown, fallback?: string): string {
  const s = cstrOrNull(v);
  return s ?? fallback ?? new Date().toISOString();
}
