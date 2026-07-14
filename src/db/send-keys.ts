import * as local from "./send-keys.local.js";
import * as remote from "./send-keys.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";

export type * from "./send-keys.local.js";

const localCompat = {
  ...local,
  listSendKeys: (ownerId, opts) => local.listSendKeys(ownerId, undefined, opts),
  listSendKeySummaries: (ownerId, opts) => local.listSendKeySummaries(ownerId, undefined, opts),
} as typeof remote;

function routed<K extends keyof typeof remote>(key: K): typeof remote[K] {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`send-keys.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as typeof remote[K];
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
