import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { buildServer } from "./server.js";

// Self-hosted-ONLY: there is no local SQLite. These guards prove that send routes
// through the /v1 stub and that local-state tools fail fast with the API-only guard
// message (the guards still live in src/mcp/tools/{email-ops,misc-ops}.ts).

let stub: V1Stub;

async function callTool(name: string, args: Record<string, unknown>) {
  const server = buildServer() as unknown as {
    _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> }>;
  };
  return await server._registeredTools[name]!.handler(args);
}

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? "";
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
  stub.clearEnv();
});

describe("MCP self_hosted guards", () => {
  it("routes send_email through the self-hosted API without touching a local DB", async () => {
    const result = await callTool("send_email", {
      from: "ops@example.com",
      to: ["user@example.com"],
      subject: "Self-hosted MCP send",
      text: "hello",
      idempotency_key: "mcp-self-hosted-send",
    });

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(resultText(result)) as { success: boolean; email_id: string; message_id: string };
    expect(payload.success).toBe(true);
    expect(payload.email_id.length).toBeGreaterThan(0);
    expect(payload.message_id.length).toBeGreaterThan(0);

    // The send persisted an outbound row on the /v1 store (not a local DB).
    const messages = await stub.list("messages");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      direction: "outbound",
      from: "ops@example.com",
      to: ["user@example.com"],
      subject: "Self-hosted MCP send",
      text: "hello",
      idempotency_key: "mcp-self-hosted-send",
    });
  });

  it("fires the email-ops self_hosted API-only guard for local-only send options", async () => {
    // send_email routes to /v1, but local-only options (e.g. provider_id) are
    // rejected by the email-ops "self_hosted API-only mode" guard before any call.
    const result = await callTool("send_email", {
      from: "ops@example.com",
      to: ["user@example.com"],
      subject: "guarded",
      text: "hi",
      provider_id: "provider-1",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("self_hosted API-only mode");
  });

  it("fails self-hosted-client-only tools without touching a local DB", async () => {
    // These read/write server-owned state; the self-hosted client refuses them.
    const cases: Array<[string, Record<string, unknown>]> = [
      ["batch_send", { recipients: [], template_name: "welcome", from_address: "ops@example.com" }],
      ["pull_events", {}],
      ["get_stats", {}],
      ["sync_s3_inbox", { bucket: "inbound-bucket" }],
      ["provision_address", { email: "ops@example.com", provider_id: "provider-1" }],
      ["provision_status", {}],
    ];

    for (const [name, args] of cases) {
      const result = await callTool(name, args);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("not available in the self-hosted client");
    }
  });

  it("routes read tools through /v1 (empty store yields empty lists, no local DB)", async () => {
    for (const name of ["list_templates", "list_sandbox_emails", "export_emails"]) {
      const result = await callTool(name, {});
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse(resultText(result)) as { items: unknown[] };
      expect(payload.items).toEqual([]);
    }
  });
});
