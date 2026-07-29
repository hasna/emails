// Binding the API key's signed `tid` claim to the local tenant mapping.
//
// contracts 0.8.2 added a signed, tamper-evident `tid` tenant claim to API
// keys, and nothing on this server consumed it: the tenant came purely from
// the api_key_tenants DB mapping (the SAFE source — a client-presented claim
// must never pick the tenant), so a key whose signed tid named tenant A while
// the local mapping pointed at tenant B was accepted and silently acted in B.
// Drift between what the key was MINTED for and what it RESOLVES to is now a
// typed refusal, never a silent pass.
//
// Untenanted keys (no tid — every key minted before 0.8.2 and this server's
// own key mint paths today) are untouched: the api-key class keeps working.
//
// The [api-auth] audit line is also asserted to carry the tenant, so both
// credential classes have tenant-attributable audit.
//
// Hermetic: fake query client, no Postgres.

import { describe, expect, it } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { resolveRequestContext, type AuthServiceDeps } from "./auth/service.js";
import { formatApiAuthAuditLine } from "./api-key-verifier.js";
import { AuthStore } from "./auth/store.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { STUB_KEY_STORE, testAuthEnv, testAuthMailer } from "./auth/test-support.js";
import type { PoolQueryClient } from "../../storage-kit/index.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";
const MAPPED_TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function fakeClient(): TypedQueryClient {
  const client: TypedQueryClient = {
    async query() {
      return { rows: [] as never[], rowCount: 0 };
    },
    async many<T>(): Promise<T[]> {
      return [] as T[];
    },
    async get<T>(sql: string): Promise<T | null> {
      if (sql.includes("api_key_tenants")) {
        return { tenant_id: MAPPED_TENANT } as unknown as T;
      }
      return null;
    },
    async one<T>(): Promise<T> {
      return {} as T;
    },
    async execute() {},
  };
  return client;
}

function deps(): AuthServiceDeps {
  return {
    authStore: new AuthStore(fakeClient() as unknown as PoolQueryClient),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => "provider-message-id" },
    keyStore: STUB_KEY_STORE,
    signingSecret: SIGNING_SECRET,
    rateLimiter: new RateLimiter(),
    mailer: testAuthMailer(),
    env: testAuthEnv(),
  };
}

async function resolve(token: string) {
  const url = new URL("http://self-hosted.test/v1/messages");
  const req = new Request(url, { headers: { "x-api-key": token } });
  return resolveRequestContext(deps(), req, url, ["emails:read"]);
}

describe("signed tid vs api_key_tenants mapping", () => {
  it("refuses, typed, a key whose signed tid names a DIFFERENT tenant than the local mapping", async () => {
    const { token } = mintApiKey({
      app: "emails",
      scopes: ["emails:read"],
      signingSecret: SIGNING_SECRET,
      tid: OTHER_TENANT,
    });
    const result = await resolve(token);
    if (result.ok) throw new Error("expected a typed refusal — signed tid disagrees with the mapping");
    const body = (await result.response.json()) as { reason?: string };
    expect({ status: result.response.status, reason: body.reason }).toEqual({
      status: 403,
      reason: "tenant_mismatch",
    });
  });

  it("accepts a key whose signed tid MATCHES the mapping", async () => {
    const { token } = mintApiKey({
      app: "emails",
      scopes: ["emails:read"],
      signingSecret: SIGNING_SECRET,
      tid: MAPPED_TENANT,
    });
    const result = await resolve(token);
    if (!result.ok) throw new Error(`expected ok, got ${result.response.status}`);
    expect(result.ctx.tenantId).toBe(MAPPED_TENANT);
  });

  it("keeps untenanted keys fully working (the pre-tid credential class)", async () => {
    const { token } = mintApiKey({
      app: "emails",
      scopes: ["emails:read"],
      signingSecret: SIGNING_SECRET,
    });
    const result = await resolve(token);
    if (!result.ok) throw new Error(`expected ok, got ${result.response.status}`);
    expect(result.ctx).toMatchObject({ tenantId: MAPPED_TENANT, principalType: "apikey" });
  });
});

describe("the [api-auth] audit line carries the tenant", () => {
  it("prints tid for an allow, and '-' when the key is untenanted", () => {
    const base = {
      outcome: "allow" as const,
      app: "emails",
      kid: "kid-1",
      reason: null,
      scopesRequired: ["emails:read"],
      method: "GET",
      path: "/v1/messages",
      status: 200,
      at: "2026-07-29T00:00:00.000Z",
    };
    const withTenant = formatApiAuthAuditLine({ ...base, tid: MAPPED_TENANT });
    expect(withTenant).toContain(`tid=${MAPPED_TENANT}`);
    expect(withTenant).toContain("kid=kid-1");

    const untenanted = formatApiAuthAuditLine({ ...base, tid: null });
    expect(untenanted).toContain("tid=-");
    // The line never carries token material — only ids and outcome fields.
    expect(withTenant).not.toContain("hasna_");
  });
});
