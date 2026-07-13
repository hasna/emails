/**
 * Ownership — addresses are owned by a human OR an agent.
 *
 * Rule: a human-owned address must be ADMINISTERED by an agent (owner=human,
 * administrator=agent). An agent-owned address is self-administered
 * (administrator = the agent). This lets an address belong to a human while
 * being operated by an agent on their behalf.
 *
 * Self-hosted-ONLY: owners route to `/v1/owners`; address ownership fields are
 * patched on `/v1/addresses/<id>`; the audit trail routes to
 * `/v1/address-ownership-events`.
 */

import type { EmailAddress } from "../types/index.js";
import { now, uuid } from "./runtime.js";
import { apiToAddress } from "./addresses.js";
import { cappedLimit, safeOffset, safeOptionalLimit } from "./pagination.js";
import { selfHostedResource, selfHostedListQuery, selfHostedPage, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const OWNER_RESOURCE = "owners";
const ADDRESS_RESOURCE = "addresses";
const OWNERSHIP_EVENT_RESOURCE = "address-ownership-events";

function apiToOwner(e: Record<string, unknown>): Owner {
  const updatedAt = ciso(e["updated_at"]);
  const type = cstr(e["type"]) === "agent" ? "agent" : "human";
  return {
    id: cstr(e["id"]),
    type,
    name: cstr(e["name"]),
    contact_email: cstrOrNull(e["contact_email"]),
    external_id: cstrOrNull(e["external_id"]),
    created_at: ciso(e["created_at"], updatedAt),
    updated_at: updatedAt,
  };
}

export type OwnerType = "human" | "agent";

export interface Owner {
  id: string;
  type: OwnerType;
  name: string;
  contact_email: string | null;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateOwnerInput {
  type: OwnerType;
  name: string;
  contact_email?: string;
  external_id?: string;
}

export interface ListOwnerOptions {
  limit?: number;
  offset?: number;
}

export interface ListAddressesByOwnerOptions {
  limit?: number;
  offset?: number;
}

let lastOwnershipEventMs = 0;

function ownershipEventTimestamp(): string {
  const current = Date.now();
  lastOwnershipEventMs = current <= lastOwnershipEventMs ? lastOwnershipEventMs + 1 : current;
  return new Date(lastOwnershipEventMs).toISOString();
}

export function createOwner(input: CreateOwnerInput): Owner {
  if (input.type !== "human" && input.type !== "agent") {
    throw new Error(`Invalid owner type '${input.type}' (must be 'human' or 'agent')`);
  }
  const externalId = input.external_id?.trim();
  const store = selfHostedResource(OWNER_RESOURCE);
  if (externalId) {
    const clash = store.list({ limit: 1000 }).map(apiToOwner).some((o) => o.external_id === externalId);
    if (clash) throw new Error(`Owner external_id already exists: ${externalId}`);
  }
  return apiToOwner(store.create({
    type: input.type,
    name: input.name,
    contact_email: input.contact_email ?? null,
    external_id: externalId ?? null,
  }));
}

export function getOwner(id: string): Owner | null {
  const record = selfHostedResource(OWNER_RESOURCE).get(id);
  return record ? apiToOwner(record) : null;
}

export function getOwnerByName(name: string): Owner | null {
  return selfHostedResource(OWNER_RESOURCE).list({ limit: 1000 }).map(apiToOwner).find((owner) => owner.name === name) ?? null;
}

export function getOwnerByExternalId(externalId: string): Owner | null {
  const normalized = externalId.trim();
  if (!normalized) return null;
  return selfHostedResource(OWNER_RESOURCE).list({ limit: 1000 }).map(apiToOwner).find((owner) => owner.external_id === normalized) ?? null;
}

export function getOwnerByContactEmail(email: string): Owner | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  return selfHostedResource(OWNER_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToOwner)
    .find((owner) => owner.contact_email?.toLowerCase() === normalized) ?? null;
}

export function listOwners(type?: OwnerType, opts?: ListOwnerOptions): Owner[] {
  const { query, limit, offset } = selfHostedListQuery(opts);
  if (type) query["type"] = type;
  let rows = selfHostedResource(OWNER_RESOURCE).list(query).map(apiToOwner);
  if (type) rows = rows.filter((o) => o.type === type);
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return selfHostedPage(rows, limit, offset);
}

export interface AddressOwnership {
  owner_id: string;
  owner_type: OwnerType;
  administrator_id: string;
}

export type AddressOwnershipAction = "assign" | "transfer" | "unassign";

export interface AddressOwnershipEvent {
  id: string;
  address_id: string;
  action: AddressOwnershipAction;
  previous_owner_id: string | null;
  previous_administrator_id: string | null;
  owner_id: string | null;
  administrator_id: string | null;
  actor: string | null;
  reason: string | null;
  created_at: string;
}

interface CurrentAddressOwnership {
  owner_id: string | null;
  administrator_id: string | null;
}

interface OwnershipChangeOptions {
  actor?: string;
  reason?: string;
}

function apiToOwnershipEvent(e: Record<string, unknown>): AddressOwnershipEvent {
  return {
    id: cstr(e["id"]),
    address_id: cstr(e["address_id"]),
    action: cstr(e["action"]) as AddressOwnershipAction,
    previous_owner_id: cstrOrNull(e["previous_owner_id"]),
    previous_administrator_id: cstrOrNull(e["previous_administrator_id"]),
    owner_id: cstrOrNull(e["owner_id"]),
    administrator_id: cstrOrNull(e["administrator_id"]),
    actor: cstrOrNull(e["actor"]),
    reason: cstrOrNull(e["reason"]),
    created_at: ciso(e["created_at"]),
  };
}

function getCurrentAddressOwnership(addressId: string): CurrentAddressOwnership {
  const record = selfHostedResource(ADDRESS_RESOURCE).get(addressId);
  if (!record) throw new Error(`Address not found: ${addressId}`);
  return {
    owner_id: cstrOrNull(record["owner_id"]),
    administrator_id: cstrOrNull(record["administrator_id"]),
  };
}

function validateAddressOwnership(ownerId: string, administratorId: string | undefined): AddressOwnership {
  const owner = getOwner(ownerId);
  if (!owner) throw new Error(`Owner not found: ${ownerId}`);

  let adminId: string;
  if (owner.type === "agent") {
    adminId = owner.id;
  } else {
    if (!administratorId) {
      throw new Error("A human-owned address requires an agent administrator (pass administratorId)");
    }
    const admin = getOwner(administratorId);
    if (!admin) throw new Error(`Administrator not found: ${administratorId}`);
    if (admin.type !== "agent") throw new Error("The administrator must be an agent");
    adminId = admin.id;
  }

  return { owner_id: owner.id, owner_type: owner.type, administrator_id: adminId };
}

function recordAddressOwnershipEvent(
  addressId: string,
  action: AddressOwnershipAction,
  previous: CurrentAddressOwnership,
  next: { owner_id: string | null; administrator_id: string | null },
  options: OwnershipChangeOptions = {},
): AddressOwnershipEvent {
  const id = uuid();
  const ts = ownershipEventTimestamp();
  selfHostedResource(OWNERSHIP_EVENT_RESOURCE).create({
    id,
    address_id: addressId,
    action,
    previous_owner_id: previous.owner_id,
    previous_administrator_id: previous.administrator_id,
    owner_id: next.owner_id,
    administrator_id: next.administrator_id,
    actor: options.actor?.trim() || null,
    reason: options.reason?.trim() || null,
    created_at: ts,
  });
  return getAddressOwnershipEvent(id)!;
}

export function getAddressOwnershipEvent(id: string): AddressOwnershipEvent | null {
  const record = selfHostedResource(OWNERSHIP_EVENT_RESOURCE).get(id);
  return record ? apiToOwnershipEvent(record) : null;
}

export function listAddressOwnershipEvents(addressId: string, limit = 20): AddressOwnershipEvent[] {
  const safeLimit = cappedLimit(limit, 20, 100);
  return selfHostedResource(OWNERSHIP_EVENT_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToOwnershipEvent)
    .filter((e) => e.address_id === addressId)
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || b.id.localeCompare(a.id))
    .slice(0, safeLimit);
}

/**
 * Assign ownership of an address.
 *  - agent owner → self-administered (administrator = owner; administratorId ignored)
 *  - human owner → administratorId is REQUIRED and must reference an agent owner
 */
export function assignAddressOwner(
  addressId: string,
  ownerId: string,
  administratorId?: string,
): AddressOwnership {
  const ownership = validateAddressOwnership(ownerId, administratorId);

  // Refuse to silently take over an address already owned by someone else.
  const current = getCurrentAddressOwnership(addressId);
  if (current.owner_id && current.owner_id !== ownership.owner_id) {
    throw new Error(`Address ${addressId} is already owned by another owner; transfer is not permitted`);
  }

  selfHostedResource(ADDRESS_RESOURCE).update(addressId, {
    owner_id: ownership.owner_id,
    administrator_id: ownership.administrator_id,
    updated_at: now(),
  });
  if (current.owner_id !== ownership.owner_id || current.administrator_id !== ownership.administrator_id) {
    recordAddressOwnershipEvent(addressId, "assign", current, ownership);
  }
  return ownership;
}

export function transferAddressOwner(
  addressId: string,
  ownerId: string,
  administratorId: string | undefined,
  options: OwnershipChangeOptions,
): AddressOwnership {
  const reason = options.reason?.trim();
  if (!reason) throw new Error("Address ownership transfer requires a reason");

  const current = getCurrentAddressOwnership(addressId);
  const ownership = validateAddressOwnership(ownerId, administratorId);

  selfHostedResource(ADDRESS_RESOURCE).update(addressId, {
    owner_id: ownership.owner_id,
    administrator_id: ownership.administrator_id,
    updated_at: now(),
  });
  if (current.owner_id !== ownership.owner_id || current.administrator_id !== ownership.administrator_id) {
    recordAddressOwnershipEvent(addressId, "transfer", current, ownership, options);
  }
  return ownership;
}

export function unassignAddressOwner(
  addressId: string,
  options: OwnershipChangeOptions,
): null {
  const reason = options.reason?.trim();
  if (!reason) throw new Error("Address ownership unassign requires a reason");

  const current = getCurrentAddressOwnership(addressId);
  selfHostedResource(ADDRESS_RESOURCE).update(addressId, {
    owner_id: null,
    administrator_id: null,
    updated_at: now(),
  });
  if (current.owner_id || current.administrator_id) {
    recordAddressOwnershipEvent(addressId, "unassign", current, { owner_id: null, administrator_id: null }, options);
  }
  return null;
}

export function getAddressOwnership(addressId: string): AddressOwnership | null {
  const record = selfHostedResource(ADDRESS_RESOURCE).get(addressId);
  if (!record) return null;
  const ownerId = cstrOrNull(record["owner_id"]);
  if (!ownerId) return null;
  const administratorId = cstrOrNull(record["administrator_id"]);
  const owner = getOwner(ownerId);
  return { owner_id: ownerId, owner_type: owner?.type ?? "agent", administrator_id: administratorId ?? ownerId };
}

/** List addresses an owner owns (default) or administers. */
export function listAddressesByOwner(
  ownerId: string,
  role: "owner" | "administrator" = "owner",
  opts?: ListAddressesByOwnerOptions,
): EmailAddress[] {
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = selfHostedResource(ADDRESS_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToAddress)
    .filter((a) => (role === "administrator" ? a.administrator_id : a.owner_id) === ownerId)
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return limit === null ? rows : rows.slice(offset, offset + limit);
}

/** List addresses an owner administers but does not also own. */
export function listAdministeredAddressesNotOwnedBy(ownerId: string, opts?: ListAddressesByOwnerOptions): EmailAddress[] {
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = selfHostedResource(ADDRESS_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToAddress)
    .filter((a) => a.administrator_id === ownerId && (a.owner_id == null || a.owner_id !== ownerId))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return limit === null ? rows : rows.slice(offset, offset + limit);
}

/** List only address strings an owner owns or administers without hydrating address rows. */
export function listAddressEmailsByOwner(ownerId: string, role: "owner" | "administrator" = "owner"): string[] {
  return selfHostedResource(ADDRESS_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToAddress)
    .filter((a) => (role === "administrator" ? a.administrator_id : a.owner_id) === ownerId)
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .map((a) => a.email);
}

export function listOwnerNamesByIds(ownerIds: Iterable<string>): Map<string, string> {
  const ids = new Set([...ownerIds].map((id) => id.trim()).filter(Boolean));
  if (ids.size === 0) return new Map();
  const map = new Map<string, string>();
  for (const owner of selfHostedResource(OWNER_RESOURCE).list({ limit: 1000 }).map(apiToOwner)) {
    if (ids.has(owner.id)) map.set(owner.id, owner.name);
  }
  return map;
}

export function listOwnersByIds(ownerIds: Iterable<string>): Map<string, Owner> {
  const ids = new Set([...ownerIds].map((id) => id.trim()).filter(Boolean));
  if (ids.size === 0) return new Map();
  const map = new Map<string, Owner>();
  for (const owner of selfHostedResource(OWNER_RESOURCE).list({ limit: 1000 }).map(apiToOwner)) {
    if (ids.has(owner.id)) map.set(owner.id, owner);
  }
  return map;
}
