import * as local from "./messages.local.js";
import * as remote from "./messages.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";

export type * from "./messages.local.js";

const localCompat = {
  ...local,
} as typeof remote;

function routed<K extends keyof typeof remote>(key: K): typeof remote[K] {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`messages.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as typeof remote[K];
}

export const createMailMessage = routed("createMailMessage");
export const getMailMessage = routed("getMailMessage");
export const upsertMailboxMessageState = routed("upsertMailboxMessageState");
export const getMailboxMessageState = routed("getMailboxMessageState");
export const listMailboxMessageStates = routed("listMailboxMessageStates");
