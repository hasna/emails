import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type ProviderToolName =
  | "list_providers"
  | "add_provider"
  | "update_provider"
  | "remove_provider";

async function runProviderTool(name: ProviderToolName, input: Record<string, unknown>) {
  const { runProviderTool: run } = await import("./providers-impl.js");
  return run(name, input);
}

export function registerProviderTools(server: McpServer): void {
// ─── PROVIDERS ────────────────────────────────────────────────────────────────

  server.tool(
  "list_providers",
  "List all configured email providers",
  {
    limit: z.number().int().positive().max(1000).optional().describe("Maximum providers to return"),
    offset: z.number().int().min(0).optional().describe("Number of providers to skip"),
  },
  async ({ limit, offset }) => {
    return runProviderTool("list_providers", { limit, offset });
  },
);

  server.tool(
  "add_provider",
  "Add a new email provider (resend, ses, or sandbox)",
  {
    name: z.string().describe("Provider name"),
    type: z.enum(["resend", "ses", "sandbox"]).describe("Provider type"),
    api_key: z.string().optional().describe("Resend API key"),
    region: z.string().optional().describe("SES region (e.g. us-east-1)"),
    access_key: z.string().optional().describe("SES access key ID"),
    secret_key: z.string().optional().describe("SES secret access key"),
    skip_validation: z.boolean().optional().describe("Skip credential validation after adding (default: false)"),
  },
  async (input) => {
    return runProviderTool("add_provider", input);
  },
);

  server.tool(
  "update_provider",
  "Update an existing email provider's configuration",
  {
    id: z.string().describe("Provider ID (or prefix)"),
    name: z.string().optional().describe("New provider name"),
    api_key: z.string().optional().describe("Resend API key"),
    region: z.string().optional().describe("SES region"),
    access_key: z.string().optional().describe("SES access key ID"),
    secret_key: z.string().optional().describe("SES secret access key"),
  },
  async (input) => {
    return runProviderTool("update_provider", input);
  },
);

  server.tool(
  "remove_provider",
  "Remove a provider by ID",
  {
    provider_id: z.string().describe("Provider ID (or prefix)"),
  },
  async ({ provider_id }) => {
    return runProviderTool("remove_provider", { provider_id });
  },
);

}
