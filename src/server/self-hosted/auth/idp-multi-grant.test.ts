// Multi-grant keying for idp_principal_tenants (ADR-0001 Phase 1 follow-up).
//
// The table was keyed on `sub` alone with `ON CONFLICT (sub) DO UPDATE ...
// revoked_at = NULL`, which had two silent effects: granting a principal
// access to tenant B unauditably REVOKED its access to tenant A (the row was
// re-pointed), and re-running a grant for a principal an operator had
// deliberately killed un-revoked it. The table is now keyed on
// (sub, tenant_id): one principal can hold several tenant grants, a re-grant
// touches only its own (sub, tenant) row, and a re-grant NEVER resurrects a
// revoked mapping — restoring one is a separate, deliberate operation.
//
// Hermetic: fake query clients capturing SQL; the real-Postgres round-trip
// lives in idp.integration.test.ts.

import { describe, expect, it } from "bun:test";
import type { PoolQueryClient } from "../../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "../migrations.js";
import { AuthStore } from "./store.js";
import { resolveRequestContext, type AuthServiceDeps } from "./service.js";
import { IdpTokenAuthenticator } from "./idp-token.js";
import { generateTestIdpKey, signTestIdpToken } from "./idp-test-support.js";
import { RateLimiter } from "./rate-limit.js";
import { STUB_KEY_STORE, testAuthEnv, testAuthMailer } from "./test-support.js";
import { verifyApiKey } from "@hasna/contracts/auth";

const key = generateTestIdpKey("kid-multi");
const IDP_TID = "11111111-2222-3333-4444-555555555555";
const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface MappingRow {
  sub: string;
  tenant_id: string;
  idp_tid: string | null;
  principal_type: string;
  revoked_at: string | null;
}

interface Captured {
  sql: string;
  params: readonly unknown[] | undefined;
}

function fakeClient(rows: MappingRow[], captured: Captured[] = []): PoolQueryClient {
  const client = {
    async query(sql: string, params?: readonly unknown[]) {
      captured.push({ sql, params });
      return { rows: [] as never[], rowCount: 0 };
    },
    async many<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      captured.push({ sql, params });
      if (sql.includes("idp_principal_tenants")) {
        return rows.filter((row) => row.sub === String(params?.[0])) as T[];
      }
      return [] as T[];
    },
    async get<T>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      captured.push({ sql, params });
      if (sql.includes("idp_principal_tenants")) {
        return (rows.find((row) => row.sub === String(params?.[0])) as T | undefined) ?? null;
      }
      return null;
    },
    async one<T>(): Promise<T> {
      return {} as T;
    },
    async execute() {},
    async close() {},
    async transaction<T>(fn: (client: unknown) => Promise<T>): Promise<T> {
      return fn(client);
    },
  };
  return client as unknown as PoolQueryClient;
}

function deps(rows: MappingRow[]): AuthServiceDeps {
  const client = fakeClient(rows);
  return {
    authStore: new AuthStore(client),
    verifier: verifyApiKey({ app: "emails", signingSecret: "test-signing-secret-do-not-use-in-prod" }),
    sender: { provider: "ses", send: async () => "provider-message-id" },
    keyStore: STUB_KEY_STORE,
    signingSecret: "test-signing-secret-do-not-use-in-prod",
    rateLimiter: new RateLimiter(),
    mailer: testAuthMailer(),
    env: testAuthEnv(),
    idpAuthenticator: new IdpTokenAuthenticator({
      jwksUrl: "https://idp.example.com/v1/.well-known/jwks.json",
      expectedAudiences: ["emails", "mailery"],
      fetchJwks: async () => ({ keys: [key.publicJwk] }),
    }),
  };
}

function row(overrides: Partial<MappingRow>): MappingRow {
  return {
    sub: "sp-agent-1",
    tenant_id: TENANT_A,
    idp_tid: IDP_TID,
    principal_type: "service",
    revoked_at: null,
    ...overrides,
  };
}

async function resolve(d: AuthServiceDeps, sub = "sp-agent-1") {
  const url = new URL("http://self-hosted.test/v1/messages");
  const { token } = signTestIdpToken(key, { sub, tid: IDP_TID, scope: ["emails:read"] });
  const req = new Request(url, { headers: { Authorization: `Bearer ${token}` } });
  return resolveRequestContext(d, req, url, ["emails:read"]);
}

describe("resolution across multiple tenant grants for one sub", () => {
  it("resolves through the single LIVE grant when the principal's other grant is revoked", async () => {
    const d = deps([
      row({ tenant_id: TENANT_A, revoked_at: "2026-07-01T00:00:00Z" }),
      row({ tenant_id: TENANT_B }),
    ]);
    const result = await resolve(d);
    if (!result.ok) throw new Error(`expected ok, got ${result.response.status}`);
    expect(result.ctx.tenantId).toBe(TENANT_B);
  });

  it("refuses typed when several grants are simultaneously live (never picks one silently)", async () => {
    const d = deps([row({ tenant_id: TENANT_A }), row({ tenant_id: TENANT_B })]);
    const result = await resolve(d);
    if (result.ok) throw new Error("expected a typed refusal");
    const body = (await result.response.json()) as { reason?: string };
    expect({ status: result.response.status, reason: body.reason }).toEqual({
      status: 403,
      reason: "idp_grant_ambiguous",
    });
  });

  it("still reports every-grant-revoked as the kill switch, and no grants as no_tenant", async () => {
    const revoked = await resolve(
      deps([
        row({ tenant_id: TENANT_A, revoked_at: "2026-07-01T00:00:00Z" }),
        row({ tenant_id: TENANT_B, revoked_at: "2026-07-02T00:00:00Z" }),
      ]),
    );
    if (revoked.ok) throw new Error("expected refusal");
    expect(((await revoked.response.json()) as { reason?: string }).reason).toBe("idp_principal_revoked");

    const unmapped = await resolve(deps([]), "sp-unmapped");
    if (unmapped.ok) throw new Error("expected refusal");
    expect(((await unmapped.response.json()) as { reason?: string }).reason).toBe("no_tenant");
  });
});

describe("grant persistence — (sub, tenant_id) keying", () => {
  it("upserts on the composite key and NEVER writes revoked_at (a re-grant cannot resurrect a kill)", async () => {
    const captured: Captured[] = [];
    const store = new AuthStore(fakeClient([], captured));
    await store.upsertIdpPrincipalTenant({ sub: "sp-agent-1", tenantId: TENANT_A, idpTid: IDP_TID });
    const insert = captured.find((c) => c.sql.includes("INSERT INTO idp_principal_tenants"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("ON CONFLICT (sub, tenant_id)");
    // The DO UPDATE arm must not touch the kill switch (reading it back in a
    // RETURNING clause is fine; SETTING it is not).
    const from = insert!.sql.indexOf("DO UPDATE");
    const to = insert!.sql.includes("RETURNING") ? insert!.sql.indexOf("RETURNING") : insert!.sql.length;
    expect(insert!.sql.slice(from, to)).not.toContain("revoked_at");
  });

  it("revokes scoped to one tenant when asked, and across all of a sub's grants for the incident path", async () => {
    const captured: Captured[] = [];
    const store = new AuthStore(fakeClient([], captured));
    await store.revokeIdpPrincipalTenant("sp-agent-1", TENANT_A);
    const scoped = captured.find((c) => c.sql.includes("UPDATE idp_principal_tenants"));
    expect(scoped).toBeDefined();
    expect(scoped!.sql).toContain("tenant_id");
    expect(scoped!.params).toEqual(["sp-agent-1", TENANT_A]);

    captured.length = 0;
    await store.revokeIdpPrincipalTenant("sp-agent-1");
    const all = captured.find((c) => c.sql.includes("UPDATE idp_principal_tenants"));
    expect(all).toBeDefined();
    expect(all!.sql).not.toContain("tenant_id =");
    expect(all!.params).toEqual(["sp-agent-1"]);
  });

  it("restores a revoked grant only through the explicit restore operation", async () => {
    const captured: Captured[] = [];
    const store = new AuthStore(fakeClient([], captured));
    await store.restoreIdpPrincipalTenant("sp-agent-1", TENANT_A);
    const restore = captured.find(
      (c) => c.sql.includes("UPDATE idp_principal_tenants") && c.sql.includes("revoked_at = NULL"),
    );
    expect(restore).toBeDefined();
    expect(restore!.params).toEqual(["sp-agent-1", TENANT_A]);
  });
});

describe("migration 0024 — composite keying is declared additively", () => {
  it("ships an idempotent migration that keys the table on (sub, tenant_id)", () => {
    const migration = emailsSelfHostedMigrations().find(
      (m) => m.id === "0024_idp_principal_tenants_multi_grant",
    );
    expect(migration).toBeDefined();
    expect(migration!.sql).toContain("idp_principal_tenants_sub_tenant_key");
    expect(migration!.sql).toContain("(sub, tenant_id)");
    // The unique composite index must exist BEFORE the sub-only primary key is
    // dropped, so uniqueness never lapses mid-migration.
    expect(migration!.sql.indexOf("idp_principal_tenants_sub_tenant_key")).toBeLessThan(
      migration!.sql.indexOf("DROP CONSTRAINT IF EXISTS idp_principal_tenants_pkey"),
    );
  });
});
