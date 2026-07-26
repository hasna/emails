import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.local.js";
import { listSandboxEmails } from "../db/sandbox.local.js";
import { mcpTestRequestInit, startTestMcpHttpServer } from "../test-support/mcp-http.js";
import { startHttpServer } from "./http.js";
import { buildServer } from "./server.js";

let server: ReturnType<typeof startHttpServer> | null = null;

beforeEach(() => {
  process.env["EMAILS_MODE"] = "local";
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  server?.stop(true);
  server = null;
  closeDatabase();
  delete process.env["EMAILS_MODE"];
  delete process.env["EMAILS_DB_PATH"];
});

describe("MCP local mode", () => {
  it("sends and lists mail through SQLite and a sandbox provider", async () => {
    const provider = createProvider({ name: "mcp-local", type: "sandbox", active: true });
    server = startTestMcpHttpServer();
    const client = new Client({ name: "emails-local-mode-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), mcpTestRequestInit());
    await client.connect(transport, { timeout: 10_000 });

    try {
      const sent = await client.callTool({
        name: "send_email",
        arguments: {
          provider_id: provider.id,
          from: "sender@example.test",
          to: "recipient@example.test",
          subject: "Local MCP smoke",
          text: "stored locally",
        },
      }, undefined, { timeout: 10_000 });
      const sentText = sent.content[0]?.type === "text" ? sent.content[0].text : "";
      expect(sentText).toContain('"success": true');

      const listed = await client.callTool({
        name: "list_emails",
        arguments: { provider_id: provider.id, limit: 10 },
      }, undefined, { timeout: 10_000 });
      const listedText = listed.content[0]?.type === "text" ? listed.content[0].text : "";
      expect(listedText).toContain("Local MCP smoke");
      expect(listSandboxEmails(provider.id, 10)).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("does not apply the self_hosted provisioning guard to infrastructure tools", async () => {
    // The self_hosted refusal added for setup_domain_for_email / setup_cloudflare_dns
    // must not leak into local mode, where these tools legitimately drive the
    // operator's own cloud account. Passing an unresolvable provider id proves
    // execution reached the real implementation (it fails at provider resolution,
    // which happens *after* the mode guard) without making any cloud call.
    const server = buildServer() as unknown as {
      _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> }>;
    };

    for (const name of ["setup_domain_for_email", "setup_cloudflare_dns"]) {
      const result = await server._registeredTools[name]!.handler({
        domain: "example.test",
        provider_id: "no-such-provider",
      });
      expect(result.isError).toBe(true);
      const text = result.content[0]?.text ?? "";
      expect(text).not.toContain("disabled in self_hosted mode");
      expect(text).toContain("Could not resolve ID 'no-such-provider' in table 'providers'");
    }
  });
});
