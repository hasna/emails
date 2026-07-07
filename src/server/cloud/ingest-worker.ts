// Cloud-side SES-inbound ingestion worker for the Mailery self_hosted service.
//
// Runs as a long-lived ECS task alongside the cloud API (`mailery-serve
// ingest-worker`). It long-polls a dedicated SQS queue that is fanned out from
// the shared SES-inbound SNS topic, fetches each archived raw message from the
// SES→S3 inbound bucket, normalizes it, and writes it to the SAME cloud
// Postgres `messages` table the /v1 API serves — so NEW inbound mail lands in
// the cloud automatically, with no per-machine step.
//
// Idempotency / dedup:
//   - `source_id` = the S3 object key, so redelivery of the same SQS message is
//     an upsert (never a duplicate).
//   - Before writing, we also skip anything already present under the same key
//     in `message_id` (the local→cloud history backfill stored the object key
//     there), so the live drain never duplicates imported history.
//
// Failure handling: any fetch/parse/DB error leaves the message on the queue
// for SQS redelivery; after the queue's maxReceiveCount it lands in the DLQ
// (nothing is silently dropped, and the durable copy remains in S3).
//
// Amendment A1 (PURE REMOTE): the worker reads/writes the shared cloud Postgres
// directly via the same store the serve uses. The RDS DSN is a server-side
// secret (never distributed to clients).

import { parseSesNotification } from "../../lib/inbound-realtime.js";
import { parseInboundMime } from "../../lib/inbound-mime.js";
import { getCloudPool, normalizeCloudEnv, closeCloudPool } from "./env.js";
import { MaileryCloudStore, type MessageInput, type MessageRecord } from "./store.js";

/** Minimal store surface the worker needs (kept narrow for testability). */
export interface IngestStore {
  findMessageIdByKey(key: string): Promise<string | null>;
  upsertMessage(input: MessageInput): Promise<{ record: MessageRecord; inserted: boolean }>;
}

export interface IngestDeps {
  store: IngestStore;
  /** Fetch a raw RFC822 object from S3 as bytes. */
  fetchObject: (bucket: string, key: string) => Promise<Buffer>;
  now: () => string;
}

export type IngestStatus = "ingested" | "duplicate" | "skipped" | "error";

export interface IngestResult {
  status: IngestStatus;
  key?: string;
  id?: string;
  inserted?: boolean;
  reason?: string;
  error?: string;
}

/**
 * Process a single SQS message body (a raw SES "Received" notification, with or
 * without an SNS envelope). Pure w.r.t. its injected deps so it is unit-testable
 * without AWS or a database.
 *
 * Returns a status the caller uses to decide whether to delete the SQS message:
 * `ingested` / `duplicate` / `skipped` are terminal (delete); `error` means
 * leave it for redelivery.
 */
export async function processInboundNotification(
  deps: IngestDeps,
  body: string,
  defaultBucket: string | undefined,
): Promise<IngestResult> {
  const note = parseSesNotification(body);
  if (!note || !note.objectKey) return { status: "skipped", reason: "no_object_key" };
  const bucket = note.bucket ?? defaultBucket;
  if (!bucket) return { status: "skipped", reason: "no_bucket" };
  const key = note.objectKey;

  try {
    if (await deps.store.findMessageIdByKey(key)) return { status: "duplicate", key };

    const raw = await deps.fetchObject(bucket, key);
    const parsed = await parseInboundMime(raw);
    const to = parsed.to_addrs.length > 0 ? parsed.to_addrs : note.recipients ?? [];
    const receivedAt = parsed.received_at ?? note.timestamp ?? deps.now();

    const input: MessageInput = {
      from_addr: parsed.from_addr || "(unknown sender)",
      to_addrs: to,
      cc_addrs: parsed.cc_addrs,
      subject: parsed.subject || null,
      body_text: parsed.body_text,
      body_html: parsed.body_html,
      status: "received",
      direction: "inbound",
      message_id: key,
      in_reply_to: parsed.in_reply_to,
      received_at: receivedAt,
      is_read: false,
      headers: parsed.headers,
      attachments: parsed.attachments,
      // Idempotency key: re-delivery of the same object upserts in place.
      source_id: key,
    };

    const { record, inserted } = await deps.store.upsertMessage(input);
    return { status: "ingested", key, id: record.id, inserted };
  } catch (err) {
    return { status: "error", key, error: err instanceof Error ? err.message : String(err) };
  }
}

interface WorkerOptions {
  queueUrl?: string;
  bucket?: string;
  region?: string;
  maxMessages?: number;
  waitTimeSeconds?: number;
  visibilityTimeout?: number;
}

/**
 * Run the ingest worker loop until SIGTERM/SIGINT. Reads its wiring from the
 * environment:
 *   MAILERY_INGEST_QUEUE_URL   (required) — the SQS queue to consume
 *   MAILERY_INGEST_S3_BUCKET   (optional) — fallback bucket when a notification
 *                                           omits it (SES always includes it)
 *   AWS_REGION                 (default us-east-1)
 *   HASNA_MAILERY_DATABASE_URL (required) — cloud Postgres DSN (server-side)
 */
export async function runIngestWorker(options: WorkerOptions = {}): Promise<void> {
  normalizeCloudEnv();
  const region = options.region ?? process.env["AWS_REGION"] ?? "us-east-1";
  const queueUrl = options.queueUrl ?? process.env["MAILERY_INGEST_QUEUE_URL"];
  const defaultBucket = options.bucket ?? process.env["MAILERY_INGEST_S3_BUCKET"];
  const maxMessages = options.maxMessages ?? 10;
  const waitTimeSeconds = options.waitTimeSeconds ?? 20;
  const visibilityTimeout = options.visibilityTimeout ?? 120;

  if (!queueUrl) {
    throw new Error("ingest worker requires MAILERY_INGEST_QUEUE_URL");
  }
  if (!process.env["HASNA_MAILERY_DATABASE_URL"] && !process.env["DATABASE_URL"]) {
    throw new Error("ingest worker requires a cloud Postgres DSN (HASNA_MAILERY_DATABASE_URL)");
  }

  const { client } = getCloudPool();
  const store = new MaileryCloudStore(client);

  const [{ SQSClient, ReceiveMessageCommand, DeleteMessageCommand }, { S3Client, GetObjectCommand }] =
    await Promise.all([import("@aws-sdk/client-sqs"), import("@aws-sdk/client-s3")]);
  const sqs = new SQSClient({ region });
  const s3 = new S3Client({ region });

  const fetchObject = async (bucket: string, key: string): Promise<Buffer> => {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) throw new Error(`empty S3 object ${bucket}/${key}`);
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    return Buffer.concat(chunks);
  };

  const deps: IngestDeps = { store, fetchObject, now: () => new Date().toISOString() };

  let running = true;
  const stop = (sig: string) => {
    console.log(`[ingest] received ${sig}, finishing current batch and shutting down`);
    running = false;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const counts = { ingested: 0, duplicate: 0, skipped: 0, error: 0 };
  let lastReport = Date.now();
  console.log(
    `[ingest] starting: queue=${queueUrl.split("/").pop()} region=${region} ` +
      `bucket=${defaultBucket ?? "(from notification)"}`,
  );

  while (running) {
    let messages: Array<{ Body?: string; ReceiptHandle?: string }> = [];
    try {
      const out = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: maxMessages,
          WaitTimeSeconds: waitTimeSeconds,
          VisibilityTimeout: visibilityTimeout,
        }),
      );
      messages = out.Messages ?? [];
    } catch (err) {
      console.error(`[ingest] receive failed: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(5000);
      continue;
    }

    for (const m of messages) {
      if (!running) break;
      const result = await processInboundNotification(deps, m.Body ?? "", defaultBucket);
      counts[result.status]++;

      if (result.status === "error") {
        console.error(`[ingest] error key=${result.key ?? "-"}: ${result.error} (left for redelivery)`);
        continue; // do NOT delete — SQS redelivers, then DLQ after maxReceiveCount
      }

      if (m.ReceiptHandle) {
        try {
          await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
        } catch (err) {
          console.error(`[ingest] delete failed key=${result.key ?? "-"}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (result.status === "ingested") {
        console.log(`[ingest] stored ${result.inserted ? "new" : "updated"} key=${result.key}`);
      }
    }

    if (Date.now() - lastReport > 30_000) {
      console.log(
        `[ingest] progress ingested=${counts.ingested} duplicate=${counts.duplicate} ` +
          `skipped=${counts.skipped} error=${counts.error}`,
      );
      lastReport = Date.now();
    }
  }

  console.log(
    `[ingest] stopped. totals ingested=${counts.ingested} duplicate=${counts.duplicate} ` +
      `skipped=${counts.skipped} error=${counts.error}`,
  );
  await closeCloudPool();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
