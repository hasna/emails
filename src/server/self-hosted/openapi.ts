// OpenAPI 3 description of the Emails self-hosted service (/v1).
//
// This is the single source of truth for the service's public HTTP contract:
// it is served at GET /openapi.json AND fed to @hasna/contracts' SDK generator
// to emit the typed client in sdk/. Keep it in lockstep with service.ts.

import type { OpenApiDocument } from "@hasna/contracts/sdk";
import { SELF_HOSTED_RESOURCES, type ResourceColumn } from "./resources.js";

type SecurityRequirement = Record<string, string[]>;
type EmailsOpenApiDocument = OpenApiDocument & {
  security?: SecurityRequirement[];
  components?: NonNullable<OpenApiDocument["components"]> & {
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
};

const publicOperation = { security: [] as SecurityRequirement[] } as const;

const roleSchema = {
  type: "string",
  enum: ["owner", "admin", "member", "viewer"],
} as const;

const trueSchema = { type: "boolean", enum: [true] } as const;

const errorResponseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    error: { type: "string", minLength: 1 },
  },
  required: ["error"],
} as const;

function errorResponse(description: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorResponse" },
      },
    },
  };
}

function jsonResponse(description: string, schema: Record<string, unknown>) {
  return {
    description,
    content: {
      "application/json": { schema },
    },
  };
}

function exactErrorSchema(error: string, reason: string) {
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      error: { type: "string", enum: [error] },
      reason: { type: "string", enum: [reason] },
    },
    required: ["error", "reason"],
  } as const;
}

type ResponseSchema = Record<string, unknown>;
type OpenApiResponse = {
  description?: string;
  content?: Record<string, { schema?: ResponseSchema }>;
};
type OpenApiOperation = {
  operationId?: string;
  security?: SecurityRequirement[];
  requestBody?: unknown;
  responses?: Record<string, OpenApiResponse>;
};

const closedErrorOnlySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    error: { type: "string", minLength: 1 },
  },
  required: ["error"],
} as const;

const closedErrorReasonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    error: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 },
  },
  required: ["error", "reason"],
} as const;

function exactErrorOnlySchema(error: string) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      error: { type: "string", enum: [error] },
    },
    required: ["error"],
  } as const;
}

function closedExactErrorSchema(error: string, reason: string) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      error: { type: "string", enum: [error] },
      reason: { type: "string", enum: [reason] },
    },
    required: ["error", "reason"],
  } as const;
}

function anyOfSchemas(...schemas: ResponseSchema[]): ResponseSchema {
  const flattened = schemas.flatMap((schema) =>
    Array.isArray(schema.anyOf)
      ? schema.anyOf.filter((branch): branch is ResponseSchema =>
          branch !== null && typeof branch === "object" && !Array.isArray(branch))
      : [schema]);
  const unique = flattened.filter((schema, index) =>
    flattened.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(schema)) === index);
  return unique.length === 1 ? unique[0]! : { anyOf: unique };
}

function responseSchema(response: OpenApiResponse | undefined): ResponseSchema | undefined {
  const schema = response?.content?.["application/json"]?.schema;
  return schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema
    : undefined;
}

function routineErrorResponse(description: string, schema: ResponseSchema): OpenApiResponse {
  return {
    description,
    content: {
      "application/json": { schema },
    },
  };
}

function setRoutineErrorResponse(
  operation: OpenApiOperation,
  status: number,
  description: string,
  schema: ResponseSchema,
  mode: "merge" | "replace" = "merge",
): void {
  operation.responses ??= {};
  const key = String(status);
  const existing = operation.responses[key];
  const existingSchema = responseSchema(existing);
  operation.responses[key] = routineErrorResponse(
    existing?.description ?? description,
    mode === "merge" && existingSchema
      ? anyOfSchemas(existingSchema, schema)
      : schema,
  );
}

const authenticationRequiredSchema = closedErrorReasonSchema;
const authorizationRequiredSchema = closedErrorReasonSchema;
const invalidRequestBodySchema = closedErrorOnlySchema;
const requestBodyTooLargeSchema = exactErrorOnlySchema("request body too large");
const internalErrorSchema = exactErrorOnlySchema("internal error");
const crossTenantReferenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    error: { type: "string", minLength: 1 },
    reason: { type: "string", enum: ["cross_tenant_reference"] },
  },
  required: ["error", "reason"],
} as const;
const inboundRouteConflictSchema = closedExactErrorSchema(
  "inbound domain route is already claimed",
  "inbound_route_conflict",
);
const rateLimitedSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    error: { type: "string", enum: ["too many requests"] },
    reason: { type: "string", enum: ["rate_limited"] },
    retry_after: { type: "number", minimum: 0 },
  },
  required: ["error", "reason", "retry_after"],
} as const;
const loginLockedSchema = closedExactErrorSchema(
  "too many attempts; try again later",
  "locked",
);

const signupForbiddenResponseSchema = exactErrorSchema(
  "signups are restricted",
  "email_not_allowed",
);

const loginForbiddenResponseSchema = {
  oneOf: [
    exactErrorSchema("login is restricted", "email_not_allowed"),
    exactErrorSchema("email is not verified", "email_unverified"),
    closedExactErrorSchema(
      "your account is not a member of any organization",
      "no_tenant",
    ),
    exactErrorSchema(
      "you are not a member of that organization",
      "not_a_member",
    ),
  ],
} as const;

const loginUnauthorizedResponseSchema = exactErrorSchema(
  "invalid email or password",
  "invalid_credentials",
);

const verifyEmailBadRequestResponseSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: true,
      properties: {
        error: { type: "string", enum: ["token is required"] },
      },
      required: ["error"],
    },
    exactErrorSchema(
      "verification link is invalid or expired",
      "invalid_token",
    ),
  ],
} as const;

const switchTenantNotFoundResponseSchema = exactErrorSchema(
  "organization not found",
  "not_found",
);

const bootstrapOwnerConflictResponseSchema = {
  oneOf: [
    exactErrorSchema("this tenant already has an owner", "owner_exists"),
    exactErrorSchema("an account with that email already exists", "email_taken"),
  ],
} as const;

const deleteReceiptSchema = {
  type: "object",
  properties: {
    deleted: trueSchema,
    id: { type: "string" },
  },
  required: ["deleted", "id"],
} as const;

const removedReceiptSchema = {
  type: "object",
  properties: {
    removed: trueSchema,
    id: { type: "string" },
  },
  required: ["removed", "id"],
} as const;

const userSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
    name: { type: "string", nullable: true },
    status: { type: "string" },
    email_verified: { type: "boolean" },
    global_role: { type: "string", enum: ["user", "super_admin"] },
    is_primary_super_admin: { type: "boolean" },
    created_at: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "email",
    "name",
    "status",
    "email_verified",
    "global_role",
    "is_primary_super_admin",
    "created_at",
  ],
} as const;

const tenantSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    slug: { type: "string" },
    name: { type: "string" },
    status: { type: "string" },
  },
  required: ["id", "slug", "name", "status"],
} as const;

const authRouteUserSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    ...userSchema.properties,
    // Auth-route clients treat the identity as opaque. Production currently
    // emits UUIDs, but compatible hermetic implementations may use another
    // non-empty identifier.
    id: { type: "string", minLength: 1 },
  },
  required: [
    "id",
    "email",
    "name",
    "status",
    "email_verified",
    "created_at",
  ],
} as const;

const authRouteTenantSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    ...tenantSchema.properties,
    id: { type: "string", minLength: 1 },
  },
  required: tenantSchema.required,
} as const;

const authRouteTenantReferenceSchema = {
  oneOf: [
    authRouteTenantSchema,
    {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
    },
  ],
} as const;

const tenantMembershipSummarySchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    slug: { type: "string" },
    name: { type: "string" },
    status: { type: "string" },
    role: roleSchema,
  },
  required: ["id", "slug", "name", "status", "role"],
} as const;

const tenantChoiceSchema = {
  type: "object",
  properties: {
    slug: { type: "string" },
    name: { type: "string" },
    role: roleSchema,
  },
  required: ["slug", "name", "role"],
} as const;

const emailIdentitySchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
    is_primary: { type: "boolean" },
    verified: { type: "boolean" },
    created_at: { type: "string", format: "date-time" },
  },
  required: ["id", "email", "is_primary", "verified"],
} as const;

const membershipSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    user_id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
    name: { type: "string", nullable: true },
    role: roleSchema,
    status: { type: "string" },
    created_at: { type: "string", format: "date-time" },
  },
  required: ["id", "user_id", "email", "name", "role", "status", "created_at"],
} as const;

const membershipSummarySchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    role: roleSchema,
    status: { type: "string" },
  },
  required: ["id", "role", "status"],
} as const;

const invitationSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
    role: roleSchema,
    expires_at: { type: "string", format: "date-time" },
    accepted_at: { type: "string", format: "date-time", nullable: true },
    created_at: { type: "string", format: "date-time" },
  },
  required: ["id", "email", "role", "expires_at", "accepted_at", "created_at"],
} as const;

const apiKeyMetadataSchema = {
  type: "object",
  properties: {
    kid: { type: "string" },
    app: { type: "string" },
    agent: { type: "string", nullable: true },
    scopes: { type: "array", items: { type: "string" } },
    issued_at: { type: "string", format: "date-time" },
    expires_at: { type: "string", format: "date-time", nullable: true },
    revoked_at: { type: "string", format: "date-time", nullable: true },
    last_used_at: { type: "string", format: "date-time", nullable: true },
    created_by_user_id: { type: "string", format: "uuid", nullable: true },
  },
  required: [
    "kid",
    "app",
    "agent",
    "scopes",
    "issued_at",
    "expires_at",
    "revoked_at",
    "last_used_at",
    "created_by_user_id",
  ],
} as const;

const legacyApiKeyMetadataSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    ...apiKeyMetadataSchema.properties,
    created_at: { type: "string", format: "date-time" },
  },
  required: ["kid", "scopes", "created_at", "expires_at", "revoked_at"],
} as const;

const tenantKeyListItemSchema = {
  oneOf: [
    { $ref: "#/components/schemas/ApiKeyMetadata" },
    legacyApiKeyMetadataSchema,
  ],
} as const;

/** One IdP-principal federation grant row (ADR-0001/0002 operator surface). */
const idpPrincipalGrantSchema = {
  type: "object",
  properties: {
    sub: { type: "string" },
    tenant_id: { type: "string" },
    idp_tid: { type: "string", nullable: true },
    principal_type: { type: "string", enum: ["user", "service"] },
    note: { type: "string", nullable: true },
    created_at: { type: "string", format: "date-time" },
    revoked_at: { type: "string", format: "date-time", nullable: true },
  },
  required: ["sub", "tenant_id", "idp_tid", "principal_type", "revoked_at"],
} as const;

const sendKeySchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    owner_id: { type: "string", nullable: true },
    prefix: { type: "string", nullable: true },
    label: { type: "string", nullable: true },
    last_used_at: { type: "string", format: "date-time", nullable: true },
    revoked_at: { type: "string", format: "date-time", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "owner_id",
    "prefix",
    "label",
    "last_used_at",
    "revoked_at",
    "created_at",
    "updated_at",
  ],
} as const;

const domainSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    domain: { type: "string" },
    status: { type: "string" },
    provider: { type: "string", nullable: true },
    verified: { type: "boolean" },
    notes: { type: "string", nullable: true },
    // Provisioning lifecycle state (mirrors the local domains provisioning columns).
    provisioning_status: { type: "string" },
    purchase_provider: { type: "string", nullable: true },
    dns_provider: { type: "string" },
    send_provider: { type: "string", nullable: true },
    cf_zone_id: { type: "string", nullable: true },
    registrar: { type: "string", nullable: true },
    nameservers_json: { type: "array", items: { type: "string" } },
    mail_from_domain: { type: "string", nullable: true },
    last_error: { type: "string", nullable: true },
    next_check_at: { type: "string", format: "date-time", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: ["id", "domain", "status", "verified", "created_at", "updated_at"],
} as const;

const addressSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    domain: { type: "string", nullable: true },
    display_name: { type: "string", nullable: true },
    status: { type: "string" },
    verified: { type: "boolean" },
    daily_quota: { type: "integer", nullable: true },
    owner_id: { type: "string", nullable: true },
    administrator_id: { type: "string", nullable: true },
    // Provisioning lifecycle state (mirrors the local addresses provisioning columns).
    domain_id: { type: "string", nullable: true },
    receive_strategy: { type: "string", nullable: true },
    forward_to: { type: "string", nullable: true },
    routing_rule_id: { type: "string", nullable: true },
    provisioning_status: { type: "string" },
    last_validated_at: { type: "string", format: "date-time", nullable: true },
    last_error: { type: "string", nullable: true },
    next_check_at: { type: "string", format: "date-time", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: ["id", "email", "status", "created_at", "updated_at"],
} as const;

// Provisioning fields accepted on a domain PATCH (all optional; null clears).
const domainProvisioningProps = {
  provisioning_status: { type: "string" },
  purchase_provider: { type: "string", nullable: true },
  dns_provider: { type: "string" },
  send_provider: { type: "string", nullable: true },
  cf_zone_id: { type: "string", nullable: true },
  registrar: { type: "string", nullable: true },
  nameservers_json: { type: "array", items: { type: "string" } },
  mail_from_domain: { type: "string", nullable: true },
  last_error: { type: "string", nullable: true },
  next_check_at: { type: "string", format: "date-time", nullable: true },
} as const;

// Provisioning fields accepted on an address PATCH (all optional; null clears).
const addressProvisioningProps = {
  domain_id: { type: "string", nullable: true },
  receive_strategy: { type: "string", nullable: true },
  forward_to: { type: "string", nullable: true },
  routing_rule_id: { type: "string", nullable: true },
  provisioning_status: { type: "string" },
  last_validated_at: { type: "string", format: "date-time", nullable: true },
  last_error: { type: "string", nullable: true },
  next_check_at: { type: "string", format: "date-time", nullable: true },
} as const;

const threadSchema = {
  type: "object",
  properties: {
    thread_key: { type: "string", description: "Normalized (Re:/Fwd:-stripped) subject key" },
    subject: { type: "string", nullable: true },
    message_count: { type: "integer" },
    unread_count: { type: "integer" },
    last_message_at: { type: "string", format: "date-time", nullable: true },
    first_message_at: { type: "string", format: "date-time", nullable: true },
    participants: { type: "array", items: { type: "string" } },
  },
  required: [
    "thread_key",
    "subject",
    "message_count",
    "unread_count",
    "last_message_at",
    "first_message_at",
    "participants",
  ],
} as const;

const mailboxSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    address: { type: "string" },
    display_name: { type: "string", nullable: true },
    status: { type: "string" },
    total: { type: "integer" },
    unread: { type: "integer" },
  },
  required: ["id", "address", "display_name", "status", "total", "unread"],
} as const;

/**
 * The AWS SNS envelope the SES receiver accepts. Additional properties are
 * allowed on purpose: the envelope is verified by SIGNATURE over the canonical
 * SNS fields, so pinning a closed shape here would reject valid AWS payloads
 * without adding any security.
 */
const snsNotificationSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    Type: { type: "string", enum: ["Notification", "SubscriptionConfirmation"] },
    MessageId: { type: "string", description: "Signed SNS message id; the idempotency key" },
    TopicArn: { type: "string", description: "Must be in EMAILS_SNS_TOPIC_ARNS" },
    Message: { type: "string", description: "Serialized SES notification (Received | Bounce | Complaint | Delivery)" },
    Timestamp: { type: "string" },
    Signature: { type: "string" },
    SignatureVersion: { type: "string", enum: ["1", "2"] },
    SigningCertURL: { type: "string", description: "Host-pinned to sns.<region>.amazonaws.com" },
    SubscribeURL: { type: "string", description: "SubscriptionConfirmation only; host-pinned to sns.<region>.amazonaws.com" },
    Token: { type: "string" },
  },
  required: ["MessageId", "Signature", "SignatureVersion", "SigningCertURL"],
} as const;

/** The Resend (Svix-signed) webhook body. Signed, so extra fields are allowed. */
const resendWebhookEventSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    type: {
      type: "string",
      description:
        "email.received | inbound.email.received route to inbound mail; "
        + "email.delivered | email.bounced | email.complained | email.opened | email.clicked "
        + "route to the delivery-outcome ledger.",
    },
    created_at: { type: "string", format: "date-time" },
    data: { type: "object", additionalProperties: true },
  },
  required: ["type"],
} as const;

/** The uniform receiver acknowledgement. */
const webhookReceiptSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    ok: { type: "boolean" },
    duplicate: { type: "boolean", description: "The event id was already completed in every destination scope" },
    confirmed: { type: "boolean", description: "An SNS subscription confirmation was fetched" },
    ignored: { type: "string", description: "Accepted but not persisted, with the reason" },
    synced: { type: "integer", minimum: 0, description: "Inbound objects newly stored" },
    id: { type: "string", nullable: true, description: "Stored inbound message id" },
    event_id: { type: "string", description: "Stored delivery-outcome row id" },
    type: { type: "string", description: "delivered | bounced | complained | opened | clicked" },
    message_id: { type: "string", nullable: true, description: "Provider message id" },
    object_key: { type: "string", nullable: true, description: "S3 object key the notification referenced" },
  },
  required: ["ok"],
} as const;

const messageSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    direction: { type: "string", description: "outbound | inbound" },
    from_addr: { type: "string" },
    to_addrs: { type: "array", items: { type: "string" } },
    cc_addrs: { type: "array", items: { type: "string" } },
    subject: { type: "string", nullable: true },
    body_text: { type: "string", nullable: true },
    body_html: { type: "string", nullable: true },
    status: { type: "string" },
    provider_message_id: { type: "string", nullable: true },
    message_id: { type: "string", nullable: true, description: "RFC 5322 Message-ID" },
    in_reply_to: { type: "string", nullable: true },
    received_at: { type: "string", format: "date-time", nullable: true, description: "Original receipt time (inbound)" },
    is_read: { type: "boolean" },
    is_starred: { type: "boolean" },
    labels: { type: "array", items: { type: "string" } },
    headers: { type: "object", additionalProperties: true },
    attachments: {
      type: "array",
      description:
        "Per-attachment metadata (filename, content_type, size) plus content_available — true when GET /v1/messages/{id}/attachments/{index} can return bytes, false for metadata-only rows such as legacy imports. content_base64 is never included here.",
      items: {
        $ref: "#/components/schemas/AttachmentMeta",
        nullable: true,
      },
    },
    source_id: { type: "string", nullable: true, description: "Stable upstream id used for idempotent upsert" },
    send_state: { type: "string", description: "none | pending | sending | sent | failed | uncertain | blocked | cancelled" },
    send_started_at: { type: "string", format: "date-time", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "direction",
    "from_addr",
    "to_addrs",
    "cc_addrs",
    "subject",
    "body_text",
    "body_html",
    "status",
    "provider_message_id",
    "message_id",
    "in_reply_to",
    "received_at",
    "is_read",
    "is_starred",
    "labels",
    "headers",
    "attachments",
    "source_id",
    "send_state",
    "send_started_at",
    "created_at",
    "updated_at",
  ],
} as const;

const idempotencyKeyRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
  },
  required: ["idempotency_key"],
} as const;

const sendIntentLookupSchema = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    tombstoned: { type: "boolean" },
    reconciliation_required: { type: "boolean" },
    message: { $ref: "#/components/schemas/SendIntentMessage", nullable: true },
  },
  required: ["found", "tombstoned", "reconciliation_required", "message"],
} as const;

const sendIntentCancellationSchema = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["tombstoned", "cancelled", "reconciliation_required"] },
    tombstoned: { type: "boolean", enum: [true] },
    reconciliation_required: { type: "boolean" },
    message: { $ref: "#/components/schemas/SendIntentMessage", nullable: true },
  },
  required: ["outcome", "tombstoned", "reconciliation_required", "message"],
} as const;

const sendMessageErrorSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    error: { type: "string" },
    reason: { type: "string", description: "Machine-readable failure class, e.g. provider_rejected | provider_outcome_uncertain | a policy code" },
    provider_error: { type: "string", description: "The provider SDK error name (e.g. MessageRejected) when the provider call failed" },
    sent: {
      type: "boolean",
      nullable: true,
      description: "What is KNOWN about the send: false = definitively not sent (provider rejected); null = indeterminate (reconcile before retrying)",
    },
    retry_safe: { type: "boolean" },
    reconciliation_required: { type: "boolean" },
    tombstoned: { type: "boolean" },
    message: {
      oneOf: [
        { $ref: "#/components/schemas/Message" },
        { $ref: "#/components/schemas/SendIntentMessage" },
      ],
      nullable: true,
    },
  },
  required: ["error", "retry_safe"],
} as const;

const providerOutcomeUncertainErrorSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    error: { type: "string", minLength: 1 },
    reason: { type: "string", enum: ["provider_outcome_uncertain"] },
    provider_error: { type: "string" },
    sent: { type: "boolean", nullable: true, enum: [null] },
    retry_safe: { type: "boolean", enum: [false] },
    reconciliation_required: { type: "boolean", enum: [true] },
    message: { $ref: "#/components/schemas/Message" },
  },
  required: [
    "error",
    "reason",
    "sent",
    "retry_safe",
    "reconciliation_required",
    "message",
  ],
} as const;

const sendMessageReplayResponseSchema = {
  type: "object",
  properties: {
    message: { $ref: "#/components/schemas/Message" },
    provider: { type: "string" },
    idempotent_replay: { type: "boolean", enum: [true] },
    sent: { type: "boolean", enum: [true], description: "Present whenever the provider accepted the message (fresh success, idempotent replay of a sent intent, or a post-send finalization failure): the message WAS sent" },
    provider_message_id: { type: "string", minLength: 1, description: "Provider message id, present whenever the provider accepted the message — including when ledger finalization failed, so the accepted send stays traceable" },
  },
  required: ["message", "provider", "idempotent_replay", "sent", "provider_message_id"],
} as const;

const sendMessageAcceptedResponseSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        message: { $ref: "#/components/schemas/Message" },
        provider: { type: "string" },
        in_progress: { type: "boolean", enum: [true] },
      },
      required: ["message", "provider", "in_progress"],
    },
    {
      type: "object",
      properties: {
        message: { $ref: "#/components/schemas/Message" },
        provider: { type: "string" },
        sent: { type: "boolean", enum: [true] },
        provider_message_id: { type: "string", minLength: 1 },
        warning: {
          type: "string",
          description:
            "Present only when the provider accepted the message but ledger finalization failed; the send must not be retried.",
        },
        retry_safe: {
          type: "boolean",
          enum: [false],
          description: "Present with warning and always false.",
        },
      },
      required: ["message", "provider", "sent", "provider_message_id"],
    },
  ],
} as const;

const messageListItemSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    direction: { type: "string", description: "outbound | inbound" },
    from_addr: { type: "string" },
    to_addrs: { type: "array", items: { type: "string" } },
    cc_addrs: { type: "array", items: { type: "string" } },
    subject: { type: "string", nullable: true },
    snippet: { type: "string", nullable: true, description: "Short text preview (<=140 chars); full bodies are available only from GET /v1/messages/{id}." },
    status: { type: "string" },
    provider_message_id: { type: "string", nullable: true },
    message_id: { type: "string", nullable: true, description: "RFC 5322 Message-ID" },
    in_reply_to: { type: "string", nullable: true },
    received_at: { type: "string", format: "date-time", nullable: true, description: "Original receipt time (inbound)" },
    is_read: { type: "boolean" },
    is_starred: { type: "boolean" },
    labels: { type: "array", items: { type: "string" } },
    attachment_count: { type: "integer", description: "Attachment count; metadata and payloads come from GET /v1/messages/{id} and the attachment endpoints." },
    source_id: { type: "string", nullable: true, description: "Stable upstream id used for idempotent upsert" },
    send_state: { type: "string", description: "none | pending | sending | sent | failed | uncertain | blocked | cancelled" },
    policy_denial: {
      type: "string",
      nullable: true,
      description:
        "Why an outbound policy gate refused this message (e.g. sender_unverified), or null when it was not refused. "
        + "Mirrors headers.policy_denial. Full headers are stripped from list rows for payload size, so without this field "
        + "a send_state of 'blocked' cannot be explained by any list consumer. "
        + "OPTIONAL, unlike its neighbours, and deliberately so: a client that required it would refuse every list response "
        + "from a server older than this field, turning a missing explanation into a total loss of `emails log` / "
        + "`emails email list` across the whole installed base. Absent and null both mean 'no reason available here'; "
        + "read it from GET /v1/messages/{id} headers.policy_denial when a list row omits it. The SERVER's obligation to "
        + "project it is enforced by src/server/self-hosted/policy-denial-visibility.test.ts, not by the wire contract.",
    },
    send_started_at: { type: "string", format: "date-time", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "direction",
    "from_addr",
    "to_addrs",
    "cc_addrs",
    "subject",
    "snippet",
    "status",
    "provider_message_id",
    "message_id",
    "in_reply_to",
    "received_at",
    "is_read",
    "is_starred",
    "labels",
    "attachment_count",
    "source_id",
    "send_state",
    "send_started_at",
    "created_at",
    "updated_at",
  ],
} as const;

const attachmentContentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    filename: { type: "string" },
    content_type: { type: "string", description: "Validated MIME type" },
    size: { type: "integer", minimum: 0, maximum: 26214400 },
    content_base64: { type: "string", description: "Canonical base64; authenticated response only" },
  },
  required: ["filename", "content_type", "size", "content_base64"],
} as const;

const attachmentContentResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: { attachment: { $ref: "#/components/schemas/AttachmentContent" } },
  required: ["attachment"],
} as const;

const attachmentUnavailableErrorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    error: { type: "string" },
    code: { type: "string", enum: ["attachment_content_unavailable"] },
    attachment: {
      type: "object",
      additionalProperties: false,
      properties: {
        filename: { type: "string" },
        content_type: { type: "string" },
        size: { type: "integer", minimum: 0, nullable: true },
      },
      required: ["filename", "content_type", "size"],
    },
  },
  required: ["error", "code", "attachment"],
} as const;

const attachmentInventoryItemSchema = {
  type: "object",
  additionalProperties: false,
  description:
    "One machine-readable attachment-metadata row. Never carries content_base64; payload bytes come from GET /v1/messages/{id}/attachments/{index}.",
  properties: {
    message_id: { type: "string" },
    attachment_index: {
      type: "integer",
      minimum: 0,
      description: "0-based position in the message's attachments array; the stable id accepted by GET /v1/messages/{id}/attachments/{index}.",
    },
    filename: { type: "string", nullable: true },
    content_type: { type: "string", nullable: true },
    size_bytes: { type: "integer", nullable: true, minimum: 0 },
    sha256: { type: "string", nullable: true, description: "Content checksum when stored." },
    content_available: {
      type: "boolean",
      description:
        "True only when stored payload bytes are canonical base64, decode within the server limit, and match a valid declared byte size, so GET /v1/messages/{id}/attachments/{index} can return them; false answers 409 attachment_content_unavailable.",
    },
    direction: { type: "string", nullable: true, enum: ["inbound", "outbound", null] },
    received_at: { type: "string", format: "date-time", nullable: true },
  },
  required: [
    "message_id",
    "attachment_index",
    "filename",
    "content_type",
    "size_bytes",
    "sha256",
    "content_available",
    "direction",
    "received_at",
  ],
} as const;

const attachmentMetaSchema = {
  type: "object",
  additionalProperties: true,
  description:
    "Per-message attachment metadata. Historical rows may be partial, but known fields remain type-checked and content_base64 is excluded.",
  properties: {
    filename: { type: "string", nullable: true },
    content_type: { type: "string", nullable: true },
    size: {
      oneOf: [
        { type: "integer", minimum: 0 },
        { type: "string" },
      ],
      nullable: true,
    },
    sha256: { type: "string", nullable: true },
    content_available: {
      type: "boolean",
      description:
        "True when the authenticated attachment-content route can return bytes, false when metadata exists without retrievable content; omitted by older serves.",
    },
  },
} as const;

const attachmentBatchMetaSchema = {
  type: "object",
  additionalProperties: false,
  description: "Per-message attachment metadata (batch mode). content_base64 is excluded.",
  properties: {
    attachment_index: { type: "integer", minimum: 0 },
    filename: { type: "string", nullable: true },
    content_type: { type: "string", nullable: true },
    size_bytes: { type: "integer", nullable: true, minimum: 0 },
    sha256: { type: "string", nullable: true },
    content_available: {
      type: "boolean",
      description:
        "True only when stored payload bytes are canonical base64, decode within the server limit, and match a valid declared byte size; false for metadata-only or malformed stored payloads.",
    },
  },
  required: [
    "attachment_index",
    "filename",
    "content_type",
    "size_bytes",
    "sha256",
    "content_available",
  ],
} as const;

const attachmentRepairManifestEntrySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object_key: { type: "string", minLength: 1 },
    recipients: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
      description: "Trusted historical envelope-recipient routing evidence.",
    },
    canary_message_ids: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
      description: "Exact complete persisted message-ID set for this one source object.",
    },
  },
  required: ["object_key", "recipients", "canary_message_ids"],
} as const;

const attachmentRepairRequestCommonProperties = {
  idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 25,
    default: 25,
    description: "Maximum manifest entries processed and checkpointed in this request.",
  },
  entries: {
    type: "array",
    minItems: 1,
    maxItems: 200,
    items: attachmentRepairManifestEntrySchema,
  },
} as const;

const attachmentRepairDryRunRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...attachmentRepairRequestCommonProperties,
    apply: { type: "boolean", enum: [false], default: false },
  },
  required: ["idempotency_key", "entries"],
} as const;

const attachmentRepairApplyRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...attachmentRepairRequestCommonProperties,
    apply: { type: "boolean", enum: [true] },
    reviewed_dry_run_id: {
      type: "string",
      format: "uuid",
      description:
        "Exact completed dry-run ledger id reviewed for this tenant and manifest.",
    },
    reviewed_dry_run_result_sha256: {
      type: "string",
      minLength: 64,
      maxLength: 64,
      pattern: "^[0-9a-f]{64}$",
      description:
        "Lowercase SHA-256 of the recursively key-sorted canonical JSON for the reviewed public AttachmentRepairSummary.",
    },
  },
  required: [
    "idempotency_key",
    "apply",
    "entries",
    "reviewed_dry_run_id",
    "reviewed_dry_run_result_sha256",
  ],
} as const;

const attachmentRepairSummarySchema = {
  type: "object",
  additionalProperties: false,
  description:
    "Tenant-scoped checkpoint ledger. inventory_total is the exact count of attachment payloads missing at manifest creation; already-present payloads are excluded. Attachment outcomes satisfy repaired + would_repair + unavailable + pending = inventory_total; entry_* outcomes satisfy the equivalent entry_total invariant. operator_action is the retry- or budget-exhausted subset of unavailable, and retrying is the attempted subset of pending. No source keys, recipients, error details, or payload bytes are returned.",
  properties: {
    id: { type: "string", format: "uuid" },
    apply: { type: "boolean" },
    status: { type: "string", enum: ["pending", "completed"] },
    entry_total: { type: "integer", minimum: 1, maximum: 200 },
    inventory_total: {
      type: "integer",
      minimum: 1,
      description: "Attachment payloads missing at manifest creation.",
    },
    repaired: { type: "integer", minimum: 0 },
    would_repair: { type: "integer", minimum: 0 },
    unavailable: { type: "integer", minimum: 0 },
    operator_action: {
      type: "integer",
      minimum: 0,
      description: "Retry- or budget-exhausted attachment payloads requiring operator action; a subset of unavailable.",
    },
    pending: { type: "integer", minimum: 0 },
    retrying: { type: "integer", minimum: 0 },
    entry_repaired: { type: "integer", minimum: 0 },
    entry_would_repair: { type: "integer", minimum: 0 },
    entry_unavailable: { type: "integer", minimum: 0 },
    entry_operator_action: {
      type: "integer",
      minimum: 0,
      description: "Retry- or budget-exhausted manifest entries requiring operator action; a subset of entry_unavailable.",
    },
    entry_pending: { type: "integer", minimum: 0 },
    entry_retrying: { type: "integer", minimum: 0 },
    attempts: { type: "integer", minimum: 0 },
    checkpoint: { type: "integer", minimum: 0 },
    byte_budget: {
      type: "integer",
      minimum: 1,
      description: "Durable source-byte budget for this repair run.",
    },
    bytes_consumed: {
      type: "integer",
      minimum: 0,
      description: "Source bytes durably charged to this run.",
    },
    time_budget_ms: {
      type: "integer",
      minimum: 1,
      description: "Wall-clock budget assigned when the run was created.",
    },
    deadline_at: { type: "string", format: "date-time" },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    completed_at: { type: "string", format: "date-time", nullable: true },
  },
  required: [
    "id",
    "apply",
    "status",
    "entry_total",
    "inventory_total",
    "repaired",
    "would_repair",
    "unavailable",
    "operator_action",
    "pending",
    "retrying",
    "entry_repaired",
    "entry_would_repair",
    "entry_unavailable",
    "entry_operator_action",
    "entry_pending",
    "entry_retrying",
    "attempts",
    "checkpoint",
    "byte_budget",
    "bytes_consumed",
    "time_budget_ms",
    "deadline_at",
    "created_at",
    "updated_at",
    "completed_at",
  ],
} as const;

const databaseProbeSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    latencyMs: { type: "number", minimum: 0 },
  },
  required: ["ok", "latencyMs"],
} as const;

const healthResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok"] },
    version: { type: "string" },
    mode: { type: "string", enum: ["self_hosted"] },
    name: { type: "string", enum: ["emails"] },
    db: databaseProbeSchema,
  },
  required: ["status", "version", "mode", "name", "db"],
} as const;

function readyResponseSchema(status: "ready" | "not_ready", ok: true | false) {
  return {
    type: "object",
    properties: {
      status: { type: "string", enum: [status] },
      version: { type: "string" },
      mode: { type: "string", enum: ["self_hosted"] },
      db: {
        type: "object",
        properties: {
          ok: { type: "boolean", enum: [ok] },
          latencyMs: { type: "number", minimum: 0 },
        },
        required: ["ok", "latencyMs"],
      },
      pendingMigrations: { type: "array", items: { type: "string" } },
      migrationIssues: { type: "array", items: { type: "string" } },
    },
    required: [
      "status",
      "version",
      "mode",
      "db",
      "pendingMigrations",
      "migrationIssues",
    ],
  } as const;
}

const versionResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok"] },
    version: { type: "string" },
    mode: { type: "string", enum: ["self_hosted"] },
    name: { type: "string", enum: ["emails"] },
  },
  required: ["status", "version", "mode", "name"],
} as const;

const openApiDocumentResponseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    openapi: { type: "string" },
    info: {
      type: "object",
      additionalProperties: true,
      properties: {
        title: { type: "string" },
        version: { type: "string" },
      },
      required: ["title", "version"],
    },
    security: { type: "array", items: { type: "object", additionalProperties: true } },
    paths: { type: "object", additionalProperties: true },
    components: { type: "object", additionalProperties: true },
  },
  required: ["openapi", "info", "security", "paths", "components"],
} as const;

const authProvidersResponseSchema = {
  type: "object",
  properties: {
    google: { type: "boolean", enum: [false] },
    device: { type: "boolean", enum: [false] },
  },
  required: ["google", "device"],
} as const;

const signupResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["verification_required"] },
    email: { type: "string", format: "email" },
    verification_required: trueSchema,
  },
  required: ["status", "email", "verification_required"],
} as const;

const verificationRequiredResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["verification_required"] },
    verification_required: trueSchema,
  },
  required: ["status", "verification_required"],
} as const;

const loginResponseSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        needs_tenant: trueSchema,
        tenants: {
          type: "array",
          minItems: 2,
          items: { $ref: "#/components/schemas/TenantChoice" },
        },
      },
      required: ["needs_tenant", "tenants"],
    },
    {
      type: "object",
      properties: {
        session_token: { type: "string" },
        expires_at: { type: "string", format: "date-time" },
        user: authRouteUserSchema,
        tenant: authRouteTenantSchema,
        role: roleSchema,
      },
      required: ["session_token", "expires_at", "user", "tenant", "role"],
    },
  ],
} as const;

const verifiedEmailResponseSchema = {
  type: "object",
  properties: {
    verified: trueSchema,
    user: authRouteUserSchema,
  },
  required: ["verified", "user"],
} as const;

const passwordResetRequestedResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["reset_requested"] },
  },
  required: ["status"],
} as const;

const passwordResetResponseSchema = {
  type: "object",
  properties: { reset: trueSchema },
  required: ["reset"],
} as const;

const inviteAcceptedResponseSchema = {
  type: "object",
  properties: {
    session_token: { type: "string" },
    expires_at: { type: "string", format: "date-time" },
    user: { $ref: "#/components/schemas/User" },
    tenant: { $ref: "#/components/schemas/Tenant", nullable: true },
    role: roleSchema,
  },
  required: ["session_token", "expires_at", "user", "tenant", "role"],
} as const;

const bootstrapOwnerResponseSchema = {
  type: "object",
  properties: {
    user: authRouteUserSchema,
    tenant: { ...authRouteTenantSchema, nullable: true },
  },
  required: ["user", "tenant"],
} as const;

const bootstrapSuperAdminResponseSchema = {
  type: "object",
  properties: {
    created: { type: "boolean" },
    user: { $ref: "#/components/schemas/User" },
    tenant: { $ref: "#/components/schemas/Tenant", nullable: true },
  },
  required: ["created", "user", "tenant"],
} as const;

const loggedOutResponseSchema = {
  type: "object",
  properties: { logged_out: trueSchema },
  required: ["logged_out"],
} as const;

const tenantSwitchResponseSchema = {
  type: "object",
  properties: {
    session_token: { type: "string" },
    expires_at: { type: "string", format: "date-time" },
    tenant: authRouteTenantSchema,
    role: roleSchema,
  },
  required: ["session_token", "expires_at", "tenant", "role"],
} as const;

const currentPrincipalResponseSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        principal_type: { type: "string", enum: ["apikey"] },
        kid: { type: "string" },
        tenant: authRouteTenantReferenceSchema,
        scopes: { type: "array", items: { type: "string" } },
      },
      required: ["principal_type", "kid", "tenant", "scopes"],
    },
    {
      type: "object",
      properties: {
        principal_type: { type: "string", enum: ["idp"] },
        sub: { type: "string", minLength: 1 },
        tenant: authRouteTenantReferenceSchema,
        scopes: { type: "array", items: { type: "string" } },
      },
      required: ["principal_type", "sub", "tenant", "scopes"],
    },
    {
      type: "object",
      properties: {
        principal_type: { type: "string", enum: ["user"] },
        user: { ...authRouteUserSchema, nullable: true },
        tenant: authRouteTenantReferenceSchema,
        role: roleSchema,
        scopes: { type: "array", items: { type: "string" } },
        memberships: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tenant_id: { type: "string", minLength: 1 },
              slug: { type: "string" },
              name: { type: "string" },
              role: roleSchema,
            },
            required: ["tenant_id", "slug", "name", "role"],
          },
        },
        email_identities: {
          type: "array",
          items: { $ref: "#/components/schemas/EmailIdentity" },
        },
      },
      required: [
        "principal_type",
        "user",
        "tenant",
        "role",
        "scopes",
        "memberships",
        "email_identities",
      ],
    },
  ],
} as const;

const messageCountsSchema = {
  type: "object",
  properties: {
    inbox: { type: "integer", minimum: 0 },
    unread: { type: "integer", minimum: 0 },
    starred: { type: "integer", minimum: 0 },
    sent: { type: "integer", minimum: 0 },
    archived: { type: "integer", minimum: 0 },
    spam: { type: "integer", minimum: 0 },
    trash: { type: "integer", minimum: 0 },
    total: { type: "integer", minimum: 0 },
    latest_received_at: { type: "string", format: "date-time", nullable: true },
  },
  required: [
    "inbox",
    "unread",
    "starred",
    "sent",
    "archived",
    "spam",
    "trash",
    "total",
    "latest_received_at",
  ],
} as const;

// Both are CLAMPED, never rejected (src/server/self-hosted/store.ts clampLimit /
// clampOffset), so a client asking for 1000 silently receives 500. Clients that page a
// window rely on that, so it is documented rather than left to be rediscovered.
const listParams = [
  {
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer" },
    description: "Page size. Clamped to 500 (default 100); a larger value returns 500 rows rather than an error.",
  },
  {
    name: "offset",
    in: "query",
    required: false,
    schema: { type: "integer" },
    description: "Rows to skip. Clamped to 100000; deep paging past that returns the same window rather than an error.",
  },
] as const;

const idParam = [{ name: "id", in: "path", required: true, schema: { type: "string" } }] as const;
const subParam = [{ name: "sub", in: "path", required: true, schema: { type: "string" } }] as const;
const attachmentRepairIdParam = [{
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
}] as const;
const invalidAttachmentRepairIdResponse = {
  description: "Repair id is not a UUID",
  content: {
    "application/json": {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          error: { type: "string" },
          code: { type: "string", enum: ["invalid_attachment_repair_id"] },
        },
        required: ["error", "code"],
      },
    },
  },
} as const;

const invalidAttachmentInventoryQueryResponse = {
  description: "Attachment cursor, direction, since filter, or page limit is invalid",
  content: {
    "application/json": {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          error: { type: "string" },
          code: {
            type: "string",
            enum: ["invalid_cursor", "invalid_direction", "invalid_since", "invalid_limit"],
          },
        },
        required: ["error", "code"],
      },
    },
  },
} as const;

const invalidAttachmentRepairResumeResponse = {
  description: "Repair id is not a UUID, the page limit is invalid, or the request body has unsupported fields",
  content: {
    "application/json": {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          error: { type: "string" },
          code: {
            type: "string",
            enum: [
              "invalid_attachment_repair_id",
              "invalid_repair_limit",
              "invalid_repair_body",
            ],
          },
        },
        required: ["error", "code"],
      },
    },
  },
} as const;

const attachmentRepairNotConfiguredResponse = {
  description: "Canonical attachment-repair source is not configured",
  content: {
    "application/json": {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          error: { type: "string" },
          code: {
            type: "string",
            enum: ["attachment_repair_not_configured"],
          },
        },
        required: ["error", "code"],
      },
    },
  },
} as const;

function resourceColumnSchema(column: ResourceColumn): Record<string, unknown> {
  if (column.bool) return { type: "boolean" };
  if (column.int) return { type: "integer" };
  if (column.num) return { type: "number" };
  if (column.json) return {};
  return { type: "string", nullable: true };
}

function resourceOperationName(path: string): string {
  return path
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
}

const genericResourcePaths: Record<string, Record<string, unknown>> = {};

for (const resource of SELF_HOSTED_RESOURCES) {
  const name = resourceOperationName(resource.path);
  const key = resource.idColumn ?? "id";
  const itemRequired = [
    key,
    "tenant_id",
    ...resource.columns.map((column) => column.name),
    "created_at",
    "updated_at",
  ].filter((value, index, values) => values.indexOf(value) === index);
  const itemSchema = {
    type: "object",
    description: `Tenant-scoped ${resource.path} row.`,
    properties: Object.fromEntries([
      ...resource.columns.map((column) => [column.name, resourceColumnSchema(column)]),
      [key, { type: "string" }],
      ["tenant_id", { type: "string", format: "uuid" }],
      ["created_at", { type: "string", format: "date-time" }],
      ["updated_at", { type: "string", format: "date-time" }],
    ]),
    required: itemRequired,
    // The runtime currently selects physical rows with SELECT *. The registry
    // defines the supported fields, but an operator-owned drifted table may
    // carry additional non-secret columns until the store moves to an explicit
    // projection. Keep this truthful rather than pretending those fields cannot
    // appear; redactColumns still excludes known secret legacy columns.
    additionalProperties: true,
  };
  const bodySchema = {
    type: "object",
    properties: Object.fromEntries(resource.columns.map((column) => [column.name, resourceColumnSchema(column)])),
    additionalProperties: false,
  };
  const queryParameters = [
    ...listParams,
    ...(resource.filters ?? []).map((filter) => ({
      name: filter,
      in: "query",
      required: false,
      schema: resourceColumnSchema(resource.columns.find((column) => column.name === filter) ?? { name: filter }),
    })),
  ];

  genericResourcePaths[`/v1/${resource.path}`] = {
    get: {
      operationId: `listResource${name}`,
      summary: `List tenant-scoped ${resource.path}`,
      parameters: queryParameters,
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { items: { type: "array", items: itemSchema } },
                required: ["items"],
              },
            },
          },
        },
      },
    },
    post: {
      operationId: `createResource${name}`,
      summary: `Create a tenant-scoped ${resource.path} row`,
      requestBody: { required: true, content: { "application/json": { schema: bodySchema } } },
      responses: { "201": { content: { "application/json": { schema: itemSchema } } } },
    },
  };
  genericResourcePaths[`/v1/${resource.path}/{id}`] = {
    get: {
      operationId: `getResource${name}`,
      summary: `Get a tenant-scoped ${resource.path} row`,
      parameters: idParam,
      responses: { "200": { content: { "application/json": { schema: itemSchema } } } },
    },
    patch: {
      operationId: `updateResource${name}`,
      summary: `Update a tenant-scoped ${resource.path} row`,
      parameters: idParam,
      requestBody: { required: true, content: { "application/json": { schema: bodySchema } } },
      responses: { "200": { content: { "application/json": { schema: itemSchema } } } },
    },
    put: {
      operationId: `replaceResource${name}`,
      summary: `Replace mutable fields on a tenant-scoped ${resource.path} row`,
      parameters: idParam,
      requestBody: { required: true, content: { "application/json": { schema: bodySchema } } },
      responses: { "200": { content: { "application/json": { schema: itemSchema } } } },
    },
    delete: {
      operationId: `deleteResource${name}`,
      summary: `Delete a tenant-scoped ${resource.path} row`,
      parameters: idParam,
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                ...deleteReceiptSchema,
              },
            },
          },
        },
      },
    },
  };
}

function operationAt(
  document: EmailsOpenApiDocument,
  path: string,
  method: "get" | "post" | "put" | "patch" | "delete",
): OpenApiOperation {
  const operation = (document.paths?.[path] as Record<string, OpenApiOperation> | undefined)?.[method];
  if (!operation) throw new Error(`OpenAPI routine-error target is missing: ${method.toUpperCase()} ${path}`);
  return operation;
}

function addRoutineError(
  document: EmailsOpenApiDocument,
  path: string,
  method: "get" | "post" | "put" | "patch" | "delete",
  status: number,
  description: string,
  schema: ResponseSchema,
  mode: "merge" | "replace" = "merge",
): void {
  setRoutineErrorResponse(operationAt(document, path, method), status, description, schema, mode);
}

function addRoutineErrorParity(document: EmailsOpenApiDocument): void {
  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operationValue] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!methods.has(method)) continue;
      const operation = operationValue as OpenApiOperation;
      const publicOperation = operation.security?.length === 0;
      const protectedVersionedOperation = path.startsWith("/v1/") && !publicOperation;
      const authHandlerOperation =
        path === "/v1/me"
        || path.startsWith("/v1/me/")
        || path === "/v1/auth"
        || path.startsWith("/v1/auth/")
        || path === "/v1/tenants"
        || path.startsWith("/v1/tenants/")
        || path.startsWith("/v1/memberships/")
        || path === "/v1/invites/accept"
        || path === "/v1/keys"
        || path.startsWith("/v1/keys/")
        || path === "/v1/idp-principals"
        || path.startsWith("/v1/idp-principals/");

      if (protectedVersionedOperation) {
        setRoutineErrorResponse(
          operation,
          401,
          "Authentication failed before the operation ran",
          authenticationRequiredSchema,
          "replace",
        );
        if (operation.operationId === "sendMessage") {
          setRoutineErrorResponse(
            operation,
            403,
            "Authentication, scope, or sender authorization failed",
            anyOfSchemas(
              authorizationRequiredSchema,
              { $ref: "#/components/schemas/SendMessageError" },
            ),
            "replace",
          );
        } else {
          setRoutineErrorResponse(
            operation,
            403,
            "The authenticated principal is not authorized for this operation",
            authorizationRequiredSchema,
            "replace",
          );
        }
        setRoutineErrorResponse(
          operation,
          500,
          "The service failed without exposing internal detail",
          internalErrorSchema,
          "replace",
        );
      } else if (authHandlerOperation && path !== "/v1/auth/providers") {
        setRoutineErrorResponse(
          operation,
          500,
          "The auth service failed without exposing internal detail",
          internalErrorSchema,
          "replace",
        );
      }

      if (operation.requestBody !== undefined) {
        setRoutineErrorResponse(
          operation,
          400,
          "The request body is malformed or fails operation validation",
          invalidRequestBodySchema,
        );
        setRoutineErrorResponse(
          operation,
          413,
          "The JSON request body exceeds the service limit",
          requestBodyTooLargeSchema,
          "replace",
        );
      }
    }
  }

  for (const resource of SELF_HOSTED_RESOURCES) {
    const collection = `/v1/${resource.path}`;
    const item = `${collection}/{id}`;
    const notFound = exactErrorOnlySchema(`${resource.path} not found`);
    for (const method of ["get", "delete"] as const) {
      addRoutineError(document, item, method, 404, `${resource.path} row not found`, notFound, "replace");
    }
    for (const method of ["patch", "put"] as const) {
      addRoutineError(
        document,
        item,
        method,
        404,
        `${resource.path} row or referenced row not found`,
        resource.foreignKeys?.length
          ? anyOfSchemas(notFound, crossTenantReferenceSchema)
          : notFound,
        "replace",
      );
    }
    if (resource.foreignKeys?.length) {
      addRoutineError(
        document,
        collection,
        "post",
        404,
        "A referenced row belongs to another tenant",
        crossTenantReferenceSchema,
        "replace",
      );
    }
  }

  const rateLimitedOperations = [
    ["/v1/auth/signup", "post"],
    ["/v1/auth/verify-email/resend", "post"],
    ["/v1/auth/password/forgot", "post"],
    ["/v1/auth/password/reset", "post"],
    ["/v1/tenants/{id}/invites", "post"],
  ] as const;
  for (const [path, method] of rateLimitedOperations) {
    addRoutineError(document, path, method, 429, "The operation is rate limited", rateLimitedSchema, "replace");
  }
  addRoutineError(
    document,
    "/v1/auth/login",
    "post",
    429,
    "Login is rate limited or the account is temporarily locked",
    anyOfSchemas(rateLimitedSchema, loginLockedSchema),
    "replace",
  );

  for (const [path, method] of [
    ["/v1/auth/signup", "post"],
    ["/v1/invites/accept", "post"],
    ["/v1/auth/bootstrap-super-admin", "post"],
    ["/v1/me/email-identities", "post"],
    ["/v1/me/email-identities/{id}", "delete"],
    ["/v1/me/email-identities/{id}/primary", "post"],
    ["/v1/tenants", "post"],
    ["/v1/tenants/{id}", "patch"],
    ["/v1/tenants/{id}", "put"],
    ["/v1/memberships/{id}", "patch"],
    ["/v1/memberships/{id}", "put"],
    ["/v1/memberships/{id}", "delete"],
  ] as const) {
    addRoutineError(
      document,
      path,
      method,
      409,
      "The requested auth or tenancy state conflicts with durable state",
      closedErrorReasonSchema,
      "replace",
    );
  }

  addRoutineError(
    document,
    "/v1/auth/bootstrap-super-admin",
    "post",
    503,
    "Primary super-admin bootstrap is not configured",
    exactErrorSchema(
      "primary super-admin bootstrap is not configured",
      "bootstrap_not_configured",
    ),
    "replace",
  );

  for (const path of ["/v1/auth/logout", "/v1/auth/logout-all"] as const) {
    addRoutineError(
      document,
      path,
      "post",
      400,
      "The supplied principal is not a user session",
      closedExactErrorSchema("not a session", "not_session"),
      "replace",
    );
  }

  const organizationNotFoundSchema = anyOfSchemas(
    exactErrorOnlySchema("organization not found"),
    closedExactErrorSchema("organization not found", "not_found"),
  );
  addRoutineError(
    document,
    "/v1/auth/switch-tenant",
    "post",
    404,
    "The organization does not exist or is inactive",
    closedExactErrorSchema("organization not found", "not_found"),
    "replace",
  );
  for (const [path, method] of [
    ["/v1/tenants/{id}", "get"],
    ["/v1/tenants/{id}", "patch"],
    ["/v1/tenants/{id}", "put"],
    ["/v1/tenants/{id}", "delete"],
  ] as const) {
    addRoutineError(
      document,
      path,
      method,
      404,
      "The organization does not exist in the caller's scope",
      organizationNotFoundSchema,
      "replace",
    );
  }

  const membershipNotFoundSchema = anyOfSchemas(
    exactErrorOnlySchema("membership not found"),
    closedExactErrorSchema("membership not found", "not_found"),
  );
  for (const method of ["patch", "put", "delete"] as const) {
    addRoutineError(
      document,
      "/v1/memberships/{id}",
      method,
      404,
      "The membership does not exist in the caller's scope",
      membershipNotFoundSchema,
      "replace",
    );
  }

  const keyNotFoundSchema = anyOfSchemas(
    exactErrorOnlySchema("key not found"),
    closedExactErrorSchema("key not found", "not_found"),
  );
  addRoutineError(document, "/v1/keys/{id}", "delete", 404, "Key not found", keyNotFoundSchema, "replace");
  addRoutineError(document, "/v1/keys/{id}/revoke", "post", 404, "Key not found", keyNotFoundSchema, "replace");

  addRoutineError(
    document,
    "/v1/domains",
    "post",
    409,
    "The domain already exists in the tenant or its inbound route is claimed",
    anyOfSchemas(closedErrorOnlySchema, inboundRouteConflictSchema),
    "replace",
  );
  for (const method of ["get", "patch", "put", "delete"] as const) {
    addRoutineError(
      document,
      "/v1/domains/{id}",
      method,
      404,
      "Domain not found",
      exactErrorOnlySchema("domain not found"),
      "replace",
    );
  }
  for (const method of ["patch", "put"] as const) {
    addRoutineError(
      document,
      "/v1/domains/{id}",
      method,
      409,
      "The inbound domain route is already claimed",
      inboundRouteConflictSchema,
      "replace",
    );
  }

  for (const method of ["get", "delete"] as const) {
    addRoutineError(
      document,
      "/v1/addresses/{id}",
      method,
      404,
      "Address not found",
      exactErrorOnlySchema("address not found"),
      "replace",
    );
  }
  for (const method of ["patch", "put"] as const) {
    addRoutineError(
      document,
      "/v1/addresses/{id}",
      method,
      404,
      "Address or referenced owner not found",
      anyOfSchemas(exactErrorOnlySchema("address not found"), crossTenantReferenceSchema),
      "replace",
    );
  }

  addRoutineError(
    document,
    "/v1/messages",
    "get",
    400,
    "A message list query parameter is invalid",
    closedErrorOnlySchema,
    "replace",
  );
  addRoutineError(
    document,
    "/v1/messages",
    "post",
    409,
    "Outbound messages must use the send operation",
    exactErrorOnlySchema("outbound messages must be sent through POST /v1/messages/send"),
    "replace",
  );

  const messageNotFoundSchema = exactErrorOnlySchema("message not found");
  const ambiguousMessageSchema = closedExactErrorSchema(
    "ambiguous message id prefix",
    "ambiguous_id",
  );
  for (const method of ["get", "patch", "put"] as const) {
    addRoutineError(
      document,
      "/v1/messages/{id}",
      method,
      404,
      "Message not found",
      messageNotFoundSchema,
      "replace",
    );
    addRoutineError(
      document,
      "/v1/messages/{id}",
      method,
      409,
      "Message id prefix is ambiguous",
      ambiguousMessageSchema,
      "replace",
    );
  }
  addRoutineError(
    document,
    "/v1/messages/{id}/raw",
    "get",
    404,
    "Message not found",
    messageNotFoundSchema,
    "replace",
  );
  addRoutineError(
    document,
    "/v1/messages/{id}/raw",
    "get",
    409,
    "Message id prefix is ambiguous",
    ambiguousMessageSchema,
    "replace",
  );

  addRoutineError(
    document,
    "/v1/send-keys/mint",
    "post",
    404,
    "The owner belongs to another tenant",
    crossTenantReferenceSchema,
    "replace",
  );
}

export const emailsSelfHostedOpenApi: EmailsOpenApiDocument = {
  openapi: "3.0.3",
  info: { title: "Emails Self-Hosted API", version: "1.0.0" },
  security: [{ apiKeyAuth: [] }, { bearerAuth: [] }],
  paths: {
    ...genericResourcePaths,
    "/health": {
      get: {
        ...publicOperation,
        operationId: "getHealth",
        summary: "Liveness probe with database reachability",
        responses: { "200": { content: { "application/json": { schema: healthResponseSchema } } } },
      },
    },
    "/ready": {
      get: {
        ...publicOperation,
        operationId: "getReady",
        summary: "Readiness probe (reachable and fully migrated)",
        responses: {
          "200": { content: { "application/json": { schema: readyResponseSchema("ready", true) } } },
          "503": { content: { "application/json": { schema: readyResponseSchema("not_ready", false) } } },
        },
      },
    },
    "/version": {
      get: {
        ...publicOperation,
        operationId: "getVersion",
        summary: "Service version and mode",
        responses: { "200": { content: { "application/json": { schema: versionResponseSchema } } } },
      },
    },
    "/openapi.json": {
      get: {
        ...publicOperation,
        operationId: "getOpenApiDocument",
        summary: "Return this OpenAPI document",
        responses: { "200": { content: { "application/json": { schema: openApiDocumentResponseSchema } } } },
      },
    },
    "/v1/openapi.json": {
      get: {
        ...publicOperation,
        operationId: "getVersionedOpenApiDocument",
        summary: "Return this OpenAPI document from the versioned API prefix",
        responses: { "200": { content: { "application/json": { schema: openApiDocumentResponseSchema } } } },
      },
    },
    "/v1/auth/providers": {
      get: {
        ...publicOperation,
        operationId: "listAuthProviders",
        summary: "Report optional self-hosted sign-in providers",
        responses: {
          "200": {
            content: {
              "application/json": { schema: authProvidersResponseSchema },
            },
          },
        },
      },
    },
    "/v1/auth/signup": {
      post: {
        ...publicOperation,
        operationId: "signUp",
        summary: "Create an unverified user and owner membership, then send email verification",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string", format: "password" },
                  name: { type: "string", nullable: true },
                  tenant_name: { type: "string" },
                  tenant_slug: { type: "string", nullable: true },
                },
                required: ["email", "password", "tenant_name"],
              },
            },
          },
        },
        responses: {
          "200": { content: { "application/json": { schema: signupResponseSchema } } },
          "403": jsonResponse(
            "The signup email is outside the configured Hasna address policy",
            signupForbiddenResponseSchema,
          ),
        },
      },
    },
    "/v1/auth/login": {
      post: {
        ...publicOperation,
        operationId: "logIn",
        summary: "Authenticate a verified user and create a tenant-bound session",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string", format: "password" },
                  tenant_slug: { type: "string", nullable: true },
                },
                required: ["email", "password"],
              },
            },
          },
        },
        responses: {
          "200": { content: { "application/json": { schema: loginResponseSchema } } },
          "401": jsonResponse(
            "The supplied credentials are invalid",
            loginUnauthorizedResponseSchema,
          ),
          "403": jsonResponse(
            "The account is not eligible to start a session",
            loginForbiddenResponseSchema,
          ),
        },
      },
    },
    "/v1/auth/verify-email": {
      get: {
        ...publicOperation,
        operationId: "verifyEmailLink",
        summary: "Verify a user email from a query-string token",
        parameters: [{ name: "token", in: "query", required: true, schema: { type: "string" } }],
        responses: {
          "200": { content: { "application/json": { schema: verifiedEmailResponseSchema } } },
          "400": jsonResponse(
            "The verification token is missing, invalid, expired, or already used",
            verifyEmailBadRequestResponseSchema,
          ),
        },
      },
      post: {
        ...publicOperation,
        operationId: "verifyEmailToken",
        summary: "Verify a user email from a JSON token",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] } } },
        },
        responses: {
          "200": { content: { "application/json": { schema: verifiedEmailResponseSchema } } },
          "400": jsonResponse(
            "The verification token is missing, invalid, expired, or already used",
            verifyEmailBadRequestResponseSchema,
          ),
        },
      },
    },
    "/v1/auth/verify-email/resend": {
      post: {
        ...publicOperation,
        operationId: "resendEmailVerification",
        summary: "Request another verification message without revealing account existence",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] } } },
        },
        responses: { "200": { content: { "application/json": { schema: verificationRequiredResponseSchema } } } },
      },
    },
    "/v1/auth/password/forgot": {
      post: {
        ...publicOperation,
        operationId: "requestPasswordReset",
        summary: "Request a password reset without revealing account existence",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] } } },
        },
        responses: { "200": { content: { "application/json": { schema: passwordResetRequestedResponseSchema } } } },
      },
    },
    "/v1/auth/password/reset": {
      post: {
        ...publicOperation,
        operationId: "resetPassword",
        summary: "Consume a password-reset token and revoke existing sessions",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { token: { type: "string" }, new_password: { type: "string", format: "password" } },
                required: ["token", "new_password"],
              },
            },
          },
        },
        responses: { "200": { content: { "application/json": { schema: passwordResetResponseSchema } } } },
      },
    },
    "/v1/invites/accept": {
      post: {
        ...publicOperation,
        operationId: "acceptInvite",
        summary: "Accept an invitation and create a tenant-bound session",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  token: { type: "string" },
                  password: { type: "string", format: "password", nullable: true },
                  name: { type: "string", nullable: true },
                },
                required: ["token"],
              },
            },
          },
        },
        responses: { "200": { content: { "application/json": { schema: inviteAcceptedResponseSchema } } } },
      },
    },
    "/v1/auth/bootstrap-owner": {
      post: {
        operationId: "bootstrapOwner",
        summary: "Create the first tenant owner using a tenant-bound operator API key",
        description: "Migration bridge. User sessions are rejected and the tenant may not already have an owner.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string", format: "password" },
                  name: { type: "string", nullable: true },
                },
                required: ["email", "password"],
              },
            },
          },
        },
        responses: {
          "201": { content: { "application/json": { schema: bootstrapOwnerResponseSchema } } },
          "409": jsonResponse(
            "The tenant already has an owner or the email is already registered",
            bootstrapOwnerConflictResponseSchema,
          ),
        },
      },
    },
    "/v1/auth/bootstrap-super-admin": {
      post: {
        operationId: "bootstrapPrimarySuperAdmin",
        summary: "Idempotently register the configured primary platform super-admin",
        description: "Requires the exact operator API-key KID configured by EMAILS_PRIMARY_SUPER_ADMIN_BOOTSTRAP_KID. The email is pinned by EMAILS_PRIMARY_SUPER_ADMIN_EMAIL and is not itself an authorization mechanism.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string", format: "email", nullable: true },
                  password: { type: "string", format: "password" },
                  name: { type: "string", nullable: true },
                },
                required: ["password"],
              },
            },
          },
        },
        responses: {
          "200": { content: { "application/json": { schema: bootstrapSuperAdminResponseSchema } } },
          "201": { content: { "application/json": { schema: bootstrapSuperAdminResponseSchema } } },
        },
      },
    },
    "/v1/auth/logout": {
      post: {
        operationId: "logOut",
        summary: "Revoke the current user session",
        responses: { "200": { content: { "application/json": { schema: loggedOutResponseSchema } } } },
      },
    },
    "/v1/auth/logout-all": {
      post: {
        operationId: "logOutAll",
        summary: "Revoke every session for the current user",
        responses: { "200": { content: { "application/json": { schema: loggedOutResponseSchema } } } },
      },
    },
    "/v1/auth/switch-tenant": {
      post: {
        operationId: "switchTenant",
        summary: "Rotate the current user session into another tenant membership",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { tenant_slug: { type: "string" } }, required: ["tenant_slug"] } } },
        },
        responses: {
          "200": { content: { "application/json": { schema: tenantSwitchResponseSchema } } },
          "404": jsonResponse(
            "The requested organization does not exist or is inactive",
            switchTenantNotFoundResponseSchema,
          ),
        },
      },
    },
    "/v1/me": {
      get: {
        operationId: "getCurrentPrincipal",
        summary: "Return the authenticated user or API-key principal and active tenant",
        responses: { "200": { content: { "application/json": { schema: currentPrincipalResponseSchema } } } },
      },
    },
    "/v1/me/email-identities": {
      get: {
        operationId: "listEmailIdentities",
        summary: "List all login email identities for the current user",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    email_identities: {
                      type: "array",
                      items: { $ref: "#/components/schemas/EmailIdentity" },
                    },
                  },
                  required: ["email_identities"],
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "addEmailIdentity",
        summary: "Add an email identity and send verification",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] } } },
        },
        responses: {
          "201": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    email_identity: { $ref: "#/components/schemas/EmailIdentity" },
                    verification_required: trueSchema,
                  },
                  required: ["email_identity", "verification_required"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/me/email-identities/{id}": {
      delete: {
        operationId: "removeEmailIdentity",
        summary: "Remove a non-primary email identity",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: removedReceiptSchema } } } },
      },
    },
    "/v1/me/email-identities/{id}/primary": {
      post: {
        operationId: "makePrimaryEmailIdentity",
        summary: "Make a verified email identity primary",
        parameters: [...idParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    email_identity: { $ref: "#/components/schemas/EmailIdentity" },
                  },
                  required: ["email_identity"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/tenants": {
      get: {
        operationId: "listTenants",
        summary: "List the current user's active tenant memberships",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tenants: {
                      type: "array",
                      items: { $ref: "#/components/schemas/TenantMembershipSummary" },
                    },
                  },
                  required: ["tenants"],
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "createTenant",
        summary: "Create a tenant owned by the current user",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" }, slug: { type: "string", nullable: true } },
                required: ["name"],
              },
            },
          },
        },
        responses: {
          "201": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tenant: { $ref: "#/components/schemas/Tenant" },
                    role: roleSchema,
                  },
                  required: ["tenant", "role"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/tenants/{id}": {
      get: {
        operationId: "getTenant",
        parameters: [...idParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tenant: { $ref: "#/components/schemas/Tenant" },
                    role: roleSchema,
                  },
                  required: ["tenant"],
                },
              },
            },
          },
        },
      },
      patch: {
        operationId: "updateTenant",
        parameters: [...idParam],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { name: { type: "string" }, slug: { type: "string" }, status: { type: "string" } } },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { tenant: { $ref: "#/components/schemas/Tenant" } },
                  required: ["tenant"],
                },
              },
            },
          },
        },
      },
      put: {
        operationId: "replaceTenant",
        summary: "Compatibility alias for tenant update",
        parameters: [...idParam],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { name: { type: "string" }, slug: { type: "string" }, status: { type: "string" } } },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { tenant: { $ref: "#/components/schemas/Tenant" } },
                  required: ["tenant"],
                },
              },
            },
          },
        },
      },
      delete: {
        operationId: "suspendTenant",
        summary: "Suspend a tenant; owner role required",
        parameters: [...idParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    suspended: trueSchema,
                    id: { type: "string", format: "uuid" },
                  },
                  required: ["suspended", "id"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/tenants/{id}/members": {
      get: {
        operationId: "listTenantMembers",
        summary: "List tenant memberships; owner or admin role required",
        parameters: [...idParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    members: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Membership" },
                    },
                  },
                  required: ["members"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/tenants/{id}/invites": {
      get: {
        operationId: "listTenantInvites",
        summary: "List outstanding tenant invitations; owner or admin role required",
        parameters: [...idParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    invites: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Invitation" },
                    },
                  },
                  required: ["invites"],
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "createTenantInvite",
        summary: "Invite a user; only an owner may grant the owner role",
        parameters: [...idParam],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string", format: "email" },
                  role: { type: "string", enum: ["owner", "admin", "member"] },
                },
                required: ["email"],
              },
            },
          },
        },
        responses: {
          "201": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    invited: trueSchema,
                    email: { type: "string", format: "email" },
                    role: { type: "string", enum: ["owner", "admin", "member"] },
                    expires_at: { type: "string", format: "date-time" },
                  },
                  required: ["invited", "email", "role", "expires_at"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/memberships/{id}": {
      patch: {
        operationId: "updateMembership",
        summary: "Change a membership role under owner/admin role gates",
        parameters: [...idParam],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { role: { type: "string", enum: ["owner", "admin", "member", "viewer"] } },
                required: ["role"],
              },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    membership: { $ref: "#/components/schemas/MembershipSummary" },
                  },
                  required: ["membership"],
                },
              },
            },
          },
        },
      },
      put: {
        operationId: "replaceMembership",
        summary: "Compatibility alias for membership role update",
        parameters: [...idParam],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { role: { type: "string", enum: ["owner", "admin", "member", "viewer"] } },
                required: ["role"],
              },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    membership: { $ref: "#/components/schemas/MembershipSummary" },
                  },
                  required: ["membership"],
                },
              },
            },
          },
        },
      },
      delete: {
        operationId: "removeMembership",
        summary: "Remove a tenant membership under owner/admin role gates",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: removedReceiptSchema } } } },
      },
    },
    "/v1/keys": {
      get: {
        operationId: "listTenantKeys",
        summary: "List tenant API-key metadata; owner or admin user session required",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    keys: {
                      type: "array",
                      items: tenantKeyListItemSchema,
                    },
                  },
                  required: ["keys"],
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "createTenantKey",
        summary: "Mint a tenant API key; plaintext token is returned once",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  scopes: { type: "array", items: { type: "string" } },
                  ttl_days: { type: "number", nullable: true },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: { type: "string" },
                    kid: { type: "string" },
                    scopes: { type: "array", items: { type: "string" } },
                    expires_at: { type: "string", format: "date-time", nullable: true },
                  },
                  required: ["token", "kid", "scopes", "expires_at"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/keys/{id}": {
      delete: {
        operationId: "revokeTenantKey",
        summary: "Revoke a tenant API key; owner or admin user session required",
        parameters: [...idParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    revoked: trueSchema,
                    kid: { type: "string" },
                  },
                  required: ["revoked", "kid"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/keys/{id}/revoke": {
      post: {
        operationId: "revokeTenantKeyByPost",
        summary: "Compatibility route for revoking a tenant API key",
        parameters: [...idParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    revoked: trueSchema,
                    kid: { type: "string" },
                  },
                  required: ["revoked", "kid"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/idp-principals": {
      get: {
        operationId: "listIdpPrincipals",
        summary: "List this tenant's IdP-principal federation grants (revoked included); tenant operator required",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    idp_principals: {
                      type: "array",
                      items: idpPrincipalGrantSchema,
                    },
                  },
                  required: ["idp_principals"],
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "grantIdpPrincipal",
        summary: "Grant an IdP principal (sub) access to the caller's tenant; a re-grant never un-revokes",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  sub: { type: "string" },
                  idp_tid: { type: "string", nullable: true },
                  principal_type: { type: "string", enum: ["user", "service"] },
                  note: { type: "string", nullable: true },
                },
                required: ["sub"],
              },
            },
          },
        },
        responses: {
          "201": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    grant: idpPrincipalGrantSchema,
                    warning: { type: "string" },
                  },
                  required: ["grant"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/idp-principals/{sub}": {
      delete: {
        operationId: "revokeIdpPrincipal",
        summary: "Throw the emails-side kill switch on a federation grant; tenant operator required",
        parameters: [...subParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    revoked: trueSchema,
                    sub: { type: "string" },
                  },
                  required: ["revoked", "sub"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/idp-principals/{sub}/revoke": {
      post: {
        operationId: "revokeIdpPrincipalByPost",
        summary: "Compatibility verb for revoking a federation grant",
        parameters: [...subParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    revoked: trueSchema,
                    sub: { type: "string" },
                  },
                  required: ["revoked", "sub"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/idp-principals/{sub}/restore": {
      post: {
        operationId: "restoreIdpPrincipal",
        summary: "Deliberately lift the kill switch on one federation grant; tenant operator required",
        parameters: [...subParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    restored: trueSchema,
                    sub: { type: "string" },
                  },
                  required: ["restored", "sub"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/domains": {
      get: {
        operationId: "listDomains",
        summary: "List sending domains",
        parameters: [...listParams],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    domains: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Domain" },
                    },
                  },
                  required: ["domains"],
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "createDomain",
        summary: "Register a sending domain (scope emails:write)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  domain: { type: "string" },
                  status: { type: "string" },
                  provider: { type: "string", nullable: true },
                  verified: { type: "boolean" },
                  notes: { type: "string", nullable: true },
                },
                required: ["domain"],
              },
            },
          },
        },
        responses: {
          "201": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { domain: { $ref: "#/components/schemas/Domain" } },
                  required: ["domain"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/domains/{id}": {
      get: {
        operationId: "getDomain",
        parameters: [...idParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { domain: { $ref: "#/components/schemas/Domain" } },
                  required: ["domain"],
                },
              },
            },
          },
        },
      },
      patch: {
        operationId: "updateDomain",
        parameters: [...idParam],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { status: { type: "string" }, provider: { type: "string", nullable: true }, verified: { type: "boolean" }, notes: { type: "string", nullable: true }, ...domainProvisioningProps },
              },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { domain: { $ref: "#/components/schemas/Domain" } },
                  required: ["domain"],
                },
              },
            },
          },
        },
      },
      put: {
        operationId: "replaceDomain",
        parameters: [...idParam],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { status: { type: "string" }, provider: { type: "string", nullable: true }, verified: { type: "boolean" }, notes: { type: "string", nullable: true }, ...domainProvisioningProps },
              },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { domain: { $ref: "#/components/schemas/Domain" } },
                  required: ["domain"],
                },
              },
            },
          },
        },
      },
      delete: {
        operationId: "deleteDomain",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: deleteReceiptSchema } } } },
      },
    },
    "/v1/addresses": {
      get: {
        operationId: "listAddresses",
        parameters: [...listParams],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    addresses: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Address" },
                    },
                  },
                  required: ["addresses"],
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "createAddress",
        summary: "Register an email address (scope emails:write)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { email: { type: "string" }, display_name: { type: "string", nullable: true }, status: { type: "string" } }, required: ["email"] },
            },
          },
        },
        responses: {
          "201": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { address: { $ref: "#/components/schemas/Address" } },
                  required: ["address"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/addresses/{id}": {
      get: {
        operationId: "getAddress",
        parameters: [...idParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { address: { $ref: "#/components/schemas/Address" } },
                  required: ["address"],
                },
              },
            },
          },
        },
      },
      patch: {
        operationId: "updateAddress",
        parameters: [...idParam],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { display_name: { type: "string", nullable: true }, status: { type: "string" }, verified: { type: "boolean" }, daily_quota: { type: "integer", nullable: true }, ...addressProvisioningProps } } } } },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { address: { $ref: "#/components/schemas/Address" } },
                  required: ["address"],
                },
              },
            },
          },
        },
      },
      put: {
        operationId: "replaceAddress",
        parameters: [...idParam],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { display_name: { type: "string", nullable: true }, status: { type: "string" }, verified: { type: "boolean" }, daily_quota: { type: "integer", nullable: true }, ...addressProvisioningProps } } } } },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { address: { $ref: "#/components/schemas/Address" } },
                  required: ["address"],
                },
              },
            },
          },
        },
      },
      delete: {
        operationId: "deleteAddress",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: deleteReceiptSchema } } } },
      },
    },
    "/v1/messages": {
      get: {
        operationId: "listMessages",
        parameters: [
          ...listParams,
          { name: "cursor", in: "query", required: false, schema: { type: "string" }, description: "Opaque keyset cursor from a previous page's next_cursor. Takes precedence over offset; pages are ordered by (received_at || created_at, id) descending." },
          { name: "direction", in: "query", required: false, schema: { type: "string", enum: ["inbound", "outbound"] } },
          { name: "folder", in: "query", required: false, schema: { type: "string", enum: ["inbox", "starred", "sent", "archived", "spam", "trash"] }, description: "Server-side folder filter; same semantics as /v1/messages/groups counts." },
          { name: "domain", in: "query", required: false, explode: true, schema: { type: "array", items: { type: "string" } }, description: "Repeatable. Only messages with a to/cc recipient at one of these domains." },
          { name: "to", in: "query", required: false, schema: { type: "string" } },
          { name: "from", in: "query", required: false, schema: { type: "string" } },
          { name: "subject", in: "query", required: false, schema: { type: "string" } },
          { name: "q", in: "query", required: false, schema: { type: "string" }, description: "Substring search over from/to/subject/body AND attachment filename/content_type (alias of search)." },
          { name: "search", in: "query", required: false, schema: { type: "string" }, description: "Substring search over from/to/subject/body AND attachment filename/content_type." },
          { name: "since", in: "query", required: false, schema: { type: "string", format: "date-time" } },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    messages: {
                      type: "array",
                      items: { $ref: "#/components/schemas/MessageListItem" },
                    },
                    next_cursor: {
                      type: "string",
                      nullable: true,
                      description: "Cursor for the next page; null when this page is the last.",
                    },
                  },
                  required: ["messages", "next_cursor"],
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "createMessage",
        summary:
          "Import an inbound message. Supplying source_id makes the write idempotent. Scope emails:write.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  from: { type: "string" },
                  to: { type: "array", items: { type: "string" } },
                  cc: { type: "array", items: { type: "string" } },
                  subject: { type: "string", nullable: true },
                  text: { type: "string", nullable: true },
                  html: { type: "string", nullable: true },
                  status: { type: "string" },
                  direction: { type: "string", enum: ["inbound"] },
                  received_at: { type: "string", format: "date-time", nullable: true },
                  message_id: { type: "string", nullable: true },
                  in_reply_to: { type: "string", nullable: true },
                  is_read: { type: "boolean" },
                  is_starred: { type: "boolean" },
                  labels: { type: "array", items: { type: "string" } },
                  headers: { type: "object", additionalProperties: true },
                  attachments: { type: "array", items: { type: "object", additionalProperties: true } },
                  provider_message_id: { type: "string", nullable: true },
                  source_id: { type: "string", description: "Stable upstream id; enables idempotent upsert" },
                },
                required: ["from", "to", "direction"],
              },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { message: { $ref: "#/components/schemas/Message" } },
                  required: ["message"],
                },
              },
            },
          },
          "201": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { message: { $ref: "#/components/schemas/Message" } },
                  required: ["message"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/messages/counts": {
      get: {
        operationId: "getMessageCounts",
        summary: "Return server-side mailbox counts",
        parameters: [
          { name: "domain", in: "query", required: false, explode: true, schema: { type: "array", items: { type: "string" } }, description: "Repeatable. Scope counts to mail with a to/cc recipient at one of these domains." },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    counts: { $ref: "#/components/schemas/MessageCounts" },
                  },
                  required: ["counts"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/messages/groups": {
      get: {
        operationId: "getMessageGroups",
        summary: "Folder counts, flat at the top level (native-client shape); same data as /v1/messages/counts",
        parameters: [
          { name: "domain", in: "query", required: false, explode: true, schema: { type: "array", items: { type: "string" } }, description: "Repeatable. Scope counts to mail with a to/cc recipient at one of these domains." },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/MessageCounts" },
              },
            },
          },
        },
      },
    },
    "/v1/messages/threads": {
      get: {
        operationId: "listThreads",
        summary: "Mail-view: subject-rolled-up conversation list (newest activity first)",
        parameters: [...listParams],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    threads: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Thread" },
                    },
                  },
                  required: ["threads"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/messages/send": {
      post: {
        operationId: "sendMessage",
        summary: "Send through the configured SES or Resend provider and persist the resulting ledger row",
        description: "Tenant API keys and owner/admin user sessions have tenant-wide send authority. Member sessions must supply a sender-scoped send_key authorized for the registered From address. Viewer sessions cannot send.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  from: { type: "string" },
                  to: { type: "array", items: { type: "string" } },
                  cc: { type: "array", items: { type: "string" } },
                  bcc: { type: "array", items: { type: "string" } },
                  reply_to: { type: "string" },
                  subject: { type: "string" },
                  text: { type: "string" },
                  html: { type: "string" },
                  attachments: {
                    type: "array",
                    maxItems: 5,
                    items: {
                      type: "object",
                      properties: {
                        filename: {
                          type: "string",
                          default: "attachment-{n}",
                          description:
                            "Defaults to `attachment-{n}` where n is the 1-based attachment index when omitted.",
                        },
                        content: { type: "string", description: "Base64-encoded attachment content" },
                        content_type: { type: "string", default: "application/octet-stream", description: "Defaults to application/octet-stream when omitted." },
                      },
                      required: ["content"],
                    },
                  },
                  send_key: {
                    type: "string",
                    description: "Sender-scoped key required for member sessions; optional for tenant API keys and owner/admin sessions.",
                  },
                  idempotency_key: { type: "string", maxLength: 200 },
                },
                required: ["from", "to", "subject", "idempotency_key"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Completed idempotent replay of an existing sent intent",
            content: {
              "application/json": {
                schema: sendMessageReplayResponseSchema,
              },
            },
          },
          "202": {
            description: "Newly accepted send or an existing send still in progress",
            content: { "application/json": { schema: sendMessageAcceptedResponseSchema } },
          },
          "400": errorResponse("Invalid send request"),
          "401": errorResponse("Authentication required"),
          "403": errorResponse("Sender or tenant scope is not authorized"),
          "409": { content: { "application/json": { schema: { $ref: "#/components/schemas/SendMessageError" } } } },
          "422": {
            description: "The provider definitively rejected the message (nothing was sent); the body carries the real provider error and sent:false",
            content: { "application/json": { schema: { $ref: "#/components/schemas/SendMessageError" } } },
          },
          "429": errorResponse("Tenant or sender quota exceeded"),
          "413": errorResponse("Request body exceeds the service limit"),
          "503": {
            description: "A rejected intent could not be re-armed for retry (sent: false — nothing was sent); safe to retry later",
            content: { "application/json": { schema: { $ref: "#/components/schemas/SendMessageError" } } },
          },
          "502": {
            description: "The provider call ended without a definitive outcome (sent: null); reconcile before retrying",
            content: { "application/json": { schema: providerOutcomeUncertainErrorSchema } },
          },
        },
      },
    },
    "/v1/messages/send-intents/lookup": {
      post: {
        operationId: "lookupSendIntent",
        summary: "Look up a tenant-scoped send intent without sending",
        requestBody: {
          required: true,
          content: { "application/json": { schema: idempotencyKeyRequestSchema } },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { send_intent: { $ref: "#/components/schemas/SendIntentLookup" } },
                  required: ["send_intent"],
                },
              },
            },
          },
          "400": errorResponse("Invalid idempotency key"),
          "401": errorResponse("Authentication required"),
          "403": errorResponse("Tenant read scope is not authorized"),
          "413": errorResponse("Request body exceeds the service limit"),
        },
      },
    },
    "/v1/messages/send-intents/uncertain": {
      get: {
        operationId: "listUncertainSendIntents",
        summary: "List send intents whose provider outcome was never established",
        description:
          "Outbound messages stuck in send_state='uncertain'. These are the only messages whose delivery is unknown; "
          + "everything else is a proven send or a proven non-send.",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "offset", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    uncertain: { type: "array", items: { $ref: "#/components/schemas/Message" } },
                    count: { type: "integer" },
                  },
                  required: ["uncertain", "count"],
                },
              },
            },
          },
          "401": errorResponse("Authentication required"),
          "403": errorResponse("Tenant read scope is not authorized"),
        },
      },
    },
    "/v1/messages/send-intents/reconcile": {
      post: {
        operationId: "reconcileSendIntent",
        summary: "Close out one uncertain send intent against operator evidence",
        description:
          "Records the TRUE outcome of a message whose provider result was never observed. Only an 'uncertain' intent "
          + "may be reconciled; a proven outcome is never overwritten. Reconciling as 'sent' requires the provider "
          + "message id that proves the message left.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  message_id: { type: "string" },
                  outcome: { type: "string", enum: ["sent", "not_sent"] },
                  provider_message_id: { type: "string", nullable: true },
                  evidence: { type: "string", description: "What proves this outcome. Persisted on the row." },
                },
                required: ["message_id", "outcome", "evidence"],
              },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    reconciled: { type: "boolean", enum: [true] },
                    outcome: { type: "string", enum: ["sent", "not_sent"] },
                    message: { $ref: "#/components/schemas/Message" },
                  },
                  required: ["reconciled", "outcome", "message"],
                },
              },
            },
          },
          "400": errorResponse("Missing message_id/outcome/evidence, or provider_message_id for a 'sent' outcome"),
          "401": errorResponse("Authentication required"),
          "403": errorResponse("Tenant write scope is not authorized"),
          "404": errorResponse("Message not found"),
          "409": errorResponse("The send intent is not (or is no longer) uncertain"),
          "413": errorResponse("Request body exceeds the service limit"),
        },
      },
    },
    "/v1/messages/send-intents/cancel": {
      post: {
        operationId: "cancelSendIntent",
        summary: "Tombstone a tenant-scoped send intent before provider delivery",
        requestBody: {
          required: true,
          content: { "application/json": { schema: idempotencyKeyRequestSchema } },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { cancellation: { $ref: "#/components/schemas/SendIntentCancellation" } },
                  required: ["cancellation"],
                },
              },
            },
          },
          "400": errorResponse("Invalid idempotency key"),
          "401": errorResponse("Authentication required"),
          "403": errorResponse("Tenant write scope is not authorized"),
          "413": errorResponse("Request body exceeds the service limit"),
        },
      },
    },
    // Record a message row without dispatching it. The counterpart of POST
    // /v1/messages (inbound import only, 409 otherwise) and of POST /v1/messages/send
    // (records AND transmits): this one is the only way to get an outbound row into the
    // ledger without invoking a provider, and it refuses every send-ledger field so a
    // row written here can never be confused with one the send fence produced.
    "/v1/messages/record": {
      post: {
        operationId: "recordMessage",
        summary:
          "Record a message in either direction WITHOUT sending it. Supplying source_id makes the write idempotent. Scope emails:write.",
        description:
          "Persists a message row and transmits nothing. Unlike POST /v1/messages this accepts direction=outbound, and unlike POST /v1/messages/send it never invokes the configured provider. The four send-ledger fields (idempotency_key, send_payload_hash, send_state, send_started_at) are rejected with 400 send_ledger_field: only POST /v1/messages/send may write them.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  from: { type: "string" },
                  to: { type: "array", items: { type: "string" } },
                  cc: { type: "array", items: { type: "string" } },
                  subject: { type: "string", nullable: true },
                  text: { type: "string", nullable: true },
                  html: { type: "string", nullable: true },
                  status: { type: "string" },
                  direction: {
                    type: "string",
                    enum: ["inbound", "outbound"],
                    description:
                      "Defaults to inbound when received_at, message_id or in_reply_to is present, and to outbound otherwise.",
                  },
                  received_at: { type: "string", format: "date-time", nullable: true },
                  message_id: { type: "string", nullable: true },
                  in_reply_to: { type: "string", nullable: true },
                  is_read: { type: "boolean" },
                  is_starred: { type: "boolean" },
                  labels: { type: "array", items: { type: "string" } },
                  headers: { type: "object", additionalProperties: true },
                  attachments: { type: "array", items: { type: "object", additionalProperties: true } },
                  provider_message_id: { type: "string", nullable: true },
                  source_id: {
                    type: "string",
                    description:
                      "Stable upstream id; enables idempotent upsert. A replay writes only the fields the body carries, so local read/star/label state survives it.",
                  },
                },
                required: ["from", "to"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The source_id matched an existing row, which was updated",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { message: { $ref: "#/components/schemas/Message" } },
                  required: ["message"],
                },
              },
            },
          },
          "201": {
            description: "A new row was recorded",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { message: { $ref: "#/components/schemas/Message" } },
                  required: ["message"],
                },
              },
            },
          },
          // Declared explicitly because this route's 400 can carry a `reason`, and the
          // routine 400 the parity pass injects for every route with a request body is
          // the CLOSED `{ error }` shape. Without this the service's own response would
          // fail the generated wire contract.
          "400": jsonResponse(
            "The body is malformed, omits from/to, carries a direction that is neither inbound nor outbound, or names a send-ledger field",
            closedErrorReasonSchema,
          ),
        },
      },
    },
    "/v1/messages/{id}": {
      get: {
        operationId: "getMessage",
        parameters: [...idParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { message: { $ref: "#/components/schemas/Message" } },
                  required: ["message"],
                },
              },
            },
          },
          "404": errorResponse("Message not found"),
          "409": errorResponse("Message id prefix is ambiguous"),
        },
      },
      patch: {
        operationId: "updateMessage",
        parameters: [...idParam],
        requestBody: { content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { status: { type: "string" }, provider_message_id: { type: "string", nullable: true }, is_read: { type: "boolean" }, is_starred: { type: "boolean" }, archived: { type: "boolean" }, add_label: { type: "string" }, remove_label: { type: "string" }, body_text: { type: "string", nullable: true }, body_html: { type: "string", nullable: true }, headers: { type: "object", additionalProperties: true } } } } } },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { message: { $ref: "#/components/schemas/Message" } },
                  required: ["message"],
                },
              },
            },
          },
          "400": errorResponse("Unknown or malformed message patch field"),
        },
      },
      put: {
        operationId: "replaceMessage",
        parameters: [...idParam],
        requestBody: { content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { status: { type: "string" }, provider_message_id: { type: "string", nullable: true }, is_read: { type: "boolean" }, is_starred: { type: "boolean" }, archived: { type: "boolean" }, add_label: { type: "string" }, remove_label: { type: "string" }, body_text: { type: "string", nullable: true }, body_html: { type: "string", nullable: true }, headers: { type: "object", additionalProperties: true } } } } } },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { message: { $ref: "#/components/schemas/Message" } },
                  required: ["message"],
                },
              },
            },
          },
          "400": errorResponse("Unknown or malformed message patch field"),
        },
      },
      delete: {
        operationId: "deleteMessage",
        parameters: [...idParam],
        responses: {
          "200": { content: { "application/json": { schema: deleteReceiptSchema } } },
          "401": errorResponse("Authentication required"),
          "403": errorResponse("Tenant write scope is not authorized"),
          "404": errorResponse("Message not found"),
          "409": {
            description: "Durable send-intent ledger rows cannot be deleted",
            content: { "application/json": { schema: { $ref: "#/components/schemas/SendMessageError" } } },
          },
        },
      },
    },
    "/v1/messages/{id}/attachments/{index}": {
      get: {
        operationId: "getMessageAttachment",
        parameters: [
          { name: "id", in: "path", required: true, description: "Exact full message ID; prefixes are rejected for attachment content", schema: { type: "string" } },
          { name: "index", in: "path", required: true, schema: { type: "integer", minimum: 0 } },
          { name: "max_bytes", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 26214400 } },
        ],
        responses: {
          "200": { content: { "application/json": { schema: attachmentContentResponseSchema } } },
          "400": errorResponse("Invalid max_bytes attachment byte limit"),
          "404": errorResponse("Message or attachment index not found"),
          "409": {
            description: "Attachment metadata exists but its content is not stored",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AttachmentUnavailableError" },
              },
            },
          },
          "413": errorResponse("Attachment exceeds the requested or service byte limit"),
          "422": errorResponse("Stored attachment payload is malformed"),
        },
      },
    },
    "/v1/attachments": {
      get: {
        operationId: "listAttachments",
        summary:
          "Read-only, tenant-scoped, keyset-paginated attachment-METADATA inventory across all messages. Exact-once and resumable via the opaque cursor; never returns content_base64. Scope emails:read.",
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500 }, description: "Page size (default 100). Noncanonical or out-of-range values are rejected." },
          { name: "cursor", in: "query", required: false, schema: { type: "string" }, description: "Opaque keyset cursor from a previous page's next_cursor. Order is (sort_ts DESC, message_id DESC, attachment_index ASC); one attachment row is the finest resumable unit." },
          { name: "direction", in: "query", required: false, schema: { type: "string", enum: ["inbound", "outbound"] } },
          { name: "since", in: "query", required: false, schema: { type: "string", format: "date-time" }, description: "Only attachments on messages received/created at or after this instant." },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    items: { type: "array", items: { $ref: "#/components/schemas/AttachmentInventoryItem" } },
                    next_cursor: { type: "string", nullable: true, description: "Cursor for the next page; null when this page is the last." },
                  },
                  required: ["items", "next_cursor"],
                },
              },
            },
          },
          "400": {
            description: "Malformed cursor, invalid since filter, invalid direction, or invalid limit",
            content: invalidAttachmentInventoryQueryResponse.content,
          },
        },
      },
    },
    "/v1/attachments/batch": {
      post: {
        operationId: "batchAttachments",
        summary:
          "Return attachment metadata for an explicit, bounded list of message IDs, keyed by message_id, so a large exact-once scan can checkpoint per batch. Read-only (scope emails:read); at most 200 ids per request.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200, description: "1..200 message ids." },
                },
                required: ["message_ids"],
              },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    by_message_id: {
                      type: "object",
                      additionalProperties: {
                        type: "array",
                        items: { $ref: "#/components/schemas/AttachmentBatchMeta" },
                      },
                      description: "Attachment metadata keyed by message_id (only ids resolvable in this tenant).",
                    },
                    unknown_ids: { type: "array", items: { type: "string" }, description: "Requested ids not found in this tenant (nonexistent or foreign)." },
                    max_batch_size: { type: "integer" },
                  },
                  required: ["by_message_id", "unknown_ids", "max_batch_size"],
                },
              },
            },
          },
          "400": errorResponse("message_ids missing, empty, malformed, or over the 200-id batch limit"),
        },
      },
    },
    "/v1/attachments/repairs": {
      post: {
        operationId: "createOrResumeAttachmentRepair",
        summary:
          "Create an idempotent bounded legacy attachment-repair manifest and process one checkpointed page.",
        description:
          "Requires a tenant owner or admin session, or an operator API key with emails:* scope. Dry-run is the default and rejects apply-proof fields. apply:true requires the exact reviewed dry-run id and its lowercase canonical result SHA-256. Before an apply ledger is created, the service proves that tenant-scoped dry run is completed with zero pending, retrying, unavailable, or operator-action item and entry totals, then checks the exact current manifest and deployment-owned canonical bucket against the reviewed dry-run ledger without creating or replaying a dry-run ledger. Review mismatches return a generic non-leaking 409 and never create or process an apply run. At manifest creation every exact canary must resolve in the authenticated tenant to the declared canonical object and have a non-empty repairable attachment inventory. This endpoint never lists a bucket and never returns source keys, recipients, or payload bytes.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  attachmentRepairDryRunRequestSchema,
                  attachmentRepairApplyRequestSchema,
                ],
              },
            },
          },
        },
        responses: {
          "201": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    repair: { $ref: "#/components/schemas/AttachmentRepairSummary" },
                    max_page_size: { type: "integer", enum: [25] },
                  },
                  required: ["repair", "max_page_size"],
                },
              },
            },
          },
          "400": {
            description:
              "Malformed, empty, duplicate, or over-limit manifest, invalid page limit, malformed or ambiguous reviewed dry-run proof, or unsupported top-level request fields",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    error: { type: "string" },
                    code: {
                      type: "string",
                      enum: [
                        "invalid_idempotency_key",
                        "invalid_apply",
                        "invalid_repair_manifest",
                        "invalid_repair_limit",
                        "invalid_repair_body",
                        "invalid_repair_review",
                      ],
                    },
                  },
                  required: ["error", "code"],
                },
              },
            },
          },
          "401": errorResponse("Authentication required"),
          "403": errorResponse("Tenant operator authorization is required"),
          "409": {
            description:
              "The idempotency key belongs to another immutable manifest, or the reviewed dry-run proof does not exactly match this tenant and current manifest",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    error: { type: "string" },
                    code: {
                      type: "string",
                      enum: [
                        "attachment_repair_idempotency_conflict",
                        "attachment_repair_review_mismatch",
                      ],
                    },
                  },
                  required: ["error", "code"],
                },
              },
            },
          },
          "429": {
            description: "The tenant's active or durable repair-ledger quota is exhausted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    error: { type: "string" },
                    code: { type: "string", enum: ["attachment_repair_quota_exceeded"] },
                    quota: {
                      type: "string",
                      enum: ["active_runs", "ledger_runs", "ledger_entries"],
                    },
                    retryable: { type: "boolean" },
                  },
                  required: ["error", "code", "quota", "retryable"],
                },
              },
            },
          },
          "503": attachmentRepairNotConfiguredResponse,
        },
      },
    },
    "/v1/attachments/repairs/{id}": {
      get: {
        operationId: "getAttachmentRepair",
        summary: "Read one tenant-scoped repair checkpoint and reconciled totals.",
        description:
          "Requires a tenant owner or admin session, or an operator API key with emails:* scope.",
        parameters: [...attachmentRepairIdParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    repair: { $ref: "#/components/schemas/AttachmentRepairSummary" },
                  },
                  required: ["repair"],
                },
              },
            },
          },
          "400": invalidAttachmentRepairIdResponse,
          "401": errorResponse("Authentication required"),
          "403": errorResponse("Tenant operator authorization is required"),
          "404": errorResponse("Run does not exist in the authenticated tenant"),
        },
      },
    },
    "/v1/attachments/repairs/{id}/resume": {
      post: {
        operationId: "resumeAttachmentRepair",
        summary: "Resume one bounded page from the first unfinished checkpoint.",
        description:
          "Requires a tenant owner or admin session, or an operator API key with emails:* scope.",
        parameters: [...attachmentRepairIdParam],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  limit: { type: "integer", minimum: 1, maximum: 25, default: 25 },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    repair: { $ref: "#/components/schemas/AttachmentRepairSummary" },
                    max_page_size: { type: "integer", enum: [25] },
                  },
                  required: ["repair", "max_page_size"],
                },
              },
            },
          },
          "400": invalidAttachmentRepairResumeResponse,
          "401": errorResponse("Authentication required"),
          "403": errorResponse("Tenant operator authorization is required"),
          "404": errorResponse("Run does not exist in the authenticated tenant"),
          "503": attachmentRepairNotConfiguredResponse,
        },
      },
    },
    "/v1/messages/{id}/raw": {
      get: {
        operationId: "getMessageRaw",
        summary: "Mail-view: reconstructed raw MIME for a stored message",
        parameters: [...idParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    raw: { type: "string" },
                    message_id: { type: "string", nullable: true },
                  },
                  required: ["raw", "message_id"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/mailboxes": {
      get: {
        operationId: "listMailboxes",
        summary: "Mail-view: registered addresses as mailboxes plus global folder counts",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    mailboxes: { type: "array", items: { $ref: "#/components/schemas/Mailbox" } },
                    counts: { $ref: "#/components/schemas/MessageCounts" },
                  },
                  required: ["mailboxes", "counts"],
                },
              },
            },
          },
        },
      },
    },
    // Bespoke scoped-send-key endpoints. These are NOT part of the generic
    // resource CRUD: the token and its hash live only on the server, so minting
    // and verification are dedicated routes (the /v1/send-keys resource itself is
    // summary-only and never returns a hash).
    "/v1/send-keys/mint": {
      post: {
        operationId: "mintSendKey",
        summary: "Issue a scoped send key; the token is returned ONCE and never stored. Requires a tenant owner/admin session or an operator API key.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { owner_id: { type: "string" }, label: { type: "string", nullable: true } },
                required: ["owner_id"],
              },
            },
          },
        },
        responses: {
          "201": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: { type: "string" },
                    key: { $ref: "#/components/schemas/SendKey" },
                  },
                  required: ["token", "key"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/send-keys/verify": {
      post: {
        operationId: "verifySendKey",
        summary: "Verify a send-key token and (optionally) that it may send from a given address",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { token: { type: "string" }, from: { type: "string" } },
                required: ["token"],
              },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    valid: { type: "boolean" },
                    authorized: { type: "boolean" },
                    key: { $ref: "#/components/schemas/SendKey", nullable: true },
                  },
                  required: ["valid", "authorized", "key"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/webhooks/ses-inbound": {
      post: {
        operationId: "receiveSesInboundWebhook",
        summary: "Receive an AWS SNS notification for SES inbound mail and delivery outcomes",
        description:
          "Provider-facing receiver for the SES inbound SNS topic. Carries NO Hasna API key: "
          + "the caller is authenticated by the AWS SNS message signature (verified against the "
          + "fetched SigningCertURL) plus an exact EMAILS_SNS_TOPIC_ARNS / EMAILS_AWS_ACCOUNT_IDS "
          + "allowlist, and a SubscriptionConfirmation SubscribeURL is host-pinned to "
          + "sns.<region>.amazonaws.com over HTTPS. A `Received` notification is ingested from the "
          + "operator-configured EMAILS_INGEST_S3_BUCKET into the tenant's messages; a Bounce, "
          + "Complaint, or Delivery notification is persisted to the tenant's events ledger. The "
          + "tenant comes from the trusted envelope (recipients for inbound, the sender's verified "
          + "domain for a delivery outcome) — never from a body field. Replays are idempotent via "
          + "webhook_receipts.",
        security: [] as SecurityRequirement[],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SnsNotification" },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Accepted. `duplicate` marks a replay, `ignored` an accepted-but-unroutable "
              + "notification, `synced` an inbound ingest, `event_id` a stored delivery outcome.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WebhookReceipt" },
              },
            },
          },
          "400": { description: "Malformed JSON, non-SNS payload, missing MessageId, or a non-AWS SubscribeURL" },
          "401": errorResponse("Invalid SNS signature, or a topic/account outside the allowlist"),
          "413": { description: "Request body exceeds the receiver's bound" },
          "503": errorResponse("The SNS allowlist or the required shared secret is not configured"),
        },
      },
    },
    "/v1/webhooks/resend-inbound": {
      post: {
        operationId: "receiveResendInboundWebhook",
        summary: "Receive a Resend webhook for inbound mail and delivery outcomes",
        description:
          "Provider-facing receiver for Resend webhooks. Carries NO Hasna API key: the caller is "
          + "authenticated by the Svix HMAC over the raw body using RESEND_WEBHOOK_SECRET, and an "
          + "unconfigured secret fails CLOSED with 503 rather than accepting an unsigned payload. "
          + "An inbound event is written to the tenant's messages; a delivery/engagement event is "
          + "written to the tenant's events ledger. The tenant comes from the signed envelope "
          + "(recipients for inbound, the sender's verified domain for a delivery outcome) — never "
          + "from a body field. Replays are idempotent via webhook_receipts.",
        security: [] as SecurityRequirement[],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ResendWebhookEvent" },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Accepted. `duplicate` marks a replay, `ignored` an accepted-but-unroutable event, "
              + "`id` a stored inbound message, `event_id` a stored delivery outcome.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WebhookReceipt" },
              },
            },
          },
          "400": { description: "Malformed JSON or no stable event id" },
          "401": errorResponse("Invalid Svix signature"),
          "413": { description: "Request body exceeds the receiver's bound" },
          "503": errorResponse("RESEND_WEBHOOK_SECRET is not configured (fails closed)"),
        },
      },
    },
  },
  components: {
    schemas: {
      ErrorResponse: errorResponseSchema as never,
      User: userSchema as never,
      Tenant: tenantSchema as never,
      TenantMembershipSummary: tenantMembershipSummarySchema as never,
      TenantChoice: tenantChoiceSchema as never,
      EmailIdentity: emailIdentitySchema as never,
      Membership: membershipSchema as never,
      MembershipSummary: membershipSummarySchema as never,
      Invitation: invitationSchema as never,
      ApiKeyMetadata: apiKeyMetadataSchema as never,
      Domain: domainSchema as never,
      Address: addressSchema as never,
      SendKey: sendKeySchema as never,
      MessageListItem: messageListItemSchema as never,
      Message: messageSchema as never,
      MessageCounts: messageCountsSchema as never,
      SendIntentMessage: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          send_state: {
            type: "string",
            enum: ["none", "pending", "blocked", "cancelled", "sending", "sent", "failed", "uncertain"],
          },
        },
        required: ["id", "send_state"],
      } as never,
      SendIntentLookup: sendIntentLookupSchema as never,
      SendIntentCancellation: sendIntentCancellationSchema as never,
      SendMessageError: sendMessageErrorSchema as never,
      AttachmentContent: attachmentContentSchema as never,
      AttachmentUnavailableError: attachmentUnavailableErrorSchema as never,
      AttachmentInventoryItem: attachmentInventoryItemSchema as never,
      AttachmentMeta: attachmentMetaSchema as never,
      AttachmentBatchMeta: attachmentBatchMetaSchema as never,
      AttachmentRepairSummary: attachmentRepairSummarySchema as never,
      Thread: threadSchema as never,
      Mailbox: mailboxSchema as never,
      SnsNotification: snsNotificationSchema as never,
      ResendWebhookEvent: resendWebhookEventSchema as never,
      WebhookReceipt: webhookReceiptSchema as never,
    },
    securitySchemes: {
      apiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "Tenant-bound hasna_ API key.",
      },
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "Opaque session or API key",
        description: "Authorization: Bearer accepts an emss_ user session or tenant-bound hasna_ API key.",
      },
    },
  },
};

addRoutineErrorParity(emailsSelfHostedOpenApi);
