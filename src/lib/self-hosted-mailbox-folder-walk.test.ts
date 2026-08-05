// FOLDER LISTING AGAINST THE /v1 STORE — the walk that "hung forever".
//
// WHAT HAPPENED (task a3f8e019). `emails inbox list --folder starred|archived|
// spam|trash` against a ~171k-row deployment never returned and was killed at
// 30-90s, while `inbox mailboxes` printed the same folders' counts instantly.
// The cause is in `listFilteredMailboxPage`: folder membership was decided
// ENTIRELY client-side, so a folder whose members are scarce or absent
// (starred: 0, archived: 1, trash: 0 on the deployment that surfaced this)
// walked the ENTIRE store through GET /v1/messages in pages floored at 50 rows
// — ~3,400 sequential round trips — with no progress output, no budget, and no
// error. The server has had an index-backed `?folder=` filter on GET
// /v1/messages since the inbox-perf work (src/server/self-hosted/service.ts
// rejects unknown folder values by name); the client simply never sent it.
//
// THE CONTRACT PINNED HERE:
//  1. the client pushes the folder down to the server (`unread` maps to the
//     server's `inbox` and stays a client-side predicate, because the server
//     enumerates no unread folder);
//  2. a server that predates `?folder=` (ignores it) still gets CORRECT
//     results — client-side filtering is kept as the second gate;
//  3. against such a server the walk is BUDGETED: it refuses loudly with the
//     upgrade path named, instead of walking a six-figure store in silence.

import { describe, expect, it } from "bun:test";
import { SelfHostedMailDataSource, type SelfHostedFetch } from "./self-hosted-mail-data-source.js";

const NEWEST = Date.parse("2026-07-20T00:00:00.000Z");

/** A full /v1 row; list responses project the lean summary off it. */
function row(index: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const at = new Date(NEWEST - index * 1000).toISOString();
  return {
    id: `m-${index}`,
    direction: "inbound",
    from_addr: `"Sender ${index}" <s${index}@example.com>`,
    to_addrs: ["andrei@example.com"],
    cc_addrs: [],
    subject: `subject ${index}`,
    snippet: `snippet ${index}`,
    attachment_count: 0,
    status: "received",
    provider_message_id: null,
    message_id: `<${index}@x>`,
    in_reply_to: null,
    received_at: at,
    is_read: false,
    is_starred: false,
    labels: [],
    source_id: null,
    send_state: "none",
    send_started_at: null,
    created_at: at,
    updated_at: at,
    ...over,
  };
}

function isSpam(r: Record<string, unknown>): boolean {
  return Array.isArray(r["labels"]) && (r["labels"] as unknown[]).includes("spam");
}

function serverFolderMatch(r: Record<string, unknown>, folder: string): boolean {
  const outbound = r["direction"] === "outbound";
  const labels = Array.isArray(r["labels"]) ? (r["labels"] as unknown[]) : [];
  switch (folder) {
    case "inbox": return !outbound && !labels.includes("archived") && !isSpam(r) && !labels.includes("trash");
    case "starred": return !outbound && r["is_starred"] === true && !labels.includes("archived") && !isSpam(r) && !labels.includes("trash");
    case "sent": return outbound;
    case "archived": return !outbound && labels.includes("archived") && !isSpam(r) && !labels.includes("trash");
    case "spam": return !outbound && isSpam(r);
    case "trash": return !outbound && labels.includes("trash");
    default: return false;
  }
}

interface WalkServe {
  fetchImpl: SelfHostedFetch;
  /** every GET /v1/messages request URL, in order */
  listRequests: URL[];
}

/**
 * A cursor-paginated /v1 messages server over `rows` (newest-first).
 * `honorsFolder` distinguishes the current serve (filters and validates
 * `?folder=`) from a deployment that predates the parameter (ignores it).
 */
function walkServe(rows: Array<Record<string, unknown>>, opts: { honorsFolder: boolean }): WalkServe {
  const listRequests: URL[] = [];
  const fetchImpl: SelfHostedFetch = async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const ok = (body: unknown, status = 200) => ({ status, async text() { return JSON.stringify(body); } });
    if (method !== "GET" || u.pathname !== "/v1/messages") return ok({ error: "not found" }, 404);
    listRequests.push(u);

    let pool = rows;
    const direction = u.searchParams.get("direction");
    if (direction) pool = pool.filter((r) => r["direction"] === direction);
    const folder = u.searchParams.get("folder");
    if (folder && opts.honorsFolder) {
      if (!["inbox", "starred", "sent", "archived", "spam", "trash"].includes(folder)) {
        return ok({ error: `folder must be one of inbox, starred, sent, archived, spam, trash` }, 400);
      }
      pool = pool.filter((r) => serverFolderMatch(r, folder));
    }

    const limit = Number(u.searchParams.get("limit") ?? "100");
    const start = Number(u.searchParams.get("cursor") ?? "0");
    const page = pool.slice(start, start + limit);
    const next = start + limit < pool.length ? String(start + limit) : null;
    return ok({ messages: page, next_cursor: next });
  };
  return { fetchImpl, listRequests };
}

function dataSource(serve: WalkServe): SelfHostedMailDataSource {
  return new SelfHostedMailDataSource({
    baseUrl: "https://emails.example/v1",
    apiKey: "test-key",
    fetchImpl: serve.fetchImpl,
  });
}

/** 1,200 plain inbox rows, then 3 spam rows at the OLD end of the store. */
function spamTailStore(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 1200; index += 1) rows.push(row(index));
  for (let index = 1200; index < 1203; index += 1) rows.push(row(index, { labels: ["spam"], status: "spam" }));
  return rows;
}

describe("folder pushdown to GET /v1/messages", () => {
  // STRONG: the folder reaches the wire and the deep-tail spam is found without
  // walking the 1,200 inbox rows in front of it.
  it("sends ?folder= and finds a deep spam tail in one request", async () => {
    const serve = walkServe(spamTailStore(), { honorsFolder: true });
    const ds = dataSource(serve);

    const spam = await ds.listMailbox("spam", { limit: 5 });

    expect(spam.map((m) => m.id)).toEqual(["m-1200", "m-1201", "m-1202"]);
    const folderRequests = serve.listRequests.filter((u) => u.searchParams.get("folder") === "spam");
    expect(folderRequests.length, "no request carried ?folder=spam").toBeGreaterThan(0);
    expect(serve.listRequests.length).toBeLessThanOrEqual(2);
  });

  // STRONG: a folder the server reports as EMPTY answers [] immediately — the
  // truthful empty, not an error and not a store-wide walk.
  it("answers an empty folder with [] after a single filtered request", async () => {
    const serve = walkServe(spamTailStore(), { honorsFolder: true });
    const ds = dataSource(serve);

    const starred = await ds.listMailbox("starred", { limit: 5 });

    expect(starred).toEqual([]);
    expect(serve.listRequests.length).toBeLessThanOrEqual(2);
  });

  // STRONG: `unread` is not a server folder; it must map to the server's inbox
  // and stay a client predicate — and must NOT be sent as `?folder=unread`,
  // which the current serve rejects with a 400 by name.
  it("maps unread onto the server's inbox folder", async () => {
    const rows = [row(0, { is_read: true }), row(1), row(2, { is_read: true }), row(3)];
    const serve = walkServe(rows, { honorsFolder: true });
    const ds = dataSource(serve);

    const unread = await ds.listMailbox("unread", { limit: 10 });

    expect(unread.map((m) => m.id)).toEqual(["m-1", "m-3"]);
    for (const request of serve.listRequests) {
      expect(request.searchParams.get("folder")).not.toBe("unread");
    }
    expect(serve.listRequests.some((u) => u.searchParams.get("folder") === "inbox")).toBe(true);
  });

  // STRONG: `--sort oldest` takes the other walk branch; the pushdown must
  // cover it too or the hang survives under one more flag.
  it("pushes the folder down on the oldest-first branch as well", async () => {
    const serve = walkServe(spamTailStore(), { honorsFolder: true });
    const ds = dataSource(serve);

    const spam = await ds.listMailbox("spam", { limit: 5, sort: "oldest" });

    expect(spam.map((m) => m.id)).toEqual(["m-1202", "m-1201", "m-1200"]);
    expect(serve.listRequests.some((u) => u.searchParams.get("folder") === "spam")).toBe(true);
  });
});

describe("degradation against a server that predates ?folder=", () => {
  // Correctness guard: the second (client-side) gate keeps the results right
  // when the server ignores the parameter.
  it("still answers correctly via client-side filtering", async () => {
    const serve = walkServe(spamTailStore(), { honorsFolder: false });
    const ds = dataSource(serve);

    const spam = await ds.listMailbox("spam", { limit: 5 });

    expect(spam.map((m) => m.id)).toEqual(["m-1200", "m-1201", "m-1202"]);
  });

  // STRONG: the walk is BUDGETED. A store too large to filter client-side
  // refuses loudly, naming the upgrade path — it does not walk six figures of
  // rows in silence. (On the code this suite was written against, this case
  // walked every page and returned [] as if the folder were empty.)
  it("refuses with the upgrade path named instead of walking a huge store", async () => {
    // No starred rows at all, and more rows than any sane client walk.
    const rows: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 110_000; index += 1) rows.push(row(index));
    const serve = walkServe(rows, { honorsFolder: false });
    const ds = dataSource(serve);

    const failure = ds.listMailbox("starred", { limit: 5 });

    await expect(failure).rejects.toThrow(/folder/);
    await expect(failure).rejects.toThrow(/\?folder=|upgrade/i);
  }, 120_000);
});
