import * as local from "./address-lifecycle.local.js";
import * as remote from "./address-lifecycle.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";

export type * from "./address-lifecycle.local.js";

const localCompat = {
  ...local,
} as typeof remote;

function routed<K extends keyof typeof remote>(key: K): typeof remote[K] {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`address-lifecycle.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as typeof remote[K];
}

export const suspendAddress = routed("suspendAddress");
export const activateAddress = routed("activateAddress");
export const setAddressQuota = routed("setAddressQuota");
export const countSendsToday = routed("countSendsToday");
export const countSendsTodayByAddress = routed("countSendsTodayByAddress");
export const getAddressSendability = routed("getAddressSendability");
