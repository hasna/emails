// Native-client DIALECT compatibility for the self-hosted service.
//
// The macOS client speaks a slightly different dialect than this service's
// canonical `/v1` surface: it targets `/api/v1/auth/me`, `/api/v1/api-keys*`,
// `/api/v1/auth/providers`, and `/api/v1/messages/groups`. These tests prove that
// each of those client paths routes to the SAME handler (and same status + body)
// as its canonical self-hosted route — never a 404 — while the bare canonical
// routes keep working unchanged (back-compat).
//
// Pairs with api-v1-alias.test.ts, which covers the plain `/api/v1` -> `/v1`
// prefix strip. This file covers the segment remaps layered on top of it.

import { describe, expect, test } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import {
  handleSelfHostedRequest,
  canonicalizeClientDialectPathname,
  type SelfHostedServiceDeps,
} from "./service.js";
import { testAuthDeps, selfScopedStore } from "./auth/test-support.js";
import { emailsSelfHostedMigrations } from "./migrations.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

/** Minimal in-memory query client — reads default to empty, probes answer SELECT 1. */
function fakeClient(): TypedQueryClient {
  const client: TypedQueryClient = {
    async query(sql, params) {
      const rows = (await client.many(sql, params)) as never[];
      return { rows, rowCount: rows.length };
    },
    async many<T>(sql: string): Promise<T[]> {
      if (sql.includes("SELECT 1")) return [{ ok: 1 } as unknown as T];
      return [] as T[];
    },
    async get<T>(sql: string): Promise<T | null> {
      if (sql.includes("SELECT 1")) return { ok: 1 } as unknown as T;
      return null;
    },
    async one<T>(): Promise<T> {
      return {} as T;
    },
    async execute() {},
  };
  return client;
}

/** Build a fresh deps bundle; `configure` may stub scoped-store methods per test. */
function deps(configure?: (d: SelfHostedServiceDeps) => void): SelfHostedServiceDeps {
  const client = fakeClient();
  const d: SelfHostedServiceDeps = {
    client,
    store: selfScopedStore(client),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => "provider-message-id" },
    migrations: emailsSelfHostedMigrations(),
    version: "9.9.9",
    ...testAuthDeps(client, SIGNING_SECRET),
  };
  configure?.(d);
  return d;
}

function token(scope: "emails:read" | "emails:write" = "emails:read"): string {
  return mintApiKey({ app: "emails", scopes: [scope], signingSecret: SIGNING_SECRET }).token;
}

type Auth = { bearer?: string; apiKey?: string };

function req(method: string, path: string, opts: { auth?: Auth; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth?.bearer) headers["Authorization"] = `Bearer ${opts.auth.bearer}`;
  if (opts.auth?.apiKey) headers["x-api-key"] = opts.auth.apiKey;
  return new Request(`http://svc${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function snapshot(res: Response | null): Promise<{ status: number | undefined; body: unknown }> {
  return { status: res?.status, body: res ? await res.json() : undefined };
}

const stubReads = (d: SelfHostedServiceDeps) => {
  const s = d.store as unknown as Record<string, unknown>;
  s.messageCounts = async () => ({ inbox: 4, sent: 2, unread: 3, starred: 1, spam: 0, trash: 0, total: 6, archived: 0 });
};

/**
 * Fire `client` (a native-dialect request) and `canonical` (the equivalent
 * canonical `/v1` request), each on a fresh deps, and assert the status + JSON
 * body are byte-identical AND not a 404 — i.e. the dialect path reaches exactly
 * the same handler as the canonical route.
 */
async function assertRoutesSame(
  client: { method: string; path: string },
  canonical: { method: string; path: string },
  opts: { auth?: Auth; body?: unknown; configure?: (d: SelfHostedServiceDeps) => void } = {},
): Promise<{ status: number | undefined; body: unknown }> {
  const canonicalResult = await snapshot(
    await handleSelfHostedRequest(deps(opts.configure), req(canonical.method, canonical.path, opts)),
  );
  const clientResult = await snapshot(
    await handleSelfHostedRequest(deps(opts.configure), req(client.method, client.path, opts)),
  );
  expect(clientResult).toEqual(canonicalResult);
  expect(clientResult.status).not.toBe(404);
  return clientResult;
}

describe("client dialect — pure path canonicalization", () => {
  test("remaps the cloud-shaped segment names onto canonical /v1 handlers", () => {
    expect(canonicalizeClientDialectPathname("/v1/auth/me")).toBe("/v1/me");
    expect(canonicalizeClientDialectPathname("/v1/api-keys")).toBe("/v1/keys");
    expect(canonicalizeClientDialectPathname("/v1/api-keys/abc123")).toBe("/v1/keys/abc123");
    expect(canonicalizeClientDialectPathname("/v1/api-keys/abc123/revoke")).toBe("/v1/keys/abc123/revoke");
  });

  test("leaves canonical and unrelated paths untouched", () => {
    expect(canonicalizeClientDialectPathname("/v1/me")).toBe("/v1/me");
    expect(canonicalizeClientDialectPathname("/v1/keys")).toBe("/v1/keys");
    expect(canonicalizeClientDialectPathname("/v1/keys/abc123")).toBe("/v1/keys/abc123");
    expect(canonicalizeClientDialectPathname("/v1/messages")).toBe("/v1/messages");
    expect(canonicalizeClientDialectPathname("/v1/messages/groups")).toBe("/v1/messages/groups");
    expect(canonicalizeClientDialectPathname("/v1/auth/login")).toBe("/v1/auth/login");
    expect(canonicalizeClientDialectPathname("/v1/auth/providers")).toBe("/v1/auth/providers");
    // A resource that merely CONTAINS "api-keys" as a value is not a prefix match.
    expect(canonicalizeClientDialectPathname("/v1/messages/api-keys")).toBe("/v1/messages/api-keys");
  });
});

describe("client dialect — route parity with canonical /v1 (not 404)", () => {
  test("GET /api/v1/auth/me routes identically to GET /v1/me", async () => {
    const result = await assertRoutesSame(
      { method: "GET", path: "/api/v1/auth/me" },
      { method: "GET", path: "/v1/me" },
      { auth: { bearer: token("emails:read") } },
    );
    // Reached handleMe (api-key principal resolves to the default tenant) — a 200
    // identity payload, NOT the 404 fallthrough.
    expect(result.status).toBe(200);
    expect((result.body as { principal_type?: string }).principal_type).toBe("apikey");
  });

  test("GET /api/v1/api-keys routes identically to GET /v1/keys", async () => {
    const result = await assertRoutesSame(
      { method: "GET", path: "/api/v1/api-keys" },
      { method: "GET", path: "/v1/keys" },
      { auth: { bearer: token("emails:read") } },
    );
    // handleListKeys gates on an owner/admin USER session; an api-key principal is
    // refused with 403 (owner or admin required) — the SAME handler, not a 404.
    expect(result.status).toBe(403);
  });

  test("POST /api/v1/api-keys routes identically to POST /v1/keys", async () => {
    const result = await assertRoutesSame(
      { method: "POST", path: "/api/v1/api-keys" },
      { method: "POST", path: "/v1/keys" },
      { auth: { bearer: token("emails:write") }, body: { name: "from the app" } },
    );
    expect(result.status).toBe(403);
    expect(result.status).not.toBe(404);
  });

  test("POST /api/v1/api-keys/{id}/revoke routes identically to POST /v1/keys/{id}/revoke", async () => {
    const result = await assertRoutesSame(
      { method: "POST", path: "/api/v1/api-keys/key_123/revoke" },
      { method: "POST", path: "/v1/keys/key_123/revoke" },
      { auth: { bearer: token("emails:write") } },
    );
    // Reaches handleRevokeKey (403 for a non-owner api-key principal), never 404
    // and never a 405 method-not-allowed.
    expect(result.status).toBe(403);
    expect(result.status).not.toBe(404);
    expect(result.status).not.toBe(405);
  });
});

describe("client dialect — auth providers stub", () => {
  test("GET /api/v1/auth/providers returns the app-expected shape (not 404)", async () => {
    const result = await assertRoutesSame(
      { method: "GET", path: "/api/v1/auth/providers" },
      { method: "GET", path: "/v1/auth/providers" },
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ google: false, device: false });
  });

  test("the providers probe is unauthenticated (no token required)", async () => {
    const res = await handleSelfHostedRequest(deps(), req("GET", "/api/v1/auth/providers"));
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ google: false, device: false });
  });
});

describe("client dialect — messages/groups flat folder counts", () => {
  test("GET /api/v1/messages/groups routes identically to GET /v1/messages/groups", async () => {
    const result = await assertRoutesSame(
      { method: "GET", path: "/api/v1/messages/groups" },
      { method: "GET", path: "/v1/messages/groups" },
      { auth: { bearer: token("emails:read") }, configure: stubReads },
    );
    expect(result.status).toBe(200);
    // Flat counts at the TOP LEVEL — the client decodes them directly here.
    expect(result.body).toMatchObject({ inbox: 4, unread: 3, total: 6 });
    // NOT the { counts: {...} } envelope that /v1/messages/counts returns.
    expect((result.body as { counts?: unknown }).counts).toBeUndefined();
  });

  test("/v1/messages/counts still returns the wrapped envelope (back-compat)", async () => {
    const res = await handleSelfHostedRequest(
      deps(stubReads),
      req("GET", "/v1/messages/counts", { auth: { bearer: token("emails:read") } }),
    );
    expect(res?.status).toBe(200);
    expect((await res!.json()).counts).toMatchObject({ inbox: 4, total: 6 });
  });
});

describe("client dialect — back-compat for bare canonical routes", () => {
  test("bare GET /v1/me still works with a bearer token", async () => {
    const res = await handleSelfHostedRequest(
      deps(),
      req("GET", "/v1/me", { auth: { bearer: token("emails:read") } }),
    );
    expect(res?.status).toBe(200);
    expect((await res!.json()).principal_type).toBe("apikey");
  });

  test("bare DELETE /v1/keys/{id} still reaches the revoke handler (not 404/405)", async () => {
    const res = await handleSelfHostedRequest(
      deps(),
      req("DELETE", "/v1/keys/key_123", { auth: { bearer: token("emails:write") } }),
    );
    expect(res?.status).not.toBe(404);
    expect(res?.status).not.toBe(405);
  });
});
