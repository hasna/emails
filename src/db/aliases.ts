/**
 * Per-domain aliases and catch-all routing. An alias maps a recipient
 * local-part on a domain to a target (owned) address; a catch-all maps every
 * otherwise-unmatched recipient on a domain. There is also a single GLOBAL
 * catch-all (domain `*`) that catches mail for every domain — it is `protected`
 * and can never be deleted, so no inbound is ever dropped.
 *
 * Resolution order: specific alias → domain catch-all → global catch-all.
 *
 * Self-hosted-ONLY: every read/write routes to the operator's `/v1/aliases` API.
 */
import { now, uuid } from "./runtime.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { selfHostedResource, cbool, ciso, cstr } from "./self-hosted-resource.js";

const ALIAS_RESOURCE = "aliases";

/** Sentinel local-part used to represent a catch-all. */
export const CATCH_ALL = "*";
/** Sentinel domain used to represent "all domains". */
export const ALL_DOMAINS = "*";

export interface Alias {
  id: string;
  domain: string;
  local_part: string;
  target_address: string;
  protected: boolean;
  created_at: string;
  updated_at: string;
}

export interface ListAliasOptions {
  limit?: number;
  offset?: number;
}

function apiToAlias(e: Record<string, unknown>): Alias {
  const updatedAt = ciso(e["updated_at"]);
  return {
    id: cstr(e["id"]),
    domain: cstr(e["domain"]),
    local_part: cstr(e["local_part"]),
    target_address: cstr(e["target_address"]),
    protected: cbool(e["protected"]),
    created_at: ciso(e["created_at"], updatedAt),
    updated_at: updatedAt,
  };
}

function splitAddress(address: string): { local_part: string; domain: string } {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) {
    throw new Error(`Invalid email address (expected local@domain): ${address}`);
  }
  return { local_part: address.slice(0, at).toLowerCase(), domain: address.slice(at + 1).toLowerCase() };
}

/** Default ordering: global catch-all first, then by domain, then local-part. */
function compareAliases(a: Alias, b: Alias): number {
  return (
    Number(b.domain === "*") - Number(a.domain === "*") ||
    a.domain.localeCompare(b.domain) ||
    a.local_part.localeCompare(b.local_part)
  );
}

function upsert(domain: string, localPart: string, target: string, isProtected = false): Alias {
  const store = selfHostedResource(ALIAS_RESOURCE);
  const existing = store.list({ limit: 1000 }).map(apiToAlias).find((a) => a.domain === domain && a.local_part === localPart);
  if (existing) {
    return apiToAlias(store.update(existing.id, { target_address: target, updated_at: now() }));
  }
  const id = uuid();
  const ts = now();
  return apiToAlias(store.create({
    id,
    domain,
    local_part: localPart,
    target_address: target,
    protected: isProtected,
    created_at: ts,
    updated_at: ts,
  }));
}

/** Create (or update) a specific alias: `alias@domain` → `target`. */
export function createAlias(aliasAddress: string, target: string): Alias {
  const { local_part, domain } = splitAddress(aliasAddress);
  return upsert(domain, local_part, target.toLowerCase());
}

/** Create (or update) a catch-all for `domain` → `target`. */
export function createCatchAll(domain: string, target: string): Alias {
  return upsert(domain.toLowerCase(), CATCH_ALL, target.toLowerCase());
}

/** Create (or update) the GLOBAL catch-all (all domains) → `target`. Protected. */
export function setGlobalCatchAll(target: string): Alias {
  return upsert(ALL_DOMAINS, CATCH_ALL, target.toLowerCase(), true);
}

/**
 * Ensure the protected global catch-all exists (target defaults to empty = keep
 * everything, no rewrite). Idempotent — safe to call on every startup.
 */
export function ensureDefaultCatchAll(): Alias {
  const existing = getGlobalCatchAll();
  if (existing) return existing;
  return upsert(ALL_DOMAINS, CATCH_ALL, "", true);
}

export function getGlobalCatchAll(): Alias | null {
  const match = selfHostedResource(ALIAS_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToAlias)
    .find((a) => a.domain === ALL_DOMAINS && a.local_part === CATCH_ALL);
  return match ?? null;
}

export function getAlias(id: string): Alias | null {
  const record = selfHostedResource(ALIAS_RESOURCE).get(id);
  return record ? apiToAlias(record) : null;
}

export function listAliases(domain?: string, opts?: ListAliasOptions): Alias[] {
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  let rows = selfHostedResource(ALIAS_RESOURCE).list({ limit: 1000 }).map(apiToAlias);
  if (domain) {
    const target = domain.toLowerCase();
    rows = rows.filter((a) => a.domain === target).sort((a, b) => a.local_part.localeCompare(b.local_part));
  } else {
    rows.sort(compareAliases);
  }
  return limit === null ? rows : rows.slice(offset, offset + limit);
}

/** List aliases that route to any of the given target addresses. */
export function listAliasesByTargets(targets: Iterable<string>): Alias[] {
  const normalized = new Set([...targets].map((target) => target.trim().toLowerCase()).filter(Boolean));
  if (normalized.size === 0) return [];
  return selfHostedResource(ALIAS_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToAlias)
    .filter((a) => normalized.has(a.target_address.toLowerCase()))
    .sort(compareAliases);
}

/** Remove an alias. Refuses to delete a protected one (the global catch-all). */
export function removeAlias(id: string): boolean {
  const a = getAlias(id);
  if (!a) return false;
  if (a.protected) throw new Error("This catch-all is protected and cannot be deleted.");
  return selfHostedResource(ALIAS_RESOURCE).del(id);
}

/**
 * Resolve a recipient address to its target via aliases:
 *   specific alias → domain catch-all → global catch-all.
 * Returns null when nothing matches (or the matched catch-all has no target).
 */
export function resolveAlias(recipient: string): string | null {
  let local_part: string, domain: string;
  try { ({ local_part, domain } = splitAddress(recipient)); } catch { return null; }
  const rows = selfHostedResource(ALIAS_RESOURCE).list({ limit: 1000 }).map(apiToAlias);
  const q = (dom: string, lp: string) =>
    rows.find((a) => a.domain === dom && a.local_part === lp)?.target_address || null;
  return q(domain, local_part) || q(domain, CATCH_ALL) || q(ALL_DOMAINS, CATCH_ALL) || null;
}
