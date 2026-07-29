// The truncation trap on the fastest-growing table in the system.
//
// `listFilteredEvents` enumerates `/v1/events` and then filters + windows the rows
// in memory. It used to compute `enumerateSelfHostedRows(...).complete` and throw
// it away, so once `events` outgrew the pager's 20_000-row budget — or the
// server's paging window shifted — the caller got a SHORT set that looked whole.
// `emails export` refuses in self_hosted, but `export events` over MCP
// (src/mcp/tools/misc-ops.ts) and the dashboard's events route both land here and
// hand the result straight to a human as a JSON/CSV file.
//
// Two guards:
//   1. an incomplete enumeration is refused, never windowed and returned;
//   2. the filters `/v1/events` declares (`email_id`, `provider_id`, `type`) are
//      sent to the SERVER, so a narrow read stays inside the budget instead of
//      dragging the whole table across the wire.
//
// The refusal then over-reached: it applied to BOUNDED reads too, which never asked
// about the rest of the table. Every caller that reaches this path through
// src/lib/export.ts — MCP `export_events`, CLI `emails export events`, and
// `GET /api/export/events` — is bounded (`normalizeEventFilters` always supplies a
// limit, 1000 by default), so all of them returned a 500 rather than a page once
// `events` outgrew the budget. A bounded read is now windowed server-side and
// answered; only an unbounded one still has to prove completeness.
//
// (`GET /api/events` is NOT one of those callers: src/server/routes/core.ts imports
// from `events.local.js` and never reaches the remote path.)

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { listEventSummaries, listEvents } from "./events.js";
import { SELF_HOSTED_ENUMERATION_PAGE_BUDGET, SELF_HOSTED_SERVER_PAGE_MAX } from "./self-hosted-page.js";

let stub: V1Stub;

beforeAll(async () => { stub = await startV1Stub(); });
afterAll(() => stub.stop());
beforeEach(async () => { await stub.reset(); stub.applyEnv(); });
afterEach(() => stub.clearEnv());

function eventRows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: `evt-${String(index).padStart(5, "0")}`,
    email_id: `email-${index % 3}`,
    provider_id: index % 2 === 0 ? "prov-a" : "prov-b",
    provider_event_id: `pe-${index}`,
    type: index % 2 === 0 ? "delivered" : "opened",
    recipient: `user${index}@example.com`,
    metadata: {},
    occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
  }));
}

describe("self-hosted event listing", () => {
  it("returns every row when the enumeration is complete", async () => {
    await stub.seed({ events: eventRows(1200) });

    expect(listEvents()).toHaveLength(1200);
    expect(listEventSummaries()).toHaveLength(1200);
  });

  // The defect: `complete` was computed and discarded, so a partial read was
  // sorted, windowed and returned as if it were the whole table.
  it("refuses a partial enumeration instead of exporting a short list as whole", async () => {
    await stub.seed({ events: eventRows(1200) });
    await stub.setListOrderInstability(7, ["events"]);

    expect(() => listEvents()).toThrow(/partial event list/);
    expect(() => listEventSummaries()).toThrow(/partial event list/);
    // The refusal names the cause and a way forward, not just "failed".
    expect(() => listEvents()).toThrow(/LOWER BOUND/);
  });

  it("sends the /v1/events filters to the server instead of reading the whole table", async () => {
    await stub.seed({ events: eventRows(1200) });

    listEvents({ email_id: "email-1", provider_id: "prov-b", type: "opened" });

    const queries = await stub.listQueries("events");
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query).toContain("email_id=email-1");
      expect(query).toContain("provider_id=prov-b");
      expect(query).toContain("type=opened");
    }
  });

  // The server-side filters are a BOUND, not the answer: the same filters run
  // again in memory so the result is identical against a server (or a stub) that
  // ignores unknown query params. Same convention as the collapsed contacts
  // family's pushed-down email filter (src/db/contacts.ts).
  it("stays correct against a server that ignores the query params", async () => {
    await stub.seed({ events: eventRows(60) });

    const opened = listEvents({ type: "opened" });
    expect(opened.length).toBe(30);
    expect(opened.every((event) => event.type === "opened")).toBe(true);

    const forEmail = listEvents({ email_id: "email-2" });
    expect(forEmail.length).toBe(20);
    expect(forEmail.every((event) => event.email_id === "email-2")).toBe(true);
  });

  // A list of types cannot be pushed through an equality filter, so it must stay
  // a client-side filter rather than be sent as a bogus `type=a,b` param.
  it("does not send a multi-value type filter server-side", async () => {
    await stub.seed({ events: eventRows(60) });

    const rows = listEvents({ type: ["opened", "delivered"] });

    expect(rows).toHaveLength(60);
    for (const query of await stub.listQueries("events")) {
      expect(query).not.toContain("type=");
    }
  });
});

// Rows whose id sequence runs newest-first, so `evt-{N}` is the (N+1)-th most recent
// event under `/v1/events`'s declared `occurred_at DESC, id ASC` order. That makes a
// server-side window checkable by IDENTITY and not merely by count: the window
// [offset, offset+limit) must be exactly `evt-{offset}` .. `evt-{offset+limit-1}`.
// `eventRows` above cannot do this — it repeats each `occurred_at` every 60 rows, so
// "the 100 most recent" is not even well defined in it.
function descendingEventRows(count: number, order: "newest-first" | "scrambled" = "newest-first"): Array<Record<string, unknown>> {
  const newest = Date.UTC(2026, 0, 1, 0, 0, 0);
  const rows = Array.from({ length: count }, (_, index) => {
    const occurredAt = new Date(newest - index * 1000).toISOString();
    return {
      id: `evt-${String(index).padStart(6, "0")}`,
      email_id: `email-${index % 3}`,
      provider_id: index % 2 === 0 ? "prov-a" : "prov-b",
      provider_event_id: `pe-${index}`,
      type: index % 2 === 0 ? "delivered" : "opened",
      recipient: `user${index}@example.com`,
      metadata: {},
      occurred_at: occurredAt,
      created_at: occurredAt,
    };
  });
  // `scrambled` seeds the SAME rows in an order no client may rely on, proving the
  // window comes from the server's declared ORDER BY and not from insertion order.
  return order === "scrambled" ? rows.slice().reverse() : rows;
}

describe("bounded self-hosted event reads", () => {
  // Past this many rows the pager cannot walk the table inside its budget, so an
  // unbounded read has no way to prove it saw all of it.
  const SCAN_CAP = SELF_HOSTED_ENUMERATION_PAGE_BUDGET * SELF_HOSTED_SERVER_PAGE_MAX;

  // THE REGRESSION. A bounded read used to enumerate the whole table and then refuse
  // the result — a 500 on a read that never asked about the whole table. `limit: 100`
  // is the single-request shape; `limit: 1000` (the `export events` default) is
  // covered separately below because it spans pages.
  it("serves a bounded read on a table past the scan cap, and still refuses an unbounded one", async () => {
    await stub.seed({ events: descendingEventRows(SCAN_CAP + 500) });

    // Asked for "the first 100": gets 100, and they are the 100 most recent.
    const page = listEventSummaries({ limit: 100 });
    expect(page).toHaveLength(100);
    expect(page[0]!.id).toBe("evt-000000");
    expect(page[99]!.id).toBe("evt-000099");
    expect(listEvents({ limit: 100 })).toHaveLength(100);

    // A window that starts past the server's 500-row page cap is still FULL: the
    // pager pages to reach it instead of asking for one over-cap page.
    const deep = listEvents({ limit: 100, offset: 700 });
    expect(deep).toHaveLength(100);
    expect(deep[0]!.id).toBe("evt-000700");
    expect(deep[99]!.id).toBe("evt-000799");

    // Asked for "everything" on a table that cannot be safely enumerated: refuses.
    // Enumerated once — walking 20_000 rows over the wire is the expensive path.
    let refusal: unknown;
    try {
      listEvents();
    } catch (error) {
      refusal = error;
    }
    expect(String(refusal)).toMatch(/partial event list/);
    expect(String(refusal)).toMatch(/LOWER BOUND/);
  }, 120_000);

  it("windows a bounded read server-side instead of dragging the table across the wire", async () => {
    await stub.seed({ events: descendingEventRows(1200) });

    expect(listEvents({ limit: 100 })).toHaveLength(100);

    // One request for the 100 rows asked for — not three pages of 500 for the table.
    // A single request also cannot observe a shifted paging window at all.
    const queries = await stub.listQueries("events");
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("limit=100");
    expect(queries[0]).toContain("offset=0");
  });

  // The clamp trap: the server caps every page at 500 rows (store.ts clampLimit) and
  // ignores anything larger, so a window whose far edge is past 500 must be PAGED to.
  // Asking for `limit = offset + limit` in one shot returns 500 rows and the local
  // slice then under-fills — a bounded read that quietly returns fewer rows than it
  // was asked for, which is the same lie as a truncated export.
  it("never asks for more than one server page, and still fills a window past the cap", async () => {
    await stub.seed({ events: descendingEventRows(1200) });

    const window = listEvents({ limit: 100, offset: 700 });

    expect(window).toHaveLength(100);
    expect(window[0]!.id).toBe("evt-000700");
    expect(window[99]!.id).toBe("evt-000799");

    const queries = await stub.listQueries("events");
    expect(queries.length).toBeGreaterThan(1);
    for (const query of queries) {
      const limit = Number(new URLSearchParams(query).get("limit"));
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(SELF_HOSTED_SERVER_PAGE_MAX);
    }
  });

  // `since`/`until` and a multi-value `type` are not `/v1/events` filters, so the
  // pager has to keep reading until the window holds N rows that PASS them. Counting
  // rows READ instead of rows KEPT would hand back a short window.
  it("fills a bounded window whose filter can only be applied client-side", async () => {
    await stub.seed({ events: descendingEventRows(1200) });

    const rows = listEvents({ type: ["opened"], limit: 100 });

    expect(rows).toHaveLength(100);
    expect(rows.every((event) => event.type === "opened")).toBe(true);
    // Only every other row is `opened`, so one page of 100 cannot fill the window.
    expect((await stub.listQueries("events")).length).toBeGreaterThan(1);
  });

  // A short answer is only honest when the table really ended. Then it is the whole
  // tail, so it must be returned rather than refused as an unfilled window.
  it("answers a bounded read the table is too small to fill", async () => {
    await stub.seed({ events: descendingEventRows(60) });

    const rows = listEvents({ limit: 100 });

    expect(rows).toHaveLength(60);
    expect(rows[0]!.id).toBe("evt-000000");
    expect(rows[59]!.id).toBe("evt-000059");
  });

  // A server-side window is only the caller's window if the SERVER ordered first, so
  // that dependency is load-bearing and must be asserted, not assumed: the same rows
  // inserted in the opposite order must still yield the 100 most recent.
  it("takes the window from the server's declared order, not from insertion order", async () => {
    await stub.seed({ events: descendingEventRows(1200, "scrambled") });

    const page = listEvents({ limit: 100 });

    expect(page).toHaveLength(100);
    expect(page[0]!.id).toBe("evt-000000");
    expect(page[99]!.id).toBe("evt-000099");
    // Newest-first, strictly — not merely the right set of ids.
    expect(page.map((event) => event.occurred_at)).toEqual(
      [...page].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)).map((event) => event.occurred_at),
    );
  });

  // A bound that fits in ONE request is genuinely immune to a shifting paging window:
  // a single request sees a single snapshot, so there is no window to shift. That is a
  // property of the single request, NOT of bounded reads in general — see the
  // multi-page case below. The unbounded read over the same table is still refused.
  it("serves a single-request bounded read while the server's paging window shifts", async () => {
    await stub.seed({ events: descendingEventRows(1200) });
    await stub.setListOrderInstability(7, ["events"]);

    expect(listEvents({ limit: 100 })).toHaveLength(100);

    expect(() => listEvents()).toThrow(/partial event list/);
    expect(() => listEvents()).toThrow(/paging window shifted/);
  });

  // A MULTI-page bounded read must refuse under a shifting window, and this is the
  // case that a bound almost hid. `limit: 1000` is the `export events` default, so it
  // spans two pages. The window moves FORWARD there, which skips rows without ever
  // returning one twice: the read came back with a full-looking 1000 rows that were
  // missing the seven most recent events, `duplicates === 0`, and nothing to fire on.
  // Filling a window is only an answer if the window did not move underneath it.
  it("refuses a multi-page bounded read when the window shifts without duplicating a row", async () => {
    await stub.seed({ events: descendingEventRows(1200) });
    await stub.setListOrderInstability(7, ["events"]);

    expect(() => listEvents({ limit: 1000 })).toThrow(/partial event list/);
    expect(() => listEvents({ limit: 1000 })).toThrow(/paging window shifted/);
    // Detected by the page anchor, not by de-duplication — no row ever came back twice.
    expect(() => listEvents({ limit: 1000 })).toThrow(/did not begin on the row the previous page ended on/);
  });

  // A bound is NOT a way around the guard. When a client-side filter starves the
  // window — the matching rows sit past everything the pager can walk — the read
  // neither fills its window nor reaches the end of the table, so it must refuse
  // rather than pass a short result off as the window that was asked for.
  it("refuses a bounded read that can neither fill its window nor reach the end", async () => {
    const rows = descendingEventRows(SCAN_CAP + 500);
    // Matches the OLDEST 1500 rows, i.e. the far end of a table ordered newest-first.
    // The pager can reach 1000 of them inside its budget; the window wants 2000.
    const until = String(rows[SCAN_CAP - 1000]!["occurred_at"]);
    await stub.seed({ events: rows });

    expect(() => listEvents({ until, limit: 2000 })).toThrow(/partial event list/);
    expect(() => listEvents({ until, limit: 2000 })).toThrow(/budget ran out/);
    // The refusal names how short the window fell, so the caller sees a real
    // shortfall and not just "failed". Asserted by shape rather than by a hard-coded
    // count, which would only track how many rows a page happens to carry.
    let refusal = "";
    try {
      listEvents({ until, limit: 2000 });
    } catch (error) {
      refusal = String(error);
    }
    const shortfall = refusal.match(/(\d+) of the 2000 row\(s\)/);
    expect(shortfall).not.toBeNull();
    const reached = Number(shortfall![1]);
    // Real rows were read (never a fabricated zero) and the window really is short.
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThan(2000);

    // Positive control: the same filter, bounded to what IS reachable, is answered —
    // the refusal above is about the unreachable rows, not a filter that matches
    // nothing.
    const reachable = listEvents({ until, limit: 500 });
    expect(reachable).toHaveLength(500);
    expect(reachable.every((event) => event.occurred_at <= until)).toBe(true);
    expect(reachable[0]!.id).toBe(`evt-${String(SCAN_CAP - 1000).padStart(6, "0")}`);
  }, 120_000);
});
