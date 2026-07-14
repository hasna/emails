import * as local from "./email-agents.local.js";
import * as remote from "./email-agents.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument, withExplicitDatabaseRoute } from "./database-routing.js";

export type * from "./email-agents.local.js";

const localCompat = {
  ...local,
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (hasDatabaseArgument(args) ? local : isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`email-agents.${String(key)} is unavailable in the selected mode.`);
    return withExplicitDatabaseRoute(args, () => (candidate as (...values: unknown[]) => unknown)(...args));
  }) as RoutedFunction<K>;
}

export const normalizeEmailAgentKey = routed("normalizeEmailAgentKey");
export const getEmailAgentDefinition = routed("getEmailAgentDefinition");
export const ensureEmailAgentSettings = routed("ensureEmailAgentSettings");
export const listEmailAgentSettings = routed("listEmailAgentSettings");
export const getEmailAgentSetting = routed("getEmailAgentSetting");
export const updateEmailAgentSetting = routed("updateEmailAgentSetting");
export const listEnabledAlwaysOnEmailAgents = routed("listEnabledAlwaysOnEmailAgents");
export const saveEmailAgentRun = routed("saveEmailAgentRun");
export const getEmailAgentRun = routed("getEmailAgentRun");
export const listEmailAgentRuns = routed("listEmailAgentRuns");
export const listPendingInboundEmailsForAgent = routed("listPendingInboundEmailsForAgent");

// Storage-independent constants retain their canonical local definitions.
export const EMAIL_AGENT_DEFINITIONS = local.EMAIL_AGENT_DEFINITIONS;
