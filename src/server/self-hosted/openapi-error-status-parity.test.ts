import { describe, expect, it } from "bun:test";
import { emailsSelfHostedOpenApi } from "./openapi.js";
import { SELF_HOSTED_RESOURCES } from "./resources.js";

type Operation = {
  operationId?: string;
  requestBody?: unknown;
  responses?: Record<string, {
    content?: Record<string, {
      schema?: {
        additionalProperties?: boolean;
        anyOf?: Array<{
          additionalProperties?: boolean;
          properties?: Record<string, { enum?: unknown[] }>;
          required?: string[];
        }>;
        properties?: Record<string, { enum?: unknown[] }>;
        required?: string[];
      };
    }>;
  }>;
};

const paths = emailsSelfHostedOpenApi.paths as Record<string, Record<string, Operation>>;

function statuses(path: string, method: string): number[] {
  const operation = paths[path]?.[method.toLowerCase()];
  expect(operation, `${method.toUpperCase()} ${path}`).toBeDefined();
  return Object.keys(operation?.responses ?? {})
    .map(Number)
    .sort((left, right) => left - right);
}

function expectStatuses(path: string, method: string, expected: number[]): void {
  expect(statuses(path, method), `${method.toUpperCase()} ${path}`)
    .toEqual([...expected].sort((left, right) => left - right));
}

const AUTH_STATUS_MATRIX: ReadonlyArray<readonly [string, string, readonly number[]]> = [
  ["/v1/auth/providers", "get", [200]],
  ["/v1/auth/signup", "post", [200, 400, 403, 409, 413, 429, 500]],
  ["/v1/auth/login", "post", [200, 400, 401, 403, 413, 429, 500]],
  ["/v1/auth/verify-email", "get", [200, 400, 500]],
  ["/v1/auth/verify-email", "post", [200, 400, 413, 500]],
  ["/v1/auth/verify-email/resend", "post", [200, 400, 413, 429, 500]],
  ["/v1/auth/password/forgot", "post", [200, 400, 413, 429, 500]],
  ["/v1/auth/password/reset", "post", [200, 400, 413, 429, 500]],
  ["/v1/invites/accept", "post", [200, 400, 409, 413, 500]],
  ["/v1/auth/bootstrap-owner", "post", [201, 400, 401, 403, 409, 413, 500]],
  ["/v1/auth/bootstrap-super-admin", "post", [200, 201, 400, 401, 403, 409, 413, 500, 503]],
  ["/v1/auth/logout", "post", [200, 400, 401, 403, 500]],
  ["/v1/auth/logout-all", "post", [200, 400, 401, 403, 500]],
  ["/v1/auth/switch-tenant", "post", [200, 400, 401, 403, 404, 413, 500]],
  ["/v1/me", "get", [200, 401, 403, 500]],
  ["/v1/me/email-identities", "get", [200, 401, 403, 500]],
  ["/v1/me/email-identities", "post", [201, 400, 401, 403, 409, 413, 500]],
  ["/v1/me/email-identities/{id}", "delete", [200, 401, 403, 409, 500]],
  ["/v1/me/email-identities/{id}/primary", "post", [200, 401, 403, 409, 500]],
  ["/v1/tenants", "get", [200, 401, 403, 500]],
  ["/v1/tenants", "post", [201, 400, 401, 403, 409, 413, 500]],
  ["/v1/tenants/{id}", "get", [200, 401, 403, 404, 500]],
  ["/v1/tenants/{id}", "patch", [200, 400, 401, 403, 404, 409, 413, 500]],
  ["/v1/tenants/{id}", "put", [200, 400, 401, 403, 404, 409, 413, 500]],
  ["/v1/tenants/{id}", "delete", [200, 401, 403, 404, 500]],
  ["/v1/tenants/{id}/members", "get", [200, 401, 403, 500]],
  ["/v1/tenants/{id}/invites", "get", [200, 401, 403, 500]],
  ["/v1/tenants/{id}/invites", "post", [201, 400, 401, 403, 413, 429, 500]],
  ["/v1/memberships/{id}", "patch", [200, 400, 401, 403, 404, 409, 413, 500]],
  ["/v1/memberships/{id}", "put", [200, 400, 401, 403, 404, 409, 413, 500]],
  ["/v1/memberships/{id}", "delete", [200, 401, 403, 404, 409, 500]],
  ["/v1/keys", "get", [200, 401, 403, 500]],
  ["/v1/keys", "post", [201, 400, 401, 403, 413, 500]],
  ["/v1/keys/{id}", "delete", [200, 401, 403, 404, 500]],
  ["/v1/keys/{id}/revoke", "post", [200, 401, 403, 404, 500]],
] as const;

const SERVICE_STATUS_MATRIX: ReadonlyArray<readonly [string, string, readonly number[]]> = [
  ["/v1/domains", "get", [200, 401, 403, 500]],
  ["/v1/domains", "post", [201, 400, 401, 403, 409, 413, 500]],
  ["/v1/domains/{id}", "get", [200, 401, 403, 404, 500]],
  ["/v1/domains/{id}", "patch", [200, 400, 401, 403, 404, 409, 413, 500]],
  ["/v1/domains/{id}", "put", [200, 400, 401, 403, 404, 409, 413, 500]],
  ["/v1/domains/{id}", "delete", [200, 401, 403, 404, 500]],
  ["/v1/addresses", "get", [200, 401, 403, 500]],
  ["/v1/addresses", "post", [201, 400, 401, 403, 413, 500]],
  ["/v1/addresses/{id}", "get", [200, 401, 403, 404, 500]],
  ["/v1/addresses/{id}", "patch", [200, 400, 401, 403, 404, 413, 500]],
  ["/v1/addresses/{id}", "put", [200, 400, 401, 403, 404, 413, 500]],
  ["/v1/addresses/{id}", "delete", [200, 401, 403, 404, 500]],
  ["/v1/messages", "get", [200, 400, 401, 403, 500]],
  ["/v1/messages", "post", [200, 201, 400, 401, 403, 409, 413, 500]],
  ["/v1/messages/counts", "get", [200, 401, 403, 500]],
  ["/v1/messages/groups", "get", [200, 401, 403, 500]],
  ["/v1/messages/threads", "get", [200, 401, 403, 500]],
  ["/v1/messages/send", "post", [200, 202, 400, 401, 403, 409, 413, 422, 429, 500, 502, 503]],
  ["/v1/messages/send-intents/lookup", "post", [200, 400, 401, 403, 413, 500]],
  ["/v1/messages/send-intents/uncertain", "get", [200, 401, 403, 500]],
  ["/v1/messages/send-intents/reconcile", "post", [200, 400, 401, 403, 404, 409, 413, 500]],
  ["/v1/messages/send-intents/cancel", "post", [200, 400, 401, 403, 413, 500]],
  ["/v1/messages/{id}", "get", [200, 401, 403, 404, 409, 500]],
  ["/v1/messages/{id}", "patch", [200, 400, 401, 403, 404, 409, 413, 500]],
  ["/v1/messages/{id}", "put", [200, 400, 401, 403, 404, 409, 413, 500]],
  ["/v1/messages/{id}", "delete", [200, 401, 403, 404, 409, 500]],
  ["/v1/messages/{id}/attachments/{index}", "get", [200, 400, 401, 403, 404, 409, 413, 422, 500]],
  ["/v1/attachments", "get", [200, 400, 401, 403, 500]],
  ["/v1/attachments/batch", "post", [200, 400, 401, 403, 413, 500]],
  ["/v1/attachments/repairs", "post", [201, 400, 401, 403, 409, 413, 429, 500, 503]],
  ["/v1/attachments/repairs/{id}", "get", [200, 400, 401, 403, 404, 500]],
  ["/v1/attachments/repairs/{id}/resume", "post", [200, 400, 401, 403, 404, 413, 500, 503]],
  ["/v1/messages/{id}/raw", "get", [200, 401, 403, 404, 409, 500]],
  ["/v1/mailboxes", "get", [200, 401, 403, 500]],
  ["/v1/send-keys/mint", "post", [201, 400, 401, 403, 404, 413, 500]],
  ["/v1/send-keys/verify", "post", [200, 400, 401, 403, 413, 500]],
] as const;

describe("self-hosted OpenAPI routine error-status parity", () => {
  it("declares the exact auth-handler status matrix", () => {
    for (const [path, method, expected] of AUTH_STATUS_MATRIX) {
      expectStatuses(path, method, [...expected]);
    }
  });

  it("declares the exact bespoke service status matrix", () => {
    for (const [path, method, expected] of SERVICE_STATUS_MATRIX) {
      expectStatuses(path, method, [...expected]);
    }
  });

  it("declares generic CRUD item absence and inherited handler failures", () => {
    for (const resource of SELF_HOSTED_RESOURCES) {
      const collection = `/v1/${resource.path}`;
      const item = `${collection}/{id}`;
      expectStatuses(collection, "get", [200, 401, 403, 500]);
      expectStatuses(collection, "post", [
        201,
        400,
        401,
        403,
        ...(resource.foreignKeys?.length ? [404] : []),
        413,
        500,
      ]);
      expectStatuses(item, "get", [200, 401, 403, 404, 500]);
      expectStatuses(item, "patch", [200, 400, 401, 403, 404, 413, 500]);
      expectStatuses(item, "put", [200, 400, 401, 403, 404, 413, 500]);
      expectStatuses(item, "delete", [200, 401, 403, 404, 500]);
    }
  });

  it("keeps shared transport and catch-path envelopes closed and machine-safe", () => {
    for (const [path, method] of [
      ["/v1/contacts", "get"],
      ["/v1/messages", "get"],
    ] as const) {
      for (const status of ["401", "403", "500"]) {
        const schema = paths[path]?.[method]?.responses?.[status]
          ?.content?.["application/json"]?.schema;
        expect(schema, `${method.toUpperCase()} ${path} ${status}`).toBeDefined();
        if (schema?.anyOf) {
          expect(schema.anyOf.every((branch) => branch.additionalProperties === false)).toBe(true);
        } else if ("oneOf" in (schema ?? {}) && Array.isArray((schema as { oneOf?: unknown[] }).oneOf)) {
          const branches = (schema as {
            oneOf: Array<{ additionalProperties?: boolean }>;
          }).oneOf;
          expect(branches.every((branch) => branch.additionalProperties === false)).toBe(true);
        } else {
          expect(schema?.additionalProperties).toBe(false);
        }
      }
    }
    expect(paths["/v1/auth/login"]?.post?.responses?.["500"]
      ?.content?.["application/json"]?.schema?.additionalProperties).toBe(false);

    const genericNotFound = paths["/v1/contacts/{id}"]?.get?.responses?.["404"]
      ?.content?.["application/json"]?.schema;
    expect(genericNotFound).toMatchObject({
      additionalProperties: false,
      required: ["error"],
      properties: {
        error: { enum: ["contacts not found"] },
      },
    });

    const foreignKeyUpdateNotFound = paths["/v1/send-keys/{id}"]?.patch
      ?.responses?.["404"]?.content?.["application/json"]?.schema;
    expect(foreignKeyUpdateNotFound?.anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        additionalProperties: false,
        required: ["error"],
        properties: expect.objectContaining({
          error: expect.objectContaining({ enum: ["send-keys not found"] }),
        }),
      }),
      expect.objectContaining({
        additionalProperties: false,
        required: ["error", "reason"],
        properties: expect.objectContaining({
          reason: expect.objectContaining({ enum: ["cross_tenant_reference"] }),
        }),
      }),
    ]));

    const loginRateLimit = paths["/v1/auth/login"]?.post?.responses?.["429"]
      ?.content?.["application/json"]?.schema;
    expect(loginRateLimit?.anyOf).toHaveLength(2);
    expect(loginRateLimit?.anyOf?.some((branch) =>
      branch.additionalProperties === false
      && JSON.stringify(branch.required) === JSON.stringify(["error", "reason", "retry_after"])
      && branch.properties?.reason?.enum?.[0] === "rate_limited")).toBe(true);
    expect(loginRateLimit?.anyOf?.some((branch) =>
      branch.additionalProperties === false
      && JSON.stringify(branch.required) === JSON.stringify(["error", "reason"])
      && branch.properties?.reason?.enum?.[0] === "locked")).toBe(true);
  });
});
