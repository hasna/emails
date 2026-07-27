// `emails aws` talks to the operator's OWN AWS account in every configuration —
// SES receipt rules and S3 buckets live in AWS, not behind `/v1`, and the
// self-hosted server exposes no inbound-setup route for a client to call. Both
// subcommands therefore get a positive test against the mocked SDKs.
//
// `setup-inbound` used to throw "is not available in the self-hosted client; it
// runs on the self-hosted server" UNCONDITIONALLY — false in local mode, where
// the very same `setupInboundEmail` + `registerS3Source` path already ran under
// `emails domain adopt`, and false about the server, which has no such route.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { setS3SendHandler, resetS3SendHandler, type S3Command } from "../../test-support/aws-s3-mock.js";

const mockSesSend = mock(async (_cmd: unknown) => ({}) as Record<string, unknown>);
// Routed through the SHARED s3 namespace: bun caches a mocked module at its first
// dynamic import process-wide, so a second private `@aws-sdk/client-s3` shape here
// would fight src/lib/aws-inbound.test.ts for the one cached namespace.
const mockS3Send = mock(async (_cmd: unknown) => ({}) as Record<string, unknown>);

mock.module("@aws-sdk/client-ses", () => ({
  SESClient: class { send = mockSesSend; },
  CreateReceiptRuleSetCommand: class { constructor(public input: unknown) {} },
  SetActiveReceiptRuleSetCommand: class { constructor(public input: unknown) {} },
  ListReceiptRuleSetsCommand: class { constructor(public input: unknown) {} },
  CreateReceiptRuleCommand: class { constructor(public input: unknown) {} },
  DescribeActiveReceiptRuleSetCommand: class { constructor(public input: unknown) {} },
  DescribeReceiptRuleCommand: class { constructor(public input: unknown) {} },
  UpdateReceiptRuleCommand: class { constructor(public input: unknown) {} },
}));

const { registerAwsCommands } = await import("./aws.js");

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}
function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

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
  captureInheritedProcessEnv();
  mockSesSend.mockReset();
  mockS3Send.mockReset();
  mockS3Send.mockImplementation(async () => ({}));
  setS3SendHandler((cmd: S3Command) => mockS3Send(cmd));
  // Short-circuits the STS lookup inside setupInboundEmail so the bucket policy
  // is built without a network call. Restored by restoreInheritedProcessEnv().
  process.env["AWS_ACCOUNT_ID"] = "123456789012";
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
  resetS3SendHandler();
  restoreInheritedProcessEnv();
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

function sentCommandNames(spy: typeof mockSesSend | typeof mockS3Send): string[] {
  return spy.mock.calls.map(([cmd]) => (cmd as { constructor?: { name?: string } })?.constructor?.name ?? "");
}

describe("aws setup-inbound command", () => {
  // THE REGRESSION. This threw unconditionally, so it refused in local mode too,
  // and the reason it gave named a server route that does not exist. Worse, it is
  // the command `emails provision *` and the MCP provisioning tools name as THE
  // supported alternative — an honest refusal pointing at a dishonest one.
  it("creates the bucket and the SES receipt rule instead of refusing", async () => {
    const result = await runAws([
      "aws", "setup-inbound", "--domain", "example.com", "--bucket", "inbound-bucket", "--region", "us-east-1",
    ]);

    // It reached AWS: bucket setup on S3, receipt rule on SES.
    expect(sentCommandNames(mockS3Send)).toContain("PutBucketPolicyCommand");
    expect(sentCommandNames(mockSesSend)).toContain("CreateReceiptRuleCommand");
    expect(result.data).toMatchObject({
      bucket: "inbound-bucket",
      s3_prefix: "inbound/example.com/",
      source: { bucket: "inbound-bucket", prefix: "inbound/example.com/" },
    });
    const out = result.lines.join("\n");
    expect(out).toContain("Setup complete!");
    // The MX record is REPORTED for the operator to publish; nothing writes DNS.
    expect(out).toContain("MX  example.com");
    expect(out).toContain("emails inbox sync-s3 --source");
    // The specific falsehoods that shipped.
    expect(out).not.toContain("not available in the self-hosted client");
    expect(out).not.toContain("runs on the self-hosted server");
  });

  it("registers the bucket so inbound sync can find the mail it just routed", async () => {
    const result = await runAws([
      "aws", "setup-inbound", "--domain", "example.com", "--bucket", "inbound-bucket",
    ]);
    const { getInboundBuckets } = await import("../../lib/config.js");
    expect(getInboundBuckets().map((b) => b.bucket)).toContain("inbound-bucket");
    const { listS3Sources } = await import("../../lib/s3-sync.js");
    expect(listS3Sources().map((s) => s.bucket)).toContain("inbound-bucket");
    expect(result.data).toBeTruthy();
  });

  it("fails on a missing bucket without touching AWS, and names the config key", async () => {
    const result = await runAwsExpectingExit(["aws", "setup-inbound", "--domain", "example.com"]);

    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("emails config set inbound_s3_bucket");
    // Says what is missing, not which mode the operator is in.
    expect(result.stderr).not.toContain("self-hosted");
    expect(mockSesSend).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});
