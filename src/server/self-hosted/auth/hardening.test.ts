// Unauthenticated-DoS hardening for the auth endpoints.
//
// Three defects, one blast radius:
//   1. `handleReset` computed the argon2id hash (~19 MiB, tens of ms) BEFORE
//      `consumePasswordReset` validated the token, so garbage tokens bought
//      unlimited argon2id runs.
//   2. The only limiter in front of it was per-IP, and the IP came from the
//      LEFTMOST `X-Forwarded-For` entry — which the client writes itself. Behind
//      an ALB (which APPENDS) that entry is attacker-supplied, so rotating one
//      header defeated every per-IP auth limit, login brute-force included.
//   3. `readJsonBody` checked `Content-Length` and then called `req.text()`,
//      buffering the whole body before the cap applied — a chunked request with
//      no or a lying `Content-Length` was fully materialised.
//
// Hermetic: fake query client, no Postgres.

import { describe, expect, it } from "bun:test";
import { verifyApiKey } from "@hasna/contracts/auth";
import type { PoolQueryClient, TypedQueryClient } from "../../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "../migrations.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "../service.js";
import { ALLOWED_EMAIL_DOMAINS_ENV } from "./allowed-email.js";
import { resolveClientIp, resolveTrustedProxyHops, TRUSTED_PROXY_HOPS_ENV } from "./client-ip.js";
import { RateLimiter } from "./rate-limit.js";
import { AuthStore } from "./store.js";
import { selfScopedStore, testAuthDeps } from "./test-support.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

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
  d.env = { [ALLOWED_EMAIL_DOMAINS_ENV]: "example.com" };
  configure?.(d);
  return d;
}

function post(path: string, body: unknown): Request {
  return new Request(`http://self-hosted.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

// ---- 1. argon2id is never paid for an unresolvable reset token ---------------

describe("password reset never pays argon2id for a token that does not resolve", () => {
  /** Fake client whose reset-claim UPDATE resolves only for `validToken`. */
  function resetClient(validToken: string | null): { client: TypedQueryClient; updates: string[] } {
    const updates: string[] = [];
    const tx: TypedQueryClient = {
      async query() { return { rows: [], rowCount: 0 }; },
      async many<T>(): Promise<T[]> { return [] as T[]; },
      async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
        if (sql.includes("password_reset_tokens") && sql.includes("RETURNING user_id")) {
          // The store passes a SHA-256 of the token, so compare against the
          // hash of the token we decided is valid.
          if (validToken === null) return null;
          const expected = new Bun.CryptoHasher("sha256").update(validToken).digest("hex");
          return params[0] === expected ? ({ user_id: "user-1" } as unknown as T) : null;
        }
        return null;
      },
      async one<T>(): Promise<T> { return {} as T; },
      async execute(sql: string) { updates.push(sql); },
    };
    const client = { ...tx, transaction: async <T>(fn: (c: TypedQueryClient) => Promise<T>) => fn(tx) };
    return { client: client as TypedQueryClient, updates };
  }

  it("does not invoke the hash factory when the token claim finds no row", async () => {
    const { client } = resetClient(null);
    const store = new AuthStore(client as unknown as PoolQueryClient);
    let hashes = 0;

    const done = await store.consumePasswordReset("garbage-token", async () => {
      hashes++;
      return "$argon2id$never";
    });

    expect(done).toBe(false);
    expect(hashes).toBe(0);
  });

  it("invokes the hash factory exactly once, after the row is claimed", async () => {
    const { client, updates } = resetClient("real-token");
    const store = new AuthStore(client as unknown as PoolQueryClient);
    let hashes = 0;

    const done = await store.consumePasswordReset("real-token", async () => {
      hashes++;
      return "$argon2id$computed";
    });

    expect(done).toBe(true);
    expect(hashes).toBe(1);
    expect(updates.some((sql) => sql.includes("UPDATE users SET password_hash"))).toBe(true);
    expect(updates.some((sql) => sql.includes("UPDATE sessions SET revoked_at"))).toBe(true);
  });

  it("hands the store a lazy factory, not a precomputed hash", async () => {
    let secondArg: unknown;
    const d = deps((dd) => {
      dd.authStore.consumePasswordReset = async (_token: string, factory: unknown) => {
        secondArg = factory;
        return false;
      };
    });

    const res = await handleSelfHostedRequest(
      d,
      post("/v1/auth/password/reset", { token: "garbage", new_password: "correct-horse-battery" }),
      { socketAddress: "203.0.113.10" },
    );

    expect(res?.status).toBe(400);
    expect(await res!.json()).toMatchObject({ reason: "invalid_token" });
    // Pre-fix this was the argon2id output — a string the endpoint had already
    // paid for before anyone checked the token.
    expect(typeof secondArg).toBe("function");
  });
});

// ---- 2. the rate-limit key cannot be steered by a header --------------------

describe("resolveClientIp", () => {
  it("ignores forwarding headers entirely at the default depth of zero", () => {
    expect(resolveTrustedProxyHops({})).toBe(0);
    expect(
      resolveClientIp({
        headers: headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8", "x-real-ip": "9.9.9.9" }),
        socketAddress: "203.0.113.5",
        env: {},
      }),
    ).toBe("203.0.113.5");
  });

  it("takes the rightmost entry with one appending proxy in front", () => {
    const env = { [TRUSTED_PROXY_HOPS_ENV]: "1" };
    // Client forged "9.9.9.9"; the ALB appended the real peer.
    expect(
      resolveClientIp({
        headers: headers({ "x-forwarded-for": "9.9.9.9, 198.51.100.7" }),
        socketAddress: "10.0.0.1",
        env,
      }),
    ).toBe("198.51.100.7");
    // Forging more entries only pads the left; the key is unchanged.
    expect(
      resolveClientIp({
        headers: headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3, 198.51.100.7" }),
        socketAddress: "10.0.0.1",
        env,
      }),
    ).toBe("198.51.100.7");
  });

  it("counts from the right for a chain of proxies", () => {
    expect(
      resolveClientIp({
        headers: headers({ "x-forwarded-for": "9.9.9.9, 198.51.100.7, 10.0.0.2" }),
        socketAddress: "10.0.0.1",
        env: { [TRUSTED_PROXY_HOPS_ENV]: "2" },
      }),
    ).toBe("198.51.100.7");
  });

  it("falls back to the socket peer when the header is shorter than the configured chain", () => {
    // Stripping the header must not let the caller escape the limiter.
    expect(
      resolveClientIp({
        headers: headers({}),
        socketAddress: "203.0.113.5",
        env: { [TRUSTED_PROXY_HOPS_ENV]: "1" },
      }),
    ).toBe("203.0.113.5");
    expect(
      resolveClientIp({
        headers: headers({ "x-forwarded-for": "198.51.100.7" }),
        socketAddress: "203.0.113.5",
        env: { [TRUSTED_PROXY_HOPS_ENV]: "3" },
      }),
    ).toBe("203.0.113.5");
  });

  it("never trusts X-Real-IP, which no proxy position owns", () => {
    for (const hops of ["0", "1", "2"]) {
      expect(
        resolveClientIp({
          headers: headers({ "x-real-ip": "9.9.9.9" }),
          socketAddress: "203.0.113.5",
          env: { [TRUSTED_PROXY_HOPS_ENV]: hops },
        }),
      ).toBe("203.0.113.5");
    }
  });

  it("drops non-IP junk instead of turning it into a limiter key", () => {
    const env = { [TRUSTED_PROXY_HOPS_ENV]: "1" };
    expect(
      resolveClientIp({
        headers: headers({ "x-forwarded-for": "not-an-ip, unknown" }),
        socketAddress: "203.0.113.5",
        env,
      }),
    ).toBe("203.0.113.5");
    expect(
      resolveClientIp({
        headers: headers({ "x-forwarded-for": `${"a".repeat(500)}, 198.51.100.7` }),
        socketAddress: "203.0.113.5",
        env,
      }),
    ).toBe("198.51.100.7");
    // Bracketed IPv6 and an appended source port both normalize.
    expect(
      resolveClientIp({
        headers: headers({ "x-forwarded-for": "[2001:db8::1]:443" }),
        socketAddress: "203.0.113.5",
        env,
      }),
    ).toBe("2001:db8::1");
    expect(
      resolveClientIp({
        headers: headers({ "x-forwarded-for": "198.51.100.7:51234" }),
        socketAddress: "203.0.113.5",
        env,
      }),
    ).toBe("198.51.100.7");
  });

  it("treats a malformed hop count as zero rather than widening trust", () => {
    for (const raw of ["-1", "abc", "1.5", "", " ", "0x2"]) {
      expect(resolveTrustedProxyHops({ [TRUSTED_PROXY_HOPS_ENV]: raw })).toBe(0);
    }
  });
});

describe("per-IP auth limits survive a rotating X-Forwarded-For", () => {
  /**
   * Distinct emails per attempt, so ONLY the per-IP dimension of
   * `checkAll("login", [ip, email])` can fire. If the IP key were spoofable the
   * limiter would never trip.
   */
  async function hammerLogin(
    d: SelfHostedServiceDeps,
    attempts: number,
    forge: (i: number) => Record<string, string>,
  ): Promise<number[]> {
    const statuses: number[] = [];
    for (let i = 0; i < attempts; i++) {
      const req = new Request("http://self-hosted.test/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...forge(i) },
        body: JSON.stringify({ email: `attacker${i}@example.com`, password: "whatever-password" }),
      });
      const res = await handleSelfHostedRequest(d, req, { socketAddress: "198.51.100.7" });
      statuses.push(res?.status ?? 0);
    }
    return statuses;
  }

  it("throttles a rotating leftmost X-Forwarded-For when no proxy is trusted", async () => {
    const d = deps((dd) => {
      dd.rateLimiter = new RateLimiter();
      dd.env = { [ALLOWED_EMAIL_DOMAINS_ENV]: "example.com" };
    });

    const statuses = await hammerLogin(d, 7, (i) => ({ "x-forwarded-for": `10.9.8.${i}` }));

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(statuses.slice(-1)[0]).toBe(429);
  });

  it("throttles a rotating forged prefix behind a trusted appending proxy", async () => {
    const d = deps((dd) => {
      dd.rateLimiter = new RateLimiter();
      dd.env = { [ALLOWED_EMAIL_DOMAINS_ENV]: "example.com", [TRUSTED_PROXY_HOPS_ENV]: "1" };
    });

    // Shape the ALB actually produces: the caller's forged value, then the peer.
    const statuses = await hammerLogin(d, 7, (i) => ({ "x-forwarded-for": `10.9.8.${i}, 198.51.100.7` }));

    expect(statuses.slice(-1)[0]).toBe(429);
  });

  it("keeps distinct real clients in distinct buckets behind a trusted proxy", async () => {
    const d = deps((dd) => {
      dd.rateLimiter = new RateLimiter();
      dd.env = { [ALLOWED_EMAIL_DOMAINS_ENV]: "example.com", [TRUSTED_PROXY_HOPS_ENV]: "1" };
    });

    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const req = new Request("http://self-hosted.test/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": `203.0.113.${i}` },
        body: JSON.stringify({ email: `person${i}@example.com`, password: "whatever-password" }),
      });
      const res = await handleSelfHostedRequest(d, req, { socketAddress: "10.0.0.1" });
      statuses.push(res?.status ?? 0);
    }

    expect(statuses).not.toContain(429);
  });
});

// ---- 3. the auth body cap applies while streaming ---------------------------

describe("auth request bodies are capped incrementally, not after buffering", () => {
  /** Chunked body with no Content-Length; counts how much the server pulled. */
  function streamingRequest(path: string, chunkCount: number, chunkBytes: number) {
    let pulled = 0;
    const chunk = new Uint8Array(chunkBytes).fill(0x20);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= chunkCount) {
          controller.close();
          return;
        }
        pulled++;
        controller.enqueue(chunk);
      },
    });
    const req = new Request(`http://self-hosted.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      // @ts-expect-error Bun/undici requirement for a stream body
      duplex: "half",
    });
    return { req, pulled: () => pulled };
  }

  it("rejects an oversized chunked body without draining it", async () => {
    // 1 MiB in 8 KiB chunks, no Content-Length, against a 64 KiB cap.
    const { req, pulled } = streamingRequest("/v1/auth/login", 128, 8 * 1024);

    const res = await handleSelfHostedRequest(deps(), req, { socketAddress: "203.0.113.5" });

    expect(res?.status).toBe(413);
    expect(await res!.json()).toEqual({ error: "request body too large" });
    // Pre-fix `req.text()` materialised all 128 chunks before any cap applied.
    expect(pulled()).toBeLessThan(32);
  });

  it("still rejects an oversized body that lies about its Content-Length", async () => {
    const oversized = JSON.stringify({ email: "a@example.com", password: "x".repeat(80 * 1024) });
    const req = new Request("http://self-hosted.test/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "content-length": "12" },
      body: oversized,
    });

    const res = await handleSelfHostedRequest(deps(), req, { socketAddress: "203.0.113.5" });

    expect(res?.status).toBe(413);
  });

  it("still accepts a normal body", async () => {
    const res = await handleSelfHostedRequest(
      deps(),
      post("/v1/auth/login", { email: "someone@example.com", password: "correct-horse-battery" }),
      { socketAddress: "203.0.113.5" },
    );

    expect(res?.status).toBe(401);
  });
});
