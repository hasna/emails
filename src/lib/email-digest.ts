import * as local from "./email-digest.local.js";
import * as remote from "./email-digest.remote.js";
import { getEmailsMode } from "./mode.js";

export type * from "./email-digest.local.js";

function routed<K extends keyof typeof local>(key: K): typeof local[K] {
  return ((...args: unknown[]) => {
    const implementation = (getEmailsMode() === "self_hosted" ? remote : local) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`email-digest.${String(key)} is unavailable in the selected mode.`);
    return candidate(...args);
  }) as typeof local[K];
}

export const resolveEmailDigestWindow = routed("resolveEmailDigestWindow");
export const generateEmailDigest = routed("generateEmailDigest");
export const loadEmailDigest = routed("loadEmailDigest");
export const formatEmailDigest = routed("formatEmailDigest");
