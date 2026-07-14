import * as local from "./sent-ledger.local.js";
import * as remote from "./sent-ledger.remote.js";
import { isSelfHostedMode } from "../db/self-hosted-store.js";

export type * from "./sent-ledger.local.js";

function routed<K extends keyof typeof local>(key: K): typeof local[K] {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : local) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`sent-ledger.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as typeof local[K];
}

export const createSentEmailLedger = routed("createSentEmailLedger");
export const storeSentEmailContent = routed("storeSentEmailContent");
export const setSentEmailThreading = routed("setSentEmailThreading");
