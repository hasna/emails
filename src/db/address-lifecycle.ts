import * as local from "./address-lifecycle.local.js";
import * as remote from "./address-lifecycle.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument, withExplicitDatabaseRoute } from "./database-routing.js";

export type * from "./address-lifecycle.local.js";

const localCompat = {
  ...local,
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (hasDatabaseArgument(args) ? local : isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`address-lifecycle.${String(key)} is unavailable in the selected mode.`);
    return withExplicitDatabaseRoute(args, () => (candidate as (...values: unknown[]) => unknown)(...args));
  }) as RoutedFunction<K>;
}

export const suspendAddress = routed("suspendAddress");
export const activateAddress = routed("activateAddress");
export const setAddressQuota = routed("setAddressQuota");
export const countSendsToday = routed("countSendsToday");
export const countSendsTodayByAddress = routed("countSendsTodayByAddress");
export const getAddressSendability = routed("getAddressSendability");
