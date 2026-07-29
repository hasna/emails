/**
 * Provider webhook receivers — ONE implementation, mounted twice.
 *
 * Inbound mail and delivery events arrive as provider HTTP callbacks. Both the
 * local dashboard (`POST /webhook/*`, SQLite) and the self-hosted service
 * (`POST /v1/webhooks/*`, operator-owned Postgres) mount THESE functions, so
 * there is exactly one SNS signature check, one Svix signature check, one set of
 * notification parsers and one idempotency protocol across every deployment
 * mode. Only the destination — where the row lands — is injected.
 *
 * The invariant this serves: when we host it, inbound mail AND delivery events
 * are pulled into the storage the operator defines. Nothing is left sitting at
 * the provider, in any configuration.
 *
 * Scope selection is ENVELOPE-based on purpose. Inbound uses the trusted
 * envelope recipients; a delivery notification uses the envelope sender (the
 * operator's own verified sending domain). There is deliberately no field in
 * which a payload can nominate its own destination scope.
 */

import { parseSesNotification } from "../../lib/inbound-realtime.js";
import {
  isResendInboundEvent,
  parseResendInboundEvent,
  type ParsedInbound,
  type ResendInboundEvent,
} from "../../lib/resend-inbound.js";
import {
  parseResendWebhook,
  parseSesWebhook,
  verifyResendSignature,
  verifySnsStructure,
  type WebhookEvent,
} from "../../lib/webhook-events.js";
import {
  snsMessageAllowed,
  snsPolicyFromEnv,
  verifyAwsSnsSignature,
} from "../../lib/sns-signature.js";
import { readBoundedRequestText, RouteBodyTooLargeError } from "../routes/request-body.js";

/** Local dashboard mount points. */
export const SES_INBOUND_WEBHOOK_PATH = "/webhook/ses-inbound";
export const RESEND_INBOUND_WEBHOOK_PATH = "/webhook/resend-inbound";
/** Self-hosted (`/v1`) mount points. */
export const SES_INBOUND_V1_WEBHOOK_PATH = "/v1/webhooks/ses-inbound";
export const RESEND_INBOUND_V1_WEBHOOK_PATH = "/v1/webhooks/resend-inbound";

/** SES/SNS notification types that carry a delivery/engagement outcome. */
const SES_DELIVERY_NOTIFICATION_TYPES = new Set(["Bounce", "Complaint", "Delivery"]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

/** Injected fetch so SNS subscription confirmation is testable. */
export type FetchLike = (url: string) => Promise<unknown>;

/** True only for genuine AWS SNS HTTPS endpoints (host-pinned, anti-SSRF). */
export function isAwsSnsUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(parsed.hostname);
}

/**
 * Trusted envelope evidence that selects the destination scope.
 *
 * `addresses` are envelope addresses whose DOMAIN selects the scope. In local
 * mode there is a single store so this is informational; in self-hosted mode it
 * resolves the tenant through the global physical domain map. It is never read
 * from a header or body field a caller could point at another tenant.
 */
export interface WebhookRouting {
  addresses: string[];
}

/**
 * Idempotency ledger (`webhook_receipts`). `record` is reached ONLY after the
 * associated persistence side effect succeeded, so a failed ingest is retried by
 * the provider rather than acknowledged as done.
 */
export interface WebhookReceiptLedger {
  find(
    provider: string,
    eventId: string,
    routing: WebhookRouting,
  ): Promise<{ resourceId: string | null } | null>;
  record(
    provider: string,
    eventId: string,
    resourceId: string | null,
    routing: WebhookRouting,
  ): Promise<void>;
}

/**
 * Result of a successful persist.
 *
 * `receiptRecorded` lets a store that HAS transactions commit the payload row
 * and its idempotency receipt as one atomic unit (the local SQLite arm does),
 * in which case the receiver does not write the receipt a second time. A store
 * without that option leaves it unset and the receiver records the receipt
 * immediately after the successful write.
 */
export interface WebhookPersistOutcome {
  id: string;
  receiptRecorded?: boolean;
}

/** The operator-configured inbound source. NEVER derived from a payload. */
export interface ConfiguredInboundSource {
  bucket?: string;
  prefix?: string;
  region?: string;
  providerId?: string;
}

export interface SesIngestRequest extends ConfiguredInboundSource {
  bucket: string;
  /** Exact object key from the notification, already prefix-checked. */
  objectKey?: string;
  /** Provider message id (SES `mail.messageId`). */
  messageId?: string;
  /** Trusted SES envelope recipients. */
  recipients: string[];
  /** SES receipt time when the notification carried one. */
  timestamp?: string;
  /** Signed SNS MessageId, for stores that record the receipt atomically. */
  eventId: string;
}

export interface SesIngestResult {
  synced: number;
  /** Stored row id, when the destination store returns one. */
  resourceId?: string | null;
  /** Set when the deployment could not route the object into a store. */
  ignored?: string;
  receiptRecorded?: boolean;
  /**
   * Failures the ingest SWALLOWED instead of throwing (per-object and listing
   * errors — `syncS3Inbox` reports them this way). Non-empty is a FAILED
   * ingest: the receiver throws instead of recording the receipt, so the
   * notification is redelivered rather than answered "duplicate".
   */
  errors?: string[];
}

/** Persist a delivery/engagement event. `null` = no destination scope resolved. */
export type DeliveryEventSink = (
  event: WebhookEvent,
  routing: WebhookRouting,
  eventId: string,
) => Promise<WebhookPersistOutcome | null>;

/** Persist an inbound Resend message. `null` = no destination scope resolved. */
export type ResendInboundSink = (
  parsed: ParsedInbound,
  routing: WebhookRouting,
  eventId: string,
) => Promise<WebhookPersistOutcome | null>;

export interface SesReceiverDeps {
  ledger: WebhookReceiptLedger;
  /** Operator-configured bucket/prefix/region — the ONLY accepted source. */
  inboundSource: () => ConfiguredInboundSource;
  ingest: (request: SesIngestRequest) => Promise<SesIngestResult>;
  recordDeliveryEvent: DeliveryEventSink;
  /** Optional shared-secret gate in front of the SNS signature check. */
  configuredSecret?: () => string | undefined;
  requireSecret?: () => boolean;
  fetchUrl?: FetchLike;
  verifySns?: (body: Record<string, unknown>) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  /** Best-effort workflow-event emission (local dashboard only). */
  onIngestRequested?: (info: {
    messageId?: string;
    bucket: string;
    prefix?: string;
    region?: string;
    objectKey?: string;
    providerId?: string;
    route: string;
  }) => void;
  /** Route label used in emitted workflow events. */
  route?: string;
}

export interface ResendReceiverDeps {
  ledger: WebhookReceiptLedger;
  /** Resolve the signing secret. Returning undefined MUST fail closed (503). */
  webhookSecret: () => Promise<string | undefined> | string | undefined;
  storeInbound: ResendInboundSink;
  recordDeliveryEvent: DeliveryEventSink;
}

function requestWebhookSecret(req: Request): string | null {
  const direct = req.headers.get("x-emails-webhook-secret");
  if (direct) return direct;
  const auth = req.headers.get("authorization") ?? "";
  return auth.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

async function readJsonObject(
  req: Request,
): Promise<
  | { ok: true; raw: string; body: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  let raw: string;
  try {
    raw = await readBoundedRequestText(req);
  } catch (error) {
    if (error instanceof RouteBodyTooLargeError) {
      return { ok: false, response: json({ error: "Request body too large" }, 413) };
    }
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return { ok: false, response: badRequest("Invalid JSON") }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: badRequest("Invalid JSON object") };
  }
  return { ok: true, raw, body: parsed as Record<string, unknown> };
}

/** Unwrap the SNS `Message` string into the SES notification object it carries. */
function innerSesNotification(body: Record<string, unknown>): Record<string, unknown> {
  const raw = typeof body["Message"] === "string" ? (body["Message"] as string) : null;
  if (raw === null) return body;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* a non-JSON Message is not a SES notification */ }
  return {};
}

/**
 * SES / SNS receiver: inbound mail (`Received`) plus delivery outcomes
 * (`Bounce` / `Complaint` / `Delivery`). The security order is fixed and must
 * not be reordered: bounded body → optional shared secret → SNS structure →
 * topic and account allowlist → SNS message signature → idempotency → side
 * effect → receipt.
 */
export async function receiveSesNotification(
  req: Request,
  deps: SesReceiverDeps,
): Promise<Response> {
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.body;

  const secret = deps.configuredSecret?.();
  if (secret || deps.requireSecret?.()) {
    if (!secret) return json({ error: "SES inbound webhook secret is required but not configured" }, 503);
    if (requestWebhookSecret(req) !== secret) return json({ error: "Invalid webhook secret" }, 401);
  }
  if (!verifySnsStructure(body)) return badRequest("Invalid SNS payload");
  let policy;
  try {
    policy = snsPolicyFromEnv(deps.env ?? process.env);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "SNS allowlist is not configured" }, 503);
  }
  if (!snsMessageAllowed(body, policy)) return json({ error: "SNS topic or account is not allowed" }, 401);
  const signatureValid = await (deps.verifySns ?? verifyAwsSnsSignature)(body).catch(() => false);
  if (!signatureValid) return json({ error: "Invalid SNS signature" }, 401);

  const type = body["Type"] ?? req.headers.get("x-amz-sns-message-type");
  const eventId = typeof body["MessageId"] === "string" ? body["MessageId"] : "";
  if (!eventId) return badRequest("SNS MessageId is required");

  // 1. Auto-confirm the SNS subscription — but only fetch genuine AWS SNS
  //    confirmation URLs (host-pinned to sns.<region>.amazonaws.com over HTTPS)
  //    so a forged body can't turn this into a server-side request forgery.
  if (type === "SubscriptionConfirmation" && typeof body["SubscribeURL"] === "string") {
    if (!isAwsSnsUrl(body["SubscribeURL"] as string)) {
      return badRequest("SubscribeURL is not a valid AWS SNS endpoint");
    }
    // A confirmation carries no envelope, so it has no per-tenant scope; the
    // ledger decides whether it can record one.
    const routing: WebhookRouting = { addresses: [] };
    if (await deps.ledger.find("sns", eventId, routing)) {
      return json({ ok: true, duplicate: true, message_id: eventId });
    }
    const fetchUrl = deps.fetchUrl ?? (async (url: string) => { await fetch(url); });
    await fetchUrl(body["SubscribeURL"] as string);
    await deps.ledger.record("sns", eventId, String(body["TopicArn"] ?? ""), routing);
    return json({ ok: true, confirmed: true });
  }

  const inner = innerSesNotification(body);
  const notificationType = typeof inner["notificationType"] === "string" ? (inner["notificationType"] as string) : "";

  // 2. Delivery / engagement outcome (bounce, complaint, delivery). The scope is
  //    selected by the ENVELOPE SENDER — the operator's own verified sending
  //    domain — never by the bounced recipients and never by a payload field.
  if (SES_DELIVERY_NOTIFICATION_TYPES.has(notificationType)) {
    const mail = (inner["mail"] ?? {}) as Record<string, unknown>;
    const sender = typeof mail["source"] === "string" ? (mail["source"] as string) : "";
    const routing: WebhookRouting = { addresses: sender ? [sender] : [] };
    if (await deps.ledger.find("sns", eventId, routing)) {
      return json({ ok: true, duplicate: true, message_id: eventId });
    }
    // `eventId` (the signed SNS MessageId) is the stable provider event id.
    const event = parseSesWebhook(inner, eventId);
    if (!event) return json({ ok: true, ignored: "unrecognized delivery notification" });
    const stored = await deps.recordDeliveryEvent(event, routing, eventId);
    if (!stored) {
      return json({
        ok: true,
        ignored: "no destination scope for delivery notification",
        message_id: event.provider_message_id ?? null,
      });
    }
    if (!stored.receiptRecorded) await deps.ledger.record("sns", eventId, stored.id, routing);
    return json({
      ok: true,
      event_id: stored.id,
      type: event.type,
      message_id: event.provider_message_id ?? null,
    });
  }

  // 3. Inbound mail.
  if (type === "Notification" || body["notificationType"] === "Received" || body["Records"]) {
    const note = parseSesNotification(
      typeof body["Message"] === "string" ? (body["Message"] as string) : JSON.stringify(body),
    );
    if (!note) return json({ ok: true, ignored: "unrecognized notification" });

    const routing: WebhookRouting = { addresses: note.recipients ?? [] };
    if (await deps.ledger.find("sns", eventId, routing)) {
      return json({ ok: true, duplicate: true, message_id: eventId });
    }

    // SECURITY: never trust note.bucket from the payload — a forged notification
    // could otherwise make us ingest an arbitrary bucket. Always use the
    // operator-configured inbound source.
    const source = deps.inboundSource();
    const bucket = source.bucket;
    if (!bucket) return json({ ok: true, ignored: "no bucket configured" });
    const objectKey = note.objectKey?.replace(/^\/+/, "");
    if (objectKey && source.prefix && !objectKey.startsWith(source.prefix)) {
      return json({
        ok: true,
        ignored: "notification object key outside configured prefix",
        message_id: note.messageId,
        object_key: objectKey,
      });
    }

    deps.onIngestRequested?.({
      messageId: note.messageId,
      bucket,
      prefix: source.prefix,
      region: source.region,
      objectKey,
      providerId: source.providerId,
      route: deps.route ?? SES_INBOUND_WEBHOOK_PATH,
    });

    const result = await deps.ingest({
      bucket,
      prefix: source.prefix,
      region: source.region,
      providerId: source.providerId,
      objectKey,
      messageId: note.messageId,
      recipients: note.recipients ?? [],
      timestamp: note.timestamp,
      eventId,
    });
    // A result that carries swallowed failures is NOT acknowledged, exactly
    // like a throwing ingest: the receipt stays unwritten so SNS redelivers
    // (re-ingest is dedup-safe) and the durable copy stays in S3. Recording it
    // would answer every redelivery "duplicate" with zero rows stored.
    if (result.errors && result.errors.length > 0) {
      throw new Error(`inbound ingest failed for ${result.errors.length} object(s): ${result.errors.join("; ")}`);
    }
    if (result.ignored) {
      return json({
        ok: true,
        ignored: result.ignored,
        message_id: note.messageId,
        object_key: objectKey ?? null,
      });
    }
    if (!result.receiptRecorded) {
      await deps.ledger.record("sns", eventId, result.resourceId ?? null, routing);
    }
    return json({
      ok: true,
      synced: result.synced,
      message_id: note.messageId,
      object_key: objectKey ?? null,
    });
  }

  return json({ ok: true, ignored: "unhandled message type" });
}

/**
 * Resend receiver: inbound mail plus delivery outcomes. Resend inbound is push
 * only (there is nothing to poll), so this route IS how Resend mail reaches the
 * operator's store. Signature verification is mandatory — an unconfigured route
 * fails closed with 503 instead of accepting unsigned payloads.
 */
export async function receiveResendEvent(
  req: Request,
  deps: ResendReceiverDeps,
): Promise<Response> {
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const event = read.body as unknown as ResendInboundEvent;

  const secret = await deps.webhookSecret();
  if (!secret) return json({ error: "Resend webhook secret is not configured" }, 503);
  const headers: Record<string, string | null> = {};
  req.headers.forEach((value, key) => { headers[key] = value; });
  let valid = false;
  try { valid = await verifyResendSignature(read.raw, headers, secret); } catch { valid = false; }
  if (!valid) return json({ error: "Invalid signature" }, 401);

  const svixId = req.headers.get("svix-id");

  if (!isResendInboundEvent(event)) {
    // Delivery / engagement outcome. The scope comes from the envelope SENDER
    // (`data.from`), which is the operator's own verified sending domain.
    const delivery = parseResendWebhook(event, svixId ?? undefined);
    if (!delivery) return json({ ok: true, ignored: `not an inbound event (${event.type ?? "?"})` });
    const sender = typeof event.data?.from === "string" ? event.data.from : "";
    const routing: WebhookRouting = { addresses: sender ? [sender] : [] };
    const eventId = svixId ?? delivery.provider_event_id;
    if (!eventId) return badRequest("Resend webhook has no stable event id");
    const existing = await deps.ledger.find("resend", eventId, routing);
    if (existing) return json({ ok: true, duplicate: true, id: existing.resourceId });
    const stored = await deps.recordDeliveryEvent(delivery, routing, eventId);
    if (!stored) {
      return json({
        ok: true,
        ignored: "no destination scope for delivery event",
        message_id: delivery.provider_message_id ?? null,
      });
    }
    if (!stored.receiptRecorded) await deps.ledger.record("resend", eventId, stored.id, routing);
    return json({
      ok: true,
      event_id: stored.id,
      type: delivery.type,
      message_id: delivery.provider_message_id ?? null,
    });
  }

  const parsed = parseResendInboundEvent(event);
  const routing: WebhookRouting = { addresses: parsed.to_addresses };
  const eventId = svixId ?? parsed.provider_message_id;
  if (!eventId) return badRequest("Resend webhook has no stable event id");
  const existing = await deps.ledger.find("resend", eventId, routing);
  if (existing) {
    return json({ ok: true, duplicate: true, id: existing.resourceId, message_id: parsed.provider_message_id });
  }

  const stored = await deps.storeInbound(parsed, routing, eventId);
  if (!stored) {
    return json({
      ok: true,
      ignored: "no destination scope for inbound recipients",
      message_id: parsed.provider_message_id,
    });
  }
  if (!stored.receiptRecorded) await deps.ledger.record("resend", eventId, stored.id, routing);
  return json({ ok: true, id: stored.id, message_id: parsed.provider_message_id });
}
