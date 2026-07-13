// Self-hosted-ONLY: the groups repo routes every read/write to the /v1 API.
// This exercises the REAL transport (synchronous curl store) against an
// out-of-process /v1 stub — see src/test-support/v1-stub.ts for why the stub
// must run in a separate process.
//
// Migrated from the deleted local-SQLite pattern. Two former tests covered
// behavior that no longer lives in the client and are dropped here:
//   - "throws on duplicate name": was a SQLite UNIQUE(name) constraint; name
//     uniqueness is now enforced server-side by /v1, not by the client.
//   - "cascades to delete members": was a SQLite FK ON DELETE CASCADE; member
//     cascade is now the server's responsibility.
//   - the listMemberSummaries SQL-projection assertion (no `SELECT *`, no `vars`
//     column) inspected local SQL that no longer exists; the meaningful part
//     (vars omitted from the summary shape) is retained functionally below.

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  createGroup,
  getGroup,
  getGroupByName,
  listGroups,
  deleteGroup,
  addMember,
  removeMember,
  getMember,
  listMembers,
  listMemberSummaries,
  getMemberCount,
  getMemberCounts,
} from "./groups.js";

let stub: V1Stub;

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

describe("createGroup", () => {
  it("creates a group with name only", () => {
    const group = createGroup("newsletter");
    expect(group.id).toHaveLength(36);
    expect(group.name).toBe("newsletter");
    expect(group.description).toBeNull();
    // Round-trips through the /v1 store.
    expect(getGroup(group.id)!.name).toBe("newsletter");
  });

  it("creates a group with description", () => {
    const group = createGroup("vip", "VIP customers");
    expect(group.name).toBe("vip");
    expect(group.description).toBe("VIP customers");
  });
});

describe("getGroup", () => {
  it("retrieves group by id", () => {
    const created = createGroup("test");
    const found = getGroup(created.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("test");
  });

  it("returns null for unknown id", () => {
    expect(getGroup("nonexistent")).toBeNull();
  });
});

describe("getGroupByName", () => {
  it("retrieves group by name", () => {
    createGroup("newsletter");
    const found = getGroupByName("newsletter");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("newsletter");
  });

  it("returns null for unknown name", () => {
    expect(getGroupByName("nonexistent")).toBeNull();
  });
});

describe("listGroups", () => {
  it("returns empty array when no groups", () => {
    expect(listGroups()).toEqual([]);
  });

  it("lists all groups ordered by name", () => {
    createGroup("beta");
    createGroup("alpha");
    const groups = listGroups();
    expect(groups.length).toBe(2);
    expect(groups[0]!.name).toBe("alpha");
    expect(groups[1]!.name).toBe("beta");
  });

  it("paginates groups after sorting by name", () => {
    createGroup("gamma");
    createGroup("alpha");
    createGroup("delta");
    createGroup("beta");

    const groups = listGroups({ limit: 2, offset: 1 });

    expect(groups.map((group) => group.name)).toEqual(["beta", "delta"]);
  });
});

describe("deleteGroup", () => {
  it("deletes a group", () => {
    const group = createGroup("test");
    const result = deleteGroup(group.id);
    expect(result).toBe(true);
    expect(getGroup(group.id)).toBeNull();
  });

  it("returns false for unknown id", () => {
    expect(deleteGroup("nonexistent")).toBe(false);
  });
});

describe("addMember", () => {
  it("adds a member with email only", () => {
    const group = createGroup("test");
    const member = addMember(group.id, "alice@example.com");
    expect(member.group_id).toBe(group.id);
    expect(member.email).toBe("alice@example.com");
    expect(member.name).toBeNull();
    expect(member.vars).toEqual({});
  });

  it("adds a member with name and vars", () => {
    const group = createGroup("test");
    const member = addMember(group.id, "bob@example.com", "Bob", { company: "Acme" });
    expect(member.name).toBe("Bob");
    expect(member.vars).toEqual({ company: "Acme" });
  });

  it("replaces existing member on duplicate email", () => {
    const group = createGroup("test");
    addMember(group.id, "alice@example.com", "Alice");
    addMember(group.id, "alice@example.com", "Alice Updated");
    const members = listMembers(group.id);
    expect(members.length).toBe(1);
    expect(members[0]!.name).toBe("Alice Updated");
  });
});

describe("removeMember", () => {
  it("removes a member", () => {
    const group = createGroup("test");
    addMember(group.id, "alice@example.com");
    const result = removeMember(group.id, "alice@example.com");
    expect(result).toBe(true);
    expect(listMembers(group.id)).toEqual([]);
  });

  it("returns false for unknown member", () => {
    const group = createGroup("test");
    expect(removeMember(group.id, "unknown@example.com")).toBe(false);
  });
});

describe("listMembers", () => {
  it("returns empty array when no members", () => {
    const group = createGroup("test");
    expect(listMembers(group.id)).toEqual([]);
  });

  it("tolerates malformed member vars JSON stored on /v1", async () => {
    const group = createGroup("malformed");
    // A group-member row whose `vars` is not valid JSON must map to {} (cobj).
    await stub.seed({
      "group-members": [
        { id: "gm-bad", group_id: group.id, email: "alice@example.com", name: "Alice", vars: "not-json", added_at: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const members = listMembers(group.id);
    expect(members[0]?.vars).toEqual({});
  });

  it("lists all members ordered by email", () => {
    const group = createGroup("test");
    addMember(group.id, "charlie@example.com");
    addMember(group.id, "alice@example.com");
    addMember(group.id, "bob@example.com");
    const members = listMembers(group.id);
    expect(members.length).toBe(3);
    expect(members[0]!.email).toBe("alice@example.com");
    expect(members[1]!.email).toBe("bob@example.com");
    expect(members[2]!.email).toBe("charlie@example.com");
  });

  it("paginates members after sorting by email", () => {
    const group = createGroup("test");
    addMember(group.id, "dave@example.com");
    addMember(group.id, "charlie@example.com");
    addMember(group.id, "alice@example.com");
    addMember(group.id, "bob@example.com");

    const members = listMembers(group.id, { limit: 2, offset: 1 });

    expect(members.map((member) => member.email)).toEqual([
      "bob@example.com",
      "charlie@example.com",
    ]);
  });
});

describe("listMemberSummaries", () => {
  it("omits member vars from the summary shape", () => {
    const group = createGroup("summary-test");
    addMember(group.id, "alice@example.com", "Alice", { notes: "large vars ".repeat(200) });

    const [summary] = listMemberSummaries(group.id);

    expect(summary).toMatchObject({ group_id: group.id, email: "alice@example.com", name: "Alice" });
    expect("vars" in summary!).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("large vars");
  });

  it("paginates summaries after sorting by email", () => {
    const group = createGroup("summary-page");
    addMember(group.id, "dave@example.com");
    addMember(group.id, "charlie@example.com");
    addMember(group.id, "alice@example.com");
    addMember(group.id, "bob@example.com");

    const summaries = listMemberSummaries(group.id, { limit: 2, offset: 1 });

    expect(summaries.map((member) => member.email)).toEqual([
      "bob@example.com",
      "charlie@example.com",
    ]);
  });
});

describe("getMember", () => {
  it("returns a full member including vars", () => {
    const group = createGroup("detail-test");
    addMember(group.id, "alice@example.com", "Alice", { company: "Acme" });

    const member = getMember(group.id, "alice@example.com");

    expect(member).toMatchObject({
      group_id: group.id,
      email: "alice@example.com",
      vars: { company: "Acme" },
    });
    expect(getMember(group.id, "missing@example.com")).toBeNull();
  });
});

describe("getMemberCount", () => {
  it("returns 0 for empty group", () => {
    const group = createGroup("test");
    expect(getMemberCount(group.id)).toBe(0);
  });

  it("returns correct count", () => {
    const group = createGroup("test");
    addMember(group.id, "a@example.com");
    addMember(group.id, "b@example.com");
    addMember(group.id, "c@example.com");
    expect(getMemberCount(group.id)).toBe(3);
  });

  it("returns batched member counts for selected groups", () => {
    const first = createGroup("first");
    const second = createGroup("second");
    const empty = createGroup("empty");
    addMember(first.id, "a@example.com");
    addMember(first.id, "b@example.com");
    addMember(second.id, "c@example.com");

    const counts = getMemberCounts([first.id, second.id, empty.id]);

    expect(counts.get(first.id)).toBe(2);
    expect(counts.get(second.id)).toBe(1);
    expect(counts.get(empty.id)).toBe(0);
  });
});
