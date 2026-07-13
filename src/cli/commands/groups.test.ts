// Self-hosted-ONLY: the groups repo routes every read/write to `/v1/groups` and
// `/v1/group-members`, so these tests drive the REAL command against an
// out-of-process /v1 stub (see src/test-support/v1-stub.ts). No local SQLite
// exists anymore, and member counts are computed from the API — not a local island.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { addMember, createGroup } from "../../db/groups.js";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerGroupCommands } from "./groups.js";

let stub: V1Stub;

async function runGroupCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerGroupCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});
afterEach(() => stub.clearEnv());

describe("group list command", () => {
  it("paginates groups and returns batched member counts", async () => {
    createGroup("gamma");
    createGroup("alpha");
    const delta = createGroup("delta");
    const beta = createGroup("beta");
    addMember(beta.id, "a@example.com");
    addMember(beta.id, "b@example.com");
    addMember(delta.id, "c@example.com");

    const result = await runGroupCommand(["group", "list", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ name: string; member_count: number }>;

    expect(data.map((group) => group.name)).toEqual(["beta", "delta"]);
    expect(data.map((group) => group.member_count)).toEqual([2, 1]);
    expect(result.out).toContain("beta");
    expect(result.out).not.toContain("gamma");
  });
});

describe("group members command", () => {
  it("paginates members by email", async () => {
    const group = createGroup("cli-members");
    addMember(group.id, "dave@example.com");
    addMember(group.id, "charlie@example.com");
    addMember(group.id, "alice@example.com", undefined, { hidden: "large vars ".repeat(100) });
    addMember(group.id, "bob@example.com", undefined, { hidden: "shown hidden vars ".repeat(100) });

    const result = await runGroupCommand(["group", "members", "cli-members", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ email: string }>;

    expect(data.map((member) => member.email)).toEqual([
      "bob@example.com",
      "charlie@example.com",
    ]);
    expect(data.every((member) => !("vars" in member))).toBe(true);
    expect(JSON.stringify(data)).not.toContain("shown hidden vars");
    expect(result.out).not.toContain("shown hidden vars");
    expect(result.out).toContain("Members for 'cli-members'");
    expect(result.out).not.toContain("alice@example.com");
  });

  it("shows a paged member view in group details", async () => {
    const group = createGroup("cli-show-members");
    addMember(group.id, "dave@example.com");
    addMember(group.id, "charlie@example.com");
    addMember(group.id, "alice@example.com");
    addMember(group.id, "bob@example.com", undefined, { hidden: "show hidden vars ".repeat(100) });

    const result = await runGroupCommand(["group", "show", "cli-show-members", "--limit", "2", "--offset", "1"]);
    const data = result.data as { member_count: number; members: Array<{ email: string }> };

    expect(data.member_count).toBe(4);
    expect(data.members.map((member) => member.email)).toEqual([
      "bob@example.com",
      "charlie@example.com",
    ]);
    expect(data.members.every((member) => !("vars" in member))).toBe(true);
    expect(JSON.stringify(data)).not.toContain("show hidden vars");
    expect(result.out).not.toContain("show hidden vars");
    expect(result.out).toContain("2 shown / 4 total");
  });
});
