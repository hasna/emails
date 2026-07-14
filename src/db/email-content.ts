import * as local from "./email-content.local.js";
import * as remote from "./email-content.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";

export type * from "./email-content.local.js";

const localCompat = {
  ...local,
} as typeof remote;

function routed<K extends keyof typeof remote>(key: K): typeof remote[K] {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`email-content.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as typeof remote[K];
}

export const storeEmailContent = routed("storeEmailContent");
export const getEmailContent = routed("getEmailContent");
