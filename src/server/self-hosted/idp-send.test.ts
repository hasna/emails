// Outbound send authorization for the IdP credential class (ADR-0001 Phase 1).
//
// An IdP-federated principal granted the ordinary `emails:write` scope must be
// able to POST /v1/messages/send within its mapped tenant, exactly like an API
// key: the send gate's tenant-wide-authority input recognizes the "idp"
// principal class instead of silently computing `false` (which turned every
// federated send into a 403 `send_key_required` with no obtainable send key —
// minting one is operator-gated on the wildcard scope the principal need not
// hold).
//
// Hermetic: fake query client, stubbed tenant-scoped store methods, no
// Postgres, no network. The outbound-policy stub reproduces the REAL
// send-authority branch of the store gate (send_key_required when neither a
// send key nor tenant-wide authority is present), so the assertion is on the
// user-visible outcome, not an internal flag alone.

import { describe, expect, it } from "bun:test";
import { verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { IdpTokenAuthenticator } from "./auth/idp-token.js";
import { generateTestIdpKey, signTestIdpToken } from "./auth/idp-test-support.js";
import { ALLOWED_EMAIL_DOMAINS_ENV } from "./auth/allowed-email.js";
import { selfScopedStore, testAuthDeps } from "./auth/test-support.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";
const TENANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const IDP_TID = "11111111-2222-3333-4444-555555555555";

const key = generateTestIdpKey("kid-send");

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
      return null;
    },
    async one<T>(): Promise<T> {
      return {} as T;
    },
    async execute() {},
  };
  return client;
}

function pendingRecord() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    direction: "outbound",
    from_addr: "agent@example.com",
    to_addrs: ["user@example.com"],
    cc_addrs: [],
    subject: "federated send",
    body_text: "hello",
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
    idempotency_key: "idp-send-key",
    send_payload_hash: "hash",
    send_state: "pending",
    send_started_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

interface Harness {
  deps: SelfHostedServiceDeps;
  policyInputs: Array<{ sendKeyToken?: string | null; allowTenantWideSend?: boolean }>;
}

function harness(mappings: Map<string, MappingRow>): Harness {
  const client = fakeClient(mappings);
  const deps: SelfHostedServiceDeps = {
    client,
    store: selfScopedStore(client),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => "provider-message-id" },
    migrations: emailsSelfHostedMigrations(),
    version: "9.9.9",
    ...testAuthDeps(client, SIGNING_SECRET),
    idpAuthenticator: new IdpTokenAuthenticator({
      jwksUrl: "https://idp.example.com/v1/.well-known/jwks.json",
      expectedAudiences: ["emails", "mailery"],
      fetchJwks: async () => ({ keys: [key.publicJwk] }),
    }),
  };
  deps.env = { ...deps.env, [ALLOWED_EMAIL_DOMAINS_ENV]: "example.com" };

  const policyInputs: Harness["policyInputs"] = [];
  const record = pendingRecord();
  const store = deps.store as unknown as Record<string, unknown>;
  store["reserveSendIntent"] = async () => ({ record, created: true });
  store["evaluateOutboundPolicy"] = async (input: {
    sendKeyToken?: string | null;
    allowTenantWideSend?: boolean;
  }) => {
    policyInputs.push(input);
    // The REAL send-authority branch of the store gate (store.ts): a caller
    // with neither a send key nor tenant-wide authority is refused, typed.
    if (!input.sendKeyToken && !input.allowTenantWideSend) {
      return {
        allowed: false,
        code: "send_key_required",
        message: "a sender-scoped send key is required",
        status: 403,
      };
    }
    return { allowed: true };
  };
  store["claimSendIntent"] = async () => ({ ...record, send_state: "sending" });
  store["completeSendIntent"] = async (_id: string, providerMessageId: string) => ({
    ...record,
    send_state: "sent",
    status: "sent",
    provider_message_id: providerMessageId,
  });
  store["markSendBlocked"] = async (_id: string, code: string) => ({
    ...record,
    send_state: "blocked",
    headers: { policy_denial: code },
  });
  return { deps, policyInputs };
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

function sendRequest(token: string): Request {
  return new Request("http://self-hosted.test/v1/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "agent@example.com",
      to: ["user@example.com"],
      subject: "federated send",
      text: "hello",
      idempotency_key: "idp-send-key",
    }),
  });
}

describe("IdP principal send authorization", () => {
  it("lets a mapped IdP principal holding emails:write send WITHOUT a send key or the wildcard", async () => {
    const { deps, policyInputs } = harness(new Map([["sp-agent-1", mappingRow()]]));
    const { token } = signTestIdpToken(key, {
      sub: "sp-agent-1",
      tid: IDP_TID,
      scope: ["emails:read", "emails:write"],
    });
    const response = await handleSelfHostedRequest(deps, sendRequest(token));
    const body = (await response.json()) as Record<string, unknown>;
    expect({ status: response.status, sent: body["sent"], reason: body["reason"] }).toEqual({
      status: 202,
      sent: true,
      reason: undefined,
    });
    expect(policyInputs).toHaveLength(1);
    expect(policyInputs[0]!.allowTenantWideSend).toBe(true);
  });

  it("grants the same authority to the wildcard operator scope", async () => {
    const { deps, policyInputs } = harness(new Map([["sp-agent-1", mappingRow()]]));
    const { token } = signTestIdpToken(key, { sub: "sp-agent-1", tid: IDP_TID, scope: ["emails:*"] });
    const response = await handleSelfHostedRequest(deps, sendRequest(token));
    expect(response.status).toBe(202);
    expect(policyInputs[0]!.allowTenantWideSend).toBe(true);
  });

  it("still refuses a read-only IdP grant at the route scope gate (never reaches the policy)", async () => {
    const { deps, policyInputs } = harness(new Map([["sp-agent-1", mappingRow()]]));
    const { token } = signTestIdpToken(key, { sub: "sp-agent-1", tid: IDP_TID, scope: ["emails:read"] });
    const response = await handleSelfHostedRequest(deps, sendRequest(token));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { reason?: string };
    expect(body.reason).toBe("insufficient_scope");
    expect(policyInputs).toHaveLength(0);
  });

  it("still refuses an unmapped IdP principal before any send machinery runs", async () => {
    const { deps, policyInputs } = harness(new Map());
    const { token } = signTestIdpToken(key, {
      sub: "sp-unmapped",
      tid: IDP_TID,
      scope: ["emails:read", "emails:write"],
    });
    const response = await handleSelfHostedRequest(deps, sendRequest(token));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { reason?: string };
    expect(body.reason).toBe("no_tenant");
    expect(policyInputs).toHaveLength(0);
  });
});
