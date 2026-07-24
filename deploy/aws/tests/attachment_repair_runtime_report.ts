import { createHash } from "node:crypto";
import {
  ATTACHMENT_REPAIR_IMAGE_REVISION_ENV,
  ATTACHMENT_REPAIR_MANIFEST_ENV,
  attachmentRepairRunResultSha256,
  canonicalAttachmentRepairJson,
  executeAttachmentRepairMaintenance,
  type AttachmentRepairMaintenanceDeps,
  type AttachmentRepairMaintenanceOptions,
} from "../../../src/server/self-hosted/attachment-repair-maintenance.js";
import type { AttachmentRepairLedgerRun } from "../../../src/server/self-hosted/store.js";

export interface AttachmentRepairRuntimeReportInput {
  taskArn: string;
  taskDefinitionArn: string;
  containerName: string;
  imageDigest: string;
  imageRevision: string;
  applyRunId: string;
}

const tenantId = "11111111-1111-4111-8111-111111111111";
const dryRunId = "22222222-2222-4222-8222-222222222222";
const manifest = canonicalAttachmentRepairJson({
  apply_idempotency_key: "attachment-repair-apply-static-contract",
  dry_run_idempotency_key: "attachment-repair-dry-run-static-contract",
  entries: [{
    canary_message_ids: ["static-contract-message"],
    object_key: "inbound/static-contract.eml",
    recipients: ["static-contract@example.test"],
  }],
  purpose: "attachment-repair-ledger",
  schema_version: 1,
  tenant_id: tenantId,
});
const manifestSha256 = createHash("sha256").update(manifest).digest("hex");

function run(
  id: string,
  apply: boolean,
): AttachmentRepairLedgerRun {
  return {
    id,
    tenant_id: tenantId,
    apply,
    status: "completed",
    entry_total: 1,
    inventory_total: 2,
    repaired: apply ? 2 : 0,
    would_repair: apply ? 0 : 2,
    unavailable: 0,
    operator_action: 0,
    pending: 0,
    retrying: 0,
    entry_repaired: apply ? 1 : 0,
    entry_would_repair: apply ? 0 : 1,
    entry_unavailable: 0,
    entry_operator_action: 0,
    entry_pending: 0,
    entry_retrying: 0,
    attempts: 1,
    checkpoint: 1,
    byte_budget: 1024,
    bytes_consumed: 5,
    time_budget_ms: 3_600_000,
    deadline_at: "2026-07-24T11:00:00.000Z",
    created_at: "2026-07-24T10:00:00.000Z",
    updated_at: "2026-07-24T10:00:01.000Z",
    completed_at: "2026-07-24T10:00:01.000Z",
  };
}

export async function generateAttachmentRepairRuntimeReport(
  input: AttachmentRepairRuntimeReportInput,
): Promise<string> {
  const dryRun = run(dryRunId, false);
  const applyRun = run(input.applyRunId, true);
  const emitted: string[] = [];
  const options: AttachmentRepairMaintenanceOptions = {
    phase: "apply",
    manifestSha256,
    pageLimit: 25,
    maxPages: 8,
    expectedTaskDefinitionArn: input.taskDefinitionArn,
    expectedImageDigest: input.imageDigest,
    expectedImageRevision: input.imageRevision,
    containerName: input.containerName,
    expectedRunId: input.applyRunId,
    dryRunId,
    dryRunResultSha256: attachmentRepairRunResultSha256(dryRun),
  };
  const deps: AttachmentRepairMaintenanceDeps = {
    env: {
      EMAILS_MODE: "self_hosted",
      EMAILS_DATABASE_URL: "postgresql://redacted",
      EMAILS_INGEST_S3_BUCKET: "canonical-inbound",
      ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/static-contract",
      [ATTACHMENT_REPAIR_IMAGE_REVISION_ENV]: input.imageRevision,
      [ATTACHMENT_REPAIR_MANIFEST_ENV]: manifest,
    },
    fetchTaskMetadata: async () => ({
      TaskARN: input.taskArn,
      Family: input.taskDefinitionArn.split("/").at(-1)?.split(":")[0],
      Revision: input.taskDefinitionArn.split(":").at(-1),
      Containers: [{
        Name: input.containerName,
        Image: `registry.example/mailery@${input.imageDigest}`,
        ImageID: input.imageDigest,
        Labels: { "org.opencontainers.image.revision": input.imageRevision },
      }],
    }),
    openStore: async () => ({
      rootStore: {} as never,
      tenantStore: {
        createOrGetAttachmentRepairRun: async (
          createInput: { apply: boolean },
        ) => createInput.apply ? applyRun : dryRun,
        getAttachmentRepairRun: async (id: string) =>
          id === dryRunId
            ? dryRun
            : id === input.applyRunId
              ? applyRun
              : null,
      } as never,
      close: async () => {},
    }),
    processPage: async () => applyRun,
    emit: (line) => emitted.push(line),
  };

  const report = await executeAttachmentRepairMaintenance(options, deps);
  if (emitted.length !== 1 || emitted[0] !== canonicalAttachmentRepairJson(report)) {
    throw new Error("runtime report fixture did not emit one canonical report");
  }
  return emitted[0]!;
}

if (import.meta.main) {
  const [
    taskArn,
    taskDefinitionArn,
    containerName,
    imageDigest,
    imageRevision,
    applyRunId,
  ] = process.argv.slice(2);
  if (!taskArn
    || !taskDefinitionArn
    || !containerName
    || !imageDigest
    || !imageRevision
    || !applyRunId) {
    throw new Error(
      "usage: attachment_repair_runtime_report.ts TASK_ARN TASK_DEFINITION_ARN CONTAINER_NAME IMAGE_DIGEST IMAGE_REVISION RUN_ID",
    );
  }
  process.stdout.write(`${await generateAttachmentRepairRuntimeReport({
    taskArn,
    taskDefinitionArn,
    containerName,
    imageDigest,
    imageRevision,
    applyRunId,
  })}\n`);
}
