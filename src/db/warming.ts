import * as local from "./warming.local.js";
import * as remote from "./warming.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument } from "./database-routing.js";

export type * from "./warming.local.js";

const localCompat = {
  ...local,
  listWarmingSchedules: (status, opts) => local.listWarmingSchedules(status, undefined, opts),
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : hasDatabaseArgument(args) ? local : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`warming.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as RoutedFunction<K>;
}

export const createWarmingSchedule = routed("createWarmingSchedule");
export const getWarmingSchedule = routed("getWarmingSchedule");
export const listWarmingSchedules = routed("listWarmingSchedules");
export const updateWarmingStatus = routed("updateWarmingStatus");
export const deleteWarmingSchedule = routed("deleteWarmingSchedule");
