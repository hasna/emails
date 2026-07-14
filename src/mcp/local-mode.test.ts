import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.local.js";
import { listSandboxEmails } from "../db/sandbox.local.js";
import { startHttpServer } from "./http.js";

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
    server = startHttpServer({ port: 0, log: () => {} });
    const client = new Client({ name: "emails-local-mode-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));
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
});
