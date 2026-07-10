import { describe, expect, it } from "bun:test";
import { SelfHostedMailDataSource, type SelfHostedFetch } from "./self-hosted-mail-data-source.js";

// A modern self-hosted serve that supports GET /v1/messages/counts and the
// direction/to filters on GET /v1/messages. Backs the "fast path" so `status`,
// mailbox summaries, and `inbox latest`/wait-code no longer scan the whole store.
function fakeFastServe(rows: Array<Record<string, unknown>>): {
  fetchImpl: SelfHostedFetch;
  countsCalls: number;
  listCalls: string[];
} {
  const state = { countsCalls: 0, listCalls: [] as string[] };
  const isOut = (m: Record<string, unknown>) => String(m["direction"] ?? "").toLowerCase() === "outbound";
  const has = (m: Record<string, unknown>, label: string) =>
    Array.isArray(m["labels"]) && (m["labels"] as string[]).includes(label);
  const fetchImpl: SelfHostedFetch = async (url) => {
    const u = new URL(url);
    const ok = (body: unknown, status = 200) => ({ status, async text() { return JSON.stringify(body); } });
    if (u.pathname === "/v1/messages/counts") {
      state.countsCalls += 1;
      const inbox = rows.filter((m) => !isOut(m) && !has(m, "archived") && !has(m, "spam") && !has(m, "trash"));
      const counts = {
        inbox: inbox.length,
        unread: inbox.filter((m) => !m["is_read"]).length,
        starred: rows.filter((m) => m["is_starred"] && !has(m, "trash")).length,
        sent: rows.filter(isOut).length,
        archived: rows.filter((m) => has(m, "archived")).length,
        spam: rows.filter((m) => has(m, "spam")).length,
        trash: rows.filter((m) => has(m, "trash")).length,
        total: rows.length,
        latest_received_at: rows
          .filter((m) => !isOut(m))
          .map((m) => String(m["received_at"] ?? m["created_at"] ?? ""))
          .sort()
          .at(-1) ?? null,
      };
      return ok({ counts });
    }
    if (u.pathname === "/v1/messages") {
      state.listCalls.push(u.search);
      const dir = u.searchParams.get("direction");
      const to = (u.searchParams.get("to") ?? "").toLowerCase();
      let out = rows.slice();
      if (dir === "inbound") out = out.filter((m) => !isOut(m));
      else if (dir === "outbound") out = out.filter(isOut);
      if (to) out = out.filter((m) => JSON.stringify(m["to_addrs"] ?? []).toLowerCase().includes(to));
      out = out.sort((a, b) => String(b["received_at"]).localeCompare(String(a["received_at"])));
      return ok({ messages: out });
    }
    return ok({ error: "not found" }, 404);
  };
  return { fetchImpl, get countsCalls() { return state.countsCalls; }, get listCalls() { return state.listCalls; } };
}

function ds(fetchImpl: SelfHostedFetch): SelfHostedMailDataSource {
  return new SelfHostedMailDataSource({ baseUrl: "https://svc/v1", apiKey: "k", fetchImpl });
}

const rows = [
  { id: "a", direction: "inbound", from_addr: "x@a.com", to_addrs: ["target@holypaper.com"], subject: "hi", body_text: "code 111", received_at: "2026-06-03T00:00:00.000Z", is_read: false, is_starred: false, labels: [] },
  { id: "b", direction: "inbound", from_addr: "y@a.com", to_addrs: ["other@holypaper.com"], subject: "nope", body_text: "n", received_at: "2026-06-02T00:00:00.000Z", is_read: true, is_starred: false, labels: [] },
  { id: "c", direction: "inbound", from_addr: "z@a.com", to_addrs: ["target@holypaper.com"], subject: "older", body_text: "code 222", received_at: "2026-06-01T00:00:00.000Z", is_read: true, is_starred: false, labels: ["spam"] },
  { id: "d", direction: "outbound", from_addr: "me@holypaper.com", to_addrs: ["dst@x.com"], subject: "sent", body_text: "s", received_at: "2026-06-04T00:00:00.000Z", is_read: true, is_starred: false, labels: [] },
];

describe("self-hosted fast path (counts + server-side filters)", () => {
  it("mailboxCounts reads the server counts aggregate (no full scan)", async () => {
    const serve = fakeFastServe(rows);
    const counts = await ds(serve.fetchImpl).mailboxCounts();
    expect(counts.inbox).toBe(2); // a, b (c is spam, d is outbound)
    expect(counts.unread).toBe(1); // a
    expect(counts.sent).toBe(1); // d
    expect(counts.spam).toBe(1); // c
    expect(serve.countsCalls).toBeGreaterThanOrEqual(1);
  });

  it("verificationCandidates pushes the recipient filter to the server", async () => {
    const serve = fakeFastServe(rows);
    const cands = await ds(serve.fetchImpl).verificationCandidates("target@holypaper.com", { limit: 5 });
    // Only inbound mail addressed exactly to target@ (a, c) — newest first.
    expect(cands.map((c) => c.id)).toEqual(["a", "c"]);
    // The server was asked with the direction + to filter (not an unbounded list).
    expect(serve.listCalls.some((s) => s.includes("direction=inbound") && s.includes("to="))).toBe(true);
  });

  it("listMailboxSources uses the server latest_received_at", async () => {
    const serve = fakeFastServe(rows);
    const sources = await ds(serve.fetchImpl).listMailboxSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.latestReceivedAt).toBe("2026-06-03T00:00:00.000Z"); // newest inbound
    expect(sources[0]!.unread).toBe(1);
  });
});

describe("self-hosted fallback (pre-counts serve)", () => {
  // A serve that 404s /messages/counts and IGNORES query filters (old build).
  function fakeOldServe(all: Array<Record<string, unknown>>): SelfHostedFetch {
    return async (url) => {
      const u = new URL(url);
      const ok = (body: unknown, status = 200) => ({ status, async text() { return JSON.stringify(body); } });
      if (u.pathname === "/v1/messages/counts") return ok({ error: "not found" }, 404);
      if (u.pathname === "/v1/messages") {
        const ordered = all.slice().sort((a, b) => String(b["received_at"]).localeCompare(String(a["received_at"])));
        return ok({ messages: ordered });
      }
      return ok({ error: "not found" }, 404);
    };
  }

  it("mailboxCounts falls back to a full scan when counts is unavailable", async () => {
    const counts = await ds(fakeOldServe(rows)).mailboxCounts();
    expect(counts.inbox).toBe(2);
    expect(counts.sent).toBe(1);
  });

  it("verificationCandidates falls back to a scan + exact client filter", async () => {
    const cands = await ds(fakeOldServe(rows)).verificationCandidates("target@holypaper.com", { limit: 5 });
    expect(cands.map((c) => c.id)).toEqual(["a", "c"]);
  });
});
