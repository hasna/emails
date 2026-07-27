// The 500-row list clamp, and the reads that used to walk straight into it.
//
// `selfHostedListQuery` asks for `max(1000, limit + offset)` rows in ONE request and
// sends no server-side offset, then windows the result locally. Every `/v1` list is
// clamped to 500 server-side (src/server/self-hosted/store.ts clampLimit), so that
// helper can never see past row 500. Against the REAL service on Postgres, a
// 600-row schedule answered `--limit 600` with 500 rows and `--offset 500` with an
// EMPTY list, both exit 0 — a silently truncated page, and a phantom
// "nothing scheduled".
//
// These tests sit at exactly that boundary. Every one of them fails on the reads as
// they were: 600 seeded rows, and the honest answers are 600 and "rows 500-599",
// never 500 and never [].
//
// The stub is the oracle ONLY because it now clamps the way production does. Its
// bespoke /v1/messages handler did not, which is the reason the export defect
// shipped green: no test could see it. If that clamp is ever removed, the
// `list respects the server clamp` case below goes red first.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { listEmails } from "./emails.remote.js";
import { SELF_HOSTED_SERVER_PAGE_MAX } from "./self-hosted-page.js";

const OVER_CLAMP = SELF_HOSTED_SERVER_PAGE_MAX + 100; // 600

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});
afterEach(() => stub.clearEnv());

function scheduledRows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `sched-${String(index).padStart(4, "0")}`,
    provider_id: "provider-1",
    from_address: "ops@example.com",
    to_addresses: [`c${index}@example.com`],
    subject: `S${index}`,
    // scheduled_at ASC is the declared order, so index order == list order.
    scheduled_at: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
    status: "pending",
  }));
}

function outboundRows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `msg-${String(index).padStart(4, "0")}`,
    direction: "outbound",
    from_addr: "ops@example.com",
    to_addrs: [`c${index}@example.com`],
    subject: `M${index}`,
    body_text: "b",
    // received_at DESC is the declared order, so index 0 is the NEWEST row.
    received_at: new Date(Date.UTC(2026, 2, 1, 0, 0, count - index)).toISOString(),
    status: "sent",
    is_read: true,
    labels: [],
  }));
}

describe("the stub enforces production's 500-row list clamp", () => {
  // The anti-vacuity control for everything below. A stub that is easier than
  // production certifies nothing, and this repo already shipped one defect that way.
  it("clamps /v1/messages, not just the generic resources", async () => {
    await stub.seed({ messages: outboundRows(OVER_CLAMP), scheduled: scheduledRows(OVER_CLAMP) });

    const messages = await fetch(`${stub.baseUrl}/v1/messages?limit=1000`, {
      headers: { authorization: `Bearer ${stub.apiKey}` },
    });
    const generic = await fetch(`${stub.baseUrl}/v1/scheduled?limit=1000`, {
      headers: { authorization: `Bearer ${stub.apiKey}` },
    });

    // /v1/messages carries its own envelope key; the generic resources use `items`.
    const messageRows = ((await messages.json()) as { messages?: unknown[] }).messages ?? [];
    const genericRows = ((await generic.json()) as { items?: unknown[] }).items ?? [];
    expect(messageRows).toHaveLength(SELF_HOSTED_SERVER_PAGE_MAX);
    expect(genericRows).toHaveLength(SELF_HOSTED_SERVER_PAGE_MAX);
  }, 30_000);
});

// The four SCHEDULED cases that used to live here have MOVED to src/db/scheduled.test.ts,
// not been dropped, and they came back stronger. That family has collapsed to one
// implementation over the store seam, so the arm they drove no longer exists — and the
// versions in their new home run over BOTH stores (SQLite directly, and the HTTP client
// against a `/v1` service backed by the same SQLite store) rather than against one stub,
// with the same 600 rows at the same clamp plus a fixture whose store order is the REVERSE
// of due order. The `/v1/scheduled` seed below is kept, because the clamp control above
// asserts on it and that control is what makes every other case in this file mean anything.

describe("the sent ledger crosses the clamp instead of truncating the export", () => {
  it("returns all 600 rows for the export's default 1000-row limit", async () => {
    await stub.seed({ messages: outboundRows(OVER_CLAMP) });
    // 1000 is exactly what src/lib/export.ts passes by default.
    expect(listEmails({ limit: 1000 })).toHaveLength(OVER_CLAMP);
  }, 30_000);

  it("returns rows 550-599 rather than an empty export", async () => {
    await stub.seed({ messages: outboundRows(OVER_CLAMP) });

    const page = listEmails({ limit: 50, offset: 550 });

    expect(page).toHaveLength(50);
    expect(page[0]?.id).toBe("msg-0550");
    expect(page[49]?.id).toBe("msg-0599");
  }, 30_000);

  it("applies a client-side --until window to rows past the clamp", async () => {
    // The 100 OLDEST rows are the newest indices (received_at DESC), so every match
    // lies past row 500. A single clamped request finds none of them and reports [].
    await stub.seed({ messages: outboundRows(OVER_CLAMP) });
    const cutoff = new Date(Date.UTC(2026, 2, 1, 0, 0, 100)).toISOString();

    const matched = listEmails({ until: cutoff, limit: 1000 });

    expect(matched).toHaveLength(100);
    expect(matched.every((row) => row.sent_at <= cutoff)).toBe(true);
  }, 30_000);
});
