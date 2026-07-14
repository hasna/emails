import { now } from "./runtime.js";
import { selfHostedResource, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const WEBHOOK_RECEIPT_RESOURCE = "webhook-receipts";

export interface WebhookReceipt {
  provider: string;
  event_id: string;
  resource_id: string | null;
  completed_at: string;
}

function apiToReceipt(e: Record<string, unknown>): WebhookReceipt {
  return {
    provider: cstr(e["provider"]),
    event_id: cstr(e["event_id"]),
    resource_id: cstrOrNull(e["resource_id"]),
    completed_at: ciso(e["completed_at"]),
  };
}

export function getWebhookReceipt(provider: string, eventId: string): WebhookReceipt | null {
  const match = selfHostedResource(WEBHOOK_RECEIPT_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToReceipt)
    .find((r) => r.provider === provider && r.event_id === eventId);
  return match ?? null;
}

/** Call only after the associated persistence side effect has succeeded. */
export function recordWebhookReceipt(provider: string, eventId: string, resourceId: string | null): void {
  selfHostedResource(WEBHOOK_RECEIPT_RESOURCE).create({
    provider,
    event_id: eventId,
    resource_id: resourceId,
    completed_at: now(),
  });
}
