import * as local from "./addresses.local.js";
import * as remote from "./addresses.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument } from "./database-routing.js";

export type * from "./addresses.local.js";

const localCompat = {
  ...local,
  listAddresses: (providerId, opts) => local.listAddresses(providerId, undefined, opts),
  listUsableSendingAddresses: (opts) => local.listUsableSendingAddresses(undefined, opts),
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : hasDatabaseArgument(args) ? local : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`addresses.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as RoutedFunction<K>;
}

export const selfHostedAddresses = routed("selfHostedAddresses");
export const apiToAddress = routed("apiToAddress");
export const createAddress = routed("createAddress");
export const getAddress = routed("getAddress");
export const getAddressByEmail = routed("getAddressByEmail");
export const findAddressesByEmail = routed("findAddressesByEmail");
export const listAddresses = routed("listAddresses");
export const listAddressesByProviderIds = routed("listAddressesByProviderIds");
export const listAddressesForReadiness = routed("listAddressesForReadiness");
export const countAddressesForReadiness = routed("countAddressesForReadiness");
export const listAddressEmails = routed("listAddressEmails");
export const listActiveAddressEmails = routed("listActiveAddressEmails");
export const listActiveAddressCountsByDomain = routed("listActiveAddressCountsByDomain");
export const listActiveAddressCountsByDomains = routed("listActiveAddressCountsByDomains");
export const getPreferredActiveAddressEmail = routed("getPreferredActiveAddressEmail");
export const listUsableSendingAddresses = routed("listUsableSendingAddresses");
export const updateAddress = routed("updateAddress");
export const deleteAddress = routed("deleteAddress");
export const markVerified = routed("markVerified");

// Storage-independent constants retain their canonical local definitions.
export const ADDRESS_RESOURCE = local.ADDRESS_RESOURCE;
