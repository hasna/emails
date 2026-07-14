import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { buildServer } from "./server.js";

// Self-hosted-ONLY: no local SQLite. list_groups routes straight through /v1 (no
// local member-count subledger), while alias/warming/group-member/sequence
// subledger tools stay disabled behind the "self_hosted API-only mode" guard.

const SEEDED_GROUP = {
  id: "group-api-1",
  name: "api-group",
  description: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

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
  stub = await startV1Stub({ seed: { groups: [{ ...SEEDED_GROUP }] } });
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

describe("MCP self_hosted local ledger guards", () => {
  it("lists groups through the self_hosted API without computing local member counts", async () => {
    const result = await callTool("list_groups", {});

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(resultText(result)) as { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const groups = Array.isArray(payload) ? payload : payload.items ?? [];
    expect(groups).toEqual([{ ...SEEDED_GROUP }]);
    expect(groups[0]).not.toHaveProperty("member_count");
  });

  it("fails local alias, warming, group-member, and sequence subledger tools with the API-only guard", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["list_aliases", {}],
      ["create_warming_schedule", { domain: "warm.example.com", target_daily_volume: 100 }],
      ["list_group_members", { group_name: "api-group" }],
      ["add_group_member", { group_name: "api-group", email: "user@example.com" }],
      ["add_sequence_step", { sequence_id: "seq-api-1", step_number: 1, delay_hours: 0, template_name: "welcome" }],
      ["enroll_contact", { sequence_id: "seq-api-1", contact_email: "user@example.com" }],
      ["list_enrollments", {}],
    ];

    for (const [name, args] of cases) {
      const result = await callTool(name, args);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("self_hosted API-only mode");
    }
  });
});
