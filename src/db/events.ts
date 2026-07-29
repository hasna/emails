// Delivery/engagement events as ONE implementation over the store seam. Nothing here
// asks where this installation is deployed; the store is resolved from STORAGE
// configuration (src/store-resolution.ts) or handed in by the caller.
//
// WHAT THIS FILE USED TO BE. A facade that read the process-wide deployment word and
// handed SEVEN exports to one of two sibling modules: a 209-line SQLite arm and a
// 248-line arm speaking to `/v1/events` through the legacy blocking bridge. Both are
// gone. Every read and write goes through the seam's own `events` repository, which
// both shipped stores already carry through the same generic resource path (`events`
// in SQLite and on the service) — no seam widening was needed for this family.
//
// ─── WHAT THE TWO ARMS DID DIFFERENTLY, MEASURED RATHER THAN ASSUMED ─────────────────
//
//  1. THE IDEMPOTENT UPSERT WAS TWO DIFFERENT ALGORITHMS. The SQLite arm was
//     create-first: one `INSERT OR IGNORE` riding the partial unique index
//     `idx_events_provider_event (provider_id, provider_event_id)`, atomic under
//     concurrent delivery. The second arm was find-first over ONE `{ limit: 1000 }`
//     page — which the service clamps to 500 — so a duplicate whose original sat past
//     the newest 500 events was NOT found and was created again: the dedup layer #146
//     documents as load-bearing silently stopped working the moment the table
//     outgrew one page. The upsert below is find-first over the WHOLE
//     (provider_id, provider_event_id)-filtered set — both stores push those two
//     equality filters down, so the read is one indexed page, not a table walk —
//     then create, and a `conflict` refusal from the store's own unique key (a race
//     lost between the find and the create) is answered by re-reading the winner
//     rather than surfaced as a failure. A store that cannot filter on
//     `provider_event_id` (a service older than the filter's declaration in
//     src/server/self-hosted/resources.ts) is REFUSED by the HTTP store's contract
//     check, and that refusal surfaces here: deduplication it cannot express is not
//     deduplication this function may silently skip. That is the "preserve on both
//     stores or refuse" ruling, implemented.
//  2. WHAT THE UNIQUE KEY GUARANTEES DIFFERS BY STORE, AND THAT IS NAMED RATHER THAN
//     GLOSSED. The SQLite schema carries the partial unique index, so its generic
//     create refuses the losing side of a race with a typed `conflict`. The service
//     schema does NOT yet hold that key (src/server/self-hosted/migrations.ts
//     declares no unique on events), so two CONCURRENT upserts of the same delivery
//     against an Emails API can still both insert — exactly the deleted second arm's
//     own exposure, minus its one-page blindness. Closing it needs the tenant-scoped
//     partial unique index (and a duplicate-clearing backfill, because deployed
//     tables already hold what the one-page scan let through) on the SERVICE, which
//     is described here and deliberately not bundled into this collapse.
//  3. THE SECOND ARM'S CREATE LIED ABOUT THE ROW ID. It POSTed `id` and `created_at`
//     in the body, but `/v1/events` declares neither column writable: the service
//     dropped both, minted its own, and the arm returned a locally fabricated event
//     whose `id` named NO stored row — `getEvent(created.id)` against the real
//     service answered null. The old test stub accepted client ids verbatim, which is
//     how a fixture kept that divergence green. The create below sends only declared
//     columns and returns the row THE STORE answered with.
//  4. METADATA WAS DOUBLE-ENCODED ON THE WIRE. The second arm sent
//     `JSON.stringify(metadata)` to a JSON column, and the service stringifies a
//     json-typed column's value itself — so Postgres held a JSONB *string* of JSON,
//     tolerated on read only because the mapper re-parsed it. The create below hands
//     the OBJECT to the seam; each store performs its own single encoding (SQLite
//     binds objects as JSON text, the service casts to jsonb).
//  5. THE TWO STORES ORDER THE TABLE DIFFERENTLY, AND `ListOptions` ADMITS NO
//     ORDERING. The service's declared order is `occurred_at DESC, id ASC`
//     (src/server/self-hosted/resources.ts); the SQLite store's generic list derives
//     `created_at DESC, id DESC` (events has no `updated_at`). `occurred_at` is the
//     provider's clock and `created_at` is the ingestion clock, and a backfilled sync
//     interleaves them differently — so neither generic order is the `occurred_at
//     DESC` both deleted arms promised. Every list below therefore enumerates the
//     whole filtered set, sorts it itself — `occurred_at` descending in UTF-16
//     code-unit order (not `localeCompare`, which moved with the machine's locale in
//     the deleted arm), with `id` ascending making it total, the service's own
//     tiebreak — and windows locally.
//  6. WHAT THAT COSTS, AND THE BOUNDED-READ LOSS, STATED HONESTLY. The deleted second
//     arm could serve `{ limit, offset }` past the enumeration budget by trusting the
//     SERVER's declared order to hand it the window directly (the export-500 fix).
//     That trust is not expressible on the seam: the seam declares no ordering, and
//     the SQLite store's generic order genuinely disagrees (divergence 5), so an
//     early stop there returns the WRONG WINDOW whenever ingestion order disagrees
//     with occurrence order — a wrong answer, not a slow one. Branching on which
//     store would answer is forbidden (src/store/descriptor.ts). So a bounded read
//     here costs a whole-set enumeration, and past the budget it REFUSES with the
//     narrowing filters named. The budget is STORE_ENUMERATION_PAGE_BUDGET pages of
//     STORE_LIST_PAGE_MAX rows (40 × 500 = 20 000 rows) — the same shared pager
//     budget every collapsed family runs under, and numerically the same cap the
//     deleted arm's own pager carried; events being the largest table is the reason
//     to keep the walk bounded, not to widen it. Restoring cheap deep windows needs
//     an ordering the seam can request (an `orderBy` on `ListOptions`, or an ordered
//     per-family list operation) — a widening of the byte-frozen `src/store/`,
//     described here and deliberately not made.
//  7. TIMESTAMP ABSENCE IS A FAULT, NOT "NOW". `occurred_at` and `created_at` are
//     NOT NULL on both schemas; the deleted second arm's mapper coerced a missing
//     `created_at` to the CURRENT time, dating a row to the moment it was read.
//     Mapping below faults on either, naming the row — and mapping happens AFTER
//     filtering, sorting and windowing (all of which compare raw text, exactly as
//     both stores' own pushed-down filters do), so one bad row faults only a read
//     that would actually present it.
//  8. WHAT BOTH ARMS AGREED ON, PRESERVED: `type` is presented as the raw stored
//     text behind the `EventType` type (both arms cast; the SQLite schema CHECKs the
//     set on write, the service schema deliberately dropped that CHECK, and faulting
//     a whole listing over a row the service accepted would lose the events the read
//     was for); a null `provider_id` (representable on the service schema, which
//     relaxed the column) is presented as `""`, the second arm's own coercion;
//     malformed metadata text maps to `{}` on read; `since`/`until` and a
//     multi-valued `type` are client-side filters re-checked on every row, because
//     neither store's generic path expresses a range or an IN-list; and the
//     single-valued pushed-down filters (`email_id`, `provider_id`, `type`) are a
//     BOUND on what is read, never the answer — they are re-checked here, so a store
//     or fixture that ignores an equality filter cannot widen the result.
//
// WHAT IS SLOWER: a read walks its whole filtered family — one in-process query per
// page locally, one HTTP request per page against an API, at up to 500 rows a page.
// The `email_id` / `provider_id` / single-`type` filters push down, so the narrow
// reads (a message's events, one provider's events, one webhook's dedup probe) stay
// one page. Past the budget these reads THROW instead of degrading, because the
// alternative is an export that looks complete and is not — the exact defect the
// deleted arm's `complete`-flag-discarding version shipped.

import type { Database } from "./database.js";
import type { EmailEvent, EventFilter, EventSummary, EventType } from "../types/index.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
// Value coercion only. These are pure functions that turn one store's JSON-typed
// column into the other's TEXT-encoded one; the module they live in is named for the
// axis being deleted, and relocating them belongs to that deletion rather than to
// this collapse.
import { cobj, cstr, cstrOrNull } from "./self-hosted-resource.js";
import { enumerateStoreRows, type StoreEnumeration } from "../lib/status-facts-enumeration.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { ListOptions, ResourceRow } from "../store/records.js";
import type { Outcome } from "../store/outcome.js";

export interface CreateEventInput {
  email_id?: string | null;
  provider_id: string;
  provider_event_id?: string | null;
  type: EventType;
  recipient?: string | null;
  metadata?: Record<string, unknown>;
  occurred_at: string;
}

/**
 * What every export accepts as its optional store argument.
 *
 * A UNION RATHER THAN A REPLACEMENT, because `Database` has been the published shape
 * of this parameter for the package's whole 1.x life — several of these exports are
 * on the public entrypoint (src/index.ts), and narrowing a 1.x surface is a breaking
 * change. See `storeFor` for what each arm means.
 */
export type EventStore = EmailStore | Database;

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
 * resolve the configured store and read the wrong installation's events.
 *
 * Built per call rather than at module load, because a contradictory storage
 * configuration is a boot error raised by the resolution and it belongs to the call
 * that needed a store, not to whoever imported this module first.
 */
function storeFor(handle: EventStore | undefined): EmailStore {
  if (handle === undefined) return createConfiguredEmailStore();
  const candidate = (handle ?? {}) as Partial<EmailStore> & Partial<Database>;
  if (typeof candidate.messages === "object" && candidate.messages !== null) return handle as EmailStore;
  if (typeof candidate.query === "function") {
    return createSqliteEmailStore({ database: handle as Database, detail: "caller-supplied database" });
  }
  throw new Error(
    "The events family's optional store argument must be an EmailStore or a bun:sqlite Database; "
      + `received ${handle === null ? "null" : typeof handle}. Passing neither would silently read the `
      + "store this installation is configured with, which is not the one the caller named.",
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

/**
 * Every row the filter admits, or a throw naming why not.
 *
 * WHY A THROW: `rows` coming back short has three unrelated causes — the store
 * refused, the read faulted, or the enumeration ran out of budget — and none of them
 * is "that few events happened". These functions return arrays and objects rather
 * than outcomes, so raising is the only way to keep the three apart from an honestly
 * empty answer. An export built from a short set would look complete and would not
 * be, which is the defect this family's second arm actually shipped.
 */
async function readAll(
  store: EmailStore,
  filters: Record<string, string> | undefined,
  what: string,
): Promise<ResourceRow[]> {
  const enumeration: StoreEnumeration<ResourceRow> = await enumerateStoreRows<ResourceRow>(
    (opts: ListOptions) => store.events.list({ ...opts, ...(filters ? { filters } : {}) }),
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
  if (!enumeration.complete) {
    const cause = enumeration.exhausted
      ? `the ${enumeration.pages}-page enumeration budget ran out before the end of the table`
      : enumeration.duplicates > 0
        ? `${enumeration.duplicates} row(s) came back twice across ${enumeration.pages} page(s), so at least `
          + "that many rows were never seen"
        : `a page did not begin on the row the previous page ended on across ${enumeration.pages} page(s), `
          + "so rows were skipped";
    throw new Error(
      `Refusing to return a partial event list: ${cause}, so the ${enumeration.rows.length} row(s) read while `
        + `trying to ${what} are a LOWER BOUND rather than the whole set — an export or a window taken from `
        + "them would look complete and would not be. Narrow the read with an email_id, provider_id or "
        + "single-type filter (both stores apply those while reading), or read one message's events with "
        + "'emails show <id>'.",
    );
  }
  return enumeration.rows;
}

/** Code-unit order, not `localeCompare` (divergence 5). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The order both deleted arms promised: `occurred_at` descending, with `id` ascending
 * making it total — the service's own declared tiebreak, so against `/v1/events` this
 * sort is a no-op re-statement of the order the rows arrived in.
 */
function byMostRecentRaw(a: ResourceRow, b: ResourceRow): number {
  return (
    compareText(cstr(b["occurred_at"]), cstr(a["occurred_at"]))
    || compareText(cstr(a["id"]), cstr(b["id"]))
  );
}

/**
 * The equality filters both stores apply while reading (a BOUND on the enumeration,
 * never the answer — everything is re-checked in `matchesFilter`). A multi-valued
 * `type` is not expressible as an equality filter and stays client-side; so do
 * `since`/`until`.
 */
function pushedDownFilters(filter: EventFilter): Record<string, string> | undefined {
  const filters: Record<string, string> = {};
  if (filter.email_id) filters["email_id"] = filter.email_id;
  if (filter.provider_id) filters["provider_id"] = filter.provider_id;
  if (typeof filter.type === "string") filters["type"] = filter.type;
  return Object.keys(filters).length > 0 ? filters : undefined;
}

/**
 * Every filter, re-checked on the RAW row (comparisons over raw text, exactly as
 * both stores' own pushed-down filters compare): a store or fixture that ignores an
 * equality filter answers with the unfiltered list, and trusting it would publish
 * another provider's deliveries under this one's export.
 */
function matchesFilter(row: ResourceRow, filter: EventFilter): boolean {
  if (filter.email_id && cstr(row["email_id"]) !== filter.email_id) return false;
  if (filter.provider_id && cstr(row["provider_id"]) !== filter.provider_id) return false;
  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(cstr(row["type"]) as EventType)) return false;
  }
  if (filter.since && cstr(row["occurred_at"]) < filter.since) return false;
  if (filter.until && cstr(row["occurred_at"]) > filter.until) return false;
  return true;
}

/** The caller's window, applied AFTER the whole set is sorted. No limit means every row. */
function windowed<T>(rows: T[], filter: EventFilter): T[] {
  const limit = safeOptionalLimit(filter.limit);
  const offset = safeOffset(filter.offset);
  return limit === null ? rows : rows.slice(offset, offset + limit);
}

// ─── Mapping store rows, AFTER filtering, sorting and windowing ──────────────

/** A timestamp both schemas declare NOT NULL; absence is a projection fault, not "now". */
function requiredTimestamp(row: ResourceRow, key: string): string {
  const value = cstrOrNull(row[key]);
  if (value === null || value === "") {
    throw new Error(
      `This installation's store returned event ${cstr(row["id"]) || "(no id)"} with no ${key}; `
        + "refusing to report the current time in its place",
    );
  }
  return value;
}

function toEvent(row: ResourceRow): EmailEvent {
  return {
    id: cstr(row["id"]),
    email_id: cstrOrNull(row["email_id"]),
    // "" for a null provider_id, preserved (divergence 8): the service schema
    // relaxed the column and the deleted arm coerced it exactly this way.
    provider_id: cstr(row["provider_id"]),
    provider_event_id: cstrOrNull(row["provider_event_id"]),
    // The raw stored text, presented behind the type both arms presented it behind
    // (divergence 8). The SQLite schema CHECKs the set on write; the service schema
    // deliberately does not.
    type: cstr(row["type"]) as EventType,
    recipient: cstrOrNull(row["recipient"]),
    // One store hands JSON text, the other a decoded object; malformed text maps to
    // `{}`, which is what BOTH deleted arms did with it.
    metadata: cobj(row["metadata"]),
    occurred_at: requiredTimestamp(row, "occurred_at"),
    created_at: requiredTimestamp(row, "created_at"),
  };
}

function toEventSummary(event: EmailEvent): EventSummary {
  const { metadata: _metadata, ...summary } = event;
  return summary;
}

/** The whole filtered set: enumerated, re-checked, sorted, windowed — raw. */
async function readFilteredWindow(filter: EventFilter, store: EmailStore, what: string): Promise<ResourceRow[]> {
  const rows = await readAll(store, pushedDownFilters(filter), what);
  return windowed(rows.filter((row) => matchesFilter(row, filter)).sort(byMostRecentRaw), filter);
}

// ─── THE SEVEN OPERATIONS ───────────────────────────────────────────────────

/**
 * Record an event. Only declared columns are sent: no `id` and no `created_at`,
 * because both stores mint the TEXT primary key and stamp their own instant
 * (divergence 3 is what happened when a deleted arm pretended otherwise), and the
 * metadata OBJECT is handed to the seam for the store's own single encoding
 * (divergence 4). The answer is the row THE STORE holds, not an echo of the input.
 */
export async function createEvent(input: CreateEventInput, store?: EventStore): Promise<EmailEvent> {
  const created = required(
    "record a delivery event",
    await storeFor(store).events.create({
      email_id: input.email_id || null,
      provider_id: input.provider_id,
      provider_event_id: input.provider_event_id || null,
      type: input.type,
      recipient: input.recipient || null,
      metadata: input.metadata || {},
      occurred_at: input.occurred_at,
    }),
  );
  return toEvent(created);
}

export async function listEvents(filter: EventFilter = {}, store?: EventStore): Promise<EmailEvent[]> {
  return (await readFilteredWindow(filter, storeFor(store), "list events")).map(toEvent);
}

/**
 * The lean projection: same enumeration, same order, same window, minus `metadata`.
 * The seam's generic list carries no column projection, so the economy the deleted
 * SQLite arm bought with a narrower SELECT is not expressible here; what is preserved
 * is the SHAPE — no metadata payload reaches the caller.
 */
export async function listEventSummaries(filter: EventFilter = {}, store?: EventStore): Promise<EventSummary[]> {
  return (await readFilteredWindow(filter, storeFor(store), "list event summaries"))
    .map((row) => toEventSummary(toEvent(row)));
}

export async function getEvent(id: string, store?: EventStore): Promise<EmailEvent | null> {
  const row = required(`read event ${id}`, await storeFor(store).events.get(id));
  return row === null ? null : toEvent(row);
}

export async function getEventsByEmail(email_id: string, store?: EventStore): Promise<EmailEvent[]> {
  return listEvents({ email_id }, store);
}

export async function upsertEvent(input: CreateEventInput, store?: EventStore): Promise<EmailEvent> {
  return (await upsertEventWithResult(input, store)).event;
}

/**
 * The existing row for one provider event, or null. The two equality filters push
 * down to BOTH stores — an indexed one-page read, not a table walk — and are
 * re-checked on the raw rows. Among duplicates (representable today on the service
 * schema, divergence 2) the winner is deterministic: newest `occurred_at`, then
 * smallest `id` — the deleted second arm's own effective pick.
 *
 * AGAINST A SERVICE THAT DOES NOT DECLARE THE `provider_event_id` FILTER, the HTTP
 * store refuses the list rather than sending a parameter the service would ignore —
 * and that refusal propagates out of the upsert. That is deliberate (divergence 1):
 * an "upsert" that cannot ask whether the event exists is a blind create.
 */
async function findProviderEvent(
  store: EmailStore,
  provider_id: string,
  provider_event_id: string,
): Promise<ResourceRow | null> {
  const rows = await readAll(
    store,
    { provider_id, provider_event_id },
    `look up the existing event for provider event ${provider_event_id}`,
  );
  const matches = rows
    .filter((row) => cstr(row["provider_id"]) === provider_id && cstr(row["provider_event_id"]) === provider_event_id)
    .sort(byMostRecentRaw);
  return matches.length === 0 ? null : (matches[0] as ResourceRow);
}

/**
 * The idempotent upsert keyed on (provider_id, provider_event_id) — the dedup layer
 * #146 documents as load-bearing. Find-first over the whole filtered set (never one
 * clamped page, divergence 1), then create; a `conflict` refusal from the store's
 * own unique key means a concurrent writer won the race between the find and the
 * create, and the winner's row is the answer, `created: false`. Any other refusal
 * throws. An input with no `provider_event_id` has no identity to deduplicate on and
 * is a plain create — both deleted arms' behaviour.
 */
export async function upsertEventWithResult(
  input: CreateEventInput,
  store?: EventStore,
): Promise<{ event: EmailEvent; created: boolean }> {
  const resolved = storeFor(store);
  if (!input.provider_event_id) {
    return { event: await createEvent(input, resolved), created: true };
  }
  const existing = await findProviderEvent(resolved, input.provider_id, input.provider_event_id);
  if (existing !== null) return { event: toEvent(existing), created: false };

  const created = await resolved.events.create({
    email_id: input.email_id || null,
    provider_id: input.provider_id,
    provider_event_id: input.provider_event_id,
    type: input.type,
    recipient: input.recipient || null,
    metadata: input.metadata || {},
    occurred_at: input.occurred_at,
  });
  if (created.ok) return { event: toEvent(created.value), created: true };
  if (created.code === "conflict") {
    const winner = await findProviderEvent(resolved, input.provider_id, input.provider_event_id);
    if (winner !== null) return { event: toEvent(winner), created: false };
    // The store refused the write as a duplicate and then could not show the row it
    // conflicted with. Answering "created" or fabricating an event would both be
    // lies; the store's own refusal is the only honest answer left.
  }
  return { event: required("record a delivery event", created), created: true };
}
