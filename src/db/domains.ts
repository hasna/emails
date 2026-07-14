import * as local from "./domains.local.js";
import * as remote from "./domains.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument } from "./database-routing.js";

export type * from "./domains.local.js";

const localCompat = {
  ...local,
  listDomains: (providerId, opts) => local.listDomains(providerId, undefined, opts),
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : hasDatabaseArgument(args) ? local : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`domains.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as RoutedFunction<K>;
}

export const createDomain = routed("createDomain");
export const getDomain = routed("getDomain");
export const getDomainByName = routed("getDomainByName");
export const findDomainsByName = routed("findDomainsByName");
export const listDomainsByProviderAndNames = routed("listDomainsByProviderAndNames");
export const listDomains = routed("listDomains");
export const listDomainsByProviderIds = routed("listDomainsByProviderIds");
export const listUsableDomains = routed("listUsableDomains");
export const countUsableDomains = routed("countUsableDomains");
export const updateDomain = routed("updateDomain");
export const updateDomainReadiness = routed("updateDomainReadiness");
export const moveDomainProvider = routed("moveDomainProvider");
export const deleteDomain = routed("deleteDomain");
export const updateDnsStatus = routed("updateDnsStatus");
