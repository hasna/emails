import {
  MAX_ATTACHMENT_DOWNLOAD_BYTES,
  decodeAttachmentPayload,
} from "../../lib/attachment-download.js";
import { parseInboundMime } from "../../lib/inbound-mime.js";
import { createHash } from "node:crypto";
import {
  ATTACHMENT_REPAIR_LEASE_MS,
  MAX_ATTACHMENT_REPAIR_SOURCE_BYTES,
  MAX_ATTACHMENT_REPAIR_MANIFEST_ITEMS,
  MAX_ATTACHMENT_REPAIR_PAGE_ITEMS,
  normalizeAttachmentRepairManifestEntries,
} from "./store.js";
import type {
  AttachmentRepairLedgerEntry,
  AttachmentRepairLedgerEntryStatus,
  AttachmentRepairLedgerRun,
  EmailsSelfHostedStore,
  InboundAttachmentRepairBinding,
  InboundAttachmentRepairUpdate,
  InboundSourceProvenance,
  TenantScopedStore,
} from "./store.js";

export const MAX_ATTACHMENT_REPAIR_RAW_BYTES = MAX_ATTACHMENT_REPAIR_SOURCE_BYTES;
export {
  MAX_ATTACHMENT_REPAIR_MANIFEST_ITEMS,
  MAX_ATTACHMENT_REPAIR_PAGE_ITEMS,
  normalizeAttachmentRepairManifestEntries,
};
export type {
  AttachmentRepairLedgerEntry,
  AttachmentRepairLedgerEntryStatus,
  AttachmentRepairLedgerRun,
  AttachmentRepairManifestEntry,
} from "./store.js";

export interface AttachmentRepairState {
  attachments: unknown[];
  provenance: InboundSourceProvenance | null;
}

export interface AttachmentRepairTenantStore {
  /** Exact tenant + message id + upstream object-key binding. */
  getAttachmentRepairState(messageId: string, sourceKey: string): Promise<AttachmentRepairState | null>;
  /** Compare-and-swap only the attachments JSON; no timestamp or other column. */
  replaceAttachmentPayload(
    messageId: string,
    sourceKey: string,
    provenance: InboundSourceProvenance,
    expected: unknown[],
    replacement: unknown[],
  ): Promise<boolean>;
}

export interface AttachmentRepairDeps {
  /** Deployment-owned canonical ingest bucket; never caller supplied. */
  canonicalBucket: string;
  resolveInboundRecipients(recipients: string[]): Promise<{
    groups: Array<{ tenantId: string; recipients: string[] }>;
    unresolved: string[];
  }>;
  /** Complete persisted set across every tenant, independent of supplied recipients. */
  listAttachmentRepairBindings(bucket: string, sourceKey: string): Promise<InboundAttachmentRepairBinding[]>;
  /** Recheck the complete set and commit every CAS in one transaction. */
  replaceAttachmentPayloadsAtomically(
    expectedBindings: readonly InboundAttachmentRepairBinding[],
    updates: readonly InboundAttachmentRepairUpdate[],
  ): Promise<boolean>;
  fetchObject(bucket: string, key: string, maxBytes?: number): Promise<Buffer>;
  parseMime?: (raw: Buffer) => Promise<{ attachments: unknown[] }>;
}

export interface AttachmentRepairInput {
  key: string;
  recipients: string[];
  canaryMessageIds: string[];
  /**
   * Authenticated service fence. Operator canaries omit it so their existing
   * complete multi-tenant object behavior remains unchanged.
   */
  allowedTenantId?: string;
  /** False by default. True is allowed only after exact-ID dry-run review. */
  apply?: boolean;
  /** Testable/operator guard; it may only lower the hard source-object cap. */
  maxRawBytes?: number;
}

export type AttachmentRepairItemStatus =
  | "would_repair"
  | "repaired"
  | "already_complete"
  | "not_found"
  | "not_in_canary"
  | "ambiguous_binding"
  | "metadata_mismatch"
  | "concurrent_change"
  | "error";

export interface AttachmentRepairItem {
  tenant_id: string;
  message_id?: string;
  status: AttachmentRepairItemStatus;
  attachments?: number;
  reason?: string;
  /** Explicitly distinguishes retryable dependency failures from terminal invalid state. */
  retryable?: boolean;
}

export interface AttachmentRepairResult {
  key: string;
  apply: boolean;
  items: AttachmentRepairItem[];
  /** Aggregate source bytes accepted by this bounded attempt. Internal only. */
  source_bytes?: number;
  /** True when the durable per-attempt reservation stopped source consumption. */
  source_limit_exhausted?: boolean;
}

export class AttachmentRepairTerminalSourceError extends Error {
  constructor(
    message: string,
    readonly code: "source_unavailable" | "source_byte_limit" = "source_unavailable",
  ) {
    super(message);
    this.name = "AttachmentRepairTerminalSourceError";
  }
}

export function resolveAttachmentRepairCanonicalBucket(
  env: NodeJS.ProcessEnv,
): string | null {
  return env["EMAILS_INGEST_S3_BUCKET"]?.trim() || null;
}

function terminalAttachmentSourceFailure(error: unknown): boolean {
  if (error instanceof AttachmentRepairTerminalSourceError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (candidate.name === "NoSuchKey"
    || candidate.name === "NoSuchBucket"
    || candidate.name === "NotFound"
    || candidate.$metadata?.httpStatusCode === 404) {
    return true;
  }
  return candidate.message === "S3 object has no body";
}

export interface AttachmentRepairLedgerStore {
  getAttachmentRepairRun(runId: string): Promise<AttachmentRepairLedgerRun | null>;
  claimAttachmentRepairEntry(
    runId: string,
    leaseMs?: number,
  ): Promise<AttachmentRepairLedgerEntry | null>;
  recordAttachmentRepairEntryOutcome(
    runId: string,
    position: number,
    claimToken: string,
    status: AttachmentRepairLedgerEntryStatus,
    errorCode?: string | null,
    sourceBytes?: number,
  ): Promise<void>;
}

export interface AttachmentRepairPageDeps {
  store: AttachmentRepairLedgerStore;
  repair(
    entry: AttachmentRepairLedgerEntry,
    apply: boolean,
  ): Promise<AttachmentRepairResult>;
}

/**
 * Normalize the exact-ID canary without changing its caller-provided order.
 * Repeating an ID after trimming is an operator input error, never an implicit
 * request to collapse the canary set.
 */
export function normalizeAttachmentRepairCanaryMessageIds(values: readonly string[]): string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  const seen = new Set<string>();
  for (const messageId of normalized) {
    if (seen.has(messageId)) {
      throw new Error("attachment repair rejects duplicate normalized canary message-id values");
    }
    seen.add(messageId);
  }
  return normalized;
}

type AttachmentMetadata = { filename: string; content_type: string; size: number };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function metadata(value: unknown): AttachmentMetadata | null {
  const item = record(value);
  if (!item) return null;
  if (typeof item["filename"] !== "string" || typeof item["content_type"] !== "string") return null;
  if (!Number.isSafeInteger(item["size"]) || Number(item["size"]) < 0) return null;
  return {
    filename: item["filename"],
    content_type: item["content_type"],
    size: Number(item["size"]),
  };
}

function sameMetadata(left: unknown[], right: unknown[]): boolean {
  if (left.length !== right.length || left.length === 0) return false;
  return left.every((value, index) => {
    const a = metadata(value);
    const b = metadata(right[index]);
    return Boolean(a && b && a.filename === b.filename && a.content_type === b.content_type && a.size === b.size);
  });
}

function contentState(attachments: unknown[]): "complete" | "missing" | "invalid" {
  if (attachments.length === 0) return "invalid";
  let missing = false;
  for (let index = 0; index < attachments.length; index++) {
    const item = record(attachments[index]);
    if (!item || !metadata(item)) return "invalid";
    if (typeof item["content_base64"] !== "string") {
      missing = true;
      continue;
    }
    try {
      const decoded = decodeAttachmentPayload({ attachment: item }, index, MAX_ATTACHMENT_DOWNLOAD_BYTES);
      if (decoded.state !== "available") return "invalid";
    } catch {
      return "invalid";
    }
  }
  return missing ? "missing" : "complete";
}

function missingAttachmentPayloadCount(attachments: unknown[]): number {
  return attachments.reduce<number>((total, value) => {
    const item = record(value);
    return total + (item && typeof item["content_base64"] !== "string" ? 1 : 0);
  }, 0);
}

function replacementPayload(existing: unknown[], parsed: unknown[]): unknown[] | null {
  if (!sameMetadata(existing, parsed)) return null;
  const replacement: unknown[] = [];
  for (let index = 0; index < existing.length; index++) {
    const oldRecord = record(existing[index]);
    const parsedRecord = record(parsed[index]);
    if (!oldRecord || !parsedRecord || typeof parsedRecord["content_base64"] !== "string") return null;
    try {
      const parsedContent = decodeAttachmentPayload({ attachment: parsedRecord }, index, MAX_ATTACHMENT_DOWNLOAD_BYTES);
      if (parsedContent.state !== "available") return null;
      if (typeof oldRecord["content_base64"] === "string") {
        const oldContent = decodeAttachmentPayload({ attachment: oldRecord }, index, MAX_ATTACHMENT_DOWNLOAD_BYTES);
        if (oldContent.state !== "available" || oldContent.sha256 !== parsedContent.sha256) return null;
      }
    } catch {
      return null;
    }
    replacement.push({ ...oldRecord, content_base64: parsedRecord["content_base64"] });
  }
  return replacement;
}

/**
 * Repair attachment payloads for one exact S3 object without using the generic
 * message upsert path. A non-empty exact-ID canary is mandatory and dry-run is
 * the default. All reads/updates remain tenant scoped.
 */
export async function repairExistingS3ObjectAttachments(
  deps: AttachmentRepairDeps,
  input: AttachmentRepairInput,
): Promise<AttachmentRepairResult> {
  const apply = input.apply === true;
  if (!input.key.trim()) throw new Error("attachment repair requires an exact object key");
  if (!deps.canonicalBucket.trim()) throw new Error("attachment repair requires the deployment canonical bucket");
  const canaryIds = normalizeAttachmentRepairCanaryMessageIds(input.canaryMessageIds);
  if (canaryIds.length === 0) throw new Error("attachment repair requires at least one exact canary message id");
  const maxRawBytes = input.maxRawBytes ?? MAX_ATTACHMENT_REPAIR_RAW_BYTES;
  if (!Number.isSafeInteger(maxRawBytes) || maxRawBytes <= 0 || maxRawBytes > MAX_ATTACHMENT_REPAIR_RAW_BYTES) {
    throw new Error(`attachment repair source byte limit must be between 1 and ${MAX_ATTACHMENT_REPAIR_RAW_BYTES}`);
  }

  const route = await deps.resolveInboundRecipients(input.recipients);
  const result: AttachmentRepairResult = { key: input.key, apply, items: [], source_bytes: 0 };
  if (route.unresolved.length > 0 || route.groups.length === 0) {
    result.items.push({
      tenant_id: "unresolved",
      status: "error",
      reason: "recipient route is incomplete",
      retryable: false,
    });
    return result;
  }

  let bindings: InboundAttachmentRepairBinding[];
  try {
    bindings = await deps.listAttachmentRepairBindings(deps.canonicalBucket, input.key);
  } catch (error) {
    result.items.push({
      tenant_id: "unresolved",
      status: "error",
      reason: error instanceof Error ? error.message : "persisted object bindings could not be read",
      retryable: true,
    });
    return result;
  }
  bindings.sort((left, right) =>
    `${left.tenantId}\0${left.messageId}`.localeCompare(`${right.tenantId}\0${right.messageId}`));
  if (bindings.length === 0) {
    for (const group of route.groups) result.items.push({ tenant_id: group.tenantId, status: "not_found" });
    return result;
  }
  if (input.allowedTenantId
    && bindings.some((binding) => binding.tenantId !== input.allowedTenantId)) {
    result.items.push({
      tenant_id: input.allowedTenantId,
      status: "ambiguous_binding",
      reason: "persisted object bindings fall outside the authenticated tenant",
    });
    return result;
  }

  const routeTenantIds = new Set(route.groups.map((group) => group.tenantId));
  const bindingTenantIds = new Set(bindings.map((binding) => binding.tenantId));
  const bindingIds = new Set(bindings.map((binding) => binding.messageId));
  const exactRouteSet = routeTenantIds.size === bindingTenantIds.size
    && [...routeTenantIds].every((tenantId) => bindingTenantIds.has(tenantId));
  const exactCanarySet = bindingIds.size === bindings.length
    && bindingIds.size === canaryIds.length
    && canaryIds.every((messageId) => bindingIds.has(messageId));
  if (!exactRouteSet) {
    for (const binding of bindings) {
      result.items.push({
        tenant_id: binding.tenantId,
        message_id: binding.messageId,
        status: "ambiguous_binding",
        reason: "trusted recipient routes do not equal the complete persisted object binding set",
      });
    }
    return result;
  }
  if (!exactCanarySet) {
    for (const binding of bindings) {
      result.items.push({
        tenant_id: binding.tenantId,
        message_id: binding.messageId,
        status: "not_in_canary",
        reason: "the canary does not equal the complete persisted object binding set",
      });
    }
    return result;
  }

  const firstProvenance = bindings[0]!.provenance;
  const validBindings = bindings.every((binding) =>
    binding.provenance.tenant_id === binding.tenantId
      && binding.provenance.message_id === binding.messageId
      && binding.provenance.object_key === input.key
      && binding.provenance.bucket === deps.canonicalBucket
      && binding.provenance.bucket === firstProvenance.bucket
      && binding.provenance.raw_sha256 === firstProvenance.raw_sha256
      && /^[0-9a-f]{64}$/.test(binding.provenance.raw_sha256));
  if (!validBindings) {
    for (const binding of bindings) {
      result.items.push({
        tenant_id: binding.tenantId,
        message_id: binding.messageId,
        status: "ambiguous_binding",
        reason: "persisted rows do not bind to one immutable object and byte digest",
      });
    }
    return result;
  }

  const states = bindings.map((binding) => {
    const state = contentState(binding.attachments);
    return {
      binding,
      state,
      repairableAttachments: state === "missing"
        ? missingAttachmentPayloadCount(binding.attachments)
        : 0,
    };
  });
  if (states.some(({ state }) => state === "invalid")) {
    for (const { binding, state } of states) {
      result.items.push({
        tenant_id: binding.tenantId,
        message_id: binding.messageId,
        status: state === "invalid" ? "error" : state === "complete" ? "already_complete" : "error",
        attachments: binding.attachments.length,
        ...(state === "invalid"
          ? { reason: "existing attachment metadata is invalid", retryable: false }
          : { retryable: false }),
      });
    }
    return result;
  }
  const missing = states.filter(({ state }) => state === "missing");
  if (missing.length === 0) {
    for (const { binding } of states) {
      result.items.push({
        tenant_id: binding.tenantId,
        message_id: binding.messageId,
        status: "already_complete",
        attachments: binding.attachments.length,
      });
    }
    return result;
  }

  let raw: Buffer;
  try {
    raw = await deps.fetchObject(firstProvenance.bucket, firstProvenance.object_key, maxRawBytes);
  } catch (error) {
    result.source_bytes = maxRawBytes;
    result.source_limit_exhausted = error instanceof AttachmentRepairTerminalSourceError
      && error.code === "source_byte_limit";
    const reason = error instanceof Error ? error.message : "attachment source could not be read";
    const retryable = !terminalAttachmentSourceFailure(error);
    for (const binding of bindings) {
      result.items.push({
        tenant_id: binding.tenantId,
        message_id: binding.messageId,
        status: "error",
        reason,
        retryable,
      });
    }
    return result;
  }
  result.source_bytes = raw.byteLength;
  const terminalSourceError = raw.byteLength === 0
    ? "S3 object is empty"
    : raw.byteLength > maxRawBytes
      ? `S3 object exceeds attachment repair source byte limit ${maxRawBytes}`
      : createHash("sha256").update(raw).digest("hex") !== firstProvenance.raw_sha256
        ? "S3 object bytes do not match immutable canonical source provenance"
        : null;
  if (raw.byteLength > maxRawBytes) result.source_limit_exhausted = true;
  if (terminalSourceError) {
    for (const binding of bindings) {
      result.items.push({
        tenant_id: binding.tenantId,
        message_id: binding.messageId,
        status: "error",
        reason: terminalSourceError,
        retryable: false,
      });
    }
    return result;
  }

  let parsed: { attachments: unknown[] };
  try {
    parsed = await (deps.parseMime ?? parseInboundMime)(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "attachment MIME could not be parsed";
    for (const binding of bindings) {
      result.items.push({
        tenant_id: binding.tenantId,
        message_id: binding.messageId,
        status: "error",
        reason,
        retryable: false,
      });
    }
    return result;
  }

  const updates: InboundAttachmentRepairUpdate[] = [];
  for (const { binding, state } of states) {
    const replacement = state === "complete"
      ? binding.attachments
      : replacementPayload(binding.attachments, parsed.attachments);
    if (!replacement) {
      for (const candidate of bindings) {
        result.items.push({
          tenant_id: candidate.tenantId,
          message_id: candidate.messageId,
          status: "metadata_mismatch",
          reason: "parsed attachment count/order/metadata/content does not match every stored row",
        });
      }
      return result;
    }
    updates.push({
      tenantId: binding.tenantId,
      messageId: binding.messageId,
      expected: binding.attachments,
      replacement,
    });
  }
  if (!apply) {
    for (const { binding, state, repairableAttachments } of states) {
      result.items.push({
        tenant_id: binding.tenantId,
        message_id: binding.messageId,
        status: state === "complete" ? "already_complete" : "would_repair",
        attachments: state === "complete" ? binding.attachments.length : repairableAttachments,
      });
    }
    return result;
  }
  const updated = await deps.replaceAttachmentPayloadsAtomically(bindings, updates);
  for (const { binding, state, repairableAttachments } of states) {
    result.items.push({
      tenant_id: binding.tenantId,
      message_id: binding.messageId,
      status: state === "complete" ? "already_complete" : updated ? "repaired" : "concurrent_change",
      attachments: state === "complete" ? binding.attachments.length : repairableAttachments,
    });
  }
  return result;
}

interface ClassifiedAttachmentRepairLedgerOutcome {
  status: AttachmentRepairLedgerEntryStatus;
  errorCode: string | null;
}

function classifyLedgerOutcome(
  entry: AttachmentRepairLedgerEntry,
  result: AttachmentRepairResult,
  apply: boolean,
): ClassifiedAttachmentRepairLedgerOutcome {
  if (result.key !== entry.object_key || result.apply !== apply || result.items.length === 0) {
    return { status: "unavailable", errorCode: "invalid_repair_result" };
  }
  if (result.items.some((item) => item.tenant_id !== entry.tenant_id)) {
    return { status: "unavailable", errorCode: "invalid_repair_tenant" };
  }
  const messageIds = result.items
    .map((item) => item.message_id)
    .filter((value): value is string => typeof value === "string");
  const expectedIds = new Set(entry.canary_message_ids);
  const exactCanary = messageIds.length === result.items.length
    && new Set(messageIds).size === expectedIds.size
    && messageIds.every((messageId) => expectedIds.has(messageId));
  if (!exactCanary) {
    return { status: "unavailable", errorCode: "invalid_repair_canary" };
  }
  const statuses = new Set(result.items.map((item) => item.status));
  if (statuses.has("concurrent_change")) {
    return { status: "pending", errorCode: "concurrent_change" };
  }
  const failures = result.items.filter((item) => item.status === "error");
  if (failures.length > 0) {
    return failures.every((item) => item.retryable !== false)
      ? { status: "pending", errorCode: "retryable_repair_error" }
      : { status: "unavailable", errorCode: "terminal_repair_error" };
  }
  if (apply) {
    return [...statuses].every((status) => status === "repaired" || status === "already_complete")
      ? { status: "repaired", errorCode: null }
      : { status: "unavailable", errorCode: "terminal_repair_outcome" };
  }
  if ([...statuses].every((status) => status === "already_complete")) {
    return { status: "repaired", errorCode: null };
  }
  return [...statuses].every((status) => status === "would_repair" || status === "already_complete")
    ? { status: "would_repair", errorCode: null }
    : { status: "unavailable", errorCode: "terminal_repair_outcome" };
}

/**
 * Process at most one explicit repair page. Each source object is claimed in a
 * short transaction before S3/MIME work and checkpointed afterward. The lease
 * prevents simultaneous resumptions from duplicating an external attempt while
 * allowing a later process to recover a crashed claim after bounded expiry.
 */
export async function processAttachmentRepairPage(
  deps: AttachmentRepairPageDeps,
  input: { runId: string; limit?: number },
): Promise<AttachmentRepairLedgerRun> {
  const limit = input.limit ?? MAX_ATTACHMENT_REPAIR_PAGE_ITEMS;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_ATTACHMENT_REPAIR_PAGE_ITEMS) {
    throw new RangeError(
      `attachment repair page limit must be between 1 and ${MAX_ATTACHMENT_REPAIR_PAGE_ITEMS}`,
    );
  }
  const run = await deps.store.getAttachmentRepairRun(input.runId);
  if (!run) throw new Error("attachment repair run not found");
  if (run.status === "completed") return run;
  for (let processed = 0; processed < limit; processed++) {
    const entry = await deps.store.claimAttachmentRepairEntry(
      input.runId,
      ATTACHMENT_REPAIR_LEASE_MS,
    );
    if (!entry) break;
    if (!entry.claim_token) {
      throw new Error("attachment repair claim did not return a claim token");
    }
    let outcome: ClassifiedAttachmentRepairLedgerOutcome;
    let sourceBytes = entry.source_byte_limit;
    try {
      const result = await deps.repair(entry, run.apply);
      sourceBytes = Number.isSafeInteger(result.source_bytes)
        && Number(result.source_bytes) >= 0
        && Number(result.source_bytes) <= entry.source_byte_limit
        ? Number(result.source_bytes)
        : entry.source_byte_limit;
      outcome = result.source_limit_exhausted
        ? { status: "unavailable", errorCode: "run_byte_budget_exhausted" }
        : classifyLedgerOutcome(entry, result, run.apply);
    } catch {
      outcome = { status: "pending", errorCode: "repair_exception" };
    }
    await deps.store.recordAttachmentRepairEntryOutcome(
      run.id,
      entry.position,
      entry.claim_token,
      outcome.status,
      outcome.errorCode,
      sourceBytes,
    );
  }
  const updated = await deps.store.getAttachmentRepairRun(run.id);
  if (!updated) throw new Error("attachment repair run disappeared");
  return updated;
}

/**
 * Production adapter for the authenticated service. The canonical bucket comes
 * only from deployment configuration; callers can provide object keys but can
 * never override the bucket. S3 is loaded lazily and no bucket listing occurs.
 */
export async function processCanonicalS3AttachmentRepairPage(
  rootStore: Pick<
    EmailsSelfHostedStore,
    "resolveInboundRecipients" | "listAttachmentRepairBindings" | "replaceAttachmentPayloadsAtomically"
  >,
  tenantStore: TenantScopedStore,
  runId: string,
  limit: number,
  env: NodeJS.ProcessEnv,
): Promise<AttachmentRepairLedgerRun> {
  const canonicalBucket = resolveAttachmentRepairCanonicalBucket(env);
  if (!canonicalBucket) {
    throw new Error(
      "attachment repair requires EMAILS_INGEST_S3_BUCKET as the canonical source",
    );
  }
  const region = env["AWS_REGION"]?.trim() || "us-east-1";
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region });
  const fetchObject = async (
    bucket: string,
    key: string,
    maxBytes = MAX_ATTACHMENT_REPAIR_RAW_BYTES,
  ): Promise<Buffer> => {
    const response = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=0-${maxBytes - 1}`,
    }));
    if (!response.Body) {
      throw new AttachmentRepairTerminalSourceError("S3 object has no body");
    }
    const body = response.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
    const totalSizeMatch = response.ContentRange?.match(/\/([0-9]+)$/);
    const totalSize = totalSizeMatch ? Number(totalSizeMatch[1]) : response.ContentLength;
    if (typeof totalSize === "number" && totalSize > maxBytes) {
      body.destroy?.();
      throw new AttachmentRepairTerminalSourceError(
        `S3 object exceeds attachment repair source byte limit ${maxBytes}`,
        "source_byte_limit",
      );
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        throw new AttachmentRepairTerminalSourceError(
          `S3 object exceeds attachment repair source byte limit ${maxBytes}`,
          "source_byte_limit",
        );
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };

  return processAttachmentRepairPage({
    store: tenantStore,
    repair: (entry, apply) => repairExistingS3ObjectAttachments({
      canonicalBucket,
      resolveInboundRecipients: (recipients) => rootStore.resolveInboundRecipients(recipients),
      listAttachmentRepairBindings: (bucket, key) => rootStore.listAttachmentRepairBindings(bucket, key),
      replaceAttachmentPayloadsAtomically: (bindings, updates) =>
        rootStore.replaceAttachmentPayloadsAtomically(bindings, updates),
      fetchObject,
    }, {
      key: entry.object_key,
      recipients: entry.recipients,
      canaryMessageIds: entry.canary_message_ids,
      allowedTenantId: entry.tenant_id,
      apply,
      maxRawBytes: entry.source_byte_limit,
    }),
  }, { runId, limit });
}
