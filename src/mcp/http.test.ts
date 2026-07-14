import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";

// Self-hosted-ONLY: the MCP HTTP transport serves tools that route through the
// operator's /v1 API (no local SQLite). All fixtures are seeded on the /v1 stub;
// the tool handlers read them back over their normal transport.
//
// NOTE (migration): several tests from the local-DB era were dropped because the
// behaviour they exercised no longer exists in the self-hosted client — see the
// task report. Namely: send-key one-time tokens (createSendKey now refuses; tokens
// are server-minted), address-ownership tools, prepare_inbox, provision_status,
// group-member summaries, warming-schedule listing, and the structured remove_provider
// error contract (all guarded or moved server-side).

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { buildServer } = await import("./server.js");
const { DEFAULT_MCP_HTTP_PORT, MCP_NAME, startHttpServer } = await import("./http.js");

const servers: Array<ReturnType<typeof startHttpServer>> = [];
let stub: V1Stub;

async function withClient<T>(name: string, run: (client: InstanceType<typeof Client>) => Promise<T>): Promise<T> {
  const server = startHttpServer({ port: 0, log: () => {} });
  servers.push(server);
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));
  await client.connect(transport, { timeout: 10_000 });
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

async function callText(client: InstanceType<typeof Client>, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
  return result.content[0]?.type === "text" ? result.content[0].text : "";
}

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  stub.clearEnv();
});

describe("emails-mcp HTTP transport", () => {
  it("exposes health and serves MCP over Streamable HTTP", async () => {
    await stub.seed({ groups: [{ id: "g1", name: "api-group", description: null }] });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", name: MCP_NAME });

    const client = new Client({ name: "emails-mcp-http-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });

      const tools = await client.listTools(undefined, { timeout: 10_000 });
      expect(tools.tools.some((tool) => tool.name === "list_groups")).toBe(true);
      for (const name of [
        "prepare_inbox",
        "wait_for_code",
        "list_usable_from_addresses",
        "provision_address",
        "get_address_owner",
        "set_address_owner",
        "transfer_address_owner",
        "unassign_address_owner",
        "list_address_owner_history",
      ]) {
        expect(tools.tools.some((tool) => tool.name === name)).toBe(true);
      }
      const removedTools = [
        ["get", "triage"],
        ["list", "triaged"],
        ["triage", "stats"],
        ["delete", "triage"],
        ["register", "agent"],
        ["heart", "beat"],
        ["set", "focus"],
        ["list", "agents"],
      ].map((parts) => parts.join("_"));
      for (const removed of removedTools) {
        expect(tools.tools.some((tool) => tool.name === removed)).toBe(false);
      }

      const resources = await client.listResources(undefined, { timeout: 10_000 });
      for (const uri of ["emails://agent/context", "emails://agent/context/full", "emails://status", "emails://domains", "emails://addresses", "emails://recent-errors"]) {
        expect(resources.resources.some((resource) => resource.uri === uri)).toBe(true);
      }
      const status = await client.readResource({ uri: "emails://status" }, { timeout: 10_000 });
      expect(status.contents[0]?.mimeType).toBe("application/json");

      const groups = await client.callTool(
        { name: "list_groups", arguments: {} },
        undefined,
        { timeout: 10_000 },
      );
      expect(groups.content[0]?.type).toBe("text");
    } finally {
      await client.close();
    }
  });

  it("uses the assigned default port constant", () => {
    expect(DEFAULT_MCP_HTTP_PORT).toBe(8861);
  });

  it("advertises bounded schemas for expensive MCP tool inputs", async () => {
    await withClient("emails-mcp-schema-bounds-test", async (client) => {
      const tools = await client.listTools(undefined, { timeout: 10_000 });
      const props = (name: string) => {
        const schema = tools.tools.find((tool) => tool.name === name)?.inputSchema as { properties?: Record<string, { default?: unknown; maximum?: number; description?: string }> } | undefined;
        return schema?.properties ?? {};
      };

      expect(props("list_emails").limit?.maximum).toBe(1000);
      expect(props("search_emails").limit?.maximum).toBe(1000);
      expect(props("search_emails").offset?.description).toContain("Pagination offset");
      expect(props("sync_s3_inbox").limit?.maximum).toBe(10000);
      expect(props("provision_address").timeout_seconds?.maximum).toBe(300);
      expect(props("provision_address").interval_seconds?.maximum).toBe(60);
      expect(props("register_domain").duration_years?.maximum).toBe(10);
      expect(props("get_latest_inbound_email").limit?.description).toContain("latest returns one");
      expect(props("list_replies").limit?.maximum).toBe(100);
    });
  });

  it("redacts provider credentials in MCP tool results", async () => {
    await stub.seed({
      providers: [{
        id: "p1",
        name: "secret-ses",
        type: "ses",
        access_key: "AKIA_MCP_SHOULD_NOT_LEAK",
        secret_key: "MCP_SECRET_SHOULD_NOT_LEAK",
        oauth_refresh_token: "OAUTH_MCP_SHOULD_NOT_LEAK",
        region: "us-east-1",
      }],
    });
    await withClient("emails-mcp-redaction-test", async (client) => {
      const text = await callText(client, "list_providers", {});
      expect(text).not.toContain('"access_key"');
      expect(text).not.toContain('"secret_key"');
      expect(text).not.toContain('"oauth_refresh_token"');
      expect(text).toContain('"cli_equivalent": "emails provider list --json"');
      expect(text).not.toContain("AKIA_MCP_SHOULD_NOT_LEAK");
      expect(text).not.toContain("MCP_SECRET_SHOULD_NOT_LEAK");
      expect(text).not.toContain("OAUTH_MCP_SHOULD_NOT_LEAK");
    });
  });

  it("redacts sensitive config values in MCP tool results", async () => {
    const originalHome = process.env["HOME"];
    const tmpHome = mkdtempSync(join(tmpdir(), "emails-mcp-config-"));
    process.env["HOME"] = tmpHome;

    try {
      await withClient("emails-mcp-config-redaction-test", async (client) => {
        const setText = await callText(client, "set_config", { key: "cloudflare_api_token", value: "MCP_CONFIG_SECRET" });
        expect(setText).toContain('"cloudflare_api_token": "***"');
        expect(setText).not.toContain("MCP_CONFIG_SECRET");

        const getText = await callText(client, "get_config", { key: "cloudflare_api_token" });
        expect(getText).toContain('"cloudflare_api_token": "***"');
        expect(getText).not.toContain("MCP_CONFIG_SECRET");

        const listText = await callText(client, "list_config", {});
        expect(listText).toContain('"cloudflare_api_token": "***"');
        expect(listText).not.toContain("MCP_CONFIG_SECRET");
      });
    } finally {
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("paginates provider listing through MCP (newest-first by created_at)", async () => {
    await stub.seed({
      providers: [
        { id: "prov-1", name: "provider-1", type: "sandbox", created_at: "2026-01-01T00:00:00.000Z" },
        { id: "prov-2", name: "provider-2", type: "sandbox", created_at: "2026-01-02T00:00:00.000Z" },
        { id: "prov-3", name: "provider-3", type: "sandbox", created_at: "2026-01-03T00:00:00.000Z" },
        { id: "prov-4", name: "provider-4", type: "sandbox", created_at: "2026-01-04T00:00:00.000Z" },
      ],
    });
    await withClient("emails-mcp-provider-paging-test", async (client) => {
      const text = await callText(client, "list_providers", { limit: 2, offset: 1 });
      const parsed = JSON.parse(text) as { providers: Array<{ name: string }>; limit: number; offset: number };
      expect(parsed.providers.map((provider) => provider.name)).toEqual(["provider-3", "provider-2"]);
      expect(parsed.limit).toBe(2);
      expect(parsed.offset).toBe(1);
    });
  });

  it("returns lean template summaries through list_templates and full details through get_template", async () => {
    await stub.seed({
      templates: [{
        id: "tpl-1",
        name: "mcp-template-summary",
        subject_template: "MCP template summary",
        html_template: `<main>${"MCP template hidden html ".repeat(200)}</main>`,
        text_template: "MCP template hidden text ".repeat(200),
        created_at: "2026-01-01T00:00:00.000Z",
      }],
    });
    await withClient("emails-mcp-template-summary-test", async (client) => {
      const listText = await callText(client, "list_templates", { limit: 1 });
      const listed = JSON.parse(listText) as { items: Array<Record<string, unknown>>; cli_equivalent: string };
      const [row] = listed.items;

      expect(row?.name).toBe("mcp-template-summary");
      expect(row?.has_html_template).toBe(true);
      expect(row?.has_text_template).toBe(true);
      expect(row).not.toHaveProperty("html_template");
      expect(row).not.toHaveProperty("text_template");
      expect(JSON.stringify(listed)).not.toContain("MCP template hidden");
      expect(listed.cli_equivalent).toBe("emails template list --limit 1 --json");

      const detailText = await callText(client, "get_template", { name_or_id: "mcp-template-summary" });
      const detail = JSON.parse(detailText) as Record<string, unknown>;

      expect(detail.name).toBe("mcp-template-summary");
      expect(String(detail.html_template)).toContain("MCP template hidden html");
      expect(String(detail.text_template)).toContain("MCP template hidden text");
      expect(detail.cli_equivalent).toBe("emails template show mcp-template-summary --json");
    });
  });

  it("wait_for_code parses a verification code and ignores SENT rows", async () => {
    await stub.seed({
      messages: [
        {
          id: "incoming-code",
          direction: "inbound",
          from_addr: '"ChatGPT" <noreply@tm.openai.com>',
          to_addrs: ["me@example.com"],
          subject: "Your temporary ChatGPT verification code",
          body_text: "Enter this temporary verification code to continue:\n\n492255",
          status: "received",
          is_read: false,
          labels: [],
          received_at: "2026-06-04T11:29:09.000Z",
        },
        {
          id: "sent-code",
          direction: "outbound",
          from_addr: '"ChatGPT" <noreply@tm.openai.com>',
          to_addrs: ["me@example.com"],
          subject: "Your temporary ChatGPT verification code",
          body_text: "Enter this temporary verification code to continue:\n\n999999",
          status: "sent",
          labels: ["SENT"],
          created_at: "2026-06-04T11:30:09.000Z",
        },
      ],
    });
    await withClient("emails-mcp-wait-code-test", async (client) => {
      const text = await callText(client, "wait_for_code", { address: "me@example.com", from: "openai", refresh: false, timeout_seconds: 1 });
      const parsed = JSON.parse(text) as { code: string | null };
      expect(parsed.code).toBe("492255");
    });
  });
});

describe("emails-mcp buildServer", () => {
  it("registers tools for stdio and HTTP modes", () => {
    const server = buildServer();
    expect(server).toBeTruthy();
    const tools = Object.keys((server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {});
    expect(tools).toContain("extract_inbound_email_links");
  });
});
