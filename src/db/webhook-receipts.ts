import * as local from "./webhook-receipts.local.js";
import * as remote from "./webhook-receipts.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";

export type * from "./webhook-receipts.local.js";

const localCompat = {
  ...local,
} as typeof remote;

function routed<K extends keyof typeof remote>(key: K): typeof remote[K] {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`webhook-receipts.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as typeof remote[K];
}

export const getWebhookReceipt = routed("getWebhookReceipt");
export const recordWebhookReceipt = routed("recordWebhookReceipt");
