import type { AddressStatus, CreateAddressInput, EmailAddress } from "../types/index.js";
import { AddressNotFoundError } from "../types/index.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { selfHostedResource } from "./self-hosted-resource.js";
import type { SelfHostedResourceStore } from "./self-hosted-store.js";

// ============================================================================
// Self-hosted (self_hosted) routing — self-hosted-ONLY client
// ============================================================================
//
// Every address read/write routes to the operator's `/v1/addresses` API. There
// is no local SQLite island. The `/v1` address entity carries
// {id, email, display_name, status, verified, owner_id, administrator_id,
// daily_quota, created_at, updated_at}; provider/quota fields not modelled over
// /v1 default to null and enrich to "-" in the CLI.
export const ADDRESS_RESOURCE = "addresses";

export function selfHostedAddresses(): SelfHostedResourceStore {
  return selfHostedResource(ADDRESS_RESOURCE);
}

/** Map a self-hosted API address entity to the local EmailAddress shape (defaults filled). */
export function apiToAddress(e: Record<string, unknown>): EmailAddress {
  const str = (v: unknown): string | null => (v == null ? null : String(v));
  const updatedAt = str(e["updated_at"]) ?? new Date().toISOString();
  const createdAt = str(e["created_at"]) ?? updatedAt;
  const status: AddressStatus = str(e["status"]) === "suspended" ? "suspended" : "active";
  const quota = e["daily_quota"];
  return {
    id: String(e["id"]),
    provider_id: str(e["provider_id"] ?? e["provider"]) ?? "",
    email: String(e["email"] ?? ""),
    display_name: str(e["display_name"]),
    verified: Boolean(e["verified"]),
    owner_id: str(e["owner_id"]),
    administrator_id: str(e["administrator_id"]),
    status,
    daily_quota: quota == null ? null : Number(quota),
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export function createAddress(input: CreateAddressInput): EmailAddress {
  const created = apiToAddress(
    selfHostedAddresses().create({ email: input.email, display_name: input.display_name || null }),
  );
  // The self-hosted address model does not persist provider_id; carry the
  // caller's provider through on the returned entity so command output is right.
  return { ...created, provider_id: input.provider_id };
}

export function getAddress(id: string): EmailAddress | null {
  const e = selfHostedAddresses().get(id);
  return e ? apiToAddress(e) : null;
}

export function getAddressByEmail(_provider_id: string, email: string): EmailAddress | null {
  // The self-hosted model keys addresses by email (no provider dimension). Match
  // on email so `address add` dedup, get, and remove all resolve the same record.
  const target = email.trim().toLowerCase();
  const found = selfHostedAddresses().list({ limit: 1000 }).map(apiToAddress).find((a) => a.email.trim().toLowerCase() === target);
  return found ?? null;
}

export function findAddressesByEmail(email: string): EmailAddress[] {
  const target = email.trim().toLowerCase();
  return selfHostedAddresses()
    .list({ limit: 1000 })
    .map(apiToAddress)
    .filter((a) => a.email.trim().toLowerCase() === target)
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

export interface ListAddressOptions {
  limit?: number;
  offset?: number;
}

export interface AddressReadinessOptions extends ListAddressOptions {
  provider_id?: string;
  owner_id?: string;
  send?: boolean;
  receive?: boolean;
  include_unverified?: boolean;
}

export function listAddresses(provider_id?: string, opts?: ListAddressOptions): EmailAddress[] {
  const lim = safeOptionalLimit(opts?.limit);
  const off = safeOffset(opts?.offset);
  const query: Record<string, string | number | undefined> = {};
  if (lim !== null) query["limit"] = Math.max(1000, lim + off);
  let addresses = selfHostedAddresses().list(query).map(apiToAddress);
  if (provider_id) addresses = addresses.filter((a) => a.provider_id === provider_id);
  addresses.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return lim === null ? addresses : addresses.slice(off, off + lim);
}

export function listAddressesByProviderIds(providerIds: Iterable<string>): EmailAddress[] {
  const ids = [...new Set([...providerIds].map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  return selfHostedAddresses()
    .list({ limit: 1000 })
    .map(apiToAddress)
    .filter((a) => idSet.has(a.provider_id))
    .sort((a, b) => a.provider_id.localeCompare(b.provider_id) || (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

// Readiness over /v1: the rich local domain-lifecycle join (DKIM/SPF/provisioning
// readiness) is not modelled on the /v1 address entity, so send-readiness keys
// off `verified` + not-suspended and receive-readiness keys off not-suspended
// (the operator configures inbound server-side).
function addressReadinessMatch(a: EmailAddress, opts: AddressReadinessOptions): boolean {
  if (opts.provider_id && a.provider_id !== opts.provider_id) return false;
  if (opts.owner_id && a.owner_id !== opts.owner_id && a.administrator_id !== opts.owner_id) return false;
  const notSuspended = (a.status ?? "active") !== "suspended";
  const sendReady = notSuspended && a.verified;
  const receiveReady = notSuspended;
  if (!opts.include_unverified && !sendReady) return false;
  if (opts.send && !sendReady) return false;
  if (opts.receive && !receiveReady) return false;
  return true;
}

export function listAddressesForReadiness(opts: AddressReadinessOptions = {}): EmailAddress[] {
  const lim = safeOptionalLimit(opts.limit);
  const off = safeOffset(opts.offset);
  const addresses = selfHostedAddresses()
    .list({ limit: 1000 })
    .map(apiToAddress)
    .filter((a) => addressReadinessMatch(a, opts))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return lim === null ? addresses : addresses.slice(off, off + lim);
}

export function countAddressesForReadiness(opts: Omit<AddressReadinessOptions, "limit" | "offset"> = {}): number {
  return selfHostedAddresses()
    .list({ limit: 1000 })
    .map(apiToAddress)
    .filter((a) => addressReadinessMatch(a, opts)).length;
}

export function listAddressEmails(provider_id?: string): string[] {
  return selfHostedAddresses()
    .list({ limit: 1000 })
    .map(apiToAddress)
    .filter((a) => (provider_id ? a.provider_id === provider_id : true))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .map((a) => a.email);
}

export function listActiveAddressEmails(provider_id?: string): string[] {
  return selfHostedAddresses()
    .list({ limit: 1000 })
    .map(apiToAddress)
    .filter((a) => (a.status ?? "active") === "active")
    .filter((a) => (provider_id ? a.provider_id === provider_id : true))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .map((a) => a.email);
}

function domainOf(email: string): string | null {
  const at = email.indexOf("@");
  return at > 0 && at < email.length - 1 ? email.slice(at + 1).toLowerCase() : null;
}

export function listActiveAddressCountsByDomain(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of selfHostedAddresses().list({ limit: 1000 }).map(apiToAddress)) {
    if ((a.status ?? "active") !== "active") continue;
    const domain = domainOf(a.email);
    if (!domain) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return counts;
}

export function listActiveAddressCountsByDomains(domains: Iterable<string>): Map<string, number> {
  const normalized = new Set([...domains].map((domain) => domain.trim().toLowerCase()).filter(Boolean));
  if (normalized.size === 0) return new Map();
  const counts = new Map<string, number>();
  for (const a of selfHostedAddresses().list({ limit: 1000 }).map(apiToAddress)) {
    if ((a.status ?? "active") !== "active") continue;
    const domain = domainOf(a.email);
    if (!domain || !normalized.has(domain)) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return counts;
}

export function getPreferredActiveAddressEmail(opts?: { provider_id?: string; domain?: string }): string | null {
  const domain = opts?.domain?.toLowerCase();
  const match = selfHostedAddresses()
    .list({ limit: 1000 })
    .map(apiToAddress)
    .filter((a) => (a.status ?? "active") === "active")
    .filter((a) => (opts?.provider_id ? a.provider_id === opts.provider_id : true))
    .filter((a) => (domain ? domainOf(a.email) === domain : true))
    .sort((a, b) =>
      Number(b.verified) - Number(a.verified) || (b.created_at ?? "").localeCompare(a.created_at ?? ""),
    )[0];
  return match?.email ?? null;
}

export function listUsableSendingAddresses(opts?: { limit?: number }): EmailAddress[] {
  const limit = typeof opts?.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
    ? Math.floor(opts.limit)
    : null;
  const rows = selfHostedAddresses()
    .list({ limit: 1000 })
    .map(apiToAddress)
    .filter((a) => a.verified && (a.status ?? "active") !== "suspended")
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return limit === null ? rows : rows.slice(0, limit);
}

export function updateAddress(
  id: string,
  input: Partial<Pick<EmailAddress, "display_name" | "verified">>,
): EmailAddress {
  const store = selfHostedAddresses();
  if (!store.get(id)) throw new AddressNotFoundError(id);
  const patch: Record<string, unknown> = {};
  if (input.display_name !== undefined) patch["display_name"] = input.display_name || null;
  if (input.verified !== undefined) patch["verified"] = input.verified;
  return apiToAddress(store.update(id, patch));
}

export function deleteAddress(id: string): boolean {
  return selfHostedAddresses().del(id);
}

export function markVerified(id: string): EmailAddress {
  const store = selfHostedAddresses();
  if (!store.get(id)) throw new AddressNotFoundError(id);
  return apiToAddress(store.update(id, { verified: true }));
}
