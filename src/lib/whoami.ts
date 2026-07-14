// Shared identity/tenant-context resolver for the self-hosted client.
//
// Calls GET /v1/me through the synchronous self-hosted transport and normalizes
// the response into an IdentityContext the CLI (`emails whoami`), MCP resources,
// and the TUI header can all consume. The active tenant is derived server-side
// from the bearer credential (a user session token or the operator API key) —
// the client never sends a tenant. No secret is logged; the token lives only in
// the transport's Authorization header.

import { selfHostedApiRequest } from "../db/self-hosted-store.js";

export interface IdentityTenant {
  id: string | null;
  slug: string | null;
  name: string | null;
}

export interface IdentityMembership {
  tenant: IdentityTenant;
  role: string | null;
}

export interface IdentityContext {
  /** How the caller authenticated. */
  principalType: "user" | "apikey" | "unknown";
  user: { id: string | null; email: string | null; name: string | null } | null;
  /** The tenant this credential is currently scoped to. */
  tenant: IdentityTenant | null;
  /** Membership role for a user session (owner/admin/member/viewer). */
  role: string | null;
  /** Derived scopes (present for API keys). */
  scopes: string[];
  /** All tenants a user belongs to (session credentials only). */
  memberships: IdentityMembership[];
}

export type IdentityResult =
  | { ok: true; identity: IdentityContext }
  | { ok: false; status: number; error: string };

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function toTenant(value: unknown): IdentityTenant | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  // The server's flat membership rows carry `tenant_id` (not `id`); accept both so
  // GET /v1/me memberships resolve a tenant id as well as a top-level tenant object.
  return { id: str(obj["id"]) ?? str(obj["tenant_id"]), slug: str(obj["slug"]), name: str(obj["name"]) };
}

function toMemberships(value: unknown): IdentityMembership[] {
  if (!Array.isArray(value)) return [];
  const out: IdentityMembership[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    // Accept either a nested `tenant` object or flat slug/name fields.
    const tenant = toTenant(obj["tenant"]) ?? toTenant(obj) ?? { id: null, slug: null, name: null };
    out.push({ tenant, role: str(obj["role"]) });
  }
  return out;
}

/** Normalize a raw GET /v1/me body into an IdentityContext. */
export function normalizeIdentity(raw: unknown): IdentityContext {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const principalRaw = str(obj["principalType"]) ?? str(obj["principal_type"]);
  const principalType: IdentityContext["principalType"] =
    principalRaw === "user" || principalRaw === "apikey"
      ? principalRaw
      : obj["user"]
        ? "user"
        : obj["kid"] || obj["scopes"]
          ? "apikey"
          : "unknown";
  const userObj = obj["user"] && typeof obj["user"] === "object" ? (obj["user"] as Record<string, unknown>) : null;
  const scopes = Array.isArray(obj["scopes"])
    ? (obj["scopes"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  return {
    principalType,
    user: userObj ? { id: str(userObj["id"]), email: str(userObj["email"]), name: str(userObj["name"]) } : null,
    tenant: toTenant(obj["tenant"]),
    role: str(obj["role"]),
    scopes,
    memberships: toMemberships(obj["memberships"]),
  };
}

/** Fetch and normalize the caller's identity. Surfaces transport/HTTP errors. */
export function fetchIdentity(): IdentityResult {
  const { status, json } = selfHostedApiRequest("GET", "/me");
  if (status < 200 || status >= 300) {
    const message = (json && typeof json === "object" && "error" in json
      ? String((json as { error?: unknown }).error ?? "")
      : "") || `GET /v1/me failed (HTTP ${status})`;
    return { ok: false, status, error: message };
  }
  return { ok: true, identity: normalizeIdentity(json) };
}

/** Fetch identity, swallowing all errors — for the MCP/TUI surfaces. */
export function fetchIdentitySafe(): IdentityContext | null {
  try {
    const result = fetchIdentity();
    return result.ok ? result.identity : null;
  } catch {
    return null;
  }
}

/** A short, human-readable label for a header/status line, e.g. "acme (owner)". */
export function describeIdentity(identity: IdentityContext | null): string {
  if (!identity) return "not signed in";
  const org = identity.tenant?.slug ?? identity.tenant?.name ?? "unknown org";
  if (identity.principalType === "apikey") return `${org} (api key)`;
  const who = identity.user?.email ?? "user";
  return identity.role ? `${who} · ${org} (${identity.role})` : `${who} · ${org}`;
}
