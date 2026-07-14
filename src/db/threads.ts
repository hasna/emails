import * as local from "./threads.local.js";
import * as remote from "./threads.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument } from "./database-routing.js";

export type * from "./threads.local.js";

const localCompat = {
  ...local,
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : hasDatabaseArgument(args) ? local : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`threads.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as RoutedFunction<K>;
}

export const setEmailThreading = routed("setEmailThreading");
export const getEmailThreading = routed("getEmailThreading");
export const getEmailByMessageId = routed("getEmailByMessageId");
export const setInboundThreadId = routed("setInboundThreadId");
export const getThreadMessages = routed("getThreadMessages");
export const resolveThreadForInbound = routed("resolveThreadForInbound");
