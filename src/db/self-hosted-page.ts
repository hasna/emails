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
import type { SelfHostedResourceStore } from "./self-hosted-store.js";

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

export interface SelfHostedEnumeration<T = Record<string, unknown>> {
  rows: T[];
  /**
   * true  => the enumeration reached a short page AND the window never shifted,
   *          so `rows.length` IS the total.
   * false => the page budget ran out, the window shifted under paging, or the
   *          read stopped early because its `need` was met; `rows.length` is a
   *          LOWER BOUND.
   *
   * `complete` answers "is this the WHOLE set?" and nothing else. A bounded read
   * that filled its window is NOT complete — see `filled`, and never conflate the
   * two: that conflation is how a page count gets published as a total.
   */
  complete: boolean;
  /**
   * true => a `need` was requested and `rows.length` reached it, so the window the
   *         caller asked for is genuinely FULL. This is completeness *for that
   *         bound* — "the first N" really is N rows — and is the only honest way to
   *         answer a bounded read of a table too large to enumerate.
   * false => no `need` was requested, or the read stopped short of it.
   */
  filled: boolean;
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
   * true => a page did not begin on the row the previous page ended on, which
   *         PROVES the window moved between requests.
   *
   * `duplicates` alone only catches the window moving BACKWARD (a row inserted
   * above the cursor re-appears). A row DELETED above the cursor moves the window
   * FORWARD: every unread row slides to a lower offset, the next page starts one row
   * late, and the skipped row is never seen by anything — no duplicate is ever
   * produced. Anchoring each page on a row already read catches both directions.
   */
  shifted: boolean;
  /**
   * false => the window moved under paging (`duplicates > 0` or `shifted`), so
   * offset paging did not see a consistent snapshot. The rows are a subset of the
   * real table, never the whole of it.
   */
  stable: boolean;
  /**
   * true => the page budget ran out before either a short page or `need` was
   *         reached, so the read gave up mid-table.
   * false => the read ended on its own terms (end of table, or window filled).
   */
  exhausted: boolean;
}

export interface EnumerateOptions<T = Record<string, unknown>> {
  /** Rows per request. Clamped to the server maximum. */
  pageSize?: number;
  /**
   * Maximum pages to fetch before giving up and reporting incompleteness. A `need`
   * that cannot be filled inside the budget comes back unfilled rather than
   * overrunning it — the budget bounds this read no matter what was asked for.
   */
  pageBudget?: number;
  /**
   * Extra query parameters sent with EVERY page, e.g. a resource's declared
   * server-side filters (`src/server/self-hosted/resources.ts` `filters`).
   * Narrowing the read server-side is what keeps a large table inside the page
   * budget; `limit`/`offset` are owned by the pager and cannot be overridden.
   */
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * BOUNDED read: stop as soon as this many rows have been collected, and report
   * `filled: true`. This is what lets a caller who asked for "the first N" be
   * served from a table too large to enumerate: the answer is complete FOR THAT
   * BOUND, so it is not a truncation and must not be refused as one.
   *
   * It is not a shortcut around the completeness guard. An unbounded caller passes
   * no `need` and still gets `complete: false` on a table it cannot walk.
   *
   * `need` is the window's far EDGE (`offset + limit`), not the page size: the
   * caller windows locally after `select`, so it needs every row up to the end of
   * its window. Requests are still capped at the server's per-page maximum and
   * paged, so a window past row 500 is FILLED rather than silently short — the
   * page cap is the pager's business, never the caller's.
   */
  need?: number;
  /**
   * Map + filter each raw row in ONE pass. Returning `null` drops the row: it is
   * not collected and does not count toward `need`, but it is still counted as
   * consumed for offset and duplicate accounting (a dropped row was really there).
   *
   * A caller with filters the server does not apply MUST use this rather than
   * filtering the result afterwards. Post-filtering a bounded read under-fills the
   * window — it stops counting at N rows read instead of N rows kept — which is
   * the same silent shortfall the completeness guard exists to prevent.
   */
  select?: (row: Record<string, unknown>) => T | null;
}

function clampPageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return SELF_HOSTED_SERVER_PAGE_MAX;
  return Math.min(Math.max(1, Math.floor(value)), SELF_HOSTED_SERVER_PAGE_MAX);
}

/**
 * Pages this read may fetch. An explicit `pageBudget` is honored as given; otherwise
 * the default applies.
 *
 * The budget is deliberately NOT raised to cover a wide `need`. It already reaches
 * 20_000 rows, past every limit a caller can ask for, so the only windows it cannot
 * reach are deep-OFFSET ones — and those are exactly the reads that should refuse.
 * `offset` is unbounded at several entry points, so scaling the budget with
 * `offset + limit` would let one request drive millions of synchronous page fetches
 * (the server caps `offset` at 100_000 anyway, so the pages past that could not even
 * return new rows). Deep paging belongs to cursors; an unreachable window gets an
 * honest refusal instead of a self-inflicted stall.
 */
function clampBudget(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return SELF_HOSTED_ENUMERATION_PAGE_BUDGET;
  return Math.max(1, Math.floor(value));
}

/** `null` => unbounded ("everything"), which is NOT the same as a bound of 0. */
function clampNeed(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
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
 *
 * A `need` makes the read BOUNDED: it stops once the window is full and reports
 * `filled`, which is how "give me the first N" is served from a table nobody can
 * enumerate. `complete` still means "this is the whole set" and is never set by a
 * bounded stop, so the two answers can never be mistaken for each other.
 */
export function enumerateSelfHostedRows<T = Record<string, unknown>>(
  resource: string | SelfHostedResourceStore,
  opts: EnumerateOptions<T> = {},
): SelfHostedEnumeration<T> {
  // Accept a resource name OR an already-resolved store. A caller that reads one
  // resource across several filtered lookups can construct the store once and name
  // it at each site, rather than re-resolving it from a string inside every call.
  const store = typeof resource === "string" ? selfHostedResource(resource) : resource;
  const pageSize = clampPageSize(opts.pageSize);
  const need = clampNeed(opts.need);
  const select = opts.select;
  const budget = clampBudget(opts.pageBudget);
  const rows: T[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let pages = 0;
  let duplicates = 0;
  /** Id of the last row read, re-requested to prove the next page did not move. */
  let anchorId: string | null = null;
  let shifted = false;
  /** Raw rows the server has handed over, including duplicates and dropped rows. */
  let consumed = 0;
  // Proven by a SHORT page: the server had no more rows to give. This is the only
  // evidence of the end of the table, and it is tracked separately from the loop
  // exit because a bounded read also exits early WITHOUT reaching the end.
  let reachedEnd = false;

  const windowFull = (): boolean => need !== null && rows.length >= need;

  /**
   * How many rows to ask the server for next.
   *
   * An unbounded read always takes a full page. A bounded read asks for what the
   * window still needs, SCALED by how many rows have been dropped so far: a filter
   * the server does not apply means the window needs more raw rows than it keeps,
   * and asking for exactly the shortfall would crawl toward it a few rows at a
   * time. Every request is still capped at the server's page maximum, so the cap
   * costs extra pages, never missing rows.
   */
  const nextRequestSize = (): number => {
    if (need === null) return pageSize;
    const remaining = need - rows.length;
    // Rows came back but none were kept, so there is no ratio to scale by: read at
    // full speed rather than inching forward on no evidence.
    if (rows.length === 0) return consumed > 0 ? pageSize : Math.min(pageSize, remaining);
    return Math.min(pageSize, Math.max(1, Math.ceil((remaining * consumed) / rows.length)));
  };

  while (pages < budget && !windowFull()) {
    // Anchor every page after the first on the last row already read: ask for it
    // again and require it back. Offset paging has no other way to notice that rows
    // MOVED — a row inserted above the cursor shows up twice (a duplicate) but a row
    // DELETED above the cursor silently skips one, and no duplicate ever appears. Once
    // a shift is proven, anchoring stops: the read is already unstable, and continuing
    // exactly as an unanchored pager would keeps `duplicates` meaning what it always
    // meant. The anchor row costs one row of each page's capacity, so ask for one
    // fewer — a request over the server's page cap would be clamped, and a clamped
    // page looks exactly like the end of the table.
    const anchored = anchorId !== null && !shifted;
    const wanted = Math.min(nextRequestSize(), anchored ? pageSize - 1 : pageSize);
    const requestOffset = anchored ? offset - 1 : offset;
    const requestLimit = anchored ? wanted + 1 : wanted;
    const page = store.list({ ...opts.query, limit: requestLimit, offset: requestOffset });
    pages += 1;

    let fresh = page;
    if (anchored) {
      const firstId = page.length > 0 && page[0]!["id"] != null ? String(page[0]!["id"]) : null;
      if (firstId === anchorId) {
        fresh = page.slice(1);
      } else {
        // The window moved. Keep the whole page (none of it is the anchor) and carry
        // on unanchored so the rest of the read behaves as it always did.
        shifted = true;
        offset = requestOffset;
      }
    }

    consumed += fresh.length;
    for (const row of fresh) {
      const id = row["id"] == null ? null : String(row["id"]);
      if (id !== null) {
        if (seen.has(id)) {
          duplicates += 1;
          continue;
        }
        seen.add(id);
      }
      // A row the caller drops was still really there, so it stays counted for
      // offset and duplicate accounting; it just does not fill the window.
      const selected = select ? select(row) : (row as unknown as T);
      if (selected === null) continue;
      rows.push(selected);
    }

    // Anchor the next page on the last row this one actually returned. A row with no
    // id cannot be anchored on (nothing to match), so the read falls back to plain
    // offset paging — the same blind spot de-duplication already has there.
    const lastRow = fresh.length > 0 ? fresh[fresh.length - 1] : undefined;
    anchorId = lastRow && lastRow["id"] != null ? String(lastRow["id"]) : null;

    // A page shorter than what we ASKED for (not than the page cap) is the end.
    if (page.length < requestLimit) {
      reachedEnd = true;
      break;
    }
    offset += fresh.length;
  }

  const filled = windowFull();
  const stable = duplicates === 0 && !shifted;
  return {
    rows,
    // A short page alone is NOT completeness: it only proves the last window was
    // partial. Completeness also requires that the window never moved.
    // A bounded stop is deliberately excluded — `filled`, not `complete`.
    complete: reachedEnd && stable,
    filled,
    pages,
    duplicates,
    shifted,
    stable,
    // The budget ran out only if the read neither reached the end nor filled its
    // window; stopping on a satisfied bound is not exhaustion.
    exhausted: !reachedEnd && !filled,
  };
}

/**
 * Refuse a read that can neither prove it is whole nor prove it filled the window
 * it was asked for.
 *
 * WHY THIS EXISTS, and why it is shared rather than re-written per repository.
 * `selfHostedListQuery` asks for `max(1000, limit + offset)` rows in ONE request
 * and sends no server-side offset, then windows the result locally. The server
 * clamps every list to SELF_HOSTED_SERVER_PAGE_MAX (see
 * src/server/self-hosted/store.ts clampLimit), so that helper can never see past
 * row 500: a 600-row table answered `--limit 600` with 500 rows and exit 0, and
 * answered `--offset 500` with an EMPTY list indistinguishable from "nothing
 * here". Both were reproduced against the real service on Postgres. A caller
 * cannot tell either outcome from the truth, which is the same defect class as
 * publishing a page count as a total.
 *
 * The contract was established by the events family's deleted `/v1` arm (that
 * family has since collapsed onto the store seam and no longer reads through this
 * module; the remaining `*.remote.ts` arms below do):
 *   UNBOUNDED ("give me everything") is answerable only by a complete enumeration.
 *   BOUNDED ("give me the first N") is answered when the window is FULL, or when
 *   the table ended first — then the short result is genuinely the whole tail.
 * It is still refused when the read could neither fill the window nor reach the
 * end, and when the window MOVED while it was being filled (`stable`), because a
 * full window assembled out of a moving one is missing rows it will never mention.
 *
 * Note the bounded half depends on trusting the SERVER's declared ordering to hand
 * the window over directly. The seam-side pager (src/lib/status-facts-enumeration.ts)
 * deliberately does NOT inherit it, because the seam declares no ordering a client
 * could trust — src/db/events.ts divergence 6 records that trade.
 */
export function assertHonestSelfHostedRead(
  enumeration: SelfHostedEnumeration<unknown>,
  bound: number | null,
  context: { noun: string; narrowHint: string },
): void {
  if (bound === null ? enumeration.complete : (enumeration.filled || enumeration.complete) && enumeration.stable) {
    return;
  }
  // Name whichever evidence actually fired: a deletion above the cursor skips rows
  // without ever producing a duplicate, so `duplicates` alone is not the whole story.
  const shiftEvidence = enumeration.duplicates > 0
    ? `${enumeration.duplicates} duplicate row(s) means rows were skipped`
    : "a page did not begin on the row the previous page ended on, so rows were skipped";
  const cause = enumeration.exhausted
    ? `the ${enumeration.pages}-page enumeration budget ran out`
    : `the server's paging window shifted (${shiftEvidence})`;
  if (bound === null) {
    throw new Error(
      `Refusing to return a partial ${context.noun} list: ${cause}, so the ${enumeration.rows.length} row(s) read `
        + "are a LOWER BOUND, not the whole set — a caller that treated them as complete would be wrong. "
        + context.narrowHint,
    );
  }
  throw new Error(
    `Refusing to return a partial ${context.noun} list: ${cause} with ${enumeration.rows.length} of the ${bound} `
      + "row(s) the requested window needs, so this result is SHORT, not the end of the table — a caller that "
      + "treated it as the window it asked for would silently skip rows. Retry, or " + context.narrowHint,
  );
}
