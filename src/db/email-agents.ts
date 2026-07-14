import * as local from "./email-agents.local.js";
import * as remote from "./email-agents.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";

export type * from "./email-agents.local.js";

const localCompat = {
  ...local,
} as typeof remote;

function routed<K extends keyof typeof remote>(key: K): typeof remote[K] {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`email-agents.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as typeof remote[K];
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
