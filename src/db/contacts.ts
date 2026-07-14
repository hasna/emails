import * as local from "./contacts.local.js";
import * as remote from "./contacts.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument, withExplicitDatabaseRoute } from "./database-routing.js";

export type * from "./contacts.local.js";

const localCompat = {
  ...local,
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (hasDatabaseArgument(args) ? local : isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`contacts.${String(key)} is unavailable in the selected mode.`);
    return withExplicitDatabaseRoute(args, () => (candidate as (...values: unknown[]) => unknown)(...args));
  }) as RoutedFunction<K>;
}

export const upsertContact = routed("upsertContact");
export const getContact = routed("getContact");
export const listContacts = routed("listContacts");
export const suppressContact = routed("suppressContact");
export const unsuppressContact = routed("unsuppressContact");
export const incrementSendCount = routed("incrementSendCount");
export const incrementSendCounts = routed("incrementSendCounts");
export const incrementBounceCount = routed("incrementBounceCount");
export const incrementBounceCounts = routed("incrementBounceCounts");
export const incrementComplaintCount = routed("incrementComplaintCount");
export const incrementComplaintCounts = routed("incrementComplaintCounts");
export const isContactSuppressed = routed("isContactSuppressed");
export const getSuppressedEmailSet = routed("getSuppressedEmailSet");
