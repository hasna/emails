import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ATTACHMENT_REPAIR_IMAGE_REVISION_ENV,
  ATTACHMENT_REPAIR_MANIFEST_ENV,
  AttachmentRepairMaintenanceError,
  attachmentRepairRunResultSha256,
  canonicalAttachmentRepairJson,
  executeAttachmentRepairMaintenance,
  parseAttachmentRepairMaintenanceArgs,
  parseAttachmentRepairMaintenanceManifest,
  type AttachmentRepairMaintenanceDeps,
  type AttachmentRepairMaintenanceOptions,
} from "./attachment-repair-maintenance.js";
import type { AttachmentRepairLedgerRun } from "./store.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const DRY_RUN_ID = "22222222-2222-4222-8222-222222222222";
const APPLY_RUN_ID = "33333333-3333-4333-8333-333333333333";
const UNRELATED_DRY_RUN_ID = "55555555-5555-4555-8555-555555555555";
const TASK_ARN =
  "arn:aws:ecs:eu-central-1:123456789012:task/rehearsal/44444444444444444444444444444444";
const TASK_DEFINITION_ARN =
  "arn:aws:ecs:eu-central-1:123456789012:task-definition/rehearsal-api-attachment-repair:7";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE_REVISION = "b".repeat(40);
const CONTAINER_NAME = "attachment-repair";
const OBJECT_KEY = "inbound/private-object.eml";
const RECIPIENT = "private@example.test";
const MESSAGE_ID = "private-message-id";

const manifestObject = {
  apply_idempotency_key: "attachment-repair-apply-1",
  dry_run_idempotency_key: "attachment-repair-dry-run-1",
  entries: [{
    canary_message_ids: [MESSAGE_ID],
    object_key: OBJECT_KEY,
    recipients: [RECIPIENT],
  }],
  purpose: "attachment-repair-ledger",
  schema_version: 1,
  tenant_id: TENANT_ID,
};
const manifest = canonicalAttachmentRepairJson(manifestObject);
const manifestSha256 = createHash("sha256").update(manifest).digest("hex");

function run(overrides: Partial<AttachmentRepairLedgerRun> = {}): AttachmentRepairLedgerRun {
  return {
    id: DRY_RUN_ID,
    tenant_id: TENANT_ID,
    apply: false,
    status: "completed",
    entry_total: 1,
    inventory_total: 2,
    repaired: 0,
    would_repair: 2,
    unavailable: 0,
    operator_action: 0,
    pending: 0,
    retrying: 0,
    entry_repaired: 0,
    entry_would_repair: 1,
    entry_unavailable: 0,
    entry_operator_action: 0,
    entry_pending: 0,
    entry_retrying: 0,
    attempts: 1,
    checkpoint: 1,
    created_at: "2026-07-24T10:00:00.000Z",
    updated_at: "2026-07-24T10:00:01.000Z",
    completed_at: "2026-07-24T10:00:01.000Z",
    ...overrides,
  };
}

function options(
  overrides: Partial<AttachmentRepairMaintenanceOptions> = {},
): AttachmentRepairMaintenanceOptions {
  return {
    phase: "dry-run",
    manifestSha256,
    pageLimit: 25,
    maxPages: 8,
    expectedTaskDefinitionArn: TASK_DEFINITION_ARN,
    expectedImageDigest: IMAGE_DIGEST,
    expectedImageRevision: IMAGE_REVISION,
    containerName: CONTAINER_NAME,
    ...overrides,
  };
}

function metadata() {
  return {
    TaskARN: TASK_ARN,
    Family: "rehearsal-api-attachment-repair",
    Revision: "7",
    Containers: [{
      Name: CONTAINER_NAME,
      Image: `registry.example/mailery@${IMAGE_DIGEST}`,
      ImageID: IMAGE_DIGEST,
      Labels: { "org.opencontainers.image.revision": IMAGE_REVISION },
    }],
  };
}

function deps(
  dryRun: AttachmentRepairLedgerRun,
  applyRun = run({
    id: APPLY_RUN_ID,
    apply: true,
    repaired: 2,
    would_repair: 0,
    entry_repaired: 1,
    entry_would_repair: 0,
  }),
  manifestDryRun = dryRun,
): {
  deps: AttachmentRepairMaintenanceDeps;
  creates: Array<Record<string, unknown>>;
  emitted: string[];
  closes: number[];
} {
  const runs = new Map<string, AttachmentRepairLedgerRun>([
    [dryRun.id, dryRun],
    [applyRun.id, applyRun],
  ]);
  const creates: Array<Record<string, unknown>> = [];
  const emitted: string[] = [];
  const closes: number[] = [];
  const tenantStore = {
    createOrGetAttachmentRepairRun: async (input: Record<string, unknown>) => {
      creates.push(input);
      return input["apply"] === true ? applyRun : manifestDryRun;
    },
    getAttachmentRepairRun: async (id: string) => runs.get(id) ?? null,
  };
  return {
    creates,
    emitted,
    closes,
    deps: {
      env: {
        EMAILS_MODE: "self_hosted",
        EMAILS_DATABASE_URL: "postgresql://redacted",
        EMAILS_INGEST_S3_BUCKET: "canonical-inbound",
        ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/example",
        [ATTACHMENT_REPAIR_IMAGE_REVISION_ENV]: IMAGE_REVISION,
        [ATTACHMENT_REPAIR_MANIFEST_ENV]: manifest,
      },
      fetchTaskMetadata: async () => metadata(),
      openStore: async () => ({
        rootStore: {} as never,
        tenantStore: tenantStore as never,
        close: async () => {
          closes.push(1);
        },
      }),
      processPage: async (_root, _tenant, id) => runs.get(id)!,
      emit: (line) => emitted.push(line),
    },
  };
}

describe("attachment repair maintenance manifest and CLI boundary", () => {
  test("accepts one canonical exact-canary manifest and rejects alternate or sensitive shapes", () => {
    expect(parseAttachmentRepairMaintenanceManifest(manifest, manifestSha256)).toEqual(
      manifestObject,
    );
    expect(() => parseAttachmentRepairMaintenanceManifest(
      `${manifest}\n`,
      createHash("sha256").update(`${manifest}\n`).digest("hex"),
    )).toThrow(/canonical JSON/i);
    expect(() => parseAttachmentRepairMaintenanceManifest(
      canonicalAttachmentRepairJson({ ...manifestObject, apply: true }),
      createHash("sha256")
        .update(canonicalAttachmentRepairJson({ ...manifestObject, apply: true }))
        .digest("hex"),
    )).toThrow(/exact schema/i);
    expect(() => parseAttachmentRepairMaintenanceManifest(
      canonicalAttachmentRepairJson({
        ...manifestObject,
        entries: [{ ...manifestObject.entries[0], content_base64: "secret-payload" }],
      }),
      createHash("sha256")
        .update(canonicalAttachmentRepairJson({
          ...manifestObject,
          entries: [{ ...manifestObject.entries[0], content_base64: "secret-payload" }],
        }))
        .digest("hex"),
    )).toThrow(/unsupported fields|exact schema/i);
  });

  test("requires explicit phase/provenance and keeps pagination bounded", () => {
    expect(parseAttachmentRepairMaintenanceArgs([
      "--phase", "dry-run",
      "--manifest-sha256", manifestSha256,
      "--page-limit", "25",
      "--max-pages", "8",
      "--task-definition-arn", TASK_DEFINITION_ARN,
      "--image-digest", IMAGE_DIGEST,
      "--image-revision", IMAGE_REVISION,
      "--container-name", CONTAINER_NAME,
    ])).toEqual(options());

    expect(() => parseAttachmentRepairMaintenanceArgs([
      "--phase", "apply",
      "--manifest-sha256", manifestSha256,
      "--page-limit", "26",
      "--max-pages", "8",
      "--task-definition-arn", TASK_DEFINITION_ARN,
      "--image-digest", IMAGE_DIGEST,
      "--image-revision", IMAGE_REVISION,
      "--container-name", CONTAINER_NAME,
    ])).toThrow(/page limit/i);
    expect(() => parseAttachmentRepairMaintenanceArgs([
      "--phase", "apply",
      "--manifest-sha256", manifestSha256,
      "--task-definition-arn", TASK_DEFINITION_ARN,
      "--image-digest", IMAGE_DIGEST,
      "--image-revision", IMAGE_REVISION,
      "--container-name", CONTAINER_NAME,
    ])).toThrow(/dry-run proof/i);
    expect(() => parseAttachmentRepairMaintenanceArgs([
      "--phase", "dry-run",
      "--manifest-sha256", manifestSha256,
      "--task-definition-arn", TASK_DEFINITION_ARN,
      "--image-digest", IMAGE_DIGEST,
      "--image-revision", IMAGE_REVISION,
      "--container-name", CONTAINER_NAME,
      "--bucket", "caller-controlled",
    ])).toThrow(/unsupported option/i);
  });
});

describe("image-bundled attachment repair maintenance execution", () => {
  test("creates or resumes a dry-run ledger and emits only stable aggregate ECS-bound JSON", async () => {
    const fixture = deps(run());
    const report = await executeAttachmentRepairMaintenance(options(), fixture.deps);

    expect(report).toMatchObject({
      status: "pass",
      failure_code: null,
      phase: "dry-run",
      task_arn: TASK_ARN,
      task_definition_arn: TASK_DEFINITION_ARN,
      image_digest: IMAGE_DIGEST,
      image_revision: IMAGE_REVISION,
      manifest_sha256: manifestSha256,
      run_id: DRY_RUN_ID,
    });
    expect(report.result_sha256).toBe(attachmentRepairRunResultSha256(run()));
    expect(fixture.creates).toEqual([{
      idempotencyKey: manifestObject.dry_run_idempotency_key,
      canonicalBucket: "canonical-inbound",
      apply: false,
      entries: manifestObject.entries,
    }]);
    expect(fixture.closes).toHaveLength(1);
    expect(fixture.emitted).toEqual([canonicalAttachmentRepairJson(report)]);
    const output = fixture.emitted[0]!;
    expect(output).not.toContain(OBJECT_KEY);
    expect(output).not.toContain(RECIPIENT);
    expect(output).not.toContain(MESSAGE_ID);
    expect(output).not.toContain("postgresql://");
    expect(report.repair).not.toHaveProperty("tenant_id");
  });

  test("uses the reviewed task revision env when ECS metadata omits an optional image label", async () => {
    const fixture = deps(run());
    fixture.deps.fetchTaskMetadata = async () => ({
      ...metadata(),
      Containers: [{
        ...metadata().Containers[0],
        Labels: {},
      }],
    });

    const report = await executeAttachmentRepairMaintenance(options(), fixture.deps);
    expect(report.image_revision).toBe(IMAGE_REVISION);
    expect(report.status).toBe("pass");
  });

  test("requires the exact completed dry-run hash before creating the apply ledger", async () => {
    const dryRun = run();
    const fixture = deps(dryRun);
    const applyOptions = options({
      phase: "apply",
      dryRunId: DRY_RUN_ID,
      dryRunResultSha256: attachmentRepairRunResultSha256(dryRun),
      expectedRunId: APPLY_RUN_ID,
    });

    const report = await executeAttachmentRepairMaintenance(applyOptions, fixture.deps);
    expect(report).toMatchObject({
      status: "pass",
      phase: "apply",
      run_id: APPLY_RUN_ID,
    });
    expect(fixture.creates).toEqual([
      {
        idempotencyKey: manifestObject.dry_run_idempotency_key,
        canonicalBucket: "canonical-inbound",
        apply: false,
        entries: manifestObject.entries,
      },
      {
        idempotencyKey: manifestObject.apply_idempotency_key,
        canonicalBucket: "canonical-inbound",
        apply: true,
        entries: manifestObject.entries,
      },
    ]);

    const mismatch = deps(dryRun);
    await expect(executeAttachmentRepairMaintenance({
      ...applyOptions,
      dryRunResultSha256: "c".repeat(64),
    }, mismatch.deps)).rejects.toMatchObject({
      code: "provenance_failure",
    });
    expect(mismatch.creates).toEqual([]);

    const unrelated = deps(
      dryRun,
      undefined,
      run({ id: UNRELATED_DRY_RUN_ID }),
    );
    await expect(executeAttachmentRepairMaintenance(
      applyOptions,
      unrelated.deps,
    )).rejects.toMatchObject({
      code: "provenance_failure",
    });
    expect(unrelated.creates).toEqual([{
      idempotencyKey: manifestObject.dry_run_idempotency_key,
      canonicalBucket: "canonical-inbound",
      apply: false,
      entries: manifestObject.entries,
    }]);
  });

  test("fails nonzero semantics for incomplete, unavailable, operator-action, and invariant states", async () => {
    const cases: Array<[AttachmentRepairLedgerRun, string]> = [
      [run({
        status: "pending",
        pending: 2,
        retrying: 2,
        entry_pending: 1,
        entry_retrying: 1,
        would_repair: 0,
        entry_would_repair: 0,
        checkpoint: 0,
        completed_at: null,
      }), "incomplete"],
      [run({
        unavailable: 2,
        would_repair: 0,
        entry_unavailable: 1,
        entry_would_repair: 0,
      }), "unavailable"],
      [run({
        unavailable: 2,
        operator_action: 2,
        would_repair: 0,
        entry_unavailable: 1,
        entry_operator_action: 1,
        entry_would_repair: 0,
      }), "operator_action"],
      [run({ inventory_total: 3 }), "invariant_failure"],
      [run({ checkpoint: 0 }), "invariant_failure"],
    ];

    for (const [candidate, code] of cases) {
      const fixture = deps(candidate);
      try {
        await executeAttachmentRepairMaintenance(options(), fixture.deps);
        throw new Error("expected maintenance failure");
      } catch (error) {
        expect(error).toBeInstanceOf(AttachmentRepairMaintenanceError);
        expect((error as AttachmentRepairMaintenanceError).code).toBe(code);
        expect((error as AttachmentRepairMaintenanceError).exitCode).not.toBe(0);
      }
      expect(fixture.emitted).toHaveLength(1);
      expect(fixture.emitted[0]).not.toContain(OBJECT_KEY);
      expect(fixture.emitted[0]).not.toContain(RECIPIENT);
      expect(fixture.emitted[0]).not.toContain(MESSAGE_ID);
    }
  });

  test("rejects local or mismatched ECS provenance before opening the ledger", async () => {
    for (const badDeps of [
      { metadataUri: "", metadata: metadata() },
      {
        metadataUri: "http://169.254.170.2/v4/example",
        metadata: { ...metadata(), TaskARN: TASK_ARN.replace("123456789012", "999999999999") },
      },
      {
        metadataUri: "http://169.254.170.2/v4/example",
        metadata: {
          ...metadata(),
          Containers: [{ ...metadata().Containers[0], ImageID: `sha256:${"d".repeat(64)}` }],
        },
      },
    ]) {
      const fixture = deps(run());
      fixture.deps.env.ECS_CONTAINER_METADATA_URI_V4 = badDeps.metadataUri;
      fixture.deps.fetchTaskMetadata = async () => badDeps.metadata;
      let opened = false;
      const originalOpen = fixture.deps.openStore;
      fixture.deps.openStore = async (tenantId) => {
        opened = true;
        return originalOpen(tenantId);
      };
      await expect(executeAttachmentRepairMaintenance(options(), fixture.deps))
        .rejects.toMatchObject({ code: "provenance_failure" });
      expect(opened).toBe(false);
      expect(fixture.emitted).toEqual([
        canonicalAttachmentRepairJson({
          failure_code: "provenance_failure",
          status: "fail",
        }),
      ]);
    }

    const missingRevision = deps(run());
    delete missingRevision.deps.env[ATTACHMENT_REPAIR_IMAGE_REVISION_ENV];
    let opened = false;
    const originalOpen = missingRevision.deps.openStore;
    missingRevision.deps.openStore = async (tenantId) => {
      opened = true;
      return originalOpen(tenantId);
    };
    await expect(executeAttachmentRepairMaintenance(
      options(),
      missingRevision.deps,
    )).rejects.toMatchObject({ code: "provenance_failure" });
    expect(opened).toBe(false);
  });
});

describe("server maintenance command boundary", () => {
  test("is image-runnable and rejects caller buckets with stable aggregate config JSON", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "run",
        "src/server/index.ts",
        "attachment-repair-ledger",
        "--phase",
        "dry-run",
        "--bucket",
        "caller-controlled",
      ],
      cwd: process.cwd(),
      env: {
        ...process.env,
        EMAILS_DATABASE_URL: "",
        ECS_CONTAINER_METADATA_URI_V4: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(64);
    expect(result.stdout.toString().trim()).toBe(
      canonicalAttachmentRepairJson({
        failure_code: "config_failure",
        status: "fail",
      }),
    );
    expect(result.stderr.toString()).not.toContain("caller-controlled");
  });
});
