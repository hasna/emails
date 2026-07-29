/**
 * Inbound webhook — the push half of real-time inbound, LOCAL (SQLite) mount.
 * Point an SNS HTTP(S) subscription (on the SES inbound topic) at
 * `POST /webhook/ses-inbound`:
 *   - SubscriptionConfirmation → we fetch SubscribeURL to confirm automatically.
 *   - Notification (Received)  → dedup-safe syncS3Inbox so the new message lands
 *                                in the inbox immediately.
 *   - Notification (Bounce / Complaint / Delivery) → the delivery outcome is
 *                                persisted to the local `events` ledger.
 *
 * No manual `emails inbox sync-s3` needed. The bucket/region/prefix come from
 * config (inbound_s3_bucket / inbound_s3_region / inbound_s3_prefix).
 *
 * The receiver itself — signature verification, the SNS topic/account allowlist,
 * SubscribeURL host pinning, parsing and the idempotency protocol — lives in
 * ../webhooks/receivers.ts and is shared verbatim with the self-hosted `/v1`
 * mount. This module supplies ONLY the local destination store: every write here
 * goes through the `src/db/*.local.ts` SQLite repositories.
 */
import { getInboundBuckets, getInboundConfig, loadConfig } from "../../lib/config.js";
import { emitEmailsEventBestEffort } from "../../lib/emails-events.js";
import {
  receiveSesNotification,
  SES_INBOUND_WEBHOOK_PATH,
  type ConfiguredInboundSource,
  type FetchLike,
  type SesIngestRequest,
  type SesIngestResult,
  type WebhookReceiptLedger,
} from "../webhooks/receivers.js";

export { isAwsSnsUrl } from "../webhooks/receivers.js";
export type { FetchLike } from "../webhooks/receivers.js";

function configuredWebhookSecret(): string | undefined {
  const config = loadConfig();
  return (config["ses_inbound_webhook_secret"] as string | undefined)
    ?? (config["emails_inbound_webhook_secret"] as string | undefined)
    ?? process.env["EMAILS_SES_INBOUND_WEBHOOK_SECRET"]
    ?? process.env["EMAILS_INBOUND_WEBHOOK_SECRET"];
}

function requireWebhookSecret(): boolean {
  const raw = process.env["EMAILS_REQUIRE_SES_INBOUND_SECRET"];
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * The single local SQLite `webhook_receipts` ledger. Local mode has one store, so
 * there is no tenant dimension and the envelope evidence is not consulted.
 */
export function localWebhookReceiptLedger(): WebhookReceiptLedger {
  return {
    async find(provider, eventId) {
      const { getDatabase } = await import("../../db/database.js");
      const { getWebhookReceipt } = await import("../../db/webhook-receipts.local.js");
      const existing = getWebhookReceipt(provider, eventId, getDatabase());
      return existing ? { resourceId: existing.resource_id } : null;
    },
    async record(provider, eventId, resourceId) {
      const { getDatabase } = await import("../../db/database.js");
      const { recordWebhookReceipt } = await import("../../db/webhook-receipts.local.js");
      recordWebhookReceipt(provider, eventId, resourceId, getDatabase());
    },
  };
}

/**
 * Persist a delivery outcome into the local `events` ledger. `events.provider_id`
 * is NOT NULL, so with no active provider row there is nothing to attach the
 * outcome to and the receiver reports it unrouted rather than dropping it
 * silently.
 */
export async function recordLocalDeliveryEvent(
  providerType: "ses" | "resend",
  event: {
    provider_event_id: string;
    type: "delivered" | "bounced" | "complained" | "opened" | "clicked";
    recipient?: string;
    provider_message_id?: string;
    occurred_at: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ id: string } | null> {
  const { getDatabase } = await import("../../db/database.js");
  const { getLatestActiveProviderId } = await import("../../db/providers.local.js");
  const { createEvent } = await import("../../db/events.js");
  const db = getDatabase();
  const providerId = getLatestActiveProviderId(providerType, db) ?? getLatestActiveProviderId(undefined, db);
  if (!providerId) return null;
  const stored = await createEvent({
    provider_id: providerId,
    provider_event_id: event.provider_event_id,
    type: event.type,
    recipient: event.recipient ?? null,
    occurred_at: event.occurred_at,
    metadata: {
      ...(event.metadata ?? {}),
      ...(event.provider_message_id ? { provider_message_id: event.provider_message_id } : {}),
    },
  }, db);
  return { id: stored.id };
}

function localInboundSource(): ConfiguredInboundSource {
  // The operator-configured source of truth; the payload's own bucket is never
  // consulted (see the SECURITY note in the shared receiver).
  const inbound = getInboundConfig();
  return {
    bucket: inbound.bucket,
    prefix: inbound.prefix,
    region: inbound.region,
    providerId: inbound.bucket
      ? getInboundBuckets().find((entry) => entry.bucket === inbound.bucket)?.providerId
      : undefined,
  };
}

export async function handleInboundWebhook(
  req: Request,
  path: string,
  method: string,
  deps?: {
    fetchUrl?: FetchLike;
    verifySns?: (body: Record<string, unknown>) => Promise<boolean>;
    sync?: (
      bucket: string,
      prefix: string | undefined,
      region: string | undefined,
      opts?: { keys?: string[]; providerId?: string },
    ) => Promise<{ synced: number }>;
  },
): Promise<Response | null> {
  if (path !== SES_INBOUND_WEBHOOK_PATH || method !== "POST") return null;

  const sync = deps?.sync ?? (async (
    bucket: string,
    prefix: string | undefined,
    region: string | undefined,
    syncOpts?: { keys?: string[]; providerId?: string },
  ) => {
    const { syncS3Inbox } = await import("../../lib/s3-sync.local.js");
    return syncS3Inbox({
      bucket,
      prefix,
      region,
      providerId: syncOpts?.providerId,
      keys: syncOpts?.keys,
      limit: syncOpts?.keys?.length ?? 100,
    });
  });

  return receiveSesNotification(req, {
    ledger: localWebhookReceiptLedger(),
    inboundSource: localInboundSource,
    configuredSecret: configuredWebhookSecret,
    requireSecret: requireWebhookSecret,
    fetchUrl: deps?.fetchUrl,
    verifySns: deps?.verifySns,
    route: SES_INBOUND_WEBHOOK_PATH,
    onIngestRequested: (info) => {
      emitEmailsEventBestEffort({
        type: "emails.inbound.sync.requested",
        subject: info.messageId,
        severity: "info",
        dedupeKey: `emails:inbound:ses-sync-requested:${info.messageId}`,
        message: "SES inbound notification requested mailbox sync",
        data: {
          message_id: info.messageId,
          bucket: info.bucket,
          prefix: info.prefix ?? "",
          region: info.region,
          object_key: info.objectKey ?? null,
          provider_id: info.providerId ?? null,
        },
        metadata: {
          route: info.route,
          exact_key: Boolean(info.objectKey),
        },
      });
    },
    async ingest(request: SesIngestRequest): Promise<SesIngestResult> {
      const result = await sync(
        request.bucket,
        request.prefix,
        request.region,
        {
          keys: request.objectKey ? [request.objectKey] : undefined,
          providerId: request.providerId,
        },
      );
      return { synced: result.synced, resourceId: request.messageId ?? null };
    },
    recordDeliveryEvent: (event) => recordLocalDeliveryEvent("ses", event),
  });
}
