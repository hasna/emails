import { describe, expect, test } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../generated/storage-kit/index.js";
import { EmailsSelfHostedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { emailsSelfHostedMigrations } from "./migrations.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

// Column order the store inserts with (see EmailsSelfHostedStore.INSERT_COLS).
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
    async many<T>(sql: string, _params?: readonly unknown[]): Promise<T[]> {
      if (sql.includes("SELECT 1")) return [{ ok: 1 } as unknown as T];
      if (sql.includes("FROM messages")) {
        const sorted = [...rows].sort((a, b) => {
          const av = String(a["received_at"] ?? a["created_at"] ?? "");
          const bv = String(b["received_at"] ?? b["created_at"] ?? "");
          return bv.localeCompare(av);
        });
        return sorted as unknown as T[];
      }
      return [] as T[];
    },
    async get<T>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      if (sql.includes("FROM messages WHERE id")) {
        const id = (params ?? [])[0];
        return (rows.find((r) => r["id"] === id) as unknown as T) ?? null;
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

function deps(): SelfHostedServiceDeps {
  const { client } = messagesClient();
  return {
    client,
    store: new EmailsSelfHostedStore(client),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => "provider-message-id" },
    migrations: emailsSelfHostedMigrations(),
    version: "9.9.9",
  };
}

function writeToken(): string {
  return mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET }).token;
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

describe("Emails self-hosted inbound messages", () => {
  test("migration set includes the inbound schema migration", () => {
    const ids = emailsSelfHostedMigrations().map((m) => m.id);
    expect(ids).toContain("0002_emails_messages_inbound");
    // Inbound must come after the core message table.
    expect(ids.indexOf("0002_emails_messages_inbound")).toBeGreaterThan(
      ids.indexOf("0001_emails_selfhosted_core"),
    );
  });

  test("POST inbound preserves all fields and returns 201", async () => {
    const res = await handleSelfHostedRequest(deps(), post(INBOUND));
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
    const res = await handleSelfHostedRequest(deps(), post({ ...noDirection, source_id: "x" }));
    const msg = (await res!.json()).message;
    expect(msg.direction).toBe("inbound");
  });

  test("re-POST with the same source_id is idempotent (upsert, no duplicate)", async () => {
    const d = deps();
    const first = await handleSelfHostedRequest(d, post(INBOUND));
    expect(first?.status).toBe(201);
    const second = await handleSelfHostedRequest(d, post({ ...INBOUND, is_read: true }));
    expect(second?.status).toBe(200); // updated, not created
    const list = await handleSelfHostedRequest(d, req(d, "GET"));
    const body = await list!.json();
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].is_read).toBe(true); // reflects the update
  });

  test("GET /v1/messages orders by original receipt time (newest first)", async () => {
    const d = deps();
    await handleSelfHostedRequest(d, post({ ...INBOUND, source_id: "older", received_at: "2026-06-01T00:00:00.000Z" }));
    await handleSelfHostedRequest(d, post({ ...INBOUND, source_id: "newer", received_at: "2026-06-30T00:00:00.000Z" }));
    const list = await handleSelfHostedRequest(d, req(d, "GET"));
    const msgs = (await list!.json()).messages;
    expect(msgs.map((m: { source_id: string }) => m.source_id)).toEqual(["newer", "older"]);
  });

  test("outbound ledger-only writes are rejected", async () => {
    const res = await handleSelfHostedRequest(
      deps(),
      post({ from: "me@hasna.com", to: ["you@x.com"], subject: "hi", text: "yo" }),
    );
    expect(res?.status).toBe(409);
    expect((await res!.json()).error).toContain("/v1/messages/send");
  });

  test("send endpoint invokes the configured provider before persisting", async () => {
    const d = deps();
    const sent: unknown[] = [];
    d.sender = { provider: "ses", send: async (input) => { sent.push(input); return "ses-message-1"; } };
    const res = await handleSelfHostedRequest(d, new Request("http://svc/v1/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": writeToken() },
      body: JSON.stringify({ from: "me@example.com", to: ["you@example.com"], subject: "hi", text: "yo" }),
    }));
    expect(res?.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect((await res!.json()).message.provider_message_id).toBe("ses-message-1");
  });

  test("POST still requires from and to", async () => {
    const noFrom = await handleSelfHostedRequest(deps(), post({ to: ["a@b.com"] }));
    expect(noFrom?.status).toBe(400);
    const noTo = await handleSelfHostedRequest(deps(), post({ from: "a@b.com" }));
    expect(noTo?.status).toBe(400);
  });
});

function req(d: SelfHostedServiceDeps, method: string): Request {
  void d;
  return new Request("http://svc/v1/messages", {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": writeToken() },
  });
}
