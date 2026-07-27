import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { buildServer } from "./server.js";

// Self-hosted-ONLY: no local SQLite. list_groups, the warming tools and the
// alias/group-member/sequence tools all route straight through /v1 — none of them
// is a "local subledger", each has a `/v1` resource, a complete client arm and a
// working CLI twin, and none of them carries a mode guard any more.

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

describe("MCP self_hosted repository-backed tools", () => {
  it("lists groups through the self_hosted API without computing local member counts", async () => {
    const result = await callTool("list_groups", {});

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(resultText(result)) as { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const groups = Array.isArray(payload) ? payload : payload.items ?? [];
    expect(groups).toEqual([{ ...SEEDED_GROUP }]);
    expect(groups[0]).not.toHaveProperty("member_count");
  });

  it("runs the warming tools through the self_hosted API instead of refusing", async () => {
    // warming.remote.ts is a complete /v1 client, so these tools are NOT local
    // subledger tools and carry no mode guard — they are the MCP twins of
    // `emails domain warm*`.
    const created = await callTool("create_warming_schedule", { domain: "warm.example.com", target_daily_volume: 100 });
    expect(created.isError).not.toBe(true);
    expect(JSON.parse(resultText(created)) as { schedule: { domain: string; status: string } }).toMatchObject({
      schedule: { domain: "warm.example.com", status: "active" },
    });

    const listed = await callTool("list_warming_schedules", {});
    expect(listed.isError).not.toBe(true);
    const payload = JSON.parse(resultText(listed)) as {
      schedules: Array<{ domain: string }>;
      cli_equivalent: string;
    };
    expect(payload.schedules.map((row) => row.domain)).toEqual(["warm.example.com"]);
    // The advertised CLI equivalent must be a command that can actually succeed.
    expect(payload.cli_equivalent).toBe("emails domain warm-list --json");

    const updated = await callTool("update_warming_status", { domain: "warm.example.com", status: "paused" });
    expect(updated.isError).not.toBe(true);
    expect((await stub.list("warming"))[0]?.["status"]).toBe("paused");

    const status = await callTool("get_warming_status", { domain: "warm.example.com" });
    expect(status.isError).not.toBe(true);
    expect(JSON.parse(resultText(status)) as { today_limit: number | null }).toMatchObject({ today_limit: null });
  });

  it("refuses a duplicate warming schedule, like the CLI twin", async () => {
    // /v1 accepts a second POST for the same domain; without the pre-check the
    // tool would leave two schedules and reads would pick one arbitrarily.
    await callTool("create_warming_schedule", { domain: "dup.example.com", target_daily_volume: 100 });
    const duplicate = await callTool("create_warming_schedule", { domain: "dup.example.com", target_daily_volume: 999 });

    expect(duplicate.isError).toBe(true);
    expect(resultText(duplicate)).toContain("already has a warming schedule");
    const rows = await stub.list("warming");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["target_daily_volume"]).toBe(100);
  });

  it("runs the alias, group-member, and sequence tools through /v1 instead of refusing", async () => {
    // These were called "local subledger" tools and refused. They are not: aliases,
    // group members, sequence steps and sequence enrollments are each a `/v1`
    // resource with a complete client arm in src/db/*.remote.ts and a working CLI
    // twin. The guard was the only thing refusing, and it is gone.
    // src/mcp/self-hosted-unguarded-tools.test.ts asserts the resulting server rows;
    // here the point is only that no mode check turns them away.
    const cases: Array<[string, Record<string, unknown>]> = [
      ["list_aliases", {}],
      ["list_group_members", { group_name: "api-group" }],
      ["add_group_member", { group_name: "api-group", email: "user@example.com" }],
      ["list_enrollments", {}],
    ];

    for (const [name, args] of cases) {
      const result = await callTool(name, args);
      expect(result.isError, `${name}: ${resultText(result)}`).not.toBe(true);
    }
    expect((await stub.list("group-members")).map((row) => row["email"])).toEqual(["user@example.com"]);
  });
});
