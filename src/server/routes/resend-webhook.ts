/**
 * Resend inbound webhook — the receive half for the Resend provider. Point a
 * Resend inbound webhook at `POST /webhook/resend-inbound`. Resend inbound is
 * push (there's nothing to poll), so this is how Resend mail lands in the store.
 *
 * Signature verification is mandatory whenever this route is enabled.
 */
import { isResendInboundEvent, parseResendInboundEvent, type ResendInboundEvent } from "../../lib/resend-inbound.js";
import { storeInboundEmail } from "../../db/inbound.local.js";
import { getLatestActiveProvider } from "../../db/providers.local.js";
import { getDatabase, runInTransaction } from "../../db/database.js";
import { getWebhookReceipt, recordWebhookReceipt } from "../../db/webhook-receipts.local.js";
import { json, badRequest } from "./helpers.js";
import { verifyResendSignature } from "../../lib/webhook-events.js";
import { emitEmailsEventBestEffort, inboundReceivedEventData } from "../../lib/emails-events.js";
import { readBoundedRequestText, RouteBodyTooLargeError } from "./request-body.js";

export async function handleResendWebhook(req: Request, path: string, method: string): Promise<Response | null> {
  if (path !== "/webhook/resend-inbound" || method !== "POST") return null;

  let raw: string;
  try { raw = await readBoundedRequestText(req); } catch (error) {
    if (error instanceof RouteBodyTooLargeError) return json({ error: "Request body too large" }, 413);
    throw error;
  }
  let event: ResendInboundEvent;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return badRequest("Invalid JSON object");
    event = parsed as ResendInboundEvent;
  } catch { return badRequest("Invalid JSON"); }

  // An unconfigured route fails closed instead of accepting unsigned payloads.
  const { loadConfig } = await import("../../lib/config.js");
  const secret = (loadConfig()["resend_webhook_secret"] as string | undefined) ?? process.env["RESEND_WEBHOOK_SECRET"];
  if (!secret) return json({ error: "Resend webhook secret is not configured" }, 503);
  const headers: Record<string, string | null> = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  let valid = false;
  try { valid = await verifyResendSignature(raw, headers, secret); } catch { valid = false; }
  if (!valid) return json({ error: "Invalid signature" }, 401);

  if (!isResendInboundEvent(event)) return json({ ok: true, ignored: `not an inbound event (${event.type ?? "?"})` });

  const parsed = parseResendInboundEvent(event);
  const db = getDatabase();
  const resend = getLatestActiveProvider("resend", db);
  const eventId = req.headers.get("svix-id") ?? parsed.provider_message_id;
  if (!eventId) return badRequest("Resend webhook has no stable event id");
  const existing = getWebhookReceipt("resend", eventId, db);
  if (existing) return json({ ok: true, duplicate: true, id: existing.resource_id, message_id: parsed.provider_message_id });

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
      webhook_type: event.type,
    },
  });

  return json({ ok: true, id: stored.id, message_id: parsed.provider_message_id });
}
