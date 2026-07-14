import * as local from "./aliases.local.js";
import * as remote from "./aliases.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument } from "./database-routing.js";

export type * from "./aliases.local.js";

const localCompat = {
  ...local,
  listAliases: (domain, opts) => local.listAliases(domain, undefined, opts),
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : hasDatabaseArgument(args) ? local : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`aliases.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as RoutedFunction<K>;
}

export const createAlias = routed("createAlias");
export const createCatchAll = routed("createCatchAll");
export const setGlobalCatchAll = routed("setGlobalCatchAll");
export const ensureDefaultCatchAll = routed("ensureDefaultCatchAll");
export const getGlobalCatchAll = routed("getGlobalCatchAll");
export const getAlias = routed("getAlias");
export const listAliases = routed("listAliases");
export const listAliasesByTargets = routed("listAliasesByTargets");
export const removeAlias = routed("removeAlias");
export const resolveAlias = routed("resolveAlias");

// Storage-independent constants retain their canonical local definitions.
export const CATCH_ALL = local.CATCH_ALL;
export const ALL_DOMAINS = local.ALL_DOMAINS;
