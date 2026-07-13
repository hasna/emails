// Self-hosted-ONLY: `aws setup-inbound` provisions S3 + SES receipt rules, which
// is server-side orchestration with no /v1 equivalent, so it now fails loud with
// the server-only message. `aws status` still runs locally against the SES API
// (mocked here), so it keeps a positive test. No local SQLite exists anymore.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";

const mockSesSend = mock(async (_cmd: unknown) => ({}) as Record<string, unknown>);
const mockS3Send = mock(async (_cmd: unknown) => ({}) as Record<string, unknown>);

mock.module("@aws-sdk/client-ses", () => ({
  SESClient: class { send = mockSesSend; },
  CreateReceiptRuleSetCommand: class { constructor(public input: unknown) {} },
  SetActiveReceiptRuleSetCommand: class { constructor(public input: unknown) {} },
  ListReceiptRuleSetsCommand: class { constructor(public input: unknown) {} },
  CreateReceiptRuleCommand: class { constructor(public input: unknown) {} },
  DescribeActiveReceiptRuleSetCommand: class { constructor(public input: unknown) {} },
}));

mock.module("@aws-sdk/client-s3", () => ({
  S3Client: class { send = mockS3Send; },
  CreateBucketCommand: class { constructor(public input: unknown) {} },
  PutBucketPolicyCommand: class { constructor(public input: unknown) {} },
  PutPublicAccessBlockCommand: class { constructor(public input: unknown) {} },
  PutBucketVersioningCommand: class { constructor(public input: unknown) {} },
  PutBucketEncryptionCommand: class { constructor(public input: unknown) {} },
  HeadBucketCommand: class { constructor(public input: unknown) {} },
}));

const { registerAwsCommands } = await import("./aws.js");

async function runAws(args: string[]) {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = ((message?: unknown) => { lines.push(String(message ?? "")); }) as typeof console.log;
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  registerAwsCommands(program, (payload) => { data = payload; });
  try {
    await program.parseAsync(["node", "emails", ...args]);
    return { lines, data };
  } finally {
    console.log = originalLog;
  }
}

async function runAwsExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await runAws(args);
    throw new Error("Expected command to exit");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

beforeEach(() => {
  mockSesSend.mockReset();
  mockS3Send.mockReset();
  mockS3Send.mockImplementation(async () => ({}));
  mockSesSend.mockImplementation(async (cmd: unknown) => {
    const name = (cmd as { constructor?: { name?: string } }).constructor?.name ?? "";
    if (name === "DescribeActiveReceiptRuleSetCommand") {
      return {
        Metadata: { Name: "active-set" },
        Rules: [{ Name: "rule-1", Enabled: true, Recipients: ["ops@example.com"] }],
      };
    }
    if (name === "ListReceiptRuleSetsCommand") {
      return { RuleSets: [{ Name: "active-set" }] };
    }
    return {};
  });
  delete process.env["AWS_PROFILE"];
});

afterEach(() => {
  delete process.env["AWS_PROFILE"];
});

describe("aws status command", () => {
  it("reports the active SES receipt rule set and its rules", async () => {
    const result = await runAws(["aws", "status", "--region", "us-east-1"]);

    expect(result.data).toMatchObject({
      active_rule_set: "active-set",
      rules: [{ Name: "rule-1", Enabled: true, Recipients: ["ops@example.com"] }],
    });
    const out = result.lines.join("\n");
    expect(out).toContain("SES Inbound Status:");
    expect(out).toContain("active-set");
    expect(out).toContain("rule-1");
    expect(out).toContain("ops@example.com");
  });
});

describe("aws setup-inbound command", () => {
  it("is server-only in the self-hosted client", async () => {
    const result = await runAwsExpectingExit([
      "aws",
      "setup-inbound",
      "--domain",
      "example.com",
      "--bucket",
      "inbound-bucket",
    ]);

    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("emails aws setup-inbound");
    expect(result.stderr).toContain("is not available in the self-hosted client");
    expect(result.stderr).toContain("it runs on the self-hosted server");
    // Blocks before ever touching AWS.
    expect(mockSesSend).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});
