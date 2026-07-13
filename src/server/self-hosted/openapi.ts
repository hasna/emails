// OpenAPI 3 description of the Emails self-hosted service (/v1).
//
// This is the single source of truth for the service's public HTTP contract:
// it is served at GET /openapi.json AND fed to @hasna/contracts' SDK generator
// to emit the typed client in sdk/. Keep it in lockstep with service.ts.

import type { OpenApiDocument } from "@hasna/contracts/sdk";

const domainSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    domain: { type: "string" },
    status: { type: "string" },
    provider: { type: "string", nullable: true },
    verified: { type: "boolean" },
    notes: { type: "string", nullable: true },
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
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: ["id", "email", "status", "created_at", "updated_at"],
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
    attachments: { type: "array", items: { type: "object", additionalProperties: true } },
    source_id: { type: "string", nullable: true, description: "Stable upstream id used for idempotent upsert" },
    send_state: { type: "string", description: "none | pending | sending | sent | uncertain" },
    send_started_at: { type: "string", format: "date-time", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: ["id", "direction", "from_addr", "to_addrs", "status", "created_at", "updated_at"],
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
    snippet: { type: "string", nullable: true, description: "Short text preview; full bodies are available only from GET /v1/messages/{id}." },
    status: { type: "string" },
    provider_message_id: { type: "string", nullable: true },
    message_id: { type: "string", nullable: true, description: "RFC 5322 Message-ID" },
    in_reply_to: { type: "string", nullable: true },
    received_at: { type: "string", format: "date-time", nullable: true, description: "Original receipt time (inbound)" },
    is_read: { type: "boolean" },
    is_starred: { type: "boolean" },
    labels: { type: "array", items: { type: "string" } },
    headers: { type: "object", additionalProperties: true },
    attachments: { type: "array", items: { type: "object", additionalProperties: true } },
    source_id: { type: "string", nullable: true, description: "Stable upstream id used for idempotent upsert" },
    send_state: { type: "string", description: "none | pending | sending | sent | uncertain" },
    send_started_at: { type: "string", format: "date-time", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: ["id", "direction", "from_addr", "to_addrs", "status", "created_at", "updated_at"],
} as const;

const listParams = [
  { name: "limit", in: "query", required: false, schema: { type: "integer" } },
  { name: "offset", in: "query", required: false, schema: { type: "integer" } },
] as const;

const idParam = [{ name: "id", in: "path", required: true, schema: { type: "string" } }] as const;

export const emailsSelfHostedOpenApi: OpenApiDocument = {
  openapi: "3.0.3",
  info: { title: "Emails Self-Hosted API", version: "1.0.0" },
  paths: {
    "/health": {
      get: {
        operationId: "getHealth",
        summary: "Liveness probe with database reachability",
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/ready": {
      get: {
        operationId: "getReady",
        summary: "Readiness probe (reachable and fully migrated)",
        responses: {
          "200": { content: { "application/json": { schema: { type: "object" } } } },
          "503": { content: { "application/json": { schema: { type: "object" } } } },
        },
      },
    },
    "/version": {
      get: {
        operationId: "getVersion",
        summary: "Service version and mode",
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
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
                schema: { type: "object", properties: { domains: { type: "array", items: { $ref: "#/components/schemas/Domain" } } } },
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
        responses: { "201": { content: { "application/json": { schema: { type: "object", properties: { domain: { $ref: "#/components/schemas/Domain" } } } } } } },
      },
    },
    "/v1/domains/{id}": {
      get: {
        operationId: "getDomain",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { domain: { $ref: "#/components/schemas/Domain" } } } } } } },
      },
      patch: {
        operationId: "updateDomain",
        parameters: [...idParam],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { status: { type: "string" }, provider: { type: "string", nullable: true }, verified: { type: "boolean" }, notes: { type: "string", nullable: true } },
              },
            },
          },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { domain: { $ref: "#/components/schemas/Domain" } } } } } } },
      },
      delete: {
        operationId: "deleteDomain",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/addresses": {
      get: {
        operationId: "listAddresses",
        parameters: [...listParams],
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { addresses: { type: "array", items: { $ref: "#/components/schemas/Address" } } } } } } } },
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
        responses: { "201": { content: { "application/json": { schema: { type: "object", properties: { address: { $ref: "#/components/schemas/Address" } } } } } } },
      },
    },
    "/v1/addresses/{id}": {
      get: {
        operationId: "getAddress",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { address: { $ref: "#/components/schemas/Address" } } } } } } },
      },
      patch: {
        operationId: "updateAddress",
        parameters: [...idParam],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { display_name: { type: "string", nullable: true }, status: { type: "string" } } } } } },
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { address: { $ref: "#/components/schemas/Address" } } } } } } },
      },
      delete: {
        operationId: "deleteAddress",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/messages": {
      get: {
        operationId: "listMessages",
        parameters: [
          ...listParams,
          { name: "direction", in: "query", required: false, schema: { type: "string", enum: ["inbound", "outbound"] } },
          { name: "to", in: "query", required: false, schema: { type: "string" } },
          { name: "from", in: "query", required: false, schema: { type: "string" } },
          { name: "subject", in: "query", required: false, schema: { type: "string" } },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          { name: "since", in: "query", required: false, schema: { type: "string", format: "date-time" } },
        ],
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { messages: { type: "array", items: { $ref: "#/components/schemas/MessageListItem" } } } } } } } },
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
          "200": { content: { "application/json": { schema: { type: "object", properties: { message: { $ref: "#/components/schemas/Message" } } } } } },
          "201": { content: { "application/json": { schema: { type: "object", properties: { message: { $ref: "#/components/schemas/Message" } } } } } },
        },
      },
    },
    "/v1/messages/counts": {
      get: {
        operationId: "getMessageCounts",
        summary: "Return server-side mailbox counts",
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/messages/send": {
      post: {
        operationId: "sendMessage",
        summary: "Send through the configured SES or Resend provider and persist the resulting ledger row",
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
                        filename: { type: "string" },
                        content: { type: "string", description: "Base64-encoded attachment content" },
                        content_type: { type: "string" },
                      },
                      required: ["filename", "content", "content_type"],
                    },
                  },
                  idempotency_key: { type: "string", maxLength: 200 },
                },
                required: ["from", "to", "subject", "idempotency_key"],
              },
            },
          },
        },
        responses: {
          "202": { content: { "application/json": { schema: { type: "object", properties: { message: { $ref: "#/components/schemas/Message" }, provider: { type: "string" } } } } } },
        },
      },
    },
    "/v1/messages/{id}": {
      get: {
        operationId: "getMessage",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { message: { $ref: "#/components/schemas/Message" } } } } } } },
      },
      patch: {
        operationId: "updateMessage",
        parameters: [...idParam],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { status: { type: "string" }, provider_message_id: { type: "string", nullable: true }, is_read: { type: "boolean" }, is_starred: { type: "boolean" }, archived: { type: "boolean" }, add_label: { type: "string" }, remove_label: { type: "string" } } } } } },
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { message: { $ref: "#/components/schemas/Message" } } } } } } },
      },
      delete: {
        operationId: "deleteMessage",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/messages/{id}/attachments/{index}": {
      get: {
        operationId: "getMessageAttachment",
        parameters: [
          ...idParam,
          { name: "index", in: "path", required: true, schema: { type: "integer", minimum: 0 } },
        ],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
  },
  components: {
    schemas: {
      Domain: domainSchema as never,
      Address: addressSchema as never,
      MessageListItem: messageListItemSchema as never,
      Message: messageSchema as never,
    },
  },
};
