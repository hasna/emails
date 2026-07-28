// Honest bounded enumeration over a store list operation.
//
// WHY THIS EXISTS. The store seam (src/store/repositories.ts) publishes list
// operations and NOT ONE aggregate: there is no `countDomains`, no
// `countAddresses`, no server-supplied total, no `has_more`, no page cursor on the
// uniform families. Both implementations clamp a list page to 500 rows
// (src/store-sqlite/resources.ts MAX_PAGE, src/store-http/registry.ts MAX_PAGE,
// and the service clamps again). So a count taken from ONE list call is a silent
// lower bound capped at 500, and a status payload that publishes it as a total
// goes wrong the moment an installation crosses 500 rows.
//
// This module pages to an EMPTY page — never merely a short one, because a clamped
// page is indistinguishable from the last page of a small table — and reports whether
// it actually reached the end. A caller that gets `complete: false` MUST publish its
// numbers as lower bounds, never as totals; and a caller that gets a refusal or a
// fault MUST publish nothing at all, because `rows` is then `[]` for a reason that has
// nothing to do with how many rows exist.
//
// THE THREE ANSWERS ARE KEPT APART ON PURPOSE, because collapsing any two of them
// is the defect this whole status surface exists to remove:
//
//   refused   the store declared it cannot do this (a typed Outcome refusal).
//             `rows` is empty because nothing was read.
//   faulted   the read threw (transport, malformed stored data).
//             `rows` is empty because nothing was read.
//   answered  rows were read. `complete` then says whether they are ALL of them.
//
// This is the store-seam counterpart of src/db/self-hosted-page.ts, and the
// duplicate/shift accounting below is taken from it deliberately rather than
// reinvented: that module's header records a production measurement — 3899 rows
// returned across 8 pages, 426 of them duplicates, 3473 distinct published as an
// authoritative total that was 11% low. The same failure is reachable through any
// limit/offset list, so the same evidence is required here.

import type { Outcome, Refusal } from "../store/outcome.js";

/**
 * Rows per request. Both store implementations clamp a page to 500, so asking for more
 * only wastes the difference. It is a CAP on what this pager requests and never an
 * assumption about what comes back — a store that serves fewer is handled by the
 * end-of-table rule, not by this constant.
 */
export const STORE_LIST_PAGE_MAX = 500;

/**
 * Pages one enumeration may fetch. 40 * 500 = 20_000 rows, which bounds wall-clock
 * and memory while staying far above real installations (the largest recorded here
 * is 325 addresses / 75 domains). Running out is reported, never hidden.
 */
export const STORE_ENUMERATION_PAGE_BUDGET = 40;

/** One page read. `limit` and `offset` are owned by the pager, never by a caller. */
export type StoreListPage<TRow> = (opts: { limit: number; offset: number }) => Promise<Outcome<TRow[]>>;

export interface StoreEnumeration<TRow> {
  rows: TRow[];
  /**
   * The store's typed refusal, or null. Non-null means `rows` is empty because the
   * store said no — not because the table is empty.
   */
  refusal: Refusal | null;
  /** A thrown fault's message, or null. Same warning as `refusal`. */
  fault: string | null;
  /**
   * true  => an EMPTY page was reached AND the window never moved, so `rows.length`
   *          IS the total.
   * false => the page budget ran out, the window shifted, or the read never
   *          happened; `rows.length` is a LOWER BOUND at best.
   */
  complete: boolean;
  /**
   * false => the window moved under paging (`duplicates > 0` or `shifted`), so the
   * rows are a strict subset of the table rather than the whole of it.
   */
  stable: boolean;
  /** Pages actually fetched. */
  pages: number;
  /**
   * Rows returned twice across pages. A duplicate PROVES the ordering was not total
   * (or the table was written to mid-enumeration), so N duplicates means at least N
   * rows were never seen. De-duplicating without saying so turns an inflated count
   * into a silent undercount.
   */
  duplicates: number;
  /**
   * true => a page did not begin on the row the previous page ended on, which proves
   * the window moved. `duplicates` alone only catches a row inserted ABOVE the
   * cursor; a row DELETED above it slides every unread row down one offset and is
   * never seen again, producing no duplicate at all.
   */
  shifted: boolean;
  /** true => the page budget ran out before the end of the table was reached. */
  exhausted: boolean;
}

export interface EnumerateStoreOptions<TRow> {
  pageSize?: number;
  pageBudget?: number;
  /**
   * The row's identity, used for duplicate and shift accounting. REQUIRED rather
   * than guessed: a row shape whose id lives under another key would silently lose
   * both checks, and losing them is invisible — every count would still look exact.
   */
  idOf: (row: TRow) => string | null;
}

function clampPageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return STORE_LIST_PAGE_MAX;
  return Math.min(Math.max(1, Math.floor(value)), STORE_LIST_PAGE_MAX);
}

function clampBudget(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return STORE_ENUMERATION_PAGE_BUDGET;
  return Math.max(1, Math.floor(value));
}

function faultMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Page a store list operation to the end of the table, or report why not.
 *
 * ANCHORING. Every page after the first re-requests the last row already read and
 * requires it back. Offset paging has no other way to notice that rows MOVED, and
 * both directions matter: an insertion above the cursor shows up as a duplicate, a
 * deletion above the cursor silently skips a row and produces none. Once a shift is
 * proven, anchoring stops — the read is already known unstable, and continuing as a
 * plain pager keeps `duplicates` meaning what it always meant.
 */
export async function enumerateStoreRows<TRow>(
  read: StoreListPage<TRow>,
  options: EnumerateStoreOptions<TRow>,
): Promise<StoreEnumeration<TRow>> {
  const pageSize = clampPageSize(options.pageSize);
  const budget = clampBudget(options.pageBudget);
  const idOf = options.idOf;
  const rows: TRow[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let pages = 0;
  let duplicates = 0;
  let anchorId: string | null = null;
  let shifted = false;
  let reachedEnd = false;
  let refusal: Refusal | null = null;
  let fault: string | null = null;

  while (pages < budget) {
    const anchored = anchorId !== null && !shifted;
    // The anchor row costs one row of the page's capacity: the request still asks
    // for `pageSize` rows, but one of them is a row already held.
    const requestOffset = anchored ? offset - 1 : offset;
    // `pageSize` is the CAP this pager asks for, never an assumption about what comes
    // back. A store is free to serve fewer; see the end-of-table note below for why
    // that is not read as the end.
    const requestLimit = pageSize;

    let outcome: Outcome<TRow[]>;
    try {
      outcome = await read({ limit: requestLimit, offset: requestOffset });
    } catch (error) {
      fault = faultMessage(error);
      break;
    }
    pages += 1;
    if (!outcome.ok) {
      refusal = outcome;
      break;
    }
    const page = outcome.value;

    let fresh = page;
    if (anchored) {
      const firstId = page.length > 0 ? idOf(page[0] as TRow) : null;
      if (firstId !== null && firstId === anchorId) {
        fresh = page.slice(1);
      } else {
        // The window moved. Keep the whole page — none of it is the anchor — and
        // carry on unanchored.
        shifted = true;
        offset = requestOffset;
      }
    }

    for (const row of fresh) {
      const id = idOf(row);
      if (id !== null) {
        if (seen.has(id)) {
          duplicates += 1;
          continue;
        }
        seen.add(id);
      }
      rows.push(row);
    }

    const lastRow = fresh.length > 0 ? fresh[fresh.length - 1] : undefined;
    anchorId = lastRow === undefined ? null : idOf(lastRow);

    // THE END OF THE TABLE IS AN EMPTY PAGE, NOT A SHORT ONE, and the difference is a
    // real hole rather than a stylistic one.
    //
    // Every list route in this system CLAMPS `limit`, and a clamped page is
    // byte-for-byte indistinguishable from the last page of a small table. So "shorter
    // than I asked for" proves nothing: a store that quietly served 200 rows for a
    // 500-row request would have had its FIRST page published as a complete total,
    // with `complete: true` and no `≥` anywhere — the exact class of measurement that
    // cannot detect what it claims. Neither store does that today, which is precisely
    // why no test would have caught it; the sibling defect where a stub served a route
    // without the clamp its own generic handler applies is the same shape.
    //
    // Requiring an EMPTY page costs exactly one extra request per enumeration and
    // removes the assumption entirely. An anchored request that comes back holding
    // only the anchor row yields no fresh rows, which is that same signal.
    if (fresh.length === 0) {
      reachedEnd = true;
      break;
    }
    offset += fresh.length;
  }

  const answered = refusal === null && fault === null;
  const stable = answered && duplicates === 0 && !shifted;
  // Reaching the end alone is NOT completeness: it only proves the last window came
  // back empty. Completeness also requires that the window never moved.
  const complete = answered && reachedEnd && stable;
  const exhausted = answered && !reachedEnd;
  return { rows, refusal, fault, complete, stable, pages, duplicates, shifted, exhausted };
}

// ─── THE CURSOR PAGER ────────────────────────────────────────────────────────────
//
// `enumerateStoreRows` above is the OFFSET pager, and it exists because the uniform
// families' `ListOptions` carries nothing else. The message families are different:
// `MessagesRepository.listMessages` returns a `Page<T>` whose `next_cursor` is
// documented on the seam as "null exactly when this page is the last"
// (src/store/records.ts), and both implementations answer it from their own row count
// against their own clamped limit — SQLite from the query it just ran
// (src/store-sqlite/messages.ts), the API store from the service's `next_cursor`
// (src/store-http/messages.ts). So for those families the STORE states the end of the
// table instead of this client inferring it from an empty page, which is strictly
// stronger evidence.
//
// WHAT IS STILL NOT AN END SIGNAL: the LENGTH of a page. Every list route here clamps
// `limit`, so a short page is byte-for-byte indistinguishable from the last page of a
// small table. Nothing below reads `items.length` to decide it has finished — only
// `next_cursor === null` does. The two anti-stall checks are guards against a store
// that contradicts its own contract (a non-null cursor with no rows, or a cursor that
// does not advance) and both leave the enumeration INCOMPLETE rather than calling it
// the end.
//
// This lives beside the offset pager rather than in one of its callers because the
// honesty rules are identical and there is no reason for two copies of them to drift.

/** One keyset page read. `limit` and `cursor` are owned by the pager, never by a caller. */
export type StoreCursorPage<TRow> = (opts: {
  limit: number;
  cursor?: string;
}) => Promise<Outcome<{ items: TRow[]; next_cursor: string | null }>>;

export interface StoreCursorEnumeration<TRow> {
  /** Distinct rows, in the order the store served them. */
  rows: TRow[];
  /** The store's typed refusal, or null. Non-null means `rows` is empty because the
   * store said no — not because the stream is empty. */
  refusal: Refusal | null;
  /** A thrown fault's message, or null. Same warning as `refusal`. */
  fault: string | null;
  /**
   * true  => the store reported the last page AND no row came back twice, so
   *          `rows` IS the whole filtered stream.
   * false => the budget ran out, the store stalled, a row repeated, or the read never
   *          happened; `rows` is a LOWER BOUND at best.
   */
  complete: boolean;
  /** Pages actually fetched. */
  pages: number;
  /**
   * Rows returned twice across pages. A keyset page is supposed to come from a TOTAL
   * order, so a repeat proves it was not — which means rows were skipped as well.
   * De-duplicating without saying so turns an inflated count into a silent undercount.
   */
  duplicates: number;
  /** true => the store handed back a non-null cursor it could not advance past. */
  stalled: boolean;
  /** true => the page budget ran out before the store reported the last page. */
  exhausted: boolean;
}

export interface EnumerateCursorOptions<TRow> {
  pageSize?: number;
  pageBudget?: number;
  /**
   * The row's identity, used for duplicate accounting. REQUIRED rather than guessed,
   * for the same reason `enumerateStoreRows` requires it: a row shape whose id lives
   * under another key would lose the check silently, and every count would still look
   * exact.
   */
  idOf: (row: TRow) => string;
}

function clampCursorPageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return STORE_LIST_PAGE_MAX;
  return Math.min(Math.max(1, Math.floor(value)), STORE_LIST_PAGE_MAX);
}

function clampCursorBudget(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return STORE_ENUMERATION_PAGE_BUDGET;
  return Math.max(1, Math.floor(value));
}

/** Page a keyset list to the end of the stream, or report why not. */
export async function enumerateStorePages<TRow>(
  read: StoreCursorPage<TRow>,
  options: EnumerateCursorOptions<TRow>,
): Promise<StoreCursorEnumeration<TRow>> {
  const pageSize = clampCursorPageSize(options.pageSize);
  const budget = clampCursorBudget(options.pageBudget);
  const idOf = options.idOf;
  const rows: TRow[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let duplicates = 0;
  let stalled = false;
  let reachedEnd = false;
  let refusal: Refusal | null = null;
  let fault: string | null = null;

  while (pages < budget) {
    let outcome: Outcome<{ items: TRow[]; next_cursor: string | null }>;
    try {
      outcome = await read({ limit: pageSize, ...(cursor === undefined ? {} : { cursor }) });
    } catch (error) {
      fault = faultMessage(error);
      break;
    }
    pages += 1;
    if (!outcome.ok) {
      refusal = outcome;
      break;
    }
    const page = outcome.value;
    for (const row of page.items) {
      const id = idOf(row);
      if (seen.has(id)) {
        duplicates += 1;
        continue;
      }
      seen.add(id);
      rows.push(row);
    }
    if (page.next_cursor === null) {
      reachedEnd = true;
      break;
    }
    // ANTI-STALL. A non-null cursor with no rows, or a cursor identical to the one just
    // sent, means the store cannot advance. Breaking here leaves `reachedEnd` false, so
    // the read is reported INCOMPLETE rather than as the end of the stream.
    if (page.items.length === 0 || page.next_cursor === cursor) {
      stalled = true;
      break;
    }
    cursor = page.next_cursor;
  }

  const answered = refusal === null && fault === null;
  // Reaching the end alone is not completeness: a duplicate proves rows were skipped.
  const complete = answered && reachedEnd && duplicates === 0;
  return {
    rows,
    refusal,
    fault,
    complete,
    pages,
    duplicates,
    stalled: answered && stalled,
    exhausted: answered && !reachedEnd && !stalled,
  };
}
