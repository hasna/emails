import type { Database } from "./database.js";

export interface WebhookReceipt {
  provider: string;
  event_id: string;
  resource_id: string | null;
  completed_at: string;
}

export function getWebhookReceipt(provider: string, eventId: string, db: Database): WebhookReceipt | null {
  return (db.query(
    "SELECT provider, event_id, resource_id, completed_at FROM webhook_receipts WHERE provider = ? AND event_id = ?",
  ).get(provider, eventId) as WebhookReceipt | null) ?? null;
}

/** Call only after the associated persistence side effect has succeeded. */
export function recordWebhookReceipt(provider: string, eventId: string, resourceId: string | null, db: Database): void {
  db.run(
    `INSERT INTO webhook_receipts (provider, event_id, resource_id, completed_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [provider, eventId, resourceId],
  );
}
