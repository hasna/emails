// The enumeration EVERY status count is built on, checked against the failures it
// exists to make visible.
//
// This is not a paging test. Each case below is a way for a count to come out wrong
// while looking exact, and the assertion is that the enumeration SAYS SO rather than
// publishing the number: a refusal is not an empty table, a thrown fault is not an
// empty table, a window that moved is not a total, and a budget that ran out is not
// the end of the table.

import { describe, expect, it } from "bun:test";
import { STORE_LIST_PAGE_MAX, enumerateStoreRows } from "./status-facts-enumeration.js";
import type { Outcome } from "../store/outcome.js";

interface Row {
  id: string;
}

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: `r${String(index).padStart(5, "0")}` }));
}

const idOf = (row: Row): string | null => row.id;

/** A stable store: one total order, never written to mid-read. */
function stableList(all: Row[], seen: Array<{ limit: number; offset: number }> = []) {
  return async (opts: { limit: number; offset: number }): Promise<Outcome<Row[]>> => {
    seen.push(opts);
    return { ok: true, value: all.slice(opts.offset, opts.offset + opts.limit) };
  };
}

/**
 * A store whose list order is NOT total: the window rotates by `rotate` positions
 * before every page, which is the production `/v1/sources` failure mode (3899 rows,
 * 426 duplicates, 3473 published as a total that was 11% low). Rotation wraps, so
 * rows already read reappear at low offsets — the DUPLICATE direction.
 */
function rotatingList(all: Row[], rotate: number) {
  let order = [...all];
  return async (opts: { limit: number; offset: number }): Promise<Outcome<Row[]>> => {
    const at = ((rotate % order.length) + order.length) % order.length;
    order = [...order.slice(at), ...order.slice(0, at)];
    return { ok: true, value: order.slice(opts.offset, opts.offset + opts.limit) };
  };
}

/**
 * A store that loses rows from ABOVE the cursor between pages — a delete, or a
 * filtered view narrowing.
 *
 * This is the direction duplicate-counting is blind to: every unread row slides to a
 * lower offset, the next page starts LATE, and the skipped rows are never returned by
 * anything, so no row is ever seen twice. Only an anchor catches it.
 */
function shrinkingList(all: Row[], dropPerPage: number) {
  let order = [...all];
  return async (opts: { limit: number; offset: number }): Promise<Outcome<Row[]>> => {
    order = order.slice(dropPerPage);
    return { ok: true, value: order.slice(opts.offset, opts.offset + opts.limit) };
  };
}

describe("store enumeration reports what it could not see", () => {
  it("enumerates past the per-page cap and reports the total as exact", async () => {
    const all = rows(1300);
    const seen: Array<{ limit: number; offset: number }> = [];
    const result = await enumerateStoreRows(stableList(all, seen), { idOf });

    expect(result.rows).toHaveLength(1300);
    expect(result.complete).toBe(true);
    expect(result.stable).toBe(true);
    expect(result.duplicates).toBe(0);
    expect(result.shifted).toBe(false);
    expect(result.exhausted).toBe(false);
    expect(result.refusal).toBeNull();
    expect(result.fault).toBeNull();
    // One list call would have capped this at 500. The whole reason the enumeration
    // exists is that neither store publishes a total. The read ends on an EMPTY page,
    // never on a short one, so the last request returns nothing.
    expect(seen.length).toBeGreaterThan(1);
    expect(result.pages).toBeGreaterThan(Math.ceil(1300 / STORE_LIST_PAGE_MAX));
    for (const request of seen) expect(request.limit).toBeLessThanOrEqual(STORE_LIST_PAGE_MAX);
  });

  it("never asks for more rows than a store will return in one page", async () => {
    const seen: Array<{ limit: number; offset: number }> = [];
    await enumerateStoreRows(stableList(rows(10), seen), { idOf, pageSize: 10_000 });
    // A request over the cap comes back CLAMPED, and a clamped full page is
    // indistinguishable from the end of the table.
    expect(seen[0]?.limit).toBe(STORE_LIST_PAGE_MAX);
  });

  it("surfaces a refusal instead of an empty table", async () => {
    const result = await enumerateStoreRows<Row>(
      async () => ({ ok: false, code: "capability_unavailable", message: "no", status: 501 }),
      { idOf },
    );

    expect(result.refusal).toMatchObject({ code: "capability_unavailable", status: 501 });
    expect(result.rows).toEqual([]);
    // The distinction the whole module exists for: an empty result set would be
    // `complete: true, rows: []`, which reads as "there is nothing there".
    expect(result.complete).toBe(false);
  });

  it("keeps a refusal on a LATER page from being published as a partial count", async () => {
    const all = rows(1300);
    let calls = 0;
    const result = await enumerateStoreRows<Row>(
      async (opts) => {
        calls += 1;
        if (calls > 1) return { ok: false, code: "invalid_input", message: "bad offset", status: 422 };
        return { ok: true, value: all.slice(opts.offset, opts.offset + opts.limit) };
      },
      { idOf },
    );

    // Rows really were read, and they are handed back — but the refusal is too, so a
    // caller cannot mistake 500 of 1300 for the total.
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThan(all.length);
    expect(result.refusal).toMatchObject({ code: "invalid_input" });
    expect(result.complete).toBe(false);
  });

  it("surfaces a thrown fault instead of an empty table", async () => {
    const result = await enumerateStoreRows<Row>(
      async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:1"); },
      { idOf },
    );

    expect(result.fault).toContain("ECONNREFUSED");
    expect(result.rows).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.pages).toBe(0);
  });

  it("catches a window that moved FORWARD, which produces no duplicate at all", async () => {
    // The case duplicate-counting is blind to, and the reason every page after the
    // first re-requests the row before it. A row removed above the cursor slides
    // every unread row down one offset: the next page starts late and the skipped
    // rows are never seen by anything.
    const all = rows(1300);
    const result = await enumerateStoreRows(shrinkingList(all, 7), { idOf });

    // THE POINT: the shift is proven with zero duplicates. Drop the anchor from the
    // pager and every assertion in this test still reads as a clean, complete
    // enumeration of a table it silently under-read.
    expect(result.shifted).toBe(true);
    expect(result.duplicates).toBe(0);
    expect(result.stable).toBe(false);
    expect(result.complete).toBe(false);
    // Rows really were skipped, so the count is a lower bound and must not be
    // published as 1300.
    expect(result.rows.length).toBeLessThan(all.length);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("catches a non-total list order, which returns rows already read", async () => {
    // The recorded production case: a rotating window hands back rows that were
    // already counted. De-duplicating without saying so would turn an inflated count
    // into a silent undercount, so the duplicates are counted AND published.
    const all = rows(1300);
    const result = await enumerateStoreRows(rotatingList(all, 7), { idOf });

    expect(result.duplicates).toBeGreaterThan(0);
    expect(result.stable).toBe(false);
    expect(result.complete).toBe(false);
    // Deliberately NOT asserting a shortfall here. Under a wrapping rotation the read
    // may well walk the whole table; what makes the count unpublishable as a total is
    // that the window MOVED, which is what `stable` and `complete` carry.
    expect(result.rows.length).toBeLessThanOrEqual(all.length);
  });

  it("does not read a CLAMPED page as the end of the table", async () => {
    // THE HOLE THIS CLOSES. Every list route clamps `limit`, and a clamped page looks
    // exactly like the last page of a small table. A pager that ends on a short page
    // therefore publishes a store's clamp as a complete total — `complete: true`, no
    // `≥`, and a number that is wrong by however much the clamp withheld.
    //
    // Neither shipped store clamps below what this pager asks for, which is exactly why
    // this needs a fixture rather than repo content: the guard has to hold for the store
    // that starts doing it, not only for the two that do not.
    const all = rows(1300);
    const CLAMP = 200;
    const seen: Array<{ limit: number; offset: number }> = [];
    const clamped = async (opts: { limit: number; offset: number }): Promise<Outcome<Row[]>> => {
      seen.push(opts);
      return { ok: true, value: all.slice(opts.offset, opts.offset + Math.min(opts.limit, CLAMP)) };
    };

    const result = await enumerateStoreRows(clamped, { idOf });

    // Precondition: the store really did serve less than it was asked for, every time.
    expect(seen.length).toBeGreaterThan(1);
    for (const request of seen) expect(request.limit).toBeGreaterThan(CLAMP);
    // ...and the enumeration still reached the end and counted every row.
    expect(result.rows).toHaveLength(all.length);
    expect(result.complete).toBe(true);
    expect(result.stable).toBe(true);
    expect(result.duplicates).toBe(0);
    expect(result.shifted).toBe(false);
  });

  it("reports an exhausted page budget as incomplete rather than as the end of the table", async () => {
    const all = rows(1300);
    const result = await enumerateStoreRows(stableList(all), { idOf, pageBudget: 2 });

    expect(result.pages).toBe(2);
    expect(result.exhausted).toBe(true);
    expect(result.complete).toBe(false);
    // The rows it DID read are real and are handed back as a lower bound.
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThan(all.length);
    // A budget that ran out is stable-but-incomplete, which is a DIFFERENT reason
    // from a moved window and must not be reported as one.
    expect(result.stable).toBe(true);
    expect(result.shifted).toBe(false);
  });

  it("still enumerates rows that carry no id, and does not pretend it checked them", async () => {
    // The documented blind spot: with no identity there is nothing to anchor on and
    // nothing to de-duplicate by. The read still terminates on a short page, and the
    // absence of duplicate/shift evidence is an absence of evidence — recorded here
    // so a future change that starts guessing an id is a visible diff.
    const anonymous = Array.from({ length: 600 }, () => ({ id: "" }) as Row);
    const result = await enumerateStoreRows(stableList(anonymous), { idOf: () => null });

    expect(result.rows).toHaveLength(600);
    expect(result.complete).toBe(true);
    expect(result.duplicates).toBe(0);
    expect(result.shifted).toBe(false);
  });

  it("treats an empty table as complete, which is the one honest zero here", async () => {
    const result = await enumerateStoreRows(stableList([]), { idOf });

    expect(result.rows).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.refusal).toBeNull();
    expect(result.fault).toBeNull();
  });
});
