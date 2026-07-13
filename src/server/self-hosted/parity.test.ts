// Server-side coverage for the self-hosted-only PARITY additions:
//   * the new generic /v1 resources (aliases, forwarding, warming, triage,
//     provisioning, sources, events, email-agents, email-agent-runs,
//     email-digests) — routing, scope enforcement, and JSON/bool/int/num
//     column round-trips through a table-aware in-memory fake;
//   * the natural-key (agent_key) resource whose create upserts (idempotent);
//   * the mail-view endpoints (threads / mailboxes / raw); and
//   * domain/address provisioning fields flowing through PATCH.

import { describe, expect, test } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { EmailsSelfHostedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { emailsSelfHostedMigrations } from "./migrations.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

/**
 * In-memory fake that emulates generic INSERT (plain + ON CONFLICT DO NOTHING),
 * SELECT-by-key, UPDATE ... SET (applied), and DELETE for arbitrary tables,
 * with JSONB round-tripping. It understands a configurable key column, so it
 * covers both UUID-keyed and natural-key (agent_key) resources.
 */
function tableClient(): TypedQueryClient {
  const tables = new Map<string, Record<string, unknown>[]>();
  const tableOf = (sql: string): string => sql.match(/(?:FROM|INTO|UPDATE)\s+([a-z_]+)/i)?.[1] ?? "";
  const whereKey = (sql: string): string => sql.match(/WHERE\s+([a-z_]+)\s*=\s*\$1/i)?.[1] ?? "id";

  /** Parse an INSERT into a stored row (JSONB placeholders decoded). */
  const buildInsertRow = (sql: string, params: readonly unknown[]): Record<string, unknown> => {
    const cols = (sql.match(/INSERT INTO [a-z_]+ \(([^)]+)\)/i)?.[1] ?? "").split(",").map((c) => c.trim());
    const valueTokens = (sql.match(/VALUES \(([^)]+)\)/i)?.[1] ?? "").split(",").map((t) => t.trim());
    const row: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      let v = params[i];
      if (/::jsonb/i.test(valueTokens[i] ?? "") && typeof v === "string") {
        try { v = JSON.parse(v); } catch { /* leave */ }
      }
      row[c] = v;
    });
    return row;
  };

  const client: TypedQueryClient = {
    async query(sql, params) {
      const rows = (await client.many(sql, params)) as never[];
      return { rows, rowCount: rows.length };
    },
    async many<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      const t = tableOf(sql);
      const rows = tables.get(t) ?? [];
      if (/^\s*DELETE/i.test(sql)) {
        const key = whereKey(sql);
        const id = (params ?? [])[0];
        const removed = rows.filter((r) => r[key] === id);
        tables.set(t, rows.filter((r) => r[key] !== id));
        return removed.map((r) => ({ id: r[key] })) as unknown as T[];
      }
      return rows as unknown as T[];
    },
    async get<T>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      const t = tableOf(sql);
      const rows = tables.get(t) ?? [];
      if (/^\s*INSERT/i.test(sql)) {
        const conflictKey = sql.match(/ON CONFLICT \(([a-z_]+)\)/i)?.[1];
        const row = buildInsertRow(sql, params ?? []);
        if (conflictKey && rows.some((r) => r[conflictKey] === row[conflictKey])) return null; // DO NOTHING
        rows.push(row);
        tables.set(t, rows);
        return row as unknown as T;
      }
      const key = whereKey(sql);
      const target = rows.find((r) => r[key] === (params ?? [])[0]);
      if (/^\s*UPDATE/i.test(sql)) {
        if (!target) return null;
        for (const m of sql.matchAll(/([a-z_]+)\s*=\s*\$(\d+)(::jsonb)?/gi)) {
          const col = m[1]!;
          if (col === "updated_at") continue;
          let v = (params ?? [])[Number(m[2]) - 1];
          if (m[3] && typeof v === "string") { try { v = JSON.parse(v); } catch { /* leave */ } }
          target[col] = v;
        }
        return target as unknown as T;
      }
      return (target as unknown as T) ?? null;
    },
    async one<T>(sql: string, params?: readonly unknown[]): Promise<T> {
      const t = tableOf(sql);
      const row = buildInsertRow(sql, params ?? []);
      const rows = tables.get(t) ?? [];
      rows.push(row);
      tables.set(t, rows);
      return row as unknown as T;
    },
    async execute() {},
  };
  return client;
}

function deps(): SelfHostedServiceDeps {
  const client = tableClient();
  return {
    client,
    store: new EmailsSelfHostedStore(client),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => "provider-message-id" },
    migrations: emailsSelfHostedMigrations(),
    version: "9.9.9",
  };
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["x-api-key"] = opts.token;
  return new Request(`http://svc${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

const readToken = () => mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token;
const writeToken = () => mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET }).token;

describe("self-hosted parity: new migrations", () => {
  test("0009 + 0010 are registered and append after 0008", () => {
    const ids = emailsSelfHostedMigrations().map((m) => m.id);
    expect(ids).toContain("0009_emails_selfhosted_parity_tables");
    expect(ids).toContain("0010_emails_selfhosted_provisioning_columns");
    expect(ids.indexOf("0009_emails_selfhosted_parity_tables")).toBeGreaterThan(
      ids.indexOf("0008_emails_legacy_messages_backfill_dedupe"),
    );
    expect(ids.indexOf("0010_emails_selfhosted_provisioning_columns")).toBeGreaterThan(
      ids.indexOf("0009_emails_selfhosted_parity_tables"),
    );
  });

  test("released migration ids/checksums are unchanged by the append", () => {
    const released = Object.fromEntries(emailsSelfHostedMigrations().map((m) => [m.id, m.checksum]));
    expect(released["0005_mailery_selfhosted_resources"]).toBe(
      "sha256:04d715446f80b8f0f1926097c3837bbd83fe76ad7400f10eef70189d97651bbc",
    );
  });

  test("0009 seeds the three email agent settings rows and 0010 adds provisioning columns", () => {
    const m = Object.fromEntries(emailsSelfHostedMigrations().map((x) => [x.id, x.sql]));
    const parity = m["0009_emails_selfhosted_parity_tables"]!;
    expect(parity).toContain("CREATE TABLE IF NOT EXISTS aliases");
    expect(parity).toContain("CREATE TABLE IF NOT EXISTS forwarding_rules");
    expect(parity).toContain("CREATE TABLE IF NOT EXISTS email_agent_settings");
    expect(parity).toContain("'categorizer'");
    expect(parity).toContain("ON CONFLICT (agent_key) DO NOTHING");
    const prov = m["0010_emails_selfhosted_provisioning_columns"]!;
    expect(prov).toContain("ALTER TABLE domains ADD COLUMN IF NOT EXISTS provisioning_status");
    expect(prov).toContain("ALTER TABLE addresses ADD COLUMN IF NOT EXISTS domain_id");
  });
});

describe("self-hosted parity: generic resource round-trips", () => {
  test("aliases create -> list -> get -> delete (protected bool round-trips)", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/aliases", {
      token: writeToken(),
      body: { domain: "x.com", local_part: "ceo", target_address: "boss@x.com", protected: true },
    }));
    expect(create?.status).toBe(201);
    const row = await create!.json();
    expect(row.domain).toBe("x.com");
    expect(row.protected).toBe(true);
    expect(typeof row.id).toBe("string");

    const list = await handleSelfHostedRequest(d, req("GET", "/v1/aliases", { token: readToken() }));
    expect((await list!.json()).items).toHaveLength(1);

    const get = await handleSelfHostedRequest(d, req("GET", `/v1/aliases/${row.id}`, { token: readToken() }));
    expect((await get!.json()).target_address).toBe("boss@x.com");

    const del = await handleSelfHostedRequest(d, req("DELETE", `/v1/aliases/${row.id}`, { token: writeToken() }));
    expect(del?.status).toBe(200);
    const gone = await handleSelfHostedRequest(d, req("GET", `/v1/aliases/${row.id}`, { token: readToken() }));
    expect(gone?.status).toBe(404);
  });

  test("forwarding rule persists the enabled boolean", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/forwarding", {
      token: writeToken(),
      body: { source_address: "a@x.com", target_address: "b@x.com", enabled: false },
    }));
    expect(create?.status).toBe(201);
    expect((await create!.json()).enabled).toBe(false);
  });

  test("warming schedule keeps target_daily_volume as an integer", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/warming", {
      token: writeToken(),
      body: { domain: "x.com", target_daily_volume: 50, start_date: "2026-07-13", status: "active" },
    }));
    const row = await create!.json();
    expect(row.target_daily_volume).toBe(50);
    expect(row.start_date).toBe("2026-07-13");
  });

  test("triage round-trips priority (int) and confidence (real)", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/triage", {
      token: writeToken(),
      body: { inbound_email_id: "ie1", label: "urgent", priority: 1, confidence: 0.87, sentiment: "negative" },
    }));
    const row = await create!.json();
    expect(row.priority).toBe(1);
    expect(row.confidence).toBe(0.87);
    expect(row.label).toBe("urgent");
  });

  test("provisioning event stores detail_json as JSON", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/provisioning", {
      token: writeToken(),
      body: { entity_type: "domain", entity_id: "dom1", to_state: "verifying", detail_json: { attempt: 2 } },
    }));
    const row = await create!.json();
    expect(row.to_state).toBe("verifying");
    expect(row.detail_json).toEqual({ attempt: 2 });
  });

  test("sources store settings_json + provider_snapshot_json objects", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/sources", {
      token: writeToken(),
      body: { mailbox_id: "mb1", type: "ses_s3", name: "SES", settings_json: { bucket: "b" }, provider_snapshot_json: {} },
    }));
    const row = await create!.json();
    expect(row.type).toBe("ses_s3");
    expect(row.settings_json).toEqual({ bucket: "b" });
  });

  test("events store the metadata object", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/events", {
      token: writeToken(),
      body: { provider_id: "p1", type: "delivered", recipient: "a@x.com", metadata: { smtp: "250" }, occurred_at: "2026-07-13T00:00:00.000Z" },
    }));
    const row = await create!.json();
    expect(row.type).toBe("delivered");
    expect(row.metadata).toEqual({ smtp: "250" });
  });

  test("email-agent-runs round-trip json arrays + numeric fields", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/email-agent-runs", {
      token: writeToken(),
      body: {
        agent_key: "labeler", inbound_email_id: "ie1", provider: "external", model: "m", status: "ok",
        labels_json: ["work", "urgent"], priority: 2, confidence: 0.5, risk_score: 10,
        tool_calls_json: [], output_json: { ok: true },
      },
    }));
    const row = await create!.json();
    expect(row.labels_json).toEqual(["work", "urgent"]);
    expect(row.priority).toBe(2);
    expect(row.risk_score).toBe(10);
  });

  test("email-digests round-trip highlight/action arrays and counts", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/email-digests", {
      token: writeToken(),
      body: {
        period: "today", since: "2026-07-13T00:00:00.000Z", until: "2026-07-13T23:59:59.000Z",
        provider: "external", model: "m", status: "ok", message_count: 12,
        highlights_json: ["h1"], action_items_json: ["a1"], important_email_ids_json: ["ie1"], label_counts_json: { work: 3 },
      },
    }));
    const row = await create!.json();
    expect(row.message_count).toBe(12);
    expect(row.highlights_json).toEqual(["h1"]);
    expect(row.label_counts_json).toEqual({ work: 3 });
  });

  test("read scope may GET but not POST a parity resource", async () => {
    const d = deps();
    const list = await handleSelfHostedRequest(d, req("GET", "/v1/warming", { token: readToken() }));
    expect(list?.status).toBe(200);
    const post = await handleSelfHostedRequest(d, req("POST", "/v1/warming", { token: readToken(), body: { domain: "x.com", target_daily_volume: 1 } }));
    expect(post?.status).toBe(403);
  });
});

describe("self-hosted parity: natural-key email-agents (agent_key)", () => {
  test("create is keyed on agent_key and idempotent; get/update address by agent_key", async () => {
    const d = deps();
    const first = await handleSelfHostedRequest(d, req("POST", "/v1/email-agents", {
      token: writeToken(),
      body: { agent_key: "categorizer", enabled: true, provider: "external", config_json: { a: 1 } },
    }));
    expect(first?.status).toBe(201);
    expect((await first!.json()).agent_key).toBe("categorizer");

    // Re-create with the same key upserts to a no-op (idempotent ensure), never a dup.
    const again = await handleSelfHostedRequest(d, req("POST", "/v1/email-agents", {
      token: writeToken(),
      body: { agent_key: "categorizer", enabled: false },
    }));
    expect(again?.status).toBe(201);
    const list = await handleSelfHostedRequest(d, req("GET", "/v1/email-agents", { token: readToken() }));
    expect((await list!.json()).items).toHaveLength(1);

    const get = await handleSelfHostedRequest(d, req("GET", "/v1/email-agents/categorizer", { token: readToken() }));
    expect(get?.status).toBe(200);
    expect((await get!.json()).agent_key).toBe("categorizer");

    const patch = await handleSelfHostedRequest(d, req("PATCH", "/v1/email-agents/categorizer", {
      token: writeToken(),
      body: { enabled: false, always_on: true },
    }));
    expect(patch?.status).toBe(200);
    const patched = await patch!.json();
    expect(patched.enabled).toBe(false);
    expect(patched.always_on).toBe(true);
  });
});

describe("self-hosted parity: mail-views", () => {
  test("GET /v1/messages/threads returns thread rollups (not treated as a message id)", async () => {
    const d = deps();
    let called = false;
    d.store.listThreads = async () => {
      called = true;
      return [{
        thread_key: "invoice", subject: "Invoice", message_count: 3, unread_count: 1,
        last_message_at: "2026-07-13T00:00:00.000Z", first_message_at: "2026-07-01T00:00:00.000Z",
        participants: ["a@x.com", "b@x.com"],
      }];
    };
    // If routing fell through to the single-message matcher, this would throw.
    d.store.getMessage = async () => { throw new Error("routed to getMessage by mistake"); };
    const res = await handleSelfHostedRequest(d, req("GET", "/v1/messages/threads", { token: readToken() }));
    expect(res?.status).toBe(200);
    expect(called).toBe(true);
    expect((await res!.json()).threads[0].message_count).toBe(3);
  });

  test("GET /v1/mailboxes returns mailboxes + folder counts", async () => {
    const d = deps();
    d.store.listMailboxes = async () => ({
      mailboxes: [{ id: "a1", address: "ceo@x.com", display_name: null, status: "active", total: 5, unread: 2 }],
      counts: { inbox: 5, unread: 2, starred: 0, sent: 1, archived: 0, spam: 0, trash: 0, total: 6, latest_received_at: null },
    });
    const res = await handleSelfHostedRequest(d, req("GET", "/v1/mailboxes", { token: readToken() }));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.mailboxes[0].address).toBe("ceo@x.com");
    expect(body.counts.inbox).toBe(5);
  });

  test("GET /v1/messages/{id}/raw reconstructs MIME, 404 when missing", async () => {
    const d = deps();
    d.store.getMessageRaw = async (id) => (id === "m1" ? { raw: "From: a@x.com\r\n\r\nhi", message_id: "<m1@x>" } : null);
    const ok = await handleSelfHostedRequest(d, req("GET", "/v1/messages/m1/raw", { token: readToken() }));
    expect(ok?.status).toBe(200);
    expect((await ok!.json()).raw).toContain("From: a@x.com");
    const missing = await handleSelfHostedRequest(d, req("GET", "/v1/messages/nope/raw", { token: readToken() }));
    expect(missing?.status).toBe(404);
  });

  test("mail-views require auth", async () => {
    const d = deps();
    expect((await handleSelfHostedRequest(d, req("GET", "/v1/mailboxes")))?.status).toBe(401);
    expect((await handleSelfHostedRequest(d, req("GET", "/v1/messages/threads")))?.status).toBe(401);
  });

  test("store.getMessageRaw builds RFC822 headers from a stored row", async () => {
    const d = deps();
    d.store.getMessage = async () => ({
      id: "m1", direction: "inbound", from_addr: "a@x.com", to_addrs: ["b@x.com"], cc_addrs: [],
      subject: "Hello", body_text: "Body here", body_html: null, status: "received",
      provider_message_id: null, message_id: "<m1@x>", in_reply_to: null, received_at: "2026-07-13T00:00:00.000Z",
      is_read: false, is_starred: false, labels: [], headers: {}, attachments: [], source_id: null,
      idempotency_key: null, send_payload_hash: null, send_state: "none", send_started_at: null,
      created_at: "2026-07-13T00:00:00.000Z", updated_at: "2026-07-13T00:00:00.000Z",
    });
    const raw = await d.store.getMessageRaw("m1");
    expect(raw?.raw).toContain("From: a@x.com");
    expect(raw?.raw).toContain("To: b@x.com");
    expect(raw?.raw).toContain("Subject: Hello");
    expect(raw?.raw).toContain("\r\n\r\nBody here");
  });
});

describe("self-hosted parity: provisioning fields on domains/addresses", () => {
  test("PATCH /v1/domains applies provisioning fields via applyDomainProvisioning", async () => {
    const d = deps();
    let seen: unknown;
    d.store.updateDomain = async () => ({
      id: "dom1", domain: "x.com", status: "pending", provider: null, verified: false, notes: null,
      created_at: "t", updated_at: "t",
    });
    d.store.applyDomainProvisioning = async (_id, patch) => {
      seen = patch;
      return { id: "dom1", domain: "x.com", status: "pending", provider: null, verified: false, notes: null, provisioning_status: "verifying", cf_zone_id: "z1", nameservers_json: ["ns1"], created_at: "t", updated_at: "t" };
    };
    const res = await handleSelfHostedRequest(d, req("PATCH", "/v1/domains/dom1", {
      token: writeToken(),
      body: { provisioning_status: "verifying", cf_zone_id: "z1", nameservers_json: ["ns1"] },
    }));
    expect(res?.status).toBe(200);
    expect(seen).toEqual({ provisioning_status: "verifying", cf_zone_id: "z1", nameservers_json: ["ns1"] });
    expect((await res!.json()).domain.provisioning_status).toBe("verifying");
  });

  test("PATCH /v1/addresses applies provisioning fields via applyAddressProvisioning", async () => {
    const d = deps();
    let seen: unknown;
    d.store.updateAddress = async () => ({
      id: "a1", email: "a@x.com", domain: "x.com", display_name: null, status: "active", verified: false, daily_quota: null,
      created_at: "t", updated_at: "t",
    });
    d.store.applyAddressProvisioning = async (_id, patch) => {
      seen = patch;
      return { id: "a1", email: "a@x.com", domain: "x.com", display_name: null, status: "active", verified: false, daily_quota: null, provisioning_status: "ready", receive_strategy: "ses-s3", created_at: "t", updated_at: "t" };
    };
    const res = await handleSelfHostedRequest(d, req("PATCH", "/v1/addresses/a1", {
      token: writeToken(),
      body: { provisioning_status: "ready", receive_strategy: "ses-s3", forward_to: null },
    }));
    expect(res?.status).toBe(200);
    expect(seen).toEqual({ provisioning_status: "ready", receive_strategy: "ses-s3", forward_to: null });
    expect((await res!.json()).address.provisioning_status).toBe("ready");
  });
});
