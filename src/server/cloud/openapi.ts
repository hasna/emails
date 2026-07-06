// OpenAPI 3 description of the Mailery self_hosted cloud service (/v1).
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
    from_addr: { type: "string" },
    to_addrs: { type: "array", items: { type: "string" } },
    subject: { type: "string", nullable: true },
    body_text: { type: "string", nullable: true },
    body_html: { type: "string", nullable: true },
    status: { type: "string" },
    provider_message_id: { type: "string", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: ["id", "from_addr", "to_addrs", "status", "created_at", "updated_at"],
} as const;

const listParams = [
  { name: "limit", in: "query", required: false, schema: { type: "integer" } },
  { name: "offset", in: "query", required: false, schema: { type: "integer" } },
] as const;

const idParam = [{ name: "id", in: "path", required: true, schema: { type: "string" } }] as const;

export const maileryCloudOpenApi: OpenApiDocument = {
  openapi: "3.0.3",
  info: { title: "Mailery Self-Hosted API", version: "1.0.0" },
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
        summary: "Register a sending domain (scope mailery:write)",
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
        summary: "Register an email address (scope mailery:write)",
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
        parameters: [...listParams],
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { messages: { type: "array", items: { $ref: "#/components/schemas/Message" } } } } } } } },
      },
      post: {
        operationId: "createMessage",
        summary: "Record an outbound message in the ledger (scope mailery:write)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  from: { type: "string" },
                  to: { type: "array", items: { type: "string" } },
                  subject: { type: "string", nullable: true },
                  text: { type: "string", nullable: true },
                  html: { type: "string", nullable: true },
                  status: { type: "string" },
                },
                required: ["from", "to"],
              },
            },
          },
        },
        responses: { "201": { content: { "application/json": { schema: { type: "object", properties: { message: { $ref: "#/components/schemas/Message" } } } } } } },
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
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { status: { type: "string" }, provider_message_id: { type: "string", nullable: true } } } } } },
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { message: { $ref: "#/components/schemas/Message" } } } } } } },
      },
      delete: {
        operationId: "deleteMessage",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
  },
  components: {
    schemas: {
      Domain: domainSchema as never,
      Address: addressSchema as never,
      Message: messageSchema as never,
    },
  },
};
