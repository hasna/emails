// Honest bounded enumeration over a `/v1` list route.
//
// WHY: every `/v1` list route is limit/offset only. NOTHING in the API returns a
// total, a has_more, a next cursor or a Link header for providers/domains/
// addresses/sources, and the server clamps every list to at most 500 rows
// (src/server/self-hosted/store.ts clampLimit -> min(max(1, limit), 500),
// default 100). A count taken from ONE list call is therefore a silent lower
// bound capped at 500 — which is exactly how a "total" can quietly become wrong
// the moment a deployment crosses 500 rows.
//
// This module pages until a short page and reports whether it actually reached
// the end (`complete`). A caller that gets `complete: false` MUST publish its
// numbers as lower bounds, never as totals.

import { selfHostedResource } from "./self-hosted-resource.js";

/**
 * Server-side hard cap on any `/v1` list page. Mirrors clampLimit() in
 * src/server/self-hosted/store.ts. Asking for more silently returns 500.
 */
export const SELF_HOSTED_SERVER_PAGE_MAX = 500;

/**
 * Page budget for a single enumeration. 40 * 500 = 20_000 rows, which bounds
 * both wall-clock (each page is a synchronous curl) and memory while staying far
 * above real deployments (production is at 325 addresses / 75 domains).
 */
export const SELF_HOSTED_ENUMERATION_PAGE_BUDGET = 40;

export interface SelfHostedEnumeration {
  rows: Record<string, unknown>[];
  /**
   * true  => the enumeration reached a short page AND the window never shifted,
   *          so `rows.length` IS the total.
   * false => the page budget ran out, or the window shifted under paging;
   *          `rows.length` is a LOWER BOUND.
   */
  complete: boolean;
  /** Pages actually fetched (for diagnostics / test assertions). */
  pages: number;
  /**
   * Rows returned twice across pages. A duplicate PROVES the ordering was not
   * total (or the table was written to mid-enumeration), which means other rows
   * were skipped by the same amount: N duplicates => at least N rows never seen.
   * De-duplicating without saying so turns an inflated count into a silent
   * UNDERcount — see `stable`.
   */
  duplicates: number;
  /**
   * false => `duplicates > 0`, i.e. offset paging did not see a consistent
   * snapshot. The de-duplicated `rows` are a subset of the real table, never the
   * whole of it.
   */
  stable: boolean;
  /** false => the page budget ran out before a short page was reached. */
  exhausted: boolean;
}

export interface EnumerateOptions {
  /** Rows per request. Clamped to the server maximum. */
  pageSize?: number;
  /** Maximum pages to fetch before giving up and reporting incompleteness. */
  pageBudget?: number;
  /**
   * Extra query parameters sent with EVERY page, e.g. a resource's declared
   * server-side filters (`src/server/self-hosted/resources.ts` `filters`).
   * Narrowing the read server-side is what keeps a large table inside the page
   * budget; `limit`/`offset` are owned by the pager and cannot be overridden.
   */
  query?: Record<string, string | number | boolean | undefined>;
}

function clampPageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return SELF_HOSTED_SERVER_PAGE_MAX;
  return Math.min(Math.max(1, Math.floor(value)), SELF_HOSTED_SERVER_PAGE_MAX);
}

function clampBudget(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return SELF_HOSTED_ENUMERATION_PAGE_BUDGET;
  return Math.max(1, Math.floor(value));
}

/**
 * Page `GET /v1/<resource>?limit&offset` until the end or the page budget.
 *
 * Rows are de-duplicated by `id` because offset paging can hand back the same
 * row twice; counting a duplicate would inflate a "real" number, which is the
 * same class of lie as a fabricated zero.
 *
 * DE-DUPLICATION IS NOT A REPAIR. A duplicate means the window moved between
 * requests, which happens when the server's ORDER BY is not a TOTAL order (ties
 * may come back in any order) or when the table is written to mid-enumeration.
 * Whatever position a duplicate row re-occupied, some other row was pushed out
 * of the window and never returned. So `duplicates > 0` means the de-duplicated
 * set is a strict SUBSET of the table, and the enumeration reports
 * `stable: false` / `complete: false` instead of publishing its row count as a
 * total.
 *
 * Measured on production `/v1/sources` (2026-07-26) before the server's ORDER BY
 * was made total: 3899 rows returned across 8 pages, 426 of them duplicates,
 * 3473 distinct — a count that looked authoritative and was 11% low. The true
 * row count (binary search on `?limit=1&offset=N`) was 3899.
 *
 * Throws (SelfHostedHttpError) if the server rejects a page. The caller is
 * expected to catch and report `source_unreachable` rather than substitute a
 * zero.
 */
export function enumerateSelfHostedRows(
  resource: string,
  opts: EnumerateOptions = {},
): SelfHostedEnumeration {
  const store = selfHostedResource(resource);
  const pageSize = clampPageSize(opts.pageSize);
  const budget = clampBudget(opts.pageBudget);
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let pages = 0;
  let duplicates = 0;

  const result = (exhausted: boolean): SelfHostedEnumeration => ({
    rows,
    // A short page alone is NOT completeness: it only proves the last window was
    // partial. Completeness also requires that no window shifted (duplicates).
    complete: !exhausted && duplicates === 0,
    pages,
    duplicates,
    stable: duplicates === 0,
    exhausted,
  });

  while (pages < budget) {
    const page = store.list({ ...opts.query, limit: pageSize, offset });
    pages += 1;
    for (const row of page) {
      const id = row["id"] == null ? null : String(row["id"]);
      if (id !== null) {
        if (seen.has(id)) {
          duplicates += 1;
          continue;
        }
        seen.add(id);
      }
      rows.push(row);
    }
    if (page.length < pageSize) return result(false);
    offset += page.length;
  }

  return result(true);
}
