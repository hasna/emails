import { describe, expect, it } from "bun:test";
import { emailsSelfHostedOpenApi } from "./openapi.js";
import { SELF_HOSTED_RESOURCES } from "./resources.js";

type Operation = {
  operationId?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{ name?: string; in?: string; schema?: Record<string, unknown> }>;
  responses?: Record<string, unknown>;
  requestBody?: {
    content?: Record<string, {
      schema?: {
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
        required?: string[];
        oneOf?: Array<{
          properties?: Record<string, unknown>;
          required?: string[];
          additionalProperties?: boolean;
        }>;
      };
    }>;
  };
};

const paths = emailsSelfHostedOpenApi.paths as Record<string, Record<string, Operation>>;

const REQUIRED_IDENTITY_PATHS = [
  "/v1/auth/signup",
  "/v1/auth/login",
  "/v1/auth/verify-email",
  "/v1/auth/verify-email/resend",
  "/v1/auth/password/forgot",
  "/v1/auth/password/reset",
  "/v1/auth/bootstrap-owner",
  "/v1/auth/bootstrap-super-admin",
  "/v1/auth/logout",
  "/v1/auth/logout-all",
  "/v1/auth/switch-tenant",
  "/v1/invites/accept",
  "/v1/me",
  "/v1/me/email-identities",
  "/v1/me/email-identities/{id}",
  "/v1/me/email-identities/{id}/primary",
  "/v1/tenants",
  "/v1/tenants/{id}",
  "/v1/tenants/{id}/members",
  "/v1/tenants/{id}/invites",
  "/v1/memberships/{id}",
  "/v1/keys",
  "/v1/keys/{id}",
] as const;

describe("self-hosted OpenAPI identity and authorization contract", () => {
  it("publishes the runtime global-role vocabulary", () => {
    const userSchema = emailsSelfHostedOpenApi.components?.schemas?.User as
      | { properties?: { global_role?: { enum?: string[] } } }
      | undefined;
    expect(userSchema?.properties?.global_role?.enum).toEqual(["user", "super_admin"]);
  });

  it("publishes every identity, tenancy, membership, invitation, and key route", () => {
    for (const path of REQUIRED_IDENTITY_PATHS) {
      expect(paths[path], path).toBeDefined();
    }
    const operationIds = Object.values(paths)
      .flatMap((path) => Object.values(path))
      .map((operation) => operation.operationId)
      .filter(Boolean);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(paths["/v1/tenants/{id}"]?.put?.operationId).toBe("replaceTenant");
    expect(paths["/v1/memberships/{id}"]?.put?.operationId).toBe("replaceMembership");
  });

  it("declares both accepted credential transports and explicitly marks public routes", () => {
    expect(emailsSelfHostedOpenApi.security).toEqual([{ apiKeyAuth: [] }, { bearerAuth: [] }]);
    expect(emailsSelfHostedOpenApi.components?.securitySchemes).toMatchObject({
      apiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" },
      bearerAuth: { type: "http", scheme: "bearer" },
    });

    for (const [path, method] of [
      ["/health", "get"],
      ["/ready", "get"],
      ["/version", "get"],
      ["/openapi.json", "get"],
      ["/v1/openapi.json", "get"],
      ["/v1/auth/signup", "post"],
      ["/v1/auth/login", "post"],
      ["/v1/auth/verify-email", "get"],
      ["/v1/auth/verify-email", "post"],
      ["/v1/auth/verify-email/resend", "post"],
      ["/v1/auth/password/forgot", "post"],
      ["/v1/auth/password/reset", "post"],
      ["/v1/invites/accept", "post"],
    ] as const) {
      expect(paths[path]?.[method]?.security, `${method.toUpperCase()} ${path}`).toEqual([]);
    }
    expect(paths["/v1/auth/bootstrap-super-admin"]?.post?.security).toBeUndefined();
    expect(paths["/v1/me"]?.get?.security).toBeUndefined();
  });

  it("formalizes scoped sender authorization on the send operation", () => {
    const send = paths["/v1/messages/send"]?.post;
    const schema = send?.requestBody?.content?.["application/json"]?.schema;
    expect(send?.operationId).toBe("sendMessage");
    expect(schema?.properties).toHaveProperty("send_key");
    expect(schema?.required).toEqual(expect.arrayContaining(["from", "to", "subject", "idempotency_key"]));
    expect(send?.description).toContain("Member sessions must supply");
    expect(send?.description).toContain("owner/admin");
    expect(send?.responses).toHaveProperty("200");
    expect(send?.responses).toHaveProperty("202");
    expect(send?.responses).toHaveProperty("400");
    expect(send?.responses).toHaveProperty("401");
    expect(send?.responses).toHaveProperty("403");
    expect(send?.responses).toHaveProperty("409");
    expect(send?.responses).toHaveProperty("429");
    expect(send?.responses).toHaveProperty("413");
    // 422 = definitive provider reject (nothing was sent); 502 = indeterminate
    // provider outcome (reconcile before retrying). They are different states
    // and the contract keeps them distinguishable.
    expect(send?.responses).toHaveProperty("422");
    expect(send?.responses).toHaveProperty("502");
    // 503 = a rejected intent could not be re-armed (sent: false, retry later).
    expect(send?.responses).toHaveProperty("503");
    const sendError = emailsSelfHostedOpenApi.components?.schemas?.SendMessageError as
      | { properties?: { message?: { oneOf?: Array<{ $ref?: string }>; nullable?: boolean } } }
      | undefined;
    expect(sendError?.properties?.message).toMatchObject({
      nullable: true,
      oneOf: [
        { $ref: "#/components/schemas/Message" },
        { $ref: "#/components/schemas/SendIntentMessage" },
      ],
    });
  });

  it("documents attachment defaults that align with send runtime behavior", () => {
    const sendSchema = paths["/v1/messages/send"]?.post?.requestBody?.content?.["application/json"]?.schema;
    const attachments = sendSchema?.properties?.attachments;
    const attachmentItem = attachments?.items as
      | { properties?: Record<string, { default?: string; description?: string; type?: string }>; required?: string[] }
      | undefined;
    expect(attachments).toMatchObject({
      type: "array",
      maxItems: 5,
    });
    expect(Array.isArray(attachmentItem?.required)).toBe(true);
    expect(attachmentItem?.required).toEqual(["content"]);
    expect(attachmentItem?.properties?.filename).toMatchObject({
      type: "string",
      default: "attachment-{n}",
      description: expect.stringContaining("attachment-{n}"),
    });
    expect(attachmentItem?.properties?.content_type).toMatchObject({
      type: "string",
      default: "application/octet-stream",
      description: expect.stringContaining("application/octet-stream"),
    });
    expect(attachmentItem?.properties?.content).toMatchObject({
      type: "string",
      description: "Base64-encoded attachment content",
    });
  });

  it("publishes message body/header writes and closes the patch object", () => {
    for (const method of ["patch", "put"] as const) {
      const operation = paths["/v1/messages/{id}"]?.[method];
      const schema = operation?.requestBody?.content?.["application/json"]?.schema;
      expect(schema?.additionalProperties, method).toBe(false);
      expect(schema?.properties, method).toMatchObject({
        body_text: { type: "string", nullable: true },
        body_html: { type: "string", nullable: true },
        headers: { type: "object", additionalProperties: true },
      });
      expect(operation?.responses, method).toHaveProperty("400");
    }
  });

  it("publishes body-only send-intent recovery operations", () => {
    const lookup = paths["/v1/messages/send-intents/lookup"]?.post;
    const cancel = paths["/v1/messages/send-intents/cancel"]?.post;
    for (const operation of [lookup, cancel]) {
      const schema = operation?.requestBody?.content?.["application/json"]?.schema;
      expect(schema?.required).toEqual(["idempotency_key"]);
      expect(schema?.properties?.["idempotency_key"]).toMatchObject({
        type: "string",
        minLength: 1,
        maxLength: 200,
      });
      expect(operation?.parameters).toBeUndefined();
    }
    expect(lookup?.operationId).toBe("lookupSendIntent");
    expect(cancel?.operationId).toBe("cancelSendIntent");
    expect(lookup?.responses).toHaveProperty("200");
    expect(lookup?.responses).toHaveProperty("400");
    expect(lookup?.responses).toHaveProperty("401");
    expect(lookup?.responses).toHaveProperty("403");
    expect(lookup?.responses).toHaveProperty("413");
    expect(cancel?.responses).toHaveProperty("200");
    expect(cancel?.responses).toHaveProperty("400");
    expect(cancel?.responses).toHaveProperty("401");
    expect(cancel?.responses).toHaveProperty("403");
    expect(cancel?.responses).toHaveProperty("413");
    expect(emailsSelfHostedOpenApi.components?.schemas?.SendIntentMessage).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["id", "send_state"],
      properties: {
        id: { type: "string" },
        send_state: {
          type: "string",
          enum: ["none", "pending", "blocked", "cancelled", "sending", "sent", "failed", "uncertain"],
        },
      },
    });
  });

  it("documents durable send-intent deletion refusal", () => {
    const deletion = paths["/v1/messages/{id}"]?.delete;
    expect(deletion?.responses).toHaveProperty("200");
    expect(deletion?.responses).toHaveProperty("401");
    expect(deletion?.responses).toHaveProperty("403");
    expect(deletion?.responses).toHaveProperty("404");
    expect(deletion?.responses).toHaveProperty("409");
    expect(deletion?.responses?.["409"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/SendMessageError",
    });
  });

  it("publishes a bounded typed attachment-content operation", () => {
    const operation = paths["/v1/messages/{id}/attachments/{index}"]?.get;
    const schema = emailsSelfHostedOpenApi.components?.schemas?.AttachmentContent as
      | { additionalProperties?: boolean; required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    const maxBytes = operation?.parameters?.find((item) => item.name === "max_bytes");

    expect(operation?.operationId).toBe("getMessageAttachment");
    expect(maxBytes).toMatchObject({
      in: "query",
      schema: { type: "integer", minimum: 1, maximum: 25 * 1024 * 1024 },
    });
    expect(Object.keys(operation?.responses ?? {})).toEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "409",
      "413",
      "422",
      "500",
    ]);
    expect(operation?.responses?.["400"]).toMatchObject({
      description: expect.stringContaining("max_bytes"),
    });
    expect(operation?.responses?.["409"]?.content?.["application/json"]?.schema)
      .toEqual({ $ref: "#/components/schemas/AttachmentUnavailableError" });
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required).toEqual(["filename", "content_type", "size", "content_base64"]);
    expect(schema?.properties).toHaveProperty("content_base64");
  });

  it("publishes availability-only inventory metadata and checkpointed repair operations", () => {
    const inventory = emailsSelfHostedOpenApi.components?.schemas?.AttachmentInventoryItem as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    const batch = emailsSelfHostedOpenApi.components?.schemas?.AttachmentBatchMeta as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    const message = emailsSelfHostedOpenApi.components?.schemas?.AttachmentMeta as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;

    for (const schema of [inventory, batch]) {
      expect(schema?.required).toContain("content_available");
      expect(schema?.properties?.content_available).toMatchObject({ type: "boolean" });
      expect(schema?.properties).not.toHaveProperty("content_base64");
    }
    expect(message?.required).toBeUndefined();
    expect(message?.properties?.content_available).toMatchObject({ type: "boolean" });
    expect(message?.properties).not.toHaveProperty("content_base64");
    expect(paths["/v1/attachments"]?.get?.responses?.["400"]
      ?.content?.["application/json"]?.schema?.properties?.code)
      .toMatchObject({
        enum: ["invalid_cursor", "invalid_direction", "invalid_since", "invalid_limit"],
      });
    expect(inventory?.required).toEqual([
      "message_id",
      "attachment_index",
      "filename",
      "content_type",
      "size_bytes",
      "sha256",
      "content_available",
      "direction",
      "received_at",
    ]);
    expect(paths["/v1/attachments/repairs"]?.post?.operationId).toBe("createOrResumeAttachmentRepair");
    expect(paths["/v1/attachments/repairs/{id}"]?.get?.operationId).toBe("getAttachmentRepair");
    expect(paths["/v1/attachments/repairs/{id}/resume"]?.post?.operationId).toBe("resumeAttachmentRepair");
    const request = paths["/v1/attachments/repairs"]?.post?.requestBody
      ?.content?.["application/json"]?.schema;
    expect(request?.oneOf).toHaveLength(2);
    const dryRunRequest = request?.oneOf?.find(
      (variant) =>
        (variant.properties?.apply as { enum?: boolean[] } | undefined)?.enum?.[0] === false,
    );
    const applyRequest = request?.oneOf?.find(
      (variant) =>
        (variant.properties?.apply as { enum?: boolean[] } | undefined)?.enum?.[0] === true,
    );
    expect(dryRunRequest?.additionalProperties).toBe(false);
    expect(dryRunRequest?.properties?.apply).toMatchObject({
      type: "boolean",
      enum: [false],
      default: false,
    });
    expect(Object.keys(dryRunRequest?.properties ?? {}).sort()).toEqual([
      "apply",
      "entries",
      "idempotency_key",
      "limit",
    ]);
    expect(dryRunRequest?.required).toEqual(["idempotency_key", "entries"]);
    expect(applyRequest?.additionalProperties).toBe(false);
    expect(applyRequest?.properties?.apply).toMatchObject({
      type: "boolean",
      enum: [true],
    });
    expect(Object.keys(applyRequest?.properties ?? {}).sort()).toEqual([
      "apply",
      "entries",
      "idempotency_key",
      "limit",
      "reviewed_dry_run_id",
      "reviewed_dry_run_result_sha256",
    ]);
    expect(applyRequest?.required).toEqual([
      "idempotency_key",
      "apply",
      "entries",
      "reviewed_dry_run_id",
      "reviewed_dry_run_result_sha256",
    ]);
    expect(applyRequest?.properties?.reviewed_dry_run_id).toMatchObject({
      type: "string",
      format: "uuid",
    });
    expect(applyRequest?.properties?.reviewed_dry_run_result_sha256).toMatchObject({
      type: "string",
      minLength: 64,
      maxLength: 64,
      pattern: "^[0-9a-f]{64}$",
    });
    const resumeRequest = paths["/v1/attachments/repairs/{id}/resume"]?.post?.requestBody
      ?.content?.["application/json"]?.schema;
    expect(Object.keys(resumeRequest?.properties ?? {})).toEqual(["limit"]);
    const summary = emailsSelfHostedOpenApi.components?.schemas?.AttachmentRepairSummary;
    for (const field of [
      "would_repair",
      "operator_action",
      "retrying",
      "entry_repaired",
      "entry_would_repair",
      "entry_unavailable",
      "entry_operator_action",
      "entry_pending",
      "entry_retrying",
      "attempts",
      "bytes_consumed",
    ]) {
      expect(summary?.required).toContain(field);
      expect(summary?.properties?.[field]).toMatchObject({ type: "integer", minimum: 0 });
    }
    for (const field of ["byte_budget", "time_budget_ms"]) {
      expect(summary?.required).toContain(field);
      expect(summary?.properties?.[field]).toMatchObject({ type: "integer", minimum: 1 });
    }
    expect(summary?.required).toContain("deadline_at");
    expect(summary?.properties?.deadline_at).toMatchObject({ type: "string", format: "date-time" });
    expect(paths["/v1/attachments/repairs"]?.post?.responses?.["429"]
      ?.content?.["application/json"]?.schema?.properties?.quota)
      .toMatchObject({ enum: ["active_runs", "ledger_runs", "ledger_entries"] });
    const repairBadRequest = paths["/v1/attachments/repairs"]?.post?.responses?.["400"]
      ?.content?.["application/json"]?.schema;
    const repairBadRequestVariant = repairBadRequest?.anyOf?.find(
      (variant) => variant.properties?.code,
    ) ?? repairBadRequest;
    expect(repairBadRequestVariant?.properties?.code)
      .toMatchObject({ enum: expect.arrayContaining(["invalid_repair_review"]) });
    expect(paths["/v1/attachments/repairs"]?.post?.responses?.["409"]
      ?.content?.["application/json"]?.schema?.properties?.code)
      .toMatchObject({
        enum: [
          "attachment_repair_idempotency_conflict",
          "attachment_repair_review_mismatch",
        ],
      });
    const repairIdParameter = paths["/v1/attachments/repairs/{id}"]?.get?.parameters?.[0];
    expect(repairIdParameter?.schema).toMatchObject({ type: "string", format: "uuid" });
    expect(paths["/v1/attachments/repairs/{id}"]?.get?.responses?.["400"]
      ?.content?.["application/json"]?.schema?.properties?.code)
      .toMatchObject({ enum: ["invalid_attachment_repair_id"] });
    const resumeBadRequest = paths["/v1/attachments/repairs/{id}/resume"]?.post
      ?.responses?.["400"]?.content?.["application/json"]?.schema;
    const resumeBadRequestVariant = resumeBadRequest?.anyOf?.find(
      (variant) => variant.properties?.code,
    ) ?? resumeBadRequest;
    expect(resumeBadRequestVariant?.properties?.code)
      .toMatchObject({
        enum: expect.arrayContaining([
          "invalid_attachment_repair_id",
          "invalid_repair_limit",
          "invalid_repair_body",
        ]),
      });
    expect(paths["/v1/attachments/repairs/{id}/resume"]?.post?.responses?.["503"]
      ?.content?.["application/json"]?.schema?.properties?.code)
      .toMatchObject({ enum: ["attachment_repair_not_configured"] });
    expect(JSON.stringify(paths["/v1/attachments/repairs"])).not.toContain("content_base64");
  });

  it("publishes both provider webhook receivers as explicitly public routes", () => {
    // These are the ONLY /v1 routes a provider (AWS SNS, Resend) calls, and a
    // provider holds no Hasna API key: the contract must say so, or an operator
    // reading the document would put an API-key gate in front of them and
    // silently break inbound mail and delivery-event ingestion.
    for (const path of ["/v1/webhooks/ses-inbound", "/v1/webhooks/resend-inbound"]) {
      const operation = paths[path]?.post;
      expect(operation, path).toBeDefined();
      expect(operation?.security, path).toEqual([]);
      // The receivers fail CLOSED when their verification material is missing.
      expect(operation?.responses, path).toHaveProperty("401");
      expect(operation?.responses, path).toHaveProperty("503");
      expect(operation?.responses, path).toHaveProperty("413");
      expect(operation?.responses, path).toHaveProperty("200");
      // Only POST is served; nothing else may be documented on these paths.
      expect(Object.keys(paths[path] ?? {}), path).toEqual(["post"]);
    }
    expect(paths["/v1/webhooks/ses-inbound"]?.post?.operationId).toBe("receiveSesInboundWebhook");
    expect(paths["/v1/webhooks/resend-inbound"]?.post?.operationId).toBe("receiveResendInboundWebhook");
    // The documented tenant-selection rule is the one the code implements.
    expect(paths["/v1/webhooks/ses-inbound"]?.post?.description).toContain("never from a body field");
    expect(paths["/v1/webhooks/resend-inbound"]?.post?.description).toContain("never");
    expect(paths["/v1/webhooks/resend-inbound"]?.post?.description).toContain("fails CLOSED");
    for (const schema of ["SnsNotification", "ResendWebhookEvent", "WebhookReceipt"]) {
      expect(emailsSelfHostedOpenApi.components?.schemas?.[schema], schema).toBeDefined();
    }
  });

  it("enumerates every registry-backed resource in the generated contract", () => {
    for (const resource of SELF_HOSTED_RESOURCES) {
      const collection = paths[`/v1/${resource.path}`];
      const item = paths[`/v1/${resource.path}/{id}`];
      expect(collection?.get?.operationId, resource.path).toBeDefined();
      expect(collection?.post?.operationId, resource.path).toBeDefined();
      expect(item?.get?.operationId, resource.path).toBeDefined();
      expect(item?.patch?.operationId, resource.path).toBeDefined();
      expect(item?.delete?.operationId, resource.path).toBeDefined();
    }
  });
});
