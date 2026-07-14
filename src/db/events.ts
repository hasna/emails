import * as local from "./events.local.js";
import * as remote from "./events.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument } from "./database-routing.js";

export type * from "./events.local.js";

const localCompat = {
  ...local,
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : hasDatabaseArgument(args) ? local : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`events.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as RoutedFunction<K>;
}

export const createEvent = routed("createEvent");
export const listEvents = routed("listEvents");
export const listEventSummaries = routed("listEventSummaries");
export const getEvent = routed("getEvent");
export const getEventsByEmail = routed("getEventsByEmail");
export const upsertEvent = routed("upsertEvent");
export const upsertEventWithResult = routed("upsertEventWithResult");
