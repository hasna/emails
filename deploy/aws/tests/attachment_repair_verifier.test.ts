import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateAttachmentRepairRuntimeReport } from "./attachment_repair_runtime_report.js";

const TASK_ARN =
  "arn:aws:ecs:eu-central-1:123456789012:task/rehearsal/44444444444444444444444444444444";
const TASK_DEFINITION_ARN =
  "arn:aws:ecs:eu-central-1:123456789012:task-definition/rehearsal-api-attachment-repair:7";
const CONTAINER_NAME = "attachment-repair";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE_REVISION = "b".repeat(40);
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const fixturePath = fileURLToPath(
  new URL("./fixtures/attachment-repair-runtime-success.json", import.meta.url),
);
const verifierPath = fileURLToPath(
  new URL("../verify_attachment_repair_result.sh", import.meta.url),
);

describe("attachment repair result verifier", () => {
  it("accepts the exact checked-in report emitted by the real maintenance runtime", async () => {
    const report = await generateAttachmentRepairRuntimeReport({
      taskArn: TASK_ARN,
      taskDefinitionArn: TASK_DEFINITION_ARN,
      containerName: CONTAINER_NAME,
      imageDigest: IMAGE_DIGEST,
      imageRevision: IMAGE_REVISION,
      applyRunId: RUN_ID,
    });
    expect(readFileSync(fixturePath, "utf8").trim()).toBe(report);

    const dir = mkdtempSync(join(tmpdir(), "attachment-repair-verifier-"));
    const resultFile = join(dir, "result.json");
    try {
      writeFileSync(resultFile, `${report}\n`, { mode: 0o600 });
      const fileSha256 = createHash("sha256")
        .update(readFileSync(resultFile))
        .digest("hex");
      const manifestSha256 = String(
        (JSON.parse(report) as Record<string, unknown>)["manifest_sha256"],
      );
      const result = Bun.spawnSync({
        cmd: [
          "sh",
          verifierPath,
          resultFile,
          fileSha256,
          TASK_ARN,
          TASK_DEFINITION_ARN,
          CONTAINER_NAME,
          IMAGE_DIGEST,
          IMAGE_REVISION,
          manifestSha256,
          RUN_ID,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
