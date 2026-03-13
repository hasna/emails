import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "./database.js";
import {
  createGroup,
  getGroup,
  getGroupByName,
  listGroups,
  deleteGroup,
  addMember,
  removeMember,
  listMembers,
  getMemberCount,
} from "./groups.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("createGroup", () => {
  it("creates a group with name only", () => {
    const group = createGroup("newsletter");
    expect(group.id).toHaveLength(36);
    expect(group.name).toBe("newsletter");
    expect(group.description).toBeNull();
  });

  it("creates a group with description", () => {
    const group = createGroup("vip", "VIP customers");
    expect(group.name).toBe("vip");
    expect(group.description).toBe("VIP customers");
  });

  it("throws on duplicate name", () => {
    createGroup("test");
    expect(() => createGroup("test")).toThrow();
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

  it("cascades to delete members", () => {
    const group = createGroup("test");
    addMember(group.id, "alice@example.com");
    deleteGroup(group.id);
    // Members should be gone
    expect(listMembers(group.id)).toEqual([]);
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
});
