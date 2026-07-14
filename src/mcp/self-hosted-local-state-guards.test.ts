import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { buildServer } from "./server.js";

// Self-hosted-ONLY: no local SQLite. Reply/prepare-inbox tools depend on local
// state the self-hosted client does not own, so they are refused; get_next_action
// routes through runtime status. All of it runs against the /v1 stub.

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
  it("refuses reply and prepare-inbox tools that need server-owned local state", async () => {
    for (const [name, args] of [
      ["list_replies", { email_id: "sent-email-1" }],
      ["prepare_inbox", { email: "ops@example.com", create_missing: true, provider_id: "provider-1" }],
    ] as const) {
      const result = await callTool(name, args);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("not available in the self-hosted client");
    }
  });

  it("routes next-action through runtime status (points at the wait-code flow)", async () => {
    const result = await callTool("get_next_action", { goal: "wait for a verification code" });
    expect(result.isError).not.toBe(true);
    expect(resultText(result)).toContain("wait-code");
  });
});
