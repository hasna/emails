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
  return Array.from({ length: count }, (_, index) => ({
    id: `addr-${String(index).padStart(5, "0")}`,
    email: `user${index}@example.com`,
    status: "active",
    verified: index % 2 === 0,
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
    expect(result.rows).toHaveLength(300);
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
