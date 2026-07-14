import * as local from "./send-keys.local.js";
import * as remote from "./send-keys.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument, withExplicitDatabaseRoute } from "./database-routing.js";

export type * from "./send-keys.local.js";

const localCompat = {
  ...local,
  listSendKeys: (ownerId, opts) => local.listSendKeys(ownerId, undefined, opts),
  listSendKeySummaries: (ownerId, opts) => local.listSendKeySummaries(ownerId, undefined, opts),
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (hasDatabaseArgument(args) ? local : isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`send-keys.${String(key)} is unavailable in the selected mode.`);
    return withExplicitDatabaseRoute(args, () => (candidate as (...values: unknown[]) => unknown)(...args));
  }) as RoutedFunction<K>;
}

export const createSendKey = routed("createSendKey");
export const getSendKey = routed("getSendKey");
export const verifySendKey = routed("verifySendKey");
export const listSendKeys = routed("listSendKeys");
export const listSendKeySummaries = routed("listSendKeySummaries");
export const listSendKeysByOwners = routed("listSendKeysByOwners");
export const listSendKeySummariesByOwners = routed("listSendKeySummariesByOwners");
export const revokeSendKey = routed("revokeSendKey");
export const canOwnerSendFrom = routed("canOwnerSendFrom");
export const assertSendAuthorized = routed("assertSendAuthorized");
