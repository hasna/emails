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
