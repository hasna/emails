import { afterEach, describe, expect, it } from "bun:test";
import {
  SelfHostedMailDataSource,
  type SelfHostedFetch,
  resolveSelfHostedMailDataSource,
} from "./self-hosted-mail-data-source.js";
import { resetCloudConfigCache } from "../db/cloud-store.js";
import { resetMailDataSource, resolveMailDataSource } from "./mail-data-source.js";

// A self-hosted /v1 message row (snake_case, as mailery.hasna.xyz returns).
function v1(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    direction: "inbound",
    from_addr: `"Sender ${id}" <s${id}@example.com>`,
    to_addrs: ["andrei@hasna.com"],
    cc_addrs: [],
    subject: `subject ${id}`,
    body_text: `body of ${id}`,
    body_html: null,
    status: "received",
    provider_message_id: null,
    message_id: `<${id}@x>`,
    in_reply_to: null,
    received_at: `2026-06-1${id}T08:00:00.000Z`,
    is_read: false,
    is_starred: false,
    labels: [],
    headers: {},
    created_at: `2026-06-1${id}T08:00:01.000Z`,
    updated_at: `2026-06-1${id}T08:00:01.000Z`,
    ...over,
  };
}

// A fake self-hosted /v1 serve backed by an in-memory row list.
function fakeServe(initial: Array<Record<string, unknown>>): { fetchImpl: SelfHostedFetch; rows: Map<string, Record<string, unknown>>; posted: unknown[]; deleted: string[] } {
  const rows = new Map(initial.map((r) => [r["id"] as string, r]));
  const posted: unknown[] = [];
  const deleted: string[] = [];
  const fetchImpl: SelfHostedFetch = async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const ok = (body: unknown, status = 200) => ({ status, async text() { return JSON.stringify(body); } });
    const list = () => {
      const ordered = [...rows.values()].sort((a, b) =>
        String(b["received_at"]).localeCompare(String(a["received_at"])));
      const limit = Number(u.searchParams.get("limit") ?? "500");
      const offset = Number(u.searchParams.get("offset") ?? "0");
      return ordered.slice(offset, offset + limit);
    };
    const idMatch = u.pathname.match(/^\/v1\/messages\/(.+)$/);
    if (u.pathname === "/v1/messages" && method === "GET") return ok({ messages: list() });
    if (u.pathname === "/v1/messages" && method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      const id = `posted-${posted.length}`;
      const rec = { id, message_id: `<${id}@x>`, ...body };
      rows.set(id, rec);
      return ok({ message: rec }, 201);
    }
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]!);
      if (method === "GET") return rows.has(id) ? ok({ message: rows.get(id) }) : ok({ error: "not found" }, 404);
      if (method === "DELETE") { const had = rows.delete(id); deleted.push(id); return had ? ok({ deleted: true }) : ok({ error: "not found" }, 404); }
      if (method === "PATCH") return rows.has(id) ? ok({ message: rows.get(id) }) : ok({ error: "not found" }, 404);
    }
    return ok({ error: "not found" }, 404);
  };
  return { fetchImpl, rows, posted, deleted };
}

function make(rows: Array<Record<string, unknown>>): { ds: SelfHostedMailDataSource; serve: ReturnType<typeof fakeServe> } {
  const serve = fakeServe(rows);
  const ds = new SelfHostedMailDataSource({ baseUrl: "https://mailery.hasna.xyz/v1", apiKey: "test-key", fetchImpl: serve.fetchImpl });
  return { ds, serve };
}

afterEach(() => {
  resetMailDataSource();
  resetCloudConfigCache();
  delete process.env["HASNA_MAILERY_API_URL"];
  delete process.env["HASNA_MAILERY_API_KEY"];
  delete process.env["MAILERY_API_URL"];
  delete process.env["MAILERY_API_KEY"];
});

describe("SelfHostedMailDataSource — /v1 resource mapping", () => {
  it("lists inbox mapping snake_case rows to TuiMessage, newest first", async () => {
    const { ds } = make([v1("2"), v1("5"), v1("3")]);
    const msgs = await ds.listMailbox("inbox");
    expect(msgs.map((m) => m.id)).toEqual(["5", "3", "2"]);
    const top = msgs[0]!;
    expect(top.from).toBe('"Sender 5" <s5@example.com>');
    expect(top.to).toBe("andrei@hasna.com");
    expect(top.subject).toBe("subject 5");
    expect(top.date).toBe("2026-06-15T08:00:00.000Z");
    expect(top.is_read).toBe(false);
    expect(top.kind).toBe("inbound");
  });

  it("filters the unread folder and honors a substring search", async () => {
    const { ds } = make([v1("2", { is_read: true }), v1("5"), v1("3", { subject: "Oana friend suggestion" })]);
    const unread = await ds.listMailbox("unread");
    expect(unread.map((m) => m.id).sort()).toEqual(["3", "5"]);
    const hits = await ds.listMailbox("inbox", { search: "oana" });
    expect(hits.map((m) => m.id)).toEqual(["3"]);
  });

  it("separates sent (outbound) from inbox", async () => {
    const { ds } = make([v1("2"), v1("5", { direction: "outbound" })]);
    expect((await ds.listMailbox("inbox")).map((m) => m.id)).toEqual(["2"]);
    const sent = await ds.listMailbox("sent");
    expect(sent.map((m) => m.id)).toEqual(["5"]);
    expect(sent[0]!.kind).toBe("sent");
  });

  it("computes mailbox counts across folders", async () => {
    const { ds } = make([v1("2"), v1("3", { is_read: true }), v1("5", { is_starred: true })]);
    const counts = await ds.mailboxCounts();
    expect(counts.inbox).toBe(3);
    expect(counts.unread).toBe(2);
    expect(counts.starred).toBe(1);
  });

  it("resolves a full id verbatim and a unique prefix by scan", async () => {
    const full = "31f40200-dc2c-48ba-a348-ed7d4414381e";
    const { ds } = make([v1("2"), { ...v1("9"), id: full }]);
    expect(await ds.resolveId(full)).toBe(full);
    expect(await ds.resolveId("31f40200")).toBe(full);
  });

  it("gets a message + body by id", async () => {
    const { ds } = make([v1("5", { body_text: "hello world", cc_addrs: ["cc@x.com"] })]);
    const msg = await ds.getMessage("5");
    expect(msg?.subject).toBe("subject 5");
    const body = await ds.getMessageBody(msg!);
    expect(body?.text).toBe("hello world");
    expect(body?.cc).toBe("cc@x.com");
  });

  it("sends via POST /messages and deletes via DELETE", async () => {
    const { ds, serve } = make([]);
    const res = await ds.send({ to: "a@x.com, b@x.com", from: "me@hasna.com", subject: "hi", body: "yo", markdown: false });
    expect(res.id).toBe("posted-1");
    expect(serve.posted).toHaveLength(1);
    expect((serve.posted[0] as { to: string[] }).to).toEqual(["a@x.com", "b@x.com"]);
    await ds.deleteMessage("posted-1");
    expect(serve.deleted).toContain("posted-1");
  });

  it("returns verification candidates scoped to the recipient address", async () => {
    const { ds } = make([
      v1("2", { to_addrs: ["andrei@hasna.com"], subject: "code 123456" }),
      v1("3", { to_addrs: ["other@hasna.com"], subject: "nope" }),
    ]);
    const cands = await ds.verificationCandidates("andrei@hasna.com");
    expect(cands.map((c) => c.id)).toEqual(["2"]);
  });

  it("throws honestly for writes the self-hosted serve cannot persist yet", async () => {
    const { ds } = make([v1("2")]);
    await expect(ds.setStarred("2", true)).rejects.toThrow(/not yet supported/);
    await expect(ds.addLabel("2", "x")).rejects.toThrow(/not yet supported/);
  });

  it("fails fast and loud (never hangs) when the serve stalls past the timeout", async () => {
    // A fetch that respects the AbortSignal, resolving only when aborted — models
    // a hung endpoint. With a tiny timeout the read must REJECT, never hang, and
    // never resolve to an empty list with a success exit.
    const hangingFetch: SelfHostedFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      }) as unknown as ReturnType<SelfHostedFetch>;
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://mailery.hasna.xyz/v1",
      apiKey: "test-key",
      fetchImpl: hangingFetch,
      timeoutMs: 25,
    });
    const started = Date.now();
    await expect(ds.listMailbox("inbox")).rejects.toThrow(/timed out after 25ms/);
    // Well under any external 2-minute wall.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("resolveMailDataSource — self-hosted seam selection", () => {
  it("selects the self-hosted source only when HASNA_MAILERY_* creds are present", () => {
    // The flip contract sets creds and NO mode var; an explicit `local` mode would
    // (correctly) force local, so clear any inherited local override for this case.
    delete process.env["MAILERY_MODE"];
    delete process.env["HASNA_EMAILS_MODE"];
    delete process.env["MAILERY_STORAGE_MODE"];
    delete process.env["HASNA_EMAILS_STORAGE_MODE"];
    process.env["HASNA_MAILERY_API_URL"] = "https://mailery.hasna.xyz";
    process.env["HASNA_MAILERY_API_KEY"] = "k";
    resetCloudConfigCache();
    resetMailDataSource();
    const ds = resolveMailDataSource();
    expect(ds.constructor.name).toBe("SelfHostedMailDataSource");
    expect(ds.mode).toBe("cloud");
    expect(resolveSelfHostedMailDataSource()).toBeInstanceOf(SelfHostedMailDataSource);
  });

  it("does NOT engage the self-hosted seam for the bare SaaS MAILERY_API_URL", () => {
    process.env["MAILERY_API_URL"] = "https://mailery.co";
    process.env["MAILERY_API_KEY"] = "k";
    resetCloudConfigCache();
    resetMailDataSource();
    expect(resolveSelfHostedMailDataSource()).toBeNull();
  });
});
