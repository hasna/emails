import * as local from "./stats.local.js";
import * as remote from "./stats.remote.js";
import { getEmailsMode } from "./mode.js";

export type * from "./stats.local.js";

function routed<K extends keyof typeof local>(key: K): typeof local[K] {
  return ((...args: unknown[]) => {
    const implementation = (getEmailsMode() === "self_hosted" ? remote : local) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`stats.${String(key)} is unavailable in the selected mode.`);
    return candidate(...args);
  }) as typeof local[K];
}

export const getLocalStats = routed("getLocalStats");
export const formatStatsTable = routed("formatStatsTable");
