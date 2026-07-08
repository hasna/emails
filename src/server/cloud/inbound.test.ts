import { describe, expect, test } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../generated/storage-kit/index.js";
import { MaileryCloudStore } from "./store.js";
import { handleCloudRequest, type CloudServiceDeps } from "./service.js";
import { maileryCloudMigrations } from "./migrations.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

// Column order the store inserts with (see MaileryCloudStore.INSERT_COLS).
const COLS = [
  "id", "direction", "from_addr", "to_addrs", "cc_addrs", "subject", "body_text",
  "body_html", "status", "provider_message_id", "message_id", "in_reply_to",
  "received_at", "is_read", "is_starred", "labels", "headers", "attachments", "source_id",
];

/**
 * In-memory query client that models JUST the `messages` table well enough to
 * exercise insert, ON CONFLICT (source_id) upsert, list ordering, and get-by-id.
 */
function messagesClient(): { client: TypedQueryClient; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];

  function rowFromParams(params: readonly unknown[]): Record<string, unknown> {
    const r: Record<string, unknown> = {};
    COLS.forEach((c, i) => (r[c] = params[i] ?? null));
    const now = new Date().toISOString();
    r["created_at"] = now;
    r["updated_at"] = now;
    return r;
  }

  const client: TypedQueryClient = {
    async query(sql, params) {
      const rowsOut = (await client.many(sql, params)) as never[];
      return { rows: rowsOut, rowCount: rowsOut.length };
    },
    async many<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      if (sql.includes("SELECT 1")) return [{ ok: 1 } as unknown as T];
      if (sql.includes("FROM messages")) {
        let out = [...rows];
        // Server-side direction/to filters (additive: absent -> full list).
        if (sql.includes("<> 'outbound'")) {
          out = out.filter((r) => String(r["direction"] ?? "").toLowerCase() !== "outbound");
        } else if (sql.includes("= 'outbound'")) {
          out = out.filter((r) => String(r["direction"] ?? "").toLowerCase() === "outbound");
        }
        const like = (params ?? []).find((p) => typeof p === "string" && p.startsWith("%") && p.endsWith("%"));
        if (like) {
          const needle = String(like).slice(1, -1).toLowerCase();
          out = out.filter((r) => JSON.stringify(r["to_addrs"] ?? []).toLowerCase().includes(needle));
        }
        out.sort((a, b) => {
          const av = String(a["received_at"] ?? a["created_at"] ?? "");
          const bv = String(b["received_at"] ?? b["created_at"] ?? "");
          return bv.localeCompare(av);
        });
        return out as unknown as T[];
      }
      return [] as T[];
    },
    async get<T>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      if (sql.includes("FROM messages WHERE id")) {
        const id = (params ?? [])[0];
        return (rows.find((r) => r["id"] === id) as unknown as T) ?? null;
      }
      // messageCounts() aggregate: mirror the folder predicates. In real
      // Postgres `labels` is JSONB (parsed to an array); the mock stores the
      // JSON string, so parse it here to emulate the driver.
      if (sql.includes("WITH m AS")) {
        const isOut = (r: Record<string, unknown>) => String(r["direction"] ?? "").toLowerCase() === "outbound";
        const labelsOf = (r: Record<string, unknown>): string[] => {
          const l = r["labels"];
          if (Array.isArray(l)) return l as string[];
          if (typeof l === "string") { try { const p = JSON.parse(l); return Array.isArray(p) ? p : []; } catch { return []; } }
          return [];
        };
        const has = (r: Record<string, unknown>, l: string) => labelsOf(r).includes(l);
        const isSpam = (r: Record<string, unknown>) => has(r, "spam") || String(r["status"] ?? "").toLowerCase() === "spam";
        const inbox = rows.filter((r) => !isOut(r) && !has(r, "archived") && !isSpam(r) && !has(r, "trash"));
        const latest = rows
          .filter((r) => !isOut(r))
          .map((r) => String(r["received_at"] ?? r["created_at"] ?? ""))
          .filter(Boolean)
          .sort()
          .at(-1) ?? null;
        return {
          inbox: String(inbox.length),
          unread: String(inbox.filter((r) => !r["is_read"]).length),
          starred: String(rows.filter((r) => r["is_starred"] && !has(r, "trash")).length),
          sent: String(rows.filter(isOut).length),
          archived: String(rows.filter((r) => has(r, "archived")).length),
          spam: String(rows.filter(isSpam).length),
          trash: String(rows.filter((r) => has(r, "trash")).length),
          total: String(rows.length),
          latest_received_at: latest,
        } as unknown as T;
      }
      return null;
    },
    async one<T>(sql: string, params?: readonly unknown[]): Promise<T> {
      if (sql.includes("INSERT INTO messages")) {
        const incoming = rowFromParams(params ?? []);
        const isUpsert = sql.includes("ON CONFLICT (source_id)");
        if (isUpsert && incoming["source_id"] != null) {
          const existing = rows.find((r) => r["source_id"] === incoming["source_id"]);
          if (existing) {
            for (const c of COLS) if (c !== "id") existing[c] = incoming[c];
            existing["updated_at"] = new Date().toISOString();
            return { ...existing, inserted: false } as unknown as T;
          }
        }
        rows.push(incoming);
        return { ...incoming, inserted: true } as unknown as T;
      }
      throw new Error(`unexpected one() SQL: ${sql.slice(0, 40)}`);
    },
    async execute() {},
  };
  return { client, rows };
}

function deps(): CloudServiceDeps {
  const { client } = messagesClient();
  return {
    client,
    store: new MaileryCloudStore(client),
    verifier: verifyApiKey({ app: "mailery", signingSecret: SIGNING_SECRET }),
    migrations: maileryCloudMigrations(),
    version: "9.9.9",
  };
}

function writeToken(): string {
  return mintApiKey({ app: "mailery", scopes: ["mailery:*"], signingSecret: SIGNING_SECRET }).token;
}

function post(body: unknown, token = writeToken()): Request {
  return new Request("http://svc/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": token },
    body: JSON.stringify(body),
  });
}

const INBOUND = {
  from: '"Facebook" <friendsuggestion@facebookmail.com>',
  to: ["andrei@hasna.com"],
  cc: ["team@hasna.com"],
  subject: "Oana is a new friend suggestion",
  text: "plain body",
  html: "<p>html body</p>",
  status: "received",
  direction: "inbound",
  received_at: "2026-06-18T19:51:35.000Z",
  message_id: "<abc123@facebookmail.com>",
  in_reply_to: "<parent@x.com>",
  is_read: false,
  is_starred: true,
  labels: ["social", "facebook"],
  headers: { "x-spam-score": "0.1" },
  attachments: [{ filename: "a.png", size: 12 }],
  source_id: "local-row-1",
};

describe("mailery cloud inbound messages", () => {
  test("migration set includes the inbound schema migration", () => {
    const ids = maileryCloudMigrations().map((m) => m.id);
    expect(ids).toContain("0002_mailery_messages_inbound");
    // Inbound must come after the core message table.
    expect(ids.indexOf("0002_mailery_messages_inbound")).toBeGreaterThan(
      ids.indexOf("0001_mailery_selfhosted_core"),
    );
  });

  test("POST inbound preserves all fields and returns 201", async () => {
    const res = await handleCloudRequest(deps(), post(INBOUND));
    expect(res?.status).toBe(201);
    const msg = (await res!.json()).message;
    expect(msg.direction).toBe("inbound");
    expect(msg.from_addr).toBe(INBOUND.from);
    expect(msg.to_addrs).toEqual(["andrei@hasna.com"]);
    expect(msg.cc_addrs).toEqual(["team@hasna.com"]);
    expect(msg.subject).toBe(INBOUND.subject);
    expect(msg.body_text).toBe("plain body");
    expect(msg.body_html).toBe("<p>html body</p>");
    expect(msg.received_at).toBe(INBOUND.received_at);
    expect(msg.message_id).toBe(INBOUND.message_id);
    expect(msg.in_reply_to).toBe(INBOUND.in_reply_to);
    expect(msg.is_read).toBe(false);
    expect(msg.is_starred).toBe(true);
    expect(msg.labels).toEqual(["social", "facebook"]);
    expect(msg.headers).toEqual({ "x-spam-score": "0.1" });
    expect(msg.attachments).toEqual([{ filename: "a.png", size: 12 }]);
    expect(msg.source_id).toBe("local-row-1");
  });

  test("inbound is inferred from received_at when direction is omitted", async () => {
    const { direction: _omit, ...noDirection } = INBOUND;
    const res = await handleCloudRequest(deps(), post({ ...noDirection, source_id: "x" }));
    const msg = (await res!.json()).message;
    expect(msg.direction).toBe("inbound");
  });

  test("re-POST with the same source_id is idempotent (upsert, no duplicate)", async () => {
    const d = deps();
    const first = await handleCloudRequest(d, post(INBOUND));
    expect(first?.status).toBe(201);
    const second = await handleCloudRequest(d, post({ ...INBOUND, is_read: true }));
    expect(second?.status).toBe(200); // updated, not created
    const list = await handleCloudRequest(d, req(d, "GET"));
    const body = await list!.json();
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].is_read).toBe(true); // reflects the update
  });

  test("GET /v1/messages orders by original receipt time (newest first)", async () => {
    const d = deps();
    await handleCloudRequest(d, post({ ...INBOUND, source_id: "older", received_at: "2026-06-01T00:00:00.000Z" }));
    await handleCloudRequest(d, post({ ...INBOUND, source_id: "newer", received_at: "2026-06-30T00:00:00.000Z" }));
    const list = await handleCloudRequest(d, req(d, "GET"));
    const msgs = (await list!.json()).messages;
    expect(msgs.map((m: { source_id: string }) => m.source_id)).toEqual(["newer", "older"]);
  });

  test("outbound message without inbound fields still works (backward compatible)", async () => {
    const res = await handleCloudRequest(
      deps(),
      post({ from: "me@hasna.com", to: ["you@x.com"], subject: "hi", text: "yo" }),
    );
    expect(res?.status).toBe(201);
    const msg = (await res!.json()).message;
    expect(msg.direction).toBe("outbound");
    expect(msg.received_at).toBeNull();
    expect(msg.source_id).toBeNull();
  });

  test("POST still requires from and to", async () => {
    const noFrom = await handleCloudRequest(deps(), post({ to: ["a@b.com"] }));
    expect(noFrom?.status).toBe(400);
    const noTo = await handleCloudRequest(deps(), post({ from: "a@b.com" }));
    expect(noTo?.status).toBe(400);
  });

  test("GET /v1/messages/counts returns per-folder counts", async () => {
    const d = deps();
    await handleCloudRequest(d, post({ ...INBOUND, source_id: "in1", is_read: false, labels: [] }));
    await handleCloudRequest(d, post({ ...INBOUND, source_id: "in2", is_read: true, labels: [] }));
    await handleCloudRequest(d, post({ ...INBOUND, source_id: "spam1", labels: ["spam"] }));
    await handleCloudRequest(d, post({ from: "me@x.com", to: ["y@x.com"], subject: "s", text: "t" })); // outbound
    const res = await handleCloudRequest(d, new Request("http://svc/v1/messages/counts", {
      headers: { "x-api-key": writeToken() },
    }));
    expect(res?.status).toBe(200);
    const counts = (await res!.json()).counts;
    expect(counts.inbox).toBe(2);
    expect(counts.unread).toBe(1);
    expect(counts.spam).toBe(1);
    expect(counts.sent).toBe(1);
    expect(counts.total).toBe(4);
    expect(typeof counts.latest_received_at === "string" || counts.latest_received_at === null).toBe(true);
  });

  test("GET /v1/messages?direction= filters inbound vs outbound", async () => {
    const d = deps();
    await handleCloudRequest(d, post({ ...INBOUND, source_id: "inb" }));
    await handleCloudRequest(d, post({ from: "me@x.com", to: ["y@x.com"], subject: "s", text: "t" }));
    const inbound = await handleCloudRequest(d, new Request("http://svc/v1/messages?direction=inbound", { headers: { "x-api-key": writeToken() } }));
    const inMsgs = (await inbound!.json()).messages;
    expect(inMsgs.every((m: { direction: string }) => m.direction !== "outbound")).toBe(true);
    const outbound = await handleCloudRequest(d, new Request("http://svc/v1/messages?direction=outbound", { headers: { "x-api-key": writeToken() } }));
    const outMsgs = (await outbound!.json()).messages;
    expect(outMsgs.every((m: { direction: string }) => m.direction === "outbound")).toBe(true);
  });

  test("GET /v1/messages?to= filters by recipient", async () => {
    const d = deps();
    await handleCloudRequest(d, post({ ...INBOUND, source_id: "toandrei", to: ["andrei@hasna.com"] }));
    await handleCloudRequest(d, post({ ...INBOUND, source_id: "toother", to: ["someone@else.com"] }));
    const res = await handleCloudRequest(d, new Request("http://svc/v1/messages?to=andrei@hasna.com", { headers: { "x-api-key": writeToken() } }));
    const msgs = (await res!.json()).messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].to_addrs).toEqual(["andrei@hasna.com"]);
  });
});

function req(d: CloudServiceDeps, method: string): Request {
  void d;
  return new Request("http://svc/v1/messages", {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": writeToken() },
  });
}
