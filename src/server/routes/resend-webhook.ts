/**
 * Resend webhook — LOCAL (SQLite) mount. Point a Resend webhook at
 * `POST /webhook/resend-inbound`. Resend inbound is push (there is nothing to
 * poll), so this is how Resend mail lands in the store; delivery outcomes
 * (delivered / bounced / complained / opened / clicked) land in `events`.
 *
 * Signature verification is mandatory whenever this route is enabled.
 *
 * The receiver itself lives in ../webhooks/receivers.ts and is shared verbatim
 * with the self-hosted `/v1` mount. This module supplies ONLY the local
 * destination store: every write here goes through the `src/db/*.local.ts`
 * SQLite repositories.
 */
import { emitEmailsEventBestEffort, inboundReceivedEventData } from "../../lib/emails-events.js";
import {
  receiveResendEvent,
  RESEND_INBOUND_WEBHOOK_PATH,
  type ResendInboundSink,
} from "../webhooks/receivers.js";
import { localWebhookReceiptLedger, recordLocalDeliveryEvent } from "./inbound-webhook.js";

const storeInboundLocally: ResendInboundSink = async (parsed, _routing, eventId) => {
  const { getDatabase, runInTransaction } = await import("../../db/database.js");
  const { storeInboundEmail } = await import("../../db/inbound.local.js");
  const { getLatestActiveProvider } = await import("../../db/providers.local.js");
  const { recordWebhookReceipt } = await import("../../db/webhook-receipts.local.js");
  const db = getDatabase();
  const resend = getLatestActiveProvider("resend", db);

  // The message row and its idempotency receipt commit together: a receipt that
  // outlived a rolled-back insert would acknowledge mail that was never stored.
  const stored = runInTransaction(db, () => {
    const inserted = storeInboundEmail({
      provider_id: resend?.id ?? null,
      message_id: parsed.provider_message_id || null,
      in_reply_to_email_id: null,
      from_address: parsed.from_address,
      to_addresses: parsed.to_addresses,
      cc_addresses: parsed.cc_addresses,
      subject: parsed.subject,
      text_body: parsed.text_body,
      html_body: parsed.html_body,
      attachments: [],
      attachment_paths: [],
      headers: parsed.headers,
      raw_size: (parsed.text_body ?? parsed.html_body ?? "").length,
      received_at: parsed.received_at,
    }, db);
    recordWebhookReceipt("resend", eventId, inserted.id, db);
    return inserted;
  });

  emitEmailsEventBestEffort({
    type: "emails.inbound.received",
    subject: stored.id,
    severity: "notice",
    dedupeKey: `emails:inbound:received:${stored.id}`,
    message: "Inbound email received from Resend",
    data: inboundReceivedEventData({
      emailId: stored.id,
      providerId: resend?.id ?? null,
      source: "resend",
      messageId: parsed.provider_message_id || null,
      fromAddress: parsed.from_address,
      toAddresses: parsed.to_addresses,
      ccAddresses: parsed.cc_addresses,
      subject: parsed.subject,
      receivedAt: parsed.received_at,
      attachmentCount: 0,
    }),
    metadata: {
      provider: "resend",
      webhook_type: "inbound",
    },
  });

  return { id: stored.id, receiptRecorded: true };
};

export async function handleResendWebhook(req: Request, path: string, method: string): Promise<Response | null> {
  if (path !== RESEND_INBOUND_WEBHOOK_PATH || method !== "POST") return null;

  return receiveResendEvent(req, {
    ledger: localWebhookReceiptLedger(),
    // An unconfigured route fails closed instead of accepting unsigned payloads.
    webhookSecret: async () => {
      const { loadConfig } = await import("../../lib/config.js");
      return (loadConfig()["resend_webhook_secret"] as string | undefined) ?? process.env["RESEND_WEBHOOK_SECRET"];
    },
    storeInbound: storeInboundLocally,
    recordDeliveryEvent: (event) => recordLocalDeliveryEvent("resend", event),
  });
}
