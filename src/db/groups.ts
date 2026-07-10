import type { Database } from "./database.js";
import { getDatabase, uuid, now } from "./database.js";
import { parseJsonObject } from "./json.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { selfHostedResource, selfHostedListQuery, selfHostedPage, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const GROUP_RESOURCE = "groups";

function apiToGroup(e: Record<string, unknown>): Group {
  const updatedAt = ciso(e["updated_at"]);
  return {
    id: cstr(e["id"]),
    name: cstr(e["name"]),
    description: cstrOrNull(e["description"]),
    created_at: ciso(e["created_at"], updatedAt),
    updated_at: updatedAt,
  };
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroupMember {
  group_id: string;
  email: string;
  name: string | null;
  vars: Record<string, string>;
  added_at: string;
}

export type GroupMemberSummary = Omit<GroupMember, "vars">;

export interface ListGroupOptions {
  limit?: number;
  offset?: number;
}

export interface ListMemberOptions {
  limit?: number;
  offset?: number;
}

interface GroupMemberRow {
  group_id: string;
  email: string;
  name: string | null;
  vars: string;
  added_at: string;
}

type GroupMemberSummaryRow = Omit<GroupMemberRow, "vars">;

const GROUP_COLUMNS = [
  "id",
  "name",
  "description",
  "created_at",
  "updated_at",
].join(", ");

const GROUP_MEMBER_COLUMNS = [
  "group_id",
  "email",
  "name",
  "vars",
  "added_at",
].join(", ");

const GROUP_MEMBER_SUMMARY_COLUMNS = [
  "group_id",
  "email",
  "name",
  "added_at",
].join(", ");

function rowToMember(row: GroupMemberRow): GroupMember {
  return {
    ...row,
    vars: parseJsonObject<Record<string, string>>(row.vars),
  };
}

function rowToMemberSummary(row: GroupMemberSummaryRow): GroupMemberSummary {
  return row;
}

export function createGroup(name: string, description?: string, db?: Database): Group {
  // Self-hosted mode: route the write to the /v1/groups API so a flipped client no
  // longer creates groups in the local SQLite island while `group list` reads
  // the selfHosted (the split-brain bug). Reads already route via listGroups().
  const selfHosted = selfHostedResource(GROUP_RESOURCE);
  if (selfHosted) {
    return apiToGroup(selfHosted.create({ name, description: description || null }));
  }

  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO groups (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [id, name, description || null, timestamp, timestamp],
  );

  return getGroup(id, d)!;
}

export function getGroup(id: string, db?: Database): Group | null {
  const selfHosted = selfHostedResource(GROUP_RESOURCE);
  if (selfHosted) {
    const record = selfHosted.get(id);
    return record ? apiToGroup(record) : null;
  }
  const d = db || getDatabase();
  const row = d.query(`SELECT ${GROUP_COLUMNS} FROM groups WHERE id = ?`).get(id) as Group | null;
  return row;
}

export function getGroupByName(name: string, db?: Database): Group | null {
  const selfHosted = selfHostedResource(GROUP_RESOURCE);
  if (selfHosted) {
    return selfHosted.list({ limit: 1000 }).map(apiToGroup).find((group) => group.name === name) ?? null;
  }
  const d = db || getDatabase();
  const row = d.query(`SELECT ${GROUP_COLUMNS} FROM groups WHERE name = ?`).get(name) as Group | null;
  return row;
}

export function listGroups(db?: Database, opts?: ListGroupOptions): Group[] {
  const selfHosted = selfHostedResource(GROUP_RESOURCE);
  if (selfHosted) {
    const { query, limit, offset } = selfHostedListQuery(opts);
    const rows = selfHosted.list(query).map(apiToGroup);
    rows.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    return selfHostedPage(rows, limit, offset);
  }

  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  return limit !== null
    ? d.query(`SELECT ${GROUP_COLUMNS} FROM groups ORDER BY name ASC LIMIT ? OFFSET ?`).all(limit, offset) as Group[]
    : d.query(`SELECT ${GROUP_COLUMNS} FROM groups ORDER BY name ASC`).all() as Group[];
}

export function deleteGroup(id: string, db?: Database): boolean {
  const selfHosted = selfHostedResource(GROUP_RESOURCE);
  if (selfHosted) return selfHosted.del(id);
  const d = db || getDatabase();
  const result = d.run("DELETE FROM groups WHERE id = ?", [id]);
  return result.changes > 0;
}

export function addMember(groupId: string, email: string, name?: string, vars?: Record<string, string>, db?: Database): GroupMember {
  const d = db || getDatabase();
  const timestamp = now();

  d.run(
    `INSERT OR REPLACE INTO group_members (group_id, email, name, vars, added_at) VALUES (?, ?, ?, ?, ?)`,
    [groupId, email, name || null, JSON.stringify(vars || {}), timestamp],
  );

  const row = d.query(`SELECT ${GROUP_MEMBER_COLUMNS} FROM group_members WHERE group_id = ? AND email = ?`).get(groupId, email) as GroupMemberRow;
  return rowToMember(row);
}

export function removeMember(groupId: string, email: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM group_members WHERE group_id = ? AND email = ?", [groupId, email]);
  return result.changes > 0;
}

export function listMembers(groupId: string, db?: Database, opts?: ListMemberOptions): GroupMember[] {
  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = limit !== null
    ? d.query(`SELECT ${GROUP_MEMBER_COLUMNS} FROM group_members WHERE group_id = ? ORDER BY email ASC LIMIT ? OFFSET ?`).all(groupId, limit, offset) as GroupMemberRow[]
    : d.query(`SELECT ${GROUP_MEMBER_COLUMNS} FROM group_members WHERE group_id = ? ORDER BY email ASC`).all(groupId) as GroupMemberRow[];
  return rows.map(rowToMember);
}

export function listMemberSummaries(groupId: string, db?: Database, opts?: ListMemberOptions): GroupMemberSummary[] {
  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = limit !== null
    ? d.query(`SELECT ${GROUP_MEMBER_SUMMARY_COLUMNS} FROM group_members WHERE group_id = ? ORDER BY email ASC LIMIT ? OFFSET ?`).all(groupId, limit, offset) as GroupMemberSummaryRow[]
    : d.query(`SELECT ${GROUP_MEMBER_SUMMARY_COLUMNS} FROM group_members WHERE group_id = ? ORDER BY email ASC`).all(groupId) as GroupMemberSummaryRow[];
  return rows.map(rowToMemberSummary);
}

export function getMember(groupId: string, email: string, db?: Database): GroupMember | null {
  const d = db || getDatabase();
  const row = d
    .query(`SELECT ${GROUP_MEMBER_COLUMNS} FROM group_members WHERE group_id = ? AND email = ?`)
    .get(groupId, email) as GroupMemberRow | null;
  return row ? rowToMember(row) : null;
}

export function getMemberCount(groupId: string, db?: Database): number {
  const d = db || getDatabase();
  const row = d.query("SELECT COUNT(*) as count FROM group_members WHERE group_id = ?").get(groupId) as { count: number };
  return row.count;
}

export function getMemberCounts(groupIds: string[], db?: Database): Map<string, number> {
  if (groupIds.length === 0) return new Map();
  const d = db || getDatabase();
  const counts = new Map(groupIds.map((id) => [id, 0]));
  const placeholders = groupIds.map(() => "?").join(", ");
  const rows = d
    .query(`SELECT group_id, COUNT(*) as count FROM group_members WHERE group_id IN (${placeholders}) GROUP BY group_id`)
    .all(...groupIds) as Array<{ group_id: string; count: number }>;
  for (const row of rows) {
    counts.set(row.group_id, row.count);
  }
  return counts;
}
