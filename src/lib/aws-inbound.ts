/**
 * AWS SES inbound email setup — S3 bucket + receipt rules.
 *
 * Creates the AWS infrastructure needed to receive email:
 *   1. S3 bucket with SES PutObject policy
 *   2. SES receipt rule set (creates if none active)
 *   3. SES receipt rule: domain → S3 with prefix inbound/{domain}/
 *
 * Uses SES v1 (not SESv2) because receipt rules are only in v1.
 * Uses @aws-sdk/client-s3 for bucket creation (already a dep via s3 config).
 */

import type { S3Client } from "@aws-sdk/client-s3";
import type { SESClient } from "@aws-sdk/client-ses";

export interface InboundSetupOptions {
  domain: string;
  bucket: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  prefix?: string;
  /** If true, also catch subdomains via wildcard */
  catchAll?: boolean;
}

export interface InboundSetupResult {
  bucket: string;
  bucket_created: boolean;
  rule_set: string;
  rule_set_created: boolean;
  rule_name: string;
  rule_created: boolean;
  s3_prefix: string;
  mx_record: string;
}

type S3Sdk = typeof import("@aws-sdk/client-s3");
type SesSdk = typeof import("@aws-sdk/client-ses");
type ReceiptRuleInput = {
  Name: string;
  Enabled: boolean;
  Recipients: string[];
  Actions: Array<{ S3Action: { BucketName: string; ObjectKeyPrefix: string } }>;
  ScanEnabled: boolean;
};

let s3SdkPromise: Promise<S3Sdk> | undefined;
let sesSdkPromise: Promise<SesSdk> | undefined;

function loadS3Sdk(): Promise<S3Sdk> {
  s3SdkPromise ??= import("@aws-sdk/client-s3");
  return s3SdkPromise;
}

function loadSesSdk(): Promise<SesSdk> {
  sesSdkPromise ??= import("@aws-sdk/client-ses");
  return sesSdkPromise;
}

async function makeClients(opts: InboundSetupOptions) {
  const region = opts.region || process.env["AWS_REGION"] || "us-east-1";
  const credentials = opts.accessKeyId && opts.secretAccessKey
    ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
    : undefined;
  const [s3Sdk, sesSdk] = await Promise.all([loadS3Sdk(), loadSesSdk()]);
  const { S3Client } = s3Sdk;
  const { SESClient } = sesSdk;
  return {
    ses: new SESClient({ region, credentials }),
    s3: new S3Client({ region, credentials }),
    region,
    s3Sdk,
    sesSdk,
  };
}

/**
 * Create S3 bucket with SES delivery policy.
 * Safe to call if bucket already exists (checks first).
 */
async function ensureS3Bucket(s3: S3Client, s3Sdk: S3Sdk, bucket: string, region: string): Promise<boolean> {
  const {
    CreateBucketCommand,
    HeadBucketCommand,
    PutBucketEncryptionCommand,
    PutBucketVersioningCommand,
    PutPublicAccessBlockCommand,
  } = s3Sdk;

  // Check if already exists
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return false; // already exists
  } catch {
    // Doesn't exist — create it
  }

  await s3.send(new CreateBucketCommand({
    Bucket: bucket,
    ...(region !== "us-east-1" ? {
      CreateBucketConfiguration: { LocationConstraint: region as never },
    } : {}),
  }));

  // Block public access
  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: bucket,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  }));

  // Enable versioning
  await s3.send(new PutBucketVersioningCommand({
    Bucket: bucket,
    VersioningConfiguration: { Status: "Enabled" },
  }));

  // Enable SSE encryption
  await s3.send(new PutBucketEncryptionCommand({
    Bucket: bucket,
    ServerSideEncryptionConfiguration: {
      Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
    },
  }));

  return true; // created
}

/**
 * Build the SES inbound bucket policy.
 *
 * The grant Resource MUST cover the shared inbound base (e.g. `inbound/*`), NOT
 * the single per-domain prefix. `PutBucketPolicy` REPLACES the whole policy, so
 * a per-domain Resource means every `domain adopt` clobbers the previous
 * domain's grant — only the last-adopted domain can receive; all others bounce
 * with "recipient error" because SES can't write their objects. Granting the
 * shared base makes the policy identical for every domain → idempotent, no
 * clobbering. (Statements this module does NOT own are protected separately:
 * {@link mergeSesBucketPolicy} upserts only `AllowSESPuts` into the fetched
 * policy — this builder's output is never Put wholesale.)
 *
 * The aws:SourceAccount condition must be the REAL account id — a literal "*"
 * with StringEquals never matches, which denies SES
 * (InvalidS3ConfigurationException). When the account id is unknown, omit the
 * condition entirely (SES can still write). Pure + testable.
 */
export function buildSesBucketPolicy(bucket: string, prefix: string, accountId?: string): object {
  // Shared base = the top-level folder of the prefix (e.g. "inbound" from
  // "inbound/elyratelier.com/"); fall back to the whole bucket if there is none.
  const base = prefix.split("/")[0];
  const resource = base ? `arn:aws:s3:::${bucket}/${base}/*` : `arn:aws:s3:::${bucket}/*`;
  const statement: Record<string, unknown> = {
    Sid: "AllowSESPuts",
    Effect: "Allow",
    Principal: { Service: "ses.amazonaws.com" },
    Action: "s3:PutObject",
    Resource: resource,
  };
  if (accountId) statement["Condition"] = { StringEquals: { "aws:SourceAccount": accountId } };
  return { Version: "2012-10-17", Statement: [statement] };
}

/**
 * Thrown when a bucket's EXISTING policy cannot be parsed into statements whose
 * Sids we can read. `PutBucketPolicy` replaces the whole document, so writing
 * over a policy we could not read would silently destroy statements we never
 * saw — exactly the failure that froze prod ingestion on 2026-07-28 (incident
 * d226ac44). Fail closed: surface the document, never overwrite it.
 */
export class BucketPolicyParseError extends Error {
  constructor(
    readonly bucket: string,
    detail: string,
  ) {
    super(
      `Refusing to update the policy on bucket "${bucket}": the existing policy could not be parsed (${detail}). ` +
        `PutBucketPolicy replaces the whole document, so writing now would destroy statements we cannot see. ` +
        `Inspect and repair the bucket policy, then re-run.`,
    );
    this.name = "BucketPolicyParseError";
  }
}

/** The one statement Sid this module owns inside a shared inbound bucket policy. */
const OWNED_SES_PUTS_SID = "AllowSESPuts";

/**
 * Merge the SES grant into a bucket's existing policy document.
 *
 * `PutBucketPolicy` REPLACES the entire policy, and shared inbound buckets carry
 * statements this module does not own (e.g. cross-account read/list grants for
 * ingest workers). The 2026-07-28 outage was a wholesale Put of
 * `buildSesBucketPolicy`'s AllowSESPuts-only document wiping those grants and
 * freezing prod ingestion for 86 minutes. So: upsert ONLY the statement this
 * module owns, keyed by its exact Sid.
 *
 * Contract (pure + testable):
 * - No existing document → exactly `buildSesBucketPolicy`'s output.
 * - Foreign statements (any other Sid, or no Sid) are preserved verbatim and in
 *   their original order; foreign top-level fields (Version, Id, …) are kept.
 * - An existing `AllowSESPuts` is replaced IN PLACE; extra occurrences are
 *   dropped; absent → appended. Never duplicated. Two runs → byte-identical.
 * - A document that cannot be parsed into Sid-readable statements throws
 *   {@link BucketPolicyParseError}; callers must not write anything.
 */
export function mergeSesBucketPolicy(existingPolicyJson: string | undefined, bucket: string, prefix: string, accountId?: string): string {
  const fresh = buildSesBucketPolicy(bucket, prefix, accountId) as { Version: string; Statement: [Record<string, unknown>] };
  const owned = fresh.Statement[0];
  if (existingPolicyJson === undefined || existingPolicyJson.trim() === "") {
    return JSON.stringify(fresh);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(existingPolicyJson);
  } catch (e: unknown) {
    throw new BucketPolicyParseError(bucket, e instanceof Error ? e.message : "invalid JSON");
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new BucketPolicyParseError(bucket, "the policy document is not a JSON object");
  }
  const record = doc as Record<string, unknown>;

  // AWS's policy grammar allows Statement to be a lone statement object as well
  // as an array; normalize to an array without touching the statements themselves.
  const rawStatement = record["Statement"];
  let statements: unknown[];
  if (rawStatement === undefined || rawStatement === null) statements = [];
  else if (Array.isArray(rawStatement)) statements = rawStatement;
  else if (typeof rawStatement === "object") statements = [rawStatement];
  else throw new BucketPolicyParseError(bucket, "Statement is neither an array nor an object");
  for (const statement of statements) {
    if (typeof statement === "object" && statement !== null && !Array.isArray(statement)) continue;
    // A statement whose Sid cannot be read cannot be safely classified as
    // owned-vs-foreign — refuse rather than guess.
    throw new BucketPolicyParseError(bucket, "a policy statement is not a JSON object");
  }

  let replaced = false;
  const merged: unknown[] = [];
  for (const statement of statements) {
    const sid = (statement as Record<string, unknown>)["Sid"];
    if (sid === OWNED_SES_PUTS_SID) {
      // Replace the first owned occurrence in place (order-stable); drop any
      // later duplicates so the owned statement is never doubled.
      if (!replaced) {
        merged.push(owned);
        replaced = true;
      }
    } else {
      merged.push(statement); // foreign — preserved verbatim, original order
    }
  }
  if (!replaced) merged.push(owned);

  record["Version"] ??= fresh.Version;
  record["Statement"] = merged;
  return JSON.stringify(record);
}

/**
 * Get → merge-by-Sid → Put. Never a blind Put: the current policy is fetched
 * first (NoSuchBucketPolicy = start empty), the owned statement is upserted by
 * {@link mergeSesBucketPolicy}, and every foreign statement survives. Any other
 * failure to read the policy propagates — an unread policy must never be
 * overwritten.
 */
async function attachSesBucketPolicy(s3: S3Client, s3Sdk: S3Sdk, bucket: string, prefix: string, accountId?: string): Promise<void> {
  const { GetBucketPolicyCommand, PutBucketPolicyCommand } = s3Sdk;
  let existing: string | undefined;
  try {
    const current = await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    existing = current.Policy ?? undefined;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "NoSuchBucketPolicy") {
      existing = undefined; // no policy yet — start from empty
    } else {
      throw e;
    }
  }
  await s3.send(new PutBucketPolicyCommand({
    Bucket: bucket,
    Policy: mergeSesBucketPolicy(existing, bucket, prefix, accountId),
  }));
}

/**
 * Ensure an active SES receipt rule set exists.
 * Returns { name, created }.
 */
async function ensureReceiptRuleSet(ses: SESClient, sesSdk: SesSdk): Promise<{ name: string; created: boolean }> {
  const {
    CreateReceiptRuleSetCommand,
    DescribeActiveReceiptRuleSetCommand,
    ListReceiptRuleSetsCommand,
    SetActiveReceiptRuleSetCommand,
  } = sesSdk;

  // Check for active rule set
  try {
    const active = await ses.send(new DescribeActiveReceiptRuleSetCommand({}));
    if (active.Metadata?.Name) {
      return { name: active.Metadata.Name, created: false };
    }
  } catch { /* no active rule set */ }

  // Check existing rule sets
  const list = await ses.send(new ListReceiptRuleSetsCommand({}));
  const existing = list.RuleSets?.[0];
  if (existing?.Name) {
    await ses.send(new SetActiveReceiptRuleSetCommand({ RuleSetName: existing.Name }));
    return { name: existing.Name, created: false };
  }

  // Create new rule set
  const name = "emails-inbound";
  await ses.send(new CreateReceiptRuleSetCommand({ RuleSetName: name }));
  await ses.send(new SetActiveReceiptRuleSetCommand({ RuleSetName: name }));
  return { name, created: true };
}

function normalizeReceiptRecipients(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((recipient) => String(recipient).trim().toLowerCase()).filter(Boolean)
    : [];
}

function receiptRuleCoversDesiredInbound(rule: unknown, desired: ReceiptRuleInput): boolean {
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) return false;
  const record = rule as Record<string, unknown>;
  if (record["Enabled"] !== true) return false;

  const recipients = normalizeReceiptRecipients(record["Recipients"]);
  const desiredRecipients = desired.Recipients.map((recipient) => recipient.trim().toLowerCase());
  const coversRecipients = recipients.length === 0 || desiredRecipients.every((recipient) => recipients.includes(recipient));
  if (!coversRecipients) return false;

  const desiredAction = desired.Actions[0]!.S3Action;
  const actions = Array.isArray(record["Actions"]) ? record["Actions"] : [];
  return actions.some((action) => {
    const s3 = typeof action === "object" && action !== null && !Array.isArray(action)
      ? (action as { S3Action?: { BucketName?: unknown; ObjectKeyPrefix?: unknown } }).S3Action
      : undefined;
    return s3?.BucketName === desiredAction.BucketName
      && (s3.ObjectKeyPrefix ?? "") === desiredAction.ObjectKeyPrefix;
  });
}

/**
 * Full setup: S3 bucket + SES receipt rule for the domain.
 */
export async function setupInboundEmail(opts: InboundSetupOptions): Promise<InboundSetupResult> {
  const { ses, s3, region, s3Sdk, sesSdk } = await makeClients(opts);
  const prefix = opts.prefix ?? `inbound/${opts.domain}/`;

  // Resolve the account id so the SES bucket policy condition is correct.
  let accountId = process.env["AWS_ACCOUNT_ID"];
  if (!accountId) {
    try {
      const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
      const credentials = opts.accessKeyId && opts.secretAccessKey
        ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
        : undefined;
      const sts = new STSClient({ region, credentials });
      const id = await sts.send(new GetCallerIdentityCommand({}));
      accountId = id.Account;
    } catch {
      // leave undefined — policy will omit the condition
    }
  }

  // 1. S3 bucket
  const bucketCreated = await ensureS3Bucket(s3, s3Sdk, opts.bucket, region);
  await attachSesBucketPolicy(s3, s3Sdk, opts.bucket, prefix, accountId);

  // 2. Receipt rule set
  const ruleSet = await ensureReceiptRuleSet(ses, sesSdk);

  // 3. Receipt rule: domain → S3
  const { CreateReceiptRuleCommand, DescribeReceiptRuleCommand, UpdateReceiptRuleCommand } = sesSdk;
  const ruleName = `inbound-${opts.domain.replace(/\./g, "-")}`;
  const desiredRule: ReceiptRuleInput = {
    Name: ruleName,
    Enabled: true,
    Recipients: opts.catchAll
      ? [opts.domain, `.${opts.domain}`]
      : [opts.domain],
    Actions: [
      {
        S3Action: {
          BucketName: opts.bucket,
          ObjectKeyPrefix: prefix,
        },
      },
    ],
    ScanEnabled: true,
  };
  let ruleCreated = false;
  try {
    await ses.send(new CreateReceiptRuleCommand({
      RuleSetName: ruleSet.name,
      Rule: desiredRule,
    }));
    ruleCreated = true;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AlreadyExistsException") {
      const existing = await ses.send(new DescribeReceiptRuleCommand({
        RuleSetName: ruleSet.name,
        RuleName: ruleName,
      }));
      if (!receiptRuleCoversDesiredInbound(existing.Rule, desiredRule)) {
        await ses.send(new UpdateReceiptRuleCommand({
          RuleSetName: ruleSet.name,
          Rule: desiredRule,
        }));
      }
      ruleCreated = false;
    } else {
      throw e;
    }
  }

  return {
    bucket: opts.bucket,
    bucket_created: bucketCreated,
    rule_set: ruleSet.name,
    rule_set_created: ruleSet.created,
    rule_name: ruleName,
    rule_created: ruleCreated,
    s3_prefix: prefix,
    // MX record needed to route incoming email to SES
    mx_record: `10 inbound-smtp.${region}.amazonaws.com`,
  };
}
