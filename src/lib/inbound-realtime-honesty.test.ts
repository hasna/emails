/**
 * Ingest honesty for the realtime watch path (bug 8623f5b7).
 *
 * `syncS3Inbox` never throws for per-object or listing failures — it swallows
 * them into `result.errors` and returns `{ synced: 0 }`. The poller therefore
 * cannot rely on exceptions alone: a sync that REPORTS errors must leave the
 * SQS messages on the queue for redelivery/DLQ, and the poll bookkeeping must
 * record the failure instead of stamping a fresh green "last poll, no error".
 * (During the 07-28 bucket-policy freeze every GetObject failed this way and
 * the watcher consumed every notification while storing nothing.)
 */
import { describe, it, expect } from "bun:test";
import { watchInboundOnce, type SqsLike, type WatchResult } from "./inbound-realtime.js";

const sesNotification = JSON.stringify({
  notificationType: "Received",
  mail: { messageId: "abcmessageid", destination: ["ops@acme.com"] },
  receipt: {
    recipients: ["ops@acme.com"],
    action: { type: "S3", bucketName: "acme-inbound", objectKey: "inbound/acme.com/abcmessageid" },
  },
});
const snsEnvelope = JSON.stringify({ Type: "Notification", MessageId: "sns-h", TopicArn: "arn:…", Message: sesNotification });

function fakeSqs(messages: Array<{ ReceiptHandle: string; Body: string }>): { sqs: SqsLike; deleted: string[] } {
  const deleted: string[] = [];
  const sqs: SqsLike = {
    receive: async () => messages,
    deleteMessage: async (handle) => { deleted.push(handle); },
  };
  return { sqs, deleted };
}

describe("watchInboundOnce — a failed ingest must not consume the notification", () => {
  it("leaves messages on the queue when sync reports swallowed ingest errors", async () => {
    const { sqs, deleted } = fakeSqs([{ ReceiptHandle: "h-a", Body: snsEnvelope }]);
    const r = await watchInboundOnce(sqs, "q", async () => ({
      synced: 0,
      errors: ["inbound/acme.com/abcmessageid: AccessDenied"],
    }));
    // The message must stay for redelivery / DLQ redrive — nothing was stored.
    expect(deleted).toEqual([]);
    expect(r.errors).toEqual(["inbound/acme.com/abcmessageid: AccessDenied"]);
  });

  it("leaves messages when a partially productive drain reports errors", async () => {
    const { sqs, deleted } = fakeSqs([{ ReceiptHandle: "h-b", Body: snsEnvelope }]);
    let calls = 0;
    const r = await watchInboundOnce(sqs, "q", async () => {
      calls++;
      return calls === 1
        ? { synced: 2, errors: ["inbound/acme.com/poison: parse failed"] }
        : { synced: 0 };
    });
    expect(calls).toBe(2);
    expect(deleted).toEqual([]);
    expect(r.errors).toEqual(["inbound/acme.com/poison: parse failed"]);
  });

  it("still deletes after a clean drain that reports an empty errors list", async () => {
    const { sqs, deleted } = fakeSqs([{ ReceiptHandle: "h-c", Body: snsEnvelope }]);
    const r = await watchInboundOnce(sqs, "q", async () => ({ synced: 0, errors: [] }));
    expect(deleted).toEqual(["h-c"]);
    expect(r.errors).toEqual([]);
  });

  it("still deletes for a void-returning sync (back-compat)", async () => {
    const { sqs, deleted } = fakeSqs([{ ReceiptHandle: "h-d", Body: snsEnvelope }]);
    const r = await watchInboundOnce(sqs, "q", async () => { /* void */ });
    expect(deleted).toEqual(["h-d"]);
    expect(r.errors).toEqual([]);
  });
});

describe("watch poll bookkeeping — a failed poll must not stamp a green status", () => {
  // Imported dynamically: the helper is the fix. On an unfixed tree the export
  // is absent, which this first assertion turns into a named failure.
  async function loadPatchHelper(): Promise<(r: WatchResult) => Record<string, unknown>> {
    const mod = await import("./inbound-realtime.js") as Record<string, unknown>;
    const helper = mod["watchPollConfigPatch"];
    expect(typeof helper).toBe("function");
    return helper as (r: WatchResult) => Record<string, unknown>;
  }

  it("records ingest errors in inbound_realtime_last_error instead of clearing it", async () => {
    const watchPollConfigPatch = await loadPatchHelper();
    const patch = watchPollConfigPatch({
      messages: 3,
      triggered: true,
      errors: ["a.eml: AccessDenied", "b.eml: AccessDenied"],
    });
    expect(patch["inbound_realtime_last_messages"]).toBe(3);
    expect(patch["inbound_realtime_last_error"]).not.toBeNull();
    expect(String(patch["inbound_realtime_last_error"])).toContain("AccessDenied");
  });

  it("clears last_error only on a poll with zero ingest errors", async () => {
    const watchPollConfigPatch = await loadPatchHelper();
    const patch = watchPollConfigPatch({ messages: 0, triggered: false, errors: [] });
    expect(patch["inbound_realtime_last_error"]).toBeNull();
    expect(patch["inbound_realtime_last_messages"]).toBe(0);
  });
});
