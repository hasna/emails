import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatError } from "../helpers.js";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerAgentTools(server: McpServer): void {
  server.tool(
    "prepare_inbox",
    "Prepare or diagnose an inbox address. Inbox address preparation, provisioning, and ownership run on the self-hosted server.",
    {
      email: z.string().describe("Inbox email address to prepare"),
      provider_id: z.string().optional().describe("Provider ID or prefix to use when creating a missing address"),
      receive_strategy: z.enum(["ses-s3", "cf-routing", "resend-webhook"]).optional().describe("Receive strategy for new provisioning state"),
      forward_to: z.string().optional().describe("Forward target for cf-routing"),
      owner: z.string().optional().describe("Owner name, ID, or ID prefix to assign"),
      administrator: z.string().optional().describe("Administering agent name, ID, or ID prefix"),
      create_missing: z.boolean().optional().describe("Create address/provisioning state when no exact address exists"),
    },
    async () => {
      // Inbox preparation orchestrates address/provisioning/ownership state that
      // is owned by the self-hosted server; there is no local store to prepare
      // and no client-side /v1 preparation endpoint. Fail loud (rule 6).
      return {
        content: [{
          type: "text" as const,
          text: "Error: prepare_inbox is not available in the self-hosted client; inbox address preparation, provisioning, and ownership run on the self-hosted server.",
        }],
        isError: true,
      };
    },
  );

  server.tool(
    "get_email_status",
    "Get redacted email system health, inbox source status, ownership counts, and next actions.",
    {},
    async () => {
      try {
        const { getEmailSystemStatusForRuntime } = await import("../../lib/agent-context.js");
        return json({ ...(await getEmailSystemStatusForRuntime()), cli_equivalent: "emails status --json" });
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
        const { getAgentContextForRuntime } = await import("../../lib/agent-context.js");
        return json({ ...(await getAgentContextForRuntime()), cli_equivalent: "emails agent context --json" });
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
        const { getNextEmailActionForRuntime } = await import("../../lib/agent-context.js");
        return json({ ...(await getNextEmailActionForRuntime(goal)), cli_equivalent: "emails status --json" });
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
        const { diagnoseInboundDeliveryLive } = await import("../../lib/delivery-doctor.js");
        return json(await diagnoseInboundDeliveryLive(address));
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );
}
