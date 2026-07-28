import {
  SELF_HOSTED_RESPONSE_COMPONENTS,
  SELF_HOSTED_RESPONSE_CONTRACTS,
  type SelfHostedResponseContract,
} from "./self-hosted-response-contracts.generated.js";
import { canonicalizeSelfHostedPathname } from "./self-hosted-paths.js";

type JsonSchema = Record<string, unknown>;

interface WireContext {
  method: string;
  path: string;
  responseKind?: "successful" | "error";
}

interface CompiledResponseContract {
  contract: SelfHostedResponseContract;
  literalLength: number;
  pattern: RegExp;
}

export const DEFAULT_SELF_HOSTED_HTTP_TIMEOUT_MS = 30_000;
export const DEFAULT_SELF_HOSTED_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const SUPPORTED_SELF_HOSTED_RESPONSE_FORMATS = [
  "date-time",
  "email",
  "uuid",
] as const;

export function selfHostedTransportLimit(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

const STATIC_MESSAGE_PATH_SEGMENTS = new Set([
  "counts",
  "groups",
  "record",
  "send",
  "send-intents",
  "threads",
]);

function pathOnly(path: string): string {
  const pathname = path.split("?", 1)[0] || "/";
  if (
    pathname === "/health"
    || pathname === "/ready"
    || pathname === "/version"
    || pathname === "/openapi.json"
    || pathname === "/api/v1"
    || pathname.startsWith("/api/v1/")
    || pathname === "/v1"
    || pathname.startsWith("/v1/")
  ) {
    return canonicalizeSelfHostedPathname(pathname);
  }
  return canonicalizeSelfHostedPathname(
    `/v1${pathname.startsWith("/") ? "" : "/"}${pathname}`,
  );
}

function safePath(path: string): string {
  const pathname = pathOnly(path);
  const messageSafe = pathname.replace(
    /(\/messages\/)([^/]+)(?=\/|$)/,
    (_match, prefix: string, segment: string) =>
      `${prefix}${STATIC_MESSAGE_PATH_SEGMENTS.has(segment) ? segment : "<id>"}`,
  );
  return messageSafe.replace(
    /(\/messages\/<id>\/attachments\/)[^/]+(?=\/|$)/,
    "$1<index>",
  );
}

export class SelfHostedWireResponseError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    detail: string,
    responseKind: "successful" | "error" = "successful",
  ) {
    super(`Self-hosted ${method.toUpperCase()} ${safePath(path)} returned an invalid ${responseKind} response: ${detail}`);
    this.name = "SelfHostedWireResponseError";
  }
}

export class SelfHostedResponseSizeError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly maxBytes: number,
  ) {
    super(`Self-hosted ${method.toUpperCase()} ${safePath(path)} response exceeded the ${maxBytes}-byte limit`);
    this.name = "SelfHostedResponseSizeError";
  }
}

/** Preserve safe-wrapper fallbacks while never disguising a bad 2xx contract. */
export function rethrowSelfHostedResponseFailure(error: unknown): void {
  if (error instanceof SelfHostedWireResponseError || error instanceof SelfHostedResponseSizeError) {
    throw error;
  }
}

function fail(context: WireContext, detail: string): never {
  throw new SelfHostedWireResponseError(
    context.method,
    context.path,
    detail,
    context.responseKind,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePath(path: string): { literalLength: number; pattern: RegExp } {
  const parts = path.split(/(\{[^}]+\})/g);
  const literalLength = parts
    .filter((part) => !part.startsWith("{"))
    .reduce((sum, part) => sum + part.length, 0);
  const source = parts
    .map((part) => part.startsWith("{") && part.endsWith("}") ? "[^/]+" : escapeRegExp(part))
    .join("");
  return { literalLength, pattern: new RegExp(`^${source}$`) };
}

const COMPILED_RESPONSE_CONTRACTS: readonly CompiledResponseContract[] =
  SELF_HOSTED_RESPONSE_CONTRACTS
    .map((contract) => ({ contract, ...compilePath(contract.path) }))
    .sort((a, b) => b.literalLength - a.literalLength);

function responseContract(context: WireContext & { status: number }): SelfHostedResponseContract {
  const method = context.method.toUpperCase();
  const pathname = pathOnly(context.path);
  const match = COMPILED_RESPONSE_CONTRACTS.find(({ contract, pattern }) =>
    contract.method === method && contract.status === context.status && pattern.test(pathname));
  if (!match) {
    fail(context, `HTTP ${context.status} is not declared for this path and method`);
  }
  return match.contract;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveSchema(schema: JsonSchema, context: WireContext): JsonSchema {
  const ref = schema["$ref"];
  if (typeof ref !== "string") return schema;
  const prefix = "#/components/schemas/";
  if (!ref.startsWith(prefix)) fail(context, "response contract contains an unsupported schema reference");
  const name = ref.slice(prefix.length);
  const resolved = SELF_HOSTED_RESPONSE_COMPONENTS[name];
  if (!isRecord(resolved)) fail(context, "response contract references an unknown component");
  return resolved;
}

function requiredPropertyNames(schema: JsonSchema, context: WireContext): Set<string> {
  const resolved = resolveSchema(schema, context);
  const names = new Set<string>();
  const required = resolved["required"];
  if (Array.isArray(required)) {
    for (const field of required) {
      if (typeof field === "string") names.add(field);
    }
  }
  const allOf = resolved["allOf"];
  if (Array.isArray(allOf)) {
    for (const branch of allOf) {
      if (!isRecord(branch)) continue;
      for (const field of requiredPropertyNames(branch, context)) names.add(field);
    }
  }
  return names;
}

function strictRequiredSuperset(
  candidate: JsonSchema,
  other: JsonSchema,
  context: WireContext,
): boolean {
  const candidateFields = requiredPropertyNames(candidate, context);
  const otherFields = requiredPropertyNames(other, context);
  return candidateFields.size > otherFields.size
    && [...otherFields].every((field) => candidateFields.has(field));
}

/**
 * Server releases through 1.3.x serialize database `*_json` columns into
 * responses as JSON-encoded STRINGS (`"[]"` rather than `[]`). Give exactly
 * that field class a second reading: when a `*_json` property fails its
 * declared schema while holding a string, decode the string ONCE and
 * re-validate the decoded value against the same schema. A decoded value the
 * contract accepts is normalized in place, so every consumer past the
 * validator sees the declared shape; a string that does not parse, or parses
 * to a shape the contract rejects, keeps the original refusal. Fields not
 * named `*_json` never get the second reading.
 */
function decodeSerializedJsonColumn(field: string, value: unknown): { decoded: unknown } | null {
  if (!field.endsWith("_json") || typeof value !== "string") return null;
  try {
    return { decoded: JSON.parse(value) };
  } catch {
    return null;
  }
}

function schemaMatches(schema: JsonSchema, value: unknown, context: WireContext, path: string): string | null {
  const resolved = resolveSchema(schema, context);
  // OpenAPI 3.0 commonly places `nullable` beside a `$ref`. Preserve that
  // endpoint-level constraint even though the referenced component supplies
  // the rest of the shape.
  if (value === null && (schema["nullable"] === true || resolved["nullable"] === true)) return null;

  const allOf = resolved["allOf"];
  if (Array.isArray(allOf)) {
    for (const branch of allOf) {
      if (!isRecord(branch)) return `${path} has an invalid response contract`;
      const error = schemaMatches(branch, value, context, path);
      if (error) return error;
    }
  }

  const anyOf = resolved["anyOf"];
  if (Array.isArray(anyOf)) {
    const matched = anyOf.some((branch) =>
      isRecord(branch) && schemaMatches(branch, value, context, path) === null);
    if (!matched) return `${path} must match an allowed response shape`;
  }

  const oneOf = resolved["oneOf"];
  if (Array.isArray(oneOf)) {
    const matches = oneOf.filter((branch): branch is JsonSchema =>
      isRecord(branch) && schemaMatches(branch, value, context, path) === null);
    if (matches.length > 1) {
      // Additive object branches can intentionally overlap (for example a full
      // Tenant and the legacy `{id}` tenant reference). Accept only when one
      // matching branch is uniquely more specific by required fields. Hybrid
      // responses across incomparable branches remain ambiguous and fail.
      const mostSpecific = matches.filter((candidate) =>
        !matches.some((other) =>
          other !== candidate && strictRequiredSuperset(other, candidate, context)));
      if (mostSpecific.length !== 1) {
        return `${path} must match exactly one allowed response shape`;
      }
    } else if (matches.length !== 1) {
      return `${path} must match exactly one allowed response shape`;
    }
  }

  const enumValues = resolved["enum"];
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => Object.is(candidate, value))) {
    return `${path} is not an allowed value`;
  }

  const type = resolved["type"];
  const objectLike =
    type === "object"
    || Array.isArray(resolved["required"])
    || isRecord(resolved["properties"])
    || resolved["additionalProperties"] !== undefined;
  if (objectLike) {
    if (!isRecord(value)) return `${path} must be a JSON object`;
    const required = Array.isArray(resolved["required"]) ? resolved["required"] as unknown[] : [];
    for (const field of required) {
      if (typeof field === "string" && !Object.prototype.hasOwnProperty.call(value, field)) {
        return `${path}.${field} is required`;
      }
    }
    const properties = isRecord(resolved["properties"]) ? resolved["properties"] : {};
    for (const [field, fieldSchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, field) || !isRecord(fieldSchema)) continue;
      const fieldPath = `${path}.${field}`;
      const error = schemaMatches(fieldSchema, value[field], context, fieldPath);
      if (error === null) continue;
      const serialized = decodeSerializedJsonColumn(field, value[field]);
      if (serialized !== null && schemaMatches(fieldSchema, serialized.decoded, context, fieldPath) === null) {
        value[field] = serialized.decoded;
        continue;
      }
      return error;
    }
    const additional = resolved["additionalProperties"];
    const extraFields = Object.keys(value).filter((field) => !(field in properties));
    if (additional === false && extraFields.length > 0) return `${path} contains unsupported fields`;
    if (isRecord(additional)) {
      for (const field of extraFields) {
        const error = schemaMatches(additional, value[field], context, `${path}.<additional>`);
        if (error) return error;
      }
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array`;
    const minItems = resolved["minItems"];
    const maxItems = resolved["maxItems"];
    if (typeof minItems === "number" && value.length < minItems) return `${path} has too few items`;
    if (typeof maxItems === "number" && value.length > maxItems) return `${path} has too many items`;
    const itemSchema = resolved["items"];
    if (isRecord(itemSchema)) {
      for (let index = 0; index < value.length; index += 1) {
        const error = schemaMatches(itemSchema, value[index], context, `${path}[${index}]`);
        if (error) return error;
      }
    }
  } else if (type === "string") {
    if (typeof value !== "string") return `${path} must be a string`;
    const minLength = resolved["minLength"];
    const maxLength = resolved["maxLength"];
    if (typeof minLength === "number" && value.length < minLength) return `${path} is too short`;
    if (typeof maxLength === "number" && value.length > maxLength) return `${path} is too long`;
    const pattern = resolved["pattern"];
    if (typeof pattern === "string" && !new RegExp(pattern).test(value)) return `${path} has an invalid format`;
    const format = resolved["format"];
    if (typeof format === "string") {
      if (format === "uuid") {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
          return `${path} must be a canonical UUID`;
        }
      } else if (format === "email") {
        if (
          value.length > 254
          || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
          || value.startsWith(".")
          || value.includes("..")
        ) {
          return `${path} must be a valid email address`;
        }
      } else if (format === "date-time") {
        const match = value.match(
          /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
        );
        if (!match) return `${path} must be an RFC 3339 date-time`;
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const hour = Number(match[4]);
        const minute = Number(match[5]);
        const second = Number(match[6]);
        const offset = match[7]!;
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        const offsetValid = offset === "Z" || (() => {
          const [offsetHour, offsetMinute] = offset.slice(1).split(":").map(Number);
          return offsetHour! <= 23 && offsetMinute! <= 59;
        })();
        if (
          month < 1
          || month > 12
          || day < 1
          || day > days[month - 1]!
          || hour > 23
          || minute > 59
          || second > 59
          || !offsetValid
        ) {
          return `${path} must be an RFC 3339 date-time`;
        }
      } else {
        return `${path} uses unsupported response format ${format}`;
      }
    }
  } else if (type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) return `${path} must be a safe integer`;
  } else if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a finite number`;
  } else if (type === "boolean") {
    if (typeof value !== "boolean") return `${path} must be a boolean`;
  }

  if ((type === "integer" || type === "number") && typeof value === "number") {
    const minimum = resolved["minimum"];
    const maximum = resolved["maximum"];
    if (typeof minimum === "number" && value < minimum) return `${path} is below the allowed minimum`;
    if (typeof maximum === "number" && value > maximum) return `${path} exceeds the allowed maximum`;
  }
  return null;
}

export function parseSelfHostedSuccessJson(
  text: string,
  context: WireContext & { status: number },
): unknown {
  const contract = responseContract(context);
  if (!text.trim()) {
    if (contract.schema === null) return undefined;
    fail(context, "body is empty; expected JSON");
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(context, "body is not valid JSON");
  }
}

export function parseSelfHostedErrorJson(
  text: string,
  context: WireContext & { status: number },
): unknown {
  const errorContext = { ...context, responseKind: "error" as const };
  const contract = responseContract(errorContext);
  if (!text.trim()) {
    if (contract.schema === null) return undefined;
    fail(errorContext, "body is empty; expected JSON");
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(errorContext, "body is not valid JSON");
  }
}

export function validateSelfHostedSdkSuccessResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): void {
  const context = { method, path, status };
  const contract = responseContract(context);
  if (contract.schema === null) {
    if (value !== undefined) fail(context, "body must be empty for this response");
    return;
  }
  if (!isRecord(contract.schema)) fail(context, "response contract is not a JSON schema");
  const error = schemaMatches(contract.schema, value, context, "body");
  if (error) fail(context, error);
}

export const validateSelfHostedMailSuccessResponse = validateSelfHostedSdkSuccessResponse;

function validateDeclaredSelfHostedErrorResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): void {
  const context = { method, path, status, responseKind: "error" as const };
  const contract = responseContract(context);
  if (!isRecord(contract.schema)) fail(context, "response contract is not a JSON schema");
  const error = schemaMatches(contract.schema, value, context, "body");
  if (error) fail(context, error);
}

export interface SelfHostedTextResponse {
  readonly body?: ReadableStream<Uint8Array> | null;
  readonly headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export async function readSelfHostedResponseText(
  response: SelfHostedTextResponse,
  context: WireContext,
  maxBytes = DEFAULT_SELF_HOSTED_MAX_RESPONSE_BYTES,
): Promise<string> {
  maxBytes = selfHostedTransportLimit(
    maxBytes,
    DEFAULT_SELF_HOSTED_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  const contentLength = Number(response.headers?.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new SelfHostedResponseSizeError(context.method, context.path, maxBytes);
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new SelfHostedResponseSizeError(context.method, context.path, maxBytes);
    }
    return text;
  }

  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new SelfHostedResponseSizeError(context.method, context.path, maxBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function safeMachineCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : undefined;
}

function safeMachineId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
    ? value
    : undefined;
}

/**
 * Retain only the small machine-readable projection callers need for recovery
 * decisions. Human error text, provider detail, message bodies, subjects,
 * addresses, and arbitrary server fields are deliberately discarded.
 */
export function redactSelfHostedErrorBody(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const redacted: Record<string, unknown> = {};
  for (const field of ["reason", "code", "outcome"] as const) {
    const safe = safeMachineCode(value[field]);
    if (safe) redacted[field] = safe;
  }
  for (const field of ["retry_safe", "sent", "tombstoned", "reconciliation_required"] as const) {
    if (typeof value[field] === "boolean" || value[field] === null) redacted[field] = value[field];
  }
  if (typeof value["retry_after"] === "number" && Number.isFinite(value["retry_after"])) {
    redacted["retry_after"] = value["retry_after"];
  }
  if (isRecord(value["message"])) {
    const message: Record<string, unknown> = {};
    const id = safeMachineId(value["message"]["id"]);
    const sendState = safeMachineCode(value["message"]["send_state"]);
    if (id) message["id"] = id;
    if (sendState) message["send_state"] = sendState;
    if (Object.keys(message).length > 0) redacted["message"] = message;
  }
  return Object.keys(redacted).length > 0 ? redacted : undefined;
}

/**
 * The attachment-unavailable 409 is a typed domain result consumed by the
 * strict attachment decoder. Validate it against OpenAPI, then retain only the
 * metadata that decoder needs; all other errors use the generic redaction.
 */
export function projectSelfHostedErrorBody(
  method: string,
  path: string,
  status: number,
  value: unknown,
): Record<string, unknown> | undefined {
  validateDeclaredSelfHostedErrorResponse(method, path, status, value);
  const pathname = pathOnly(path);
  if (
    method.toUpperCase() === "POST"
    && status === 403
    && (
      pathname === "/v1/auth/signup"
      || pathname === "/v1/auth/login"
    )
    && isRecord(value)
  ) {
    // These two route contracts enumerate exact safe error/reason pairs. Keep
    // that approved human text after validation; arbitrary server detail and
    // every other route remain under the generic machine-only projection.
    return {
      error: value["error"],
      reason: value["reason"],
    };
  }
  if (
    method.toUpperCase() === "GET"
    && status === 409
    && /^\/v1\/messages\/[^/]+\/attachments\/\d+$/.test(pathname)
    && isRecord(value)
    && value["code"] === "attachment_content_unavailable"
  ) {
    const attachment = value["attachment"] as Record<string, unknown>;
    return {
      code: "attachment_content_unavailable",
      attachment: {
        filename: attachment["filename"],
        content_type: attachment["content_type"],
        size: attachment["size"],
      },
    };
  }
  return redactSelfHostedErrorBody(value);
}

export const projectSelfHostedMailErrorBody = projectSelfHostedErrorBody;
