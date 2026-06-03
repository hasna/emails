/**
 * Background auto-pull for the TUI — the "daemon" half. On each tick it drains
 * any real-time inbound (SES→SNS→SQS) and/or does a dedup-safe S3 sync, plus a
 * best-effort Gmail incremental sync, so new mail appears in the inbox without
 * the user running a manual sync. Entirely best-effort: missing config or creds
 * is silently a no-op.
 */
export interface PullResult { pulled: number; ok: boolean; reason?: string; configured: boolean }

export async function autoPull(): Promise<PullResult> {
  const { getInboundConfig, loadConfig } = await import("../../lib/config.js");
  const inbound = getInboundConfig();
  const config = loadConfig();
  const queueUrl = config["inbound_realtime_queue_url"] as string | undefined;
  const configured = Boolean(inbound.bucket || queueUrl);

  let pulled = 0;
  try {
    if (queueUrl && inbound.bucket) {
      // Real-time: drain the queue, syncing the bucket on any notification.
      const { makeSqsAdapter } = await import("../../lib/inbound-realtime-aws.js");
      const { watchInboundOnce } = await import("../../lib/inbound-realtime.js");
      const { syncS3Inbox } = await import("../../lib/s3-sync.js");
      const sqs = makeSqsAdapter({ queueUrl, region: inbound.region, waitTimeSeconds: 1 });
      await watchInboundOnce(sqs, queueUrl, async () => {
        const r = await syncS3Inbox({ bucket: inbound.bucket!, prefix: inbound.prefix, region: inbound.region, limit: 100 });
        pulled += r.synced;
        return { synced: r.synced };
      });
    } else if (inbound.bucket) {
      // No queue configured — fall back to a periodic dedup-safe S3 scan.
      const { syncS3Inbox } = await import("../../lib/s3-sync.js");
      const r = await syncS3Inbox({ bucket: inbound.bucket, prefix: inbound.prefix, region: inbound.region, limit: 100 });
      pulled += r.synced;
    }
    return { pulled, ok: true, configured };
  } catch (e) {
    return { pulled, ok: false, reason: e instanceof Error ? e.message : String(e), configured };
  }
}
