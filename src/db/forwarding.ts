import * as local from "./forwarding.local.js";
import * as remote from "./forwarding.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";

export type * from "./forwarding.local.js";

const localCompat = {
  ...local,
  listPendingForwarding: (limit, opts) => local.listPendingForwarding(limit, undefined, opts),
} as typeof remote;

function routed<K extends keyof typeof remote>(key: K): typeof remote[K] {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`forwarding.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as typeof remote[K];
}

export const createForwardingRule = routed("createForwardingRule");
export const getForwardingRule = routed("getForwardingRule");
export const listForwardingRules = routed("listForwardingRules");
export const setForwardingRuleEnabled = routed("setForwardingRuleEnabled");
export const removeForwardingRule = routed("removeForwardingRule");
export const listPendingForwarding = routed("listPendingForwarding");
export const recordForwardingDelivery = routed("recordForwardingDelivery");
