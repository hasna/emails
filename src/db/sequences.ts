import * as local from "./sequences.local.js";
import * as remote from "./sequences.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument, withExplicitDatabaseRoute } from "./database-routing.js";

export type * from "./sequences.local.js";

const localCompat = {
  ...local,
  listSequences: (opts) => local.listSequences(undefined, opts),
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (hasDatabaseArgument(args) ? local : isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`sequences.${String(key)} is unavailable in the selected mode.`);
    return withExplicitDatabaseRoute(args, () => (candidate as (...values: unknown[]) => unknown)(...args));
  }) as RoutedFunction<K>;
}

export const createSequence = routed("createSequence");
export const getSequence = routed("getSequence");
export const listSequences = routed("listSequences");
export const updateSequence = routed("updateSequence");
export const deleteSequence = routed("deleteSequence");
export const addStep = routed("addStep");
export const listSteps = routed("listSteps");
export const getStepAtIndex = routed("getStepAtIndex");
export const removeStep = routed("removeStep");
export const enroll = routed("enroll");
export const unenroll = routed("unenroll");
export const listEnrollments = routed("listEnrollments");
export const countEnrollmentsByStatus = routed("countEnrollmentsByStatus");
export const getDueEnrollments = routed("getDueEnrollments");
export const advanceEnrollment = routed("advanceEnrollment");
