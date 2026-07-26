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
      id: payload.email_id,
      direction: "outbound",
      from_addr: "ops@example.com",
      to_addrs: ["user@example.com"],
      subject: "Self-hosted MCP send",
      body_text: "hello",
      status: "sent",
      send_state: "sent",
      provider_message_id: payload.message_id,
      message_id: "stub-1",
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
    ];

    for (const [name, args] of cases) {
      const result = await callTool(name, args);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("not available in the self-hosted client");
    }
  });

  it("tells the truth about provisioning tools that no mode implements", async () => {
    // The local provisioning orchestrator was unreachable dead code and is gone;
    // the self-hosted server exposes no /v1 provisioning route. Claiming these
    // "run on the self-hosted server" sent operators looking for a service that
    // does not exist, so the error names the real, runnable alternative instead.
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["provision_address", { email: "ops@example.com", provider_id: "provider-1" }, "emails address add"],
      ["provision_status", {}, "emails domain list --json"],
      ["provision_domain", { domain: "example.com", provider_id: "provider-1" }, "emails domain adopt"],
    ];

    for (const [name, args, alternative] of cases) {
      const result = await callTool(name, args);
      expect(result.isError).toBe(true);
      const text = resultText(result);
      expect(text).toContain("is not implemented in this build");
      expect(text).toContain(alternative);
      expect(text).not.toContain("runs on the self-hosted server");
      expect(text).not.toContain("not available in the self-hosted client");
    }
  });

  it("refuses infrastructure-mutating provisioning tools instead of using client cloud credentials", async () => {
    // In self_hosted mode `getProvider` returns a row whose secrets are nulled by
    // policy, so the SES adapter would resolve credentials from the CLIENT's
    // ambient AWS_* environment and Cloudflare from the client's token — while
    // `createDomain` writes into the OPERATOR's shared domain state. That lets a
    // tenant member stand up a SES identity in their own AWS account and record a
    // domain the operator's SES cannot send from, so these refuse outright.
    const cases: Array<[string, Record<string, unknown>]> = [
      ["setup_domain_for_email", { domain: "attacker.example.com", provider_id: "provider-1", add_mx: true }],
      ["setup_cloudflare_dns", { domain: "attacker.example.com", provider_id: "provider-1", register_domain: true }],
      ["setup_ses_inbound", { domain: "attacker.example.com", bucket: "attacker-inbound" }],
    ];

    for (const [name, args] of cases) {
      const result = await callTool(name, args);
      expect(result.isError).toBe(true);
      const text = resultText(result);
      // This is the assertion that discriminates: with the guard removed these
      // tools instead fail later, at provider resolution or at the first AWS
      // call, so the refusal text cannot appear by accident.
      expect(text).toContain(`MCP tool ${name} is disabled in self_hosted mode`);
      expect(text).toContain("EMAILS_MODE=local");
      // The refusal must not repeat the false claim that a server route exists.
      expect(text).not.toContain("runs on the self-hosted server");
      // ...nor mention credentials: mcp/contracts.ts classifies by regex over the
      // message and would mislabel a mode refusal as an auth_error whose
      // fix_commands point at provider credentials.
      expect(text.toLowerCase()).not.toContain("credential");
      expect((JSON.parse(text) as { error?: { code?: string } }).error?.code).not.toBe("auth_error");
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
