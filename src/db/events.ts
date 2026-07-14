import * as local from "./events.local.js";
import * as remote from "./events.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";

export type * from "./events.local.js";

const localCompat = {
  ...local,
} as typeof remote;

function routed<K extends keyof typeof remote>(key: K): typeof remote[K] {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`events.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as typeof remote[K];
}

export const createEvent = routed("createEvent");
export const listEvents = routed("listEvents");
export const listEventSummaries = routed("listEventSummaries");
export const getEvent = routed("getEvent");
export const getEventsByEmail = routed("getEventsByEmail");
export const upsertEvent = routed("upsertEvent");
export const upsertEventWithResult = routed("upsertEventWithResult");
