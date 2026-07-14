import * as local from "./emails.local.js";
import * as remote from "./emails.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument } from "./database-routing.js";

export type * from "./emails.local.js";

const localCompat = {
  ...local,
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : hasDatabaseArgument(args) ? local : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`emails.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as RoutedFunction<K>;
}

export const createEmail = routed("createEmail");
export const getEmail = routed("getEmail");
export const resolveEmailId = routed("resolveEmailId");
export const listEmails = routed("listEmails");
export const searchEmails = routed("searchEmails");
export const updateEmailStatus = routed("updateEmailStatus");
export const deleteEmail = routed("deleteEmail");
