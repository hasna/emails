/**
 * Inbound webhook — the push half of real-time inbound. Point an SNS HTTP(S)
 * subscription (on the SES inbound topic) at `POST /webhook/ses-inbound`:
 *   - SubscriptionConfirmation → we fetch SubscribeURL to confirm automatically.
 *   - Notification             → we parse it and run a dedup-safe syncS3Inbox so
 *                                the new message lands in the inbox immediately.
 *
 * No manual `emails inbox sync-s3` needed. The bucket/region/prefix come from
 * config (inbound_s3_bucket / inbound_s3_region / inbound_s3_prefix).
 */
import { parseSesNotification } from "../../lib/inbound-realtime.js";
import { json, badRequest } from "./helpers.js";

/** Injected fetch so confirmation is testable. */
export type FetchLike = (url: string) => Promise<unknown>;

export async function handleInboundWebhook(
  req: Request,
  path: string,
  method: string,
  deps?: { fetchUrl?: FetchLike; sync?: (bucket: string, prefix: string | undefined, region: string | undefined) => Promise<{ synced: number }> },
): Promise<Response | null> {
  if (path !== "/webhook/ses-inbound" || method !== "POST") return null;

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return badRequest("Invalid JSON"); }

  const type = body["Type"] ?? req.headers.get("x-amz-sns-message-type");

  // 1. Auto-confirm the SNS subscription.
  if (type === "SubscriptionConfirmation" && typeof body["SubscribeURL"] === "string") {
    const fetchUrl = deps?.fetchUrl ?? (async (u: string) => { await fetch(u); });
    await fetchUrl(body["SubscribeURL"] as string);
    return json({ ok: true, confirmed: true });
  }

  // 2. Process an inbound notification.
  if (type === "Notification" || body["notificationType"] === "Received" || body["Records"]) {
    const note = parseSesNotification(typeof body["Message"] === "string" ? (body["Message"] as string) : JSON.stringify(body));
    if (!note) return json({ ok: true, ignored: "unrecognized notification" });

    const { getInboundConfig } = await import("../../lib/config.js");
    const inbound = getInboundConfig();
    const bucket = note.bucket ?? inbound.bucket;
    const region = inbound.region;
    const prefix = inbound.prefix;
    if (!bucket) return json({ ok: true, ignored: "no bucket configured" });

    const sync = deps?.sync ?? (async (b: string, p: string | undefined, r: string | undefined) => {
      const { syncS3Inbox } = await import("../../lib/s3-sync.js");
      return syncS3Inbox({ bucket: b, prefix: p, region: r, limit: 100 });
    });
    const result = await sync(bucket, prefix, region);
    return json({ ok: true, synced: result.synced, message_id: note.messageId });
  }

  return json({ ok: true, ignored: "unhandled message type" });
}
