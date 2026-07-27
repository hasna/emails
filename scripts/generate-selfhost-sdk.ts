#!/usr/bin/env bun
// Regenerates the self_hosted API client from the serve's OpenAPI document.
//   bun run scripts/generate-selfhost-sdk.ts
// The output (src/selfhost.ts, exported as @hasna/emails/selfhost) is
// committed; CI can re-run this to verify it is in sync with openapi.ts.

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSdkFromOpenApi } from "@hasna/contracts/sdk";
import { emailsSelfHostedOpenApi } from "../src/server/self-hosted/openapi.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const generated = generateSdkFromOpenApi(emailsSelfHostedOpenApi, {
  className: "EmailsSelfHostClient",
  apiKeyHeader: "x-api-key",
});

type ResponseContract = {
  method: string;
  operationId: string;
  path: string;
  status: number;
  schema: unknown;
};

const responseContracts: ResponseContract[] = [];
const responseContractKeys = new Set<string>();
for (const [path, pathItem] of Object.entries(emailsSelfHostedOpenApi.paths ?? {})) {
  for (const [method, operationValue] of Object.entries(pathItem as Record<string, unknown>)) {
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
    const operation = operationValue as {
      operationId?: unknown;
      responses?: Record<string, {
        content?: Record<string, { schema?: unknown }>;
      }>;
    };
    for (const [statusText, response] of Object.entries(operation.responses ?? {})) {
      if (!/^[1-5]\d\d$/.test(statusText)) continue;
      const contract = {
        method: method.toUpperCase(),
        operationId: typeof operation.operationId === "string" ? operation.operationId : `${method}:${path}`,
        path,
        status: Number(statusText),
        schema: response.content?.["application/json"]?.schema ?? null,
      };
      const key = `${contract.method} ${contract.path} ${contract.status}`;
      if (responseContractKeys.has(key)) throw new Error(`duplicate OpenAPI success response contract: ${key}`);
      responseContractKeys.add(key);
      responseContracts.push(contract);
    }
  }
}
responseContracts.sort((a, b) =>
  a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.status - b.status);

const allComponents = emailsSelfHostedOpenApi.components?.schemas ?? {};
const responseComponentNames = new Set<string>();
function collectResponseComponentRefs(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) collectResponseComponentRefs(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const ref = record["$ref"];
  const prefix = "#/components/schemas/";
  if (typeof ref === "string" && ref.startsWith(prefix)) {
    const name = ref.slice(prefix.length);
    if (!(name in allComponents)) throw new Error(`unknown response schema component: ${name}`);
    if (!responseComponentNames.has(name)) {
      responseComponentNames.add(name);
      collectResponseComponentRefs(allComponents[name]);
    }
  }
  for (const nested of Object.values(record)) collectResponseComponentRefs(nested);
}
for (const contract of responseContracts) collectResponseComponentRefs(contract.schema);
const responseComponents = Object.fromEntries(
  [...responseComponentNames]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => [name, allComponents[name]]),
);

const responseContractOutput = `// @generated from src/server/self-hosted/openapi.ts by scripts/generate-selfhost-sdk.ts — DO NOT EDIT.
// Compact runtime response contracts. Regenerate with: bun run scripts/generate-selfhost-sdk.ts
export interface SelfHostedResponseContract {
  readonly method: string;
  readonly operationId: string;
  readonly path: string;
  readonly status: number;
  readonly schema: unknown;
}

export const SELF_HOSTED_RESPONSE_CONTRACTS: readonly SelfHostedResponseContract[] = ${JSON.stringify(responseContracts, null, 2)};

export const SELF_HOSTED_RESPONSE_COMPONENTS: Readonly<Record<string, unknown>> = ${JSON.stringify(
  responseComponents,
  null,
  2,
)};
`;
let secureClientCode = generated.code.replace(
  '    this.baseUrl = options.baseUrl.replace(/\\\/$/, "");',
  `    const parsedBaseUrl = new URL(options.baseUrl);
    const loopback = parsedBaseUrl.hostname === "localhost"
      || parsedBaseUrl.hostname === "127.0.0.1"
      || parsedBaseUrl.hostname === "[::1]"
      || parsedBaseUrl.hostname === "::1";
    if (parsedBaseUrl.protocol !== "https:" && !(parsedBaseUrl.protocol === "http:" && loopback)) {
      throw new Error("EmailsSelfHostClient requires HTTPS except for loopback development URLs.");
    }
    this.baseUrl = options.baseUrl.replace(/\\\/$/, "");`,
);
if (secureClientCode === generated.code) {
  throw new Error("generated SDK constructor shape changed; HTTPS policy was not injected");
}

function replaceRequired(source: string, needle: string | RegExp, replacement: string, label: string): string {
  const updated = typeof needle === "string"
    ? source.replace(needle, replacement)
    : source.replace(needle, replacement);
  if (updated === source) throw new Error(`generated SDK shape changed; ${label} was not injected`);
  return updated;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSchema(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unique(types: string[]): string[] {
  return types.filter((type, index) => types.indexOf(type) === index);
}

/**
 * Render response JSON Schema to TypeScript without dropping OpenAPI 3.0's
 * sibling `nullable: true`. This deliberately handles nullable after resolving
 * the base shape, so `$ref`, oneOf/anyOf and allOf are all covered uniformly.
 */
function responseSchemaType(schema: Record<string, unknown>): string {
  const ref = schema["$ref"];
  let base: string;
  if (typeof ref === "string" && ref.startsWith("#/components/schemas/")) {
    base = ref.slice("#/components/schemas/".length);
  } else if (Array.isArray(schema["oneOf"])) {
    base = unique(
      schema["oneOf"].filter(isSchema).map(responseSchemaType),
    ).join(" | ") || "unknown";
  } else if (Array.isArray(schema["anyOf"])) {
    base = unique(
      schema["anyOf"].filter(isSchema).map(responseSchemaType),
    ).join(" | ") || "unknown";
  } else if (Array.isArray(schema["allOf"])) {
    base = unique(
      schema["allOf"].filter(isSchema).map(responseSchemaType),
    ).join(" & ") || "unknown";
  } else if (Array.isArray(schema["enum"]) && schema["enum"].length > 0) {
    const literals = schema["enum"]
      .filter((value) => value !== null)
      .map((value) => JSON.stringify(value));
    base = unique(literals).join(" | ") || "never";
  } else if (
    schema["type"] === "object"
    || isSchema(schema["properties"])
    || Array.isArray(schema["required"])
  ) {
    const properties = isSchema(schema["properties"]) ? schema["properties"] : {};
    const required = new Set(
      Array.isArray(schema["required"])
        ? schema["required"].filter((field): field is string => typeof field === "string")
        : [],
    );
    const fields = Object.entries(properties)
      .filter((entry): entry is [string, Record<string, unknown>] => isSchema(entry[1]))
      .map(([name, property]) =>
        `${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${responseSchemaType(property)}`);
    if (fields.length === 0) {
      const additional = schema["additionalProperties"];
      base = isSchema(additional)
        ? `Record<string, ${responseSchemaType(additional)}>`
        : "Record<string, unknown>";
    } else {
      base = `{ ${fields.join("; ")} }`;
    }
  } else if (schema["type"] === "array") {
    base = `Array<${isSchema(schema["items"]) ? responseSchemaType(schema["items"]) : "unknown"}>`;
  } else if (schema["type"] === "string") {
    base = "string";
  } else if (schema["type"] === "integer" || schema["type"] === "number") {
    base = "number";
  } else if (schema["type"] === "boolean") {
    base = "boolean";
  } else {
    base = "unknown";
  }

  const nullable = schema["nullable"] === true
    || (Array.isArray(schema["enum"]) && schema["enum"].includes(null));
  if (!nullable) return base;
  return base.includes(" | ") || base.includes(" & ")
    ? `(${base}) | null`
    : `${base} | null`;
}

for (const [name, schema] of Object.entries(allComponents)) {
  if (!isSchema(schema)) continue;
  const declaration = responseSchemaType(schema);
  if (!declaration.startsWith("{ ")) continue;
  const pattern = new RegExp(`export interface ${escapeRegExp(name)} \\{[^\\n]*\\}`);
  if (!pattern.test(secureClientCode)) continue;
  secureClientCode = secureClientCode.replace(
    pattern,
    `export interface ${name} ${declaration}`,
  );
}

for (const operation of generated.operations) {
  const pathItem = emailsSelfHostedOpenApi.paths?.[operation.path] as
    | Record<string, { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }>
    | undefined;
  const responses = pathItem?.[operation.method]?.responses ?? {};
  const successTypes = unique(
    Object.entries(responses)
      .filter(([status]) => /^2\d\d$/.test(status))
      .map(([, response]) => response.content?.["application/json"]?.schema)
      .map((schema) => isSchema(schema) ? responseSchemaType(schema) : "undefined"),
  );
  if (successTypes.length === 0) continue;
  const pattern = new RegExp(
    `(async ${escapeRegExp(operation.functionName)}\\([^\\n]*\\): Promise<)(.*?)(> \\{\\n\\s+return this\\.request)`,
  );
  if (!pattern.test(secureClientCode)) {
    throw new Error(
      `generated SDK shape changed; complete success union for ${operation.operationId} was not injected`,
    );
  }
  secureClientCode = secureClientCode.replace(
    pattern,
    `$1${successTypes.join(" | ")}$3`,
  );
}

secureClientCode = replaceRequired(
  secureClientCode,
  "  apiKey?: string;\n",
  "  apiKey?: string;\n  /** Opaque emss_ user session (or bearer-compatible API key). */\n  bearerToken?: string;\n",
  "bearer option",
);
secureClientCode = replaceRequired(
  secureClientCode,
  "  /** Extra headers merged into every request. */\n  headers?: Record<string, string>;\n",
  `  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
  /** Maximum response bytes read before failing closed (default: 8 MiB). */
  maxResponseBytes?: number;
`,
  "transport bounds options",
);
secureClientCode = replaceRequired(
  secureClientCode,
  "  private readonly apiKey: string | undefined;\n",
  "  private readonly apiKey: string | undefined;\n  private readonly bearerToken: string | undefined;\n",
  "bearer field",
);
secureClientCode = replaceRequired(
  secureClientCode,
  "  private readonly baseHeaders: Record<string, string>;\n",
  `  private readonly baseHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
`,
  "transport bounds fields",
);
secureClientCode = replaceRequired(
  secureClientCode,
  "    this.apiKey = options.apiKey;\n",
  "    this.apiKey = options.apiKey;\n    this.bearerToken = options.bearerToken;\n",
  "bearer assignment",
);
secureClientCode = replaceRequired(
  secureClientCode,
  "    this.baseHeaders = options.headers ?? {};\n",
  `    this.baseHeaders = options.headers ?? {};
    this.timeoutMs = selfHostedTransportLimit(
      options.timeoutMs,
      DEFAULT_SELF_HOSTED_HTTP_TIMEOUT_MS,
      "timeoutMs",
    );
    this.maxResponseBytes = selfHostedTransportLimit(
      options.maxResponseBytes,
      DEFAULT_SELF_HOSTED_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
`,
  "transport bounds assignment",
);
secureClientCode = replaceRequired(
  secureClientCode,
  '    if (this.apiKey) headers["x-api-key"] = this.apiKey;\n',
  '    if (this.bearerToken) headers["Authorization"] = `Bearer ${this.bearerToken}`;\n    else if (this.apiKey) headers["x-api-key"] = this.apiKey;\n',
  "bearer header",
);
secureClientCode = replaceRequired(
  secureClientCode,
  "    const response = await this.fetchImpl(url.toString(), { ...opts.init, method, headers, body: payload });\n",
  `    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = opts.init?.signal
      ? AbortSignal.any([opts.init.signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        ...opts.init,
        method,
        headers,
        body: payload,
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (timeoutSignal.aborted || (error as Error)?.name === "TimeoutError") {
        throw new Error(\`Self-hosted \${method} \${path} timed out after \${this.timeoutMs}ms\`);
      }
      if (opts.init?.signal?.aborted || (error as Error)?.name === "AbortError") {
        throw new Error(\`Self-hosted \${method} \${path} request was aborted\`);
      }
      throw new Error(\`Cannot reach the Emails self-hosted service for \${method} \${path}\`);
    }
`,
  "bounded redirect-safe request",
);
secureClientCode = replaceRequired(
  secureClientCode,
  "    const text = await response.text();\n",
  "    const text = await readSelfHostedResponseText(response, { method, path }, this.maxResponseBytes);\n",
  "bounded response read",
);
secureClientCode = replaceRequired(
  secureClientCode,
  "    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;\n",
  `    const data = response.ok
      ? parseSelfHostedSuccessJson(text, { status: response.status, method, path })
      : projectSelfHostedErrorBody(
        method,
        path,
        response.status,
        parseSelfHostedErrorJson(text, { status: response.status, method, path }),
      );
    if (response.ok) validateSelfHostedSdkSuccessResponse(method, path, response.status, data);
`,
  "success and error wire validation",
);
secureClientCode = replaceRequired(
  secureClientCode,
  `export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown) {
    super(message);
    this.name = "ApiError";
  }
}`,
  `export type SendIntentRecoveryState = "blocked" | "cancelled" | "failed" | "none" | "pending" | "sending" | "sent" | "uncertain";

export interface SendIntentMessageProjection {
  id: string;
  send_state: SendIntentRecoveryState;
}

const SEND_INTENT_MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEND_INTENT_RECOVERY_STATES = new Set<SendIntentRecoveryState>([
  "blocked", "cancelled", "failed", "none", "pending", "sending", "sent", "uncertain",
]);

function parseSendIntentMessage(body: unknown): SendIntentMessageProjection | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const message = (body as Record<string, unknown>)["message"];
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const id = (message as Record<string, unknown>)["id"];
  const sendState = (message as Record<string, unknown>)["send_state"];
  if (typeof id !== "string" || !SEND_INTENT_MESSAGE_ID.test(id)) return undefined;
  if (typeof sendState !== "string" || !SEND_INTENT_RECOVERY_STATES.has(sendState as SendIntentRecoveryState)) {
    return undefined;
  }
  return { id, send_state: sendState as SendIntentRecoveryState };
}

export class ApiError extends Error {
  readonly sendIntentMessage: SendIntentMessageProjection | undefined;

  constructor(readonly status: number, message: string, readonly body: unknown) {
    super(message);
    this.name = "ApiError";
    this.sendIntentMessage = parseSendIntentMessage(body);
  }
}`,
  "send-intent error projection",
);
const header = `// @generated from src/server/self-hosted/openapi.ts by scripts/generate-selfhost-sdk.ts — DO NOT EDIT.
// Regenerate: bun run scripts/generate-selfhost-sdk.ts
import {
  DEFAULT_SELF_HOSTED_HTTP_TIMEOUT_MS,
  DEFAULT_SELF_HOSTED_MAX_RESPONSE_BYTES,
  parseSelfHostedErrorJson,
  parseSelfHostedSuccessJson,
  projectSelfHostedErrorBody,
  readSelfHostedResponseText,
  selfHostedTransportLimit,
  validateSelfHostedSdkSuccessResponse,
} from "./lib/self-hosted-wire.js";

`;
const out = join(root, "src", "selfhost.ts");
writeFileSync(out, header + secureClientCode);
const responseContractsOut = join(root, "src", "lib", "self-hosted-response-contracts.generated.ts");
writeFileSync(responseContractsOut, responseContractOutput);
console.log(`wrote ${out}`);
console.log(`wrote ${responseContractsOut}`);
console.log(`operations: ${generated.operations.map((o) => o.functionName).join(", ")}`);
if (generated.warnings.length) console.log(`warnings:\n  ${generated.warnings.join("\n  ")}`);
