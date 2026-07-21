// `/api/v1` alias parity for the self-hosted service.
//
// The native client targets `/api/v1/...` + `Authorization: Bearer <key>`, while
// the self-hosted server's canonical surface is `/v1/...`. These tests prove that
// `/api/v1/...` routes byte-for-byte identically to `/v1/...` across auth,
// resource, and openapi routes, that the bearer/x-api-key credentials both work,
// and that bare `/v1/...` keeps working (back-compat).

import { describe, expect, test } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import {
  handleSelfHostedRequest,
  canonicalizeApiV1Pathname,
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

/**
 * The heart of the suite: fire the SAME request against `/v1<suffix>` and
 * `/api/v1<suffix>` (each on a fresh deps so no per-request state bleeds) and
 * assert the status + JSON body are identical AND not a 404.
 */
async function assertAliasParity(
  method: string,
  suffix: string,
  opts: { auth?: Auth; body?: unknown; configure?: (d: SelfHostedServiceDeps) => void } = {},
): Promise<{ status: number | undefined; body: unknown }> {
  const canonical = await snapshot(
    await handleSelfHostedRequest(deps(opts.configure), req(method, `/v1${suffix}`, opts)),
  );
  const aliased = await snapshot(
    await handleSelfHostedRequest(deps(opts.configure), req(method, `/api/v1${suffix}`, opts)),
  );
  expect(aliased).toEqual(canonical);
  expect(aliased.status).not.toBe(404);
  return aliased;
}

// A representative stored message the id/counts/list routes can return verbatim.
const MESSAGE = {
  id: "msg_00000000000000000000000001",
  direction: "inbound",
  from_addr: "sender@example.com",
  to_addrs: ["dest@hasna.com"],
  subject: "hello",
  body_text: "world",
  status: "received",
  is_read: false,
  is_starred: false,
  created_at: "2026-07-21T00:00:00.000Z",
  updated_at: "2026-07-21T00:00:00.000Z",
  idempotency_key: "should-be-stripped",
  send_payload_hash: "should-be-stripped",
};

const stubReads = (d: SelfHostedServiceDeps) => {
  const s = d.store as unknown as Record<string, unknown>;
  s.listMessages = async () => [MESSAGE];
  s.messageCounts = async () => ({ inbox: 4, sent: 2, unread: 3, total: 6, archived: 0, drafts: 0 });
  s.listMailboxes = async () => ({
    mailboxes: [{ address: "dest@hasna.com", counts: { inbox: 1, unread: 1 } }],
    counts: { inbox: 1, unread: 1, sent: 0, archived: 0, total: 1 },
  });
  s.resolveMessageId = async (id: string) => ({ id });
  s.getMessage = async () => MESSAGE;
};

describe("/api/v1 alias — pure path canonicalization", () => {
  test("strips a leading /api only for the /api/v1 prefix", () => {
    expect(canonicalizeApiV1Pathname("/api/v1")).toBe("/v1");
    expect(canonicalizeApiV1Pathname("/api/v1/")).toBe("/v1/");
    expect(canonicalizeApiV1Pathname("/api/v1/messages")).toBe("/v1/messages");
    expect(canonicalizeApiV1Pathname("/api/v1/messages/counts")).toBe("/v1/messages/counts");
    expect(canonicalizeApiV1Pathname("/api/v1/auth/login")).toBe("/v1/auth/login");
    expect(canonicalizeApiV1Pathname("/api/v1/openapi.json")).toBe("/v1/openapi.json");
  });

  test("leaves non-/api/v1 paths untouched", () => {
    expect(canonicalizeApiV1Pathname("/v1/messages")).toBe("/v1/messages");
    expect(canonicalizeApiV1Pathname("/health")).toBe("/health");
    expect(canonicalizeApiV1Pathname("/openapi.json")).toBe("/openapi.json");
    // A different segment that merely starts with "/api/v1" (no boundary) is NOT stripped.
    expect(canonicalizeApiV1Pathname("/api/v1beta/x")).toBe("/api/v1beta/x");
    // `/api/<other>` is not the v1 alias and is left alone.
    expect(canonicalizeApiV1Pathname("/api/health")).toBe("/api/health");
  });
});

describe("/api/v1 alias — route parity with /v1", () => {
  test("POST /api/v1/auth/login routes identically to /v1/auth/login", async () => {
    const result = await assertAliasParity("POST", "/auth/login", {
      body: { email: "alias-test@hasna.com", password: "not-the-right-password" },
    });
    // Reached the login handler (fake client has no such user) — not the 404 fallthrough.
    expect(result.status).toBe(401);
    expect((result.body as { reason?: string }).reason).toBe("invalid_credentials");
  });

  test("GET /api/v1/messages routes identically to /v1/messages", async () => {
    const result = await assertAliasParity("GET", "/messages", {
      auth: { bearer: token("emails:read") },
      configure: stubReads,
    });
    expect(result.status).toBe(200);
    expect((result.body as { messages: unknown[] }).messages).toHaveLength(1);
  });

  test("GET /api/v1/mailboxes routes identically to /v1/mailboxes", async () => {
    const result = await assertAliasParity("GET", "/mailboxes", {
      auth: { bearer: token("emails:read") },
      configure: stubReads,
    });
    expect(result.status).toBe(200);
    expect((result.body as { mailboxes: unknown[] }).mailboxes).toHaveLength(1);
  });

  test("GET /api/v1/messages/:id routes identically to /v1/messages/:id", async () => {
    const result = await assertAliasParity("GET", `/messages/${MESSAGE.id}`, {
      auth: { bearer: token("emails:read") },
      configure: stubReads,
    });
    expect(result.status).toBe(200);
    const message = (result.body as { message: Record<string, unknown> }).message;
    expect(message.id).toBe(MESSAGE.id);
    // Public projection still applies through the alias.
    expect(message.idempotency_key).toBeUndefined();
    expect(message.send_payload_hash).toBeUndefined();
  });

  test("GET /api/v1/messages/counts routes identically to /v1/messages/counts", async () => {
    const result = await assertAliasParity("GET", "/messages/counts", {
      auth: { bearer: token("emails:read") },
      configure: stubReads,
    });
    expect(result.status).toBe(200);
    expect((result.body as { counts: { inbox: number } }).counts).toMatchObject({ inbox: 4, total: 6 });
  });

  test("GET /api/v1/openapi.json routes identically to /v1/openapi.json", async () => {
    const result = await assertAliasParity("GET", "/openapi.json");
    expect(result.status).toBe(200);
    expect((result.body as { openapi?: string }).openapi ?? (result.body as { info?: unknown }).info).toBeDefined();
  });
});

describe("/api/v1 alias — credentials and back-compat", () => {
  test("the aliased data route accepts an x-api-key credential too", async () => {
    const res = await handleSelfHostedRequest(
      deps(stubReads),
      req("GET", "/api/v1/messages", { auth: { apiKey: token("emails:read") } }),
    );
    expect(res?.status).toBe(200);
  });

  test("an unauthenticated aliased data route fails the same as /v1 (401, not 404)", async () => {
    const result = await assertAliasParity("GET", "/messages");
    expect(result.status).toBe(401);
    expect((result.body as { reason?: string }).reason).toBe("missing_token");
  });

  test("bare /v1 keeps working with a bearer token (back-compat)", async () => {
    const res = await handleSelfHostedRequest(
      deps(stubReads),
      req("GET", "/v1/messages", { auth: { bearer: token("emails:read") } }),
    );
    expect(res?.status).toBe(200);
    expect((await res!.json()).messages).toHaveLength(1);
  });
});
