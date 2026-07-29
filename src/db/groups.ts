// Recipient groups — the groups and their membership rows — as ONE implementation
// over the store seam. Nothing here asks where this installation is deployed; the
// store is resolved from STORAGE configuration (src/store-resolution.ts) or handed in
// by the caller.
//
// WHAT THIS FILE USED TO BE. A facade that read the process-wide deployment word and
// handed TWELVE exports to one of two sibling modules: a 224-line SQLite arm and a
// 145-line arm speaking to `/v1` through the legacy blocking bridge. Both are gone.
// The group rows are read and written through the seam's own `groups` repository; the
// membership join table goes through the SAME generic resource path on both stores via
// the membership extension (src/store-group-membership.ts), because `EmailStore` does
// not declare it yet and `src/store/` is byte-identical in this change. The described-
// and-not-made seam widening lives in that module's header.
//
// THE DELETED SQLITE ARM WAS ALREADY HALF AN HTTP ARM. Its five group-table operations
// each began by asking the legacy resource bridge whether to route to `/v1` after all —
// while its seven membership operations never asked. So one configuration could create
// a group through an API and then add members to a LOCAL SQLite island holding no such
// group: the provenance split this programme exists to remove, measured here rather
// than assumed.
//
// ─── WHAT THE TWO ARMS DID DIFFERENTLY, MEASURED RATHER THAN ASSUMED ─────────────────
//
//  1. EVERY MEMBERSHIP READ IN THE DELETED SECOND ARM ANSWERED OUT OF ONE CLAMPED
//     PAGE. It asked for `{ limit: 1000 }` once and filtered locally; the service
//     clamps a list to 500 rows. So with 501+ membership rows across an installation's
//     groups, `listMembers` silently dropped members — and `--to-group` builds its
//     To: header from that list, so a campaign mailed at most the clamp while
//     reporting the whole group. `getMember` and `removeMember` answered "not a
//     member" for a real member past the clamp; `addMember`'s existing-row check
//     missed one, re-sent a create, and got back whatever the service does with a
//     duplicate natural key; `getMemberCount` and `getMemberCounts` undercounted; and
//     `getGroupByName` answered null for a real group past the clamp, which every
//     command and MCP tool resolves names through. Every read below enumerates the
//     WHOLE filtered set (pushing down the filters both stores accept, re-checked
//     client-side) and REFUSES if it could not finish — a truncated group presented
//     as the whole one is the defect this collapse exists to remove.
//  2. THE TWO STORES ORDER BOTH TABLES DIFFERENTLY, AND `ListOptions` ADMITS NO
//     ORDERING. The SQLite store's generic list orders by the table's time column
//     (`updated_at DESC` for groups) or bare rowid (members); the service orders
//     `groups` by `name ASC` and `group-members` by `added_at ASC, email ASC`
//     (src/server/self-hosted/resources.ts). So a windowed read taken from either
//     store's own order is a plausible, silently wrong page against the other. Every
//     list here sorts the enumerated set itself and windows locally, so both stores
//     answer the same question.
//  3. NEITHER ARM'S ORDER WAS TOTAL IN THE SAME WAY. The deleted second arm sorted
//     with `localeCompare`, so the order it presented moved with the machine's locale;
//     the SQLite arm's `ORDER BY name ASC` compared code units. Comparators below use
//     UTF-16 code-unit order with tiebreakers down to the row's identity, which makes
//     every window the same window on every machine against both stores.
//  4. A MEMBERSHIP ROW'S IDENTITY ARRIVES UNDER TWO NAMES. The local table's natural
//     key is composite (group_id, email), so the generic SQLite path addresses its
//     rows by `rowid` and projects that; the service could not serve composite-key
//     CRUD and mints a TEXT `id` instead. `memberIdentityOf` reads whichever the row
//     itself carries — a fact about the ROW, never a question about which store
//     answered — and nothing below sends an id on a create.
//  5. WHO WRITES `added_at`, AND IN WHAT FORMAT. Both deleted arms wrote it as an ISO
//     instant; the local column's DEFAULT writes a different text format whose
//     interleaving would not sort against ISO rows. It is sent explicitly below, on
//     create and on the re-add refresh both arms performed.
//  6. ABSENT IS NOT `now()`. The old mappers read timestamps through a coercion that
//     answers the current instant for a missing value, dating a row to the moment it
//     was read. Both stores declare these columns NOT NULL, so absence is a projection
//     fault and is reported as one, naming the row. Member `vars`, by contrast, keeps
//     its deliberate tolerance: both arms mapped a malformed JSON payload to `{}`, a
//     suite pins that, and faulting a whole member listing over one row's template
//     variables would lose the members the read was for.
//  7. WHAT BOTH ARMS AGREED ON, PRESERVED: `createGroup` stores an empty description
//     as null; `getGroupByName` is an exact-name match (among several groups sharing a
//     name — reachable through an API store; the local schema forbids it — the NEWEST
//     wins, deterministically); re-adding a member refreshes its name, vars and
//     added_at; `removeMember` and `deleteGroup` answer false for a row that is not
//     there; a group with no members lists as empty and counts as zero.
//
// ─── WHAT IS LOST, NAMED RATHER THAN LEFT TO BE DISCOVERED ───────────────────────────
//
//  * THE ATOMIC UPSERT. `addMember` was one INSERT OR REPLACE; it is now a
//    find-then-write, so two racing adds for the same (group, email) can both miss the
//    existing row — on a local store the schema's natural key refuses the second
//    create (a typed refusal, surfaced as a throw), where the old arm silently kept
//    the last write. The second arm already had exactly this exposure; closing it
//    needs a conditional write on the seam, which is described here and not added.
//  * CLIENT-SIDE CASCADE VISIBILITY. `deleteGroup` on a local store still cascades to
//    membership rows through the schema's own foreign key; through an API the service
//    decides, as it always has for the second arm.
//  * AGGREGATION. There is no count on the seam to push `getMemberCount` /
//    `getMemberCounts` to, so both enumerate and REFUSE when they could not reach the
//    end of the table — an exact answer or a named refusal, never a lower bound
//    presented as a total (the deleted arm counted one clamped page).
//  * SYNCHRONOUS CALLS. Every operation on the seam is async, so all twelve exports
//    are now async and every consumer awaits them.
//
// WHAT IS SLOWER: a read that is not addressed by id walks its whole filtered family —
// one in-process query per page locally, one HTTP request per page against an API, at
// up to 500 rows a page. Bounded rather than open-ended: past the page budget these
// reads THROW instead of degrading, because the alternative is a truncated recipient
// list published as the whole one.

import type { Database } from "./database.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { now } from "./runtime.js";
// Value coercion only. These are pure functions that turn one store's JSON-typed
// column into the other's TEXT-encoded one; the module they live in is named for the
// axis being deleted, and relocating them belongs to that deletion rather than to this
// collapse.
import { cobj, cstr, cstrOrNull } from "./self-hosted-resource.js";
import { enumerateStoreRows, type StoreEnumeration } from "../lib/status-facts-enumeration.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import { groupMembershipOf, type GroupMembership } from "../store-group-membership.js";
import type { EmailStore } from "../store/email-store.js";
import type { ListOptions, ResourceRow } from "../store/records.js";
import type { Outcome } from "../store/outcome.js";
import type { ResourceRepository } from "../store/repositories.js";

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

/**
 * What every export accepts as its optional store argument.
 *
 * A UNION RATHER THAN A REPLACEMENT, because `Database` has been the published shape
 * of this parameter for the package's whole 1.x life — these exports are on the public
 * entrypoint (src/index.ts), and narrowing a 1.x surface is a breaking change. See
 * `storeFor` for what each arm means.
 */
export type GroupStore = EmailStore | Database;

/**
 * Pages one enumeration may fetch, at up to 500 rows a page — about 100,000 rows.
 *
 * Far above the shared 40-page default because membership is the one family here that
 * an operator grows in bulk (`emails group add <name> <email...>` walks a whole
 * recipient list), and a group past the budget must be a refusal naming the bound,
 * never a shorter answer. Group rows share it for uniformity; they are small in
 * practice.
 */
const MAX_GROUP_PAGES = 200;

// ─── The store handle ───────────────────────────────────────────────────────

/**
 * THE INJECTABLE ACCEPTS BOTH SHAPES, and that is a published-surface obligation
 * rather than a convenience: every export here has always taken an optional
 * `Database` meaning "scope this to the database I own". A `Database` becomes a
 * SQLite store BOUND TO THAT HANDLE — which is stronger than what the deleted facade
 * did with it (the handle's PRESENCE picked an arm) — and an `EmailStore` is used as
 * handed in.
 *
 * THE DISCRIMINATION IS STRUCTURAL, not a label: `EmailStore` exposes repositories
 * and a `bun:sqlite` `Database` exposes `query`. `descriptor` is deliberately NOT
 * read — branching on it is forbidden (src/store/descriptor.ts), and this asks which
 * of two ARGUMENT shapes was passed, never which store answered. Anything that is
 * neither is a fault naming both, because silently treating it as absent would
 * resolve the configured store and read the wrong installation's groups.
 *
 * Built per call rather than at module load, because a contradictory storage
 * configuration is a boot error raised by the resolution and it belongs to the call
 * that needed a store, not to whoever imported this module first.
 */
function storeFor(handle: GroupStore | undefined): EmailStore {
  if (handle === undefined) return createConfiguredEmailStore();
  const candidate = handle as Partial<EmailStore> & Partial<Database>;
  if (typeof candidate.messages === "object" && candidate.messages !== null) return handle as EmailStore;
  if (typeof candidate.query === "function") {
    return createSqliteEmailStore({ database: handle as Database, detail: "caller-supplied database" });
  }
  throw new Error(
    "The groups family's optional store argument must be an EmailStore or a bun:sqlite Database; "
      + `received ${handle === null ? "null" : typeof handle}. Passing neither would silently read the `
      + "store this installation is configured with, which is not the one the caller named.",
  );
}

/**
 * True when the caller's argument is a store rather than options.
 *
 * Needed because the published surface admits TWO parameter orders for the three
 * listing exports: the deleted SQLite arm took its optional handle BEFORE the
 * options, the deleted facade's compat shim exposed options-first, and the facade's
 * intersection type made both compile for the package's whole 1.x life. Narrowing to
 * one order would break released consumers, so both stay and the argument's SHAPE
 * decides — the same structural question `storeFor` asks, never a label.
 */
function isStoreArgument(value: unknown): value is GroupStore {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<EmailStore> & Partial<Database>;
  return typeof candidate.query === "function"
    || (typeof candidate.messages === "object" && candidate.messages !== null);
}

/** Split one of the dual-order listing argument pairs into (opts, store). */
function listingArguments<TOptions>(
  first: TOptions | GroupStore | undefined,
  second: GroupStore | TOptions | undefined,
): { opts: TOptions | undefined; store: GroupStore | undefined } {
  if (isStoreArgument(first)) return { opts: second as TOptions | undefined, store: first };
  return { opts: first, store: second as GroupStore | undefined };
}

/**
 * The membership ledger, or a refusal naming what is missing.
 *
 * Both shipped stores carry it (they serve the join table through the same generic
 * resource path as `groups` itself), so this refusal is only reachable with a
 * caller-supplied store that implements the seam and nothing else — and for that
 * caller "this store holds no membership rows" is the true answer, where an empty
 * list would be a fabricated one.
 */
function membershipFor(store: EmailStore, what: string): GroupMembership {
  const membership = groupMembershipOf(store);
  if (membership !== null) return membership;
  throw new Error(
    `This store cannot ${what}: it carries no group membership ledger (no groupMembers `
      + "repository beside its groups repository). Both shipped stores carry it; a "
      + "caller-supplied store must too.",
  );
}

/** Unwrap an `Outcome`, or throw the store's own refusal naming the operation. */
function required<TValue>(what: string, outcome: Outcome<TValue>): TValue {
  if (!outcome.ok) {
    throw new Error(
      `This installation's store cannot ${what} (${outcome.code}, ${outcome.status}): ${outcome.message}`,
    );
  }
  return outcome.value;
}

// ─── The enumerated stream ──────────────────────────────────────────────────

/**
 * A membership row's addressable identity: the service's minted TEXT `id`, or the
 * `rowid` the local generic path projects for the composite-key table (divergence 4).
 * A row carrying neither cannot be addressed for an update or a delete, and updating
 * "some row" instead would rewrite another member.
 */
function memberIdentityOf(row: ResourceRow): string {
  const id = cstrOrNull(row["id"]) ?? cstrOrNull(row["rowid"]);
  if (id === null || id === "") {
    throw new Error(
      `This installation's store returned a membership row for ${cstr(row["email"]) || "(no email)"} `
        + "with no id and no rowid; refusing to address it for a write",
    );
  }
  return id;
}

/** Identity for duplicate/shift accounting during enumeration; null when untrackable. */
function enumerationIdOf(row: ResourceRow): string | null {
  const value = row["id"] ?? row["rowid"];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

/**
 * Every row the filter admits, or a throw naming why not.
 *
 * WHY A THROW: `rows` coming back short has three unrelated causes — the store
 * refused, the read faulted, or the enumeration ran out of budget — and none of them
 * is "the group is that small". These functions return arrays and scalars rather than
 * outcomes, so raising is the only way to keep the three apart from an honestly empty
 * answer.
 */
async function readAll(
  family: ResourceRepository<ResourceRow>,
  filters: Record<string, string> | undefined,
  what: string,
): Promise<ResourceRow[]> {
  const enumeration: StoreEnumeration<ResourceRow> = await enumerateStoreRows<ResourceRow>(
    (opts: ListOptions) => family.list({ ...opts, ...(filters ? { filters } : {}) }),
    { idOf: enumerationIdOf, pageBudget: MAX_GROUP_PAGES },
  );
  if (enumeration.refusal !== null) {
    throw new Error(
      `Refusing to ${what}: the configured store refused the read `
        + `(${enumeration.refusal.code}): ${enumeration.refusal.message}`,
    );
  }
  if (enumeration.fault !== null) {
    throw new Error(`Refusing to ${what}: the read faulted: ${enumeration.fault}`);
  }
  if (!enumeration.complete) {
    const cause = enumeration.exhausted
      ? `the ${enumeration.pages}-page enumeration budget ran out before the end of the table`
      : enumeration.duplicates > 0
        ? `${enumeration.duplicates} row(s) came back twice across ${enumeration.pages} page(s), so at least `
          + "that many rows were never seen"
        : `a page did not begin on the row the previous page ended on across ${enumeration.pages} page(s), `
          + "so rows were skipped";
    throw new Error(
      `Refusing to ${what}: ${cause}, so the ${enumeration.rows.length} row(s) read are a LOWER BOUND `
        + "rather than the whole set — and a window, a count, a recipient list or a membership decision "
        + "taken from a partial read is silently wrong. Narrow the read or retry.",
    );
  }
  return enumeration.rows;
}

/** Code-unit order, not `localeCompare` (divergence 3). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The caller's window, applied AFTER the whole set is sorted. No limit means every row. */
function windowed<T>(rows: T[], opts: { limit?: number; offset?: number } | undefined): T[] {
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  return limit === null ? rows : rows.slice(offset, offset + limit);
}

// ─── Mapping store rows, AFTER filtering and windowing ──────────────────────

/** A timestamp both schemas declare NOT NULL; absence is a projection fault, not "now". */
function requiredTimestamp(row: ResourceRow, key: string, noun: string): string {
  const value = cstrOrNull(row[key]);
  if (value === null || value === "") {
    throw new Error(
      `This installation's store returned ${noun} ${cstr(row["id"]) || cstr(row["email"]) || "(no id)"} `
        + `with no ${key}; refusing to report the current time in its place`,
    );
  }
  return value;
}

function toGroup(row: ResourceRow): Group {
  return {
    id: cstr(row["id"]),
    name: cstr(row["name"]),
    description: cstrOrNull(row["description"]),
    created_at: requiredTimestamp(row, "created_at", "group"),
    updated_at: requiredTimestamp(row, "updated_at", "group"),
  };
}

/**
 * Member `vars` keeps its deliberate tolerance (divergence 6): both deleted arms
 * mapped a malformed payload to `{}` and a suite pins that, because template
 * variables are a payload the member row carries, not the row's own identity.
 */
function toMember(row: ResourceRow): GroupMember {
  return {
    group_id: cstr(row["group_id"]),
    email: cstr(row["email"]),
    name: cstrOrNull(row["name"]),
    vars: cobj(row["vars"] ?? row["vars_json"]) as Record<string, string>,
    added_at: requiredTimestamp(row, "added_at", "group member"),
  };
}

function toMemberSummary(row: ResourceRow): GroupMemberSummary {
  const { vars: _vars, ...summary } = toMember(row);
  return summary;
}

// ─── Raw comparators — total orders over the RAW row (divergences 2 and 3) ──

/** The listing order both arms promised: name, with identity making it total. */
function byNameRaw(a: ResourceRow, b: ResourceRow): number {
  return (
    compareText(cstr(a["name"]), cstr(b["name"]))
    || compareText(cstr(a["id"]), cstr(b["id"]))
  );
}

/** Newest group first — how a duplicated name resolves deterministically. */
function byNewestGroupRaw(a: ResourceRow, b: ResourceRow): number {
  return (
    compareText(cstr(b["created_at"]), cstr(a["created_at"]))
    || compareText(cstr(b["id"]), cstr(a["id"]))
  );
}

/** The member order both arms promised: email, with the row identity making it total. */
function byMemberEmailRaw(a: ResourceRow, b: ResourceRow): number {
  return (
    compareText(cstr(a["email"]), cstr(b["email"]))
    || compareText(cstr(a["id"] ?? a["rowid"]), cstr(b["id"] ?? b["rowid"]))
  );
}

/**
 * Membership rows of one group, raw and sorted. The `group_id` filter is pushed down
 * (the column exists locally and `/v1/group-members` declares the filter) and
 * RE-CHECKED on the raw row: a store or fixture that ignores an equality filter
 * answers with the unfiltered list, and trusting it would splice another group's
 * members into this one's recipient list.
 */
async function readMembersRaw(
  membership: GroupMembership,
  groupId: string,
  what: string,
): Promise<ResourceRow[]> {
  const rows = await readAll(membership.groupMembers, { group_id: groupId }, what);
  return rows.filter((row) => cstr(row["group_id"]) === groupId).sort(byMemberEmailRaw);
}

/**
 * The membership row of one (group, email) pair, raw, or undefined. Both filters push
 * down and both are re-checked; among duplicates (reachable only through a store
 * without the natural-key constraint both shipped stores carry) the FIRST in the
 * total member order wins, deterministically.
 */
async function findMemberRaw(
  membership: GroupMembership,
  groupId: string,
  email: string,
  what: string,
): Promise<ResourceRow | undefined> {
  const rows = await readAll(membership.groupMembers, { group_id: groupId, email }, what);
  return rows
    .filter((row) => cstr(row["group_id"]) === groupId && cstr(row["email"]) === email)
    .sort(byMemberEmailRaw)[0];
}

// ─── GROUPS ─────────────────────────────────────────────────────────────────

export async function createGroup(name: string, description?: string, store?: GroupStore): Promise<Group> {
  const created = required(
    "create a group",
    await storeFor(store).groups.create({ name, description: description || null }),
  );
  return toGroup(created);
}

export async function getGroup(id: string, store?: GroupStore): Promise<Group | null> {
  // An empty id addresses no row — and through an API, a blank path segment is a
  // DIFFERENT route (the list), whose answer must not be presented as a record.
  if (id.trim() === "") return null;
  const record = required("read a group", await storeFor(store).groups.get(id));
  return record === null ? null : toGroup(record);
}

/**
 * One group by exact name, or null. This enumerates: neither store's groups list
 * accepts a name filter, and the deleted second arm's one-page scan answered null for
 * a real group past the clamp (divergence 1). Among several groups sharing a name
 * (reachable through an API store; the local schema forbids it) the NEWEST wins,
 * deterministically (divergence 7).
 */
export async function getGroupByName(name: string, store?: GroupStore): Promise<Group | null> {
  const rows = await readAll(storeFor(store).groups, undefined, `resolve the group name ${name}`);
  const match = rows.filter((row) => cstr(row["name"]) === name).sort(byNewestGroupRaw)[0];
  return match === undefined ? null : toGroup(match);
}

export async function listGroups(opts?: ListGroupOptions, store?: GroupStore): Promise<Group[]>;
export async function listGroups(store: GroupStore, opts?: ListGroupOptions): Promise<Group[]>;
export async function listGroups(
  first?: ListGroupOptions | GroupStore,
  second?: GroupStore | ListGroupOptions,
): Promise<Group[]> {
  const { opts, store } = listingArguments<ListGroupOptions>(first, second);
  const rows = await readAll(storeFor(store).groups, undefined, "list groups");
  return windowed(rows.sort(byNameRaw), opts).map(toGroup);
}

/**
 * Delete a group; false when there was no such row (both arms agreed). On a local
 * store the schema's own foreign key cascades to its membership rows; through an API
 * the service decides, as it always has.
 */
export async function deleteGroup(id: string, store?: GroupStore): Promise<boolean> {
  return required("delete a group", await storeFor(store).groups.remove(id));
}

// ─── MEMBERS ────────────────────────────────────────────────────────────────

/**
 * Add a member, or refresh one already there. Re-adding updates the name, the vars
 * and `added_at`, which is what BOTH arms did (one with an atomic INSERT OR REPLACE,
 * one with a full-body update — divergence 7); the existing-row check enumerates
 * rather than reading one clamped page (divergence 1), because a missed match here
 * re-creates a row the store's natural key then refuses. The write is a
 * find-then-write now; the atomicity note in the module header names what that
 * gives up.
 */
export async function addMember(
  groupId: string,
  email: string,
  name?: string,
  vars?: Record<string, string>,
  store?: GroupStore,
): Promise<GroupMember> {
  const membership = membershipFor(storeFor(store), "add a group member");
  const existing = await findMemberRaw(membership, groupId, email, "check for an existing member");
  // `vars` is sent PRE-SERIALIZED: the column is TEXT on both stores (the service
  // declares it so precisely because the deleted arms wrote JSON text), and the exact
  // string round-trips where a JSON value would be re-encoded into a different one.
  // `added_at` is explicit ISO (divergence 5). No id is sent (divergence 4).
  const body = {
    name: name || null,
    vars: JSON.stringify(vars || {}),
    added_at: now(),
  };
  const saved = existing !== undefined
    ? required("refresh a group member", await membership.groupMembers.update(memberIdentityOf(existing), body))
    : required("add a group member", await membership.groupMembers.create({ group_id: groupId, email, ...body }));
  if (saved === null) {
    // The row vanished between the read and the write; re-adding it is exactly what
    // the caller asked for.
    return toMember(
      required("add a group member", await membership.groupMembers.create({ group_id: groupId, email, ...body })),
    );
  }
  return toMember(saved);
}

/** Remove a member; false when there is no such membership row (both arms agreed). */
export async function removeMember(groupId: string, email: string, store?: GroupStore): Promise<boolean> {
  const membership = membershipFor(storeFor(store), "remove a group member");
  const existing = await findMemberRaw(membership, groupId, email, "find the member to remove");
  if (existing === undefined) return false;
  return required("remove a group member", await membership.groupMembers.remove(memberIdentityOf(existing)));
}

export async function listMembers(
  groupId: string,
  opts?: ListMemberOptions,
  store?: GroupStore,
): Promise<GroupMember[]>;
export async function listMembers(
  groupId: string,
  store: GroupStore,
  opts?: ListMemberOptions,
): Promise<GroupMember[]>;
export async function listMembers(
  groupId: string,
  first?: ListMemberOptions | GroupStore,
  second?: GroupStore | ListMemberOptions,
): Promise<GroupMember[]> {
  const { opts, store } = listingArguments<ListMemberOptions>(first, second);
  const membership = membershipFor(storeFor(store), "list group members");
  const rows = await readMembersRaw(membership, groupId, `list the members of group ${groupId}`);
  return windowed(rows, opts).map(toMember);
}

/**
 * The member list without per-member `vars` — the shape every listing surface prints.
 * The key is ABSENT from the summary, not present-and-empty: a member's template
 * variables can dwarf the member, and serialising them into every listing is how they
 * leak into logs.
 */
export async function listMemberSummaries(
  groupId: string,
  opts?: ListMemberOptions,
  store?: GroupStore,
): Promise<GroupMemberSummary[]>;
export async function listMemberSummaries(
  groupId: string,
  store: GroupStore,
  opts?: ListMemberOptions,
): Promise<GroupMemberSummary[]>;
export async function listMemberSummaries(
  groupId: string,
  first?: ListMemberOptions | GroupStore,
  second?: GroupStore | ListMemberOptions,
): Promise<GroupMemberSummary[]> {
  const { opts, store } = listingArguments<ListMemberOptions>(first, second);
  const membership = membershipFor(storeFor(store), "list group member summaries");
  const rows = await readMembersRaw(membership, groupId, `list the members of group ${groupId}`);
  return windowed(rows, opts).map(toMemberSummary);
}

export async function getMember(
  groupId: string,
  email: string,
  store?: GroupStore,
): Promise<GroupMember | null> {
  const membership = membershipFor(storeFor(store), "read a group member");
  const row = await findMemberRaw(membership, groupId, email, `read the member ${email}`);
  return row === undefined ? null : toMember(row);
}

/**
 * Exactly how many members a group has — exact because the enumeration behind it
 * REFUSES rather than stopping early; there is no aggregate on the seam to push this
 * to (divergence 1: the deleted arm counted one clamped page).
 */
export async function getMemberCount(groupId: string, store?: GroupStore): Promise<number> {
  const membership = membershipFor(storeFor(store), "count group members");
  return (await readMembersRaw(membership, groupId, `count the members of group ${groupId}`)).length;
}

/**
 * Member counts for a batch of groups, zero-filled for a group with no rows. ONE
 * enumeration of the whole membership table rather than one filtered walk per group,
 * because the group list screen asks for up to a hundred groups at a time and a
 * hundred paged walks against an API is a hundred times the latency for the same
 * rows. Same exactness rule: the whole table or a refusal.
 */
export async function getMemberCounts(
  groupIds: string[],
  store?: GroupStore,
): Promise<Map<string, number>> {
  if (groupIds.length === 0) return new Map();
  const membership = membershipFor(storeFor(store), "count group members");
  const wanted = new Set(groupIds);
  const counts = new Map(groupIds.map((id) => [id, 0]));
  for (const row of await readAll(membership.groupMembers, undefined, "count members across groups")) {
    const groupId = cstr(row["group_id"]);
    if (wanted.has(groupId)) counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
  }
  return counts;
}
