// Domain warming schedules as ONE implementation over the store seam. Nothing here
// asks where this installation is deployed; the store is resolved from STORAGE
// configuration (src/store-resolution.ts) or handed in by the caller.
//
// WHAT THIS FILE USED TO BE. A facade that read the process-wide deployment word and
// handed FIVE exports to one of two sibling modules: a 95-line SQLite arm and an
// 83-line arm speaking to `/v1` through the legacy blocking bridge. Both are gone.
// Every read and write goes through the seam's own `warming` repository, which both
// shipped stores already carry through the same generic resource path
// (`warming_schedules` in SQLite, `/v1/warming` on the service) — no seam widening
// was needed for this family.
//
// ─── WHAT THE TWO ARMS DID DIFFERENTLY, MEASURED RATHER THAN ASSUMED ─────────────────
//
//  1. EVERY READ IN THE DELETED SECOND ARM ANSWERED OUT OF ONE CLAMPED PAGE. It asked
//     for `{ limit: 1000 }` once and filtered locally; the service clamps a list to
//     500 rows. So with 501+ schedules, `getWarmingSchedule` answered null for a real
//     schedule past the clamp — which made `domain warm` CREATE A SECOND SCHEDULE for
//     an already-warming domain (its duplicate guard is this read), made warm-status/
//     pause/resume/complete/delete answer "not found" for a schedule that exists, and
//     made the SEND GATE (assertWarmingLimit in src/lib/send.local.ts) skip the daily
//     cap entirely — a full-volume send from a mid-ramp domain, presented as
//     compliant. `listWarmingSchedules` returned the clamp as the whole table, with
//     the status filter applied AFTER the truncation. Every read below enumerates the
//     WHOLE filtered set (pushing down the `domain` and `status` filters both stores
//     accept, re-checked client-side) and REFUSES if it could not finish.
//  2. THE TWO STORES ORDER THE TABLE DIFFERENTLY, AND `ListOptions` ADMITS NO
//     ORDERING. The SQLite store's generic list orders by `updated_at DESC, id DESC`
//     (its derived time order), the service by `created_at DESC, id ASC`
//     (src/server/self-hosted/resources.ts). Both DELETED arms promised newest-first
//     by `created_at` — one via SQL with no tiebreaker, one by sorting with
//     `localeCompare`, so the order it presented moved with the machine's locale. And
//     the generic orders diverge OBSERVABLY: a pause or resume touches `updated_at`,
//     which JUMPS the row to the top of the SQLite generic order while the service's
//     order holds still. Every list below sorts the enumerated set itself —
//     `created_at` descending in UTF-16 code-unit order, with the row id making it
//     total — and windows locally, so both stores answer the same question on every
//     machine.
//  3. TIMESTAMPS ARE NOT SENT, AND THE DELETED SECOND ARM ONLY APPEARED TO SEND
//     THEM. It put `created_at`/`updated_at` in every create body, but `/v1/warming`
//     does not declare either column writable, so the service SILENTLY DROPPED both
//     and stamped its own — which is exactly the hazard the real HTTP store's
//     fail-closed contract check refuses a write over. Nothing below names either
//     column: both stores stamp their own ISO instants on create and on update (the
//     SQLite generic path stamps `new Date().toISOString()`, never the column
//     DEFAULT's space-separated format), so `created_at` — the order every listing
//     presents — interleaves correctly with rows the deleted arms wrote.
//  4. `start_date` KEEPS ITS DELIBERATE TOLERANCE. SQLite declares it NOT NULL; the
//     service schema relaxed it to nullable, and the deleted `/v1` arm coerced null
//     to "". `warmingDayIndex` (src/lib/warming.ts) answers null for that "" and
//     `getTodayLimit` FAILS CLOSED on it (limit 0), so tolerating it here is safe and
//     faulting the whole listing over it would lose the schedules the read was for.
//     `created_at` and `updated_at`, by contrast, are NOT NULL on both schemas, so
//     absence there is a projection fault and is reported as one, naming the row —
//     never the current time (the old mappers' coercion dated a row to the moment it
//     was read).
//  5. A STATUS OUTSIDE THE DECLARED SET WAS PUBLISHED BEHIND A TYPE THAT SAYS IT
//     CANNOT BE. The local schema CHECK-constrains status to active/paused/completed;
//     the service schema does not. One arm cast the raw column, the other coerced
//     only empty-to-active, so `status: "bogus"` came through typed as
//     `WarmingSchedule["status"]`. Mapping below FAULTS on it, naming the row and the
//     value — and mapping happens AFTER filtering and AFTER windowing (filters
//     compare raw text, exactly as both stores' own pushed-down filters do), so one
//     bad row faults the read that would actually present it. The empty-to-active
//     coercion is PRESERVED: the service declares the column's default and the
//     deleted arm mapped "" that way — but a status FILTER compares the raw text, so
//     an empty-status row is presented as active and matched by no filter, which is
//     what the server's own `status` filter already does. (The deleted arm disagreed
//     with its own server there: it filtered on the coerced value, over one clamped
//     page.)
//  6. THE DOMAIN IS UNIQUE ON BOTH SHIPPED SCHEMAS, BUT THE SEAM DOES NOT PROMISE IT.
//     A caller-supplied store need not enforce `UNIQUE(domain)`, so duplicates are
//     representable. Among duplicates, the READS resolve deterministically — the
//     NEWEST wins — and the WRITES apply to EVERY row carrying the domain, which is
//     the deleted SQLite arm's own semantics (`UPDATE`/`DELETE ... WHERE domain = ?`
//     touched all matches); the deleted second arm updated or deleted whichever
//     single row a clamped page happened to surface first.
//  7. WHAT BOTH ARMS AGREED ON, PRESERVED: `start_date` defaults to today's UTC
//     calendar date; a new schedule is born `active`; `updateWarmingStatus` answers
//     null and `deleteWarmingSchedule` false for a domain with no schedule; a
//     duplicate CREATE is refused by the store that can see it (both shipped stores
//     hold the unique key — the refusal is typed and surfaced as a throw), and the
//     CLI/MCP surfaces keep their own read-first guard so the operator gets the
//     recovery text instead of a constraint error.
//
// ─── WHAT IS LOST, NAMED RATHER THAN LEFT TO BE DISCOVERED ───────────────────────────
//
//  * THE ATOMIC CONDITIONAL WRITE. `updateWarmingStatus` and `deleteWarmingSchedule`
//    were each ONE statement whose change count WAS the answer; they are now
//    find-then-write, so two racing transitions can both report success. The second
//    arm already had exactly this exposure; closing it needs a conditional write on
//    the seam, which is described here and not added.
//  * SYNCHRONOUS CALLS. Every operation on the seam is async, so all five exports are
//    now async and every consumer awaits them.
//
// WHAT IS SLOWER: a read walks its whole filtered family — one in-process query per
// page locally, one HTTP request per page against an API, at up to 500 rows a page.
// The `domain` and `status` filters push down, so the common reads are one page.
// Bounded rather than open-ended: past the page budget these reads THROW instead of
// degrading, because the alternative is a send cap silently skipped or a truncated
// table published as the whole one.

import type { Database } from "./database.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
// Value coercion only. These are pure functions that turn one store's JSON-typed
// column into the other's TEXT-encoded one; the module they live in is named for the
// axis being deleted, and relocating them belongs to that deletion rather than to
// this collapse.
import { cnum, cstr, cstrOrNull } from "./self-hosted-resource.js";
import { enumerateStoreRows, type StoreEnumeration } from "../lib/status-facts-enumeration.js";
import type { WarmingSchedule } from "../lib/warming.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { ListOptions, ResourceRow } from "../store/records.js";
import type { Outcome } from "../store/outcome.js";

export interface ListWarmingScheduleOptions {
  limit?: number;
  offset?: number;
}

/**
 * What every export accepts as its optional store argument.
 *
 * A UNION RATHER THAN A REPLACEMENT, because `Database` has been the published shape
 * of this parameter for the package's whole 1.x life — these exports are on the
 * public entrypoint (src/index.ts), and narrowing a 1.x surface is a breaking
 * change. See `storeFor` for what each arm means.
 */
export type WarmingStore = EmailStore | Database;

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
 * resolve the configured store and read the wrong installation's schedules.
 *
 * Built per call rather than at module load, because a contradictory storage
 * configuration is a boot error raised by the resolution and it belongs to the call
 * that needed a store, not to whoever imported this module first.
 */
function storeFor(handle: WarmingStore | undefined): EmailStore {
  if (handle === undefined) return createConfiguredEmailStore();
  const candidate = handle as Partial<EmailStore> & Partial<Database>;
  if (typeof candidate.messages === "object" && candidate.messages !== null) return handle as EmailStore;
  if (typeof candidate.query === "function") {
    return createSqliteEmailStore({ database: handle as Database, detail: "caller-supplied database" });
  }
  throw new Error(
    "The warming family's optional store argument must be an EmailStore or a bun:sqlite Database; "
      + `received ${handle === null ? "null" : typeof handle}. Passing neither would silently read the `
      + "store this installation is configured with, which is not the one the caller named.",
  );
}

/**
 * True when the caller's argument is a store rather than options.
 *
 * Needed because the published surface admits TWO parameter orders for the listing
 * export: the deleted SQLite arm took its optional handle BEFORE the options, the
 * deleted facade's compat shim exposed options-first, and the facade's intersection
 * type made both compile for the package's whole 1.x life. Narrowing to one order
 * would break released consumers, so both stay and the argument's SHAPE decides —
 * the same structural question `storeFor` asks, never a label.
 */
function isStoreArgument(value: unknown): value is WarmingStore {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<EmailStore> & Partial<Database>;
  return typeof candidate.query === "function"
    || (typeof candidate.messages === "object" && candidate.messages !== null);
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
 * A schedule's addressable identity: the TEXT `id` both schemas declare as the
 * primary key (and both stores mint). A row carrying neither an `id` nor a projected
 * `rowid` cannot be addressed for a write, and writing to "some row" instead would
 * transition another domain's ramp.
 */
function scheduleIdentityOf(row: ResourceRow): string {
  const id = cstrOrNull(row["id"]) ?? cstrOrNull(row["rowid"]);
  if (id === null || id === "") {
    throw new Error(
      `This installation's store returned a warming schedule for ${cstr(row["domain"]) || "(no domain)"} `
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
 * is "that few domains are warming". These functions return arrays and scalars
 * rather than outcomes, so raising is the only way to keep the three apart from an
 * honestly empty answer.
 */
async function readAll(
  store: EmailStore,
  filters: Record<string, string> | undefined,
  what: string,
): Promise<ResourceRow[]> {
  const enumeration: StoreEnumeration<ResourceRow> = await enumerateStoreRows<ResourceRow>(
    (opts: ListOptions) => store.warming.list({ ...opts, ...(filters ? { filters } : {}) }),
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
      `Refusing to ${what}: ${cause}, so the ${enumeration.rows.length} row(s) read are a LOWER BOUND `
        + "rather than the whole set — and a send cap, a duplicate check or a listing taken from a "
        + "partial read is silently wrong. Narrow the read or retry.",
    );
  }
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

/** The caller's window, applied AFTER the whole set is sorted. No limit means every row. */
function windowed<T>(rows: T[], opts: { limit?: number; offset?: number } | undefined): T[] {
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  return limit === null ? rows : rows.slice(offset, offset + limit);
}

/**
 * Every schedule row carrying `domain`, raw and sorted newest-first. The filter is
 * pushed down (the column exists locally and `/v1/warming` declares the filter) and
 * RE-CHECKED on the raw row: a store or fixture that ignores an equality filter
 * answers with the unfiltered list, and trusting it would gate one domain's sends on
 * another domain's ramp.
 */
async function readDomainRowsRaw(store: EmailStore, domain: string, what: string): Promise<ResourceRow[]> {
  const rows = await readAll(store, { domain }, what);
  return rows.filter((row) => cstr(row["domain"]) === domain).sort(byNewestRaw);
}

// ─── Mapping store rows, AFTER filtering and windowing ──────────────────────

/** A timestamp both schemas declare NOT NULL; absence is a projection fault, not "now". */
function requiredTimestamp(row: ResourceRow, key: string): string {
  const value = cstrOrNull(row[key]);
  if (value === null || value === "") {
    throw new Error(
      `This installation's store returned warming schedule ${cstr(row["id"]) || cstr(row["domain"]) || "(no id)"} `
        + `with no ${key}; refusing to report the current time in its place`,
    );
  }
  return value;
}

const WARMING_STATUSES: ReadonlySet<string> = new Set(["active", "paused", "completed"]);

/**
 * The declared status set, enforced at the boundary (divergence 5). Empty means the
 * column's declared default, `active`; anything else outside the set is a fault
 * naming the row and the value, never a cast.
 */
function statusOf(row: ResourceRow): WarmingSchedule["status"] {
  const raw = cstr(row["status"]);
  if (raw === "") return "active";
  if (!WARMING_STATUSES.has(raw)) {
    throw new Error(
      `This installation's store returned warming schedule ${cstr(row["id"]) || cstr(row["domain"]) || "(no id)"} `
        + `with status ${JSON.stringify(raw)}, which is outside the declared set `
        + "(active, paused, completed); refusing to present it as one of them",
    );
  }
  return raw as WarmingSchedule["status"];
}

function toSchedule(row: ResourceRow): WarmingSchedule {
  return {
    id: cstr(row["id"]),
    domain: cstr(row["domain"]),
    provider_id: cstrOrNull(row["provider_id"]),
    target_daily_volume: cnum(row["target_daily_volume"]),
    // "" for a null start date, preserved (divergence 4): the ramp math fails
    // closed on it rather than this mapper faulting the whole listing.
    start_date: cstr(row["start_date"]),
    status: statusOf(row),
    created_at: requiredTimestamp(row, "created_at"),
    updated_at: requiredTimestamp(row, "updated_at"),
  };
}

// ─── THE FIVE OPERATIONS ────────────────────────────────────────────────────

/**
 * Create a schedule. `start_date` defaults to today's UTC calendar date and the row
 * is born `active` (divergence 7). No id and no timestamps are sent — both stores
 * mint the TEXT primary key and stamp their own instants (divergence 3). A store
 * that can see the domain's unique key refuses a duplicate with its own typed
 * refusal, surfaced as a throw.
 */
export async function createWarmingSchedule(
  input: {
    domain: string;
    provider_id?: string;
    target_daily_volume: number;
    start_date?: string;
  },
  store?: WarmingStore,
): Promise<WarmingSchedule> {
  const created = required(
    "create a warming schedule",
    await storeFor(store).warming.create({
      domain: input.domain,
      provider_id: input.provider_id ?? null,
      target_daily_volume: input.target_daily_volume,
      start_date: input.start_date ?? new Date().toISOString().slice(0, 10),
      status: "active",
    }),
  );
  return toSchedule(created);
}

/**
 * The schedule for one domain, or null. This enumerates the pushed-down `domain`
 * filter to the END: the deleted second arm's one-page scan answered null for a real
 * schedule past the clamp (divergence 1), which skipped the send cap and let `warm`
 * create a duplicate. Among duplicates (reachable only through a store without the
 * unique key both shipped stores carry) the NEWEST wins, deterministically
 * (divergence 6).
 */
export async function getWarmingSchedule(domain: string, store?: WarmingStore): Promise<WarmingSchedule | null> {
  const rows = await readDomainRowsRaw(storeFor(store), domain, `read the warming schedule for ${domain}`);
  return rows.length === 0 ? null : toSchedule(rows[0] as ResourceRow);
}

export async function listWarmingSchedules(
  status?: string,
  opts?: ListWarmingScheduleOptions,
  store?: WarmingStore,
): Promise<WarmingSchedule[]>;
export async function listWarmingSchedules(
  status: string | undefined,
  store: WarmingStore | undefined,
  opts?: ListWarmingScheduleOptions,
): Promise<WarmingSchedule[]>;
export async function listWarmingSchedules(
  status?: string,
  second?: ListWarmingScheduleOptions | WarmingStore,
  third?: WarmingStore | ListWarmingScheduleOptions,
): Promise<WarmingSchedule[]> {
  // Both published argument orders stay callable (see `isStoreArgument`), including
  // the deleted SQLite arm's `(status, undefined, opts)` — this repo's own REST
  // routes called it that way until this collapse.
  const store = isStoreArgument(second) ? second : isStoreArgument(third) ? third : undefined;
  const opts = isStoreArgument(second)
    ? (third as ListWarmingScheduleOptions | undefined)
    : (second as ListWarmingScheduleOptions | undefined) ?? (third as ListWarmingScheduleOptions | undefined);
  const rows = await readAll(
    storeFor(store),
    status === undefined || status === "" ? undefined : { status },
    "list warming schedules",
  );
  // The re-check compares RAW text, exactly as both stores' own pushed-down filters
  // do (divergence 5's filter note).
  const admitted = status === undefined || status === ""
    ? rows
    : rows.filter((row) => cstr(row["status"]) === status);
  return windowed(admitted.sort(byNewestRaw), opts).map(toSchedule);
}

/**
 * Transition a domain's schedule; null when it has none. The write applies to EVERY
 * row carrying the domain — the deleted SQLite arm's own `WHERE domain = ?`
 * semantics (divergence 6) — and the answer is the newest surviving row. The patch
 * names only `status`: both stores stamp `updated_at` themselves (divergence 3).
 */
export async function updateWarmingStatus(
  domain: string,
  status: "active" | "paused" | "completed",
  store?: WarmingStore,
): Promise<WarmingSchedule | null> {
  const resolved = storeFor(store);
  const rows = await readDomainRowsRaw(resolved, domain, `find the warming schedule for ${domain}`);
  if (rows.length === 0) return null;
  const patch = { status };
  let newest: ResourceRow | null = null;
  for (const row of rows) {
    const updated = required(
      "update a warming schedule",
      await resolved.warming.update(scheduleIdentityOf(row), patch),
    );
    // A row that vanished between the read and the write contributes nothing; the
    // remaining rows still carry the transition.
    if (updated !== null && newest === null) newest = updated;
  }
  return newest === null ? null : toSchedule(newest);
}

/**
 * Delete a domain's schedule(s); false when there was none — including when every
 * found row vanished before the write, which is the deleted arms' own answer (their
 * change count was zero). Applies to every row carrying the domain (divergence 6).
 */
export async function deleteWarmingSchedule(domain: string, store?: WarmingStore): Promise<boolean> {
  const resolved = storeFor(store);
  const rows = await readDomainRowsRaw(resolved, domain, `find the warming schedule for ${domain}`);
  let removed = false;
  for (const row of rows) {
    if (required("delete a warming schedule", await resolved.warming.remove(scheduleIdentityOf(row)))) {
      removed = true;
    }
  }
  return removed;
}
