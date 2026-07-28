import { describe, expect, it } from "bun:test";
import { emailsSelfHostedOpenApi } from "./openapi.js";
import { SELF_HOSTED_RESOURCES } from "./resources.js";

type Schema = {
  type?: string;
  $ref?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  oneOf?: Schema[];
  items?: Schema;
  additionalProperties?: boolean | Schema;
  enum?: unknown[];
  nullable?: boolean;
};

type Operation = {
  operationId?: string;
  requestBody?: unknown;
  responses?: Record<string, {
    content?: Record<string, { schema?: Schema }>;
  }>;
};

const paths = emailsSelfHostedOpenApi.paths as Record<string, Record<string, Operation>>;

function successSchema(
  path: string,
  method: "get" | "post" | "put" | "patch" | "delete",
  status: number,
): Schema {
  const schema = paths[path]?.[method]?.responses?.[String(status)]
    ?.content?.["application/json"]?.schema;
  expect(schema, `${method.toUpperCase()} ${path} ${status}`).toBeDefined();
  return schema!;
}

function expectRequired(
  path: string,
  method: "get" | "post" | "put" | "patch" | "delete",
  status: number,
  required: string[],
): void {
  expect(successSchema(path, method, status).required, `${method.toUpperCase()} ${path} ${status}`)
    .toEqual(required);
}

describe("self-hosted OpenAPI success-response schemas", () => {
  it("keeps successes additive except for explicit attachment and redacted-record boundaries", () => {
    const closedSuccesses: string[] = [];
    const inspect = (schema: Schema | undefined, location: string): void => {
      if (!schema) return;
      if (schema.additionalProperties === false) closedSuccesses.push(location);
      for (const [index, branch] of (schema.oneOf ?? []).entries()) {
        inspect(branch, `${location} oneOf[${index}]`);
      }
    };

    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          if (!/^2\d\d$/.test(status)) continue;
          inspect(
            response.content?.["application/json"]?.schema,
            `${method.toUpperCase()} ${path} ${status}`,
          );
        }
      }
    }

    expect(closedSuccesses.sort()).toEqual([
      "GET /v1/attachments/repairs/{id} 200",
      "GET /v1/messages/{id}/attachments/{index} 200",
      "POST /v1/attachments/repairs 201",
      "POST /v1/attachments/repairs/{id}/resume 200",
    ]);

    const componentSchemas = emailsSelfHostedOpenApi.components?.schemas as
      | Record<string, Schema>
      | undefined;
    const closedComponents = Object.entries(componentSchemas ?? {})
      .filter(([, schema]) => schema.additionalProperties === false)
      .map(([name]) => name)
      .sort();

    expect(closedComponents).toEqual([
      "AttachmentBatchMeta",
      "AttachmentContent",
      "AttachmentInventoryItem",
      "AttachmentRepairSummary",
      "AttachmentUnavailableError",
      "SendIntentMessage",
    ]);
  });

  it("never publishes a bare successful JSON object", () => {
    const bare: string[] = [];
    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          if (!/^2\d\d$/.test(status)) continue;
          const schema = response.content?.["application/json"]?.schema;
          if (
            schema?.type === "object"
            && !schema.$ref
            && !schema.oneOf
            && Object.keys(schema.properties ?? {}).length === 0
          ) {
            bare.push(`${method.toUpperCase()} ${path} ${status}`);
          }
        }
      }
    }
    expect(bare).toEqual([]);
  });

  it("publishes every successful auth and API-key route actually served", () => {
    expect(paths["/v1/auth/providers"]?.get?.operationId).toBe("listAuthProviders");
    expect(paths["/v1/keys/{id}/revoke"]?.post?.operationId).toBe("revokeTenantKeyByPost");

    expectRequired("/v1/auth/providers", "get", 200, ["google", "device"]);
    expectRequired("/v1/auth/signup", "post", 200, ["status", "email", "verification_required"]);
    expectRequired("/v1/auth/verify-email", "get", 200, ["verified", "user"]);
    expectRequired("/v1/auth/verify-email", "post", 200, ["verified", "user"]);
    expectRequired("/v1/auth/verify-email/resend", "post", 200, ["status", "verification_required"]);
    expectRequired("/v1/auth/password/forgot", "post", 200, ["status"]);
    expectRequired("/v1/auth/password/reset", "post", 200, ["reset"]);
    expectRequired("/v1/auth/logout", "post", 200, ["logged_out"]);
    expectRequired("/v1/auth/logout-all", "post", 200, ["logged_out"]);
    expectRequired("/v1/auth/bootstrap-owner", "post", 201, ["user", "tenant"]);
    expectRequired("/v1/auth/bootstrap-super-admin", "post", 200, ["created", "user", "tenant"]);
    expectRequired("/v1/auth/bootstrap-super-admin", "post", 201, ["created", "user", "tenant"]);
    expectRequired("/v1/auth/switch-tenant", "post", 200, ["session_token", "expires_at", "tenant", "role"]);
    expectRequired("/v1/invites/accept", "post", 200, ["session_token", "expires_at", "user", "tenant", "role"]);
    expectRequired("/v1/keys", "get", 200, ["keys"]);
    expectRequired("/v1/keys", "post", 201, ["token", "kid", "scopes", "expires_at"]);
    expectRequired("/v1/keys/{id}", "delete", 200, ["revoked", "kid"]);
    expectRequired("/v1/keys/{id}/revoke", "post", 200, ["revoked", "kid"]);
  });

  it("declares exact public-auth 403 contracts and a route-accurate verified user", () => {
    const globalUser = emailsSelfHostedOpenApi.components?.schemas?.User as
      | Schema
      | undefined;
    expect(globalUser?.required).toEqual(expect.arrayContaining([
      "global_role",
      "is_primary_super_admin",
    ]));

    const signupForbidden = successSchema("/v1/auth/signup", "post", 403);
    expect(signupForbidden.required).toEqual(["error", "reason"]);
    expect(signupForbidden.properties?.error?.enum).toEqual(["signups are restricted"]);
    expect(signupForbidden.properties?.reason?.enum).toEqual(["email_not_allowed"]);

    const loginForbidden = successSchema("/v1/auth/login", "post", 403);
    expect(loginForbidden.oneOf).toHaveLength(4);
    expect(loginForbidden.oneOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        required: ["error", "reason"],
        properties: expect.objectContaining({
          error: expect.objectContaining({ enum: ["email is not verified"] }),
          reason: expect.objectContaining({ enum: ["email_unverified"] }),
        }),
      }),
    ]));
    const loginUnauthorized = successSchema("/v1/auth/login", "post", 401);
    expect(loginUnauthorized.required).toEqual(["error", "reason"]);
    expect(loginUnauthorized.properties?.error?.enum).toEqual(["invalid email or password"]);
    expect(loginUnauthorized.properties?.reason?.enum).toEqual(["invalid_credentials"]);

    const login = successSchema("/v1/auth/login", "post", 200);
    const loginSuccess = login.oneOf?.find((branch) =>
      branch.required?.includes("session_token"));
    expect(loginSuccess?.properties?.user?.$ref).toBeUndefined();
    expect(loginSuccess?.properties?.user?.required).toEqual([
      "id",
      "email",
      "name",
      "status",
      "email_verified",
      "created_at",
    ]);
    expect(loginSuccess?.properties?.tenant?.properties?.id?.format).toBeUndefined();
    expect(
      successSchema("/v1/auth/switch-tenant", "post", 200)
        .properties?.tenant?.properties?.id?.format,
    ).toBeUndefined();
    const switchNotFound = successSchema("/v1/auth/switch-tenant", "post", 404);
    expect(switchNotFound.properties?.error?.enum).toEqual(["organization not found"]);
    expect(switchNotFound.properties?.reason?.enum).toEqual(["not_found"]);

    const bootstrap = successSchema("/v1/auth/bootstrap-owner", "post", 201);
    expect(bootstrap.properties?.user?.$ref).toBeUndefined();
    expect(bootstrap.properties?.tenant?.$ref).toBeUndefined();
    expect(bootstrap.properties?.tenant?.nullable).toBe(true);
    const bootstrapConflict = successSchema("/v1/auth/bootstrap-owner", "post", 409);
    expect(bootstrapConflict.oneOf).toHaveLength(2);
    expect(bootstrapConflict.oneOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        properties: expect.objectContaining({
          error: expect.objectContaining({ enum: ["this tenant already has an owner"] }),
          reason: expect.objectContaining({ enum: ["owner_exists"] }),
        }),
      }),
    ]));
    const listedKey = successSchema("/v1/keys", "get", 200)
      .properties?.keys?.items;
    expect(listedKey?.oneOf).toHaveLength(2);
    expect(listedKey?.oneOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ $ref: "#/components/schemas/ApiKeyMetadata" }),
      expect.objectContaining({
        required: ["kid", "scopes", "created_at", "expires_at", "revoked_at"],
      }),
    ]));

    const principal = successSchema("/v1/me", "get", 200);
    const userPrincipal = principal.oneOf?.find((branch) =>
      branch.properties?.principal_type?.enum?.includes("user"));
    expect(userPrincipal?.properties?.user?.$ref).toBeUndefined();
    expect(userPrincipal?.properties?.user?.required).toEqual([
      "id",
      "email",
      "name",
      "status",
      "email_verified",
      "created_at",
    ]);
    expect(
      userPrincipal?.properties?.memberships?.items?.properties?.tenant_id?.format,
    ).toBeUndefined();

    for (const method of ["get", "post"] as const) {
      const verified = successSchema("/v1/auth/verify-email", method, 200);
      expect(verified.properties?.user?.$ref).toBeUndefined();
      expect(verified.properties?.user?.required).toEqual([
        "id",
        "email",
        "name",
        "status",
        "email_verified",
        "created_at",
      ]);
      expect(verified.properties?.user?.required).not.toContain("global_role");
      expect(verified.properties?.user?.required).not.toContain("is_primary_super_admin");
      expect(verified.properties?.user?.properties).toHaveProperty("global_role");
      expect(verified.properties?.user?.properties).toHaveProperty("is_primary_super_admin");

      const rejected = successSchema("/v1/auth/verify-email", method, 400);
      const rejectedContract = rejected.anyOf?.find((variant) => variant.oneOf) ?? rejected;
      expect(rejectedContract.oneOf).toHaveLength(2);
      expect(rejectedContract.oneOf).toEqual(expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            error: expect.objectContaining({
              enum: ["verification link is invalid or expired"],
            }),
            reason: expect.objectContaining({ enum: ["invalid_token"] }),
          }),
        }),
      ]));
    }
  });

  it("models login and current-principal responses as discriminated branches", () => {
    const login = successSchema("/v1/auth/login", "post", 200);
    expect(login.oneOf).toHaveLength(2);
    expect(login.oneOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        required: ["needs_tenant", "tenants"],
        properties: expect.objectContaining({
          needs_tenant: expect.objectContaining({ enum: [true] }),
        }),
      }),
      expect.objectContaining({
        required: ["session_token", "expires_at", "user", "tenant", "role"],
      }),
    ]));

    const me = successSchema("/v1/me", "get", 200);
    expect(me.oneOf).toHaveLength(3);
    expect(me.oneOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        required: ["principal_type", "kid", "tenant", "scopes"],
        properties: expect.objectContaining({
          principal_type: expect.objectContaining({ enum: ["apikey"] }),
        }),
      }),
      expect.objectContaining({
        required: ["principal_type", "sub", "tenant", "scopes"],
        properties: expect.objectContaining({
          principal_type: expect.objectContaining({ enum: ["fleet"] }),
        }),
      }),
      expect.objectContaining({
        required: [
          "principal_type",
          "user",
          "tenant",
          "role",
          "scopes",
          "memberships",
          "email_identities",
        ],
        properties: expect.objectContaining({
          principal_type: expect.objectContaining({ enum: ["user"] }),
        }),
      }),
    ]));
  });

  it("requires the exact identity, tenancy, invitation, and membership envelopes", () => {
    expectRequired("/v1/me/email-identities", "get", 200, ["email_identities"]);
    expectRequired("/v1/me/email-identities", "post", 201, ["email_identity", "verification_required"]);
    expectRequired("/v1/me/email-identities/{id}", "delete", 200, ["removed", "id"]);
    expectRequired("/v1/me/email-identities/{id}/primary", "post", 200, ["email_identity"]);
    expectRequired("/v1/tenants", "get", 200, ["tenants"]);
    expectRequired("/v1/tenants", "post", 201, ["tenant", "role"]);
    expectRequired("/v1/tenants/{id}", "get", 200, ["tenant"]);
    expectRequired("/v1/tenants/{id}", "patch", 200, ["tenant"]);
    expectRequired("/v1/tenants/{id}", "put", 200, ["tenant"]);
    expectRequired("/v1/tenants/{id}", "delete", 200, ["suspended", "id"]);
    expectRequired("/v1/tenants/{id}/members", "get", 200, ["members"]);
    expectRequired("/v1/tenants/{id}/invites", "get", 200, ["invites"]);
    expectRequired("/v1/tenants/{id}/invites", "post", 201, ["invited", "email", "role", "expires_at"]);
    expectRequired("/v1/memberships/{id}", "patch", 200, ["membership"]);
    expectRequired("/v1/memberships/{id}", "put", 200, ["membership"]);
    expectRequired("/v1/memberships/{id}", "delete", 200, ["removed", "id"]);
  });

  it("requires every domain, address, message, mailbox, and attachment success field", () => {
    for (const [path, method, status, required] of [
      ["/v1/domains", "get", 200, ["domains"]],
      ["/v1/domains", "post", 201, ["domain"]],
      ["/v1/domains/{id}", "get", 200, ["domain"]],
      ["/v1/domains/{id}", "patch", 200, ["domain"]],
      ["/v1/domains/{id}", "put", 200, ["domain"]],
      ["/v1/domains/{id}", "delete", 200, ["deleted", "id"]],
      ["/v1/addresses", "get", 200, ["addresses"]],
      ["/v1/addresses", "post", 201, ["address"]],
      ["/v1/addresses/{id}", "get", 200, ["address"]],
      ["/v1/addresses/{id}", "patch", 200, ["address"]],
      ["/v1/addresses/{id}", "put", 200, ["address"]],
      ["/v1/addresses/{id}", "delete", 200, ["deleted", "id"]],
      ["/v1/messages", "get", 200, ["messages", "next_cursor"]],
      ["/v1/messages", "post", 200, ["message"]],
      ["/v1/messages", "post", 201, ["message"]],
      ["/v1/messages/counts", "get", 200, ["counts"]],
      ["/v1/messages/threads", "get", 200, ["threads"]],
      ["/v1/messages/{id}", "get", 200, ["message"]],
      ["/v1/messages/{id}", "patch", 200, ["message"]],
      ["/v1/messages/{id}", "put", 200, ["message"]],
      ["/v1/messages/{id}", "delete", 200, ["deleted", "id"]],
      ["/v1/messages/{id}/raw", "get", 200, ["raw", "message_id"]],
      ["/v1/mailboxes", "get", 200, ["mailboxes", "counts"]],
      ["/v1/messages/{id}/attachments/{index}", "get", 200, ["attachment"]],
      ["/v1/attachments", "get", 200, ["items", "next_cursor"]],
      ["/v1/attachments/batch", "post", 200, ["by_message_id", "unknown_ids", "max_batch_size"]],
      ["/v1/attachments/repairs", "post", 201, ["repair", "max_page_size"]],
      ["/v1/attachments/repairs/{id}", "get", 200, ["repair"]],
      ["/v1/attachments/repairs/{id}/resume", "post", 200, ["repair", "max_page_size"]],
      ["/v1/send-keys/mint", "post", 201, ["token", "key"]],
      ["/v1/send-keys/verify", "post", 200, ["valid", "authorized", "key"]],
    ] as const) {
      expectRequired(
        path,
        method as "get" | "post" | "put" | "patch" | "delete",
        status,
        [...required],
      );
    }
    expect(successSchema("/v1/messages/groups", "get", 200)).toEqual({
      $ref: "#/components/schemas/MessageCounts",
    });
  });

  it("separates nullable message attachment slots from strict batch metadata", () => {
    const componentSchemas = emailsSelfHostedOpenApi.components?.schemas as
      | Record<string, Schema>
      | undefined;
    const message = componentSchemas?.["Message"];
    const messageMetadata = componentSchemas?.["AttachmentMeta"];
    const batchMetadata = componentSchemas?.["AttachmentBatchMeta"];
    expect(message?.required).toContain("attachments");
    expect(message?.properties?.["attachments"]).toEqual({
      type: "array",
      description: expect.any(String),
      items: {
        $ref: "#/components/schemas/AttachmentMeta",
        nullable: true,
      },
    });
    expect(messageMetadata?.additionalProperties).toBe(true);
    expect(messageMetadata?.required).toBeUndefined();
    expect(Object.keys(messageMetadata?.properties ?? {}).sort()).toEqual([
      "content_available",
      "content_type",
      "filename",
      "sha256",
      "size",
    ]);

    const batchByMessageId = successSchema("/v1/attachments/batch", "post", 200)
      .properties?.["by_message_id"];
    expect(batchByMessageId?.additionalProperties).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/AttachmentBatchMeta" },
    });
    expect(batchMetadata?.additionalProperties).toBe(false);
    expect(batchMetadata?.required).toEqual([
      "attachment_index",
      "filename",
      "content_type",
      "size_bytes",
      "sha256",
      "content_available",
    ]);
  });

  it("keeps the 202 send response split between in-progress and accepted-send states", () => {
    const replay = successSchema("/v1/messages/send", "post", 200);
    expect(replay.required).toEqual([
      "message",
      "provider",
      "idempotent_replay",
      "sent",
      "provider_message_id",
    ]);
    expect(replay.properties?.idempotent_replay?.enum).toEqual([true]);
    expect(replay.properties?.sent?.enum).toEqual([true]);
    expect(replay.properties?.provider_message_id).toEqual(expect.objectContaining({
      type: "string",
      minLength: 1,
    }));

    const accepted = successSchema("/v1/messages/send", "post", 202);
    expect(accepted.oneOf).toHaveLength(2);
    expect(accepted.oneOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        required: ["message", "provider", "in_progress"],
        properties: expect.objectContaining({
          in_progress: expect.objectContaining({ enum: [true] }),
        }),
      }),
      expect.objectContaining({
        required: ["message", "provider", "sent", "provider_message_id"],
        properties: expect.objectContaining({
          sent: expect.objectContaining({ enum: [true] }),
        }),
      }),
    ]));
  });

  it("requires the generic resource key, tenant scope, declared columns, and timestamps", () => {
    for (const resource of SELF_HOSTED_RESOURCES) {
      const schema = successSchema(`/v1/${resource.path}`, "post", 201);
      const key = resource.idColumn ?? "id";
      const expected = [
        key,
        "tenant_id",
        ...resource.columns.map((column) => column.name),
        "created_at",
        "updated_at",
      ].filter((value, index, values) => values.indexOf(value) === index);
      expect(schema.required, resource.path).toEqual(expected);
      expect(schema.properties, resource.path).toHaveProperty("tenant_id");
      expect(schema.properties, resource.path).not.toHaveProperty("key_hash");
      expectRequired(`/v1/${resource.path}/{id}`, "put", 200, expected);
    }
  });

  it("keeps registry identity keys non-null when the key is also writable", () => {
    for (const [resource, key] of [
      ["email-agents", "agent_key"],
      ["address-ownership-events", "id"],
    ] as const) {
      const schema = successSchema(`/v1/${resource}`, "post", 201);
      expect(schema.properties?.[key]?.type).toBe("string");
      expect(schema.properties?.[key]?.nullable).not.toBe(true);
    }
  });

  it("publishes PUT as an exact request/response contract peer of every served PATCH", () => {
    const missing: string[] = [];
    for (const [path, pathItem] of Object.entries(paths)) {
      if (!pathItem.patch) continue;
      if (!pathItem.put) {
        missing.push(path);
        continue;
      }
      expect(pathItem.put.requestBody).toEqual(pathItem.patch.requestBody);
      expect(pathItem.put.responses).toEqual(pathItem.patch.responses);
    }
    expect(missing).toEqual([]);
  });

  it("declares a JSON schema for every non-2xx response status", () => {
    const missing: string[] = [];
    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          if (/^2\d\d$/.test(status)) continue;
          if (!response.content?.["application/json"]?.schema) {
            missing.push(`${method.toUpperCase()} ${path} ${status}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("publishes a fail-safe provider-outcome-uncertain 502 schema", () => {
    const schema = successSchema("/v1/messages/send", "post", 502);
    expect(schema.required).toEqual([
      "error",
      "reason",
      "sent",
      "retry_safe",
      "reconciliation_required",
      "message",
    ]);
    expect(schema.properties?.reason?.enum).toEqual(["provider_outcome_uncertain"]);
    expect(schema.properties?.sent?.enum).toEqual([null]);
    expect(schema.properties?.retry_safe?.enum).toEqual([false]);
    expect(schema.properties?.reconciliation_required?.enum).toEqual([true]);
  });

  it("publishes exact operational probe shapes", () => {
    expectRequired("/health", "get", 200, ["status", "version", "mode", "name", "db"]);
    expectRequired("/ready", "get", 200, [
      "status", "version", "mode", "db", "pendingMigrations", "migrationIssues",
    ]);
    expectRequired("/version", "get", 200, ["status", "version", "mode", "name"]);
    expectRequired("/openapi.json", "get", 200, [
      "openapi", "info", "security", "paths", "components",
    ]);
    expectRequired("/v1/openapi.json", "get", 200, [
      "openapi", "info", "security", "paths", "components",
    ]);
  });
});
