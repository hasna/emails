/**
 * Provisioning DB layer — lifecycle fields for automated domain/address
 * provisioning plus an append-only audit trail (provisioning_events).
 *
 * Self-hosted-ONLY. The provisioning STATE fields live as columns on the
 * `domains` and `addresses` entities and are read/written directly over
 * `/v1/domains/<id>` and `/v1/addresses/<id>` (the local Domain/EmailAddress
 * repo mappers intentionally drop these lifecycle columns, so this module reads
 * the raw entities). The append-only event trail routes to `/v1/provisioning`.
 * The daemon "due work" queue is derived client-side by listing domains and
 * addresses and filtering on provisioning_status + next_check_at.
 */

import { now, uuid } from "./runtime.js";
import type { DomainState, AddressState } from "../lib/provision/state-machine.js";
import { parseJsonArray } from "./json.js";
import { selfHostedResource, cobj, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const DOMAIN_RESOURCE = "domains";
const ADDRESS_RESOURCE = "addresses";
const PROVISIONING_RESOURCE = "provisioning";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Terminal states never re-enter the daemon queue. */
export const TERMINAL_STATES = ["ready", "failed", "none"] as const;
const TERMINAL_SET = new Set<string>(TERMINAL_STATES);

/**
 * Persisted provisioning status. The canonical state names come from the
 * state machine (src/lib/provision/state-machine.ts); `none` is the
 * not-yet-started default for rows that were never enrolled in provisioning.
 */
export type DomainProvisioningStatus = DomainState | "none";

export type AddressProvisioningStatus = AddressState | "none";

export type ReceiveStrategy = "ses-s3" | "cf-routing" | "resend-webhook";

export interface DomainProvisioning {
  provisioning_status: DomainProvisioningStatus;
  purchase_provider: string | null;
  dns_provider: string;
  send_provider: string | null;
  cf_zone_id: string | null;
  registrar: string | null;
  nameservers: string[];
  mail_from_domain: string | null;
  last_error: string | null;
  next_check_at: string | null;
}

export interface DomainProvisioningInput {
  provisioning_status?: DomainProvisioningStatus;
  purchase_provider?: string | null;
  dns_provider?: string;
  send_provider?: string | null;
  cf_zone_id?: string | null;
  registrar?: string | null;
  nameservers?: string[];
  mail_from_domain?: string | null;
  last_error?: string | null;
  next_check_at?: string | null;
}

export interface AddressProvisioning {
  domain_id: string | null;
  receive_strategy: ReceiveStrategy | null;
  forward_to: string | null;
  routing_rule_id: string | null;
  provisioning_status: AddressProvisioningStatus;
  last_validated_at: string | null;
  last_error: string | null;
  next_check_at: string | null;
}

export interface AddressProvisioningInput {
  domain_id?: string | null;
  receive_strategy?: ReceiveStrategy | null;
  forward_to?: string | null;
  routing_rule_id?: string | null;
  provisioning_status?: AddressProvisioningStatus;
  last_validated_at?: string | null;
  last_error?: string | null;
  next_check_at?: string | null;
}

export interface ProvisioningEvent {
  id: string;
  entity_type: "domain" | "address";
  entity_id: string;
  from_state: string | null;
  to_state: string;
  detail: Record<string, unknown>;
  created_at: string;
}

// ─── Domain provisioning ────────────────────────────────────────────────────

function nameserversOf(e: Record<string, unknown>): string[] {
  if (Array.isArray(e["nameservers"])) return e["nameservers"].map((x) => String(x));
  return parseJsonArray<string>(cstrOrNull(e["nameservers_json"]));
}

function rowToDomainProvisioning(e: Record<string, unknown>): DomainProvisioning {
  return {
    provisioning_status: (cstr(e["provisioning_status"]) || "none") as DomainProvisioningStatus,
    purchase_provider: cstrOrNull(e["purchase_provider"]),
    dns_provider: cstr(e["dns_provider"]),
    send_provider: cstrOrNull(e["send_provider"]),
    cf_zone_id: cstrOrNull(e["cf_zone_id"]),
    registrar: cstrOrNull(e["registrar"]),
    nameservers: nameserversOf(e),
    mail_from_domain: cstrOrNull(e["mail_from_domain"]),
    last_error: cstrOrNull(e["last_error"]),
    next_check_at: cstrOrNull(e["next_check_at"]),
  };
}

export function getDomainProvisioning(id: string): DomainProvisioning | null {
  const record = selfHostedResource(DOMAIN_RESOURCE).get(id);
  if (!record) return null;
  return rowToDomainProvisioning(record);
}

export function listDomainProvisioningById(): Map<string, DomainProvisioning> {
  const rows = selfHostedResource(DOMAIN_RESOURCE).list({ limit: 1000 });
  return new Map(rows.map((row) => [cstr(row["id"]), rowToDomainProvisioning(row)]));
}

export function listDomainProvisioningByIds(domainIds: Iterable<string>): Map<string, DomainProvisioning> {
  const ids = new Set([...domainIds].map((id) => id.trim()).filter(Boolean));
  if (ids.size === 0) return new Map();
  return new Map(
    selfHostedResource(DOMAIN_RESOURCE)
      .list({ limit: 1000 })
      .filter((row) => ids.has(cstr(row["id"])))
      .map((row) => [cstr(row["id"]), rowToDomainProvisioning(row)]),
  );
}

export function setDomainProvisioning(
  id: string,
  input: DomainProvisioningInput,
): DomainProvisioning | null {
  const patch: Record<string, unknown> = {};
  if (input.provisioning_status !== undefined) patch["provisioning_status"] = input.provisioning_status;
  if (input.purchase_provider !== undefined) patch["purchase_provider"] = input.purchase_provider;
  if (input.dns_provider !== undefined) patch["dns_provider"] = input.dns_provider;
  if (input.send_provider !== undefined) patch["send_provider"] = input.send_provider;
  if (input.cf_zone_id !== undefined) patch["cf_zone_id"] = input.cf_zone_id;
  if (input.registrar !== undefined) patch["registrar"] = input.registrar;
  if (input.nameservers !== undefined) patch["nameservers_json"] = JSON.stringify(input.nameservers);
  if (input.mail_from_domain !== undefined) patch["mail_from_domain"] = input.mail_from_domain;
  if (input.last_error !== undefined) patch["last_error"] = input.last_error;
  if (input.next_check_at !== undefined) patch["next_check_at"] = input.next_check_at;
  patch["updated_at"] = now();
  selfHostedResource(DOMAIN_RESOURCE).update(id, patch);
  return getDomainProvisioning(id);
}

// ─── Address provisioning ───────────────────────────────────────────────────

function rowToAddressProvisioning(e: Record<string, unknown>): AddressProvisioning {
  return {
    domain_id: cstrOrNull(e["domain_id"]),
    receive_strategy: cstrOrNull(e["receive_strategy"]) as ReceiveStrategy | null,
    forward_to: cstrOrNull(e["forward_to"]),
    routing_rule_id: cstrOrNull(e["routing_rule_id"]),
    provisioning_status: (cstr(e["provisioning_status"]) || "none") as AddressProvisioningStatus,
    last_validated_at: cstrOrNull(e["last_validated_at"]),
    last_error: cstrOrNull(e["last_error"]),
    next_check_at: cstrOrNull(e["next_check_at"]),
  };
}

export function getAddressProvisioning(id: string): AddressProvisioning | null {
  const record = selfHostedResource(ADDRESS_RESOURCE).get(id);
  if (!record) return null;
  return rowToAddressProvisioning(record);
}

export function listAddressProvisioningById(): Map<string, AddressProvisioning> {
  const rows = selfHostedResource(ADDRESS_RESOURCE).list({ limit: 1000 });
  return new Map(rows.map((row) => [cstr(row["id"]), rowToAddressProvisioning(row)]));
}

export function listAddressProvisioningByIds(addressIds: Iterable<string>): Map<string, AddressProvisioning> {
  const ids = new Set([...addressIds].map((id) => id.trim()).filter(Boolean));
  if (ids.size === 0) return new Map();
  return new Map(
    selfHostedResource(ADDRESS_RESOURCE)
      .list({ limit: 1000 })
      .filter((row) => ids.has(cstr(row["id"])))
      .map((row) => [cstr(row["id"]), rowToAddressProvisioning(row)]),
  );
}

export interface AddressProvisioningByDomain {
  id: string;
  email: string;
  provisioning: AddressProvisioning;
}

function rowToAddressProvisioningByDomain(row: Record<string, unknown>): AddressProvisioningByDomain {
  return { id: cstr(row["id"]), email: cstr(row["email"]), provisioning: rowToAddressProvisioning(row) };
}

function groupAddressesByDomain(rows: Record<string, unknown>[]): Map<string, AddressProvisioningByDomain[]> {
  const withDomain = rows
    .filter((row) => cstrOrNull(row["domain_id"]))
    .sort((a, b) => cstr(b["created_at"]).localeCompare(cstr(a["created_at"])));
  const byDomain = new Map<string, AddressProvisioningByDomain[]>();
  for (const row of withDomain) {
    const domainId = cstrOrNull(row["domain_id"]);
    if (!domainId) continue;
    const items = byDomain.get(domainId) ?? [];
    items.push(rowToAddressProvisioningByDomain(row));
    byDomain.set(domainId, items);
  }
  return byDomain;
}

export function listAddressProvisioningByDomain(): Map<string, AddressProvisioningByDomain[]> {
  return groupAddressesByDomain(selfHostedResource(ADDRESS_RESOURCE).list({ limit: 1000 }));
}

export function listAddressProvisioningByDomains(domainIds: Iterable<string>): Map<string, AddressProvisioningByDomain[]> {
  const ids = new Set([...domainIds].map((id) => id.trim()).filter(Boolean));
  if (ids.size === 0) return new Map();
  const rows = selfHostedResource(ADDRESS_RESOURCE)
    .list({ limit: 1000 })
    .filter((row) => {
      const domainId = cstrOrNull(row["domain_id"]);
      return domainId != null && ids.has(domainId);
    });
  return groupAddressesByDomain(rows);
}

export function listAddressProvisioningForDomain(domainId: string): AddressProvisioningByDomain[] {
  return selfHostedResource(ADDRESS_RESOURCE)
    .list({ limit: 1000 })
    .filter((row) => cstrOrNull(row["domain_id"]) === domainId)
    .sort((a, b) => cstr(b["created_at"]).localeCompare(cstr(a["created_at"])))
    .map(rowToAddressProvisioningByDomain);
}

export function listReadyAddressCountsByDomain(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of selfHostedResource(ADDRESS_RESOURCE).list({ limit: 1000 })) {
    const domainId = cstrOrNull(row["domain_id"]);
    if (!domainId || cstr(row["provisioning_status"]) !== "ready") continue;
    counts.set(domainId, (counts.get(domainId) ?? 0) + 1);
  }
  return counts;
}

export function listReadyAddressCountsByDomains(domainIds: Iterable<string>): Map<string, number> {
  const ids = new Set([...domainIds].map((id) => id.trim()).filter(Boolean));
  if (ids.size === 0) return new Map();
  const counts = new Map<string, number>();
  for (const row of selfHostedResource(ADDRESS_RESOURCE).list({ limit: 1000 })) {
    const domainId = cstrOrNull(row["domain_id"]);
    if (!domainId || !ids.has(domainId) || cstr(row["provisioning_status"]) !== "ready") continue;
    counts.set(domainId, (counts.get(domainId) ?? 0) + 1);
  }
  return counts;
}

export function countReadyAddressesForDomain(domainId: string): number {
  return selfHostedResource(ADDRESS_RESOURCE)
    .list({ limit: 1000 })
    .filter((row) => cstrOrNull(row["domain_id"]) === domainId && cstr(row["provisioning_status"]) === "ready").length;
}

export function setAddressProvisioning(
  id: string,
  input: AddressProvisioningInput,
): AddressProvisioning | null {
  const patch: Record<string, unknown> = {};
  if (input.domain_id !== undefined) patch["domain_id"] = input.domain_id;
  if (input.receive_strategy !== undefined) patch["receive_strategy"] = input.receive_strategy;
  if (input.forward_to !== undefined) patch["forward_to"] = input.forward_to;
  if (input.routing_rule_id !== undefined) patch["routing_rule_id"] = input.routing_rule_id;
  if (input.provisioning_status !== undefined) patch["provisioning_status"] = input.provisioning_status;
  if (input.last_validated_at !== undefined) patch["last_validated_at"] = input.last_validated_at;
  if (input.last_error !== undefined) patch["last_error"] = input.last_error;
  if (input.next_check_at !== undefined) patch["next_check_at"] = input.next_check_at;
  patch["updated_at"] = now();
  selfHostedResource(ADDRESS_RESOURCE).update(id, patch);
  return getAddressProvisioning(id);
}

// ─── Audit trail ────────────────────────────────────────────────────────────

export function recordProvisioningEvent(
  entity_type: "domain" | "address",
  entity_id: string,
  from_state: string | null,
  to_state: string,
  detail: Record<string, unknown> = {},
): ProvisioningEvent {
  const id = uuid();
  const created_at = now();
  selfHostedResource(PROVISIONING_RESOURCE).create({
    id,
    entity_type,
    entity_id,
    from_state,
    to_state,
    detail_json: JSON.stringify(detail),
    created_at,
  });
  return { id, entity_type, entity_id, from_state, to_state, detail, created_at };
}

export function listProvisioningEvents(
  entity_type: "domain" | "address",
  entity_id: string,
): ProvisioningEvent[] {
  return selfHostedResource(PROVISIONING_RESOURCE)
    .list({ limit: 1000 })
    .filter((row) => cstr(row["entity_type"]) === entity_type && cstr(row["entity_id"]) === entity_id)
    .map((row) => ({
      id: cstr(row["id"]),
      entity_type: cstr(row["entity_type"]) as "domain" | "address",
      entity_id: cstr(row["entity_id"]),
      from_state: cstrOrNull(row["from_state"]),
      to_state: cstr(row["to_state"]),
      detail: cobj(row["detail"] ?? row["detail_json"]),
      created_at: ciso(row["created_at"]),
    }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// ─── Daemon queue (derived client-side) ─────────────────────────────────────

interface DueRow {
  id: string;
  status: string;
  next: string | null;
}

function dueRows(resource: string): DueRow[] {
  return selfHostedResource(resource).list({ limit: 1000 }).map((row) => ({
    id: cstr(row["id"]),
    status: cstr(row["provisioning_status"]) || "none",
    next: cstrOrNull(row["next_check_at"]),
  }));
}

function claimDue(resource: string, asOf?: string): { id: string }[] {
  const ts = asOf || now();
  return dueRows(resource)
    .filter((r) => !TERMINAL_SET.has(r.status) && r.next != null && r.next <= ts)
    .sort((a, b) => (a.next ?? "").localeCompare(b.next ?? ""))
    .map((r) => ({ id: r.id }));
}

export function claimDueDomains(asOf?: string): { id: string }[] {
  return claimDue(DOMAIN_RESOURCE, asOf);
}

export function claimDueAddresses(asOf?: string): { id: string }[] {
  return claimDue(ADDRESS_RESOURCE, asOf);
}

export interface ProvisioningWorkSummary {
  due_domains: number;
  due_addresses: number;
  failed_domains: number;
  failed_addresses: number;
}

export function getProvisioningWorkSummary(asOf?: string): ProvisioningWorkSummary {
  const ts = asOf || now();
  const domains = dueRows(DOMAIN_RESOURCE);
  const addresses = dueRows(ADDRESS_RESOURCE);
  const isDue = (r: DueRow) => !TERMINAL_SET.has(r.status) && r.next != null && r.next <= ts;
  return {
    due_domains: domains.filter(isDue).length,
    due_addresses: addresses.filter(isDue).length,
    failed_domains: domains.filter((r) => r.status === "failed").length,
    failed_addresses: addresses.filter((r) => r.status === "failed").length,
  };
}
