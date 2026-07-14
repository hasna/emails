import * as local from "./forwarding.local.js";
import * as remote from "./forwarding.remote.js";
import { getEmailsMode } from "./mode.js";

export type * from "./forwarding.local.js";

function routed<K extends keyof typeof local>(key: K): typeof local[K] {
  return ((...args: unknown[]) => {
    const implementation = (getEmailsMode() === "self_hosted" ? remote : local) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`forwarding.${String(key)} is unavailable in the selected mode.`);
    return candidate(...args);
  }) as typeof local[K];
}

export const processForwardingRules = routed("processForwardingRules");
