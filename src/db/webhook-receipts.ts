import * as local from "./webhook-receipts.local.js";
import * as remote from "./webhook-receipts.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument } from "./database-routing.js";

export type * from "./webhook-receipts.local.js";

const localCompat = {
  ...local,
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : hasDatabaseArgument(args) ? local : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`webhook-receipts.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as RoutedFunction<K>;
}

export const getWebhookReceipt = routed("getWebhookReceipt");
export const recordWebhookReceipt = routed("recordWebhookReceipt");
