import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "../db/database.js";
import { getEmailsMode } from "../lib/mode.js";
import * as local from "./resources.local.js";
import * as remote from "./resources.remote.js";

export const domainsResourcePayload = local.domainsResourcePayload;
export const addressesResourcePayload = local.addressesResourcePayload;
export const mailboxesResourcePayload = local.mailboxesResourcePayload;
export const sourcesResourcePayload = local.sourcesResourcePayload;
export const recentErrorsResourcePayload = local.recentErrorsResourcePayload;

export function domainsResourcePayloadForRuntime(db?: Database): Record<string, unknown> {
  return getEmailsMode() === "self_hosted"
    ? remote.domainsResourcePayloadForRuntime()
    : local.domainsResourcePayload(db);
}

export async function addressesResourcePayloadForRuntime(db?: Database): Promise<Record<string, unknown>> {
  return getEmailsMode() === "self_hosted"
    ? remote.addressesResourcePayloadForRuntime()
    : local.addressesResourcePayload(db);
}

export async function agentContextResourcePayload(db?: Database): Promise<Record<string, unknown>> {
  return getEmailsMode() === "self_hosted"
    ? remote.agentContextResourcePayload()
    : local.agentContextResourcePayload(db);
}

export async function mailboxesResourcePayloadForRuntime(db?: Database): Promise<Record<string, unknown>> {
  return getEmailsMode() === "self_hosted"
    ? remote.mailboxesResourcePayloadForRuntime()
    : local.mailboxesResourcePayloadForRuntime(db);
}

export async function sourcesResourcePayloadForRuntime(db?: Database): Promise<Record<string, unknown>> {
  return getEmailsMode() === "self_hosted"
    ? remote.sourcesResourcePayloadForRuntime()
    : local.sourcesResourcePayloadForRuntime(db);
}

export function recentErrorsResourcePayloadForRuntime(db?: Database): Record<string, unknown> {
  return getEmailsMode() === "self_hosted"
    ? remote.recentErrorsResourcePayloadForRuntime()
    : local.recentErrorsResourcePayload(db);
}

export function registerEmailResources(server: McpServer): void {
  return (getEmailsMode() === "self_hosted" ? remote.registerEmailResources : local.registerEmailResources)(server);
}
