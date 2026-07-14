import type {
  Domain,
  DnsStatus,
  DomainMonitoringStatus,
  DomainOwnershipStatus,
  DomainRouteStatus,
  DomainSourceOfTruth,
  DomainType,
} from "../types/index.js";
import { DomainNotFoundError } from "../types/index.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { selfHostedResource } from "./self-hosted-resource.js";

// ============================================================================
// Self-hosted (self_hosted) routing — self-hosted-ONLY client
// ============================================================================
//
// Every domain read/write routes to the operator's `/v1/domains` API. There is
// no local SQLite island. The `/v1` domain entity is intentionally minimal
// (id, domain, provider, verified, timestamps); the rich local Domain shape is
// reconstructed with sensible defaults by apiToDomain().
const DOMAIN_RESOURCE = "domains";

/** Map a self-hosted API domain entity to the local rich Domain shape (defaults filled). */
function apiToDomain(e: Record<string, unknown>): Domain {
  const str = (v: unknown): string | null => (v == null ? null : String(v));
  const verified = Boolean(e["verified"]);
  const dns: DnsStatus = verified ? "verified" : "pending";
  const updatedAt = str(e["updated_at"]) ?? new Date().toISOString();
  const createdAt = str(e["created_at"]) ?? updatedAt;
  return {
    id: String(e["id"]),
    provider_id: str(e["provider"] ?? e["provider_id"]) ?? "self_hosted",
    domain: String(e["domain"] ?? ""),
    domain_type: "self_hosted",
    source_of_truth: "postgres",
    ownership_status: verified ? "verified" : "pending",
    inbound_status: "pending",
    outbound_status: "pending",
    monitoring_status: "none",
    dkim_status: dns,
    spf_status: dns,
    dmarc_status: dns,
    dns_records: {},
    provider_metadata: {},
    verified_at: verified ? updatedAt : null,
    last_dns_check_at: null,
    last_inbound_check_at: null,
    last_outbound_check_at: null,
    last_monitored_at: null,
    restricted_at: null,
    suspended_at: null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export function createDomain(provider_id: string, domain: string): Domain {
  const created = selfHostedResource(DOMAIN_RESOURCE).create({ domain, provider: provider_id });
  return apiToDomain(created);
}

export function getDomain(id: string): Domain | null {
  const entity = selfHostedResource(DOMAIN_RESOURCE).get(id);
  return entity ? apiToDomain(entity) : null;
}

export function getDomainByName(_provider_id: string, domain: string): Domain | null {
  // A self-hosted deployment is one operator-owned instance; match by domain
  // name because the local provider row is not part of the service identity.
  const name = domain.trim().toLowerCase();
  const match = selfHostedResource(DOMAIN_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToDomain)
    .find((dm) => dm.domain.toLowerCase() === name);
  return match ?? null;
}

export function findDomainsByName(domain: string): Domain[] {
  const name = domain.trim().toLowerCase();
  return selfHostedResource(DOMAIN_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToDomain)
    .filter((dm) => dm.domain.toLowerCase() === name)
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

export interface DomainProviderName {
  provider_id: string;
  domain: string;
}

export function listDomainsByProviderAndNames(pairs: Iterable<DomainProviderName>): Domain[] {
  const wanted = new Set(
    [...pairs]
      .map((pair) => pair.domain.trim().toLowerCase())
      .filter(Boolean),
  );
  if (wanted.size === 0) return [];
  return selfHostedResource(DOMAIN_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToDomain)
    .filter((dm) => wanted.has(dm.domain.toLowerCase()))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

export interface ListDomainOptions {
  limit?: number;
  offset?: number;
}

export interface UsableDomainOptions extends ListDomainOptions {
  provider_id?: string;
  send?: boolean;
  receive?: boolean;
}

export function listDomains(provider_id?: string, opts?: ListDomainOptions): Domain[] {
  const lim = safeOptionalLimit(opts?.limit);
  const off = safeOffset(opts?.offset);
  const query: Record<string, string | number | undefined> = {};
  if (lim !== null) query["limit"] = Math.max(1000, lim + off);
  let domains = selfHostedResource(DOMAIN_RESOURCE).list(query).map(apiToDomain);
  if (provider_id) domains = domains.filter((dm) => dm.provider_id === provider_id);
  domains.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return lim === null ? domains : domains.slice(off, off + lim);
}

export function listDomainsByProviderIds(providerIds: Iterable<string>): Domain[] {
  const ids = new Set([...providerIds].map((id) => id.trim()).filter(Boolean));
  if (ids.size === 0) return [];
  return selfHostedResource(DOMAIN_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToDomain)
    .filter((dm) => ids.has(dm.provider_id))
    .sort((a, b) => a.provider_id.localeCompare(b.provider_id) || (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

// "Usable" in the self-hosted model: a verified domain sends and receives (the
// operator configures inbound/outbound on the server). The rich local readiness
// columns do not exist over /v1, so send/receive both key off `verified`.
function usableFilter(dm: Domain, opts: UsableDomainOptions): boolean {
  if (opts.provider_id && dm.provider_id !== opts.provider_id) return false;
  return dm.ownership_status === "verified" || dm.dkim_status === "verified";
}

export function listUsableDomains(opts: UsableDomainOptions = {}): Domain[] {
  const lim = safeOptionalLimit(opts.limit);
  const off = safeOffset(opts.offset);
  const domains = selfHostedResource(DOMAIN_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToDomain)
    .filter((dm) => usableFilter(dm, opts))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return lim === null ? domains : domains.slice(off, off + lim);
}

export function countUsableDomains(opts: Omit<UsableDomainOptions, "limit" | "offset"> = {}): number {
  return selfHostedResource(DOMAIN_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToDomain)
    .filter((dm) => usableFilter(dm, opts)).length;
}

export function updateDomain(
  id: string,
  input: Partial<Pick<Domain, "dkim_status" | "spf_status" | "dmarc_status" | "verified_at">>,
): Domain {
  const store = selfHostedResource(DOMAIN_RESOURCE);
  const current = store.get(id);
  if (!current) throw new DomainNotFoundError(id);
  const verified =
    input.verified_at != null ||
    (input.dkim_status === "verified" && input.spf_status === "verified" && input.dmarc_status === "verified");
  const updated = verified ? store.update(id, { verified: true }) : current;
  return apiToDomain(updated);
}

export interface DomainReadinessUpdate {
  domain_type?: DomainType;
  source_of_truth?: DomainSourceOfTruth;
  ownership_status?: DomainOwnershipStatus;
  inbound_status?: DomainRouteStatus;
  outbound_status?: DomainRouteStatus;
  monitoring_status?: DomainMonitoringStatus;
  dns_records?: Record<string, unknown>;
  provider_metadata?: Record<string, unknown>;
  last_dns_check_at?: string | null;
  last_inbound_check_at?: string | null;
  last_outbound_check_at?: string | null;
  last_monitored_at?: string | null;
  restricted_at?: string | null;
  suspended_at?: string | null;
}

export function updateDomainReadiness(id: string, _input: DomainReadinessUpdate): Domain {
  // The /v1 domain schema does not carry the local lifecycle/readiness fields;
  // return the current record so callers (e.g. `domain add`) still get a Domain.
  const current = selfHostedResource(DOMAIN_RESOURCE).get(id);
  if (!current) throw new DomainNotFoundError(id);
  return apiToDomain(current);
}

export interface MoveDomainProviderResult {
  domain: Domain;
  from_provider_id: string;
  to_provider_id: string;
  moved_addresses: number;
}

export function moveDomainProvider(id: string, toProviderId: string): MoveDomainProviderResult {
  const store = selfHostedResource(DOMAIN_RESOURCE);
  const current = store.get(id);
  if (!current) throw new DomainNotFoundError(id);
  const domain = apiToDomain(current);
  if (domain.provider_id === toProviderId) {
    return { domain, from_provider_id: domain.provider_id, to_provider_id: toProviderId, moved_addresses: 0 };
  }
  const updated = apiToDomain(store.update(id, { provider: toProviderId }));
  // Server owns address reassignment in the self-hosted model.
  return { domain: updated, from_provider_id: domain.provider_id, to_provider_id: toProviderId, moved_addresses: 0 };
}

export function deleteDomain(id: string): boolean {
  return selfHostedResource(DOMAIN_RESOURCE).del(id);
}

export function updateDnsStatus(id: string, dkim: DnsStatus, spf: DnsStatus, dmarc: DnsStatus): Domain {
  const store = selfHostedResource(DOMAIN_RESOURCE);
  const current = store.get(id);
  if (!current) throw new DomainNotFoundError(id);
  const allVerified = dkim === "verified" && spf === "verified" && dmarc === "verified";
  const updated = allVerified ? store.update(id, { verified: true }) : current;
  return apiToDomain(updated);
}
