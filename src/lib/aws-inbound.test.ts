import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setS3SendHandler, resetS3SendHandler } from "../test-support/aws-s3-mock.js";

// ─── Mock AWS SDKs ────────────────────────────────────────────────────────────
// SES is mocked inline (this file is the last-loaded of the SES mockers only where
// it matters and its shape is compatible). The S3 mock is SHARED
// (src/test-support/aws-s3-mock.ts) because a sibling file also drives
// "@aws-sdk/client-s3" through a dynamic import and bun's process-global module mock
// caches the first-resolved namespace — see that module's header. We route the
// shared S3 `send` through this file's `mockS3Send` spy (below) so setupMocks() and
// call assertions keep working.

const mockSesSend = mock(async (_cmd: unknown) => ({}));
const mockS3Send = mock(async (_cmd: unknown) => ({}));

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

const { setupInboundEmail, buildSesBucketPolicy, mergeSesBucketPolicy, BucketPolicyParseError } = await import("./aws-inbound.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSesSend.mockReset();
  mockS3Send.mockReset();
  // The shared S3 mock delegates to this file's spy so constructor.name dispatch
  // (setupMocks) and any call assertions observe the commands the source sends.
  setS3SendHandler((cmd) => mockS3Send(cmd));
});

afterEach(() => resetS3SendHandler());

function setupMocks(bucketExists = false) {
  mockS3Send.mockImplementation(async (cmd: unknown) => {
    const name = (cmd as { constructor?: { name?: string } })?.constructor?.name ?? "";
    // HeadBucket — throw to indicate bucket doesn't exist (triggers creation path)
    if (!bucketExists && name === "HeadBucketCommand") {
      throw Object.assign(new Error("NoSuchBucket"), { name: "NoSuchBucket" });
    }
    return {};
  });

  let sesCallCount = 0;
  mockSesSend.mockImplementation(async () => {
    sesCallCount++;
    // First call = DescribeActiveReceiptRuleSet — throw to indicate no active set
    if (sesCallCount === 1) throw new Error("NoActiveRuleSet");
    // Second call = ListReceiptRuleSets — return empty
    if (sesCallCount === 2) return { RuleSets: [] };
    // Remaining calls = CreateReceiptRuleSet, SetActive, CreateRule — succeed
    return {};
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildSesBucketPolicy — must not clobber other domains' grants", () => {
  type Pol = { Statement: { Resource: string; Condition?: unknown }[] };

  it("keeps AWS clients behind setup-only dynamic imports", () => {
    const source = readFileSync(join(import.meta.dir, "aws-inbound.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s+(?!type\b)[\s\S]*?from\s+["']@aws-sdk\/client-(?:s3|ses)["'];/m);
    expect(source).toContain('import("@aws-sdk/client-s3")');
    expect(source).toContain('import("@aws-sdk/client-ses")');
  });

  it("grants the shared inbound base, not a single per-domain prefix", () => {
    const pol = buildSesBucketPolicy("buck", "inbound/elyratelier.com/", "111122223333") as Pol;
    // Must cover ALL inbound objects so a later adopt of another domain still works.
    expect(pol.Statement[0]!.Resource).toBe("arn:aws:s3:::buck/inbound/*");
  });

  it("produces an IDENTICAL policy for different domains (idempotent — no clobber)", () => {
    const a = JSON.stringify(buildSesBucketPolicy("buck", "inbound/elyratelier.com/", "111122223333"));
    const b = JSON.stringify(buildSesBucketPolicy("buck", "inbound/droolbowl.com/", "111122223333"));
    // Re-adopting droolbowl must not change the grant that lets elyratelier receive.
    expect(a).toBe(b);
  });

  it("falls back to the whole bucket when prefix has no folder", () => {
    const pol = buildSesBucketPolicy("buck", "", "111122223333") as Pol;
    expect(pol.Statement[0]!.Resource).toBe("arn:aws:s3:::buck/*");
  });

  it("keeps the SourceAccount condition when an account id is given (and omits it otherwise)", () => {
    expect((buildSesBucketPolicy("buck", "inbound/x.com/", "111122223333") as Pol).Statement[0]!.Condition)
      .toEqual({ StringEquals: { "aws:SourceAccount": "111122223333" } });
    expect((buildSesBucketPolicy("buck", "inbound/x.com/") as Pol).Statement[0]!.Condition).toBeUndefined();
  });
});

describe("setupInboundEmail", () => {
  it("creates bucket and receipt rule when neither exists", async () => {
    setupMocks(false);

    const result = await setupInboundEmail({
      domain: "example.com",
      bucket: "my-emails",
      region: "us-east-1",
    });

    expect(result.bucket).toBe("my-emails");
    expect(typeof result.rule_set).toBe("string");
    expect(typeof result.rule_name).toBe("string");
    expect(result.s3_prefix).toContain("inbound/example.com");
    expect(result.mx_record).toContain("inbound-smtp");
    expect(result.mx_record).toContain("us-east-1");
  });

  it("returns correct mx_record format", async () => {
    setupMocks(false);

    const result = await setupInboundEmail({
      domain: "test.com",
      bucket: "test-bucket",
      region: "eu-west-1",
    });

    expect(result.mx_record).toBe("10 inbound-smtp.eu-west-1.amazonaws.com");
  });

  it("uses default prefix inbound/<domain>/", async () => {
    setupMocks(false);

    const result = await setupInboundEmail({
      domain: "example.com",
      bucket: "example-emails",
    });

    expect(result.s3_prefix).toBe("inbound/example.com/");
  });

  it("respects custom prefix", async () => {
    setupMocks(false);

    const result = await setupInboundEmail({
      domain: "example.com",
      bucket: "example-emails",
      prefix: "custom/prefix/",
    });

    expect(result.s3_prefix).toBe("custom/prefix/");
  });

  it("marks bucket_created=false when bucket exists", async () => {
    // HeadBucket succeeds (bucket exists)
    mockS3Send.mockImplementation(async () => ({}));
    mockSesSend.mockImplementation(async (cmd: unknown) => {
      const c = cmd as { constructor: { name: string } };
      if (c?.constructor?.name === "DescribeActiveReceiptRuleSetCommand") throw new Error("no active");
      if (c?.constructor?.name === "ListReceiptRuleSetsCommand") return { RuleSets: [] };
      return {};
    });

    const result = await setupInboundEmail({ domain: "x.com", bucket: "existing-bucket" });
    expect(result.bucket_created).toBe(false);
  });

  it("converges an existing receipt rule with the owned name instead of accepting stale wiring", async () => {
    const updates: unknown[] = [];
    mockS3Send.mockImplementation(async () => ({}));
    mockSesSend.mockImplementation(async (cmd: unknown) => {
      const c = cmd as { constructor?: { name?: string }; input?: unknown };
      const name = c?.constructor?.name ?? "";
      if (name === "DescribeActiveReceiptRuleSetCommand") return { Metadata: { Name: "emails-inbound" } };
      if (name === "CreateReceiptRuleCommand") throw Object.assign(new Error("already exists"), { name: "AlreadyExistsException" });
      if (name === "DescribeReceiptRuleCommand") {
        return {
          Rule: {
            Name: "inbound-example-com",
            Enabled: false,
            Recipients: ["example.com"],
            Actions: [{ S3Action: { BucketName: "old-bucket", ObjectKeyPrefix: "inbound/example.com/" } }],
          },
        };
      }
      if (name === "UpdateReceiptRuleCommand") {
        updates.push(c.input);
        return {};
      }
      return {};
    });

    const result = await setupInboundEmail({
      domain: "example.com",
      bucket: "my-emails",
      region: "us-east-1",
    });

    expect(result.rule_created).toBe(false);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      RuleSetName: "emails-inbound",
      Rule: {
        Name: "inbound-example-com",
        Enabled: true,
        Actions: [{ S3Action: { BucketName: "my-emails", ObjectKeyPrefix: "inbound/example.com/" } }],
      },
    });
  });
});

// ─── Bucket-policy merge — regression for the 2026-07-28 prod ingestion freeze ──
//
// PutBucketPolicy REPLACES the whole bucket policy. On 2026-07-28T17:15:39Z a CLI
// inbound-provisioning run PUT buildSesBucketPolicy's output (AllowSESPuts only)
// over the prod inbound bucket's policy, wiping the cross-account read/list grants
// the ingest worker role depends on and freezing ingestion for 86 minutes
// (incident d226ac44, bug 48d80ad6). The contract under test: attachSesBucketPolicy
// must GET the current policy, upsert ONLY the statement it owns (Sid AllowSESPuts),
// preserve every foreign statement verbatim and in order, and fail closed on a
// policy it cannot parse.

describe("setupInboundEmail bucket-policy merge — must not clobber foreign statements", () => {
  // Realistic foreign statements mirroring the outage: cross-account read/list for
  // the prod ingest worker role. These are NOT owned by aws-inbound.ts and must
  // survive any provisioning run byte-for-byte.
  const FOREIGN_READ = {
    Sid: "AllowCrossAccountInboundRead",
    Effect: "Allow",
    Principal: { AWS: "arn:aws:iam::123456789012:role/ingest-worker-task" },
    Action: "s3:GetObject",
    Resource: "arn:aws:s3:::emails-inbound-111122223333/inbound/*",
  };
  const FOREIGN_LIST = {
    Sid: "AllowCrossAccountInboundList",
    Effect: "Allow",
    Principal: { AWS: "arn:aws:iam::123456789012:role/ingest-worker-task" },
    Action: "s3:ListBucket",
    Resource: "arn:aws:s3:::emails-inbound-111122223333",
  };
  const BUCKET = "emails-inbound-111122223333";
  const ACCOUNT = "111122223333";

  let savedAccountId: string | undefined;

  beforeEach(() => {
    // Pin the account id so setupInboundEmail never reaches for STS.
    savedAccountId = process.env["AWS_ACCOUNT_ID"];
    process.env["AWS_ACCOUNT_ID"] = ACCOUNT;
    // SES side: everything succeeds (rule set + rule get created).
    mockSesSend.mockImplementation(async () => ({}));
  });

  afterEach(() => {
    if (savedAccountId === undefined) delete process.env["AWS_ACCOUNT_ID"];
    else process.env["AWS_ACCOUNT_ID"] = savedAccountId;
  });

  /**
   * Stateful S3 mock: GetBucketPolicy serves the current policy (NoSuchBucketPolicy
   * when absent), PutBucketPolicy stores it. Records every PUT and the S3 command
   * order so tests can assert get-before-put and fail-closed (no PUT at all).
   */
  function statefulPolicyBucket(initialPolicy: string | undefined) {
    const state = { policy: initialPolicy, puts: [] as string[], commands: [] as string[] };
    mockS3Send.mockImplementation(async (cmd: unknown) => {
      const name = (cmd as { constructor?: { name?: string } })?.constructor?.name ?? "";
      state.commands.push(name);
      if (name === "GetBucketPolicyCommand") {
        if (state.policy === undefined) {
          throw Object.assign(new Error("The bucket policy does not exist"), { name: "NoSuchBucketPolicy" });
        }
        return { Policy: state.policy };
      }
      if (name === "PutBucketPolicyCommand") {
        const policy = (cmd as { input: { Policy: string } }).input.Policy;
        state.policy = policy;
        state.puts.push(policy);
        return {};
      }
      return {}; // HeadBucket succeeds — bucket exists; other setup calls succeed
    });
    return state;
  }

  type PolicyDoc = { Version?: string; Statement: Record<string, unknown>[] };
  const statements = (json: string): Record<string, unknown>[] => (JSON.parse(json) as PolicyDoc).Statement;
  const sidsOf = (json: string): (string | undefined)[] => statements(json).map((s) => s["Sid"] as string | undefined);

  it("REGRESSION (2026-07-28 outage): preserves foreign cross-account statements verbatim and in order", async () => {
    const bucket = statefulPolicyBucket(JSON.stringify({
      Version: "2012-10-17",
      Statement: [FOREIGN_READ, FOREIGN_LIST],
    }));

    await setupInboundEmail({ domain: "airapproach.com", bucket: BUCKET });

    expect(bucket.puts.length).toBe(1);
    const merged = statements(bucket.puts[0]!);
    const read = merged.find((s) => s["Sid"] === "AllowCrossAccountInboundRead");
    const list = merged.find((s) => s["Sid"] === "AllowCrossAccountInboundList");
    // Byte-for-byte at statement level: the worker role's grants are untouched.
    expect(JSON.stringify(read)).toBe(JSON.stringify(FOREIGN_READ));
    expect(JSON.stringify(list)).toBe(JSON.stringify(FOREIGN_LIST));
    // Order-stability: foreign statements keep their relative order.
    const sids = sidsOf(bucket.puts[0]!);
    expect(sids.indexOf("AllowCrossAccountInboundRead")).toBeLessThan(sids.indexOf("AllowCrossAccountInboundList"));
    // The owned statement is upserted exactly once.
    expect(sids.filter((s) => s === "AllowSESPuts").length).toBe(1);
  });

  it("starts from an empty policy on NoSuchBucketPolicy — and fetches before writing", async () => {
    const bucket = statefulPolicyBucket(undefined);

    await setupInboundEmail({ domain: "airapproach.com", bucket: BUCKET });

    expect(bucket.puts.length).toBe(1);
    expect(bucket.puts[0]).toBe(
      JSON.stringify(buildSesBucketPolicy(BUCKET, "inbound/airapproach.com/", ACCOUNT)),
    );
    // Get→merge→Put: the current policy must be read before any replacement.
    const getIdx = bucket.commands.indexOf("GetBucketPolicyCommand");
    const putIdx = bucket.commands.indexOf("PutBucketPolicyCommand");
    expect(getIdx).toBeGreaterThanOrEqual(0); // a blind Put never fetched at all
    expect(putIdx).toBeGreaterThan(getIdx);
  });

  it("replaces an older AllowSESPuts in place — never duplicated, foreign neighbors intact", async () => {
    const staleSesPuts = {
      Sid: "AllowSESPuts",
      Effect: "Allow",
      Principal: { Service: "ses.amazonaws.com" },
      Action: "s3:PutObject",
      // Old per-domain grant from a pre-1.3 provisioning run — must be replaced.
      Resource: `arn:aws:s3:::${BUCKET}/inbound/elyratelier.com/*`,
    };
    const bucket = statefulPolicyBucket(JSON.stringify({
      Version: "2012-10-17",
      Statement: [staleSesPuts, FOREIGN_READ],
    }));

    await setupInboundEmail({ domain: "airapproach.com", bucket: BUCKET });

    const sids = sidsOf(bucket.puts[0]!);
    expect(sids).toEqual(["AllowSESPuts", "AllowCrossAccountInboundRead"]); // in place, no reorder
    const sesPuts = statements(bucket.puts[0]!).find((s) => s["Sid"] === "AllowSESPuts")!;
    expect(sesPuts["Resource"]).toBe(`arn:aws:s3:::${BUCKET}/inbound/*`);
    expect(sesPuts["Condition"]).toEqual({ StringEquals: { "aws:SourceAccount": ACCOUNT } });
    expect(JSON.stringify(statements(bucket.puts[0]!).find((s) => s["Sid"] === "AllowCrossAccountInboundRead")))
      .toBe(JSON.stringify(FOREIGN_READ));
  });

  it("fails closed on an unparseable existing policy — typed error, nothing written", async () => {
    const bucket = statefulPolicyBucket("{ this is not json");

    await expect(setupInboundEmail({ domain: "airapproach.com", bucket: BUCKET }))
      .rejects.toMatchObject({ name: "BucketPolicyParseError" });
    expect(bucket.puts.length).toBe(0);
  });

  it("fails closed on a parseable policy with an unusable Statement shape — nothing written", async () => {
    const bucket = statefulPolicyBucket(JSON.stringify({ Version: "2012-10-17", Statement: "not-a-statement-list" }));

    await expect(setupInboundEmail({ domain: "airapproach.com", bucket: BUCKET }))
      .rejects.toMatchObject({ name: "BucketPolicyParseError" });
    expect(bucket.puts.length).toBe(0);
  });

  it("is idempotent: a second provisioning run produces a byte-identical policy", async () => {
    const bucket = statefulPolicyBucket(JSON.stringify({
      Version: "2012-10-17",
      Statement: [FOREIGN_READ, FOREIGN_LIST],
    }));

    await setupInboundEmail({ domain: "airapproach.com", bucket: BUCKET });
    await setupInboundEmail({ domain: "airapproach.com", bucket: BUCKET });

    expect(bucket.puts.length).toBe(2);
    expect(bucket.puts[1]).toBe(bucket.puts[0]);
    // And the foreign grants are still there after both runs.
    const sids = sidsOf(bucket.puts[1]!);
    expect(sids).toContain("AllowCrossAccountInboundRead");
    expect(sids).toContain("AllowCrossAccountInboundList");
  });
});

describe("mergeSesBucketPolicy — pure merge semantics", () => {
  const ACCOUNT = "111122223333";

  it("preserves unknown top-level policy fields and the existing Version", () => {
    const existing = JSON.stringify({
      Version: "2008-10-17",
      Id: "hand-written-policy",
      Statement: [{ Sid: "Foreign", Effect: "Deny", Principal: "*", Action: "s3:*", Resource: "arn:aws:s3:::b/*" }],
    });
    const merged = JSON.parse(mergeSesBucketPolicy(existing, "b", "inbound/x.com/", ACCOUNT)) as Record<string, unknown>;
    expect(merged["Version"]).toBe("2008-10-17");
    expect(merged["Id"]).toBe("hand-written-policy");
    const stmts = merged["Statement"] as Record<string, unknown>[];
    expect(stmts.map((s) => s["Sid"])).toEqual(["Foreign", "AllowSESPuts"]);
  });

  it("preserves statements that have no Sid at all", () => {
    const anonymous = { Effect: "Allow", Principal: { AWS: "arn:aws:iam::111122223333:root" }, Action: "s3:GetObject", Resource: "arn:aws:s3:::b/inbound/*" };
    const merged = mergeSesBucketPolicy(
      JSON.stringify({ Version: "2012-10-17", Statement: [anonymous] }),
      "b", "inbound/x.com/", ACCOUNT,
    );
    const stmts = (JSON.parse(merged) as { Statement: Record<string, unknown>[] }).Statement;
    expect(JSON.stringify(stmts[0])).toBe(JSON.stringify(anonymous));
    expect(stmts[1]!["Sid"]).toBe("AllowSESPuts");
  });

  it("accepts the single-object Statement form AWS's policy grammar allows", () => {
    const lone = { Sid: "Foreign", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::b/inbound/*" };
    const merged = mergeSesBucketPolicy(
      JSON.stringify({ Version: "2012-10-17", Statement: lone }),
      "b", "inbound/x.com/", ACCOUNT,
    );
    const stmts = (JSON.parse(merged) as { Statement: Record<string, unknown>[] }).Statement;
    expect(stmts.map((s) => s["Sid"])).toEqual(["Foreign", "AllowSESPuts"]);
  });

  it("collapses duplicate AllowSESPuts occurrences to exactly one, in the first slot", () => {
    const staleA = { Sid: "AllowSESPuts", Effect: "Allow", Principal: { Service: "ses.amazonaws.com" }, Action: "s3:PutObject", Resource: "arn:aws:s3:::b/inbound/old-a.com/*" };
    const staleB = { Sid: "AllowSESPuts", Effect: "Allow", Principal: { Service: "ses.amazonaws.com" }, Action: "s3:PutObject", Resource: "arn:aws:s3:::b/inbound/old-b.com/*" };
    const foreign = { Sid: "Foreign", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::b/inbound/*" };
    const merged = mergeSesBucketPolicy(
      JSON.stringify({ Version: "2012-10-17", Statement: [staleA, foreign, staleB] }),
      "b", "inbound/x.com/", ACCOUNT,
    );
    const stmts = (JSON.parse(merged) as { Statement: Record<string, unknown>[] }).Statement;
    // First occurrence replaced in place, second dropped, foreign untouched between.
    expect(stmts.map((s) => s["Sid"])).toEqual(["AllowSESPuts", "Foreign"]);
    expect(stmts[0]!["Resource"]).toBe("arn:aws:s3:::b/inbound/*");
  });

  it("builds a fresh policy when there is no existing document", () => {
    expect(mergeSesBucketPolicy(undefined, "b", "inbound/x.com/", ACCOUNT))
      .toBe(JSON.stringify(buildSesBucketPolicy("b", "inbound/x.com/", ACCOUNT)));
  });

  it("throws the typed parse error on garbage — callers must never write over it", () => {
    // Not `.toThrow(SomeClass)`: that passes vacuously when the class binding is
    // undefined. Catch and check the instance + name explicitly.
    const expectParseError = (existing: string) => {
      let caught: unknown;
      try {
        mergeSesBucketPolicy(existing, "b", "inbound/x.com/", ACCOUNT);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BucketPolicyParseError);
      expect((caught as Error).name).toBe("BucketPolicyParseError");
    };
    expectParseError("not json at all");
    expectParseError(JSON.stringify(["an", "array"]));
    expectParseError(JSON.stringify({ Statement: [42] }));
  });
});
