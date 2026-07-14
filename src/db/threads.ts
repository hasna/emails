import * as local from "./threads.local.js";
import * as remote from "./threads.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";

export type * from "./threads.local.js";

const localCompat = {
  ...local,
} as typeof remote;

function routed<K extends keyof typeof remote>(key: K): typeof remote[K] {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`threads.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as typeof remote[K];
}

export const setEmailThreading = routed("setEmailThreading");
export const getEmailThreading = routed("getEmailThreading");
export const getEmailByMessageId = routed("getEmailByMessageId");
export const setInboundThreadId = routed("setInboundThreadId");
export const getThreadMessages = routed("getThreadMessages");
export const resolveThreadForInbound = routed("resolveThreadForInbound");
