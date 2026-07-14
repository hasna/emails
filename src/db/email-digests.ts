import * as local from "./email-digests.local.js";
import * as remote from "./email-digests.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument, withExplicitDatabaseRoute } from "./database-routing.js";

export type * from "./email-digests.local.js";

const localCompat = {
  ...local,
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (hasDatabaseArgument(args) ? local : isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`email-digests.${String(key)} is unavailable in the selected mode.`);
    return withExplicitDatabaseRoute(args, () => (candidate as (...values: unknown[]) => unknown)(...args));
  }) as RoutedFunction<K>;
}

export const normalizeEmailDigestPeriod = routed("normalizeEmailDigestPeriod");
export const emailDigestPeriodLabel = routed("emailDigestPeriodLabel");
export const saveEmailDigest = routed("saveEmailDigest");
export const getEmailDigest = routed("getEmailDigest");
export const getLatestEmailDigest = routed("getLatestEmailDigest");
export const listEmailDigests = routed("listEmailDigests");
