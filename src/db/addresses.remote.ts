import type { AddressStatus, CreateAddressInput, EmailAddress } from "../types/index.js";
import { AddressNotFoundError } from "../types/index.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { assertHonestSelfHostedRead, enumerateSelfHostedRows } from "./self-hosted-page.js";
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

// Every list-shaped read below walks `/v1/addresses` through the shared pager
// instead of taking ONE page and calling it the table. The server windows a
// missing limit to 100 rows and caps every page at 500 (clampLimit in
// src/server/self-hosted/store.ts), so the previous single-call convention —
// `.list({ limit: 1000 })`, or no limit at all — silently returned 100 or 500
// rows of a larger table as if complete; production crossed 100 addresses long
// ago and holds 325 today. `/v1/addresses` declares no server-side filters, so
// every filter here runs in the pager's `select`, which counts a bounded
// window in rows KEPT rather than rows read.
//
// `bound` follows the contract src/db/events.remote.ts established: `null`
// means "everything", answerable only by a complete enumeration; a number
// means "the first N in the server's declared order" (`created_at DESC,
// id ASC` — total, and the same order every sort in this file applies), served
// once the window is full or the table ended first. A read that can prove
// neither REFUSES instead of returning a plausible subset.
function readAddresses(bound: number | null, keep?: (address: EmailAddress) => boolean): EmailAddress[] {
  const enumeration = enumerateSelfHostedRows<EmailAddress>(ADDRESS_RESOURCE, {
    ...(bound === null ? {} : { need: bound }),
    select: (row) => {
      const address = apiToAddress(row);
      return keep && !keep(address) ? null : address;
    },
  });
  assertHonestSelfHostedRead(enumeration, bound, {
    noun: "address",
    narrowHint: "ask for a bounded page with an explicit limit (GET /v1/addresses windows on limit/offset).",
  });
  return enumeration.rows;
}

const byNewestFirst = (a: EmailAddress, b: EmailAddress): number =>
  (b.created_at ?? "").localeCompare(a.created_at ?? "");

export function getAddressByEmail(_provider_id: string, email: string): EmailAddress | null {
  // The self-hosted model keys addresses by email (no provider dimension). Match
  // on email so `address add` dedup, get, and remove all resolve the same record.
  //
  // Bounded to ONE row: existence is the question. On a table the pager cannot
  // finish, this REFUSES rather than returning null — this null is what
  // `address add` dedupes against, and a false null mints a duplicate address.
  const target = email.trim().toLowerCase();
  const rows = readAddresses(1, (a) => a.email.trim().toLowerCase() === target);
  return rows[0] ?? null;
}

export function findAddressesByEmail(email: string): EmailAddress[] {
  const target = email.trim().toLowerCase();
  return readAddresses(null, (a) => a.email.trim().toLowerCase() === target).sort(byNewestFirst);
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
  // The window's far edge is `lim + off` because the slice below runs locally
  // after the client-side provider filter; the pager still caps every request
  // at the server's page maximum and pages to reach the edge.
  const rows = readAddresses(
    lim === null ? null : lim + off,
    provider_id ? (a) => a.provider_id === provider_id : undefined,
  );
  rows.sort(byNewestFirst);
  return lim === null ? rows : rows.slice(off, off + lim);
}

export function listAddressesByProviderIds(providerIds: Iterable<string>): EmailAddress[] {
  const ids = [...new Set([...providerIds].map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  return readAddresses(null, (a) => idSet.has(a.provider_id)).sort(
    (a, b) => a.provider_id.localeCompare(b.provider_id) || byNewestFirst(a, b),
  );
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
  const rows = readAddresses(lim === null ? null : lim + off, (a) => addressReadinessMatch(a, opts));
  rows.sort(byNewestFirst);
  return lim === null ? rows : rows.slice(off, off + lim);
}

export function countAddressesForReadiness(opts: Omit<AddressReadinessOptions, "limit" | "offset"> = {}): number {
  // A count is a claim about the WHOLE table, so it enumerates completely or
  // refuses; a count taken from one page is a lower bound published as a total.
  return readAddresses(null, (a) => addressReadinessMatch(a, opts)).length;
}

export function listAddressEmails(provider_id?: string): string[] {
  return readAddresses(null, provider_id ? (a) => a.provider_id === provider_id : undefined)
    .sort(byNewestFirst)
    .map((a) => a.email);
}

export function listActiveAddressEmails(provider_id?: string): string[] {
  return readAddresses(
    null,
    (a) => (a.status ?? "active") === "active" && (provider_id ? a.provider_id === provider_id : true),
  )
    .sort(byNewestFirst)
    .map((a) => a.email);
}

function domainOf(email: string): string | null {
  const at = email.indexOf("@");
  return at > 0 && at < email.length - 1 ? email.slice(at + 1).toLowerCase() : null;
}

// Per-domain counts are claims about the whole table (see
// countAddressesForReadiness): enumerate completely or refuse.
export function listActiveAddressCountsByDomain(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of readAddresses(null, (address) => (address.status ?? "active") === "active")) {
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
  const keep = (a: EmailAddress): boolean => {
    if ((a.status ?? "active") !== "active") return false;
    const domain = domainOf(a.email);
    return domain !== null && normalized.has(domain);
  };
  for (const a of readAddresses(null, keep)) {
    const domain = domainOf(a.email);
    if (!domain) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return counts;
}

export function getPreferredActiveAddressEmail(opts?: { provider_id?: string; domain?: string }): string | null {
  const domain = opts?.domain?.toLowerCase();
  // The ranking puts `verified` above recency, which is NOT the server's list
  // order, so the best row can sit anywhere in the table: this read cannot be
  // bounded and must see everything before it may pick.
  const match = readAddresses(
    null,
    (a) =>
      (a.status ?? "active") === "active" &&
      (opts?.provider_id ? a.provider_id === opts.provider_id : true) &&
      (domain ? domainOf(a.email) === domain : true),
  ).sort((a, b) => Number(b.verified) - Number(a.verified) || byNewestFirst(a, b))[0];
  return match?.email ?? null;
}

export function listUsableSendingAddresses(opts?: { limit?: number }): EmailAddress[] {
  const limit = typeof opts?.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
    ? Math.floor(opts.limit)
    : null;
  const rows = readAddresses(limit, (a) => a.verified && (a.status ?? "active") !== "suspended");
  rows.sort(byNewestFirst);
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
