import * as local from "./analytics.local.js";
import * as remote from "./analytics.remote.js";
import { getEmailsMode } from "./mode.js";

export type * from "./analytics.local.js";

function routed<K extends keyof typeof local>(key: K): typeof local[K] {
  return ((...args: unknown[]) => {
    const implementation = (getEmailsMode() === "self_hosted" ? remote : local) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`analytics.${String(key)} is unavailable in the selected mode.`);
    return candidate(...args);
  }) as typeof local[K];
}

export const getAnalytics = routed("getAnalytics");
export const formatAnalytics = routed("formatAnalytics");
