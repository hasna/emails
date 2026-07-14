import * as local from "./triage.local.js";
import * as remote from "./triage.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument } from "./database-routing.js";

export type * from "./triage.local.js";

const localCompat = {
  ...local,
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : hasDatabaseArgument(args) ? local : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`triage.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as RoutedFunction<K>;
}

export const saveTriage = routed("saveTriage");
export const getTriage = routed("getTriage");
export const getTriageById = routed("getTriageById");
export const listTriaged = routed("listTriaged");
export const listTriagedSummaries = routed("listTriagedSummaries");
export const getUntriaged = routed("getUntriaged");
export const deleteTriage = routed("deleteTriage");
export const deleteTriageByEmail = routed("deleteTriageByEmail");
export const getTriageStats = routed("getTriageStats");
export const clearTriage = routed("clearTriage");
