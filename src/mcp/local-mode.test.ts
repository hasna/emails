import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createDomain } from "../db/domains.local.js";
import { createProvider } from "../db/providers.local.js";
import { listSandboxEmails } from "../db/sandbox.js";
import { mcpTestRequestInit, startTestMcpHttpServer } from "../test-support/mcp-http.js";
import { startHttpServer } from "./http.js";
import { buildServer } from "./server.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}
function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

let server: ReturnType<typeof startHttpServer> | null = null;

beforeEach(() => {
  captureInheritedProcessEnv();
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
  restoreInheritedProcessEnv();
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
      expect(await listSandboxEmails(provider.id, 10)).toHaveLength(1);
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

  it("explains that a sandbox domain has no DNS records rather than reporting none found", async () => {
    // The reachable end of this defect. `get_dns_records` on a sandbox domain
    // answered "No DNS records found." — indistinguishable from a failed lookup or
    // a misconfigured domain, and the caller here is normally an agent that would
    // then tell the operator their DNS is broken. Sandbox structurally has none.
    const provider = createProvider({ name: "mcp-local-sandbox-dns", type: "sandbox", active: true });
    createDomain(provider.id, "sandbox-dns.test");
    server = startTestMcpHttpServer();
    const client = new Client({ name: "emails-sandbox-dns-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), mcpTestRequestInit());
    await client.connect(transport, { timeout: 10_000 });

    try {
      // Both resolution paths: explicit provider_id, and inferred from the domain
      // row. They took the same formatting call site, so both had the same bug.
      for (const args of [{ domain: "sandbox-dns.test", provider_id: provider.id }, { domain: "sandbox-dns.test" }]) {
        const result = await client.callTool({ name: "get_dns_records", arguments: args }, undefined, { timeout: 10_000 });
        expect(result.isError).toBeFalsy();
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        const payload = JSON.parse(text) as { result?: string };
        const message = payload.result ?? "";

        expect(message).toContain("none are expected");
        expect(message).toContain("captures mail in the local store");
        expect(message).toContain("SES or Resend");
        // The remedy has to be runnable: `emails domain move-provider` is wired to
        // a real action, unlike most of the neighbouring domain subcommands.
        expect(message).toContain("emails domain move-provider <domain> --to-provider <id>");
        // The exact regression: the old sentence, and the "not found" reading of it.
        expect(message).not.toContain("No DNS records found");
        expect(message).not.toContain("found");
      }
    } finally {
      await client.close();
    }
  });
});
