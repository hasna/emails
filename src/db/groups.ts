import * as local from "./groups.local.js";
import * as remote from "./groups.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument, withExplicitDatabaseRoute } from "./database-routing.js";

export type * from "./groups.local.js";

const localCompat = {
  ...local,
  listGroups: (opts) => local.listGroups(undefined, opts),
  listMembers: (groupId, opts) => local.listMembers(groupId, undefined, opts),
  listMemberSummaries: (groupId, opts) => local.listMemberSummaries(groupId, undefined, opts),
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (hasDatabaseArgument(args) ? local : isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`groups.${String(key)} is unavailable in the selected mode.`);
    return withExplicitDatabaseRoute(args, () => (candidate as (...values: unknown[]) => unknown)(...args));
  }) as RoutedFunction<K>;
}

export const createGroup = routed("createGroup");
export const getGroup = routed("getGroup");
export const getGroupByName = routed("getGroupByName");
export const listGroups = routed("listGroups");
export const deleteGroup = routed("deleteGroup");
export const addMember = routed("addMember");
export const removeMember = routed("removeMember");
export const listMembers = routed("listMembers");
export const listMemberSummaries = routed("listMemberSummaries");
export const getMember = routed("getMember");
export const getMemberCount = routed("getMemberCount");
export const getMemberCounts = routed("getMemberCounts");
