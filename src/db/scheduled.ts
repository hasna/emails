import * as local from "./scheduled.local.js";
import * as remote from "./scheduled.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument } from "./database-routing.js";

export type * from "./scheduled.local.js";

const localCompat = {
  ...local,
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : hasDatabaseArgument(args) ? local : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`scheduled.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as RoutedFunction<K>;
}

export const createScheduledEmail = routed("createScheduledEmail");
export const getScheduledEmail = routed("getScheduledEmail");
export const listScheduledEmails = routed("listScheduledEmails");
export const listScheduledEmailSummaries = routed("listScheduledEmailSummaries");
export const cancelScheduledEmail = routed("cancelScheduledEmail");
export const getDueEmails = routed("getDueEmails");
export const markSent = routed("markSent");
export const markFailed = routed("markFailed");
