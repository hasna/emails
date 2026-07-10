// Server-side coverage for the generic /v1 resource endpoints (contacts,
// providers, groups, …) exposed to self-hosted clients: routing, auth/scope
// enforcement, and that the generic store builds a working INSERT/SELECT/DELETE
// against a table-aware in-memory fake query client.

import { describe, expect, test } from "bun:test";
import { mintApiKey } from "@hasna/contracts/auth";
import { verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../generated/storage-kit/index.js";
import { EmailsSelfHostedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
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

describe("self_hosted service generic resources", () => {
  test("migration 0005 is registered", () => {
    expect(emailsSelfHostedMigrations().some((m) => m.id === "0005_emails_selfhosted_resources")).toBe(true);
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
