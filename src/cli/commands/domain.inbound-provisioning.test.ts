// `emails domain add` and the inbound receiving chain.
//
// THE BUG CLASS UNDER TEST: a domain receives mail only when the FULL chain
// exists — MX → SES receipt rule (S3 action to the inbound bucket) → app
// registration. `domain add` used to write the app row ALONE and report success,
// leaving the SES receipt rule to a separate operator step nothing enforced, so
// a forgotten step produced a domain that looked "added" while SES 550-bounced
// every message for it (the survivalpatriots.com incident). These tests pin the
// durable contract:
//
//   * `domain add` provisions the whole chain by default, reusing the merge-safe
//     `setupInboundEmail` (get→merge→put bucket policy, additive receipt rule);
//   * when the chain CANNOT be provisioned from this context it refuses BEFORE
//     writing the app row — never a silent app-only domain;
//   * if the SES leg fails AFTER the row is written, the command fails naming
//     the row's state — never "success";
//   * `--send-only` is the one deliberate way to get a domain without inbound;
//   * `emails domain readiness` audits the chain per domain and flags drift.
//
// Driven against the REAL command over the out-of-process /v1 stub, with the
// AWS SDKs mocked (shared S3/STS mocks + the same compatible inline SES shape
// the sibling aws.test.ts registers). No test reaches real AWS.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { setS3SendHandler, resetS3SendHandler, type S3Command } from "../../test-support/aws-s3-mock.js";
import { setStsSendHandler, resetStsSendHandler } from "../../test-support/aws-sts-mock.js";
import { registerDomainCommands } from "./domain.js";

const mockSesSend = mock(async (_cmd: unknown) => ({}) as Record<string, unknown>);

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

const BUCKET = "emails-inbound-scratch";

// Digit-free scratch HOME (bug 23d0db9b: scratch paths must not contain digits),
// isolating the config-file writes (`addInboundBucket`, the mail-source registry)
// from the operator's real home directory.
function lettersOnly(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
const scratchHome = join(tmpdir(), `emails-inbound-chain-home-${lettersOnly(8)}`);

let stub: V1Stub;
let savedHome: string | undefined;
const SAVED_KEYS = ["EMAILS_INBOUND_S3_BUCKET", "AWS_ACCOUNT_ID", "AWS_REGION", "AWS_DEFAULT_REGION"] as const;
let savedEnv: Record<string, string | undefined>;
let savedExitCode: number | string | undefined;

async function runDomainCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerDomainCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

async function runDomainCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await runDomainCommand(args);
    throw new Error("Expected command to exit");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

/** S3 handler for a bucket that exists and has no policy yet; records every put. */
function healthyBucket() {
  const state = { policyPuts: [] as string[], commands: [] as string[] };
  setS3SendHandler((cmd: S3Command) => {
    state.commands.push(cmd.__type);
    if (cmd.__type === "GetBucketPolicy") {
      throw Object.assign(new Error("The bucket policy does not exist"), { name: "NoSuchBucketPolicy" });
    }
    if (cmd.__type === "PutBucketPolicy") {
      state.policyPuts.push(String(cmd.input["Policy"]));
      return {};
    }
    return {};
  });
  return state;
}

beforeAll(async () => {
  stub = await startV1Stub({ openapi: true });
  savedHome = process.env["HOME"];
  mkdirSync(scratchHome, { recursive: true, mode: 0o700 });
});

afterAll(() => {
  stub.stop();
  rmSync(scratchHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
  savedEnv = {};
  for (const key of SAVED_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["HOME"] = scratchHome;
  savedExitCode = process.exitCode;
  mockSesSend.mockReset();
  mockSesSend.mockImplementation(async () => ({}));
  setS3SendHandler(() => ({}));
  resetStsSendHandler(); // default: STS throws, like the credential-less real SDK
});

afterEach(() => {
  stub.clearEnv();
  for (const key of SAVED_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  // The readiness drift test sets `process.exitCode = 1` through the command
  // action. Restoring the SAVED value is not enough: assigning `undefined` does
  // not clear an already-set exit code in bun, so the whole test process would
  // exit 1 with every test green — exactly the failure CI's isolated diagnosis
  // step surfaced. An explicit 0 clears it; bun still exits non-zero on its own
  // when any test actually fails.
  process.exitCode = typeof savedExitCode === "number" ? savedExitCode : 0;
  resetS3SendHandler();
  resetStsSendHandler();
});

describe("domain add — full-chain provisioning", () => {
  it("REFUSES to register a domain when no inbound bucket is resolvable — never a silent app-only row", async () => {
    // No --bucket, no EMAILS_INBOUND_S3_BUCKET, no config: the SES receipt rule
    // cannot be created, so the app row must not be written either.
    const result = await runDomainCommandExpectingExit([
      "domain", "add", "half.example.com", "--provider", "sandbox",
    ]);

    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("NOT registered");
    expect(result.stderr).toContain("--bucket");
    expect(result.stderr).toContain("EMAILS_INBOUND_S3_BUCKET");
    expect(result.stderr).toContain("--send-only");
    expect(await stub.list("domains")).toHaveLength(0);
  });

  it("REFUSES before writing when AWS credentials cannot be resolved", async () => {
    process.env["EMAILS_INBOUND_S3_BUCKET"] = BUCKET;
    // The shared STS mock's default handler throws — exactly the shape the real
    // SDK produces in a context with no AWS credentials.
    const result = await runDomainCommandExpectingExit([
      "domain", "add", "nocreds.example.com", "--provider", "sandbox",
    ]);

    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("credentials");
    expect(result.stderr).toContain("--send-only");
    expect(await stub.list("domains")).toHaveLength(0);
  });

  it("provisions the FULL chain by default: app row + SES receipt rule + registered sync source", async () => {
    process.env["EMAILS_INBOUND_S3_BUCKET"] = BUCKET;
    process.env["AWS_ACCOUNT_ID"] = "111122223333";
    const bucket = healthyBucket();

    const result = await runDomainCommand([
      "domain", "add", "full.example.com", "--provider", "sandbox",
    ]);

    // The app row reached /v1.
    const rows = await stub.list("domains");
    expect(rows.map((row) => row["domain"])).toEqual(["full.example.com"]);
    // The SES leg really ran: the merge-safe bucket-policy path wrote the grant.
    expect(bucket.policyPuts.length).toBe(1);
    expect(bucket.commands.indexOf("GetBucketPolicy")).toBeGreaterThanOrEqual(0);
    // The command reports the whole chain, not just the row.
    expect(result.data).toMatchObject({
      domain: "full.example.com",
      inbound: {
        bucket: BUCKET,
        rule_name: "inbound-full-example-com",
      },
    });
    const inbound = (result.data as { inbound: { mx_record: string; source_id: string } }).inbound;
    expect(inbound.mx_record).toContain("inbound-smtp");
    expect(typeof inbound.source_id).toBe("string");
    expect(result.out).toContain("MX");
  });

  it("surfaces an SES failure AFTER the app row is written as a failure naming the row — never success", async () => {
    process.env["EMAILS_INBOUND_S3_BUCKET"] = BUCKET;
    process.env["AWS_ACCOUNT_ID"] = "111122223333";
    setS3SendHandler((cmd: S3Command) => {
      if (cmd.__type === "GetBucketPolicy") {
        throw Object.assign(new Error("not allowed to read the bucket policy"), { name: "AccessDenied" });
      }
      return {};
    });

    const result = await runDomainCommandExpectingExit([
      "domain", "add", "partial.example.com", "--provider", "sandbox",
    ]);

    expect(result.error).toBe("process.exit:1");
    const rows = await stub.list("domains");
    expect(rows).toHaveLength(1);
    const id = String(rows[0]!["id"]);
    // The failure names the app row's state and the exact completion path.
    expect(result.stderr).toContain(id.slice(0, 8));
    expect(result.stderr).toContain("NOT wired");
    expect(result.stderr).toContain("emails aws setup-inbound --domain partial.example.com");
  });

  it("names the TRUE row state when refusing for an already-registered domain", async () => {
    // Re-running `add` on an existing half-provisioned domain in a context that
    // cannot provision must not claim the domain "was NOT registered" — it is.
    await stub.seed({
      domains: [{ id: "dom-already", domain: "already.example.com", provider: "sandbox", verified: false }],
    });

    const result = await runDomainCommandExpectingExit([
      "domain", "add", "already.example.com", "--provider", "sandbox",
    ]);

    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("already registered");
    expect(result.stderr).toContain("dom-alre");
    expect(result.stderr).not.toContain("NOT registered");
    expect(await stub.list("domains")).toHaveLength(1);
  });

  it("--send-only deliberately skips inbound and says so — the ONLY way to get a domain without the chain", async () => {
    const result = await runDomainCommand([
      "domain", "add", "outbound.example.com", "--provider", "sandbox", "--send-only",
    ]);

    expect(await stub.list("domains")).toHaveLength(1);
    expect(result.out.toLowerCase()).toContain("send-only");
    expect(result.out).toContain("emails aws setup-inbound --domain outbound.example.com");
  });

  it("--dry-run describes the full chain it would create, and mutates nothing", async () => {
    process.env["EMAILS_INBOUND_S3_BUCKET"] = BUCKET;
    const s3Commands: string[] = [];
    setS3SendHandler((cmd: S3Command) => { s3Commands.push(cmd.__type); return {}; });

    const result = await runDomainCommand([
      "domain", "add", "planned.example.com", "--provider", "sandbox", "--dry-run",
    ]);

    expect(result.data).toMatchObject({
      dry_run: true,
      would_create_domain: true,
      inbound_chain: { planned: true, bucket: BUCKET },
    });
    const chain = (result.data as { inbound_chain: { mx_record: string } }).inbound_chain;
    expect(chain.mx_record).toContain("inbound-smtp");
    expect(await stub.list("domains")).toHaveLength(0);
    expect(s3Commands).toHaveLength(0);
  });

  it("--dry-run states plainly when a real run would refuse (no bucket), instead of hiding it", async () => {
    const result = await runDomainCommand([
      "domain", "add", "planned.example.com", "--provider", "sandbox", "--dry-run",
    ]);

    const chain = (result.data as { inbound_chain: { blocked_by?: string } }).inbound_chain;
    expect(String(chain.blocked_by)).toContain("bucket");
    expect(await stub.list("domains")).toHaveLength(0);
  });
});

describe("domain readiness — the drift detector", () => {
  it("flags a registered domain whose SES receipt rule is MISSING", async () => {
    process.env["EMAILS_INBOUND_S3_BUCKET"] = BUCKET;
    await stub.seed({
      domains: [{ id: "dom-half", domain: "half.example.com", provider: "sandbox", verified: false }],
    });
    // An active rule set exists, but no rule covers this domain.
    mockSesSend.mockImplementation(async (cmd: unknown) => {
      const name = (cmd as { constructor?: { name?: string } })?.constructor?.name ?? "";
      if (name === "DescribeActiveReceiptRuleSetCommand") {
        return {
          Metadata: { Name: "emails-inbound" },
          Rules: [{
            Name: "inbound-other-example-com",
            Enabled: true,
            Recipients: ["other.example.com"],
            Actions: [{ S3Action: { BucketName: BUCKET, ObjectKeyPrefix: "inbound/other.example.com/" } }],
          }],
        };
      }
      return {};
    });

    const result = await runDomainCommand(["domain", "readiness", "half.example.com"]);

    const report = (result.data as { reports: Array<{ domain: string; drift: boolean; links: Array<{ link: string; status: string; remediation: string | null }> }> }).reports[0]!;
    expect(report.domain).toBe("half.example.com");
    expect(report.drift).toBe(true);
    const ses = report.links.find((link) => link.link === "ses_receipt_rule");
    expect(ses?.status).toBe("missing");
    expect(ses?.remediation).toContain("emails aws setup-inbound --domain half.example.com");
    expect(report.links.find((link) => link.link === "app_registration")?.status).toBe("ok");
    expect(result.out).toContain("MISSING");
    // Drift makes the audit exit non-zero so it can gate cron/CI directly.
    expect(process.exitCode).toBe(1);
  });

  it("with no argument audits every registered domain and reports each chain", async () => {
    process.env["EMAILS_INBOUND_S3_BUCKET"] = BUCKET;
    await stub.seed({
      domains: [
        { id: "dom-a", domain: "alpha.example.com", provider: "sandbox", verified: false },
        { id: "dom-b", domain: "beta.example.com", provider: "sandbox", verified: false },
      ],
    });

    const result = await runDomainCommand(["domain", "readiness"]);

    const reports = (result.data as { reports: Array<{ domain: string }> }).reports;
    expect(reports.map((report) => report.domain).sort()).toEqual(["alpha.example.com", "beta.example.com"]);
  });

  it("reports an unregistered domain's app link as MISSING instead of erroring", async () => {
    process.env["EMAILS_INBOUND_S3_BUCKET"] = BUCKET;

    const result = await runDomainCommand(["domain", "readiness", "ghost.example.com"]);

    const report = (result.data as { reports: Array<{ links: Array<{ link: string; status: string }> }> }).reports[0]!;
    expect(report.links.find((link) => link.link === "app_registration")?.status).toBe("missing");
  });
});
