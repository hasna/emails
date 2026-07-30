import { describe, expect, it } from "bun:test";
import {
  REQUIRED_DEPLOYMENT_CHECKS,
  validateDeploymentEvidence,
  validateGateConfig,
} from "../scripts/immutable-deployment-gate.mjs";
import {
  DEPLOYMENT_GATE_COMMAND,
  REQUIRED_GATE_ENV,
  deploymentWorkflowFindings,
} from "../scripts/deployment-workflow-policy-lib.mjs";

const CANDIDATE_SHA = "a".repeat(40);
const ROLLBACK_SHA = "b".repeat(40);
const CANDIDATE_DIGEST = `sha256:${"c".repeat(64)}`;
const ROLLBACK_DIGEST = `sha256:${"d".repeat(64)}`;
const CANDIDATE_INTEGRITY = `sha512-${Buffer.from("candidate").toString("base64")}`;
const ROLLBACK_INTEGRITY = `sha512-${Buffer.from("rollback").toString("base64")}`;

function configFixture(): Record<string, any> {
  return {
    schema_version: 1,
    candidate: {
      package_name: "@hasna/emails",
      package_version: "2.0.0",
      package_integrity: CANDIDATE_INTEGRITY,
      source_sha: CANDIDATE_SHA,
      image_reference: `registry.example/emails@${CANDIDATE_DIGEST}`,
    },
    rollback: {
      package_name: "@hasna/emails",
      package_version: "1.9.0",
      package_integrity: ROLLBACK_INTEGRITY,
      source_sha: ROLLBACK_SHA,
      image_reference: `registry.example/emails@${ROLLBACK_DIGEST}`,
    },
    target: { base_url: "https://emails.example.test" },
    database: { restore_database: "emails_deployment_gate_release_2" },
    latency: { max_probe_ms: 5000 },
    evidence: { max_age_seconds: 900 },
    fixture: {
      classification: "synthetic_designated_test",
      production_data: false,
      message_body_disclosure: false,
      recipient: "deployment-gate@example.test",
      search_token: "release_gate_123456789",
      ordered_message_ids: ["message-new", "message-old"],
      content: { message_id: "message-new", field: "text_body", sha256: "e".repeat(64) },
      attachments: [
        { message_id: "message-new", index: 0, filename: "one.txt", sha256: "f".repeat(64) },
        { message_id: "message-old", index: 0, filename: "two.txt", sha256: "1".repeat(64) },
      ],
    },
  };
}

function evidenceFixture(createdAt = new Date().toISOString()): Record<string, any> {
  const probes = Array.from({ length: 12 }, (_, index) => ({ name: `probe-${index}`, duration_ms: 20 + index }));
  return {
    schema_version: 1,
    kind: "emails-immutable-deployment-gate",
    result: "pass",
    execution_id: "run-42-attempt-1",
    created_at: createdAt,
    candidate: {
      package_name: "@hasna/emails",
      package_version: "2.0.0",
      package_integrity: CANDIDATE_INTEGRITY,
      source_sha: CANDIDATE_SHA,
      image_digest: CANDIDATE_DIGEST,
    },
    rollback: {
      package_name: "@hasna/emails",
      package_version: "1.9.0",
      package_integrity: ROLLBACK_INTEGRITY,
      source_sha: ROLLBACK_SHA,
      image_digest: ROLLBACK_DIGEST,
    },
    fixture: {
      classification: "synthetic_designated_test",
      production_data: false,
      message_body_disclosure: false,
      mailbox_rows: 2,
      attachment_rows: 2,
    },
    latency: { budget_ms: 5000, max_ms: 31, probes },
    backup: {
      archive_sha256: "2".repeat(64),
      source_data_sha256: "3".repeat(64),
      restored_data_sha256: "3".repeat(64),
      source_ledger_sha256: "4".repeat(64),
      restored_ledger_sha256: "4".repeat(64),
    },
    checks: Object.fromEntries(REQUIRED_DEPLOYMENT_CHECKS.map((name) => [name, "pass"])),
  };
}

function expected() {
  const config = validateGateConfig(configFixture());
  return { ...config, executionId: "run-42-attempt-1" };
}

function deploymentWorkflow(): string {
  const env = REQUIRED_GATE_ENV.map((name) => `      ${name}: value`).join("\n");
  return `name: release
on:
  workflow_dispatch:
jobs:
  immutable-deployment-gate:
    runs-on: ubuntu-24.04
    env:
${env}
    steps:
      - run: ${DEPLOYMENT_GATE_COMMAND}
  deploy:
    needs: immutable-deployment-gate
    runs-on: ubuntu-24.04
    steps:
      - run: aws ecs update-service --cluster example --service emails
`;
}

describe("immutable deployment gate config", () => {
  it("accepts only immutable package/image bindings and designated synthetic fixtures", () => {
    const parsed = validateGateConfig(configFixture());
    expect(parsed.candidate).toMatchObject({ sourceSha: CANDIDATE_SHA, version: "2.0.0", integrity: CANDIDATE_INTEGRITY });
    expect(parsed.candidate.image.digest).toBe(CANDIDATE_DIGEST);
    expect(parsed.fixture.orderedIds).toEqual(["message-new", "message-old"]);
  });

  it("rejects mutable images, production rows, body disclosure, and ambient fixture domains", () => {
    const mutations: Array<(value: Record<string, any>) => void> = [
      (value) => { value.candidate.image_reference = "registry.example/emails:latest"; },
      (value) => { value.fixture.production_data = true; },
      (value) => { value.fixture.message_body_disclosure = true; },
      (value) => { value.fixture.recipient = "person@example.com"; },
      (value) => { value.fixture.ordered_message_ids = ["only-one"]; },
      (value) => { value.candidate.extra = "ignored"; },
    ];
    for (const mutate of mutations) {
      const value = configFixture();
      mutate(value);
      expect(() => validateGateConfig(value)).toThrow("immutable deployment gate");
    }
  });
});

describe("immutable deployment evidence", () => {
  it("accepts complete, fresh evidence bound to package gitHead and image digests", () => {
    expect(validateDeploymentEvidence(evidenceFixture(), expected())).toBe(true);
  });

  it("fails closed on omitted checks, binding drift, disclosure, latency, stale evidence, and restore drift", () => {
    const mutations: Array<(value: Record<string, any>) => void> = [
      (value) => { delete value.checks["attachment-download-hash"]; },
      (value) => { value.checks["migration-compatibility"] = "skip"; },
      (value) => { value.candidate.source_sha = ROLLBACK_SHA; },
      (value) => { value.candidate.image_digest = ROLLBACK_DIGEST; },
      (value) => { value.fixture.production_data = true; },
      (value) => { value.fixture.message_body_disclosure = true; },
      (value) => { value.latency.max_ms = 5001; },
      (value) => { value.backup.restored_data_sha256 = "5".repeat(64); },
      (value) => { value.unreviewed = true; },
    ];
    for (const mutate of mutations) {
      const value = evidenceFixture();
      mutate(value);
      expect(() => validateDeploymentEvidence(value, expected())).toThrow("immutable deployment gate");
    }
    const stale = evidenceFixture(new Date(Date.now() - 901_000).toISOString());
    expect(() => validateDeploymentEvidence(stale, expected())).toThrow(/stale/);
  });
});

describe("future deployment workflow policy", () => {
  it("allows a mutating job only behind the canonical fail-closed gate job", () => {
    expect(deploymentWorkflowFindings("release.yml", deploymentWorkflow())).toEqual([]);
  });

  it("rejects missing inputs, missing dependencies, late gates, and error bypasses", () => {
    const fixtures = [
      deploymentWorkflow().replace(`      DEPLOYMENT_GATE_CANDIDATE_SHA: value\n`, ""),
      deploymentWorkflow().replace("    needs: immutable-deployment-gate\n", ""),
      deploymentWorkflow().replace(`      - run: ${DEPLOYMENT_GATE_COMMAND}\n`, ""),
      deploymentWorkflow().replace(`      - run: ${DEPLOYMENT_GATE_COMMAND}`, `      - run: ${DEPLOYMENT_GATE_COMMAND} || true`),
      deploymentWorkflow().replace("    needs: immutable-deployment-gate", "    needs: immutable-deployment-gate\n    if: always()"),
      `name: deploy\non: workflow_dispatch\njobs:\n  deploy:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: terraform apply -auto-approve\n      - run: ${DEPLOYMENT_GATE_COMMAND}\n`,
    ];
    for (const workflow of fixtures) {
      expect(deploymentWorkflowFindings("release.yml", workflow).length).toBeGreaterThan(0);
    }
  });

  it("does not impose deployment credentials or a runtime gate on validation-only CI", () => {
    const ci = `name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: bun test\n`;
    expect(deploymentWorkflowFindings("ci.yml", ci)).toEqual([]);
  });
});

