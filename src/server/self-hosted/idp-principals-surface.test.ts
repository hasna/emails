// Operator surface for IdP-principal federation grants (ADR-0001/0002).
//
// The federation slice was inert: upsertIdpPrincipalTenant and
// revokeIdpPrincipalTenant had zero non-test callers, so no grant row could
// exist without hand SQL against production — and revoked_at, the ONLY
// revocation emails can enforce inside a token's ≤24h life, had no operator
// surface either. These routes make a grant auditable and a revocation
// one call:
//
//   GET    /v1/idp-principals               list this tenant's grants
//   POST   /v1/idp-principals               grant  { sub, ... } -> this tenant
//   POST   /v1/idp-principals/{sub}/revoke  throw the kill switch
//   DELETE /v1/idp-principals/{sub}         same as revoke
//   POST   /v1/idp-principals/{sub}/restore deliberately lift the kill switch
//
// All are privilege-GRANTING operations (they change WHO may act in the
// tenant), so — exactly like send-key minting — they require a tenant
// owner/admin or the wildcard operator scope, never bare emails:write. The
// tenant is ALWAYS the caller's resolved tenant, never a parameter.
//
// Hermetic: fake query client + patched auth store, no Postgres.

import { describe, expect, test } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { DEFAULT_TENANT_ID } from "./migrations.js";
import { selfScopedStore, testAuthDeps } from "./auth/test-support.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

function fakeClient(): TypedQueryClient {
  const client: TypedQueryClient = {
    async query() {
      return { rows: [] as never[], rowCount: 0 };
    },
    async many<T>(): Promise<T[]> {
      return [] as T[];
    },
    async get<T>(): Promise<T | null> {
      return null;
    },
    async one<T>(): Promise<T> {
      return {} as T;
    },
    async execute() {},
  };
  return client;
}

type Role = "owner" | "admin" | "member" | "viewer";

const SESSION_TOKENS: Record<Role, string> = {
  owner: "emss_session_owner",
  admin: "emss_session_admin",
  member: "emss_session_member",
  viewer: "emss_session_viewer",
};

interface Spy {
  upserts: unknown[];
  revokes: unknown[];
  restores: unknown[];
  lists: unknown[];
}

function deps(): { d: SelfHostedServiceDeps; spy: Spy } {
  const client = fakeClient();
  const spy: Spy = { upserts: [], revokes: [], restores: [], lists: [] };
  const d: SelfHostedServiceDeps = {
    client,
    store: selfScopedStore(client),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => "provider-message-id" },
    migrations: emailsSelfHostedMigrations(),
    version: "9.9.9",
    ...testAuthDeps(client, SIGNING_SECRET),
  };

  d.authStore.resolveSession = (async (token: string) => {
    const entry = (Object.entries(SESSION_TOKENS) as Array<[Role, string]>).find(([, value]) => value === token);
    if (!entry) return null;
    return { tenantId: DEFAULT_TENANT_ID, userId: `user-${entry[0]}`, role: entry[0], globalRole: null };
  }) as typeof d.authStore.resolveSession;

  d.authStore.upsertIdpPrincipalTenant = (async (input: unknown) => {
    spy.upserts.push(input);
    const grant = input as { sub: string; tenantId: string; idpTid?: string | null };
    return {
      sub: grant.sub,
      tenantId: grant.tenantId,
      idpTid: grant.idpTid ?? null,
      principalType: "service" as const,
      revokedAt: null,
    };
  }) as typeof d.authStore.upsertIdpPrincipalTenant;

  d.authStore.revokeIdpPrincipalTenant = (async (sub: string, tenantId?: string) => {
    spy.revokes.push({ sub, tenantId });
    return sub === "sp-known";
  }) as typeof d.authStore.revokeIdpPrincipalTenant;

  d.authStore.restoreIdpPrincipalTenant = (async (sub: string, tenantId: string) => {
    spy.restores.push({ sub, tenantId });
    return sub === "sp-known";
  }) as typeof d.authStore.restoreIdpPrincipalTenant;

  d.authStore.listIdpPrincipalTenants = (async (tenantId: string) => {
    spy.lists.push(tenantId);
    return [
      {
        sub: "sp-known",
        tenantId,
        idpTid: "11111111-2222-3333-4444-555555555555",
        principalType: "service" as const,
        note: "ci agent",
        createdAt: "2026-07-01T00:00:00Z",
        revokedAt: null,
      },
    ];
  }) as typeof d.authStore.listIdpPrincipalTenants;

  return { d, spy };
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

const writeScopedKey = () => mintApiKey({ app: "emails", scopes: ["emails:write"], signingSecret: SIGNING_SECRET }).token;
const operatorKey = () => mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET }).token;

describe("granting an IdP principal", () => {
  test("an owner grants a principal into THEIR resolved tenant (never a body-chosen one)", async () => {
    const { d, spy } = deps();
    const res = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/idp-principals", {
        token: SESSION_TOKENS.owner,
        body: {
          sub: "sp-new-agent",
          idp_tid: "11111111-2222-3333-4444-555555555555",
          tenant_id: "some-other-tenant-the-caller-typed",
          note: "signup",
        },
      }),
    );
    expect(res?.status).toBe(201);
    const body = (await res!.json()) as { grant?: { sub?: string; tenant_id?: string } };
    expect(body.grant?.sub).toBe("sp-new-agent");
    expect(body.grant?.tenant_id).toBe(DEFAULT_TENANT_ID);
    expect(spy.upserts).toHaveLength(1);
    expect(spy.upserts[0]).toMatchObject({ sub: "sp-new-agent", tenantId: DEFAULT_TENANT_ID });
  });

  test("a member (bare emails:write) cannot grant — typed operator_required, nothing reaches the store", async () => {
    const { d, spy } = deps();
    const res = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/idp-principals", { token: SESSION_TOKENS.member, body: { sub: "sp-x" } }),
    );
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ reason: "operator_required" });
    expect(spy.upserts).toEqual([]);
  });

  test("a write-scoped API key cannot grant either; the wildcard operator key can", async () => {
    const { d, spy } = deps();
    const denied = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/idp-principals", { token: writeScopedKey(), body: { sub: "sp-x" } }),
    );
    expect(denied?.status).toBe(403);
    expect(await denied!.json()).toMatchObject({ reason: "operator_required" });
    expect(spy.upserts).toEqual([]);

    const allowed = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/idp-principals", { token: operatorKey(), body: { sub: "sp-x" } }),
    );
    expect(allowed?.status).toBe(201);
    expect(spy.upserts).toHaveLength(1);
  });

  test("a grant without a sub is a 400, not a row", async () => {
    const { d, spy } = deps();
    const res = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/idp-principals", { token: SESSION_TOKENS.owner, body: { note: "no sub" } }),
    );
    expect(res?.status).toBe(400);
    expect(spy.upserts).toEqual([]);
  });
});

describe("listing grants", () => {
  test("an admin lists the tenant's grants; a member is refused", async () => {
    const { d, spy } = deps();
    const res = await handleSelfHostedRequest(d, req("GET", "/v1/idp-principals", { token: SESSION_TOKENS.admin }));
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { idp_principals?: Array<{ sub?: string }> };
    expect(body.idp_principals?.[0]?.sub).toBe("sp-known");
    expect(spy.lists).toEqual([DEFAULT_TENANT_ID]);

    const denied = await handleSelfHostedRequest(d, req("GET", "/v1/idp-principals", { token: SESSION_TOKENS.member }));
    expect(denied?.status).toBe(403);
  });
});

describe("the kill switch is pullable in one call", () => {
  test("owner revokes via POST .../revoke; the revocation is tenant-scoped", async () => {
    const { d, spy } = deps();
    const res = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/idp-principals/sp-known/revoke", { token: SESSION_TOKENS.owner }),
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toMatchObject({ revoked: true, sub: "sp-known" });
    expect(spy.revokes).toEqual([{ sub: "sp-known", tenantId: DEFAULT_TENANT_ID }]);
  });

  test("DELETE /v1/idp-principals/{sub} is the same operation", async () => {
    const { d, spy } = deps();
    const res = await handleSelfHostedRequest(
      d,
      req("DELETE", "/v1/idp-principals/sp-known", { token: SESSION_TOKENS.owner }),
    );
    expect(res?.status).toBe(200);
    expect(spy.revokes).toHaveLength(1);
  });

  test("revoking a sub with no live grant in this tenant is a typed 404", async () => {
    const { d } = deps();
    const res = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/idp-principals/sp-unknown/revoke", { token: SESSION_TOKENS.owner }),
    );
    expect(res?.status).toBe(404);
    expect(await res!.json()).toMatchObject({ reason: "not_found" });
  });

  test("a member cannot pull the kill switch (privilege boundary, same as granting)", async () => {
    const { d, spy } = deps();
    const res = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/idp-principals/sp-known/revoke", { token: SESSION_TOKENS.member }),
    );
    expect(res?.status).toBe(403);
    expect(spy.revokes).toEqual([]);
  });
});

describe("restore is a separate deliberate act", () => {
  test("owner restores a revoked grant explicitly", async () => {
    const { d, spy } = deps();
    const res = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/idp-principals/sp-known/restore", { token: SESSION_TOKENS.owner }),
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toMatchObject({ restored: true, sub: "sp-known" });
    expect(spy.restores).toEqual([{ sub: "sp-known", tenantId: DEFAULT_TENANT_ID }]);
  });

  test("a member cannot restore", async () => {
    const { d, spy } = deps();
    const res = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/idp-principals/sp-known/restore", { token: SESSION_TOKENS.member }),
    );
    expect(res?.status).toBe(403);
    expect(spy.restores).toEqual([]);
  });
});
