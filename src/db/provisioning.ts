import * as local from "./provisioning.local.js";
import * as remote from "./provisioning.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument, withExplicitDatabaseRoute } from "./database-routing.js";

export type * from "./provisioning.local.js";

const localCompat = {
  ...local,
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (hasDatabaseArgument(args) ? local : isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`provisioning.${String(key)} is unavailable in the selected mode.`);
    return withExplicitDatabaseRoute(args, () => (candidate as (...values: unknown[]) => unknown)(...args));
  }) as RoutedFunction<K>;
}

export const getDomainProvisioning = routed("getDomainProvisioning");
export const listDomainProvisioningById = routed("listDomainProvisioningById");
export const listDomainProvisioningByIds = routed("listDomainProvisioningByIds");
export const setDomainProvisioning = routed("setDomainProvisioning");
export const getAddressProvisioning = routed("getAddressProvisioning");
export const listAddressProvisioningById = routed("listAddressProvisioningById");
export const listAddressProvisioningByIds = routed("listAddressProvisioningByIds");
export const listAddressProvisioningByDomain = routed("listAddressProvisioningByDomain");
export const listAddressProvisioningByDomains = routed("listAddressProvisioningByDomains");
export const listAddressProvisioningForDomain = routed("listAddressProvisioningForDomain");
export const listReadyAddressCountsByDomain = routed("listReadyAddressCountsByDomain");
export const listReadyAddressCountsByDomains = routed("listReadyAddressCountsByDomains");
export const countReadyAddressesForDomain = routed("countReadyAddressesForDomain");
export const setAddressProvisioning = routed("setAddressProvisioning");
export const recordProvisioningEvent = routed("recordProvisioningEvent");
export const listProvisioningEvents = routed("listProvisioningEvents");
export const claimDueDomains = routed("claimDueDomains");
export const claimDueAddresses = routed("claimDueAddresses");
export const getProvisioningWorkSummary = routed("getProvisioningWorkSummary");

// Storage-independent constants retain their canonical local definitions.
export const TERMINAL_STATES = local.TERMINAL_STATES;
