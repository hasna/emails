import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import {
  SelfHostedHttpError,
  selfHostedStoreFor,
  resetSelfHostedConfigCache,
} from "./db/self-hosted-store.js";
import { getAgentContextForRuntime, getEmailSystemStatusForRuntime } from "./lib/agent-context.js";
import { resetMailDataSource } from "./lib/mail-data-source.js";
import { SelfHostedMailDataSource } from "./lib/self-hosted-mail-data-source.js";
import {
  SELF_HOSTED_RESPONSE_COMPONENTS,
  SELF_HOSTED_RESPONSE_CONTRACTS,
} from "./lib/self-hosted-response-contracts.generated.js";
import {
  parseSelfHostedSuccessJson,
  projectSelfHostedMailErrorBody,
  SelfHostedResponseSizeError,
  SelfHostedWireResponseError,
  SUPPORTED_SELF_HOSTED_RESPONSE_FORMATS,
  validateSelfHostedSdkSuccessResponse,
} from "./lib/self-hosted-wire.js";
import { fetchIdentitySafe } from "./lib/whoami.js";
import { activeProviderId, sendComposed } from "./cli/tui/data.remote.js";
import { ApiError, EmailsSelfHostClient } from "./selfhost.js";

const RESPONSE_SECRET_MARKER = "credential-like-response-body-must-not-leak";
type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaSample(schema: JsonSchema): unknown {
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    const component = SELF_HOSTED_RESPONSE_COMPONENTS[
      ref.slice("#/components/schemas/".length)
    ];
    if (!isRecord(component)) throw new Error(`missing response component ${ref}`);
    return schemaSample(component);
  }
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];
  const oneOf = schema["oneOf"];
  if (Array.isArray(oneOf)) {
    const branch = oneOf.at(-1);
    if (isRecord(branch)) return schemaSample(branch);
  }
  const allOf = schema["allOf"];
  if (Array.isArray(allOf)) {
    return allOf.reduce<Record<string, unknown>>((sample, branch) => {
      const value = isRecord(branch) ? schemaSample(branch) : undefined;
      return isRecord(value) ? { ...sample, ...value } : sample;
    }, {});
  }
  if (
    schema["type"] === "object"
    || Array.isArray(schema["required"])
    || isRecord(schema["properties"])
  ) {
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    const required = Array.isArray(schema["required"]) ? schema["required"] : [];
    return required.reduce<Record<string, unknown>>((sample, field) => {
      if (typeof field === "string" && isRecord(properties[field])) {
        sample[field] = schemaSample(properties[field]);
      }
      return sample;
    }, {});
  }
  if (schema["type"] === "array") {
    return isRecord(schema["items"]) ? [schemaSample(schema["items"])] : [];
  }
  if (schema["type"] === "boolean") return false;
  if (schema["type"] === "integer" || schema["type"] === "number") {
    return schema["minimum"] ?? 0;
  }
  if (schema["type"] === "string") {
    if (schema["format"] === "uuid") return "12345678-1234-4234-8234-123456789abc";
    if (schema["format"] === "email") return "fixture@example.test";
    if (schema["format"] === "date-time") return "2026-07-26T10:00:00.000Z";
    return "x".repeat(Math.max(1, Number(schema["minLength"] ?? 1)));
  }
  return null;
}

function responseSample(method: string, path: string, status: number): Record<string, unknown> {
  const contract = SELF_HOSTED_RESPONSE_CONTRACTS.find((candidate) => {
    if (candidate.method !== method || candidate.status !== status) return false;
    const pattern = candidate.path
      .split(/(\{[^}]+\})/g)
      .map((part) => part.startsWith("{")
        ? "[^/]+"
        : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("");
    return new RegExp(`^${pattern}$`).test(path);
  });
  if (!contract || !isRecord(contract.schema)) {
    throw new Error(`missing response contract ${method} ${path} ${status}`);
  }
  const sample = schemaSample(contract.schema);
  if (!isRecord(sample)) throw new Error("response sample is not an object");
  return sample;
}

const SERVER_CODE = String.raw`
const secret = "credential-like-response-body-must-not-leak";
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/providers") {
      return new Response("{" + secret, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/v1/domains") return json([]);
    if (url.pathname === "/v1/addresses") return json({ addresses: [{ status: "active" }] });
    if (url.pathname === "/v1/contacts") return json({});
    if (url.pathname === "/v1/templates") {
      return json({ items: [], padding: "x".repeat(4096) });
    }
    if (url.pathname === "/v1/groups") {
      return json({
        error: secret,
        reason: "provider_rejected",
        message: { id: "safe-id", subject: secret, body_text: secret },
      }, 500);
    }
    if (url.pathname === "/v1/messages/counts") return json({ counts: {} });
    if (url.pathname === "/v1/messages/missing-fields") {
      return json({ message: { direction: "inbound" } });
    }
    if (url.pathname === "/v1/messages") {
      const search = url.searchParams.get("search");
      if (search === "malformed") {
        return new Response("{" + secret, { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (search === "wrong-shape") return json([]);
      if (search === "missing-fields") {
        return json({ messages: [{ direction: "inbound" }], next_cursor: null });
      }
      return json({ messages: [], next_cursor: null });
    }
    if (url.pathname === "/v1/messages/send") {
      const submitted = await request.json();
      if (submitted.subject === "in-progress") {
        return json({
          message: {
            id: "message-in-progress",
            direction: "outbound",
            from_addr: submitted.from,
            to_addrs: submitted.to,
            cc_addrs: [],
            subject: submitted.subject,
            body_text: submitted.text,
            body_html: submitted.html ?? null,
            status: "sending",
            provider_message_id: null,
            message_id: null,
            in_reply_to: null,
            received_at: null,
            is_read: true,
            is_starred: false,
            labels: [],
            headers: {},
            attachments: [],
            source_id: null,
            send_state: "sending",
            send_started_at: "2026-07-26T10:00:00.000Z",
            created_at: "2026-07-26T10:00:00.000Z",
            updated_at: "2026-07-26T10:00:00.000Z",
          },
          provider: "sandbox",
          in_progress: true,
        }, 202);
      }
      return json({
        error: secret,
        reason: "provider_rejected",
        retry_safe: true,
        sent: false,
        message: { id: "safe-id", send_state: "failed" },
      }, 422);
    }
    if (url.pathname === "/v1/me") return json({});
    return json({ error: "not found" }, 404);
  },
});
console.log("PORT " + server.port);
`;

let server: Subprocess;
let baseUrl: string;

async function startLoopbackServer(): Promise<{ server: Subprocess; baseUrl: string }> {
  const child = Bun.spawn(["bun", "-e", SERVER_CODE], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
  }
  reader.releaseLock();
  const port = output.match(/PORT (\d+)/)?.[1];
  if (!port) throw new Error(`loopback server did not report a port: ${output}`);
  return { server: child, baseUrl: `http://127.0.0.1:${port}` };
}

function applySelfHostedEnv(): void {
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = baseUrl;
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = "loopback-test-key";
  resetSelfHostedConfigCache();
  resetMailDataSource();
}

function clearSelfHostedEnv(): void {
  delete process.env["EMAILS_MODE"];
  delete process.env["EMAILS_SELF_HOSTED_URL"];
  delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
  delete process.env["EMAILS_SELF_HOSTED_HTTP_MAX_RESPONSE_BYTES"];
  resetSelfHostedConfigCache();
  resetMailDataSource();
}

async function expectSafeRejection(operation: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await operation;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(String(thrown)).toMatch(/self-hosted.*invalid|invalid.*self-hosted/i);
  expect(String(thrown)).not.toContain(RESPONSE_SECRET_MARKER);
}

beforeAll(async () => {
  ({ server, baseUrl } = await startLoopbackServer());
});

afterAll(() => {
  server?.kill();
});

afterEach(clearSelfHostedEnv);

describe("self-hosted successful-response wire contract", () => {
  test("generic stores reject malformed JSON instead of synthesizing an empty list", () => {
    applySelfHostedEnv();
    expect(() => selfHostedStoreFor("providers").list()).toThrow(/invalid.*JSON/i);
  });

  test("generic stores reject wrong list envelopes and rows missing their identity", () => {
    applySelfHostedEnv();
    expect(() => selfHostedStoreFor("domains").list()).toThrow(/invalid successful response/i);
    expect(() => selfHostedStoreFor("contacts").list()).toThrow(/invalid successful response/i);
    expect(() => selfHostedStoreFor("addresses").list()).toThrow(/invalid.*id/i);
  });

  test("inbox list and search reject malformed, wrong-shaped, and incomplete pages", async () => {
    const dataSource = new SelfHostedMailDataSource({
      baseUrl: `${baseUrl}/v1`,
      apiKey: "loopback-test-key",
    });
    await expectSafeRejection(dataSource.listMailbox("inbox", { search: "malformed" }));
    await expectSafeRejection(dataSource.listMailbox("inbox", { search: "wrong-shape" }));
    await expectSafeRejection(dataSource.listMailbox("inbox", { search: "missing-fields" }));
  });

  test("inbox reads reject message objects missing required wire fields", async () => {
    const dataSource = new SelfHostedMailDataSource({
      baseUrl: `${baseUrl}/v1`,
      apiKey: "loopback-test-key",
    });
    await expectSafeRejection(dataSource.getMessage("missing-fields"));
  });

  test("status, context, and sync-status backing reads reject incomplete counts", async () => {
    applySelfHostedEnv();
    await expectSafeRejection(getEmailSystemStatusForRuntime());
    resetMailDataSource();
    await expectSafeRejection(getAgentContextForRuntime());
  });

  test("the public self-hosted SDK rejects malformed successful JSON without leaking it", async () => {
    const client = new EmailsSelfHostClient({
      baseUrl,
      apiKey: "loopback-test-key",
    });
    await expectSafeRejection(client.listResourceProviders());
  });

  test("TUI and identity safe wrappers do not disguise invalid 2xx contracts as empty state", () => {
    applySelfHostedEnv();
    expect(() => activeProviderId()).toThrow(SelfHostedWireResponseError);
    expect(() => fetchIdentitySafe()).toThrow(SelfHostedWireResponseError);
  });

  test("TUI send surfaces a legitimate in-progress receipt distinctly", async () => {
    applySelfHostedEnv();
    const result = await sendComposed({
      from: "sender@example.test",
      to: "recipient@example.test",
      subject: "in-progress",
      body: "body",
    });
    expect(result).toMatchObject({
      id: "message-in-progress",
      inProgress: true,
    });
  });

  test("every generic resource operation validates list rows, records, and delete receipts", () => {
    const generic = SELF_HOSTED_RESPONSE_CONTRACTS.filter((contract) =>
      contract.status >= 200
      && contract.status < 300
      && /^(list|create|get|update|delete)Resource/.test(contract.operationId));
    expect(generic.length).toBeGreaterThan(0);
    for (const contract of generic) {
      const path = contract.path.replace(/\{[^}]+\}/g, "row-id");
      const invalid = contract.operationId.startsWith("listResource")
        ? { items: [{}] }
        : contract.operationId.startsWith("deleteResource")
          ? { deleted: false, id: "row-id" }
          : {};
      expect(
        () => validateSelfHostedSdkSuccessResponse(contract.method, path, contract.status, invalid),
        `${contract.operationId} accepted an incomplete successful response`,
      ).toThrow(/invalid successful response/i);
    }
  });

  test("mailbox mutation and send receipts fail closed while a real in-progress send remains valid", () => {
    const message = {
      id: "message-1",
      direction: "outbound",
      from_addr: "sender@example.test",
      to_addrs: ["recipient@example.test"],
      cc_addrs: [],
      subject: "subject",
      body_text: "body",
      body_html: null,
      status: "sending",
      provider_message_id: null,
      message_id: null,
      in_reply_to: null,
      received_at: null,
      is_read: true,
      is_starred: false,
      labels: [],
      headers: {},
      attachments: [],
      source_id: null,
      send_state: "sending",
      send_started_at: "2026-07-26T10:00:00.000Z",
      created_at: "2026-07-26T10:00:00.000Z",
      updated_at: "2026-07-26T10:00:00.000Z",
    };
    expect(() => validateSelfHostedSdkSuccessResponse(
      "PATCH",
      "/v1/messages/message-1",
      200,
      { message: { id: "message-1" } },
    )).toThrow(/invalid successful response/i);
    expect(() => validateSelfHostedSdkSuccessResponse(
      "DELETE",
      "/v1/messages/message-1",
      200,
      { deleted: false, id: "message-1" },
    )).toThrow(/invalid successful response/i);
    expect(() => validateSelfHostedSdkSuccessResponse(
      "POST",
      "/v1/messages/send",
      200,
      {
        message: { ...message, send_state: "sent", status: "sent" },
        provider: "sandbox",
        idempotent_replay: true,
        sent: true,
      },
    )).toThrow(/provider_message_id is required/i);
    expect(() => validateSelfHostedSdkSuccessResponse(
      "POST",
      "/v1/messages/send",
      202,
      { message, provider: "sandbox" },
    )).toThrow(/invalid successful response/i);
    expect(() => validateSelfHostedSdkSuccessResponse(
      "POST",
      "/v1/messages/send",
      202,
      { message, provider: "sandbox", in_progress: true },
    )).not.toThrow();
    expect(() => validateSelfHostedSdkSuccessResponse(
      "POST",
      "/v1/messages/send",
      202,
      {
        message,
        provider: "sandbox",
        in_progress: true,
        sent: true,
        provider_message_id: "provider-message-1",
      },
    )).toThrow(/exactly one allowed response shape/i);
  });

  test("send-intent list, reconcile, and cancel enforce their discriminated response contracts", () => {
    for (const [method, path, body] of [
      ["GET", "/v1/messages/send-intents/uncertain", { uncertain: [] }],
      ["POST", "/v1/messages/send-intents/reconcile", { reconciled: true, message: {} }],
      ["POST", "/v1/messages/send-intents/cancel", { cancellation: {} }],
    ] as const) {
      expect(() => validateSelfHostedSdkSuccessResponse(method, path, 200, body)).toThrow(
        /invalid successful response/i,
      );
    }
  });

  test("auth, identity, bootstrap, key, login, and switch responses validate nested required fields", () => {
    const cases: Array<[string, string, number, unknown]> = [
      ["POST", "/v1/auth/signup", 200, {}],
      ["POST", "/v1/auth/login", 200, { needs_tenant: true, tenants: [{}] }],
      ["POST", "/v1/auth/login", 200, { session_token: "session-only" }],
      ["POST", "/v1/auth/verify-email", 200, { verified: true }],
      ["POST", "/v1/auth/verify-email/resend", 200, {}],
      ["POST", "/v1/auth/bootstrap-owner", 201, { user: {} }],
      ["POST", "/v1/auth/bootstrap-super-admin", 200, { created: false }],
      ["GET", "/v1/me", 200, { principal_type: "user", scopes: [] }],
      ["GET", "/v1/keys", 200, { keys: [{}] }],
      ["POST", "/v1/keys", 201, { kid: "kid-only" }],
      ["DELETE", "/v1/keys/kid-1", 200, { revoked: false, kid: "kid-1" }],
      ["POST", "/v1/auth/switch-tenant", 200, { session_token: "session-only" }],
    ];
    for (const [method, path, status, body] of cases) {
      expect(
        () => validateSelfHostedSdkSuccessResponse(method, path, status, body),
        `${method} ${path} accepted an incomplete response`,
      ).toThrow(/invalid successful response/i);
    }
    expect(() => validateSelfHostedSdkSuccessResponse(
      "GET",
      "/v1/me",
      200,
      {
        principal_type: "apikey",
        kid: "kid-1",
        tenant: {
          id: "12345678-1234-4234-8234-123456789abc",
          slug: "default",
          name: "Default",
          status: "active",
        },
        scopes: ["emails:read"],
      },
    )).not.toThrow();
  });

  test("public auth 403s retain only schema-approved human text after validation", () => {
    expect(projectSelfHostedMailErrorBody(
      "POST",
      "/v1/auth/signup",
      403,
      {
        error: "signups are restricted",
        reason: "email_not_allowed",
        detail: RESPONSE_SECRET_MARKER,
      },
    )).toEqual({
      error: "signups are restricted",
      reason: "email_not_allowed",
    });

    expect(projectSelfHostedMailErrorBody(
      "POST",
      "/v1/auth/login",
      403,
      {
        error: "email is not verified",
        reason: "email_unverified",
        detail: RESPONSE_SECRET_MARKER,
      },
    )).toEqual({
      error: "email is not verified",
      reason: "email_unverified",
    });

    expect(() => projectSelfHostedMailErrorBody(
      "POST",
      "/v1/auth/login",
      403,
      {
        error: "email is not verified",
        reason: "not_a_member",
      },
    )).toThrow(/invalid error response/i);

    expect(projectSelfHostedMailErrorBody(
      "POST",
      "/v1/auth/login",
      401,
      {
        error: "invalid email or password",
        reason: "invalid_credentials",
      },
    )).toEqual({ reason: "invalid_credentials" });
  });

  test("verify-email accepts its real additive user envelope and still requires core fields", () => {
    const verifiedUser = {
      verified: true,
      user: {
        id: "user-carol@example.com",
        email: "carol@example.com",
        name: null,
        status: "active",
        email_verified: true,
        created_at: "2026-07-26T10:00:00.000Z",
      },
    };
    expect(() => validateSelfHostedSdkSuccessResponse(
      "POST",
      "/v1/auth/verify-email",
      200,
      verifiedUser,
    )).not.toThrow();
    expect(() => validateSelfHostedSdkSuccessResponse(
      "GET",
      "/v1/auth/verify-email?token=redacted",
      200,
      {
        ...verifiedUser,
        user: {
          ...verifiedUser.user,
          global_role: "super_admin",
          is_primary_super_admin: true,
        },
      },
    )).not.toThrow();

    const missingCreatedAt = structuredClone(verifiedUser);
    delete (missingCreatedAt.user as Partial<typeof verifiedUser.user>).created_at;
    expect(() => validateSelfHostedSdkSuccessResponse(
      "POST",
      "/v1/auth/verify-email",
      200,
      missingCreatedAt,
    )).toThrow(/body\.user\.created_at is required/i);

    expect(projectSelfHostedMailErrorBody(
      "POST",
      "/v1/auth/verify-email",
      400,
      {
        error: "verification link is invalid or expired",
        reason: "invalid_token",
      },
    )).toEqual({ reason: "invalid_token" });
    expect(() => projectSelfHostedMailErrorBody(
      "POST",
      "/v1/auth/verify-email",
      400,
      {
        error: "verification link is invalid or expired",
        reason: "different_reason",
      },
    )).toThrow(/invalid error response/i);
  });

  test("login accepts the same additive auth user with opaque route identifiers", () => {
    expect(() => validateSelfHostedSdkSuccessResponse(
      "POST",
      "/v1/auth/login",
      200,
      {
        session_token: "emss_session",
        expires_at: "2026-08-26T10:00:00.000Z",
        user: {
          id: "user-carol@example.com",
          email: "carol@example.com",
          name: null,
          status: "active",
          email_verified: true,
          created_at: "2026-07-26T10:00:00.000Z",
        },
        tenant: {
          id: "tenant-carolco",
          slug: "carolco",
          name: "Carol Co",
          status: "active",
        },
        role: "owner",
      },
    )).not.toThrow();
  });

  test("current principal accepts the route's additive auth identity envelope", () => {
    expect(() => validateSelfHostedSdkSuccessResponse(
      "GET",
      "/v1/me",
      200,
      {
        principal_type: "user",
        user: {
          id: "user-carol@example.com",
          email: "carol@example.com",
          name: null,
          status: "active",
          email_verified: true,
          created_at: "2026-07-26T10:00:00.000Z",
        },
        tenant: {
          id: "tenant-carolco",
          slug: "carolco",
          name: "Carol Co",
          status: "active",
        },
        role: "owner",
        scopes: ["emails:read", "emails:write"],
        memberships: [{
          tenant_id: "tenant-carolco",
          slug: "carolco",
          name: "Carol Co",
          role: "owner",
        }],
        email_identities: [],
      },
    )).not.toThrow();
  });

  test("switch-tenant accepts its opaque auth-route tenant identifier", () => {
    expect(() => validateSelfHostedSdkSuccessResponse(
      "POST",
      "/v1/auth/switch-tenant",
      200,
      {
        session_token: "emss_session",
        expires_at: "2026-08-26T10:00:00.000Z",
        tenant: {
          id: "tenant-work",
          slug: "work",
          name: "Work",
          status: "active",
        },
        role: "admin",
      },
    )).not.toThrow();
    expect(projectSelfHostedMailErrorBody(
      "POST",
      "/v1/auth/switch-tenant",
      404,
      {
        error: "organization not found",
        reason: "not_found",
      },
    )).toEqual({ reason: "not_found" });
  });

  test("bootstrap-owner accepts its additive auth envelope and exact conflict", () => {
    expect(() => validateSelfHostedSdkSuccessResponse(
      "POST",
      "/v1/auth/bootstrap-owner",
      201,
      {
        user: {
          id: "user-operator@example.com",
          email: "operator@example.com",
          name: null,
          status: "active",
          email_verified: true,
          created_at: "2026-07-26T10:00:00.000Z",
        },
        tenant: {
          id: "tenant-default",
          slug: "default",
          name: "Default Tenant",
          status: "active",
        },
      },
    )).not.toThrow();
    expect(projectSelfHostedMailErrorBody(
      "POST",
      "/v1/auth/bootstrap-owner",
      409,
      {
        error: "this tenant already has an owner",
        reason: "owner_exists",
      },
    )).toEqual({ reason: "owner_exists" });
  });

  test("tenant key listing accepts production metadata or the additive legacy route shape", () => {
    expect(() => validateSelfHostedSdkSuccessResponse(
      "GET",
      "/v1/keys",
      200,
      {
        keys: [{
          kid: "kid_fixture",
          scopes: ["emails:*"],
          created_at: "2026-07-26T10:00:00.000Z",
          expires_at: null,
          revoked_at: null,
        }],
      },
    )).not.toThrow();
    expect(() => validateSelfHostedSdkSuccessResponse(
      "GET",
      "/v1/keys",
      200,
      {
        keys: [{
          kid: "kid_fixture",
          scopes: ["emails:*"],
          expires_at: null,
          revoked_at: null,
        }],
      },
    )).toThrow(/invalid successful response/i);
  });

  test("tenant, membership, invite, and logout receipts validate their required fields", () => {
    const cases: Array<[string, string, number, unknown]> = [
      ["GET", "/v1/tenants", 200, { tenants: [{}] }],
      ["POST", "/v1/tenants", 201, { tenant: {} }],
      ["PATCH", "/v1/tenants/tenant-1", 200, {}],
      ["DELETE", "/v1/tenants/tenant-1", 200, { suspended: false }],
      ["GET", "/v1/tenants/tenant-1/members", 200, { members: [{}] }],
      ["GET", "/v1/tenants/tenant-1/invites", 200, { invites: [{}] }],
      ["POST", "/v1/tenants/tenant-1/invites", 201, { invited: true }],
      ["PATCH", "/v1/memberships/member-1", 200, { membership: {} }],
      ["DELETE", "/v1/memberships/member-1", 200, { removed: false }],
      ["POST", "/v1/invites/accept", 200, { session_token: "session-only" }],
      ["POST", "/v1/auth/logout", 200, { logged_out: false }],
      ["POST", "/v1/auth/logout-all", 200, {}],
    ];
    for (const [method, path, status, body] of cases) {
      expect(
        () => validateSelfHostedSdkSuccessResponse(method, path, status, body),
        `${method} ${path} accepted an incomplete response`,
      ).toThrow(/invalid successful response/i);
    }
  });

  test("attachment content, raw, batch, and repair responses enforce endpoint-specific invariants", () => {
    const cases: Array<[string, string, number, unknown]> = [
      ["GET", "/v1/messages/message-1/attachments/0", 200, { attachment: { content_base64: "eA==" } }],
      ["GET", "/v1/messages/message-1/raw", 200, {}],
      ["GET", "/v1/attachments", 200, { items: [] }],
      ["POST", "/v1/attachments/batch", 200, { by_message_id: {} }],
      ["POST", "/v1/attachments/repairs", 201, { repair: {} }],
      ["GET", "/v1/attachments/repairs/00000000-0000-4000-8000-000000000001", 200, { repair: {} }],
      ["POST", "/v1/attachments/repairs/00000000-0000-4000-8000-000000000001/resume", 200, { repair: {} }],
    ];
    for (const [method, path, status, body] of cases) {
      expect(
        () => validateSelfHostedSdkSuccessResponse(method, path, status, body),
        `${method} ${path} accepted an incomplete response`,
      ).toThrow(/invalid successful response/i);
    }
  });

  test("message detail accepts null attachment slots but keeps non-null metadata strict", () => {
    const response = responseSample("GET", "/v1/messages/message-1", 200);
    const message = response["message"] as Record<string, unknown>;
    const attachment = {
      filename: "invoice.pdf",
      content_type: "application/pdf",
      size: 10,
      sha256: null,
      content_available: false,
    };

    message["attachments"] = [attachment, null];
    expect(() => validateSelfHostedSdkSuccessResponse(
      "GET",
      "/v1/messages/message-1",
      200,
      response,
    )).not.toThrow();

    message["attachments"] = [{ ...attachment, content_available: "yes" }];
    expect(() => validateSelfHostedSdkSuccessResponse(
      "GET",
      "/v1/messages/message-1",
      200,
      response,
    )).toThrow(/invalid successful response/i);
  });

  test("typed attachment-unavailable errors validate before a metadata-only projection", () => {
    expect(() => projectSelfHostedMailErrorBody(
      "GET",
      "/v1/messages/message-1/attachments/0",
      409,
      {
        code: "attachment_content_unavailable",
        attachment: { content_type: "application/pdf", size: 10 },
      },
    )).toThrow(/invalid error response/i);

    expect(projectSelfHostedMailErrorBody(
      "GET",
      "/v1/messages/message-1/attachments/0",
      409,
      {
        error: RESPONSE_SECRET_MARKER,
        code: "attachment_content_unavailable",
        attachment: {
          filename: "invoice.pdf",
          content_type: "application/pdf",
          size: 10,
        },
      },
    )).toEqual({
      code: "attachment_content_unavailable",
      attachment: {
        filename: "invoice.pdf",
        content_type: "application/pdf",
        size: 10,
      },
    });
  });

  test("all raw errors validate before projection and invalid contracts throw the typed wire error", () => {
    const valid = responseSample("POST", "/v1/messages/send", 502);
    expect(() => projectSelfHostedMailErrorBody(
      "POST",
      "/v1/messages/send",
      502,
      {
        ...valid,
        retry_safe: true,
      },
    )).toThrow(SelfHostedWireResponseError);

    const missingReconciliation = { ...valid };
    delete missingReconciliation.reconciliation_required;
    expect(() => projectSelfHostedMailErrorBody(
      "POST",
      "/v1/messages/send",
      502,
      missingReconciliation,
    )).toThrow(/reconciliation_required is required/i);

    expect(projectSelfHostedMailErrorBody(
      "POST",
      "/v1/messages/send",
      502,
      valid,
    )).toEqual(expect.objectContaining({
      reason: "provider_outcome_uncertain",
      sent: null,
      retry_safe: false,
      reconciliation_required: true,
    }));
  });

  test("canonical and native-client identity paths use exactly the same response contracts", () => {
    for (const [method, canonical, alias] of [
      ["GET", "/v1/me", "/api/v1/auth/me"],
      ["GET", "/v1/keys", "/api/v1/api-keys"],
      ["DELETE", "/v1/keys/key-1", "/api/v1/api-keys/key-1"],
      ["POST", "/v1/keys/key-1/revoke", "/api/v1/api-keys/key-1/revoke"],
    ] as const) {
      const valid = responseSample(method, canonical, 200);
      expect(() => validateSelfHostedSdkSuccessResponse(method, canonical, 200, valid)).not.toThrow();
      expect(() => validateSelfHostedSdkSuccessResponse(method, alias, 200, valid)).not.toThrow();
      expect(() => validateSelfHostedSdkSuccessResponse(method, alias, 200, {})).toThrow(
        /invalid successful response/i,
      );
    }
  });

  test("response formats fail closed across identity, tenant, membership, invite, key, and repair schemas", () => {
    const cases: Array<{
      method: string;
      path: string;
      status: number;
      mutate(value: Record<string, unknown>): void;
    }> = [
      {
        method: "GET",
        path: "/v1/me",
        status: 200,
        mutate: (value) => {
          (value.user as Record<string, unknown>).email = "not-an-email";
        },
      },
      {
        method: "GET",
        path: "/v1/tenants",
        status: 200,
        mutate: (value) => {
          ((value.tenants as Record<string, unknown>[])[0]!).id = "not-a-uuid";
        },
      },
      {
        method: "GET",
        path: "/v1/tenants/12345678-1234-4234-8234-123456789abc/members",
        status: 200,
        mutate: (value) => {
          ((value.members as Record<string, unknown>[])[0]!).created_at = "2026-99-99";
        },
      },
      {
        method: "GET",
        path: "/v1/tenants/12345678-1234-4234-8234-123456789abc/invites",
        status: 200,
        mutate: (value) => {
          ((value.invites as Record<string, unknown>[])[0]!).expires_at = "tomorrow";
        },
      },
      {
        method: "GET",
        path: "/v1/keys",
        status: 200,
        mutate: (value) => {
          ((value.keys as Record<string, unknown>[])[0]!).created_by_user_id = "broken";
        },
      },
      {
        method: "GET",
        path: "/v1/attachments/repairs/12345678-1234-4234-8234-123456789abc",
        status: 200,
        mutate: (value) => {
          (value.repair as Record<string, unknown>).deadline_at = "not-a-date";
        },
      },
    ];
    for (const item of cases) {
      const invalid = structuredClone(responseSample(item.method, item.path, item.status));
      item.mutate(invalid);
      expect(
        () => validateSelfHostedSdkSuccessResponse(
          item.method,
          item.path,
          item.status,
          invalid,
        ),
        `${item.method} ${item.path} accepted an invalid formatted field`,
      ).toThrow(/invalid successful response/i);
    }
  });

  test("the runtime explicitly supports every generated response format and no others", () => {
    const formats = new Set<string>();
    const inspect = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) inspect(item);
        return;
      }
      if (!isRecord(value)) return;
      if (typeof value.format === "string") formats.add(value.format);
      for (const nested of Object.values(value)) inspect(nested);
    };
    inspect(SELF_HOSTED_RESPONSE_CONTRACTS);
    inspect(SELF_HOSTED_RESPONSE_COMPONENTS);
    expect([...formats].sort()).toEqual([...SUPPORTED_SELF_HOSTED_RESPONSE_FORMATS].sort());
  });

  test("registry identity keys reject null and every served resource publishes PUT", () => {
    for (const [path, key] of [
      ["/v1/email-agents", "agent_key"],
      ["/v1/address-ownership-events", "id"],
    ] as const) {
      const body = responseSample("POST", path, 201);
      body[key] = null;
      expect(() => validateSelfHostedSdkSuccessResponse("POST", path, 201, body))
        .toThrow(new RegExp(`body\\.${key} must be a string`, "i"));
    }

    const genericPuts = SELF_HOSTED_RESPONSE_CONTRACTS.filter((contract) =>
      contract.method === "PUT"
      && contract.status === 200
      && contract.operationId.startsWith("replaceResource"));
    expect(genericPuts).toHaveLength(
      SELF_HOSTED_RESPONSE_CONTRACTS.filter((contract) =>
        contract.method === "PATCH"
        && contract.status === 200
        && contract.operationId.startsWith("updateResource")).length,
    );
  });

  test("send-key verification requires the authorized decision", () => {
    expect(() => validateSelfHostedSdkSuccessResponse(
      "POST",
      "/v1/send-keys/verify",
      200,
      { valid: true, key: {} },
    )).toThrow(/body\.authorized is required/i);
  });

  test("an undeclared empty 204 is rejected instead of being globally accepted", () => {
    expect(() => parseSelfHostedSuccessJson("", {
      method: "POST",
      path: "/v1/auth/logout",
      status: 204,
    })).toThrow(/HTTP 204 is not declared/i);
  });

  test("both fetch clients enforce response-size limits before contract projection", async () => {
    const oversized = JSON.stringify({ messages: [], padding: "x".repeat(2048) });
    const sdk = new EmailsSelfHostClient({
      baseUrl,
      apiKey: "loopback-test-key",
      maxResponseBytes: 128,
      fetch: (async () => new Response(oversized, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
    });
    await expect(sdk.getHealth()).rejects.toBeInstanceOf(SelfHostedResponseSizeError);

    const mailbox = new SelfHostedMailDataSource({
      baseUrl: `${baseUrl}/v1`,
      apiKey: "loopback-test-key",
      maxResponseBytes: 128,
      fetchImpl: async () => new Response(oversized, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
    await expect(mailbox.listMailbox("inbox")).rejects.toBeInstanceOf(SelfHostedResponseSizeError);
  });

  test("the public SDK has a default timeout and honors a bounded override", async () => {
    const sdk = new EmailsSelfHostClient({
      baseUrl,
      apiKey: "loopback-test-key",
      timeoutMs: 15,
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })) as typeof fetch,
    });
    await expect(sdk.getHealth()).rejects.toThrow(/timed out after 15ms/i);
  });

  test("curl, fetch, and SDK errors never retain or print response bodies", async () => {
    applySelfHostedEnv();
    expect(() => selfHostedStoreFor("groups").list()).toThrow(SelfHostedHttpError);
    try {
      selfHostedStoreFor("groups").list();
    } catch (error) {
      expect(String(error)).not.toContain(RESPONSE_SECRET_MARKER);
      expect(error).not.toHaveProperty("bodyText");
    }

    const mailbox = new SelfHostedMailDataSource({
      baseUrl: `${baseUrl}/v1`,
      apiKey: "loopback-test-key",
    });
    let mailboxError: unknown;
    try {
      await mailbox.send({
        from: "sender@example.test",
        to: "recipient@example.test",
        subject: "subject",
        body: "body",
      });
    } catch (error) {
      mailboxError = error;
    }
    expect(mailboxError).toBeInstanceOf(Error);
    expect(String(mailboxError)).not.toContain(RESPONSE_SECRET_MARKER);

    const sdk = new EmailsSelfHostClient({
      baseUrl,
      apiKey: "loopback-test-key",
      fetch: (async () => new Response(JSON.stringify({
        error: RESPONSE_SECRET_MARKER,
        reason: "provider_rejected",
        retry_safe: true,
        message: {
          id: "12345678-1234-4234-8234-123456789abc",
          send_state: "failed",
        },
      }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
    });
    try {
      await sdk.sendMessage({
        from: "sender@example.test",
        to: ["recipient@example.test"],
        subject: "subject",
        idempotency_key: "key",
      });
      throw new Error("expected ApiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(String(error)).not.toContain(RESPONSE_SECRET_MARKER);
      expect(JSON.stringify((error as ApiError).body)).not.toContain(RESPONSE_SECRET_MARKER);
      expect((error as ApiError).body).toEqual({
        reason: "provider_rejected",
        retry_safe: true,
        message: {
          id: "12345678-1234-4234-8234-123456789abc",
          send_state: "failed",
        },
      });
    }
  });

  test("the synchronous curl bridge enforces a response-size bound", () => {
    applySelfHostedEnv();
    process.env["EMAILS_SELF_HOSTED_HTTP_MAX_RESPONSE_BYTES"] = "128";
    expect(() => selfHostedStoreFor("templates").list()).toThrow(SelfHostedResponseSizeError);
  });
});
