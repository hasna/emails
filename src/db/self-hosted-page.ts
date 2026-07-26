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
   * true  => the enumeration reached a short page, so `rows.length` IS the total.
   * false => the page budget ran out first; `rows.length` is a LOWER BOUND.
   */
  complete: boolean;
  /** Pages actually fetched (for diagnostics / test assertions). */
  pages: number;
}

export interface EnumerateOptions {
  /** Rows per request. Clamped to the server maximum. */
  pageSize?: number;
  /** Maximum pages to fetch before giving up and reporting incompleteness. */
  pageBudget?: number;
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
 * Rows are de-duplicated by `id` because offset paging over a table that is
 * being written to can hand back the same row twice; counting a duplicate would
 * inflate a "real" number, which is the same class of lie as a fabricated zero.
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

  while (pages < budget) {
    const page = store.list({ limit: pageSize, offset });
    pages += 1;
    for (const row of page) {
      const id = row["id"] == null ? null : String(row["id"]);
      if (id !== null) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      rows.push(row);
    }
    if (page.length < pageSize) return { rows, complete: true, pages };
    offset += page.length;
  }

  return { rows, complete: false, pages };
}
