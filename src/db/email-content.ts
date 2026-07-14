import * as local from "./email-content.local.js";
import * as remote from "./email-content.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument, withExplicitDatabaseRoute } from "./database-routing.js";

export type * from "./email-content.local.js";

const localCompat = {
  ...local,
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (hasDatabaseArgument(args) ? local : isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`email-content.${String(key)} is unavailable in the selected mode.`);
    return withExplicitDatabaseRoute(args, () => (candidate as (...values: unknown[]) => unknown)(...args));
  }) as RoutedFunction<K>;
}

export const storeEmailContent = routed("storeEmailContent");
export const getEmailContent = routed("getEmailContent");
