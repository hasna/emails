import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getEmailsMode } from "../../lib/mode.js";
import { registerEmailOpsTools as registerLocal } from "./email-ops.local.js";
import { registerEmailOpsTools as registerRemote } from "./email-ops.remote.js";

export function registerEmailOpsTools(server: McpServer): void {
  return (getEmailsMode() === "self_hosted" ? registerRemote : registerLocal)(server);
}
