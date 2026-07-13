/**
 * AWS S3 → SQS inbound-ingest wiring for the self-hosted ingest worker.
 *
 * `setupInboundEmail()` (aws-inbound.ts) provisions SES → S3: raw mail lands in
 * the inbound bucket under `inbound/{domain}/`. This module provisions the
 * MISSING hop that makes ingestion automatic end-to-end: an S3 ObjectCreated
 * event notification on the SHARED `inbound/` prefix → a single SQS queue that
 * the ingest worker (server/self-hosted/ingest-worker.ts) long-polls.
 *
 * Why bucket-wide (not per-domain): `parseSesNotification()` already understands
 * raw S3 ObjectCreated events, so ONE notification on `inbound/` covers every
 * domain — present and future. Adopting a new domain then needs only its SES
 * receipt rule (already automated); its mail flows with no extra realtime step.
 *
 * Idempotent + non-destructive: safe to re-run on every `domain adopt`. Creates
 * the queue (+ DLQ) if missing, grants S3→SQS SendMessage scoped to the bucket,
 * and installs exactly one notification for the shared prefix — PRESERVING
 * unrelated notifications and reconciling narrower overlapping ones (S3 rejects
 * a config whose prefix overlaps another for the same event type).
 *
 * SAFETY: no credentials are logged; the queue policy is scoped to the bucket
 * ARN (+ account) so only this bucket can enqueue.
 */

export const INGEST_NOTIFICATION_ID = "emails-inbound-ingest";
export const DEFAULT_INBOUND_PREFIX = "inbound/";
const OBJECT_CREATED_EVENT = "s3:ObjectCreated:*";

// ── pure helpers (SDK-free, unit-tested) ─────────────────────────────────────

/** True when two S3 key prefixes overlap (one contains the other). S3 forbids
 *  two notification configs with overlapping prefixes for the same event. */
export function prefixesOverlap(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/** SQS access policy statement allowing the S3 service to enqueue for a specific
 *  bucket. Scoped by aws:SourceArn (bucket) and, when known, aws:SourceAccount. */
export function buildIngestQueueStatement(queueArn: string, bucketArn: string, accountId?: string): Record<string, unknown> {
  const condition: Record<string, unknown> = { ArnLike: { "aws:SourceArn": bucketArn } };
  if (accountId) condition["StringEquals"] = { "aws:SourceAccount": accountId };
  return {
    Sid: "AllowS3InboundNotify",
    Effect: "Allow",
    Principal: { Service: "s3.amazonaws.com" },
    Action: "sqs:SendMessage",
    Resource: queueArn,
    Condition: condition,
  };
}

/** Merge our statement into an existing queue policy by Sid (replacing any prior
 *  copy), preserving every other statement (e.g. an SNS subscription grant). */
export function mergeQueuePolicy(existingPolicyJson: string | undefined, statement: Record<string, unknown>): object {
  let statements: Array<Record<string, unknown>> = [];
  if (existingPolicyJson) {
    try {
      const parsed = JSON.parse(existingPolicyJson) as { Statement?: unknown };
      if (Array.isArray(parsed.Statement)) statements = parsed.Statement as Array<Record<string, unknown>>;
    } catch {
      // Malformed policy → start clean rather than propagate corruption.
    }
  }
  const sid = statement["Sid"];
  const kept = statements.filter((s) => s && s["Sid"] !== sid);
  return { Version: "2012-10-17", Statement: [...kept, statement] };
}

interface FilterRule { Name?: string; Value?: string }
interface QueueConfig { Id?: string; QueueArn?: string; Events?: string[]; Filter?: { Key?: { FilterRules?: FilterRule[] } } }
interface NotificationConfig {
  QueueConfigurations?: QueueConfig[];
  TopicConfigurations?: unknown[];
  LambdaFunctionConfigurations?: unknown[];
  EventBridgeConfiguration?: unknown;
}

function prefixOfConfig(cfg: QueueConfig): string {
  const rules = cfg.Filter?.Key?.FilterRules ?? [];
  const rule = rules.find((r) => (r.Name ?? "").toLowerCase() === "prefix");
  return rule?.Value ?? ""; // no prefix filter ⇒ matches whole bucket ⇒ "" overlaps everything
}

function hasObjectCreated(cfg: QueueConfig): boolean {
  return (cfg.Events ?? []).some((e) => e === OBJECT_CREATED_EVENT || e.startsWith("s3:ObjectCreated"));
}

/**
 * Build the notification configuration to PUT: our single QueueConfiguration for
 * `prefix` → `queueArn`, plus every EXISTING config that neither shares our Id
 * nor conflicts with us. A conflict is another QueueConfiguration whose
 * ObjectCreated prefix overlaps ours (S3 would reject the PUT, and it is
 * subsumed by our bucket-wide config anyway). Topic/Lambda/EventBridge configs
 * are preserved untouched.
 */
export function mergeBucketNotification(existing: NotificationConfig | undefined, prefix: string, queueArn: string): { config: NotificationConfig; removedIds: string[] } {
  const removedIds: string[] = [];
  const priorQueues = existing?.QueueConfigurations ?? [];
  const keptQueues = priorQueues.filter((cfg) => {
    if (cfg.Id === INGEST_NOTIFICATION_ID) { if (cfg.Id) removedIds.push(cfg.Id); return false; }
    if (hasObjectCreated(cfg) && prefixesOverlap(prefixOfConfig(cfg), prefix)) {
      if (cfg.Id) removedIds.push(cfg.Id);
      return false;
    }
    return true;
  });
  const ours: QueueConfig = {
    Id: INGEST_NOTIFICATION_ID,
    QueueArn: queueArn,
    Events: [OBJECT_CREATED_EVENT],
    Filter: { Key: { FilterRules: [{ Name: "prefix", Value: prefix }] } },
  };
  const config: NotificationConfig = { QueueConfigurations: [...keptQueues, ours] };
  if (existing?.TopicConfigurations?.length) config.TopicConfigurations = existing.TopicConfigurations;
  if (existing?.LambdaFunctionConfigurations?.length) config.LambdaFunctionConfigurations = existing.LambdaFunctionConfigurations;
  if (existing?.EventBridgeConfiguration) config.EventBridgeConfiguration = existing.EventBridgeConfiguration;
  return { config, removedIds };
}

// ── orchestrator (impure; lazy SDK import like aws-inbound.ts) ────────────────

export interface IngestPipelineOptions {
  bucket: string;
  /** SQS queue the ingest worker consumes. Created if missing. */
  queueName: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  accountId?: string;
  /** Shared inbound prefix to notify on (default `inbound/`). */
  prefix?: string;
  /** Also create a dead-letter queue + redrive (default true). */
  dlq?: boolean;
}

export interface IngestPipelineResult {
  queue_name: string;
  queue_url: string;
  queue_arn: string;
  queue_created: boolean;
  dlq_arn: string | null;
  prefix: string;
  notification_id: string;
  notification_installed: boolean;
  removed_overlapping_notifications: string[];
}

type SqsSdk = typeof import("@aws-sdk/client-sqs");
type S3Sdk = typeof import("@aws-sdk/client-s3");

function creds(opts: IngestPipelineOptions) {
  return opts.accessKeyId && opts.secretAccessKey
    ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
    : undefined;
}

async function ensureQueue(
  sqs: InstanceType<SqsSdk["SQSClient"]>,
  sdk: SqsSdk,
  name: string,
  redrivePolicy?: string,
): Promise<{ url: string; arn: string; created: boolean }> {
  const { CreateQueueCommand, GetQueueUrlCommand, GetQueueAttributesCommand } = sdk;
  let url: string | undefined;
  let created = false;
  try {
    const got = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    url = got.QueueUrl;
  } catch {
    // Not found → create.
  }
  if (!url) {
    const attributes: Record<string, string> = {};
    if (redrivePolicy) attributes["RedrivePolicy"] = redrivePolicy;
    const res = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: Object.keys(attributes).length ? attributes : undefined }));
    url = res.QueueUrl!;
    created = true;
  }
  const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url!, AttributeNames: ["QueueArn"] }));
  return { url: url!, arn: attrs.Attributes?.["QueueArn"] ?? "", created };
}

/**
 * Ensure the S3→SQS ingest pipeline for the shared inbound prefix. Idempotent.
 */
export async function ensureInboundIngestPipeline(opts: IngestPipelineOptions): Promise<IngestPipelineResult> {
  const region = opts.region || process.env["AWS_REGION"] || "us-east-1";
  const prefix = opts.prefix ?? DEFAULT_INBOUND_PREFIX;
  const credentials = creds(opts);
  const [sqsSdk, s3Sdk] = await Promise.all([
    import("@aws-sdk/client-sqs") as Promise<SqsSdk>,
    import("@aws-sdk/client-s3") as Promise<S3Sdk>,
  ]);
  const sqs = new sqsSdk.SQSClient({ region, credentials });
  const s3 = new s3Sdk.S3Client({ region, credentials });

  // 1. Dead-letter queue (optional) + main queue.
  let dlqArn: string | null = null;
  let redrivePolicy: string | undefined;
  if (opts.dlq !== false) {
    const dlq = await ensureQueue(sqs, sqsSdk, `${opts.queueName}-dlq`);
    dlqArn = dlq.arn;
    redrivePolicy = JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: 5 });
  }
  const queue = await ensureQueue(sqs, sqsSdk, opts.queueName, redrivePolicy);

  // 2. Grant S3 → SQS SendMessage scoped to the bucket (merge, preserve others).
  const bucketArn = `arn:aws:s3:::${opts.bucket}`;
  const { GetQueueAttributesCommand, SetQueueAttributesCommand } = sqsSdk;
  const existingPolicy = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queue.url, AttributeNames: ["Policy"] }))).Attributes?.["Policy"];
  const statement = buildIngestQueueStatement(queue.arn, bucketArn, opts.accountId);
  await sqs.send(new SetQueueAttributesCommand({ QueueUrl: queue.url, Attributes: { Policy: JSON.stringify(mergeQueuePolicy(existingPolicy, statement)) } }));

  // 3. S3 bucket notification: merge our ObjectCreated config for the shared prefix.
  const { GetBucketNotificationConfigurationCommand, PutBucketNotificationConfigurationCommand } = s3Sdk;
  const current = await s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: opts.bucket }));
  const { config, removedIds } = mergeBucketNotification(current as NotificationConfig, prefix, queue.arn);
  await s3.send(new PutBucketNotificationConfigurationCommand({
    Bucket: opts.bucket,
    NotificationConfiguration: config as never,
    // Skip the test-notification round-trip: the queue policy above must exist
    // first, and SkipDestinationValidation avoids a race on freshly-set policy.
    SkipDestinationValidation: true,
  }));

  return {
    queue_name: opts.queueName,
    queue_url: queue.url,
    queue_arn: queue.arn,
    queue_created: queue.created,
    dlq_arn: dlqArn,
    prefix,
    notification_id: INGEST_NOTIFICATION_ID,
    notification_installed: true,
    removed_overlapping_notifications: removedIds,
  };
}
