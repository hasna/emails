import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { buildServer } from "./server.js";

// Self-hosted-ONLY: no local SQLite. `prepare_inbox` genuinely has no route in this
// client and is refused; `list_replies` claimed the same and was WRONG (see below);
// get_next_action routes through runtime status. All of it runs against the /v1 stub.

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

describe("MCP self_hosted local-state guards", () => {
  it("refuses prepare_inbox, which really has no route in this client", async () => {
    // Unlike list_replies below, this one is honest: there is no `/v1` provisioning
    // route and `emails address provision` is `serverOnly(...)`.
    const result = await callTool("prepare_inbox", { email: "ops@example.com", create_missing: true, provider_id: "provider-1" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("not available in the self-hosted client");
  });

  it("no longer refuses list_replies — it serves replies from /v1/messages", async () => {
    // This tool used to refuse UNCONDITIONALLY, in every mode, saying "inbound reply
    // tracking runs on the self-hosted server". It does not: src/db/inbound.ts routes
    // listReplySummaries to inbound.remote.ts over `/v1/messages`, and the CLI twin
    // `emails replies <id>` has always worked here. Seeded straight onto the stub so
    // the rows can only have come off the wire.
    await stub.seed({
      messages: [
        { id: "sent-email-1", direction: "outbound", message_id: "<root@example.com>", from_addr: "ops@example.com", to_addrs: ["ada@example.com"], subject: "Question", body_text: "?", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:00.000Z" },
        { id: "reply-1", direction: "inbound", message_id: "<reply@example.com>", in_reply_to: "<root@example.com>", from_addr: "ada@example.com", to_addrs: ["ops@example.com"], subject: "Re: Question", body_text: "answer", created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z", received_at: "2026-01-02T00:00:00.000Z" },
      ],
    });

    const result = await callTool("list_replies", { email_id: "sent-email-1" });

    expect(resultText(result)).not.toContain("not available in the self-hosted client");
    expect(result.isError, resultText(result)).not.toBe(true);
    const payload = JSON.parse(resultText(result)) as { replies: Array<{ id: string; subject: string }>; total: number };
    expect(payload.replies.map((r) => r.id)).toEqual(["reply-1"]);
    expect(payload.replies[0]?.subject).toBe("Re: Question");
    expect(payload.total).toBe(1);
  });

  it("routes next-action through runtime status (points at the wait-code flow)", async () => {
    const result = await callTool("get_next_action", { goal: "wait for a verification code" });
    expect(result.isError).not.toBe(true);
    expect(resultText(result)).toContain("wait-code");
  });
});
