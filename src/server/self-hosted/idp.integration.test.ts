// Idp credential class against a REAL Postgres (ADR-0001 Phase 1).
//
// Proves what the hermetic idp tests cannot: migration 0021 actually creates
// the resolution table (outside RLS, idempotent), the AuthStore mapping methods
// run real SQL, and resolveRequestContext resolves a real signed token through
// the real store — allow, emails-side revocation, and the suspended-tenant
// fail-close.
//
// Gated on EMAILS_TEST_POSTGRES_URL (an ephemeral Postgres), like every other
// *.integration.test.ts here. Additionally, when EMAILS_TEST_TENANTS_JWKS_URL
// points at a locally-running @hasna/tenants instance, the JWKS-fetch path is
// exercised against that live endpoint (shape assertions only — minting a live
// token needs the IdP's service-principal issuance, a named open-tenants gap).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { verifyApiKey } from "@hasna/contracts/auth";
import { createPgPool, createQueryClient, MigrationLedger } from "../../storage-kit/index.js";
import type { PoolQueryClient } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { EmailsSelfHostedStore } from "./store.js";
import type { SelfHostedServiceDeps } from "./service.js";
import { AuthStore } from "./auth/store.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { resolveRequestContext } from "./auth/service.js";
import { IdpTokenAuthenticator, parseIdpClaimsUnverified } from "./auth/idp-token.js";
import { generateTestIdpKey, signTestIdpToken } from "./auth/idp-test-support.js";
import { testAuthEnv, testAuthMailer, STUB_KEY_STORE } from "./auth/test-support.js";

const databaseUrl = process.env["EMAILS_TEST_POSTGRES_URL"];
const pg: PoolQueryClient | null = databaseUrl
  ? createQueryClient(createPgPool({ connectionString: databaseUrl, env: { PGSSLMODE: "disable" } }))
  : null;

const liveJwksUrl = process.env["EMAILS_TEST_TENANTS_JWKS_URL"];

const TENANT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const IDP_TID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";
const key = generateTestIdpKey("kid-int");

function deps(): SelfHostedServiceDeps {
  return {
    client: pg!,
    store: new EmailsSelfHostedStore(pg!),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => "provider-message-id" },
    migrations: emailsSelfHostedMigrations(),
    version: "9.9.9",
    authStore: new AuthStore(pg!),
    keyStore: STUB_KEY_STORE,
    signingSecret: SIGNING_SECRET,
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

async function resolve(token: string) {
  const url = new URL("http://self-hosted.test/v1/messages");
  const req = new Request(url, { headers: { Authorization: `Bearer ${token}` } });
  return resolveRequestContext(deps(), req, url, ["emails:read"]);
}

async function denyReason(result: Awaited<ReturnType<typeof resolve>>): Promise<{ status: number; reason: string | undefined }> {
  if (result.ok) throw new Error("expected a refusal");
  const body = (await result.response.json()) as { reason?: string };
  return { status: result.response.status, reason: body.reason };
}

beforeAll(async () => {
  if (!pg) return;
  await pg.execute("DROP SCHEMA IF EXISTS public CASCADE");
  await pg.execute("CREATE SCHEMA public");
  await new MigrationLedger(pg, emailsSelfHostedMigrations()).migrate();
  await pg.execute(
    `INSERT INTO tenants (id, slug, name, status) VALUES ($1, 'idp-int', 'Idp Int', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_ID],
  );
});

afterAll(async () => {
  await pg?.close();
});

describe.skipIf(!pg)("migration 0021 — idp_principal_tenants", () => {
  it("creates the resolution table OUTSIDE row-level security", async () => {
    const table = await pg!.one<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'idp_principal_tenants'`,
    );
    // Resolution tables are read BEFORE a tenant is known; RLS here would make
    // every idp authentication fail. Absence is the designed state.
    expect(table).toEqual({ relrowsecurity: false, relforcerowsecurity: false });
  });

  it("is internally idempotent: re-executing its SQL is a clean no-op", async () => {
    const migration = emailsSelfHostedMigrations().find((m) => m.id === "0021_idp_principal_tenants")!;
    await pg!.execute(migration.sql);
    await pg!.execute(migration.sql);
    expect(migration).toBeDefined();
  });

  it("keys the table on (sub, tenant_id) after 0022, idempotently", async () => {
    const migration = emailsSelfHostedMigrations().find(
      (m) => m.id === "0022_idp_principal_tenants_multi_grant",
    )!;
    await pg!.execute(migration.sql);
    await pg!.execute(migration.sql);
    const index = await pg!.get<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idp_principal_tenants_sub_tenant_key'`,
    );
    expect(index?.indexdef).toContain("UNIQUE");
    const pk = await pg!.get<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'idp_principal_tenants_pkey'`,
    );
    expect(pk).toBeNull();
  });
});

describe.skipIf(!pg)("AuthStore idp mapping — real SQL round-trip", () => {
  const store = () => new AuthStore(pg!);

  it("upserts, resolves, and revokes a mapping", async () => {
    await store().upsertIdpPrincipalTenant({
      sub: "sp-roundtrip",
      tenantId: TENANT_ID,
      idpTid: IDP_TID,
      note: "integration",
    });
    const [mapping] = await store().listIdpPrincipalTenantsForSub("sp-roundtrip");
    expect(mapping).toMatchObject({
      sub: "sp-roundtrip",
      tenantId: TENANT_ID,
      idpTid: IDP_TID,
      principalType: "service",
      revokedAt: null,
    });

    expect(await store().revokeIdpPrincipalTenant("sp-roundtrip")).toBe(true);
    const [revoked] = await store().listIdpPrincipalTenantsForSub("sp-roundtrip");
    expect(revoked?.revokedAt).not.toBeNull();
    // Second revoke is a no-op, reported as such.
    expect(await store().revokeIdpPrincipalTenant("sp-roundtrip")).toBe(false);
    // Re-granting must NOT resurrect the kill switch: the revocation stands
    // until the explicit restore operation lifts it.
    const regrant = await store().upsertIdpPrincipalTenant({ sub: "sp-roundtrip", tenantId: TENANT_ID, idpTid: IDP_TID });
    expect(regrant?.revokedAt).not.toBeNull();
    expect((await store().listIdpPrincipalTenantsForSub("sp-roundtrip"))[0]?.revokedAt).not.toBeNull();
    expect(await store().restoreIdpPrincipalTenant("sp-roundtrip", TENANT_ID)).toBe(true);
    expect((await store().listIdpPrincipalTenantsForSub("sp-roundtrip"))[0]?.revokedAt).toBeNull();
  });

  it("holds several tenant grants per sub, each with an independent kill switch", async () => {
    const second = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await pg!.execute(
      `INSERT INTO tenants (id, slug, name, status) VALUES ($1, 'idp-second', 'Second', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [second],
    );
    await store().upsertIdpPrincipalTenant({ sub: "sp-multi", tenantId: TENANT_ID, idpTid: IDP_TID });
    await store().upsertIdpPrincipalTenant({ sub: "sp-multi", tenantId: second, idpTid: IDP_TID });
    const grants = await store().listIdpPrincipalTenantsForSub("sp-multi");
    // Granting the second tenant did NOT re-point (revoke) the first grant.
    expect(grants.map((g) => g.tenantId).sort()).toEqual([TENANT_ID, second].sort());

    // A tenant-scoped revoke kills exactly one grant.
    expect(await store().revokeIdpPrincipalTenant("sp-multi", second)).toBe(true);
    const after = await store().listIdpPrincipalTenantsForSub("sp-multi");
    expect(after.find((g) => g.tenantId === second)?.revokedAt).not.toBeNull();
    expect(after.find((g) => g.tenantId === TENANT_ID)?.revokedAt).toBeNull();

    // The unscoped incident path kills everything left.
    expect(await store().revokeIdpPrincipalTenant("sp-multi")).toBe(true);
    const killed = await store().listIdpPrincipalTenantsForSub("sp-multi");
    expect(killed.every((g) => g.revokedAt !== null)).toBe(true);
  });

  it("fails closed when the mapped tenant is suspended", async () => {
    const suspended = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await pg!.execute(
      `INSERT INTO tenants (id, slug, name, status) VALUES ($1, 'idp-sus', 'Suspended', 'suspended')
       ON CONFLICT (id) DO NOTHING`,
      [suspended],
    );
    await store().upsertIdpPrincipalTenant({ sub: "sp-suspended", tenantId: suspended });
    expect(await store().listIdpPrincipalTenantsForSub("sp-suspended")).toEqual([]);
  });
});

describe.skipIf(!pg)("resolveRequestContext with a real store and real signed tokens", () => {
  it("allows a mapped principal, then honors the emails-side kill switch", async () => {
    await new AuthStore(pg!).upsertIdpPrincipalTenant({
      sub: "sp-e2e",
      tenantId: TENANT_ID,
      idpTid: IDP_TID,
    });
    const { token } = signTestIdpToken(key, { sub: "sp-e2e", tid: IDP_TID, scope: ["emails:*"] });

    const allowed = await resolve(token);
    if (!allowed.ok) throw new Error("expected allow");
    expect(allowed.ctx).toEqual({
      tenantId: TENANT_ID,
      principalType: "idp",
      sub: "sp-e2e",
      scopes: ["emails:*"],
    });

    await new AuthStore(pg!).revokeIdpPrincipalTenant("sp-e2e");
    expect(await denyReason(await resolve(token))).toEqual({ status: 403, reason: "idp_principal_revoked" });
  });

  it("refuses an unmapped principal against the real table", async () => {
    const { token } = signTestIdpToken(key, { sub: "sp-never-mapped", tid: IDP_TID });
    expect(await denyReason(await resolve(token))).toEqual({ status: 403, reason: "no_tenant" });
  });
});

describe.skipIf(!liveJwksUrl)("live @hasna/tenants JWKS endpoint", () => {
  it("serves a JWKS the authenticator accepts, and refuses our locally-signed token (typed unknown_kid)", async () => {
    const authenticator = new IdpTokenAuthenticator({
      jwksUrl: liveJwksUrl!,
      expectedAudiences: ["emails", "mailery"],
    });
    // A locally-signed token must be refused with a typed reason (never a 5xx):
    // the live IdP does not hold our throwaway key. This proves the fetch path,
    // the JWKS parse, and the fail-closed verify against real key material.
    const { token } = signTestIdpToken(key, { sub: "sp-live" });
    const result = await authenticator.authenticate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["unknown_kid", "bad_signature"]).toContain(result.reason);
    expect(parseIdpClaimsUnverified(token)?.sub).toBe("sp-live");
  });
});
