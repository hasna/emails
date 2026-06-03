/**
 * Background auto-pull for the TUI — the "daemon" half. On each tick it drains
 * any real-time inbound (SES→SNS→SQS) and/or does a dedup-safe S3 sync, plus a
 * best-effort Gmail incremental sync, so new mail appears in the inbox without
 * the user running a manual sync. Entirely best-effort: missing config or creds
 * is silently a no-op.
 */
export interface PullResult { pulled: number; ok: boolean; reason?: string; configured: boolean }

export async function autoPull(): Promise<PullResult> {
  const { getInboundConfig, getInboundBuckets, loadConfig } = await import("../../lib/config.js");
  const inbound = getInboundConfig();
  const buckets = getInboundBuckets();
  const config = loadConfig();
  const queueUrl = config["inbound_realtime_queue_url"] as string | undefined;
  const configured = buckets.length > 0 || Boolean(queueUrl);

  let pulled = 0;
  try {
    const { syncS3Inbox } = await import("../../lib/s3-sync.js");
    const { getProvider } = await import("../../db/providers.js");
    const profile = inbound.profile;
    if (profile) process.env["AWS_PROFILE"] = profile;
    // Dedup-safe scan of every configured inbound bucket. Each bucket uses its
    // SES provider's stored creds (buckets live in different AWS accounts); the
    // legacy bucket falls back to the configured SES profile / default chain.
    const syncAll = async () => {
      let n = 0;
      for (const b of buckets) {
        const prov = b.providerId ? getProvider(b.providerId) : null;
        const r = await syncS3Inbox({
          bucket: b.bucket, prefix: inbound.prefix, region: b.region,
          accessKeyId: prov?.access_key ?? undefined,
          secretAccessKey: prov?.secret_key ?? undefined,
          limit: 100,
        });
        n += r.synced;
      }
      return n;
    };
    if (queueUrl && buckets.length > 0) {
      // Real-time: drain the queue, syncing all buckets on any notification.
      const { makeSqsAdapter } = await import("../../lib/inbound-realtime-aws.js");
      const { watchInboundOnce } = await import("../../lib/inbound-realtime.js");
      const sqs = makeSqsAdapter({ queueUrl, region: inbound.region, waitTimeSeconds: 1 });
      await watchInboundOnce(sqs, queueUrl, async () => { const n = await syncAll(); pulled += n; return { synced: n }; });
    } else if (buckets.length > 0) {
      pulled += await syncAll();
    }
    return { pulled, ok: true, configured };
  } catch (e) {
    return { pulled, ok: false, reason: e instanceof Error ? e.message : String(e), configured };
  }
}
