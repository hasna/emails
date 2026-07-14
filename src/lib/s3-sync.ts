import * as local from "./s3-sync.local.js";
import * as remote from "./s3-sync.remote.js";
import { getEmailsMode } from "./mode.js";

export type * from "./s3-sync.local.js";

function routed<K extends keyof typeof local>(key: K): typeof local[K] {
  return ((...args: unknown[]) => {
    const implementation = (getEmailsMode() === "self_hosted" ? remote : local) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`s3-sync.${String(key)} is unavailable in the selected mode.`);
    return candidate(...args);
  }) as typeof local[K];
}

export const listS3Sources = routed("listS3Sources");
export const listLiveS3Sources = routed("listLiveS3Sources");
export const registerS3Source = routed("registerS3Source");
export const retireS3Source = routed("retireS3Source");
export const syncS3Inbox = routed("syncS3Inbox");
