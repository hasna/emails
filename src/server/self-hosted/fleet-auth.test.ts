// Fleet-token credential class at the service level (ADR-0001 Phase 1).
//
// Drives resolveRequestContext + GET /v1/me with a fake query client and an
// injected FleetTokenAuthenticator whose JWKS "fetch" is a stub. Asserts the
// new class end to end (verify → map sub → tenant → scopes → identity) AND
// that the existing hasna_/emss_ dispatch is untouched by its presence.
//
// Hermetic: fake query client, no Postgres, no network.

import { describe, expect, it } from "bun:test";
import { verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { FleetTokenAuthenticator } from "./auth/fleet-token.js";
import { generateTestFleetKey, signTestFleetToken } from "./auth/fleet-test-support.js";
import {
  resolveRequestContext,
  type FleetAuthAuditEvent,
} from "./auth/service.js";
import { ALLOWED_EMAIL_DOMAINS_ENV } from "./auth/allowed-email.js";
import { selfScopedStore, testAuthDeps } from "./auth/test-support.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";
const TENANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const FLEET_TID = "11111111-2222-3333-4444-555555555555";

const key = generateTestFleetKey("kid-svc");

interface MappingRow {
  sub: string;
  tenant_id: string;
  fleet_tid: string | null;
  principal_type: string;
  revoked_at: string | null;
}

function fakeClient(mappings: Map<string, MappingRow>): TypedQueryClient {
  const client: TypedQueryClient = {
    async query(sql, params) {
      const rows = (await client.many(sql, params)) as never[];
      return { rows, rowCount: rows.length };
    },
    async many<T>(): Promise<T[]> {
      return [] as T[];
    },
    async get<T>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      if (sql.includes("fleet_principal_tenants")) {
        return (mappings.get(String(params?.[0])) as T | undefined) ?? null;
      }
      if (sql.includes("FROM tenants WHERE id")) {
        return {
          id: String(params?.[0]),
          slug: "acme",
          name: "Acme",
          status: "active",
          created_at: "",
          updated_at: "",
        } as unknown as T;
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

function fleetAuthenticator(): FleetTokenAuthenticator {
  return new FleetTokenAuthenticator({
    jwksUrl: "https://idp.example.com/v1/.well-known/jwks.json",
    expectedAudiences: ["emails", "mailery"],
    fetchJwks: async () => ({ keys: [key.publicJwk] }),
  });
}

function deps(options: {
  mappings?: Map<string, MappingRow>;
  authenticator?: FleetTokenAuthenticator | null;
  audit?: (event: FleetAuthAuditEvent) => void;
} = {}): SelfHostedServiceDeps {
  const client = fakeClient(options.mappings ?? new Map());
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
  if (options.authenticator !== undefined) d.fleetAuthenticator = options.authenticator;
  if (options.audit) d.fleetAudit = options.audit;
  return d;
}

function mappingRow(overrides: Partial<MappingRow> = {}): MappingRow {
  return {
    sub: "sp-agent-1",
    tenant_id: TENANT_ID,
    fleet_tid: FLEET_TID,
    principal_type: "service",
    revoked_at: null,
    ...overrides,
  };
}

function get(path: string, token: string): Request {
  return new Request(`http://self-hosted.test${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function resolve(d: SelfHostedServiceDeps, token: string, requiredScopes: string[] = ["emails:read"]) {
  const url = new URL("http://self-hosted.test/v1/messages");
  return resolveRequestContext(d, get("/v1/messages", token), url, requiredScopes);
}

async function reason(response: Response): Promise<{ status: number; reason: string | undefined }> {
  const body = (await response.json()) as { reason?: string };
  return { status: response.status, reason: body.reason };
}

describe("fleet credential class — fail closed until configured", () => {
  it("refuses a fleet-shaped token with a typed 401 when no JWKS is configured", async () => {
    const { token } = signTestFleetToken(key, { sub: "sp-agent-1" });
    const result = await resolve(deps(), token);
    if (result.ok) throw new Error("expected refusal");
    expect(await reason(result.response)).toEqual({ status: 401, reason: "fleet_not_configured" });
  });

  it("surfaces JWKS unavailability as a typed 503, never an allow", async () => {
    const authenticator = new FleetTokenAuthenticator({
      jwksUrl: "https://idp.example.com/v1/.well-known/jwks.json",
      expectedAudiences: ["emails"],
      fetchJwks: async () => {
        throw new Error("down");
      },
    });
    const { token } = signTestFleetToken(key, { sub: "sp-agent-1" });
    const result = await resolve(deps({ authenticator }), token);
    if (result.ok) throw new Error("expected refusal");
    expect(await reason(result.response)).toEqual({ status: 503, reason: "jwks_unavailable" });
  });
});

describe("fleet credential class — mapping and scopes", () => {
  it("resolves a mapped principal to its tenant with normalized scopes", async () => {
    const mappings = new Map([["sp-agent-1", mappingRow()]]);
    const { token } = signTestFleetToken(key, { sub: "sp-agent-1", tid: FLEET_TID, scope: ["*"] });
    const result = await resolve(deps({ mappings, authenticator: fleetAuthenticator() }), token);
    if (!result.ok) throw new Error(`expected ok, got ${result.response.status}`);
    expect(result.ctx).toEqual({
      tenantId: TENANT_ID,
      principalType: "fleet",
      sub: "sp-agent-1",
      scopes: ["emails:*"],
    });
  });

  it("refuses an unmapped principal (403 no_tenant) — mapping is explicit, never inferred", async () => {
    const { token } = signTestFleetToken(key, { sub: "sp-unmapped", tid: FLEET_TID });
    const result = await resolve(deps({ authenticator: fleetAuthenticator() }), token);
    if (result.ok) throw new Error("expected refusal");
    expect(await reason(result.response)).toEqual({ status: 403, reason: "no_tenant" });
  });

  it("honors the emails-side kill switch (403 fleet_principal_revoked)", async () => {
    const mappings = new Map([["sp-agent-1", mappingRow({ revoked_at: "2026-07-28T00:00:00Z" })]]);
    const { token } = signTestFleetToken(key, { sub: "sp-agent-1", tid: FLEET_TID });
    const result = await resolve(deps({ mappings, authenticator: fleetAuthenticator() }), token);
    if (result.ok) throw new Error("expected refusal");
    expect(await reason(result.response)).toEqual({ status: 403, reason: "fleet_principal_revoked" });
  });

  it("refuses a token whose IdP tenant no longer matches the pinned grant (403 fleet_tenant_mismatch)", async () => {
    const mappings = new Map([["sp-agent-1", mappingRow()]]);
    const { token } = signTestFleetToken(key, { sub: "sp-agent-1", tid: "99999999-0000-0000-0000-000000000000" });
    const result = await resolve(deps({ mappings, authenticator: fleetAuthenticator() }), token);
    if (result.ok) throw new Error("expected refusal");
    expect(await reason(result.response)).toEqual({ status: 403, reason: "fleet_tenant_mismatch" });
  });

  it("enforces required scopes with wildcard satisfaction (read grant cannot write)", async () => {
    const mappings = new Map([["sp-agent-1", mappingRow()]]);
    const d = deps({ mappings, authenticator: fleetAuthenticator() });
    const readToken = signTestFleetToken(key, { sub: "sp-agent-1", tid: FLEET_TID, scope: ["emails:read"] }).token;
    const denied = await resolve(d, readToken, ["emails:write"]);
    if (denied.ok) throw new Error("expected refusal");
    expect(await reason(denied.response)).toEqual({ status: 403, reason: "insufficient_scope" });
    const allowed = await resolve(d, readToken, ["emails:read"]);
    expect(allowed.ok).toBe(true);
  });

  it("refuses an expired token with its typed verify reason", async () => {
    const mappings = new Map([["sp-agent-1", mappingRow()]]);
    const { token } = signTestFleetToken(key, { sub: "sp-agent-1", tid: FLEET_TID, nowMs: Date.now() - 10_000_000, ttlSeconds: 60 });
    const result = await resolve(deps({ mappings, authenticator: fleetAuthenticator() }), token);
    if (result.ok) throw new Error("expected refusal");
    expect(await reason(result.response)).toEqual({ status: 401, reason: "expired" });
  });
});

describe("fleet credential class — /v1/me identity", () => {
  it("returns the fleet principal, tenant and scopes", async () => {
    const mappings = new Map([["sp-agent-1", mappingRow()]]);
    const { token } = signTestFleetToken(key, { sub: "sp-agent-1", tid: FLEET_TID, scope: ["emails:read"] });
    const response = await handleSelfHostedRequest(
      deps({ mappings, authenticator: fleetAuthenticator() }),
      get("/v1/me", token),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["principal_type"]).toBe("fleet");
    expect(body["sub"]).toBe("sp-agent-1");
    expect(body["scopes"]).toEqual(["emails:read"]);
    expect((body["tenant"] as Record<string, unknown>)["id"]).toBe(TENANT_ID);
  });
});

describe("fleet credential class — audit + dispatch isolation", () => {
  it("emits allow and deny audit events carrying sub/jti/reason, never the token", async () => {
    const events: FleetAuthAuditEvent[] = [];
    const mappings = new Map([["sp-agent-1", mappingRow()]]);
    const d = deps({ mappings, authenticator: fleetAuthenticator(), audit: (e) => events.push(e) });
    const ok = signTestFleetToken(key, { sub: "sp-agent-1", tid: FLEET_TID, jti: "jti-ok" });
    const bad = signTestFleetToken(key, { sub: "sp-unmapped", tid: FLEET_TID, jti: "jti-bad" });
    await resolve(d, ok.token);
    await resolve(d, bad.token);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ outcome: "allow", sub: "sp-agent-1", jti: "jti-ok", reason: null });
    expect(events[1]).toMatchObject({ outcome: "deny", sub: "sp-unmapped", jti: "jti-bad", reason: "no_tenant" });
    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain(ok.token.slice(0, 24));
      expect(JSON.stringify(event)).not.toContain(bad.token.slice(0, 24));
    }
  });

  it("leaves the existing classes untouched: hasna_ still routes to the API-key verifier, junk is still 'malformed'", async () => {
    const d = deps({ authenticator: fleetAuthenticator() });
    const apiKey = await resolve(d, "hasna_not-a-real-key");
    if (apiKey.ok) throw new Error("expected refusal");
    expect(apiKey.response.status).toBe(401);
    expect((await apiKey.response.json()) as object).not.toMatchObject({ reason: "fleet_not_configured" });

    const junk = await resolve(d, "junk-token");
    if (junk.ok) throw new Error("expected refusal");
    expect(await reason(junk.response)).toEqual({ status: 401, reason: "malformed" });
  });
});
