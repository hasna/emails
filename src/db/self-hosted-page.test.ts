// The count trap this pager closes.
//
// Every `/v1` list route is limit/offset only and the server clamps every page to
// 500 rows (src/server/self-hosted/store.ts clampLimit). The client's convention
// was `.list({ limit: 1000 })` — believing it got up to 1000 rows — so any count
// derived from ONE call is a silent lower bound capped at 500. A status payload
// built that way would report a plausible, wrong total the moment a deployment
// crosses 500 rows.
//
// enumerateSelfHostedRows pages until a short page and reports `complete`, so a
// caller can publish a real total or an explicit lower bound.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  enumerateSelfHostedRows,
  SELF_HOSTED_ENUMERATION_PAGE_BUDGET,
  SELF_HOSTED_SERVER_PAGE_MAX,
} from "./self-hosted-page.js";
import { selfHostedResource } from "./self-hosted-resource.js";

let stub: V1Stub;
beforeAll(async () => { stub = await startV1Stub(); });
afterAll(() => stub.stop());
beforeEach(async () => { await stub.reset(); stub.applyEnv(); });
afterEach(() => stub.clearEnv());

function rows(count: number): Array<Record<string, unknown>> {
  // Explicit DESCENDING created_at (row 0 newest). The stub now applies the real
  // server's address list order (`created_at DESC, id ASC` — see declaredListOrder
  // in src/test-support/v1-stub.ts), so a fixture without timestamps would be
  // served in the order of the seed call's now()-stamp millisecond ties, not in
  // insertion order. Stamping newest-first makes served order == insertion order,
  // keeping every positional expectation below deterministic and meaningful.
  return Array.from({ length: count }, (_, index) => ({
    id: `addr-${String(index).padStart(5, "0")}`,
    email: `user${index}@example.com`,
    status: "active",
    verified: index % 2 === 0,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - index * 1000).toISOString(),
  }));
}

describe("enumerateSelfHostedRows", () => {
  it("mirrors the server page cap in a named constant", () => {
    expect(SELF_HOSTED_SERVER_PAGE_MAX).toBe(500);
    expect(SELF_HOSTED_ENUMERATION_PAGE_BUDGET).toBeGreaterThan(1);
  });

  it("returns every row and marks the count complete when the end is reached", async () => {
    await stub.seed({ addresses: rows(37) });

    const result = enumerateSelfHostedRows("addresses");

    expect(result.rows).toHaveLength(37);
    expect(result.complete).toBe(true);
    expect(result.pages).toBe(1);
  });

  it("pages past the server cap instead of silently truncating at 500", async () => {
    await stub.seed({ addresses: rows(1200) });

    // The old single-call convention: the client asks for 1000 and gets 500.
    const single = selfHostedResource("addresses").list({ limit: 1000 });
    expect(single.length).toBeLessThanOrEqual(SELF_HOSTED_SERVER_PAGE_MAX);

    const result = enumerateSelfHostedRows("addresses");
    expect(result.rows).toHaveLength(1200);
    expect(result.complete).toBe(true);
    expect(result.pages).toBeGreaterThan(2);
    expect(new Set(result.rows.map((row) => row["id"])).size).toBe(1200);
  });

  it("reports complete: false rather than a plausible total when the budget runs out", async () => {
    await stub.seed({ addresses: rows(1200) });

    const result = enumerateSelfHostedRows("addresses", { pageSize: 100, pageBudget: 3 });

    expect(result.complete).toBe(false);
    expect(result.pages).toBe(3);
    // 100 + 99 + 99: every page after the first re-reads the previous page's last row
    // to prove the window did not move (see `shifted`), so one row of each page's
    // capacity buys that proof. The point of the assertion is unchanged — the budget
    // ran out, so this count is a lower bound and never a total.
    expect(result.rows).toHaveLength(298);
  });

  // The SECOND count trap, found on production /v1/sources: the server's list
  // ORDER BY was not a total order, so offset paging returned the same rows twice
  // and skipped others. De-duplicating hid the skips and produced a confident
  // UNDERcount: 3473 distinct rows reported as the total of a 3899-row table.
  // Whenever the window shifts, the enumeration is a lower bound, not a total.
  it("reports stable: false / complete: false when the paging window shifts", async () => {
    await stub.seed({ addresses: rows(1200) });
    await stub.setListOrderInstability(7, ["addresses"]);

    const result = enumerateSelfHostedRows("addresses");

    expect(result.duplicates).toBeGreaterThan(0);
    expect(result.stable).toBe(false);
    // The rows it DID see are real, but they are a subset...
    expect(result.rows.length).toBeLessThan(1200);
    // ...so the count must NOT be published as a total.
    expect(result.complete).toBe(false);
    // The pager reached a short page: "short page" alone must never imply complete.
    expect(result.exhausted).toBe(false);
  });

  it("keeps stable: true and an exact total when the order is total", async () => {
    await stub.seed({ addresses: rows(1200) });
    await stub.setListOrderInstability(0);

    const result = enumerateSelfHostedRows("addresses");

    expect(result.duplicates).toBe(0);
    expect(result.stable).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.rows).toHaveLength(1200);
  });

  it("throws instead of returning an empty page set when the endpoint is unreachable", async () => {
    // Fail LOUD: the caller must report `source_unreachable`, never count 0 rows.
    process.env["EMAILS_SELF_HOSTED_URL"] = "http://127.0.0.1:1";
    const { resetSelfHostedConfigCache } = await import("./self-hosted-store.js");
    resetSelfHostedConfigCache();

    expect(() => enumerateSelfHostedRows("addresses")).toThrow();
  });
});

// A BOUNDED read — "the first N", not "everything". The completeness guard above is
// the right answer to "everything" and the wrong answer to "the first N": a window is
// complete for its own bound, and refusing it turns a page request into a 500.
describe("enumerateSelfHostedRows with a bounded need", () => {
  it("stops at the window and reports filled, without claiming completeness", async () => {
    await stub.seed({ addresses: rows(1200) });

    const result = enumerateSelfHostedRows("addresses", { need: 100 });

    expect(result.rows).toHaveLength(100);
    expect(result.filled).toBe(true);
    // It stopped early, so it knows nothing about the rest of the table. `filled` and
    // `complete` must never be conflated — that conflation is how a page becomes a
    // "total".
    expect(result.complete).toBe(false);
    expect(result.exhausted).toBe(false);
    // One request: it asked the server for exactly the window it needed.
    expect(result.pages).toBe(1);
  });

  it("pages to fill a window wider than the server's page cap", async () => {
    await stub.seed({ addresses: rows(1200) });

    const result = enumerateSelfHostedRows("addresses", { need: 800 });

    expect(result.rows).toHaveLength(800);
    expect(result.filled).toBe(true);
    // 800 > the 500-row server cap, so a single request could never have filled it.
    expect(result.pages).toBeGreaterThan(1);
    expect(new Set(result.rows.map((row) => row["id"])).size).toBe(800);
    expect(result.rows[0]!["id"]).toBe("addr-00000");
    expect(result.rows[799]!["id"]).toBe("addr-00799");
  });

  it("reports the end of the table rather than filled when the bound overshoots it", async () => {
    await stub.seed({ addresses: rows(37) });

    const result = enumerateSelfHostedRows("addresses", { need: 100 });

    expect(result.rows).toHaveLength(37);
    expect(result.filled).toBe(false);
    // The table ended, so this short answer IS the whole set — a caller may return it.
    expect(result.complete).toBe(true);
    expect(result.exhausted).toBe(false);
  });

  it("reports neither filled nor complete when the budget runs out first", async () => {
    await stub.seed({ addresses: rows(1200) });

    const result = enumerateSelfHostedRows("addresses", { need: 900, pageSize: 100, pageBudget: 3 });

    // 100 + 99 + 99 — one row per page after the first pays for the anchor.
    expect(result.rows).toHaveLength(298);
    expect(result.filled).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.exhausted).toBe(true);
  });

  // `select` maps and filters in one pass. A dropped row is still consumed — it was
  // really there — but must not count toward the window, or the window comes back
  // short of the rows the caller asked to KEEP.
  it("fills the window with rows that pass select, not rows merely read", async () => {
    await stub.seed({ addresses: rows(1200) });

    const result = enumerateSelfHostedRows<string>("addresses", {
      need: 100,
      select: (row) => (row["verified"] === true ? String(row["id"]) : null),
    });

    expect(result.rows).toHaveLength(100);
    expect(result.filled).toBe(true);
    // Only every other row is verified, so >=200 rows had to be read to keep 100.
    expect(result.rows).toEqual(
      Array.from({ length: 100 }, (_, index) => `addr-${String(index * 2).padStart(5, "0")}`),
    );
  });

  // De-duplication only catches the window moving BACKWARD. Moving FORWARD — a row
  // deleted above the cursor — slides every unread row down one offset, so the next
  // page starts one row late and the skipped row is seen by nobody. No duplicate is
  // ever produced, so `duplicates` cannot be the only integrity signal.
  it("proves a forward window shift that produces no duplicate at all", async () => {
    await stub.seed({ addresses: rows(1200) });
    await stub.setListOrderInstability(7, ["addresses"]);

    const result = enumerateSelfHostedRows("addresses", { need: 1000 });

    expect(result.shifted).toBe(true);
    // The point: nothing came back twice, so the pre-existing signal saw nothing.
    expect(result.duplicates).toBe(0);
    expect(result.stable).toBe(false);
    // It must NOT be publishable: the window looks full but skipped rows.
    expect(result.complete).toBe(false);
  });

  it("keeps shifted false and the window full when the order really is total", async () => {
    await stub.seed({ addresses: rows(1200) });

    const result = enumerateSelfHostedRows("addresses", { need: 1000 });

    expect(result.shifted).toBe(false);
    expect(result.stable).toBe(true);
    expect(result.filled).toBe(true);
    expect(result.rows).toHaveLength(1000);
    // Anchoring re-reads a row per page; it must never leak into the result.
    expect(new Set(result.rows.map((row) => row["id"])).size).toBe(1000);
    expect(result.rows[0]!["id"]).toBe("addr-00000");
    expect(result.rows[999]!["id"]).toBe("addr-00999");
  });

  it("counts a dropped row as consumed so paging never re-reads it", async () => {
    await stub.seed({ addresses: rows(1200) });

    const result = enumerateSelfHostedRows<string>("addresses", {
      select: (row) => (row["verified"] === true ? String(row["id"]) : null),
    });

    expect(result.rows).toHaveLength(600);
    expect(result.complete).toBe(true);
    expect(new Set(result.rows).size).toBe(600);
  });
});
