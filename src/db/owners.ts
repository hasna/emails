// Address owners — the owner registry, the ownership columns on the address, and the
// append-only ownership audit trail — as ONE implementation over the store seam.
// Nothing here asks where this installation is deployed; the store is resolved from
// STORAGE configuration (src/store-resolution.ts) or handed in by the caller.
//
// Ownership rule, unchanged: an address is owned by a human OR an agent. A
// human-owned address must be ADMINISTERED by an agent (owner=human,
// administrator=agent); an agent-owned address is self-administered.
//
// WHAT THIS FILE USED TO BE. A facade that read the process-wide deployment word and
// handed SEVENTEEN exports to one of two sibling modules: a 432-line SQLite arm and a
// 377-line arm speaking to `/v1` through the legacy blocking bridge. Both are gone.
// Owner rows go through the seam's own `owners` repository; the address ownership
// columns are read through `addresses` and written through
// `addressLifecycle.applyAddressOwnership` — the seam operation that exists for
// exactly this write; and the audit trail goes through the same generic resource path
// on both stores via the ledger extension (src/store-address-ownership-ledger.ts),
// because `EmailStore` does not declare it yet and `src/store/` is byte-identical in
// this change. The described-and-not-made seam widening lives in that module's
// header.
//
// THE DELETED SQLITE ARM WAS ALREADY HALF AN HTTP ARM. Its six owner-row operations
// each began by asking the legacy resource bridge whether to route to `/v1` after all
// — while its eleven address-side and audit operations never asked. So one
// configuration could register an owner through an API and then assign addresses and
// write audit rows into a LOCAL SQLite island holding no such owner: the provenance
// split this programme exists to remove, measured here rather than assumed. The same
// split crossed FAMILY lines: `src/db/send-keys.ts` collapsed first, so the sendkey
// command resolved an owner NAME through this facade's deployment word while the keys
// came from the configured store (#137; recorded in that file's divergence 8). Both
// splits close here, by construction: every read and write below resolves the same
// way the send-key family's do.
//
// ─── WHAT THE TWO ARMS DID DIFFERENTLY, MEASURED RATHER THAN ASSUMED ─────────────────
//
//  1. EVERY OWNER READ IN THE DELETED SECOND ARM ANSWERED OUT OF ONE CLAMPED PAGE. It
//     asked for `{ limit: 1000 }` once and filtered locally; the service clamps a list
//     to 500 rows. So with 501+ owners, `getOwnerByName` answered null for a REAL
//     owner past the clamp — and that lookup is how `owner addresses`, `sendkey
//     create`, `sendkey list --owner` and `sendkey check` turn a name into an id, so
//     a real owner became "Owner not found". `createOwner`'s duplicate-external_id
//     guard missed a clash past the clamp and issued the second POST (the store's own
//     unique key then refused it with a transport error instead of this module's
//     message). `listOwnerNamesByIds` silently dropped names past the clamp, so the
//     sendkey listing printed raw ids for owners that exist. And every "addresses for
//     owner" read filtered ONE page of `/v1/addresses`, so an owner's 501st address
//     was invisible to `owner addresses` and to `sendkey create`'s printed scope.
//     Every read below enumerates the WHOLE filtered set (pushing down the filters
//     both stores accept, re-checked client-side) and REFUSES if it could not finish.
//  2. THE TWO STORES ORDER THE OWNERS TABLE DIFFERENTLY, AND `ListOptions` ADMITS NO
//     ORDERING. The SQLite store's generic list orders by `updated_at DESC, id DESC`;
//     the service orders `owners` by `created_at DESC, id ASC`
//     (src/server/self-hosted/resources.ts). Both deleted arms promised newest-first
//     by `created_at` — one via SQL with no tiebreaker, one by sorting with
//     `localeCompare`, so the order it presented moved with the machine's locale.
//     Every list below sorts the enumerated set itself — UTF-16 code-unit order, with
//     the row id making it total — and windows locally.
//  3. NAME RESOLUTION DISAGREED ON WHICH DUPLICATE WINS. Neither schema declares
//     `owners.name` unique, so two owners can share a name. The deleted SQLite arm
//     spelled its answer in SQL: `ORDER BY created_at ASC` — the OLDEST registration
//     wins. The deleted second arm took `.find()` over the server's newest-first page:
//     the NEWEST wins, and only within one clamped page. The OLDEST-wins promise is
//     kept, deliberately: name→id resolution feeds send-key issuance and address
//     assignment, and under newest-wins, registering a second "andrei" TODAY quietly
//     captures every subsequent `--owner andrei`. Same rule for `external_id` and
//     `contact_email` lookups (the SQLite arm ordered all three ascending; for
//     external_id both shipped schemas carry a unique key, so duplicates are reachable
//     only through a caller-supplied store).
//  4. TIMESTAMPS: ABSENT IS NOT `now()`. The deleted second arm read owner and event
//     timestamps through a coercion that answers the current instant for a missing
//     value — `created_at` fell back to `updated_at`, and `updated_at` to the moment
//     the row was READ, dating a registration to the time of the listing. Both
//     schemas declare these columns NOT NULL, so absence is a projection fault and is
//     reported as one, naming the row. Nothing below SENDS a timestamp on an owner
//     create — both stores stamp their own ISO instants — with ONE deliberate
//     exception: the audit trail's `created_at` is client-minted and MONOTONIC
//     (`ownershipEventTimestamp`), because consecutive events inside one millisecond
//     must present in write order, both stores declare the column writable for this
//     resource, and the service honours the client-minted event id for the same
//     reason.
//  5. OWNER `type` OUTSIDE THE DECLARED SET MAPS TO `human`, WHICH BOTH ARMS AGREED
//     ON. The local schema CHECK-constrains type to human/agent; the service schema
//     does not — it declares DEFAULT 'human'. Both deleted arms mapped anything that
//     is not exactly "agent" to "human", and that coercion is PRESERVED rather than
//     turned into a fault: it matches the server's own declared default, and it fails
//     SAFE — a garbage-typed owner cannot administer addresses and cannot be
//     self-administered, so every privileged path refuses it. The audit trail's
//     `action` column is the opposite case: the local schema CHECK-constrains it, the
//     service schema does not, and no agreed coercion exists — an out-of-set action in
//     an AUDIT record is a fault naming the row and the value, never a cast (mapping
//     happens AFTER filtering and windowing, so one bad row faults only the read that
//     would present it).
//  6. THE ADDRESS ROWS THESE LISTINGS RETURN LOSE THEIR PROVIDER ASSOCIATION, NAMED
//     RATHER THAN HIDDEN. The published `EmailAddress` shape carries `provider_id`;
//     the seam's `AddressRecord` does not (the strongest arm's address model has no
//     provider association). The deleted second arm already answered `""` there, so
//     an API-configured installation never saw one; what changes is that a LOCAL
//     installation's `listAddressesByOwner` now answers `""` too, where the deleted
//     SQLite arm's `SELECT *` surfaced the column. Every consumer in this repo
//     tolerates the empty string (the CLI prints it dim or substitutes a label).
//     `status` is narrowed the way the deleted second arm did — "suspended" stays,
//     anything else presents as "active" — where the deleted SQLite arm CAST the raw
//     column behind the binary type (the #137 class this programme removes).
//  7. WHAT BOTH ARMS AGREED ON, PRESERVED: an invalid owner type on create is refused
//     by name; a duplicate `external_id` is refused with the same message (the check
//     now enumerates, and the store's own unique key — carried by BOTH shipped
//     schemas — is the backstop the deleted arms also had); agent owners
//     self-administer and `administratorId` is ignored for them; a human owner
//     without an agent administrator is refused; assign refuses to take over an
//     address owned by SOMEONE ELSE (re-assign to the same owner stays allowed, and
//     an administrator change under the same owner is recorded as an `assign`);
//     transfer and unassign REQUIRE a reason; an event is recorded only when the
//     ownership actually changed; `getAddressOwnership` answers null for an unowned
//     address and coerces a vanished owner's type to "agent"; event listings are
//     newest-first and the default/maximum limits (20/100) are kept.
//
// ─── WHAT IS LOST, NAMED RATHER THAN LEFT TO BE DISCOVERED ───────────────────────────
//
//  * THE ATOMIC OWNERSHIP WRITE. The deleted SQLite arm's assign/transfer/unassign
//    each read, validated and updated inside one process over one file; they are now
//    read-validate-write over the seam, so two racing writes can interleave — the
//    second arm already had exactly this exposure. The trail keeps its honesty rule
//    either way: the event is recorded only after the store confirms the patch
//    landed, and a write whose audit row cannot be recorded (a caller-supplied store
//    without the ledger) is REFUSED up front rather than performed unrecorded.
//  * SYNCHRONOUS CALLS. Every operation on the seam is async, so all seventeen
//    exports are now async and every consumer awaits them.
//  * THERE IS STILL NO OWNER DELETE. Neither deleted arm exposed one, and this
//    collapse does not add one (fixture owners parked in a live service — task
//    d5a42a50 — stay parked). When it lands it belongs HERE, as one export over
//    `owners.remove`, with rules for the send keys and addresses that reference the
//    row (both schemas already answer `ON DELETE SET NULL` for them locally).
//
// WHAT IS SLOWER: a read that is not addressed by id walks its whole filtered family —
// one in-process query per page locally, one HTTP request per page against an API, at
// up to 500 rows a page. The `type` filter (owners) and `address_id` filter (events)
// push down; the address registry has no owner filter on the seam, so the two
// "addresses for owner" listings walk the registry — the same composition, and the
// same budget, that the send-key scope check already uses. Bounded rather than
// open-ended: past the page budget these reads THROW instead of degrading, because
// the alternative is a real owner reported as missing or a truncated address scope
// presented as the whole one.

import type { Database } from "./database.js";
import { cappedLimit, safeOffset, safeOptionalLimit } from "./pagination.js";
import { uuid } from "./runtime.js";
// Value coercion only. These are pure functions that turn one store's JSON-typed
// column into the other's TEXT-encoded one; the module they live in is named for the
// axis being deleted, and relocating them belongs to that deletion rather than to
// this collapse.
import { cstr, cstrOrNull } from "./self-hosted-resource.js";
import { enumerateStoreRows, type StoreEnumeration } from "../lib/status-facts-enumeration.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import {
  addressOwnershipLedgerOf,
  type AddressOwnershipLedger,
} from "../store-address-ownership-ledger.js";
import type { EmailStore } from "../store/email-store.js";
import type { AddressRecord, ListOptions, ResourceRow } from "../store/records.js";
import type { Outcome } from "../store/outcome.js";
import type { EmailAddress } from "../types/index.js";

export type OwnerType = "human" | "agent";

export interface Owner {
  id: string;
  type: OwnerType;
  name: string;
  contact_email: string | null;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateOwnerInput {
  type: OwnerType;
  name: string;
  contact_email?: string;
  external_id?: string;
}

export interface ListOwnerOptions {
  limit?: number;
  offset?: number;
}

export interface ListAddressesByOwnerOptions {
  limit?: number;
  offset?: number;
}

export interface AddressOwnership {
  owner_id: string;
  owner_type: OwnerType;
  administrator_id: string;
}

export type AddressOwnershipAction = "assign" | "transfer" | "unassign";

export interface AddressOwnershipEvent {
  id: string;
  address_id: string;
  action: AddressOwnershipAction;
  previous_owner_id: string | null;
  previous_administrator_id: string | null;
  owner_id: string | null;
  administrator_id: string | null;
  actor: string | null;
  reason: string | null;
  created_at: string;
}

interface CurrentAddressOwnership {
  owner_id: string | null;
  administrator_id: string | null;
}

interface OwnershipChangeOptions {
  actor?: string;
  reason?: string;
}

/**
 * What every export accepts as its optional store argument.
 *
 * A UNION RATHER THAN A REPLACEMENT, because `Database` has been the published shape
 * of this parameter for the package's whole 1.x life — these exports are on the
 * public entrypoint (src/index.ts), and narrowing a 1.x surface is a breaking
 * change. See `storeFor` for what each arm means.
 */
export type OwnerStore = EmailStore | Database;

/**
 * Pages one address-registry enumeration may fetch, for the two "addresses for
 * owner" listings and the email projection. The seam has no owner filter on the
 * address list, so these walk the whole registry and match client-side — the same
 * composition, and the same budget, that `src/db/send-keys.ts` and
 * `src/db/address-lifecycle.ts` use for their own by-column address lookups.
 * 20 pages bounds one read at 10,000 address rows.
 */
const MAX_ADDRESS_PAGES = 20;

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
 * resolve the configured store and read the wrong installation's owners.
 *
 * Built per call rather than at module load, because a contradictory storage
 * configuration is a boot error raised by the resolution and it belongs to the call
 * that needed a store, not to whoever imported this module first.
 */
function storeFor(handle: OwnerStore | undefined): EmailStore {
  if (handle === undefined) return createConfiguredEmailStore();
  const candidate = handle as Partial<EmailStore> & Partial<Database>;
  if (typeof candidate.messages === "object" && candidate.messages !== null) return handle as EmailStore;
  if (typeof candidate.query === "function") {
    return createSqliteEmailStore({ database: handle as Database, detail: "caller-supplied database" });
  }
  throw new Error(
    "The owners family's optional store argument must be an EmailStore or a bun:sqlite Database; "
      + `received ${handle === null ? "null" : typeof handle}. Passing neither would silently read the `
      + "store this installation is configured with, which is not the one the caller named.",
  );
}

/**
 * True when the caller's argument is a store rather than options.
 *
 * Needed because the published surface admits TWO parameter orders for the listing
 * exports: the deleted SQLite arm took its optional handle BEFORE the options, the
 * deleted facade's compat shim exposed options-first, and the facade's intersection
 * type made both compile for the package's whole 1.x life. Narrowing to one order
 * would break released consumers, so both stay and the argument's SHAPE decides —
 * the same structural question `storeFor` asks, never a label.
 */
function isStoreArgument(value: unknown): value is OwnerStore {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<EmailStore> & Partial<Database>;
  return typeof candidate.query === "function"
    || (typeof candidate.messages === "object" && candidate.messages !== null);
}

/** Split one of the dual-order listing argument pairs into (opts, store). */
function listingArguments<TOptions>(
  first: TOptions | OwnerStore | undefined,
  second: OwnerStore | TOptions | undefined,
): { opts: TOptions | undefined; store: OwnerStore | undefined } {
  if (isStoreArgument(first)) return { opts: second as TOptions | undefined, store: first };
  return { opts: first, store: second as OwnerStore | undefined };
}

/**
 * The audit ledger, or a refusal naming what is missing.
 *
 * Both shipped stores carry it (they serve the trail through the same generic
 * resource path as `owners` itself), so this refusal is only reachable with a
 * caller-supplied store that implements the seam and nothing else. For the WRITES it
 * fires BEFORE the ownership patch: an ownership change whose audit row cannot be
 * recorded must be refused rather than performed unrecorded.
 */
function ledgerFor(store: EmailStore, what: string): AddressOwnershipLedger {
  const ledger = addressOwnershipLedgerOf(store);
  if (ledger !== null) return ledger;
  throw new Error(
    `This store cannot ${what}: it carries no address-ownership audit ledger (no `
      + "addressOwnershipEvents repository beside its owners repository). Both shipped "
      + "stores carry it; a caller-supplied store must too.",
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

/** Identity for duplicate/shift accounting during enumeration; null when untrackable. */
function enumerationIdOf(row: ResourceRow): string | null {
  const value = row["id"] ?? row["rowid"];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

/** Shared refusal text for an enumeration that could not finish honestly. */
function incompleteEnumeration(what: string, enumeration: StoreEnumeration<unknown>): Error {
  const cause = enumeration.exhausted
    ? `the ${enumeration.pages}-page enumeration budget ran out before the end of the table`
    : enumeration.duplicates > 0
      ? `${enumeration.duplicates} row(s) came back twice across ${enumeration.pages} page(s), so at least `
        + "that many rows were never seen"
      : `a page did not begin on the row the previous page ended on across ${enumeration.pages} page(s), `
        + "so rows were skipped";
  return new Error(
    `Refusing to ${what}: ${cause}, so the ${enumeration.rows.length} row(s) read are a LOWER BOUND `
      + "rather than the whole set — and a name resolution, a duplicate check, an address scope or an "
      + "audit listing taken from a partial read is silently wrong. Narrow the read or retry.",
  );
}

/**
 * Every row the filter admits, or a throw naming why not.
 *
 * WHY A THROW: `rows` coming back short has three unrelated causes — the store
 * refused, the read faulted, or the enumeration ran out of budget — and none of them
 * is "that few owners exist". These functions return arrays, scalars and maps rather
 * than outcomes, so raising is the only way to keep the three apart from an honestly
 * empty answer.
 */
async function readAll(
  list: (opts: ListOptions & { filters?: Record<string, string> }) => Promise<Outcome<ResourceRow[]>>,
  filters: Record<string, string> | undefined,
  what: string,
): Promise<ResourceRow[]> {
  const enumeration: StoreEnumeration<ResourceRow> = await enumerateStoreRows<ResourceRow>(
    (opts: ListOptions) => list({ ...opts, ...(filters ? { filters } : {}) }),
    { idOf: enumerationIdOf },
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
  if (!enumeration.complete) throw incompleteEnumeration(what, enumeration);
  return enumeration.rows;
}

/**
 * Every address row in the registry, typed. The seam's address list accepts no
 * filters, so the owner/administrator match happens on the caller's side — see
 * `MAX_ADDRESS_PAGES` for the budget and the precedent.
 */
async function readAllAddresses(store: EmailStore, what: string): Promise<AddressRecord[]> {
  const enumeration: StoreEnumeration<AddressRecord> = await enumerateStoreRows<AddressRecord>(
    (opts: ListOptions) => store.addresses.listAddresses(opts),
    {
      idOf: (record) => (typeof record.id === "string" && record.id !== "" ? record.id : null),
      pageBudget: MAX_ADDRESS_PAGES,
    },
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
  if (!enumeration.complete) throw incompleteEnumeration(what, enumeration);
  return enumeration.rows;
}

/** Code-unit order, not `localeCompare` (divergence 2). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The listing order both arms promised: newest first, with identity making it total. */
function byNewestRaw(a: ResourceRow, b: ResourceRow): number {
  return (
    compareText(cstr(b["created_at"]), cstr(a["created_at"]))
    || compareText(cstr(b["id"]), cstr(a["id"]))
  );
}

/** The resolution order the SQLite arm promised: OLDEST registration first (divergence 3). */
function byOldestRaw(a: ResourceRow, b: ResourceRow): number {
  return (
    compareText(cstr(a["created_at"]), cstr(b["created_at"]))
    || compareText(cstr(a["id"]), cstr(b["id"]))
  );
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
      `This installation's store returned ${noun} ${cstr(row["id"]) || "(no id)"} `
        + `with no ${key}; refusing to report the current time in its place`,
    );
  }
  return value;
}

/**
 * The declared owner-type coercion both arms agreed on (divergence 5): exactly
 * "agent" is an agent; anything else — including the service schema's reachable
 * garbage — presents as the server's own declared default, "human", which no
 * privileged path accepts as an administrator.
 */
function ownerTypeOf(row: ResourceRow): OwnerType {
  return cstr(row["type"]) === "agent" ? "agent" : "human";
}

function toOwner(row: ResourceRow): Owner {
  return {
    id: cstr(row["id"]),
    type: ownerTypeOf(row),
    name: cstr(row["name"]),
    contact_email: cstrOrNull(row["contact_email"]),
    external_id: cstrOrNull(row["external_id"]),
    created_at: requiredTimestamp(row, "created_at", "owner"),
    updated_at: requiredTimestamp(row, "updated_at", "owner"),
  };
}

const OWNERSHIP_ACTIONS: ReadonlySet<string> = new Set(["assign", "transfer", "unassign"]);

/**
 * The declared action set, enforced at the boundary (divergence 5). The local schema
 * CHECK-constrains it, the service schema does not, and this is an AUDIT record: an
 * action outside the set is a fault naming the row and the value, never a cast.
 */
function actionOf(row: ResourceRow): AddressOwnershipAction {
  const raw = cstr(row["action"]);
  if (!OWNERSHIP_ACTIONS.has(raw)) {
    throw new Error(
      `This installation's store returned address-ownership event ${cstr(row["id"]) || "(no id)"} `
        + `with action ${JSON.stringify(raw)}, which is outside the declared set `
        + "(assign, transfer, unassign); refusing to present it as one of them",
    );
  }
  return raw as AddressOwnershipAction;
}

function toOwnershipEvent(row: ResourceRow): AddressOwnershipEvent {
  return {
    id: cstr(row["id"]),
    address_id: cstr(row["address_id"]),
    action: actionOf(row),
    previous_owner_id: cstrOrNull(row["previous_owner_id"]),
    previous_administrator_id: cstrOrNull(row["previous_administrator_id"]),
    owner_id: cstrOrNull(row["owner_id"]),
    administrator_id: cstrOrNull(row["administrator_id"]),
    actor: cstrOrNull(row["actor"]),
    reason: cstrOrNull(row["reason"]),
    created_at: requiredTimestamp(row, "created_at", "address-ownership event"),
  };
}

/**
 * The published address shape, from the seam's record (divergence 6): no provider
 * association (`""`, the deleted second arm's own answer) and the status narrowed
 * rather than cast.
 */
function toEmailAddress(record: AddressRecord): EmailAddress {
  return {
    id: record.id,
    provider_id: "",
    email: record.email,
    display_name: record.display_name,
    verified: record.verified,
    owner_id: record.owner_id ?? null,
    administrator_id: record.administrator_id ?? null,
    status: record.status === "suspended" ? "suspended" : "active",
    daily_quota: record.daily_quota,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

/** Newest address first, with identity making it total — the order both arms promised. */
function byNewestAddress(a: AddressRecord, b: AddressRecord): number {
  return compareText(b.created_at, a.created_at) || compareText(b.id, a.id);
}

// ─── OWNERS ─────────────────────────────────────────────────────────────────

export async function createOwner(input: CreateOwnerInput, store?: OwnerStore): Promise<Owner> {
  if (input.type !== "human" && input.type !== "agent") {
    throw new Error(`Invalid owner type '${input.type}' (must be 'human' or 'agent')`);
  }
  const resolved = storeFor(store);
  const externalId = input.external_id?.trim();
  if (externalId) {
    // The friendly refusal, over the WHOLE table (divergence 1). Both shipped
    // schemas also carry a unique key on external_id, so a clash that races past
    // this read is refused by the store itself, as it always was.
    const clash = (await readAll(
      (opts) => resolved.owners.list(opts),
      undefined,
      `check for an existing owner with external id ${externalId}`,
    )).some((row) => cstrOrNull(row["external_id"]) === externalId);
    if (clash) throw new Error(`Owner external_id already exists: ${externalId}`);
  }
  // No id and no timestamps are sent — both stores mint the TEXT primary key and
  // stamp their own ISO instants (divergence 4).
  const created = required(
    "register an owner",
    await resolved.owners.create({
      type: input.type,
      name: input.name,
      contact_email: input.contact_email ?? null,
      external_id: externalId ?? null,
    }),
  );
  return toOwner(created);
}

export async function getOwner(id: string, store?: OwnerStore): Promise<Owner | null> {
  // An empty id addresses no row — and through an API, a blank path segment is a
  // DIFFERENT route (the list), whose answer must not be presented as a record.
  if (id.trim() === "") return null;
  const record = required("read an owner", await storeFor(store).owners.get(id));
  return record === null ? null : toOwner(record);
}

/**
 * One owner by exact name, or null. This enumerates: neither store's owners list
 * accepts a name filter, and the deleted second arm's one-page scan answered null
 * for a real owner past the clamp (divergence 1) — which turned into "Owner not
 * found" on every command that resolves names. Among owners sharing a name the
 * OLDEST registration wins, deterministically (divergence 3).
 */
export async function getOwnerByName(name: string, store?: OwnerStore): Promise<Owner | null> {
  const rows = await readAll(
    (opts) => storeFor(store).owners.list(opts),
    undefined,
    `resolve the owner name ${name}`,
  );
  const match = rows.filter((row) => cstr(row["name"]) === name).sort(byOldestRaw)[0];
  return match === undefined ? null : toOwner(match);
}

export async function getOwnerByExternalId(externalId: string, store?: OwnerStore): Promise<Owner | null> {
  const normalized = externalId.trim();
  if (!normalized) return null;
  const rows = await readAll(
    (opts) => storeFor(store).owners.list(opts),
    undefined,
    `resolve the owner external id ${normalized}`,
  );
  const match = rows.filter((row) => cstrOrNull(row["external_id"]) === normalized).sort(byOldestRaw)[0];
  return match === undefined ? null : toOwner(match);
}

export async function getOwnerByContactEmail(email: string, store?: OwnerStore): Promise<Owner | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const rows = await readAll(
    (opts) => storeFor(store).owners.list(opts),
    undefined,
    `resolve the owner contact email ${normalized}`,
  );
  const match = rows
    .filter((row) => (cstrOrNull(row["contact_email"]) ?? "").toLowerCase() === normalized)
    .sort(byOldestRaw)[0];
  return match === undefined ? null : toOwner(match);
}

export async function listOwners(
  type?: OwnerType,
  opts?: ListOwnerOptions,
  store?: OwnerStore,
): Promise<Owner[]>;
export async function listOwners(
  type: OwnerType | undefined,
  store: OwnerStore | undefined,
  opts?: ListOwnerOptions,
): Promise<Owner[]>;
export async function listOwners(
  type?: OwnerType,
  second?: ListOwnerOptions | OwnerStore,
  third?: OwnerStore | ListOwnerOptions,
): Promise<Owner[]> {
  // Both published argument orders stay callable (see `isStoreArgument`), including
  // the deleted SQLite arm's `(type, undefined, opts)` — the facade's compat shim
  // served `(type, opts)` on the same export for the package's whole 1.x life.
  const { opts, store } = listingArguments<ListOwnerOptions>(second, third);
  // The `type` filter pushes down (the column exists locally and `/v1/owners`
  // declares the filter) and is RE-CHECKED on the raw row, comparing the RAW text
  // exactly as both stores' own pushed-down filters do: a store or fixture that
  // ignores an equality filter answers with the unfiltered list.
  const rows = await readAll(
    (listOpts) => storeFor(store).owners.list(listOpts),
    type === undefined ? undefined : { type },
    "list owners",
  );
  const admitted = type === undefined ? rows : rows.filter((row) => cstr(row["type"]) === type);
  return windowed(admitted.sort(byNewestRaw), opts).map(toOwner);
}

/** The distinct, non-empty string ids of an iterable that may carry nulls (see below). */
function wantedIds(ownerIds: Iterable<string>): Set<string> {
  const wanted = new Set<string>();
  for (const id of ownerIds) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed !== "") wanted.add(trimmed);
  }
  return wanted;
}

/**
 * Owner names for a batch of ids — the shape the sendkey listing prints. ONE
 * enumeration of the owners table rather than one addressed read per id
 * (divergence 1: the deleted second arm read one clamped page and silently dropped
 * names past it, so the listing printed raw ids for owners that exist).
 *
 * Ids are sanitised STRUCTURALLY rather than trusted: `send_keys.owner_id` is
 * nullable on the seam and on the service schema (a key can outlive its owner), so
 * a null or non-string entry in the iterable is dropped rather than faulted — the
 * caller is building a display map, and one orphaned key must not take down the
 * listing.
 */
export async function listOwnerNamesByIds(
  ownerIds: Iterable<string>,
  store?: OwnerStore,
): Promise<Map<string, string>> {
  const wanted = wantedIds(ownerIds);
  if (wanted.size === 0) return new Map();
  const rows = await readAll(
    (opts) => storeFor(store).owners.list(opts),
    undefined,
    "resolve owner names for a set of ids",
  );
  const names = new Map<string, string>();
  for (const row of rows) {
    const id = cstr(row["id"]);
    if (wanted.has(id)) names.set(id, cstr(row["name"]));
  }
  return names;
}

export async function listOwnersByIds(
  ownerIds: Iterable<string>,
  store?: OwnerStore,
): Promise<Map<string, Owner>> {
  const wanted = wantedIds(ownerIds);
  if (wanted.size === 0) return new Map();
  const rows = await readAll(
    (opts) => storeFor(store).owners.list(opts),
    undefined,
    "resolve owners for a set of ids",
  );
  const owners = new Map<string, Owner>();
  for (const row of rows) {
    const id = cstr(row["id"]);
    if (wanted.has(id)) owners.set(id, toOwner(row));
  }
  return owners;
}

// ─── ADDRESS OWNERSHIP ──────────────────────────────────────────────────────

let lastOwnershipEventMs = 0;

/**
 * Client-minted, strictly monotonic event instants (divergence 4): consecutive
 * events inside one millisecond must present in write order, and `created_at` is
 * the order every trail listing sorts by.
 */
function ownershipEventTimestamp(): string {
  const current = Date.now();
  lastOwnershipEventMs = current <= lastOwnershipEventMs ? lastOwnershipEventMs + 1 : current;
  return new Date(lastOwnershipEventMs).toISOString();
}

async function getCurrentAddressOwnership(
  store: EmailStore,
  addressId: string,
): Promise<CurrentAddressOwnership> {
  const record = addressId.trim() === ""
    ? null
    : required("read an address", await store.addresses.getAddress(addressId));
  if (record === null) throw new Error(`Address not found: ${addressId}`);
  return {
    owner_id: record.owner_id ?? null,
    administrator_id: record.administrator_id ?? null,
  };
}

async function validateAddressOwnership(
  store: EmailStore,
  ownerId: string,
  administratorId: string | undefined,
): Promise<AddressOwnership> {
  const owner = await getOwner(ownerId, store);
  if (!owner) throw new Error(`Owner not found: ${ownerId}`);

  let adminId: string;
  if (owner.type === "agent") {
    adminId = owner.id;
  } else {
    if (!administratorId) {
      throw new Error("A human-owned address requires an agent administrator (pass administratorId)");
    }
    const admin = await getOwner(administratorId, store);
    if (!admin) throw new Error(`Administrator not found: ${administratorId}`);
    if (admin.type !== "agent") throw new Error("The administrator must be an agent");
    adminId = admin.id;
  }

  return { owner_id: owner.id, owner_type: owner.type, administrator_id: adminId };
}

/**
 * Apply an ownership patch and confirm it landed. A null answer means the address
 * vanished between the read and the write; recording an audit event for a write
 * that did not land would forge the trail, so it is a fault instead.
 */
async function applyOwnershipPatch(
  store: EmailStore,
  addressId: string,
  patch: { owner_id: string | null; administrator_id: string | null },
): Promise<void> {
  const applied = required(
    "write address ownership",
    await store.addressLifecycle.applyAddressOwnership(addressId, patch),
  );
  if (applied === null) throw new Error(`Address not found: ${addressId}`);
}

async function recordAddressOwnershipEvent(
  ledger: AddressOwnershipLedger,
  addressId: string,
  action: AddressOwnershipAction,
  previous: CurrentAddressOwnership,
  next: { owner_id: string | null; administrator_id: string | null },
  options: OwnershipChangeOptions = {},
): Promise<AddressOwnershipEvent> {
  // The event id is CLIENT-minted and the instant is explicit — the service honours
  // both for this resource, and the local generic path writes an explicit id and
  // created_at instead of minting its own (divergence 4).
  const created = required(
    "record an address-ownership event",
    await ledger.addressOwnershipEvents.create({
      id: uuid(),
      address_id: addressId,
      action,
      previous_owner_id: previous.owner_id,
      previous_administrator_id: previous.administrator_id,
      owner_id: next.owner_id,
      administrator_id: next.administrator_id,
      actor: options.actor?.trim() || null,
      reason: options.reason?.trim() || null,
      created_at: ownershipEventTimestamp(),
    }),
  );
  return toOwnershipEvent(created);
}

export async function getAddressOwnershipEvent(
  id: string,
  store?: OwnerStore,
): Promise<AddressOwnershipEvent | null> {
  if (id.trim() === "") return null;
  const ledger = ledgerFor(storeFor(store), "read an address-ownership event");
  const record = required(
    "read an address-ownership event",
    await ledger.addressOwnershipEvents.get(id),
  );
  return record === null ? null : toOwnershipEvent(record);
}

/**
 * The audit trail of one address, newest first. The `address_id` filter pushes down
 * (the column exists locally and `/v1/address-ownership-events` declares the
 * filter) and is RE-CHECKED on the raw row: trusting a store that ignores it would
 * splice another address's history into this one's trail. The default and maximum
 * limits (20/100) are both arms' own.
 */
export async function listAddressOwnershipEvents(
  addressId: string,
  limit = 20,
  store?: OwnerStore,
): Promise<AddressOwnershipEvent[]> {
  const safeLimit = cappedLimit(limit, 20, 100);
  const ledger = ledgerFor(storeFor(store), "list address-ownership events");
  const rows = await readAll(
    (opts) => ledger.addressOwnershipEvents.list(opts),
    { address_id: addressId },
    `list the ownership events of address ${addressId}`,
  );
  return rows
    .filter((row) => cstr(row["address_id"]) === addressId)
    .sort(byNewestRaw)
    .slice(0, safeLimit)
    .map(toOwnershipEvent);
}

/**
 * Assign ownership of an address.
 *  - agent owner → self-administered (administrator = owner; administratorId ignored)
 *  - human owner → administratorId is REQUIRED and must reference an agent owner
 */
export async function assignAddressOwner(
  addressId: string,
  ownerId: string,
  administratorId?: string,
  store?: OwnerStore,
): Promise<AddressOwnership> {
  const resolved = storeFor(store);
  // The ledger is required BEFORE the write: an ownership change this module cannot
  // record must be refused rather than performed unrecorded.
  const ledger = ledgerFor(resolved, "assign address ownership");
  const ownership = await validateAddressOwnership(resolved, ownerId, administratorId);

  // Refuse to silently take over an address already owned by someone else —
  // prevents cross-principal hijack on (re)provision. Reassigning to the same
  // owner (e.g. updating the administrator) stays allowed.
  const current = await getCurrentAddressOwnership(resolved, addressId);
  if (current.owner_id && current.owner_id !== ownership.owner_id) {
    throw new Error(`Address ${addressId} is already owned by another owner; transfer is not permitted`);
  }

  await applyOwnershipPatch(resolved, addressId, {
    owner_id: ownership.owner_id,
    administrator_id: ownership.administrator_id,
  });
  if (current.owner_id !== ownership.owner_id || current.administrator_id !== ownership.administrator_id) {
    await recordAddressOwnershipEvent(ledger, addressId, "assign", current, ownership);
  }
  return ownership;
}

export async function transferAddressOwner(
  addressId: string,
  ownerId: string,
  administratorId: string | undefined,
  options: OwnershipChangeOptions,
  store?: OwnerStore,
): Promise<AddressOwnership> {
  const resolved = storeFor(store);
  const ledger = ledgerFor(resolved, "transfer address ownership");
  const reason = options.reason?.trim();
  if (!reason) throw new Error("Address ownership transfer requires a reason");

  const current = await getCurrentAddressOwnership(resolved, addressId);
  const ownership = await validateAddressOwnership(resolved, ownerId, administratorId);

  await applyOwnershipPatch(resolved, addressId, {
    owner_id: ownership.owner_id,
    administrator_id: ownership.administrator_id,
  });
  if (current.owner_id !== ownership.owner_id || current.administrator_id !== ownership.administrator_id) {
    await recordAddressOwnershipEvent(ledger, addressId, "transfer", current, ownership, options);
  }
  return ownership;
}

export async function unassignAddressOwner(
  addressId: string,
  options: OwnershipChangeOptions,
  store?: OwnerStore,
): Promise<null> {
  const resolved = storeFor(store);
  const ledger = ledgerFor(resolved, "unassign address ownership");
  const reason = options.reason?.trim();
  if (!reason) throw new Error("Address ownership unassign requires a reason");

  const current = await getCurrentAddressOwnership(resolved, addressId);
  await applyOwnershipPatch(resolved, addressId, { owner_id: null, administrator_id: null });
  if (current.owner_id || current.administrator_id) {
    await recordAddressOwnershipEvent(
      ledger,
      addressId,
      "unassign",
      current,
      { owner_id: null, administrator_id: null },
      options,
    );
  }
  return null;
}

export async function getAddressOwnership(
  addressId: string,
  store?: OwnerStore,
): Promise<AddressOwnership | null> {
  const resolved = storeFor(store);
  const record = addressId.trim() === ""
    ? null
    : required("read an address", await resolved.addresses.getAddress(addressId));
  if (record === null) return null;
  const ownerId = record.owner_id ?? null;
  if (!ownerId) return null;
  const owner = await getOwner(ownerId, resolved);
  return {
    owner_id: ownerId,
    // A vanished owner's type coerces to "agent" — both arms' answer for a row whose
    // owner no longer resolves.
    owner_type: owner?.type ?? "agent",
    administrator_id: record.administrator_id ?? ownerId,
  };
}

// ─── ADDRESSES FOR AN OWNER ─────────────────────────────────────────────────

async function readAddressesByRole(
  store: EmailStore,
  ownerId: string,
  role: "owner" | "administrator",
  what: string,
): Promise<AddressRecord[]> {
  const rows = await readAllAddresses(store, what);
  return rows
    .filter((record) => (role === "administrator" ? record.administrator_id : record.owner_id) === ownerId)
    .sort(byNewestAddress);
}

/** List addresses an owner owns (default) or administers. */
export async function listAddressesByOwner(
  ownerId: string,
  role?: "owner" | "administrator",
  opts?: ListAddressesByOwnerOptions,
  store?: OwnerStore,
): Promise<EmailAddress[]>;
export async function listAddressesByOwner(
  ownerId: string,
  role: "owner" | "administrator" | undefined,
  store: OwnerStore | undefined,
  opts?: ListAddressesByOwnerOptions,
): Promise<EmailAddress[]>;
export async function listAddressesByOwner(
  ownerId: string,
  role: "owner" | "administrator" = "owner",
  second?: ListAddressesByOwnerOptions | OwnerStore,
  third?: OwnerStore | ListAddressesByOwnerOptions,
): Promise<EmailAddress[]> {
  const { opts, store } = listingArguments<ListAddressesByOwnerOptions>(second, third);
  const rows = await readAddressesByRole(
    storeFor(store),
    ownerId,
    role,
    `list the addresses of owner ${ownerId}`,
  );
  return windowed(rows, opts).map(toEmailAddress);
}

/** List addresses an owner administers but does not also own. */
export async function listAdministeredAddressesNotOwnedBy(
  ownerId: string,
  opts?: ListAddressesByOwnerOptions,
  store?: OwnerStore,
): Promise<EmailAddress[]>;
export async function listAdministeredAddressesNotOwnedBy(
  ownerId: string,
  store: OwnerStore | undefined,
  opts?: ListAddressesByOwnerOptions,
): Promise<EmailAddress[]>;
export async function listAdministeredAddressesNotOwnedBy(
  ownerId: string,
  second?: ListAddressesByOwnerOptions | OwnerStore,
  third?: OwnerStore | ListAddressesByOwnerOptions,
): Promise<EmailAddress[]> {
  const { opts, store } = listingArguments<ListAddressesByOwnerOptions>(second, third);
  const rows = (await readAllAddresses(
    storeFor(store),
    `list the addresses administered by owner ${ownerId}`,
  ))
    .filter((record) => (record.administrator_id ?? null) === ownerId
      && (record.owner_id ?? null) !== ownerId)
    .sort(byNewestAddress);
  return windowed(rows, opts).map(toEmailAddress);
}

/** List only address strings an owner owns or administers without hydrating address rows. */
export async function listAddressEmailsByOwner(
  ownerId: string,
  role: "owner" | "administrator" = "owner",
  store?: OwnerStore,
): Promise<string[]> {
  const rows = await readAddressesByRole(
    storeFor(store),
    ownerId,
    role,
    `list the address emails of owner ${ownerId}`,
  );
  return rows.map((record) => record.email);
}
