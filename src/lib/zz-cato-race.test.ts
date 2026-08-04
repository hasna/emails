// TEMPORARY reviewer probe (PR #198, hasna/emails). Not for merge.
// Question: does invalidate() actually drop the label tally when a walk is
// already in flight? The PR claims "invalidate() drops the tally, since
// labelling changes it".
import { describe, expect, it } from "bun:test";
import {
  SelfHostedMailDataSource,
  type SelfHostedFetch,
} from "./self-hosted-mail-data-source.js";

// Copied verbatim from self-hosted-mail-data-source.test.ts so the wire
// validator accepts these rows.
function v1(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const numericId = /^\d+$/.test(id) ? Number(id) : 0;
  const day = String(10 + (numericId % 18)).padStart(2, "0");
  return {
    id,
    direction: "inbound",
    from_addr: `"Sender ${id}" <s${id}@example.com>`,
    to_addrs: ["andrei@example.com"],
    cc_addrs: [],
    subject: `subject ${id}`,
    body_text: `body of ${id}`,
    body_html: null,
    status: "received",
    provider_message_id: null,
    message_id: `<${id}@x>`,
    in_reply_to: null,
    received_at: `2026-06-${day}T08:00:00.000Z`,
    is_read: false,
    is_starred: false,
    labels: [],
    headers: {},
    attachments: [],
    source_id: null,
    send_state: "none",
    send_started_at: null,
    created_at: `2026-06-${day}T08:00:01.000Z`,
    updated_at: `2026-06-${day}T08:00:01.000Z`,
    ...over,
  };
}

function listV1(row: Record<string, unknown>): Record<string, unknown> {
  const { body_text: bodyText, body_html: _bodyHtml, headers, attachments, ...summary } = row;
  const denial = headers && typeof headers === "object" && !Array.isArray(headers)
    ? (headers as Record<string, unknown>)["policy_denial"]
    : undefined;
  return {
    ...summary,
    snippet: typeof bodyText === "string" ? bodyText.replace(/\s+/g, " ").trim().slice(0, 140) : null,
    attachment_count: Array.isArray(attachments) ? attachments.length : 0,
    policy_denial: typeof denial === "string" && denial.trim() ? denial.trim() : null,
  };
}

// A 3-page store — inside the 10-request budget, so the walk COMPLETES and
// therefore writes the cache. `gate`, when armed, holds the first GET open so a
// write can land while the walk is genuinely in flight.
function serve() {
  const gets: string[] = [];
  const patches: string[] = [];
  let gate: Promise<void> | null = null;
  let firstGetSeen: (() => void) | null = null;

  const fetchImpl: SelfHostedFetch = async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const ok = (body: unknown, status = 200) => ({ status, async text() { return JSON.stringify(body); } });

    if (method === "PATCH") {
      patches.push(u.pathname);
      return ok({ message: v1("1", { labels: ["added"] }) });
    }
    if (method !== "GET" || u.pathname !== "/v1/messages") return ok({ error: "not found" }, 404);

    const cursor = u.searchParams.get("cursor") ?? "";
    const index = cursor === "" ? 0 : Number(cursor.slice("page-".length));
    gets.push(`GET page ${index}`);
    if (index === 0 && gate) {
      firstGetSeen?.();
      await gate;
    }
    const messages = [listV1(v1(`${index}`, { labels: ["urgent"] }))];
    return ok({ messages, next_cursor: index + 1 < 3 ? `page-${index + 1}` : null });
  };

  return {
    fetchImpl,
    gets,
    patches,
    armGate() {
      let release!: () => void;
      const reached = new Promise<void>((r) => { firstGetSeen = r; });
      gate = new Promise<void>((r) => { release = r; });
      return { reached, release: () => { gate = null; release(); } };
    },
  };
}

function makeDs(fetchImpl: SelfHostedFetch, now: () => number) {
  return new SelfHostedMailDataSource({
    baseUrl: "https://emails.example/v1",
    apiKey: "test-key",
    fetchImpl,
    now,
  });
}

describe("PR#198 probe — invalidate() vs an in-flight label walk", () => {
  it("CONTROL: with no walk in flight, a write does force a re-walk", async () => {
    const s = serve();
    let clock = 1_000_000;
    const src = makeDs(s.fetchImpl, () => clock);

    await src.listLabelSummaries({ limit: 80 });
    const afterFirstWalk = s.gets.length;
    expect(afterFirstWalk).toBeGreaterThan(0);

    await src.addLabel("1", "added"); // invalidate() with nothing in flight
    clock += 1_000; // far inside the 60s TTL

    await src.listLabelSummaries({ limit: 80 });
    const afterWrite = s.gets.length;

    console.log(`CONTROL gets: firstWalk=${afterFirstWalk} afterWrite=${afterWrite} patches=${s.patches.length}`);
    // The probe can SEE a re-walk. Without this arm the race arm proves nothing.
    expect(afterWrite).toBeGreaterThan(afterFirstWalk);
  });

  it("RACE: a write DURING a walk is defeated — the stale tally is cached anyway", async () => {
    const s = serve();
    let clock = 2_000_000;
    const src = makeDs(s.fetchImpl, () => clock);

    const { reached, release } = s.armGate();
    const walking = src.listLabelSummaries({ limit: 80 }); // starts, blocks on page 0
    await reached;

    await src.addLabel("1", "added"); // invalidate() runs mid-walk
    expect(s.patches.length).toBe(1);

    release();
    await walking;
    const afterWalk = s.gets.length;

    clock += 1_000; // inside the 60s TTL
    await src.listLabelSummaries({ limit: 80 });
    const afterWrite = s.gets.length;

    console.log(`RACE gets: walk=${afterWalk} afterPostWriteRead=${afterWrite} patches=${s.patches.length}`);
    // If invalidate() were honoured, this read would re-walk exactly like the control.
    expect(afterWrite).toBeGreaterThan(afterWalk);
  });
});
