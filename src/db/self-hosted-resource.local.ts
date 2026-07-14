// Shared client-side selfHosted routing for the resource repositories.
//
// The STANDARD (single Store, no per-command local fallback) requires that in
// selfHosted mode EVERY list/read routes to the app's `/v1` API — never the local
// SQLite island. Historically only `domains` and `addresses` did this; the other
// resource repos (contacts, providers, templates, groups, sequences, owners,
// scheduled, send-keys, sent-mail) read local SQLite unconditionally, so a
// flipped client silently returned LOCAL data for `contact list`, `provider
// list`, etc. — the split-brain bug this module closes.
//
// Fail-closed: when the client is flipped to selfHosted but the endpoint does not yet
// exist server-side, `selfHostedStoreFor(...).list()` gets an HTTP 404 and THROWS
// (SelfHostedHttpError). It never silently degrades to the local store. Once the
// matching `/v1/<resource>` endpoint is deployed, the same call returns selfHosted
// data. Local mode (isSelfHostedMode() === false) is entirely unaffected.

import { selfHostedStoreFor, isSelfHostedMode, type SelfHostedResourceStore } from "./self-hosted-store.js";
import { isExplicitDatabaseRoute } from "./database-routing.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";

/**
 * Return a selfHosted-backed store for `resource` when the client is flipped to
 * selfHosted, else null (local mode — caller uses SQLite). Routed public calls
 * with an explicit Database are scoped locally and never consult this store.
 */
export function selfHostedResource(resource: string): SelfHostedResourceStore | null {
  if (isExplicitDatabaseRoute()) return null;
  if (!isSelfHostedMode()) return null;
  return selfHostedStoreFor(resource);
}

export interface SelfHostedPageOptions {
  limit?: number;
  offset?: number;
}

/** Build a bounded `{limit, offset}` query for a selfHosted list call. */
export function selfHostedListQuery(opts?: SelfHostedPageOptions): {
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

/** Apply the same limit/offset window locally after a selfHosted list, for parity. */
export function selfHostedPage<T>(rows: T[], limit: number | null, offset: number): T[] {
  if (limit === null) return rows;
  return rows.slice(offset, offset + limit);
}

// ---- value coercion (selfHosted JSON -> local typed columns) --------------------

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
