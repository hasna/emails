import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAgentContext, getEmailSystemStatus, getNextEmailAction } from "../../lib/agent-context.js";
import { diagnoseInboundDelivery } from "../../lib/delivery-doctor.js";
import { formatError } from "../helpers.js";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerAgentTools(server: McpServer): void {
  server.tool(
    "get_email_status",
    "Get redacted email system health, inbox source status, ownership counts, and next actions.",
    {},
    async () => {
      try {
        return json({ ...getEmailSystemStatus(), cli_equivalent: "emails status --json" });
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "get_agent_context",
    "Get a redacted orientation snapshot and recommended workflows for agents using this emails app.",
    {},
    async () => {
      try {
        return json({ ...getAgentContext(), cli_equivalent: "emails agent context --json" });
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "get_next_action",
    "Suggest the next useful email CLI action for a high-level goal.",
    {
      goal: z.string().optional().describe("High-level task, e.g. 'wait for a verification code' or 'diagnose missing inbound mail'"),
    },
    async ({ goal }) => {
      try {
        return json({ ...getNextEmailAction(goal), cli_equivalent: "emails status --json" });
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "diagnose_inbound_delivery",
    "Diagnose why inbound mail may not be reaching a local address.",
    {
      address: z.string().describe("Recipient email address to diagnose"),
    },
    async ({ address }) => {
      try {
        return json(diagnoseInboundDelivery(address));
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );
}
