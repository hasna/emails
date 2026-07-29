// Full binding of IdP token claims to the mapping and to downstream surfaces.
//
// The idp principal class was added to the resolver but not to everything
// downstream of it. Four gaps, one cause, pinned here:
//
//   1. `pt` (principal type) is signed in the token and stored on the grant —
//      the column exists precisely to be compared, and never was: a 'user'
//      token was accepted against a 'service' grant and vice versa.
//   2. The pinned wire contract says header typ 'at+jwt'; verification never
//      read `typ` (any EdDSA JWS the IdP key signed verified here regardless
//      of its intended token type), and `nbf` was never read either.
//   3. GET /v1/tenants/{id} computed own-tenant access only for the apikey
//      class, so an IdP principal reading the very tenant id /v1/me just
//      returned got 404.
//   4. The send-intent reconciliation ledger recorded IdP principals as the
//      literal 'apikey:unknown' — the wrong credential class, sub dropped.
//
// Hermetic: fake query client, stubbed store methods, no Postgres, no network.

import { describe, expect, it } from "bun:test";
import { verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import {
  IdpTokenAuthenticator,
  looksLikeIdpToken,
  verifyIdpToken,
} from "./auth/idp-token.js";
import { generateTestIdpKey, signTestIdpToken } from "./auth/idp-test-support.js";
import { resolveRequestContext } from "./auth/service.js";
import { ALLOWED_EMAIL_DOMAINS_ENV } from "./auth/allowed-email.js";
import { selfScopedStore, testAuthDeps } from "./auth/test-support.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";
const TENANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const IDP_TID = "11111111-2222-3333-4444-555555555555";

const key = generateTestIdpKey("kid-bind");

interface MappingRow {
  sub: string;
  tenant_id: string;
  idp_tid: string | null;
  principal_type: string;
  revoked_at: string | null;
}

function fakeClient(mappings: Map<string, MappingRow>): TypedQueryClient {
  const client: TypedQueryClient = {
    async query(sql, params) {
      const rows = (await client.many(sql, params)) as never[];
      return { rows, rowCount: rows.length };
    },
    async many<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      if (typeof sql === "string" && sql.includes("idp_principal_tenants")) {
        const row = mappings.get(String(params?.[0]));
        return (row ? [row] : []) as T[];
      }
      return [] as T[];
    },
    async get<T>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      if (sql.includes("idp_principal_tenants")) {
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

function idpAuthenticator(): IdpTokenAuthenticator {
  return new IdpTokenAuthenticator({
    jwksUrl: "https://idp.example.com/v1/.well-known/jwks.json",
    expectedAudiences: ["emails", "mailery"],
    fetchJwks: async () => ({ keys: [key.publicJwk] }),
  });
}

function deps(mappings: Map<string, MappingRow>): SelfHostedServiceDeps {
  const client = fakeClient(mappings);
  const d: SelfHostedServiceDeps = {
    client,
    store: selfScopedStore(client),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => "provider-message-id" },
    migrations: emailsSelfHostedMigrations(),
    version: "9.9.9",
    ...testAuthDeps(client, SIGNING_SECRET),
    idpAuthenticator: idpAuthenticator(),
  };
  d.env = { ...d.env, [ALLOWED_EMAIL_DOMAINS_ENV]: "example.com" };
  return d;
}

function mappingRow(overrides: Partial<MappingRow> = {}): MappingRow {
  return {
    sub: "sp-agent-1",
    tenant_id: TENANT_ID,
    idp_tid: IDP_TID,
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

async function resolve(d: SelfHostedServiceDeps, token: string) {
  const url = new URL("http://self-hosted.test/v1/messages");
  return resolveRequestContext(d, get("/v1/messages", token), url, ["emails:read"]);
}

async function reason(response: Response): Promise<{ status: number; reason: string | undefined }> {
  const body = (await response.json()) as { reason?: string };
  return { status: response.status, reason: body.reason };
}

describe("pt is bound to the grant's principal_type", () => {
  it("refuses a 'user' token against a 'service' grant, typed", async () => {
    const d = deps(new Map([["sp-agent-1", mappingRow({ principal_type: "service" })]]));
    const { token } = signTestIdpToken(key, { sub: "sp-agent-1", tid: IDP_TID, pt: "user" });
    const result = await resolve(d, token);
    if (result.ok) throw new Error("expected refusal");
    expect(await reason(result.response)).toEqual({ status: 403, reason: "idp_principal_type_mismatch" });
  });

  it("refuses a 'service' token against a 'user' grant, and accepts the matching type", async () => {
    const d = deps(new Map([["sp-agent-1", mappingRow({ principal_type: "user" })]]));
    const serviceToken = signTestIdpToken(key, { sub: "sp-agent-1", tid: IDP_TID, pt: "service" }).token;
    const denied = await resolve(d, serviceToken);
    if (denied.ok) throw new Error("expected refusal");
    expect((await denied.response.json() as { reason?: string }).reason).toBe("idp_principal_type_mismatch");

    const userToken = signTestIdpToken(key, { sub: "sp-agent-1", tid: IDP_TID, pt: "user" }).token;
    expect((await resolve(d, userToken)).ok).toBe(true);
  });
});

describe("header typ and nbf are validated", () => {
  it("verifyIdpToken refuses a non-access-token typ, typed", () => {
    const { token } = signTestIdpToken(key, { header: { alg: "EdDSA", kid: key.kid, typ: "JWT" } });
    expect(
      verifyIdpToken(token, { jwks: [key.publicJwk], expectedAudiences: ["emails"] }),
    ).toEqual({ ok: false, reason: "unsupported_typ" });
  });

  it("an EdDSA JWS without the at+jwt typ is NOT accepted through the resolver", async () => {
    const d = deps(new Map([["sp-agent-1", mappingRow()]]));
    const { token } = signTestIdpToken(key, {
      sub: "sp-agent-1",
      tid: IDP_TID,
      header: { alg: "EdDSA", kid: key.kid, typ: "JWT" },
    });
    const result = await resolve(d, token);
    if (result.ok) throw new Error("expected refusal — a non-at+jwt EdDSA JWS must never authenticate");
    expect(result.response.status).toBe(401);
  });

  it("looksLikeIdpToken keys the class on typ, not on the signature algorithm alone", () => {
    const declared = signTestIdpToken(key).token;
    expect(looksLikeIdpToken(declared)).toBe(true);
    const undeclared = signTestIdpToken(key, { header: { alg: "EdDSA", kid: key.kid } }).token;
    expect(looksLikeIdpToken(undeclared)).toBe(false);
  });

  it("refuses a token whose nbf lies in the future (not_yet_valid), honoring leeway", () => {
    const now = Date.now();
    const { token } = signTestIdpToken(key, { nowMs: now, nbf: Math.floor(now / 1000) + 600 });
    expect(
      verifyIdpToken(token, { jwks: [key.publicJwk], expectedAudiences: ["emails"], nowMs: now }),
    ).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(
      verifyIdpToken(token, {
        jwks: [key.publicJwk],
        expectedAudiences: ["emails"],
        nowMs: now,
        leewaySeconds: 900,
      }).ok,
    ).toBe(true);
  });
});

describe("GET /v1/tenants/{id} — an IdP principal can read its own tenant", () => {
  it("returns the tenant /v1/me just named instead of 404", async () => {
    const d = deps(new Map([["sp-agent-1", mappingRow()]]));
    const { token } = signTestIdpToken(key, { sub: "sp-agent-1", tid: IDP_TID, scope: ["emails:read"] });
    const response = await handleSelfHostedRequest(d, get(`/v1/tenants/${TENANT_ID}`, token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tenant?: { id?: string } };
    expect(body.tenant?.id).toBe(TENANT_ID);
  });

  it("still refuses a FOREIGN tenant id for an IdP principal", async () => {
    const d = deps(new Map([["sp-agent-1", mappingRow()]]));
    const { token } = signTestIdpToken(key, { sub: "sp-agent-1", tid: IDP_TID, scope: ["emails:read"] });
    const response = await handleSelfHostedRequest(
      d,
      get("/v1/tenants/99999999-0000-0000-0000-000000000000", token),
    );
    expect(response.status).toBe(404);
  });
});

describe("send-intent reconciliation names the IdP principal", () => {
  it("records resolvedBy as idp:<sub>, never apikey:unknown", async () => {
    const d = deps(new Map([["sp-agent-1", mappingRow()]]));
    const uncertain = {
      id: "22222222-2222-4222-8222-222222222222",
      direction: "outbound",
      from_addr: "agent@example.com",
      to_addrs: ["user@example.com"],
      cc_addrs: [],
      subject: "s",
      body_text: null,
      body_html: null,
      status: "queued",
      provider_message_id: null,
      message_id: null,
      in_reply_to: null,
      received_at: null,
      is_read: false,
      is_starred: false,
      labels: [],
      headers: {},
      attachments: [],
      source_id: null,
      idempotency_key: "k",
      send_payload_hash: null,
      send_state: "uncertain",
      send_started_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const resolutions: Array<{ resolvedBy?: string | null }> = [];
    const store = d.store as unknown as Record<string, unknown>;
    store["resolveMessageId"] = async (id: string) => ({ id });
    store["getMessage"] = async () => uncertain;
    store["reconcileUncertainSendIntent"] = async (
      _id: string,
      resolution: { resolvedBy?: string | null },
    ) => {
      resolutions.push(resolution);
      return { ...uncertain, send_state: "sent", provider_message_id: "prov-1" };
    };

    const { token } = signTestIdpToken(key, {
      sub: "sp-agent-1",
      tid: IDP_TID,
      scope: ["emails:read", "emails:write"],
    });
    const response = await handleSelfHostedRequest(
      d,
      new Request("http://self-hosted.test/v1/messages/send-intents/reconcile", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message_id: uncertain.id,
          outcome: "sent",
          provider_message_id: "prov-1",
          evidence: "provider dashboard message prov-1",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]!.resolvedBy).toBe("idp:sp-agent-1");
  });
});
