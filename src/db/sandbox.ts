import * as local from "./sandbox.local.js";
import * as remote from "./sandbox.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";

export type * from "./sandbox.local.js";

const localCompat = {
  ...local,
} as typeof remote;

function routed<K extends keyof typeof remote>(key: K): typeof remote[K] {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`sandbox.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as typeof remote[K];
}

export const storeSandboxEmail = routed("storeSandboxEmail");
export const listSandboxEmails = routed("listSandboxEmails");
export const listSandboxEmailSummaries = routed("listSandboxEmailSummaries");
export const getSandboxEmail = routed("getSandboxEmail");
export const clearSandboxEmails = routed("clearSandboxEmails");
export const getSandboxCount = routed("getSandboxCount");
