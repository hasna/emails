import * as local from "./providers.local.js";
import * as remote from "./providers.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument, withExplicitDatabaseRoute } from "./database-routing.js";

export type * from "./providers.local.js";

const localCompat = {
  ...local,
  listProviders: (opts) => local.listProviders(undefined, opts),
  listProviderSummaries: (opts) => local.listProviderSummaries(undefined, opts),
  listActiveProviderSummaries: (type, opts) => local.listActiveProviderSummaries(type, undefined, opts),
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (hasDatabaseArgument(args) ? local : isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`providers.${String(key)} is unavailable in the selected mode.`);
    return withExplicitDatabaseRoute(args, () => (candidate as (...values: unknown[]) => unknown)(...args));
  }) as RoutedFunction<K>;
}

export const createProvider = routed("createProvider");
export const getProvider = routed("getProvider");
export const resolveProviderId = routed("resolveProviderId");
export const getProviderByNameAndType = routed("getProviderByNameAndType");
export const listProviders = routed("listProviders");
export const listProviderSummaries = routed("listProviderSummaries");
export const listProviderNamesByIds = routed("listProviderNamesByIds");
export const listActiveProviders = routed("listActiveProviders");
export const listActiveProviderSummaries = routed("listActiveProviderSummaries");
export const getLatestActiveProvider = routed("getLatestActiveProvider");
export const getLatestActiveProviderId = routed("getLatestActiveProviderId");
export const updateProvider = routed("updateProvider");
export const deleteProvider = routed("deleteProvider");
export const getActiveProvider = routed("getActiveProvider");
