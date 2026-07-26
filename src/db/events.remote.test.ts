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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { listEventSummaries, listEvents } from "./events.js";

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
  // ignores unknown query params. Same convention as src/db/contacts.remote.ts.
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
