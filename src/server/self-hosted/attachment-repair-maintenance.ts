import { createHash } from "node:crypto";
import {
  MAX_ATTACHMENT_REPAIR_PAGE_ITEMS,
  normalizeAttachmentRepairManifestEntries,
  processCanonicalS3AttachmentRepairPage,
  resolveAttachmentRepairCanonicalBucket,
} from "./attachment-repair.js";
import { AttachmentRepairIdempotencyConflictError } from "./store.js";
import type {
  AttachmentRepairLedgerRun,
  AttachmentRepairManifestEntry,
  EmailsSelfHostedStore,
  TenantScopedStore,
} from "./store.js";

export const ATTACHMENT_REPAIR_MANIFEST_ENV =
  "EMAILS_ATTACHMENT_REPAIR_MANIFEST";
export const ATTACHMENT_REPAIR_IMAGE_REVISION_ENV =
  "EMAILS_IMAGE_REVISION";

const ATTACHMENT_REPAIR_MANIFEST_MAX_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_REPAIR_MAINTENANCE_PAGES = 32;
const UUID_RE =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const REVISION_RE = /^[0-9a-f]{40}$/;
const UTC_TIMESTAMP_RE =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/;
const CONTAINER_NAME_RE = /^[A-Za-z0-9_-]{1,255}$/;
const TASK_DEFINITION_ARN_RE =
  /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:task-definition\/[A-Za-z0-9_-]+:[1-9][0-9]*$/;

export type AttachmentRepairMaintenancePhase = "dry-run" | "apply";
export type AttachmentRepairMaintenanceFailureCode =
  | "config_failure"
  | "provenance_failure"
  | "invariant_failure"
  | "unavailable"
  | "operator_action"
  | "incomplete";

const EXIT_CODES: Record<AttachmentRepairMaintenanceFailureCode, number> = {
  config_failure: 64,
  provenance_failure: 65,
  invariant_failure: 66,
  unavailable: 67,
  operator_action: 68,
  incomplete: 75,
};

export class AttachmentRepairMaintenanceError extends Error {
  readonly exitCode: number;

  constructor(
    readonly code: AttachmentRepairMaintenanceFailureCode,
    readonly report?: AttachmentRepairMaintenanceReport,
  ) {
    super(`attachment repair maintenance failed: ${code}`);
    this.name = "AttachmentRepairMaintenanceError";
    this.exitCode = EXIT_CODES[code];
  }
}

export interface AttachmentRepairMaintenanceManifest {
  apply_idempotency_key: string;
  dry_run_idempotency_key: string;
  entries: AttachmentRepairManifestEntry[];
  purpose: "attachment-repair-ledger";
  schema_version: 1;
  tenant_id: string;
}

export interface AttachmentRepairMaintenanceOptions {
  phase: AttachmentRepairMaintenancePhase;
  manifestSha256: string;
  pageLimit: number;
  maxPages: number;
  expectedTaskDefinitionArn: string;
  expectedImageDigest: string;
  expectedImageRevision: string;
  containerName: string;
  expectedRunId?: string;
  dryRunId?: string;
  dryRunResultSha256?: string;
}

export type PublicAttachmentRepairRun = Omit<
  AttachmentRepairLedgerRun,
  "tenant_id"
>;

export interface AttachmentRepairMaintenanceReport {
  container_name: string;
  failure_code: AttachmentRepairMaintenanceFailureCode | null;
  image_digest: string;
  image_revision: string;
  manifest_sha256: string;
  phase: AttachmentRepairMaintenancePhase;
  repair: PublicAttachmentRepairRun;
  result_sha256: string;
  run_id: string;
  schema_version: 1;
  status: "pass" | "fail";
  task_arn: string;
  task_definition_arn: string;
}

interface AttachmentRepairMaintenanceStoreContext {
  rootStore: Pick<
    EmailsSelfHostedStore,
    | "resolveInboundRecipients"
    | "listAttachmentRepairBindings"
    | "replaceAttachmentPayloadsAtomically"
  >;
  tenantStore: Pick<
    TenantScopedStore,
    | "createOrGetAttachmentRepairRun"
    | "getAttachmentRepairRun"
    | "claimAttachmentRepairEntry"
    | "recordAttachmentRepairEntryOutcome"
  >;
  close(): Promise<void>;
}

export interface AttachmentRepairMaintenanceDeps {
  env: NodeJS.ProcessEnv;
  fetchTaskMetadata(uri: string): Promise<unknown>;
  openStore(tenantId: string): Promise<AttachmentRepairMaintenanceStoreContext>;
  processPage(
    rootStore: AttachmentRepairMaintenanceStoreContext["rootStore"],
    tenantStore: AttachmentRepairMaintenanceStoreContext["tenantStore"],
    runId: string,
    limit: number,
    env: NodeJS.ProcessEnv,
  ): Promise<AttachmentRepairLedgerRun>;
  emit(line: string): void;
}

interface EcsTaskProvenance {
  taskArn: string;
  taskDefinitionArn: string;
  containerName: string;
  imageDigest: string;
  imageRevision: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalAttachmentRepairJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function safeIdempotencyKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 200
    && /^[\x21-\x7e]+$/.test(value);
}

export function parseAttachmentRepairMaintenanceManifest(
  raw: string,
  expectedSha256: string,
): AttachmentRepairMaintenanceManifest {
  if (!SHA256_RE.test(expectedSha256)) {
    throw new AttachmentRepairMaintenanceError("config_failure");
  }
  if (!raw || Buffer.byteLength(raw, "utf8") > ATTACHMENT_REPAIR_MANIFEST_MAX_BYTES) {
    throw new AttachmentRepairMaintenanceError("config_failure");
  }
  if (sha256(raw) !== expectedSha256) {
    throw new AttachmentRepairMaintenanceError("provenance_failure");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AttachmentRepairMaintenanceError("config_failure");
  }
  if (!isRecord(parsed)
    || !exactKeys(parsed, [
      "apply_idempotency_key",
      "dry_run_idempotency_key",
      "entries",
      "purpose",
      "schema_version",
      "tenant_id",
    ])) {
    throw new Error("attachment repair maintenance manifest must use the exact schema");
  }
  if (canonicalAttachmentRepairJson(parsed) !== raw) {
    throw new Error("attachment repair maintenance manifest must be canonical JSON");
  }
  if (parsed["schema_version"] !== 1
    || parsed["purpose"] !== "attachment-repair-ledger"
    || typeof parsed["tenant_id"] !== "string"
    || !UUID_RE.test(parsed["tenant_id"])) {
    throw new Error("attachment repair maintenance manifest has invalid operator metadata");
  }
  if (!safeIdempotencyKey(parsed["dry_run_idempotency_key"])
    || !safeIdempotencyKey(parsed["apply_idempotency_key"])
    || parsed["dry_run_idempotency_key"] === parsed["apply_idempotency_key"]) {
    throw new Error("attachment repair maintenance manifest has invalid idempotency keys");
  }
  if (!Array.isArray(parsed["entries"])) {
    throw new Error("attachment repair maintenance manifest entries must be an array");
  }
  const entries = normalizeAttachmentRepairManifestEntries(
    parsed["entries"] as AttachmentRepairManifestEntry[],
  );
  if (canonicalAttachmentRepairJson(entries)
    !== canonicalAttachmentRepairJson(parsed["entries"])) {
    throw new Error(
      "attachment repair maintenance manifest entries must already be exact and canonical",
    );
  }
  return {
    apply_idempotency_key: parsed["apply_idempotency_key"],
    dry_run_idempotency_key: parsed["dry_run_idempotency_key"],
    entries,
    purpose: "attachment-repair-ledger",
    schema_version: 1,
    tenant_id: parsed["tenant_id"],
  };
}

function requireOption(
  values: Map<string, string>,
  flag: string,
): string {
  const value = values.get(flag);
  if (!value) throw new Error(`attachment repair maintenance requires ${flag}`);
  return value;
}

function positiveInteger(raw: string, label: string, maximum: number): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return parsed;
}

export function parseAttachmentRepairMaintenanceArgs(
  args: readonly string[],
): AttachmentRepairMaintenanceOptions {
  const allowed = new Set([
    "--phase",
    "--manifest-sha256",
    "--page-limit",
    "--max-pages",
    "--task-definition-arn",
    "--image-digest",
    "--image-revision",
    "--container-name",
    "--expected-run-id",
    "--dry-run-id",
    "--dry-run-result-sha256",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !allowed.has(flag)) {
      throw new Error("attachment repair maintenance received an unsupported option");
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`attachment repair maintenance requires a value for ${flag}`);
    }
    if (values.has(flag)) {
      throw new Error(`attachment repair maintenance rejects duplicate ${flag}`);
    }
    values.set(flag, value);
  }

  const phase = requireOption(values, "--phase");
  if (phase !== "dry-run" && phase !== "apply") {
    throw new Error("attachment repair maintenance --phase must be dry-run or apply");
  }
  const manifestSha256 = requireOption(values, "--manifest-sha256");
  const expectedTaskDefinitionArn = requireOption(
    values,
    "--task-definition-arn",
  );
  const expectedImageDigest = requireOption(values, "--image-digest");
  const expectedImageRevision = requireOption(values, "--image-revision");
  const containerName = requireOption(values, "--container-name");
  if (!SHA256_RE.test(manifestSha256)
    || !TASK_DEFINITION_ARN_RE.test(expectedTaskDefinitionArn)
    || !IMAGE_DIGEST_RE.test(expectedImageDigest)
    || !REVISION_RE.test(expectedImageRevision)
    || !CONTAINER_NAME_RE.test(containerName)) {
    throw new Error("attachment repair maintenance provenance options are invalid");
  }
  const pageLimit = positiveInteger(
    values.get("--page-limit") ?? String(MAX_ATTACHMENT_REPAIR_PAGE_ITEMS),
    "attachment repair page limit",
    MAX_ATTACHMENT_REPAIR_PAGE_ITEMS,
  );
  const maxPages = positiveInteger(
    values.get("--max-pages") ?? "8",
    "attachment repair max pages",
    MAX_ATTACHMENT_REPAIR_MAINTENANCE_PAGES,
  );
  const expectedRunId = values.get("--expected-run-id");
  const dryRunId = values.get("--dry-run-id");
  const dryRunResultSha256 = values.get("--dry-run-result-sha256");
  for (const [label, value] of [
    ["expected run id", expectedRunId],
    ["dry-run id", dryRunId],
  ] as const) {
    if (value !== undefined && !UUID_RE.test(value)) {
      throw new Error(`attachment repair maintenance ${label} must be a UUID`);
    }
  }
  if (dryRunResultSha256 !== undefined && !SHA256_RE.test(dryRunResultSha256)) {
    throw new Error(
      "attachment repair maintenance dry-run result SHA-256 is invalid",
    );
  }
  if (phase === "apply" && (!dryRunId || !dryRunResultSha256)) {
    throw new Error(
      "attachment repair maintenance apply requires the exact dry-run proof",
    );
  }
  if (phase === "dry-run" && (dryRunId || dryRunResultSha256)) {
    throw new Error(
      "attachment repair maintenance dry-run does not accept apply proof options",
    );
  }

  return {
    phase,
    manifestSha256,
    pageLimit,
    maxPages,
    expectedTaskDefinitionArn,
    expectedImageDigest,
    expectedImageRevision,
    containerName,
    ...(expectedRunId ? { expectedRunId } : {}),
    ...(dryRunId ? { dryRunId } : {}),
    ...(dryRunResultSha256 ? { dryRunResultSha256 } : {}),
  };
}

function taskDefinitionArnFromMetadata(
  taskArn: string,
  family: string,
  revision: string,
): string | null {
  const match = taskArn.match(
    /^(arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}):task\/(?:[^/]+\/)?[0-9a-f-]+$/i,
  );
  if (!match || !/^[A-Za-z0-9_-]+$/.test(family)
    || !/^[1-9][0-9]*$/.test(revision)) {
    return null;
  }
  return `${match[1]}:task-definition/${family}:${revision}`;
}

function parseTaskProvenance(
  metadata: unknown,
  options: AttachmentRepairMaintenanceOptions,
  configuredImageRevision: string | undefined,
): EcsTaskProvenance {
  if (!isRecord(metadata)
    || typeof metadata["TaskARN"] !== "string"
    || typeof metadata["Family"] !== "string"
    || (typeof metadata["Revision"] !== "string"
      && typeof metadata["Revision"] !== "number")
    || !Array.isArray(metadata["Containers"])) {
    throw new AttachmentRepairMaintenanceError("provenance_failure");
  }
  const taskDefinitionArn = taskDefinitionArnFromMetadata(
    metadata["TaskARN"],
    metadata["Family"],
    String(metadata["Revision"]),
  );
  if (taskDefinitionArn !== options.expectedTaskDefinitionArn) {
    throw new AttachmentRepairMaintenanceError("provenance_failure");
  }
  const containers = metadata["Containers"].filter(
    (value): value is Record<string, unknown> =>
      isRecord(value) && value["Name"] === options.containerName,
  );
  if (containers.length !== 1) {
    throw new AttachmentRepairMaintenanceError("provenance_failure");
  }
  const container = containers[0]!;
  const image = typeof container["Image"] === "string" ? container["Image"] : "";
  const imageId =
    typeof container["ImageID"] === "string" ? container["ImageID"] : "";
  const labels = isRecord(container["Labels"]) ? container["Labels"] : {};
  const imageRevisionLabel =
    labels["org.opencontainers.image.revision"];
  if (configuredImageRevision !== options.expectedImageRevision
    || imageId !== options.expectedImageDigest
    || !image.endsWith(`@${options.expectedImageDigest}`)
    || (imageRevisionLabel !== undefined
      && imageRevisionLabel !== options.expectedImageRevision)) {
    throw new AttachmentRepairMaintenanceError("provenance_failure");
  }
  return {
    taskArn: metadata["TaskARN"],
    taskDefinitionArn,
    containerName: options.containerName,
    imageDigest: options.expectedImageDigest,
    imageRevision: options.expectedImageRevision,
  };
}

async function resolveTaskProvenance(
  options: AttachmentRepairMaintenanceOptions,
  deps: AttachmentRepairMaintenanceDeps,
): Promise<EcsTaskProvenance> {
  const metadataUri = deps.env["ECS_CONTAINER_METADATA_URI_V4"]?.trim();
  if (!metadataUri) {
    throw new AttachmentRepairMaintenanceError("provenance_failure");
  }
  let url: URL;
  try {
    url = new URL(metadataUri);
  } catch {
    throw new AttachmentRepairMaintenanceError("provenance_failure");
  }
  if (url.protocol !== "http:" || url.hostname !== "169.254.170.2") {
    throw new AttachmentRepairMaintenanceError("provenance_failure");
  }
  const metadata = await deps.fetchTaskMetadata(
    `${metadataUri.replace(/\/+$/, "")}/task`,
  );
  return parseTaskProvenance(
    metadata,
    options,
    deps.env[ATTACHMENT_REPAIR_IMAGE_REVISION_ENV]?.trim(),
  );
}

export function publicAttachmentRepairRun(
  run: AttachmentRepairLedgerRun,
): PublicAttachmentRepairRun {
  const { tenant_id: _tenantId, ...safe } = run;
  return safe;
}

export function attachmentRepairRunResultSha256(
  run: AttachmentRepairLedgerRun,
): string {
  return sha256(canonicalAttachmentRepairJson(publicAttachmentRepairRun(run)));
}

const NUMERIC_RUN_FIELDS = [
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
] as const;

function validateRunInvariant(
  run: AttachmentRepairLedgerRun,
  tenantId: string,
): void {
  if (!UUID_RE.test(run.id)
    || run.tenant_id !== tenantId
    || typeof run.apply !== "boolean"
    || (run.status !== "pending" && run.status !== "completed")
    || !NUMERIC_RUN_FIELDS.every(
      (field) => Number.isSafeInteger(run[field]) && run[field] >= 0,
    )
    || !UTC_TIMESTAMP_RE.test(run.created_at)
    || !UTC_TIMESTAMP_RE.test(run.updated_at)
    || (run.completed_at !== null
      && !UTC_TIMESTAMP_RE.test(run.completed_at))
    || run.entry_total < 1
    || run.inventory_total < 1
    || run.checkpoint > run.entry_total
    || (run.status === "completed" && run.checkpoint !== run.entry_total)
    || run.repaired + run.would_repair + run.unavailable + run.pending
      !== run.inventory_total
    || run.entry_repaired + run.entry_would_repair
      + run.entry_unavailable + run.entry_pending !== run.entry_total
    || run.operator_action > run.unavailable
    || run.entry_operator_action > run.entry_unavailable
    || run.retrying > run.pending
    || run.entry_retrying > run.entry_pending
    || (run.status === "completed") !== (run.entry_pending === 0)
    || (run.status === "completed") !== (run.completed_at !== null)) {
    throw new AttachmentRepairMaintenanceError("invariant_failure");
  }
}

function terminalFailureCode(
  run: AttachmentRepairLedgerRun,
  phase: AttachmentRepairMaintenancePhase,
): AttachmentRepairMaintenanceFailureCode | null {
  if (run.operator_action !== 0 || run.entry_operator_action !== 0) {
    return "operator_action";
  }
  if (run.unavailable !== 0 || run.entry_unavailable !== 0) {
    return "unavailable";
  }
  if (run.pending !== 0 || run.retrying !== 0
    || run.entry_pending !== 0 || run.entry_retrying !== 0
    || run.status !== "completed") {
    return "incomplete";
  }
  if (phase === "apply"
    && (run.apply !== true
      || run.repaired !== run.inventory_total
      || run.would_repair !== 0
      || run.entry_repaired !== run.entry_total
      || run.entry_would_repair !== 0)) {
    return "invariant_failure";
  }
  if (phase === "dry-run" && run.apply !== false) {
    return "invariant_failure";
  }
  return null;
}

export interface AttachmentRepairReviewedDryRunProof {
  tenantId: string;
  runId: string;
  resultSha256: string;
}

export type AttachmentRepairReviewedDryRunValidation =
  | { ok: true }
  | { ok: false; reason: "invariant_failure" | "review_mismatch" };

/**
 * Pure validation shared by the image-bundled maintenance lane and the public
 * API apply gate. The result hash intentionally excludes tenant_id, so the
 * explicit tenant comparison is part of the proof and must not be removed.
 */
export function validateAttachmentRepairReviewedDryRun(
  run: AttachmentRepairLedgerRun | null,
  proof: AttachmentRepairReviewedDryRunProof,
): AttachmentRepairReviewedDryRunValidation {
  if (!run
    || !UUID_RE.test(proof.runId)
    || !SHA256_RE.test(proof.resultSha256)) {
    return { ok: false, reason: "review_mismatch" };
  }
  try {
    validateRunInvariant(run, proof.tenantId);
  } catch {
    return { ok: false, reason: "invariant_failure" };
  }
  if (run.id.toLowerCase() !== proof.runId.toLowerCase()
    || terminalFailureCode(run, "dry-run") !== null
    || attachmentRepairRunResultSha256(run) !== proof.resultSha256) {
    return { ok: false, reason: "review_mismatch" };
  }
  return { ok: true };
}

function reportFor(
  run: AttachmentRepairLedgerRun,
  options: AttachmentRepairMaintenanceOptions,
  provenance: EcsTaskProvenance,
  failureCode: AttachmentRepairMaintenanceFailureCode | null,
): AttachmentRepairMaintenanceReport {
  return {
    container_name: provenance.containerName,
    failure_code: failureCode,
    image_digest: provenance.imageDigest,
    image_revision: provenance.imageRevision,
    manifest_sha256: options.manifestSha256,
    phase: options.phase,
    repair: publicAttachmentRepairRun(run),
    result_sha256: attachmentRepairRunResultSha256(run),
    run_id: run.id,
    schema_version: 1,
    status: failureCode === null ? "pass" : "fail",
    task_arn: provenance.taskArn,
    task_definition_arn: provenance.taskDefinitionArn,
  };
}

async function executeAttachmentRepairMaintenanceInner(
  options: AttachmentRepairMaintenanceOptions,
  deps: AttachmentRepairMaintenanceDeps,
): Promise<AttachmentRepairMaintenanceReport> {
  const rawManifest = deps.env[ATTACHMENT_REPAIR_MANIFEST_ENV];
  if (!rawManifest) {
    throw new AttachmentRepairMaintenanceError("config_failure");
  }
  let manifest: AttachmentRepairMaintenanceManifest;
  try {
    manifest = parseAttachmentRepairMaintenanceManifest(
      rawManifest,
      options.manifestSha256,
    );
  } catch (error) {
    if (error instanceof AttachmentRepairMaintenanceError) throw error;
    throw new AttachmentRepairMaintenanceError("config_failure");
  }

  let provenance: EcsTaskProvenance;
  try {
    provenance = await resolveTaskProvenance(options, deps);
  } catch {
    throw new AttachmentRepairMaintenanceError("provenance_failure");
  }
  const canonicalBucket = resolveAttachmentRepairCanonicalBucket(deps.env);
  if (!canonicalBucket) {
    throw new AttachmentRepairMaintenanceError("config_failure");
  }

  const context = await deps.openStore(manifest.tenant_id);
  try {
    if (options.phase === "apply") {
      const dryRun = await context.tenantStore.getAttachmentRepairRun(
        options.dryRunId!,
      );
      if (!dryRun) {
        throw new AttachmentRepairMaintenanceError("provenance_failure");
      }
      const reviewedDryRun = validateAttachmentRepairReviewedDryRun(dryRun, {
        tenantId: manifest.tenant_id,
        runId: options.dryRunId!,
        resultSha256: options.dryRunResultSha256!,
      });
      if (!reviewedDryRun.ok) {
        throw new AttachmentRepairMaintenanceError(
          reviewedDryRun.reason === "invariant_failure"
            ? "invariant_failure"
            : "provenance_failure",
        );
      }
      let manifestDryRun: AttachmentRepairLedgerRun;
      try {
        manifestDryRun =
          await context.tenantStore.createOrGetAttachmentRepairRun({
            idempotencyKey: manifest.dry_run_idempotency_key,
            canonicalBucket,
            apply: false,
            entries: manifest.entries,
          });
      } catch (error) {
        if (error instanceof AttachmentRepairIdempotencyConflictError) {
          throw new AttachmentRepairMaintenanceError("provenance_failure");
        }
        throw error;
      }
      const replayedDryRun = validateAttachmentRepairReviewedDryRun(
        manifestDryRun,
        {
          tenantId: manifest.tenant_id,
          runId: dryRun.id,
          resultSha256: options.dryRunResultSha256!,
        },
      );
      if (!replayedDryRun.ok) {
        throw new AttachmentRepairMaintenanceError(
          replayedDryRun.reason === "invariant_failure"
            ? "invariant_failure"
            : "provenance_failure",
        );
      }
    }

    let repair = await context.tenantStore.createOrGetAttachmentRepairRun({
      idempotencyKey: options.phase === "apply"
        ? manifest.apply_idempotency_key
        : manifest.dry_run_idempotency_key,
      canonicalBucket,
      apply: options.phase === "apply",
      entries: manifest.entries,
    });
    if (options.expectedRunId && repair.id !== options.expectedRunId) {
      throw new AttachmentRepairMaintenanceError("provenance_failure");
    }

    for (let page = 0;
      page < options.maxPages && repair.status !== "completed";
      page += 1) {
      const before = canonicalAttachmentRepairJson(
        publicAttachmentRepairRun(repair),
      );
      repair = await deps.processPage(
        context.rootStore,
        context.tenantStore,
        repair.id,
        options.pageLimit,
        deps.env,
      );
      if (canonicalAttachmentRepairJson(publicAttachmentRepairRun(repair))
        === before) {
        break;
      }
    }

    validateRunInvariant(repair, manifest.tenant_id);
    const failureCode = terminalFailureCode(repair, options.phase);
    const report = reportFor(repair, options, provenance, failureCode);
    if (failureCode !== null) {
      throw new AttachmentRepairMaintenanceError(failureCode, report);
    }
    return report;
  } catch (error) {
    if (error instanceof AttachmentRepairMaintenanceError) throw error;
    throw new AttachmentRepairMaintenanceError("unavailable");
  } finally {
    await context.close();
  }
}

export async function executeAttachmentRepairMaintenance(
  options: AttachmentRepairMaintenanceOptions,
  deps: AttachmentRepairMaintenanceDeps,
): Promise<AttachmentRepairMaintenanceReport> {
  try {
    const report = await executeAttachmentRepairMaintenanceInner(options, deps);
    deps.emit(canonicalAttachmentRepairJson(report));
    return report;
  } catch (error) {
    const failure = error instanceof AttachmentRepairMaintenanceError
      ? error
      : new AttachmentRepairMaintenanceError("unavailable");
    deps.emit(canonicalAttachmentRepairJson(
      failure.report ?? { failure_code: failure.code, status: "fail" },
    ));
    throw failure;
  }
}

async function defaultFetchTaskMetadata(uri: string): Promise<unknown> {
  const response = await fetch(uri, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new AttachmentRepairMaintenanceError("provenance_failure");
  }
  return response.json();
}

async function defaultOpenStore(
  tenantId: string,
): Promise<AttachmentRepairMaintenanceStoreContext> {
  const [{ getSelfHostedPool, closeSelfHostedPool }, { EmailsSelfHostedStore }] =
    await Promise.all([
      import("./env.js"),
      import("./store.js"),
    ]);
  const { client } = getSelfHostedPool();
  const rootStore = new EmailsSelfHostedStore(client);
  return {
    rootStore,
    tenantStore: rootStore.forTenant(tenantId),
    close: closeSelfHostedPool,
  };
}

export async function runAttachmentRepairMaintenanceCommand(
  args: readonly string[],
): Promise<void> {
  let executionStarted = false;
  try {
    const options = parseAttachmentRepairMaintenanceArgs(args);
    executionStarted = true;
    await executeAttachmentRepairMaintenance(options, {
      env: process.env,
      fetchTaskMetadata: defaultFetchTaskMetadata,
      openStore: defaultOpenStore,
      processPage: (
        rootStore,
        tenantStore,
        runId,
        limit,
        env,
      ) => processCanonicalS3AttachmentRepairPage(
        rootStore,
        tenantStore as TenantScopedStore,
        runId,
        limit,
        env,
      ),
      emit: (line) => console.log(line),
    });
  } catch (error) {
    const failure = error instanceof AttachmentRepairMaintenanceError
      ? error
      : new AttachmentRepairMaintenanceError(
        executionStarted ? "unavailable" : "config_failure",
      );
    if (!executionStarted) {
      console.log(canonicalAttachmentRepairJson({
        failure_code: failure.code,
        status: "fail",
      }));
    }
    process.exitCode = failure.exitCode;
  }
}
