import { describe, expect, test } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../generated/storage-kit/index.js";
import { MaileryCloudStore } from "./store.js";
import { handleCloudRequest, type CloudServiceDeps } from "./service.js";
import { maileryCloudMigrations } from "./migrations.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

/** Minimal in-memory query client that answers only the SQL our tests exercise. */
function fakeClient(): { client: TypedQueryClient; calls: string[] } {
  const calls: string[] = [];
  const domains: Record<string, unknown>[] = [];
  const client: TypedQueryClient = {
    async query(sql, params) {
      calls.push(sql.trim().split("\n")[0]!.trim());
      const rows = (await client.many(sql, params)) as never[];
      return { rows, rowCount: rows.length };
    },
    async many<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      calls.push(sql.trim().split("\n")[0]!.trim());
      if (sql.includes("SELECT 1")) return [{ ok: 1 } as unknown as T];
      if (sql.startsWith("SELECT * FROM domains ORDER BY")) return domains as unknown as T[];
      return [] as T[];
    },
    async get<T>(sql: string): Promise<T | null> {
      calls.push(sql.trim().split("\n")[0]!.trim());
      if (sql.includes("SELECT 1")) return { ok: 1 } as unknown as T;
      return null;
    },
    async one<T>(sql: string, params?: readonly unknown[]): Promise<T> {
      calls.push(sql.trim().split("\n")[0]!.trim());
      const rec = {
        id: "generated-id",
        domain: String((params ?? [])[1] ?? ""),
        status: "pending",
        provider: null,
        verified: false,
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      domains.push(rec);
      return rec as unknown as T;
    },
    async execute(sql: string) {
      calls.push(sql.trim().split("\n")[0]!.trim());
    },
  };
  return { client, calls };
}

function deps(): CloudServiceDeps {
  const { client } = fakeClient();
  return {
    client,
    store: new MaileryCloudStore(client),
    verifier: verifyApiKey({ app: "mailery", signingSecret: SIGNING_SECRET }),
    migrations: maileryCloudMigrations(),
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

describe("mailery cloud service", () => {
  test("GET /health returns 200 with status/version/mode", async () => {
    const res = await handleCloudRequest(deps(), req("GET", "/health"));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBe("9.9.9");
    expect(body.mode).toBe("cloud");
  });

  test("GET /version returns the version+mode shape", async () => {
    const res = await handleCloudRequest(deps(), req("GET", "/version"));
    const body = await res!.json();
    expect(body).toMatchObject({ status: "ok", version: "9.9.9", mode: "cloud", name: "mailery" });
  });

  test("unknown non-v1 path falls through (null)", async () => {
    const res = await handleCloudRequest(deps(), req("GET", "/dashboard"));
    expect(res).toBeNull();
  });

  test("/v1 without a key is rejected 401", async () => {
    const res = await handleCloudRequest(deps(), req("GET", "/v1/domains"));
    expect(res?.status).toBe(401);
    expect((await res!.json()).reason).toBe("missing_token");
  });

  test("/v1 with a bad-signature key is rejected 401", async () => {
    const forged = mintApiKey({ app: "mailery", scopes: ["mailery:read"], signingSecret: "a-different-signing-secret-16b+" }).token;
    const res = await handleCloudRequest(deps(), req("GET", "/v1/domains", { token: forged }));
    expect(res?.status).toBe(401);
  });

  test("read-scoped key can GET but not POST (403 insufficient scope)", async () => {
    const d = deps();
    const readToken = mintApiKey({ app: "mailery", scopes: ["mailery:read"], signingSecret: SIGNING_SECRET }).token;
    const listRes = await handleCloudRequest(d, req("GET", "/v1/domains", { token: readToken }));
    expect(listRes?.status).toBe(200);
    const writeRes = await handleCloudRequest(d, req("POST", "/v1/domains", { token: readToken, body: { domain: "x.com" } }));
    expect(writeRes?.status).toBe(403);
  });

  test("wrong-app key is rejected", async () => {
    const otherApp = mintApiKey({ app: "todos", scopes: ["todos:read"], signingSecret: SIGNING_SECRET }).token;
    const res = await handleCloudRequest(deps(), req("GET", "/v1/domains", { token: otherApp }));
    expect(res?.status).toBe(401);
  });

  test("write-scoped key creates a domain (201) and it appears in the list", async () => {
    const d = deps();
    const writeToken = mintApiKey({ app: "mailery", scopes: ["mailery:*"], signingSecret: SIGNING_SECRET }).token;
    const create = await handleCloudRequest(d, req("POST", "/v1/domains", { token: writeToken, body: { domain: "Example.COM" } }));
    expect(create?.status).toBe(201);
    const created = (await create!.json()).domain;
    expect(created.domain).toBe("example.com");
    const list = await handleCloudRequest(d, req("GET", "/v1/domains", { token: writeToken }));
    expect((await list!.json()).domains.length).toBe(1);
  });

  test("POST with missing required field returns 400", async () => {
    const writeToken = mintApiKey({ app: "mailery", scopes: ["mailery:write"], signingSecret: SIGNING_SECRET }).token;
    const res = await handleCloudRequest(deps(), req("POST", "/v1/domains", { token: writeToken, body: {} }));
    expect(res?.status).toBe(400);
  });
});
