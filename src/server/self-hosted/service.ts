// HTTP request handler for the Emails self-hosted service.
//
// Surfaces operational probes (/health, /ready, /version)
// plus the authenticated, versioned /v1 API. Every /v1 route requires a valid
// Hasna API key (@hasna/contracts/auth) scoped to `emails:read` / `emails:write`.
//
// All data operations hit the operator-owned Postgres via the
// store, which wraps the product-owned storage utilities' typed client.

import type { ApiKeyVerifier } from "@hasna/contracts/auth";
import { createHash } from "node:crypto";
import { migrationAcceptsChecksum, type TypedQueryClient, type Migration } from "../../storage-kit/index.js";
import { checkHealth } from "../../storage-kit/index.js";
import {
  EmailsSelfHostedStore,
  IdempotencyKeyConflictError,
  SendIntentDeletionForbiddenError,
  SendIntentTombstonedError,
  CrossTenantReferenceError,
  InboundDomainRouteConflictError,
  AttachmentRepairIdempotencyConflictError,
  AttachmentRepairQuotaExceededError,
  AttachmentRepairReviewMismatchError,
  decodeMessagesCursor,
  decodeAttachmentsCursor,
  MAX_ATTACHMENT_BATCH_IDS,
  MESSAGE_FOLDERS,
  type MessageFolder,
  type TenantScopedStore,
  type MessageInput,
  type MessageListRecord,
  type MessageRecord,
  type DomainProvisioningPatch,
  type AddressProvisioningPatch,
  type AddressOwnershipPatch,
} from "./store.js";
import { SELF_HOSTED_SEND_ATTACHMENT_LIMITS } from "../../lib/send-attachment-limits.js";
import {
  MAX_ATTACHMENT_REPAIR_PAGE_ITEMS,
  normalizeAttachmentRepairManifestEntries,
  processCanonicalS3AttachmentRepairPage,
  resolveAttachmentRepairCanonicalBucket,
  type AttachmentRepairLedgerRun,
  type AttachmentRepairManifestEntry,
} from "./attachment-repair.js";
import { validateAttachmentRepairReviewedDryRun } from "./attachment-repair-maintenance.js";
import { emailsSelfHostedOpenApi } from "./openapi.js";
import { resourceSpecForPath, type SelfHostedResourceSpec } from "./resources.js";
import {
  handleSelfHostedResendWebhook,
  handleSelfHostedSesWebhook,
  type FetchS3Object,
} from "./webhooks.js";
import {
  RESEND_INBOUND_V1_WEBHOOK_PATH,
  SES_INBOUND_V1_WEBHOOK_PATH,
} from "../webhooks/receivers.js";
import { classifyProviderSendError, type SelfHostedSender } from "./sender.js";
import {
  isTenantOperator,
  resolveRequestContext,
  handleAuthRoutes,
  type RequestContext,
} from "./auth/service.js";
import type { AuthStore } from "./auth/store.js";
import type { RateLimiter } from "./auth/rate-limit.js";
import type { AuthMailerConfig } from "./auth/mailer.js";
import type { SelfHostedKeyStore } from "./keys.js";
import { canonicalSender } from "../../lib/email-address.js";
import { normalizeAttachmentByteLimit } from "../../lib/attachment-download.js";
import { canonicalizeSelfHostedPathname } from "../../lib/self-hosted-paths.js";

export {
  canonicalizeApiV1Pathname,
  canonicalizeClientDialectPathname,
} from "../../lib/self-hosted-paths.js";

interface ReadyResult {
  ok: boolean;
  latencyMs: number;
  pendingMigrations: string[];
  migrationIssues: string[];
}

const MAX_JSON_BODY_BYTES = 1024 * 1024;

class RequestBodyTooLargeError extends Error {}

/**
 * SELECT-only readiness: reachable AND every defined migration is recorded in
 * `schema_migrations`. Unlike the kit's `checkReady`, this never issues DDL, so
 * it works under the least-privileged app role (which has no CREATE on public).
 */
async function readinessCheck(deps: SelfHostedServiceDeps): Promise<ReadyResult> {
  const start = Date.now();
  try {
    const rows = await deps.client.many<{ id: string; checksum: string }>(`SELECT id, checksum FROM schema_migrations`);
    const expected = new Map(deps.migrations.map((migration) => [migration.id, migration.checksum]));
    const applied = new Map(rows.map((row) => [row.id, row.checksum]));
    const pending = deps.migrations.filter((migration) => !applied.has(migration.id)).map((migration) => migration.id);
    const drifted = rows
      .filter((row) => {
        const migration = deps.migrations.find((item) => item.id === row.id);
        return migration !== undefined && !migrationAcceptsChecksum(migration, row.checksum);
      })
      .map((row) => `checksum mismatch: ${row.id}`);
    const unknown = rows.filter((row) => !expected.has(row.id)).map((row) => `unknown migration: ${row.id}`);
    const migrationIssues = [...drifted, ...unknown];
    return {
      ok: pending.length === 0 && migrationIssues.length === 0,
      latencyMs: Date.now() - start,
      pendingMigrations: pending,
      migrationIssues,
    };
  } catch {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      pendingMigrations: [],
      migrationIssues: ["migration ledger unavailable"],
    };
  }
}

export interface SelfHostedServiceDeps {
  client: TypedQueryClient;
  store: EmailsSelfHostedStore;
  verifier: ApiKeyVerifier;
  sender: SelfHostedSender;
  migrations: readonly Migration[];
  version: string;
  // ---- multi-tenancy + auth (WI-2) ----
  authStore: AuthStore;
  keyStore: SelfHostedKeyStore;
  signingSecret: string;
  rateLimiter: RateLimiter;
  mailer: AuthMailerConfig;
  env?: NodeJS.ProcessEnv;
  /** Test/embedding seam; production falls back to the canonical S3 adapter. */
  attachmentRepair?: {
    processPage(
      store: TenantScopedStore,
      runId: string,
      limit: number,
    ): Promise<AttachmentRepairLedgerRun>;
  };
  /**
   * Test/embedding seams for the provider webhook receivers. Production leaves
   * these unset: S3 reads use the canonical client and SNS signatures are
   * verified against the fetched AWS signing certificate.
   */
  webhooks?: {
    fetchObject?: FetchS3Object;
    verifySns?: (body: Record<string, unknown>) => Promise<boolean>;
    fetchUrl?: (url: string) => Promise<unknown>;
    now?: () => string;
  };
}

const MODE = "self_hosted" as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function publicMessage(record: MessageRecord): Omit<MessageRecord, "idempotency_key" | "send_payload_hash"> {
  const { idempotency_key: _key, send_payload_hash: _hash, ...safe } = record;
  return safe;
}

function missingProviderProofResponse(record: MessageRecord): Response {
  return json(409, {
    error: "the send ledger says sent but has no provider message id; reconcile provider evidence before treating it as delivered",
    reason: "provider_proof_missing",
    sent: null,
    message: publicMessage(record),
    retry_safe: false,
    reconciliation_required: true,
  });
}

function sendIntentMessage(record: MessageRecord): { id: string; send_state: string } {
  return { id: record.id, send_state: record.send_state };
}

function publicAttachmentRepair(run: AttachmentRepairLedgerRun) {
  const { tenant_id: _tenantId, ...safe } = run;
  return safe;
}

async function processAttachmentRepairRun(
  deps: SelfHostedServiceDeps,
  store: TenantScopedStore,
  runId: string,
  limit: number,
): Promise<AttachmentRepairLedgerRun> {
  if (deps.attachmentRepair) {
    return deps.attachmentRepair.processPage(store, runId, limit);
  }
  return processCanonicalS3AttachmentRepairPage(
    deps.store,
    store,
    runId,
    limit,
    deps.env ?? process.env,
  );
}

function publicMessageListItem(record: MessageRecord | MessageListRecord): MessageListRecord {
  const {
    body_text: bodyText,
    body_html: _bodyHtml,
    idempotency_key: _key,
    send_payload_hash: _hash,
    headers: _headers,
    attachments,
    snippet: providedSnippet,
    attachment_count: providedAttachmentCount,
    ...safe
  } = record as MessageRecord & { snippet?: string | null; attachment_count?: number };
  const rawSnippet = typeof providedSnippet === "string"
    ? providedSnippet
    : typeof bodyText === "string"
      ? bodyText
      : "";
  const snippet = rawSnippet.replace(/\s+/g, " ").trim().slice(0, 140);
  const attachment_count =
    typeof providedAttachmentCount === "number"
      ? providedAttachmentCount
      : Array.isArray(attachments)
        ? attachments.length
        : 0;
  return { ...safe, snippet: snippet || null, attachment_count } as MessageListRecord;
}

function sendPayloadHash(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function decodeStrictBase64(value: string): Buffer {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("attachment content must be canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("attachment content must be canonical base64");
  return decoded;
}

const MIME_TYPE_RE = /^[A-Za-z0-9!#$&^_.+~-]+\/[A-Za-z0-9!#$&^_.+~-]+$/;

function safeHeaderValue(label: string, value: string): string {
  if (/[\x00-\x1F\x7F]/.test(value)) throw new Error(`${label} contains forbidden control characters`);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) throw new Error(`${label} contains non-well-formed Unicode`);
      index++;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      throw new Error(`${label} contains non-well-formed Unicode`);
    }
  }
  return value;
}

function parseIdempotencyKey(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key || key.length > 200) {
    return { ok: false, error: "idempotency_key is required and must be at most 200 characters" };
  }
  try {
    safeHeaderValue("idempotency_key", key);
  } catch {
    return { ok: false, error: "idempotency_key contains unsafe characters" };
  }
  return { ok: true, value: key };
}

function parseAttachmentRepairId(
  value: string,
): { ok: true; value: string } | { ok: false } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return { ok: false };
  }
  return ATTACHMENT_REPAIR_UUID_RE.test(decoded)
    ? { ok: true, value: decoded.toLowerCase() }
    : { ok: false };
}

const ATTACHMENT_REPAIR_UUID_RE =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ATTACHMENT_REPAIR_REVIEW_SHA256_RE = /^[0-9a-f]{64}$/;
const ATTACHMENT_REPAIR_REVIEW_FIELDS = [
  "reviewed_dry_run_id",
  "reviewed_dry_run_result_sha256",
] as const;

interface AttachmentRepairReviewProof {
  runId: string;
  resultSha256: string;
}

function invalidAttachmentRepairIdResponse(): Response {
  return json(400, {
    error: "attachment repair id must be a UUID",
    code: "invalid_attachment_repair_id",
  });
}

function invalidAttachmentRepairReviewResponse(): Response {
  return json(400, {
    error: "attachment repair reviewed dry-run proof is invalid",
    code: "invalid_repair_review",
  });
}

function attachmentRepairReviewMismatchResponse(): Response {
  return json(409, {
    error: "attachment repair reviewed dry-run proof does not match",
    code: "attachment_repair_review_mismatch",
  });
}

function parseAttachmentRepairReviewProof(
  body: Record<string, unknown>,
  apply: boolean,
):
  | { ok: true; proof?: AttachmentRepairReviewProof }
  | { ok: false; response: Response } {
  const present = ATTACHMENT_REPAIR_REVIEW_FIELDS.filter(
    (field) => Object.prototype.hasOwnProperty.call(body, field),
  );
  if (!apply) {
    return present.length === 0
      ? { ok: true }
      : { ok: false, response: invalidAttachmentRepairReviewResponse() };
  }
  if (present.length !== ATTACHMENT_REPAIR_REVIEW_FIELDS.length) {
    return { ok: false, response: invalidAttachmentRepairReviewResponse() };
  }
  const rawRunId = body.reviewed_dry_run_id;
  const resultSha256 = body.reviewed_dry_run_result_sha256;
  if (typeof rawRunId !== "string"
    || !ATTACHMENT_REPAIR_UUID_RE.test(rawRunId)
    || typeof resultSha256 !== "string"
    || !ATTACHMENT_REPAIR_REVIEW_SHA256_RE.test(resultSha256)) {
    return { ok: false, response: invalidAttachmentRepairReviewResponse() };
  }
  return {
    ok: true,
    proof: {
      runId: rawRunId.toLowerCase(),
      resultSha256,
    },
  };
}

function attachmentRepairNotConfiguredResponse(): Response {
  return json(503, {
    error: "attachment repair canonical source is not configured",
    code: "attachment_repair_not_configured",
  });
}

function unsupportedRequestFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  const allowlist = new Set(allowed);
  return Object.keys(body).filter((key) => !allowlist.has(key)).sort();
}

function sendLeaseExpired(record: MessageRecord, now = Date.now()): boolean {
  const started = record.send_started_at ? Date.parse(record.send_started_at) : NaN;
  const configured = Number(process.env["EMAILS_SEND_LEASE_SECONDS"] ?? "300");
  const leaseMs = (Number.isFinite(configured) && configured > 0 ? configured : 300) * 1000;
  return Number.isFinite(started) && now - started >= leaseMs;
}

/**
 * Parse an optional `daily_quota` field off an address request body.
 * `provided` is false when the key is absent (leave the column untouched); when
 * present it must be null (clear) or a non-negative integer.
 */
function parseDailyQuota(
  body: Record<string, unknown>,
): { provided: boolean; value: number | null; error?: string } {
  if (!("daily_quota" in body)) return { provided: false, value: null };
  const raw = body.daily_quota;
  if (raw === null) return { provided: true, value: null };
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return { provided: true, value: raw };
  }
  return { provided: true, value: null, error: "daily_quota must be a non-negative integer or null" };
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    throw new RequestBodyTooLargeError("request body exceeds the limit");
  }
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new RequestBodyTooLargeError("request body exceeds the limit");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function queryInt(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function queryCanonicalBoundedInt(
  url: URL,
  key: string,
  minimum: number,
  maximum: number,
): { value?: number; error?: string } {
  const raw = url.searchParams.get(key);
  if (raw === null) return {};
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    return { error: `${key} must be a canonical integer between ${minimum} and ${maximum}` };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return { error: `${key} must be a canonical integer between ${minimum} and ${maximum}` };
  }
  return { value };
}

function queryIsoDate(url: URL, key: string): { value?: string; error?: string } {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === "") return {};
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return { error: `${key} must be a valid ISO date` };
  return { value: new Date(time).toISOString() };
}

/**
 * Repeatable `?domain=` filter values (comma-splitting tolerated), normalized
 * to bare lowercase domains. Values are always bound SQL parameters.
 */
function queryDomains(url: URL): string[] | undefined {
  const domains = url.searchParams
    .getAll("domain")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  return domains.length > 0 ? domains : undefined;
}

/** Coerce a JSON body value into a string[] (array, comma/whitespace-tolerant). */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

/** Coerce a JSON body value into a plain object, else undefined. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Coerce a JSON body value into an array, else undefined. */
function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Optional string|null passthrough: undefined stays undefined. */
function asOptStringOrNull(value: unknown): string | null | undefined {
  return value === undefined ? undefined : (value as string | null);
}

/**
 * The four message columns only the send path may write.
 *
 * They are the send ledger: the idempotency fence, the payload hash the fence is
 * computed over, and the claim state and lease instant that make a send exactly-once.
 * A row carrying an `idempotency_key` is also undeletable
 * (`SendIntentDeletionForbiddenError`), so accepting one on a plain write would strand
 * the row as well as fabricate a fence.
 */
export const SEND_LEDGER_FIELDS = [
  "idempotency_key",
  "send_payload_hash",
  "send_state",
  "send_started_at",
] as const;

/**
 * The only two directions a message row may carry.
 *
 * Validated rather than passed through, because until the record route existed EVERY
 * write path pinned this: `POST /v1/messages` answers 409 for anything that is not
 * exactly `inbound`, `reserveSendIntent` forces `outbound`, and the webhook sinks set
 * `inbound` themselves. A route that accepts the value from a caller is the first one
 * that can store a typo, and a typo is not merely cosmetic: every reader classifies a
 * row as inbound with `lower(coalesce(direction,'')) <> 'outbound'`, while the outbound
 * daily-quota query compares `direction = 'outbound'` exactly — so `"outbund"` would be
 * filed as received mail AND excluded from the sender's quota, and an upsert would write
 * it over a good row.
 */
const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;

/**
 * Map a request body onto a message write, or name the field that is missing.
 *
 * ONE parser for both write routes (`POST /v1/messages` and `POST /v1/messages/record`)
 * so they cannot drift on how a field is spelled, how a direction is inferred, or what
 * a status defaults to. The routes differ in exactly one decision — whether a
 * non-inbound row may be recorded without being dispatched — and that decision stays
 * at the call site rather than being smuggled in here.
 */
function messageWriteInput(body: Record<string, unknown>): { input: MessageInput } | { error: string } {
  const from = String(body.from ?? body.from_addr ?? "").trim();
  if (!from) return { error: "from is required" };
  const rawTo = body.to ?? body.to_addrs;
  const to = Array.isArray(rawTo)
    ? rawTo.map((v) => String(v))
    : typeof rawTo === "string" && rawTo.trim()
      ? [rawTo.trim()]
      : [];
  if (to.length === 0) return { error: "to is required" };

  // Direction defaults to outbound in the store; any inbound signal marks it inbound so
  // the same body records both sent and received mail.
  const receivedAt = asOptStringOrNull(body.received_at);
  const directionRaw = body.direction === undefined ? undefined : String(body.direction);
  if (directionRaw !== undefined && !(MESSAGE_DIRECTIONS as readonly string[]).includes(directionRaw)) {
    return { error: `direction must be one of ${MESSAGE_DIRECTIONS.join(", ")}` };
  }
  const direction = directionRaw ?? (receivedAt || body.message_id || body.in_reply_to ? "inbound" : undefined);

  // An EMPTY source_id is not a fence and must not be stored as one. Left as `""` it
  // lands in the column, where the partial unique index `(tenant_id, source_id) WHERE
  // source_id IS NOT NULL` makes the SECOND such write a unique violation — a 500 for a
  // caller who asked for a plain create. `undefined` stores NULL, which is what "no
  // fence" means, and matches the client's own guard.
  const sourceId = body.source_id === undefined ? undefined : String(body.source_id) || undefined;

  return {
    input: {
      from_addr: from,
      to_addrs: to,
      cc_addrs:
        body.cc === undefined && body.cc_addrs === undefined ? undefined : asStringArray(body.cc ?? body.cc_addrs),
      subject: asOptStringOrNull(body.subject),
      body_text: body.text === undefined ? asOptStringOrNull(body.body_text) : asOptStringOrNull(body.text),
      body_html: body.html === undefined ? asOptStringOrNull(body.body_html) : asOptStringOrNull(body.html),
      status: body.status ? String(body.status) : undefined,
      provider_message_id: asOptStringOrNull(body.provider_message_id),
      direction,
      message_id: asOptStringOrNull(body.message_id),
      in_reply_to: asOptStringOrNull(body.in_reply_to),
      received_at: receivedAt,
      is_read: typeof body.is_read === "boolean" ? body.is_read : undefined,
      is_starred: typeof body.is_starred === "boolean" ? body.is_starred : undefined,
      labels: body.labels === undefined ? undefined : asStringArray(body.labels),
      headers: asObject(body.headers),
      attachments: asArray(body.attachments),
      source_id: sourceId,
    },
  };
}

/** Coerce a body value to string|null (null preserved) for a provisioning column. */
function provStr(value: unknown): string | null {
  return value === null ? null : String(value);
}

/**
 * Extract the domain provisioning fields PRESENT in a PATCH body (mirrors the
 * local domains provisioning columns). Absent keys are omitted so they stay
 * untouched; an explicit null clears the column. `nameservers_json` (or the
 * `nameservers` alias) is a string array.
 */
function extractDomainProvisioning(body: Record<string, unknown>): DomainProvisioningPatch {
  const p: DomainProvisioningPatch = {};
  if ("provisioning_status" in body) p.provisioning_status = String(body.provisioning_status);
  if ("purchase_provider" in body) p.purchase_provider = provStr(body.purchase_provider);
  if ("dns_provider" in body) p.dns_provider = String(body.dns_provider);
  if ("send_provider" in body) p.send_provider = provStr(body.send_provider);
  if ("cf_zone_id" in body) p.cf_zone_id = provStr(body.cf_zone_id);
  if ("registrar" in body) p.registrar = provStr(body.registrar);
  if ("nameservers_json" in body) p.nameservers_json = asStringArray(body.nameservers_json);
  else if ("nameservers" in body) p.nameservers_json = asStringArray(body.nameservers);
  if ("mail_from_domain" in body) p.mail_from_domain = provStr(body.mail_from_domain);
  if ("last_error" in body) p.last_error = provStr(body.last_error);
  if ("next_check_at" in body) p.next_check_at = provStr(body.next_check_at);
  return p;
}

/**
 * Extract the address ownership fields PRESENT in a PATCH body. Absent keys are
 * omitted (left untouched); an explicit null clears the column (the client's
 * unassign). This is how the self-hosted client persists `assignAddressOwner` /
 * `transferAddressOwner` / `unassignAddressOwner` over /v1/addresses/<id>.
 */
function extractAddressOwnership(body: Record<string, unknown>): AddressOwnershipPatch {
  const p: AddressOwnershipPatch = {};
  if ("owner_id" in body) p.owner_id = provStr(body.owner_id);
  if ("administrator_id" in body) p.administrator_id = provStr(body.administrator_id);
  return p;
}

/** Extract the address provisioning fields PRESENT in a PATCH body. */
function extractAddressProvisioning(body: Record<string, unknown>): AddressProvisioningPatch {
  const p: AddressProvisioningPatch = {};
  if ("domain_id" in body) p.domain_id = provStr(body.domain_id);
  if ("receive_strategy" in body) p.receive_strategy = provStr(body.receive_strategy);
  if ("forward_to" in body) p.forward_to = provStr(body.forward_to);
  if ("routing_rule_id" in body) p.routing_rule_id = provStr(body.routing_rule_id);
  if ("provisioning_status" in body) p.provisioning_status = String(body.provisioning_status);
  if ("last_validated_at" in body) p.last_validated_at = provStr(body.last_validated_at);
  if ("last_error" in body) p.last_error = provStr(body.last_error);
  if ("next_check_at" in body) p.next_check_at = provStr(body.next_check_at);
  return p;
}

interface AuthOk {
  ok: true;
  ctx: RequestContext;
  /** The tenant-scoped store — the ONLY data surface a handler is given. */
  store: TenantScopedStore;
}
interface AuthFail {
  ok: false;
  response: Response;
}

/**
 * Authenticate a /v1 data request. REPLACES the old single-key `authenticate()`:
 * resolves the credential to a tenant-bound context (session or api key) and
 * hands back a `store.forTenant(ctx.tenantId)`. A handler can therefore ONLY
 * touch data through the tenant-scoped store — tenant isolation is enforced by
 * the type system (design §6 Layer 1). The tenant is NEVER a path/query/body param.
 */
async function authenticate(
  deps: SelfHostedServiceDeps,
  req: Request,
  url: URL,
  requiredScopes: string[],
): Promise<AuthOk | AuthFail> {
  const resolved = await resolveRequestContext(deps, req, url, requiredScopes);
  if (!resolved.ok) return { ok: false, response: resolved.response };
  return { ok: true, ctx: resolved.ctx, store: deps.store.forTenant(resolved.ctx.tenantId) };
}

/**
 * Gate an operation that changes WHO may act inside the tenant, not merely what
 * data the tenant holds. `emails:write` is the ordinary data-write grant and
 * every role down to `member` holds it, so it must never be sufficient on its
 * own for a privilege-granting route: an interactive caller needs owner/admin,
 * and non-interactive automation needs the wildcard operator scope.
 */
/**
 * Apply a resource spec's `writeRequiresOperator` flag to a generic CRUD write.
 *
 * The generic `/v1/<resource>` matcher reaches the same columns the bespoke
 * handlers guard. Without this, role-gating a bespoke route (send-key minting,
 * address ownership) is decorative: the caller just uses the generic path
 * instead. Driven off the spec rather than a path list here, so a new
 * authority-bearing resource is gated where it is declared.
 */
function requireResourceWriteAuthority(auth: AuthOk, spec: SelfHostedResourceSpec): Response | null {
  if (!spec.writeRequiresOperator) return null;
  return requireTenantOperator(auth, `writing ${spec.path}`);
}

function requireTenantOperator(auth: AuthOk, operation = "attachment repair"): Response | null {
  return isTenantOperator(auth.ctx)
    ? null
    : json(403, {
        error: `${operation} requires a tenant owner, admin, or operator API key`,
        reason: "operator_required",
      });
}

/**
 * Resolve a `/v1/messages/{id...}` path segment that MAY be a short id PREFIX (the
 * id printed by `inbox list`) to a full row id, tenant-scoped. Returns a ready-made
 * error Response on ambiguity (409 `ambiguous_id`) or no match (404); otherwise the
 * resolved full id. A full id is returned unchanged, so exact-id behavior is
 * bit-for-bit preserved — a non-existent full id still 404s downstream when the
 * handler fetches the row. MUST be called after `authenticate` so resolution runs
 * through the caller's tenant-scoped store (never cross-tenant).
 */
async function resolveMessageIdOrError(
  store: TenantScopedStore,
  id: string,
): Promise<{ ok: true; id: string } | { ok: false; response: Response }> {
  const resolved = await store.resolveMessageId(id);
  if (resolved === null) return { ok: false, response: json(404, { error: "message not found" }) };
  if ("ambiguous" in resolved) {
    return { ok: false, response: json(409, { error: "ambiguous message id prefix", reason: "ambiguous_id" }) };
  }
  return { ok: true, id: resolved.id };
}

/**
 * The canonical HTTP surface of this service is `/v1/...`. The native client
 * targets `/api/v1/...`, so accept `/api/v1` as an ALIAS by stripping a single
 * leading `/api` segment: `/api/v1/...` then routes byte-for-byte as `/v1/...`.
 * Bare `/v1/...` is untouched (back-compat). Only the exact `/api/v1` prefix is
 * rewritten; any other path (including `/health`, `/openapi.json`, `/api/...`
 * that is not `/api/v1`) is returned unchanged.
 */
/**
 * The native client speaks a slightly different DIALECT than this service's
 * canonical `/v1` surface. It targets a few cloud-shaped segment names that map
 * 1:1 onto existing self-hosted handlers. Normalize those segments (AFTER the
 * `/api/v1` → `/v1` alias) so the client's paths route to the real handlers with
 * NO change of HTTP method or response shape (pure path canonicalization):
 *
 *   client dialect               canonical self-hosted route
 *   ------------------------     ---------------------------
 *   GET  /v1/auth/me         ->  GET    /v1/me
 *   GET  /v1/api-keys        ->  GET    /v1/keys        (list)
 *   POST /v1/api-keys        ->  POST   /v1/keys        (create)
 *   DELETE /v1/api-keys/{id} ->  DELETE /v1/keys/{id}   (delete)
 *   POST /v1/api-keys/{id}/revoke -> POST /v1/keys/{id}/revoke (revoke)
 *
 * Bare canonical `/v1/me` and `/v1/keys*` are untouched (back-compat). This is a
 * pure `string -> string` mapping so it stays trivially unit-testable and cannot
 * alter method or body. The `/v1/keys/{id}/revoke` POST target is served by the
 * auth router alongside the existing `DELETE /v1/keys/{id}`.
 */
/**
 * Route + handle a single request. Returns `null` when the path is not owned by
 * this service (so a caller can fall through to other handlers).
 */
export interface SelfHostedRequestContext {
  /** Socket peer address, e.g. `server.requestIP(req)?.address`. Anchors the
   * per-IP auth rate limits, which must never key on a client-supplied header. */
  socketAddress?: string | null;
}

export async function handleSelfHostedRequest(
  deps: SelfHostedServiceDeps,
  req: Request,
  context: SelfHostedRequestContext = {},
): Promise<Response | null> {
  const url = new URL(req.url);
  // Normalize the `/api/v1` alias to `/v1` ONCE, at this single entry point that
  // both computes the route path AND dispatches to the auth router
  // (`handleAuthRoutes`) and `resolveRequestContext` (the verifier path). Rewrite
  // the URL object in place so every downstream path check sees canonical `/v1`.
  const canonicalPathname = canonicalizeSelfHostedPathname(url.pathname);
  if (canonicalPathname !== url.pathname) url.pathname = canonicalPathname;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();

  // ---- operational probes (unauthenticated) ------------------------------
  if (path === "/health") {
    const health = await checkHealth(deps.client);
    return json(200, {
      status: "ok",
      version: deps.version,
      mode: MODE,
      name: "emails",
      db: { ok: health.ok, latencyMs: health.latencyMs },
    });
  }

  if (path === "/ready") {
    const ready = await readinessCheck(deps);
    return json(ready.ok ? 200 : 503, {
      status: ready.ok ? "ready" : "not_ready",
      version: deps.version,
      mode: MODE,
      db: { ok: ready.ok, latencyMs: ready.latencyMs },
      pendingMigrations: ready.pendingMigrations,
      migrationIssues: ready.migrationIssues,
    });
  }

  if (path === "/version") {
    return json(200, { status: "ok", version: deps.version, mode: MODE, name: "emails" });
  }

  if (path === "/openapi.json" || path === "/v1/openapi.json") {
    return json(200, { ...emailsSelfHostedOpenApi, info: { ...emailsSelfHostedOpenApi.info, version: deps.version } });
  }

  if (!path.startsWith("/v1/") && path !== "/v1") return null;

  // ---- /v1 (authenticated) -----------------------------------------------
  const read = ["emails:read"];
  const write = ["emails:write"];

  try {
    // ---- provider webhook receivers --------------------------------------
    // Claimed BEFORE everything else, for two reasons.
    //
    // 1. These are the ONLY /v1 routes a provider (AWS SNS, Resend) calls, and a
    //    provider holds no Hasna API key. They authenticate the CALLER
    //    cryptographically instead — an AWS SNS message signature against the
    //    fetched signing certificate plus an exact topic/account allowlist, or a
    //    Svix HMAC over the raw body. Both fail closed. They must therefore not
    //    pass through `authenticate`, and the tenant comes from the trusted
    //    envelope (never a body field) via the global inbound domain map.
    // 2. The generic resource matcher below only matches two path segments and
    //    would resolve `webhooks` as a resource name (404, since no such
    //    resource exists), the same hazard `send-keys/mint` and
    //    `send-keys/verify` are registered ahead of it to avoid.
    //
    // Everything they persist lands in the operator's Postgres through
    // `deps.store.forTenant(...)`; see ./webhooks.ts.
    if (path === SES_INBOUND_V1_WEBHOOK_PATH || path === RESEND_INBOUND_V1_WEBHOOK_PATH) {
      if (method !== "POST") return json(405, { error: "method not allowed" });
      const webhookDeps = {
        store: deps.store,
        env: deps.env ?? process.env,
        ...(deps.webhooks ?? {}),
      };
      return path === SES_INBOUND_V1_WEBHOOK_PATH
        ? await handleSelfHostedSesWebhook(webhookDeps, req)
        : await handleSelfHostedResendWebhook(webhookDeps, req);
    }

    // Auth / tenant / membership / key routes are claimed FIRST (they run their
    // own credential resolution + role gates). Returns null when not an auth path.
    const authResponse = await handleAuthRoutes(deps, req, url, { socketAddress: context.socketAddress ?? null });
    if (authResponse) return authResponse;

    // /v1/domains
    if (path === "/v1/domains") {
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        return json(200, { domains: await auth.store.listDomains({ limit: queryInt(url, "limit"), offset: queryInt(url, "offset") }) });
      }
      if (method === "POST") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const domain = String(body.domain ?? "").trim();
        if (!domain) return json(400, { error: "domain is required" });
        if (await auth.store.getDomainByName(domain)) return json(409, { error: `domain ${domain} already exists` });
        const created = await auth.store.createDomain({
          domain,
          status: body.status ? String(body.status) : undefined,
          provider: body.provider === undefined ? undefined : (body.provider as string | null),
          verified: typeof body.verified === "boolean" ? body.verified : undefined,
          notes: body.notes === undefined ? undefined : (body.notes as string | null),
        });
        return json(201, { domain: created });
      }
      return json(405, { error: "method not allowed" });
    }

    const domainMatch = path.match(/^\/v1\/domains\/([^/]+)$/);
    if (domainMatch) {
      const id = decodeURIComponent(domainMatch[1]!);
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        const rec = await auth.store.getDomain(id);
        return rec ? json(200, { domain: rec }) : json(404, { error: "domain not found" });
      }
      if (method === "PATCH" || method === "PUT") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        let rec = await auth.store.updateDomain(id, {
          status: body.status === undefined ? undefined : String(body.status),
          provider: body.provider === undefined ? undefined : (body.provider as string | null),
          verified: typeof body.verified === "boolean" ? body.verified : undefined,
          notes: body.notes === undefined ? undefined : (body.notes as string | null),
        });
        if (rec) {
          const prov = extractDomainProvisioning(body);
          if (Object.keys(prov).length > 0) rec = (await auth.store.applyDomainProvisioning(id, prov)) ?? rec;
        }
        return rec ? json(200, { domain: rec }) : json(404, { error: "domain not found" });
      }
      if (method === "DELETE") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        return (await auth.store.deleteDomain(id)) ? json(200, { deleted: true, id }) : json(404, { error: "domain not found" });
      }
      return json(405, { error: "method not allowed" });
    }

    // /v1/addresses
    if (path === "/v1/addresses") {
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        return json(200, { addresses: await auth.store.listAddresses({ limit: queryInt(url, "limit"), offset: queryInt(url, "offset") }) });
      }
      if (method === "POST") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const email = String(body.email ?? "").trim();
        if (!email || !email.includes("@")) return json(400, { error: "a valid email is required" });
        const quota = parseDailyQuota(body);
        if (quota.error) return json(400, { error: quota.error });
        const created = await auth.store.createAddress({
          email,
          display_name: body.display_name === undefined ? undefined : (body.display_name as string | null),
          status: body.status ? String(body.status) : undefined,
          verified: typeof body.verified === "boolean" ? body.verified : undefined,
          daily_quota: quota.provided ? quota.value : undefined,
        });
        return json(201, { address: created });
      }
      return json(405, { error: "method not allowed" });
    }

    const addressMatch = path.match(/^\/v1\/addresses\/([^/]+)$/);
    if (addressMatch) {
      const id = decodeURIComponent(addressMatch[1]!);
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        const rec = await auth.store.getAddress(id);
        return rec ? json(200, { address: rec }) : json(404, { error: "address not found" });
      }
      if (method === "PATCH" || method === "PUT") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        // Reassigning owner_id/administrator_id decides who may send as this
        // address — the same authority the send-key mint grants, so it takes the
        // same gate. Checked BEFORE any write so a refused request leaves no
        // partial update behind; the ordinary address fields stay writable with
        // plain `emails:write`.
        if ("owner_id" in body || "administrator_id" in body) {
          const operatorError = requireTenantOperator(auth, "reassigning address ownership");
          if (operatorError) return operatorError;
        }
        const quota = parseDailyQuota(body);
        if (quota.error) return json(400, { error: quota.error });
        let rec = await auth.store.updateAddress(id, {
          display_name: body.display_name === undefined ? undefined : (body.display_name as string | null),
          status: body.status === undefined ? undefined : String(body.status),
          verified: typeof body.verified === "boolean" ? body.verified : undefined,
          dailyQuotaSet: quota.provided,
          daily_quota: quota.value,
        });
        if (rec) {
          const prov = extractAddressProvisioning(body);
          if (Object.keys(prov).length > 0) rec = (await auth.store.applyAddressProvisioning(id, prov)) ?? rec;
          const own = extractAddressOwnership(body);
          if (Object.keys(own).length > 0) rec = (await auth.store.applyAddressOwnership(id, own)) ?? rec;
        }
        return rec ? json(200, { address: rec }) : json(404, { error: "address not found" });
      }
      if (method === "DELETE") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        return (await auth.store.deleteAddress(id)) ? json(200, { deleted: true, id }) : json(404, { error: "address not found" });
      }
      return json(405, { error: "method not allowed" });
    }

    if (path === "/v1/messages/counts") {
      if (method !== "GET") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, read);
      if (!auth.ok) return auth.response;
      return json(200, { counts: await auth.store.messageCounts({ domains: queryDomains(url) }) });
    }

    // /v1/messages/groups — the native client's folder-count source. Identical
    // data to /v1/messages/counts, but returned UNWRAPPED (a flat
    // `{ inbox, unread, starred, sent, archived, spam, trash, total }` object)
    // because the client decodes the counts at the top level of this response.
    // `?domain=` (repeatable) scopes the counts to mail addressed to those
    // recipient domains — the same filter contract as GET /v1/messages.
    if (path === "/v1/messages/groups") {
      if (method !== "GET") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, read);
      if (!auth.ok) return auth.response;
      return json(200, await auth.store.messageCounts({ domains: queryDomains(url) }));
    }

    // /v1/messages/threads — mail-view: subject-rolled-up conversation list.
    // Handled BEFORE the single-message matcher so "threads" is not read as an id.
    if (path === "/v1/messages/threads") {
      if (method !== "GET") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, read);
      if (!auth.ok) return auth.response;
      return json(200, {
        threads: await auth.store.listThreads({ limit: queryInt(url, "limit"), offset: queryInt(url, "offset") }),
      });
    }

    if (path === "/v1/messages/send-intents/lookup") {
      if (method !== "POST") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, read);
      if (!auth.ok) return auth.response;
      const body = await readJsonBody(req);
      const parsed = parseIdempotencyKey(body.idempotency_key);
      if (!parsed.ok) return json(400, { error: parsed.error });
      const result = await auth.store.lookupSendIntent(parsed.value);
      return json(200, {
        send_intent: {
          ...result,
          message: result.message ? sendIntentMessage(result.message) : null,
        },
      });
    }

    // Enumerate the intents whose provider outcome was never established. This
    // is the entry point for closing out an incident: without it an operator
    // cannot even find the messages that need a decision.
    if (path === "/v1/messages/send-intents/uncertain") {
      if (method !== "GET") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, read);
      if (!auth.ok) return auth.response;
      const records = await auth.store.listUncertainSendIntents({
        limit: queryInt(url, "limit"),
        offset: queryInt(url, "offset"),
      });
      return json(200, {
        uncertain: records.map(publicMessage),
        count: records.length,
      });
    }

    // Close out ONE uncertain intent against evidence the operator gathered
    // from the provider (a message id, a delivery event, a metric window).
    // Nothing here infers an outcome: the caller asserts it and the assertion,
    // its evidence and its author are persisted on the row.
    if (path === "/v1/messages/send-intents/reconcile") {
      if (method !== "POST") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, write);
      if (!auth.ok) return auth.response;
      const body = await readJsonBody(req);
      const messageId = String(body.message_id ?? "").trim();
      if (!messageId) return json(400, { error: "message_id is required" });
      const outcome = String(body.outcome ?? "").trim();
      if (outcome !== "sent" && outcome !== "not_sent") {
        return json(400, { error: "outcome must be 'sent' (it left the provider) or 'not_sent' (it did not)" });
      }
      const evidence = String(body.evidence ?? "").trim();
      if (!evidence) {
        return json(400, {
          error: "evidence is required: record WHAT proves this outcome (provider message id, delivery event, metric window)",
        });
      }
      const providerMessageId = typeof body.provider_message_id === "string" ? body.provider_message_id.trim() : "";
      if (outcome === "sent" && !providerMessageId) {
        return json(400, { error: "provider_message_id is required when reconciling an intent as sent" });
      }
      // Same resolution as every other message route: accept a short prefix and
      // answer 404/409 for an unknown or ambiguous id instead of letting a
      // malformed value reach the uuid column as a 500.
      const resolvedId = await resolveMessageIdOrError(auth.store, messageId);
      if (!resolvedId.ok) return resolvedId.response;
      const existing = await auth.store.getMessage(resolvedId.id);
      if (!existing) return json(404, { error: "message not found" });
      if (existing.send_state !== "uncertain") {
        // Refuse rather than overwrite: only an unknown outcome may be decided.
        return json(409, {
          error: `only an 'uncertain' send intent can be reconciled; this one is '${existing.send_state}'`,
          reconciled: false,
          message: publicMessage(existing),
        });
      }
      let record;
      try {
        record = await auth.store.reconcileUncertainSendIntent(resolvedId.id, {
          outcome,
          providerMessageId: providerMessageId || null,
          evidence,
          // Who asserted the outcome — an opaque principal reference, never a
          // credential. `kid` is the API key id, not the key material.
          resolvedBy: auth.ctx.principalType === "user"
            ? `user:${auth.ctx.userId ?? "unknown"}`
            : `apikey:${auth.ctx.kid ?? "unknown"}`,
        });
      } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : "reconciliation rejected" });
      }
      if (!record) {
        // Lost a race with a concurrent reconcile/send.
        const latest = await auth.store.getMessage(resolvedId.id);
        return json(409, {
          error: "the send intent stopped being uncertain before it could be reconciled; re-read it and decide again",
          reconciled: false,
          ...(latest ? { message: publicMessage(latest) } : {}),
        });
      }
      return json(200, { reconciled: true, outcome, message: publicMessage(record) });
    }

    if (path === "/v1/messages/send-intents/cancel") {
      if (method !== "POST") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, write);
      if (!auth.ok) return auth.response;
      const body = await readJsonBody(req);
      const parsed = parseIdempotencyKey(body.idempotency_key);
      if (!parsed.ok) return json(400, { error: parsed.error });
      const result = await auth.store.cancelSendIntent(parsed.value);
      return json(200, {
        cancellation: {
          ...result,
          message: result.message ? sendIntentMessage(result.message) : null,
        },
      });
    }

    // /v1/messages/send — the only outbound create path. It invokes the
    // operator-selected provider only after atomically persisting and claiming
    // an idempotent send intent.
    if (path === "/v1/messages/send") {
      if (method !== "POST") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, write);
      if (!auth.ok) return auth.response;
      const body = await readJsonBody(req);
      const rawFrom = String(body.from ?? "").trim();
      const rawTo = asStringArray(body.to);
      if (!rawFrom) return json(400, { error: "from is required" });
      if (rawTo.length === 0) return json(400, { error: "to is required" });
      const from = canonicalSender(rawFrom);
      const rawCc = asStringArray(body.cc);
      const rawBcc = asStringArray(body.bcc);
      const parsedRecipients = [...rawTo, ...rawCc, ...rawBcc].map(canonicalSender);
      if (!from || parsedRecipients.some((value) => value === null)) {
        return json(400, { error: "from, to, cc, and bcc must each contain one valid mailbox" });
      }
      const to = parsedRecipients.slice(0, rawTo.length) as string[];
      const cc = parsedRecipients.slice(rawTo.length, rawTo.length + rawCc.length) as string[];
      const bcc = parsedRecipients.slice(rawTo.length + rawCc.length) as string[];
      const subject = String(body.subject ?? "").trim();
      if (!subject) return json(400, { error: "subject is required" });

      const parsedIdempotencyKey = parseIdempotencyKey(body.idempotency_key);
      if (!parsedIdempotencyKey.ok) return json(400, { error: parsedIdempotencyKey.error });
      const idempotencyKey = parsedIdempotencyKey.value;
      const rawAttachments = asArray(body.attachments) ?? [];
      if (rawAttachments.length > SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxFiles) {
        return json(400, { error: `at most ${SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxFiles} inline attachments are allowed` });
      }
      let attachments: Array<{ filename: string; content: string; content_type: string }>;
      try {
        safeHeaderValue("from", from);
        for (const value of [...to, ...cc, ...bcc]) safeHeaderValue("recipient address", value);
        safeHeaderValue("subject", subject);
        if (typeof body.reply_to === "string") safeHeaderValue("reply_to", body.reply_to);
        let totalAttachmentBytes = 0;
        attachments = rawAttachments.map((value, index) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`attachment ${index} must be an object`);
          const item = value as Record<string, unknown>;
          const content = typeof item.content === "string" ? item.content : "";
          const bytes = decodeStrictBase64(content).byteLength;
          totalAttachmentBytes += bytes;
          if (!content || bytes > SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxBytesPerFile) {
            throw new Error(`attachment ${index} requires base64 content no larger than 512KiB`);
          }
          if (totalAttachmentBytes > SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxTotalBytes) {
            throw new Error("inline attachments may total at most 768KiB");
          }
          const filename = safeHeaderValue("attachment filename", String(item.filename ?? `attachment-${index + 1}`));
          if (!filename.trim() || filename.length > 255) throw new Error(`attachment ${index} filename must be 1-255 characters`);
          const contentType = safeHeaderValue("attachment content_type", String(item.content_type ?? "application/octet-stream"));
          if (!MIME_TYPE_RE.test(contentType)) throw new Error(`attachment ${index} content_type must be a safe type/subtype token`);
          return {
            filename,
            content,
            content_type: contentType,
          };
        });
      } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : "invalid attachment" });
      }
      const payload = {
        from,
        to,
        cc,
        bcc,
        reply_to: typeof body.reply_to === "string" ? body.reply_to : null,
        subject,
        text: typeof body.text === "string" ? body.text : null,
        html: typeof body.html === "string" ? body.html : null,
        attachments,
        provider: deps.sender.provider,
      };
      const sendKeyToken = typeof body.send_key === "string"
        ? body.send_key.trim()
        : req.headers.get("x-emails-send-key")?.trim() ?? "";
      let reserved;
      try {
        reserved = await auth.store.reserveSendIntent({
          direction: "outbound",
          from_addr: from,
          to_addrs: to,
          cc_addrs: cc,
          subject,
          body_text: payload.text,
          body_html: payload.html,
          attachments: attachments.map(({ filename, content_type, content }) => ({
            filename,
            content_type,
            size: Buffer.byteLength(content, "base64"),
          })),
          idempotency_key: idempotencyKey,
          send_payload_hash: sendPayloadHash(payload),
        });
      } catch (error) {
        if (error instanceof IdempotencyKeyConflictError) {
          return json(409, { error: error.message, retry_safe: false });
        }
        if (error instanceof SendIntentTombstonedError) {
          return json(409, {
            error: error.message,
            tombstoned: true,
            message: error.record ? sendIntentMessage(error.record) : null,
            retry_safe: false,
          });
        }
        throw error;
      }

      if (!reserved.created) {
        if (reserved.record.send_state === "sent") {
          if (!reserved.record.provider_message_id?.trim()) {
            return missingProviderProofResponse(reserved.record);
          }
          return json(200, {
            message: publicMessage(reserved.record),
            provider: deps.sender.provider,
            idempotent_replay: true,
            // The original attempt succeeded: say so at the top level, exactly
            // like a fresh success, so callers have ONE place to check.
            sent: true,
            provider_message_id: reserved.record.provider_message_id,
          });
        }
        if (reserved.record.send_state === "sending") {
          if (sendLeaseExpired(reserved.record)) {
            const uncertain = await auth.store.markSendUncertain(reserved.record.id).catch(() => null);
            return json(409, {
              error: "send lease expired with an uncertain provider outcome; reconcile before retrying",
              message: publicMessage(uncertain ?? reserved.record),
              retry_safe: false,
            });
          }
          return json(202, { message: publicMessage(reserved.record), provider: deps.sender.provider, in_progress: true });
        }
        if (reserved.record.send_state === "blocked") {
          return json(409, {
            error: "send was blocked by outbound policy",
            reason: String(reserved.record.headers?.["policy_denial"] ?? "policy_denied"),
            message: publicMessage(reserved.record),
            retry_safe: false,
          });
        }
        if (reserved.record.send_state === "failed") {
          // A definitive provider reject sent NOTHING, so the same idempotency
          // key may retry — on the SAME ledger row (never a duplicate). If the
          // re-arm itself fails, that is still PRE-provider: nothing was sent,
          // and the response must say so instead of a generic 500 (which reads
          // as "outcome unknown" — the exact ambiguity behind the incident).
          let rearmed: MessageRecord | null = null;
          try {
            rearmed = await auth.store.rearmFailedSendIntent(reserved.record.id);
          } catch (error) {
            console.error("[emails-self-hosted] failed to re-arm a rejected send intent", {
              message_id: reserved.record.id,
              error: error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError",
            });
            return json(503, {
              error: "could not re-arm the previously rejected send intent; NOTHING was sent — retry later",
              reason: "rearm_failed",
              sent: false,
              message: publicMessage(reserved.record),
              retry_safe: true,
            });
          }
          if (rearmed) reserved = { record: rearmed, created: false };
        }
        if (reserved.record.send_state !== "pending") {
          return json(409, {
            error: "send outcome is uncertain; reconcile the provider message before any retry",
            message: publicMessage(reserved.record),
            retry_safe: false,
          });
        }
      }

      const policy = await auth.store.evaluateOutboundPolicy({
        from,
        recipients: [...to, ...cc, ...bcc],
        sendKeyToken: sendKeyToken || null,
        allowTenantWideSend:
          auth.ctx.principalType === "apikey" || auth.ctx.role === "owner" || auth.ctx.role === "admin",
      });
      if (!policy.allowed) {
        const blocked = await auth.store.markSendBlocked(reserved.record.id, policy.code).catch(() => null);
        return json(policy.status, {
          error: policy.message,
          reason: policy.code,
          message: publicMessage(blocked ?? reserved.record),
          retry_safe: false,
        });
      }

      const claimed = await auth.store.claimSendIntent(reserved.record.id);
      if (!claimed) {
        const latest = await auth.store.getMessage(reserved.record.id);
        if (latest?.send_state === "sent") {
          if (!latest.provider_message_id?.trim()) {
            return missingProviderProofResponse(latest);
          }
          return json(200, {
            message: publicMessage(latest),
            provider: deps.sender.provider,
            idempotent_replay: true,
            sent: true,
            provider_message_id: latest.provider_message_id,
          });
        }
        if (latest?.send_state === "cancelled") {
          return json(409, {
            error: "send intent is cancelled and cannot be sent",
            tombstoned: true,
            message: sendIntentMessage(latest),
            retry_safe: false,
          });
        }
        const recovery = await auth.store.lookupSendIntent(idempotencyKey);
        if (recovery.tombstoned && !recovery.reconciliation_required) {
          return json(409, {
            error: "send intent is cancelled and cannot be sent",
            tombstoned: true,
            message: recovery.message ? sendIntentMessage(recovery.message) : null,
            retry_safe: false,
          });
        }
        return json(202, {
          message: publicMessage(latest ?? reserved.record),
          provider: deps.sender.provider,
          in_progress: true,
        });
      }

      let messageId: string;
      try {
        messageId = await deps.sender.send({
          provider_id: `self-hosted-${deps.sender.provider}`,
          from,
          to,
          cc: cc.length ? cc : undefined,
          bcc: bcc.length ? bcc : undefined,
          reply_to: typeof body.reply_to === "string" ? body.reply_to : undefined,
          subject,
          text: typeof body.text === "string" ? body.text : undefined,
          html: typeof body.html === "string" ? body.html : undefined,
          attachments: attachments.length ? attachments : undefined,
        });
      } catch (error) {
        // NEVER swallow the provider error (the 2026-07-25 incident): classify
        // it, log it, and answer with what is actually KNOWN about the send.
        const outcome = classifyProviderSendError(error);
        console.error("[emails-self-hosted] provider send failed", {
          message_id: claimed.id,
          provider: deps.sender.provider,
          outcome: outcome.kind,
          provider_error: outcome.providerErrorName,
          http_status: outcome.httpStatus ?? null,
          detail: outcome.detail,
        });
        if (outcome.kind === "rejected") {
          // The provider REFUSED the request (4xx): nothing was sent. This is
          // a definitive failure — not "uncertain", and not a 502.
          const failed = await auth.store.markSendFailed(claimed.id, outcome.providerErrorName).catch(() => null);
          return json(422, {
            error: `the provider rejected this message and NOTHING was sent — ${outcome.providerErrorName}: ${outcome.detail}`,
            reason: "provider_rejected",
            provider_error: outcome.providerErrorName,
            sent: false,
            message: publicMessage(failed ?? claimed),
            retry_safe: true,
          });
        }
        const uncertain = await auth.store.markSendUncertain(claimed.id).catch(() => null);
        return json(502, {
          error: `the provider call failed without a definitive outcome (${outcome.providerErrorName}: ${outcome.detail}); ` +
            "the message may or may not have been sent — reconcile the provider before retrying",
          reason: "provider_outcome_uncertain",
          provider_error: outcome.providerErrorName,
          sent: null,
          message: publicMessage(uncertain ?? claimed),
          retry_safe: false,
          reconciliation_required: true,
        });
      }
      try {
        const completed = await auth.store.completeSendIntent(claimed.id, messageId);
        // `sent` + `provider_message_id` sit at the top level on EVERY response
        // where the provider accepted the message (here, on idempotent replays,
        // and on the finalization-failure path below), so a client never has to
        // guess what happened from the HTTP status alone.
        return json(202, {
          message: publicMessage(completed),
          provider: deps.sender.provider,
          sent: true,
          provider_message_id: messageId,
        });
      } catch (error) {
        // The provider ACCEPTED the message — it was sent. A post-send ledger
        // failure must therefore surface as SUCCESS with a warning: presenting
        // it as an error is what made operators retry and triple-send real
        // client mail on 2026-07-25.
        console.error("[emails-self-hosted] ledger finalization failed after provider accept", {
          message_id: claimed.id,
          provider: deps.sender.provider,
          provider_message_id: messageId,
          error: error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError",
        });
        // The provider id is the ONLY evidence this message left. Persist it on
        // the parked row: `emails log`, the uncertain queue and
        // `reconcile --outcome sent` all read it from there, and an uncertain
        // row without it can only be closed as `not_sent` — filing a delivered
        // message as failed.
        const uncertain = await auth.store.markSendUncertain(claimed.id, messageId).catch(() => null);
        return json(202, {
          message: publicMessage(uncertain ?? claimed),
          provider: deps.sender.provider,
          provider_message_id: messageId,
          sent: true,
          warning: "the provider ACCEPTED this message (it was sent) but recording the final state failed; " +
            "do NOT retry the send — reconcile the ledger row instead",
          retry_safe: false,
        });
      }
    }

    // /v1/messages — inbound import and ledger reads. Outbound writes must use
    // /v1/messages/send so the provider invocation cannot be bypassed.
    if (path === "/v1/messages") {
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        const directionValue = url.searchParams.get("direction")?.trim().toLowerCase();
        const direction = directionValue === "inbound" || directionValue === "outbound" ? directionValue : undefined;
        const since = queryIsoDate(url, "since");
        if (since.error) return json(400, { error: since.error });
        const folderValue = url.searchParams.get("folder")?.trim().toLowerCase();
        if (folderValue && !MESSAGE_FOLDERS.includes(folderValue as MessageFolder)) {
          return json(400, { error: `folder must be one of ${MESSAGE_FOLDERS.join(", ")}` });
        }
        const cursor = url.searchParams.get("cursor")?.trim() || undefined;
        if (cursor && decodeMessagesCursor(cursor) === null) {
          return json(400, { error: "cursor is not a valid pagination cursor" });
        }
        const offset = queryInt(url, "offset");
        if (!cursor && offset !== undefined && offset > 100_000) {
          return json(400, { error: "offset is limited to 100000; use cursor pagination for deep pages" });
        }
        const page = await auth.store.listMessages({
          limit: queryInt(url, "limit"),
          offset,
          direction,
          folder: (folderValue as MessageFolder | undefined) || undefined,
          cursor,
          domains: queryDomains(url),
          to: url.searchParams.get("to") ?? undefined,
          from: url.searchParams.get("from") ?? undefined,
          subject: url.searchParams.get("subject") ?? undefined,
          // `q` is the native-client spelling; `search` is the original one.
          search: url.searchParams.get("q") ?? url.searchParams.get("search") ?? undefined,
          since: since.value,
        });
        return json(200, {
          messages: page.items.map(publicMessageListItem),
          next_cursor: page.next_cursor,
        });
      }
      if (method === "POST") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const parsed = messageWriteInput(body);
        if ("error" in parsed) return json(400, { error: parsed.error });
        const input = parsed.input;

        // KNOWN AND DELIBERATELY UNCHANGED: this route still ACCEPTS AND DROPS the four
        // send-ledger fields, where /v1/messages/record refuses them. Now that both share
        // `messageWriteInput` the refusal is one line from covering both, and it should —
        // "accepted and dropped" is the exact failure this program exists to delete. It is
        // not done here because it is a contract change to a route that has shipped for
        // some time, which belongs in its own change with its own 400 declared on the
        // published document, not as a side effect of adding a different route.
        //
        // THE INBOUND-ONLY GUARD, and it stays. This route may not create an outbound
        // row, because an outbound row that never went through the send path has no
        // provider invocation behind it and this route cannot make one. A caller that
        // means "record a row without sending it" has POST /v1/messages/record;
        // loosening this condition instead would make the send path bypassable.
        if (input.direction !== "inbound") {
          return json(409, { error: "outbound messages must be sent through POST /v1/messages/send" });
        }

        // With a source_id the write is idempotent (upsert): re-running an
        // import updates the existing row instead of creating a duplicate.
        if (input.source_id) {
          const { record, inserted } = await auth.store.upsertMessage(input);
          return json(inserted ? 201 : 200, { message: publicMessage(record) });
        }
        const created = await auth.store.createMessage(input);
        return json(201, { message: publicMessage(created) });
      }
      return json(405, { error: "method not allowed" });
    }

    // /v1/messages/record — RECORD a message row in either direction WITHOUT
    // dispatching it.
    //
    // THE GAP THIS CLOSES. Until this route existed there was no way to record an
    // outbound message at all: POST /v1/messages answers 409 for anything not inbound,
    // and POST /v1/messages/send mails what it records. So a caller importing mail that
    // was already sent elsewhere, reconciling a provider's log, or seeding a mailbox had
    // no surface — and the store seam's `createMessage`/`upsertMessage` are UNGATED, so
    // no capability could be declared false and no refusal was legal. An operation with
    // neither a route nor a legal refusal is the one shape the seam has no answer for.
    //
    // IT IS NOT A WAY AROUND THE SEND GUARD, and the two properties that keep it honest
    // are here rather than in a comment on the guard:
    //   * it never touches `deps.sender`, so nothing is transmitted;
    //   * it REFUSES all four send-ledger fields, so a row recorded here can never carry
    //     the fence a real send produces, and can never be mistaken for one.
    // POST /v1/messages keeps its 409 unchanged.
    //
    // Registered BEFORE the `/v1/messages/{id}` matcher below, which would otherwise
    // read "record" as an abbreviated message id.
    if (path === "/v1/messages/record") {
      if (method !== "POST") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, write);
      if (!auth.ok) return auth.response;
      const body = await readJsonBody(req);
      // Refused, not dropped. A caller who sets one of these and reads a 201 believes a
      // fence was recorded when none was — and a row carrying an idempotency_key cannot
      // be deleted, so a dropped field would be the kinder half of the outcome.
      const ledgerFields = SEND_LEDGER_FIELDS.filter((field) => field in body);
      if (ledgerFields.length > 0) {
        return json(400, {
          error: `${ledgerFields.join(", ")} may only be written by POST /v1/messages/send`,
          reason: "send_ledger_field",
        });
      }
      const parsed = messageWriteInput(body);
      if ("error" in parsed) return json(400, { error: parsed.error });
      // TENANCY: `auth.store` is already bound to the caller's tenant and stamps
      // `tenant_id` on the insert from its own scope — never from the body, and the
      // upsert's conflict target is `(tenant_id, source_id)`, so a replay can never
      // match another tenant's row.
      if (parsed.input.source_id) {
        const { record, inserted } = await auth.store.upsertMessage(parsed.input);
        return json(inserted ? 201 : 200, { message: publicMessage(record) });
      }
      const created = await auth.store.createMessage(parsed.input);
      return json(201, { message: publicMessage(created) });
    }

    const attachmentMatch = path.match(/^\/v1\/messages\/([^/]+)\/attachments\/(\d+)$/);
    if (attachmentMatch) {
      if (method !== "GET") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, read);
      if (!auth.ok) return auth.response;
      // Attachment bytes are the deliberate-download boundary. Unlike ordinary
      // message reads, this route never resolves prefixes: callers must present
      // the exact tenant-scoped message id before any attachment lookup.
      const messageId = decodeURIComponent(attachmentMatch[1]!);
      const message = await auth.store.getMessage(messageId);
      if (!message || message.id !== messageId) {
        return json(404, { error: "message not found", code: "message_not_found" });
      }
      let maxBytes: number;
      try {
        const rawLimit = url.searchParams.get("max_bytes");
        maxBytes = normalizeAttachmentByteLimit(rawLimit === null ? undefined : Number(rawLimit));
      } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : "invalid attachment byte limit", code: "invalid_attachment_limit" });
      }
      const attachment = await auth.store.getMessageAttachment(
        messageId,
        Number(attachmentMatch[2]),
        maxBytes,
      );
      if (!attachment) return json(404, { error: "attachment not found", code: "attachment_not_found" });
      if (attachment.state === "content_unavailable") {
        return json(409, {
          error: "attachment content is not stored",
          code: "attachment_content_unavailable",
          attachment: attachment.attachment,
        });
      }
      if (attachment.state === "invalid") {
        const tooLarge = /byte limit/i.test(attachment.reason);
        return json(tooLarge ? 413 : 422, {
          error: attachment.reason,
          code: tooLarge ? "attachment_too_large" : "invalid_attachment_payload",
        });
      }
      return json(200, { attachment: attachment.attachment });
    }

    // /v1/messages/{id}/raw — mail-view: reconstructed raw MIME for a message.
    const rawMatch = path.match(/^\/v1\/messages\/([^/]+)\/raw$/);
    if (rawMatch) {
      if (method !== "GET") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, read);
      if (!auth.ok) return auth.response;
      const resolved = await resolveMessageIdOrError(auth.store, decodeURIComponent(rawMatch[1]!));
      if (!resolved.ok) return resolved.response;
      const raw = await auth.store.getMessageRaw(resolved.id);
      return raw ? json(200, raw) : json(404, { error: "message not found" });
    }

    const messageMatch = path.match(/^\/v1\/messages\/([^/]+)$/);
    if (messageMatch) {
      const id = decodeURIComponent(messageMatch[1]!);
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        const resolved = await resolveMessageIdOrError(auth.store, id);
        if (!resolved.ok) return resolved.response;
        const rec = await auth.store.getMessage(resolved.id);
        return rec ? json(200, { message: publicMessage(rec) }) : json(404, { error: "message not found" });
      }
      if (method === "PATCH" || method === "PUT") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const resolved = await resolveMessageIdOrError(auth.store, id);
        if (!resolved.ok) return resolved.response;
        const body = await readJsonBody(req);
        const rec = await auth.store.updateMessageStatus(resolved.id, {
          status: body.status === undefined ? undefined : String(body.status),
          provider_message_id: body.provider_message_id === undefined ? undefined : (body.provider_message_id as string | null),
          is_read: typeof body.is_read === "boolean" ? body.is_read : undefined,
          is_starred: typeof body.is_starred === "boolean" ? body.is_starred : undefined,
          archived: typeof body.archived === "boolean" ? body.archived : undefined,
          add_label: typeof body.add_label === "string" ? body.add_label : undefined,
          remove_label: typeof body.remove_label === "string" ? body.remove_label : undefined,
        });
        return rec ? json(200, { message: publicMessage(rec) }) : json(404, { error: "message not found" });
      }
      if (method === "DELETE") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const resolved = await resolveMessageIdOrError(auth.store, id);
        if (!resolved.ok) return resolved.response;
        try {
          return (await auth.store.deleteMessage(resolved.id))
            ? json(200, { deleted: true, id: resolved.id })
            : json(404, { error: "message not found" });
        } catch (error) {
          if (error instanceof SendIntentDeletionForbiddenError) {
            return json(409, {
              error: error.message,
              message: sendIntentMessage(error.record),
              retry_safe: false,
            });
          }
          throw error;
        }
      }
      return json(405, { error: "method not allowed" });
    }

    // /v1/mailboxes — mail-view: registered addresses as mailboxes, each with an
    // inbound folder rollup, plus the global folder counts.
    if (path === "/v1/mailboxes") {
      if (method !== "GET") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, read);
      if (!auth.ok) return auth.response;
      const { mailboxes, counts } = await auth.store.listMailboxes();
      return json(200, { mailboxes, counts });
    }

    // Explicit, bounded repair manifests only: the service never lists or scans
    // an S3 bucket. Each entry retains the existing exact canary contract and is
    // checkpointed before the next object is attempted.
    if (path === "/v1/attachments/repairs") {
      if (method !== "POST") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, write);
      if (!auth.ok) return auth.response;
      const operatorError = requireTenantOperator(auth);
      if (operatorError) return operatorError;
      const body = await readJsonBody(req);
      const unsupported = unsupportedRequestFields(
        body,
        [
          "idempotency_key",
          "apply",
          "limit",
          "entries",
          ...ATTACHMENT_REPAIR_REVIEW_FIELDS,
        ],
      );
      if (unsupported.length > 0) {
        return json(400, {
          error: `attachment repair request contains unsupported fields: ${unsupported.join(", ")}`,
          code: "invalid_repair_body",
        });
      }
      const key = parseIdempotencyKey(body.idempotency_key);
      if (!key.ok) return json(400, { error: key.error, code: "invalid_idempotency_key" });
      if (body.apply !== undefined && typeof body.apply !== "boolean") {
        return json(400, { error: "apply must be a boolean", code: "invalid_apply" });
      }
      const apply = body.apply === true;
      const reviewedProof = parseAttachmentRepairReviewProof(body, apply);
      if (!reviewedProof.ok) return reviewedProof.response;
      if (!Array.isArray(body.entries)) {
        return json(400, { error: "entries must be an array", code: "invalid_repair_manifest" });
      }
      let entries: AttachmentRepairManifestEntry[];
      try {
        entries = normalizeAttachmentRepairManifestEntries(
          body.entries as AttachmentRepairManifestEntry[],
        );
      } catch (error) {
        return json(400, {
          error: error instanceof Error ? error.message : "invalid attachment repair manifest",
          code: "invalid_repair_manifest",
        });
      }
      const rawLimit = body.limit ?? MAX_ATTACHMENT_REPAIR_PAGE_ITEMS;
      if (!Number.isSafeInteger(rawLimit)
        || Number(rawLimit) <= 0
        || Number(rawLimit) > MAX_ATTACHMENT_REPAIR_PAGE_ITEMS) {
        return json(400, {
          error: `limit must be between 1 and ${MAX_ATTACHMENT_REPAIR_PAGE_ITEMS}`,
          code: "invalid_repair_limit",
        });
      }
      try {
        const canonicalBucket = resolveAttachmentRepairCanonicalBucket(
          deps.env ?? process.env,
        );
        if (!canonicalBucket) {
          return attachmentRepairNotConfiguredResponse();
        }
        if (reviewedProof.proof) {
          const proof = reviewedProof.proof;
          const reviewedRun = await auth.store.getAttachmentRepairRun(
            proof.runId,
          );
          const reviewed = validateAttachmentRepairReviewedDryRun(
            reviewedRun,
            {
              tenantId: auth.ctx.tenantId,
              runId: proof.runId,
              resultSha256: proof.resultSha256,
            },
          );
          if (!reviewed.ok) return attachmentRepairReviewMismatchResponse();
          const matches = await auth.store.attachmentRepairRunMatchesManifest(
            proof.runId,
            {
              canonicalBucket,
              apply: false,
              entries,
            },
          );
          if (!matches) return attachmentRepairReviewMismatchResponse();
        }
        const run = await auth.store.createOrGetAttachmentRepairRun({
          idempotencyKey: key.value,
          canonicalBucket,
          apply,
          reviewedDryRunId: reviewedProof.proof?.runId,
          entries,
        });
        const updated = await processAttachmentRepairRun(
          deps,
          auth.store,
          run.id,
          Number(rawLimit),
        );
        return json(201, {
          repair: publicAttachmentRepair(updated),
          max_page_size: MAX_ATTACHMENT_REPAIR_PAGE_ITEMS,
        });
      } catch (error) {
        if (error instanceof AttachmentRepairReviewMismatchError) {
          return attachmentRepairReviewMismatchResponse();
        }
        if (error instanceof AttachmentRepairIdempotencyConflictError) {
          return json(409, {
            error: error.message,
            code: "attachment_repair_idempotency_conflict",
          });
        }
        if (error instanceof AttachmentRepairQuotaExceededError) {
          return json(429, {
            error: error.message,
            code: "attachment_repair_quota_exceeded",
            quota: error.code,
            retryable: error.retryable,
          });
        }
        if (error instanceof RangeError) {
          return json(400, {
            error: error.message,
            code: "invalid_repair_manifest",
          });
        }
        throw error;
      }
    }

    const attachmentRepairResumeMatch = path.match(/^\/v1\/attachments\/repairs\/([^/]+)\/resume$/);
    if (attachmentRepairResumeMatch) {
      if (method !== "POST") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, write);
      if (!auth.ok) return auth.response;
      const operatorError = requireTenantOperator(auth);
      if (operatorError) return operatorError;
      const parsedRunId = parseAttachmentRepairId(attachmentRepairResumeMatch[1]!);
      if (!parsedRunId.ok) return invalidAttachmentRepairIdResponse();
      const body = await readJsonBody(req);
      const unsupported = unsupportedRequestFields(body, ["limit"]);
      if (unsupported.length > 0) {
        return json(400, {
          error: `attachment repair resume request contains unsupported fields: ${unsupported.join(", ")}`,
          code: "invalid_repair_body",
        });
      }
      const rawLimit = body.limit ?? MAX_ATTACHMENT_REPAIR_PAGE_ITEMS;
      if (!Number.isSafeInteger(rawLimit)
        || Number(rawLimit) <= 0
        || Number(rawLimit) > MAX_ATTACHMENT_REPAIR_PAGE_ITEMS) {
        return json(400, {
          error: `limit must be between 1 and ${MAX_ATTACHMENT_REPAIR_PAGE_ITEMS}`,
          code: "invalid_repair_limit",
        });
      }
      const existing = await auth.store.getAttachmentRepairRun(parsedRunId.value);
      if (!existing) {
        return json(404, {
          error: "attachment repair not found",
          code: "attachment_repair_not_found",
        });
      }
      if (!resolveAttachmentRepairCanonicalBucket(deps.env ?? process.env)) {
        return attachmentRepairNotConfiguredResponse();
      }
      const updated = await processAttachmentRepairRun(
        deps,
        auth.store,
        existing.id,
        Number(rawLimit),
      );
      return json(200, {
        repair: publicAttachmentRepair(updated),
        max_page_size: MAX_ATTACHMENT_REPAIR_PAGE_ITEMS,
      });
    }

    const attachmentRepairMatch = path.match(/^\/v1\/attachments\/repairs\/([^/]+)$/);
    if (attachmentRepairMatch) {
      if (method !== "GET") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, read);
      if (!auth.ok) return auth.response;
      const operatorError = requireTenantOperator(auth);
      if (operatorError) return operatorError;
      const parsedRunId = parseAttachmentRepairId(attachmentRepairMatch[1]!);
      if (!parsedRunId.ok) return invalidAttachmentRepairIdResponse();
      const run = await auth.store.getAttachmentRepairRun(parsedRunId.value);
      return run
        ? json(200, { repair: publicAttachmentRepair(run) })
        : json(404, {
            error: "attachment repair not found",
            code: "attachment_repair_not_found",
          });
    }

    // /v1/attachments/batch — checkpointable batch attachment-metadata read for
    // an explicit, bounded list of message IDs (MP-00034). POST carries the id
    // list in the body (a scan of thousands of ids will not fit a query string),
    // but it is a READ: only emails:read is required and nothing is mutated.
    // Matched BEFORE the generic resource matcher so "batch" is not read as an id.
    if (path === "/v1/attachments/batch") {
      if (method !== "POST") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, read);
      if (!auth.ok) return auth.response;
      const body = await readJsonBody(req);
      const raw = body.message_ids;
      if (!Array.isArray(raw)) {
        return json(400, { error: "message_ids must be an array of message ids", code: "invalid_message_ids" });
      }
      if (raw.length === 0) {
        return json(400, { error: "message_ids must not be empty", code: "empty_message_ids" });
      }
      if (raw.length > MAX_ATTACHMENT_BATCH_IDS) {
        return json(400, {
          error: `message_ids may contain at most ${MAX_ATTACHMENT_BATCH_IDS} ids per batch`,
          code: "batch_too_large",
          max_batch_size: MAX_ATTACHMENT_BATCH_IDS,
        });
      }
      const ids: string[] = [];
      for (const value of raw) {
        if (typeof value !== "string" || !value.trim()) {
          return json(400, { error: "every message id must be a non-empty string", code: "invalid_message_ids" });
        }
        ids.push(value);
      }
      const result = await auth.store.listAttachmentsForMessageIds(ids);
      return json(200, {
        by_message_id: result.by_message_id,
        unknown_ids: result.unknown_ids,
        max_batch_size: MAX_ATTACHMENT_BATCH_IDS,
      });
    }

    // /v1/attachments — read-only, tenant-scoped, keyset-paginated attachment
    // METADATA inventory across ALL messages (MP-00034). Unlike GET /v1/messages
    // (which exposes only attachment_count), this streams the full per-attachment
    // metadata the per-ID detail read carries — filename, content_type,
    // size_bytes, sha256 — keyed to (message_id, attachment_index), exact-once
    // and resumable via an opaque cursor. Never returns content_base64.
    if (path === "/v1/attachments") {
      if (method !== "GET") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, read);
      if (!auth.ok) return auth.response;
      const limit = queryCanonicalBoundedInt(url, "limit", 1, 500);
      if (limit.error) {
        return json(400, { error: limit.error, code: "invalid_limit" });
      }
      const cursor = url.searchParams.get("cursor")?.trim() || undefined;
      if (cursor && decodeAttachmentsCursor(cursor) === null) {
        return json(400, { error: "cursor is not a valid pagination cursor", code: "invalid_cursor" });
      }
      const rawDirection = url.searchParams.get("direction");
      const directionValue = rawDirection?.trim().toLowerCase();
      if (rawDirection !== null
        && directionValue !== "inbound"
        && directionValue !== "outbound") {
        return json(400, {
          error: "direction must be inbound or outbound",
          code: "invalid_direction",
        });
      }
      const direction = directionValue as "inbound" | "outbound" | undefined;
      const since = queryIsoDate(url, "since");
      if (since.error) {
        return json(400, {
          error: since.error,
          code: "invalid_since",
        });
      }
      const page = await auth.store.listAttachments({
        limit: limit.value,
        cursor,
        direction,
        since: since.value,
      });
      return json(200, { items: page.items, next_cursor: page.next_cursor });
    }

    // ---- scoped send keys: mint + verify ----------------------------------
    // Handled BEFORE the generic resource matcher so "verify"/"mint" are not read
    // as a send-keys id. The token and its hash live ONLY on the server; the
    // generic /v1/send-keys resource stays summary-only.

    // POST /v1/send-keys/mint — issue a scoped send key (token returned ONCE).
    //
    // Owner/admin (or an operator API key) ONLY. The send key is the control that
    // decides which of the tenant's from-addresses a holder may send as, so
    // minting one for a caller-supplied `owner_id` GRANTS send authority. With
    // only `emails:write` — which `member` holds — a member could mint a key for
    // another owner and send as that owner's addresses, i.e. mint their way
    // around the very check the send key exists to enforce. `owners` rows carry
    // no link back to `users`, so "the caller is that owner" is not expressible
    // here; the role gate is the boundary that is.
    if (path === "/v1/send-keys/mint") {
      if (method !== "POST") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, write);
      if (!auth.ok) return auth.response;
      const operatorError = requireTenantOperator(auth, "minting a send key");
      if (operatorError) return operatorError;
      const body = await readJsonBody(req);
      const ownerId = String(body.owner_id ?? "").trim();
      if (!ownerId) return json(400, { error: "owner_id is required" });
      const label = body.label === undefined || body.label === null ? null : String(body.label);
      const minted = await auth.store.mintSendKey({ owner_id: ownerId, label });
      return json(201, minted);
    }

    // POST /v1/send-keys/verify — resolve a token to its key and (optionally)
    // confirm it is authorized to send from a given `from` address. The client
    // never holds the key hash; verification (and last_used_at stamping) is here.
    if (path === "/v1/send-keys/verify") {
      if (method !== "POST") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, write);
      if (!auth.ok) return auth.response;
      const body = await readJsonBody(req);
      const token = typeof body.token === "string" ? body.token : "";
      if (!token.trim()) return json(400, { error: "token is required" });
      const key = await auth.store.verifySendKey(token);
      if (!key) return json(200, { valid: false, authorized: false, key: null });
      const from = typeof body.from === "string" ? body.from.trim() : "";
      // Default-deny: `authorized` reflects ONLY an actual from-address scope
      // check. With no `from` the caller is resolving the key (verifySendKey),
      // not making an authorization decision, so authorized stays false.
      if (!from) return json(200, { valid: true, authorized: false, key });
      const authorized = key.owner_id ? await auth.store.isOwnerAuthorizedFrom(key.owner_id, from) : false;
      return json(200, { valid: true, authorized, key });
    }

    // ---- generic resources (contacts/providers/templates/groups/…) --------
    const resourceMatch = path.match(/^\/v1\/([^/]+)(?:\/([^/]+))?$/);
    if (resourceMatch) {
      const spec = resourceSpecForPath(resourceMatch[1]!);
      if (spec) {
        const id = resourceMatch[2] ? decodeURIComponent(resourceMatch[2]) : undefined;
        if (id === undefined) {
          if (method === "GET") {
            const auth = await authenticate(deps, req, url, read);
            if (!auth.ok) return auth.response;
            const filters: Record<string, unknown> = {};
            for (const key of spec.filters ?? []) {
              const v = url.searchParams.get(key);
              if (v !== null) filters[key] = v;
            }
            const items = await auth.store.listResource(spec, {
              limit: queryInt(url, "limit"),
              offset: queryInt(url, "offset"),
              filters,
            });
            return json(200, { items });
          }
          if (method === "POST") {
            const auth = await authenticate(deps, req, url, write);
            if (!auth.ok) return auth.response;
            const specError = requireResourceWriteAuthority(auth, spec);
            if (specError) return specError;
            const body = await readJsonBody(req);
            return json(201, await auth.store.createResource(spec, body));
          }
          return json(405, { error: "method not allowed" });
        }
        if (method === "GET") {
          const auth = await authenticate(deps, req, url, read);
          if (!auth.ok) return auth.response;
          const rec = await auth.store.getResource(spec, id);
          return rec ? json(200, rec) : json(404, { error: `${spec.path} not found` });
        }
        if (method === "PATCH" || method === "PUT") {
          const auth = await authenticate(deps, req, url, write);
          if (!auth.ok) return auth.response;
          const specError = requireResourceWriteAuthority(auth, spec);
          if (specError) return specError;
          const body = await readJsonBody(req);
          const rec = await auth.store.updateResource(spec, id, body);
          return rec ? json(200, rec) : json(404, { error: `${spec.path} not found` });
        }
        if (method === "DELETE") {
          const auth = await authenticate(deps, req, url, write);
          if (!auth.ok) return auth.response;
          const specError = requireResourceWriteAuthority(auth, spec);
          if (specError) return specError;
          return (await auth.store.deleteResource(spec, id))
            ? json(200, { deleted: true, id })
            : json(404, { error: `${spec.path} not found` });
        }
        return json(405, { error: "method not allowed" });
      }
    }

    return json(404, { error: "not found" });
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return json(413, { error: "request body too large" });
    }
    if (err instanceof CrossTenantReferenceError) {
      // A body-supplied FK id pointing at another tenant's row: treat as "not
      // found" for this tenant (no cross-tenant existence is revealed).
      return json(404, { error: `referenced ${err.column} not found`, reason: "cross_tenant_reference" });
    }
    if (err instanceof InboundDomainRouteConflictError) {
      return json(409, { error: "inbound domain route is already claimed", reason: "inbound_route_conflict" });
    }
    if (err instanceof SyntaxError || (err instanceof Error && err.message.includes("JSON"))) {
      return json(400, { error: `invalid request body: ${err.message}` });
    }
    console.error("[emails-self-hosted] request failed", {
      method,
      path,
      error: err instanceof Error ? err.name : "UnknownError",
    });
    return json(500, { error: "internal error" });
  }
}
