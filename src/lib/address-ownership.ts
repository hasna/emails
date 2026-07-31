import { resolveResourceId } from "../db/self-hosted-store.js";
import { findAddressesByEmail, getAddress, listAddresses, type ListAddressOptions } from "../db/addresses.js";
import { listProviderNamesByIds } from "../db/providers.js";
import {
  assignAddressOwner,
  getOwner,
  getOwnerByName,
  listOwners,
  listOwnersByIds,
  listAddressOwnershipEvents,
  transferAddressOwner,
  unassignAddressOwner,
  type AddressOwnership,
  type AddressOwnershipEvent,
  type Owner,
} from "../db/owners.js";
import type { EmailAddress } from "../types/index.js";

export interface EnrichedAddress extends EmailAddress {
  provider_name: string | null;
  owner: Owner | null;
  administrator: Owner | null;
}

export interface AddressOwnershipDetail {
  address: EnrichedAddress;
  ownership: AddressOwnership | null;
  history: AddressOwnershipEvent[];
}

/**
 * Resolve an owner reference: exact name, then exact id, then a UNIQUE id prefix.
 *
 * The prefix match enumerates the owners family itself rather than going through the
 * legacy deployment-word resolver (`resolveResourceId`): the owners family has
 * collapsed onto the store seam, so its references must resolve against the SAME
 * store its reads and writes go to — resolving a prefix against one store and
 * assigning ownership in another is the provenance split the collapse removed. An
 * ambiguous prefix resolves to nothing, exactly as the old resolver answered.
 */
async function resolveOwnerRef(ref: string): Promise<Owner | null> {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const byName = await getOwnerByName(trimmed);
  if (byName) return byName;
  const byId = await getOwner(trimmed);
  if (byId) return byId;
  const matches = (await listOwners()).filter((owner) => owner.id.startsWith(trimmed));
  return matches.length === 1 ? (matches[0] as Owner) : null;
}

export function resolveAddressRef(ref: string): EmailAddress {
  const trimmed = ref.trim();
  const exact = getAddress(trimmed);
  if (exact) return exact;

  const id = resolveResourceId("addresses", trimmed);
  if (id) {
    const address = getAddress(id);
    if (address) return address;
  }

  const lowered = trimmed.toLowerCase();
  const matches = findAddressesByEmail(lowered);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const ids = matches.map((address) => `${address.id.slice(0, 8)}:${address.provider_id.slice(0, 8)}`).join(", ");
    throw new Error(`Address '${trimmed}' exists on multiple providers; use an address ID (${ids})`);
  }
  throw new Error(`Address not found: ${trimmed}`);
}

export async function enrichAddress(address: EmailAddress): Promise<EnrichedAddress> {
  const providers = listProviderNamesByIds([address.provider_id]);
  const owner = address.owner_id ? await getOwner(address.owner_id) : null;
  const administrator = address.administrator_id ? await getOwner(address.administrator_id) : null;
  return {
    ...address,
    provider_name: providers.get(address.provider_id) ?? null,
    owner,
    administrator,
  };
}

export async function enrichAddresses(addresses: EmailAddress[]): Promise<EnrichedAddress[]> {
  if (addresses.length === 0) return [];
  const providers = listProviderNamesByIds(addresses.map((address) => address.provider_id));
  const ownerIds = addresses.flatMap((address) => [address.owner_id, address.administrator_id])
    .filter((id): id is string => !!id);
  const owners = await listOwnersByIds(ownerIds);
  return addresses.map((address) => ({
    ...address,
    provider_name: providers.get(address.provider_id) ?? null,
    owner: address.owner_id ? owners.get(address.owner_id) ?? null : null,
    administrator: address.administrator_id ? owners.get(address.administrator_id) ?? null : null,
  }));
}

export async function listEnrichedAddresses(
  providerId?: string,
  opts?: ListAddressOptions,
): Promise<EnrichedAddress[]> {
  return enrichAddresses(listAddresses(providerId, opts));
}

export async function getAddressOwnershipDetail(ref: string): Promise<AddressOwnershipDetail> {
  const address = resolveAddressRef(ref);
  const enriched = await enrichAddress(address);
  return {
    address: enriched,
    ownership: enriched.owner
      ? {
          owner_id: enriched.owner.id,
          owner_type: enriched.owner.type,
          administrator_id: enriched.administrator?.id ?? enriched.owner.id,
        }
      : null,
    history: await listAddressOwnershipEvents(address.id, 10),
  };
}

export async function setAddressOwnerByRef(
  addressRef: string,
  ownerRef: string,
  administratorRef?: string,
): Promise<AddressOwnershipDetail> {
  const address = resolveAddressRef(addressRef);
  const owner = await resolveOwnerRef(ownerRef);
  if (!owner) throw new Error(`Owner not found: ${ownerRef}`);
  const administrator = administratorRef ? await resolveOwnerRef(administratorRef) : null;
  await assignAddressOwner(address.id, owner.id, administrator?.id);
  return getAddressOwnershipDetail(address.id);
}

export async function transferAddressOwnerByRef(
  addressRef: string,
  ownerRef: string,
  administratorRef: string | undefined,
  options: { actor?: string; reason: string },
): Promise<AddressOwnershipDetail> {
  const address = resolveAddressRef(addressRef);
  const owner = await resolveOwnerRef(ownerRef);
  if (!owner) throw new Error(`Owner not found: ${ownerRef}`);
  const administrator = administratorRef ? await resolveOwnerRef(administratorRef) : null;
  await transferAddressOwner(address.id, owner.id, administrator?.id, options);
  return getAddressOwnershipDetail(address.id);
}

export async function unassignAddressOwnerByRef(
  addressRef: string,
  options: { actor?: string; reason: string },
): Promise<AddressOwnershipDetail> {
  const address = resolveAddressRef(addressRef);
  await unassignAddressOwner(address.id, options);
  return getAddressOwnershipDetail(address.id);
}

export async function getAddressOwnershipHistoryByRef(
  addressRef: string,
  limit = 20,
): Promise<{ address: EnrichedAddress; history: AddressOwnershipEvent[] }> {
  const address = resolveAddressRef(addressRef);
  return {
    address: await enrichAddress(address),
    history: await listAddressOwnershipEvents(address.id, limit),
  };
}

export function suggestAddressLocalParts(domain: string, existingEmails: string[]): string[] {
  const normalized = domain.trim().toLowerCase();
  const used = new Set(
    existingEmails
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.endsWith(`@${normalized}`))
      .map((email) => email.split("@")[0]),
  );
  const candidates = [
    "hello", "hi", "contact", "support", "team", "admin", "inbox",
    "mail", "me", "bot", "agent", "verify", "accounts", "notify",
  ];
  return candidates.filter((local) => !used.has(local)).slice(0, 8).map((local) => `${local}@${normalized}`);
}
