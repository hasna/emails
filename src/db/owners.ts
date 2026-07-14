import * as local from "./owners.local.js";
import * as remote from "./owners.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument } from "./database-routing.js";

export type * from "./owners.local.js";

const localCompat = {
  ...local,
  listOwners: (type, opts) => local.listOwners(type, undefined, opts),
  listAddressesByOwner: (ownerId, role, opts) => local.listAddressesByOwner(ownerId, role, undefined, opts),
  listAdministeredAddressesNotOwnedBy: (ownerId, opts) => local.listAdministeredAddressesNotOwnedBy(ownerId, undefined, opts),
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : hasDatabaseArgument(args) ? local : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`owners.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as RoutedFunction<K>;
}

export const createOwner = routed("createOwner");
export const getOwner = routed("getOwner");
export const getOwnerByName = routed("getOwnerByName");
export const getOwnerByExternalId = routed("getOwnerByExternalId");
export const getOwnerByContactEmail = routed("getOwnerByContactEmail");
export const listOwners = routed("listOwners");
export const getAddressOwnershipEvent = routed("getAddressOwnershipEvent");
export const listAddressOwnershipEvents = routed("listAddressOwnershipEvents");
export const assignAddressOwner = routed("assignAddressOwner");
export const transferAddressOwner = routed("transferAddressOwner");
export const unassignAddressOwner = routed("unassignAddressOwner");
export const getAddressOwnership = routed("getAddressOwnership");
export const listAddressesByOwner = routed("listAddressesByOwner");
export const listAdministeredAddressesNotOwnedBy = routed("listAdministeredAddressesNotOwnedBy");
export const listAddressEmailsByOwner = routed("listAddressEmailsByOwner");
export const listOwnerNamesByIds = routed("listOwnerNamesByIds");
export const listOwnersByIds = routed("listOwnersByIds");
