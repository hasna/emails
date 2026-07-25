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

/**
 * Widen a generated interface's `message` property to `| null`.
 *
 * Anchored on the interface NAME and the property, not on the whole literal:
 * adding a sibling field to a response schema (e.g. the send-failure
 * `reason`/`provider_error`/`sent` triple) must not silently drop the
 * nullability the wire contract actually has. A brittle whole-literal needle is
 * what broke `bun run scripts/generate-selfhost-sdk.ts` on the first attempt at
 * the 2026-07-25 send-semantics fix.
 */
function nullableMessageProperty(
  source: string,
  interfaceName: string,
  messageType: string,
  label: string,
): string {
  const pattern = new RegExp(
    `(export interface ${escapeRegExp(interfaceName)} \\{[^{}]*?"message"\\??: ${escapeRegExp(messageType)})(\\s*[;}])`,
  );
  return replaceRequired(source, pattern, "$1 | null$2", label);
}

secureClientCode = replaceRequired(
  secureClientCode,
  "  apiKey?: string;\n",
  "  apiKey?: string;\n  /** Opaque emss_ user session (or bearer-compatible API key). */\n  bearerToken?: string;\n",
  "bearer option",
);
secureClientCode = replaceRequired(
  secureClientCode,
  "  private readonly apiKey: string | undefined;\n",
  "  private readonly apiKey: string | undefined;\n  private readonly bearerToken: string | undefined;\n",
  "bearer field",
);
secureClientCode = replaceRequired(
  secureClientCode,
  "    this.apiKey = options.apiKey;\n",
  "    this.apiKey = options.apiKey;\n    this.bearerToken = options.bearerToken;\n",
  "bearer assignment",
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
  "    const response = await this.fetchImpl(url.toString(), { ...opts.init, method, headers, body: payload, redirect: \"error\" });\n",
  "redirect rejection",
);
secureClientCode = replaceRequired(
  secureClientCode,
  `export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown) {
    super(message);
    this.name = "ApiError";
  }
}`,
  `export type SendIntentRecoveryState = "blocked" | "cancelled" | "none" | "pending" | "sending" | "sent" | "uncertain";

export interface SendIntentMessageProjection {
  id: string;
  send_state: SendIntentRecoveryState;
}

const SEND_INTENT_MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEND_INTENT_RECOVERY_STATES = new Set<SendIntentRecoveryState>([
  "blocked", "cancelled", "none", "pending", "sending", "sent", "uncertain",
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
secureClientCode = nullableMessageProperty(
  secureClientCode,
  "SendIntentLookup",
  "SendIntentMessage",
  "nullable send-intent lookup message",
);
secureClientCode = nullableMessageProperty(
  secureClientCode,
  "SendIntentCancellation",
  "SendIntentMessage",
  "nullable send-intent cancellation message",
);
secureClientCode = nullableMessageProperty(
  secureClientCode,
  "SendMessageError",
  "Message | SendIntentMessage",
  "nullable send failure message",
);

const header = `// @generated from src/server/self-hosted/openapi.ts by scripts/generate-selfhost-sdk.ts — DO NOT EDIT.
// Regenerate: bun run scripts/generate-selfhost-sdk.ts
`;
const out = join(root, "src", "selfhost.ts");
writeFileSync(out, header + secureClientCode);
console.log(`wrote ${out}`);
console.log(`operations: ${generated.operations.map((o) => o.functionName).join(", ")}`);
if (generated.warnings.length) console.log(`warnings:\n  ${generated.warnings.join("\n  ")}`);
