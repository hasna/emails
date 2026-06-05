import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAgentContext, getEmailSystemStatus } from "../lib/agent-context.js";

function jsonResource(uri: string, value: unknown) {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(value, null, 2),
    }],
  };
}

export function registerEmailResources(server: McpServer): void {
  server.registerResource(
    "emails-agent-context",
    "emails://agent/context",
    {
      title: "Emails Agent Context",
      description: "Redacted system snapshot and recommended CLI workflows for coding agents.",
      mimeType: "application/json",
    },
    async () => jsonResource("emails://agent/context", getAgentContext()),
  );

  server.registerResource(
    "emails-status",
    "emails://status",
    {
      title: "Emails Status",
      description: "Redacted email system status, source health, and next actions.",
      mimeType: "application/json",
    },
    async () => jsonResource("emails://status", getEmailSystemStatus()),
  );

  server.registerResource(
    "emails-inbox-sync-status",
    "emails://inbox/sync-status",
    {
      title: "Emails Inbox Sync Status",
      description: "Inbox source status for S3, realtime queue, and Gmail sync.",
      mimeType: "application/json",
    },
    async () => {
      const status = getEmailSystemStatus();
      return jsonResource("emails://inbox/sync-status", {
        inbox: status.inbox,
        gmail: status.providers.gmail,
        cli_equivalents: status.cli_equivalents,
      });
    },
  );
}
