import * as local from "./mailboxes.local.js";
import * as remote from "./mailboxes.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument, withExplicitDatabaseRoute } from "./database-routing.js";

export type * from "./mailboxes.local.js";

const localCompat = {
  ...local,
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (hasDatabaseArgument(args) ? local : isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`mailboxes.${String(key)} is unavailable in the selected mode.`);
    return withExplicitDatabaseRoute(args, () => (candidate as (...values: unknown[]) => unknown)(...args));
  }) as RoutedFunction<K>;
}

export const ensureDefaultMailFolders = routed("ensureDefaultMailFolders");
export const createMailbox = routed("createMailbox");
export const getMailbox = routed("getMailbox");
export const getMailboxByAddress = routed("getMailboxByAddress");
export const listMailboxes = routed("listMailboxes");
export const createMailFolder = routed("createMailFolder");
export const getMailFolder = routed("getMailFolder");
export const getMailboxFolderByRole = routed("getMailboxFolderByRole");
export const listMailFolders = routed("listMailFolders");
