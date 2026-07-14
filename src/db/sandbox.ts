import * as local from "./sandbox.local.js";
import * as remote from "./sandbox.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument } from "./database-routing.js";

export type * from "./sandbox.local.js";

const localCompat = {
  ...local,
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : hasDatabaseArgument(args) ? local : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`sandbox.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as RoutedFunction<K>;
}

export const storeSandboxEmail = routed("storeSandboxEmail");
export const listSandboxEmails = routed("listSandboxEmails");
export const listSandboxEmailSummaries = routed("listSandboxEmailSummaries");
export const getSandboxEmail = routed("getSandboxEmail");
export const clearSandboxEmails = routed("clearSandboxEmails");
export const getSandboxCount = routed("getSandboxCount");
