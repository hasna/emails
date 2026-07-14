import { now, uuid } from "./runtime.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { selfHostedResource, selfHostedListQuery, selfHostedPage, cobj, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const GROUP_RESOURCE = "groups";
const GROUP_MEMBER_RESOURCE = "group-members";

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

function apiToMember(e: Record<string, unknown>): GroupMember {
  return {
    group_id: cstr(e["group_id"]),
    email: cstr(e["email"]),
    name: cstrOrNull(e["name"]),
    vars: cobj(e["vars"] ?? e["vars_json"]) as Record<string, string>,
    added_at: ciso(e["added_at"]),
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

export function createGroup(name: string, description?: string): Group {
  return apiToGroup(selfHostedResource(GROUP_RESOURCE).create({ name, description: description || null }));
}

export function getGroup(id: string): Group | null {
  const record = selfHostedResource(GROUP_RESOURCE).get(id);
  return record ? apiToGroup(record) : null;
}

export function getGroupByName(name: string): Group | null {
  return selfHostedResource(GROUP_RESOURCE).list({ limit: 1000 }).map(apiToGroup).find((group) => group.name === name) ?? null;
}

export function listGroups(opts?: ListGroupOptions): Group[] {
  const { query, limit, offset } = selfHostedListQuery(opts);
  const rows = selfHostedResource(GROUP_RESOURCE).list(query).map(apiToGroup);
  rows.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return selfHostedPage(rows, limit, offset);
}

export function deleteGroup(id: string): boolean {
  return selfHostedResource(GROUP_RESOURCE).del(id);
}

function findMemberRow(store: ReturnType<typeof selfHostedResource>, groupId: string, email: string): Record<string, unknown> | undefined {
  return store.list({ limit: 1000 }).find((r) => cstr(r["group_id"]) === groupId && cstr(r["email"]) === email);
}

export function addMember(groupId: string, email: string, name?: string, vars?: Record<string, string>): GroupMember {
  const store = selfHostedResource(GROUP_MEMBER_RESOURCE);
  const body = {
    group_id: groupId,
    email,
    name: name || null,
    vars: JSON.stringify(vars || {}),
    added_at: now(),
  };
  const existing = findMemberRow(store, groupId, email);
  const saved = existing ? store.update(cstr(existing["id"]), body) : store.create({ id: uuid(), ...body });
  return apiToMember(saved);
}

export function removeMember(groupId: string, email: string): boolean {
  const store = selfHostedResource(GROUP_MEMBER_RESOURCE);
  const existing = findMemberRow(store, groupId, email);
  if (!existing) return false;
  return store.del(cstr(existing["id"]));
}

function listMemberRows(groupId: string, opts?: ListMemberOptions): GroupMember[] {
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = selfHostedResource(GROUP_MEMBER_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToMember)
    .filter((m) => m.group_id === groupId)
    .sort((a, b) => a.email.localeCompare(b.email));
  return limit === null ? rows : rows.slice(offset, offset + limit);
}

export function listMembers(groupId: string, opts?: ListMemberOptions): GroupMember[] {
  return listMemberRows(groupId, opts);
}

export function listMemberSummaries(groupId: string, opts?: ListMemberOptions): GroupMemberSummary[] {
  return listMemberRows(groupId, opts).map(({ vars: _vars, ...summary }) => summary);
}

export function getMember(groupId: string, email: string): GroupMember | null {
  const row = findMemberRow(selfHostedResource(GROUP_MEMBER_RESOURCE), groupId, email);
  return row ? apiToMember(row) : null;
}

export function getMemberCount(groupId: string): number {
  return selfHostedResource(GROUP_MEMBER_RESOURCE)
    .list({ limit: 1000 })
    .filter((r) => cstr(r["group_id"]) === groupId).length;
}

export function getMemberCounts(groupIds: string[]): Map<string, number> {
  if (groupIds.length === 0) return new Map();
  const wanted = new Set(groupIds);
  const counts = new Map(groupIds.map((id) => [id, 0]));
  for (const r of selfHostedResource(GROUP_MEMBER_RESOURCE).list({ limit: 1000 })) {
    const groupId = cstr(r["group_id"]);
    if (wanted.has(groupId)) counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
  }
  return counts;
}
