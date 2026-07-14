// Server-side coverage for the generic /v1 resource endpoints (contacts,
// providers, groups, …) exposed to self-hosted clients: routing, auth/scope
// enforcement, and that the generic store builds a working INSERT/SELECT/DELETE
// against a table-aware in-memory fake query client.

import { describe, expect, test } from "bun:test";
import { mintApiKey } from "@hasna/contracts/auth";
import { verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { EmailsSelfHostedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { testAuthDeps, selfScopedStore } from "./auth/test-support.js";
import { emailsSelfHostedMigrations } from "./migrations.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

/** In-memory fake that emulates INSERT/SELECT/DELETE for arbitrary tables. */
function tableClient(): TypedQueryClient {
  const tables = new Map<string, Record<string, unknown>[]>();
  const tableOf = (sql: string): string => {
    const m = sql.match(/(?:FROM|INTO|UPDATE)\s+([a-z_]+)/i);
    return m ? m[1]! : "";
  };
  const insertCols = (sql: string): string[] => {
    const m = sql.match(/INSERT INTO [a-z_]+ \(([^)]+)\)/i);
    return m ? m[1]!.split(",").map((c) => c.trim()) : [];
  };
  const client: TypedQueryClient = {
    async query(sql, params) {
      const rows = (await client.many(sql, params)) as never[];
      return { rows, rowCount: rows.length };
    },
    async many<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      if (sql.includes("SELECT 1")) return [{ ok: 1 } as unknown as T];
      const t = tableOf(sql);
      const rows = tables.get(t) ?? [];
      if (/^\s*DELETE/i.test(sql)) {
        const id = (params ?? [])[0];
        const kept = rows.filter((r) => r["id"] !== id);
        const removed = rows.filter((r) => r["id"] === id);
        tables.set(t, kept);
        return removed.map((r) => ({ id: r["id"] })) as unknown as T[];
      }
      return rows as unknown as T[];
    },
    async get<T>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      const t = tableOf(sql);
      const rows = tables.get(t) ?? [];
      if (/^\s*UPDATE/i.test(sql)) {
        const id = (params ?? [])[0];
        const row = rows.find((r) => r["id"] === id);
        return (row as unknown as T) ?? null;
      }
      const id = (params ?? [])[0];
      return (rows.find((r) => r["id"] === id) as unknown as T) ?? null;
    },
    async one<T>(sql: string, params?: readonly unknown[]): Promise<T> {
      const t = tableOf(sql);
      const cols = insertCols(sql);
      // Emulate Postgres JSONB: a `$n::jsonb` value is stored/returned parsed.
      const valuesClause = sql.match(/VALUES \(([^)]+)\)/i)?.[1] ?? "";
      const jsonbPositions = new Set(
        [...valuesClause.matchAll(/\$(\d+)::jsonb/gi)].map((m) => Number(m[1]) - 1),
      );
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        let v = (params ?? [])[i];
        if (jsonbPositions.has(i) && typeof v === "string") {
          try {
            v = JSON.parse(v);
          } catch {
            /* leave as-is */
          }
        }
        row[c] = v;
      });
      const arr = tables.get(t) ?? [];
      arr.push(row);
      tables.set(t, arr);
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
    store: selfScopedStore(client),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => "provider-message-id" },
    migrations: emailsSelfHostedMigrations(),
    version: "9.9.9",
    ...testAuthDeps(client, SIGNING_SECRET),
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

describe("self_hosted service generic resources", () => {
  test("migration 0005 is registered", () => {
    expect(emailsSelfHostedMigrations().some((m) => m.id === "0005_mailery_selfhosted_resources")).toBe(true);
    expect(emailsSelfHostedMigrations().some((m) => m.id === "0006_emails_rename_bridge")).toBe(true);
    expect(emailsSelfHostedMigrations().some((m) => m.id === "0006b_emails_legacy_messages_backfill_prep")).toBe(true);
    expect(emailsSelfHostedMigrations().some((m) => m.id === "0007_emails_legacy_messages_backfill")).toBe(true);
    expect(emailsSelfHostedMigrations().some((m) => m.id === "0008_emails_legacy_messages_backfill_dedupe")).toBe(true);
  });

  test("preserves the released Mailery migration ids and checksums before the rename bridge", () => {
    const released = Object.fromEntries(emailsSelfHostedMigrations().map((migration) => [migration.id, migration.checksum]));
    expect(released).toMatchObject({
      "0001_mailery_selfhosted_core": "sha256:b2d71b0e1686d07c6e4da85edc46a43d1c8912b3e5a8c61043939c2c09de98ac",
      "0002_mailery_messages_inbound": "sha256:729be8b0d4ee8267cf1443cfc60a11bbce8b0329a32af91934adf55ad3105373",
      "0003_mailery_addresses_verified": "sha256:245244eae5dd0a2deadc7aeb6082a4aee44e0867e2b93d78965971837c532338",
      "0004_mailery_addresses_daily_quota": "sha256:e590954b8c06c26f8a4f2f25074a6dcf6d10313534a519e803f3ae98d9c0d586",
      "0005_mailery_selfhosted_resources": "sha256:04d715446f80b8f0f1926097c3837bbd83fe76ad7400f10eef70189d97651bbc",
    });
    const bridge = emailsSelfHostedMigrations().find((migration) => migration.id === "0006_emails_rename_bridge");
    expect(bridge?.sql).toContain("ALTER TABLE cloud_providers RENAME TO self_hosted_providers");
    expect(bridge?.sql).toContain("idempotency_key");
    const ids = emailsSelfHostedMigrations().map((migration) => migration.id);
    expect(ids.indexOf("0006b_emails_legacy_messages_backfill_prep")).toBeGreaterThan(
      ids.indexOf("0006_emails_rename_bridge"),
    );
    expect(ids.indexOf("0007_emails_legacy_messages_backfill")).toBeGreaterThan(
      ids.indexOf("0006b_emails_legacy_messages_backfill_prep"),
    );
    expect(ids.indexOf("0008_emails_legacy_messages_backfill_dedupe")).toBeGreaterThan(
      ids.indexOf("0007_emails_legacy_messages_backfill"),
    );
  });

  test("legacy backfill hardening preserves immutable 0007 and repairs around it", () => {
    const migrations = Object.fromEntries(emailsSelfHostedMigrations().map((migration) => [migration.id, migration]));
    const prep = migrations["0006b_emails_legacy_messages_backfill_prep"]!;
    const backfill = migrations["0007_emails_legacy_messages_backfill"]!;
    const dedupe = migrations["0008_emails_legacy_messages_backfill_dedupe"]!;

    expect(prep.sql).toContain("pg_temp.emails_safe_jsonb_text");
    expect(prep.sql).toContain("pg_temp.emails_safe_timestamptz_text");
    expect(prep.sql).toContain("RETURNS TIMESTAMPTZ");
    expect(prep.checksum).toBe("sha256:7dffe791bd15d152088530edc129f000f82c89bd80fa1fa133f1b08d52c3ce23");
    expect(prep.acceptedChecksums).toContain(
      "sha256:0418239e617335b948364101dfa9d55d401322c377c9999804429b6cc789de23",
    );
    expect(prep.sql).toContain("UPDATE inbound_emails");
    expect(prep.sql).toContain("UPDATE emails");
    expect(prep.sql).toContain("sent_at = COALESCE(");
    expect(prep.sql).toContain("pg_temp.emails_safe_timestamptz_text(created_at::text)");
    expect(prep.sql).toContain("pg_temp.emails_safe_timestamptz_text(updated_at::text)");
    expect(backfill.checksum).toBe("sha256:1c345e0153002d820eb50ce2559d8155e2e1993520a120648d5c78f0fb7816b1");
    expect(dedupe.sql).toContain("DELETE FROM messages legacy");
    expect(dedupe.sql).toContain("existing.message_id = legacy.message_id");
    expect(dedupe.sql).toContain("existing.id NOT LIKE 'legacy-inbound:%'");
  });

  test("GET /v1/contacts requires auth (401)", async () => {
    const res = await handleSelfHostedRequest(deps(), req("GET", "/v1/contacts"));
    expect(res?.status).toBe(401);
  });

  test("read scope can GET but not POST contacts", async () => {
    const d = deps();
    const list = await handleSelfHostedRequest(d, req("GET", "/v1/contacts", { token: readToken() }));
    expect(list?.status).toBe(200);
    expect((await list!.json()).items).toEqual([]);
    const post = await handleSelfHostedRequest(d, req("POST", "/v1/contacts", { token: readToken(), body: { email: "a@x.com" } }));
    expect(post?.status).toBe(403);
  });

  test("create -> list -> get -> delete round-trips a contact", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/contacts", { token: writeToken(), body: { email: "a@x.com", name: "A", send_count: 2, suppressed: true } }));
    expect(create?.status).toBe(201);
    const created = await create!.json();
    expect(created.email).toBe("a@x.com");
    expect(created.send_count).toBe(2);
    expect(created.suppressed).toBe(true);
    expect(typeof created.id).toBe("string");

    const list = await handleSelfHostedRequest(d, req("GET", "/v1/contacts", { token: writeToken() }));
    expect((await list!.json()).items).toHaveLength(1);

    const get = await handleSelfHostedRequest(d, req("GET", `/v1/contacts/${created.id}`, { token: writeToken() }));
    expect(get?.status).toBe(200);
    expect((await get!.json()).email).toBe("a@x.com");

    const del = await handleSelfHostedRequest(d, req("DELETE", `/v1/contacts/${created.id}`, { token: writeToken() }));
    expect(del?.status).toBe(200);
    const get2 = await handleSelfHostedRequest(d, req("GET", `/v1/contacts/${created.id}`, { token: writeToken() }));
    expect(get2?.status).toBe(404);
  });

  test("send-keys (hyphenated path) and scheduled resolve and never expose secrets", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/send-keys", { token: writeToken(), body: { owner_id: "o1", prefix: "esk_abc", label: "ci" } }));
    expect(create?.status).toBe(201);
    const row = await create!.json();
    expect(row).not.toHaveProperty("key_hash");
    const sched = await handleSelfHostedRequest(d, req("POST", "/v1/scheduled", { token: writeToken(), body: { subject: "hi", to_addresses: ["b@x.com"], status: "pending" } }));
    expect(sched?.status).toBe(201);
    expect((await sched!.json()).to_addresses).toEqual(["b@x.com"]);
  });

  test("unknown resource still 404s", async () => {
    const res = await handleSelfHostedRequest(deps(), req("GET", "/v1/nonsense", { token: readToken() }));
    expect(res?.status).toBe(404);
  });
});
