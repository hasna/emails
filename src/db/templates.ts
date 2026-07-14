import * as local from "./templates.local.js";
import * as remote from "./templates.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";

export type * from "./templates.local.js";

const localCompat = {
  ...local,
  listTemplates: (opts) => local.listTemplates(undefined, opts),
  listTemplateSummaries: (opts) => local.listTemplateSummaries(undefined, opts),
} as typeof remote;

function routed<K extends keyof typeof remote>(key: K): typeof remote[K] {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`templates.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as typeof remote[K];
}

export const createTemplate = routed("createTemplate");
export const getTemplate = routed("getTemplate");
export const getTemplateByName = routed("getTemplateByName");
export const listTemplates = routed("listTemplates");
export const listTemplateSummaries = routed("listTemplateSummaries");
export const deleteTemplate = routed("deleteTemplate");
export const renderTemplate = routed("renderTemplate");
