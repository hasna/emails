import { resolveResourceId } from "../db/self-hosted-store.js";
import { findAddressesByEmail, getAddress, listAddresses, type ListAddressOptions } from "../db/addresses.js";
import { listProviderNamesByIds } from "../db/providers.js";
import {
  assignAddressOwner,
  getOwner,
  getOwnerByName,
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

function resolveOwnerRef(ref: string): Owner | null {
  const partialId = resolveResourceId("owners", ref);
  return getOwnerByName(ref)
    ?? getOwner(ref)
    ?? (partialId ? getOwner(partialId) : null);
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

export function enrichAddress(address: EmailAddress): EnrichedAddress {
  const providers = listProviderNamesByIds([address.provider_id]);
  const owner = address.owner_id ? getOwner(address.owner_id) : null;
  const administrator = address.administrator_id ? getOwner(address.administrator_id) : null;
  return {
    ...address,
    provider_name: providers.get(address.provider_id) ?? null,
    owner,
    administrator,
  };
}

export function enrichAddresses(addresses: EmailAddress[]): EnrichedAddress[] {
  const providers = listProviderNamesByIds(addresses.map((address) => address.provider_id));
  const ownerIds = addresses.flatMap((address) => [address.owner_id, address.administrator_id])
    .filter((id): id is string => !!id);
  const owners = listOwnersByIds(ownerIds);
  return addresses.map((address) => ({
    ...address,
    provider_name: providers.get(address.provider_id) ?? null,
    owner: address.owner_id ? owners.get(address.owner_id) ?? null : null,
    administrator: address.administrator_id ? owners.get(address.administrator_id) ?? null : null,
  }));
}

export function listEnrichedAddresses(providerId?: string, opts?: ListAddressOptions): EnrichedAddress[] {
  return enrichAddresses(listAddresses(providerId, opts));
}

export function getAddressOwnershipDetail(ref: string): AddressOwnershipDetail {
  const address = resolveAddressRef(ref);
  const enriched = enrichAddress(address);
  return {
    address: enriched,
    ownership: enriched.owner
      ? {
          owner_id: enriched.owner.id,
          owner_type: enriched.owner.type,
          administrator_id: enriched.administrator?.id ?? enriched.owner.id,
        }
      : null,
    history: listAddressOwnershipEvents(address.id, 10),
  };
}

export function setAddressOwnerByRef(
  addressRef: string,
  ownerRef: string,
  administratorRef?: string,
): AddressOwnershipDetail {
  const address = resolveAddressRef(addressRef);
  const owner = resolveOwnerRef(ownerRef);
  if (!owner) throw new Error(`Owner not found: ${ownerRef}`);
  const administrator = administratorRef ? resolveOwnerRef(administratorRef) : null;
  assignAddressOwner(address.id, owner.id, administrator?.id);
  return getAddressOwnershipDetail(address.id);
}

export function transferAddressOwnerByRef(
  addressRef: string,
  ownerRef: string,
  administratorRef: string | undefined,
  options: { actor?: string; reason: string },
): AddressOwnershipDetail {
  const address = resolveAddressRef(addressRef);
  const owner = resolveOwnerRef(ownerRef);
  if (!owner) throw new Error(`Owner not found: ${ownerRef}`);
  const administrator = administratorRef ? resolveOwnerRef(administratorRef) : null;
  transferAddressOwner(address.id, owner.id, administrator?.id, options);
  return getAddressOwnershipDetail(address.id);
}

export function unassignAddressOwnerByRef(
  addressRef: string,
  options: { actor?: string; reason: string },
): AddressOwnershipDetail {
  const address = resolveAddressRef(addressRef);
  unassignAddressOwner(address.id, options);
  return getAddressOwnershipDetail(address.id);
}

export function getAddressOwnershipHistoryByRef(
  addressRef: string,
  limit = 20,
): { address: EnrichedAddress; history: AddressOwnershipEvent[] } {
  const address = resolveAddressRef(addressRef);
  return {
    address: enrichAddress(address),
    history: listAddressOwnershipEvents(address.id, limit),
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
