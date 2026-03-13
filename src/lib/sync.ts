import { getDatabase } from "../db/database.js";
import { listProviders, getProvider } from "../db/providers.js";
import { getEmail } from "../db/emails.js";
import { upsertEvent } from "../db/events.js";
import { incrementBounceCount, incrementComplaintCount } from "../db/contacts.js";
import { getAdapter } from "../providers/index.js";
import type { Database } from "bun:sqlite";

export async function syncProvider(providerId: string, db?: Database): Promise<number> {
  const d = db || getDatabase();
  const provider = getProvider(providerId, d);
  if (!provider) throw new Error(`Provider not found: ${providerId}`);

  const adapter = getAdapter(provider);

  // Get last sync time from most recent event
  const lastEvent = d
    .query("SELECT occurred_at FROM events WHERE provider_id = ? ORDER BY occurred_at DESC LIMIT 1")
    .get(providerId) as { occurred_at: string } | null;

  const since = lastEvent?.occurred_at;

  const remoteEvents = await adapter.pullEvents(since);
  let inserted = 0;

  for (const remoteEvent of remoteEvents) {
    // Try to find the local email by provider_message_id
    let emailId: string | null = null;
    if (remoteEvent.provider_message_id) {
      const emailRow = d
        .query("SELECT id FROM emails WHERE provider_message_id = ? AND provider_id = ?")
        .get(remoteEvent.provider_message_id, providerId) as { id: string } | null;
      if (emailRow) emailId = emailRow.id;
    }

    const event = upsertEvent(
      {
        email_id: emailId,
        provider_id: providerId,
        provider_event_id: remoteEvent.provider_event_id,
        type: remoteEvent.type,
        recipient: remoteEvent.recipient ?? null,
        metadata: remoteEvent.metadata ?? {},
        occurred_at: remoteEvent.occurred_at,
      },
      d,
    );

    // Update email status if we have a linked email
    if (emailId && event) {
      const email = getEmail(emailId, d);
      if (email) {
        const statusMap: Record<string, string> = {
          delivered: "delivered",
          bounced: "bounced",
          complained: "complained",
        };
        const newStatus = statusMap[remoteEvent.type];
        if (newStatus && email.status === "sent") {
          d.run("UPDATE emails SET status = ?, updated_at = datetime('now') WHERE id = ?", [
            newStatus,
            emailId,
          ]);
        }
      }
    }

    // Track bounce/complaint counts on contacts
    if (remoteEvent.recipient) {
      if (remoteEvent.type === "bounced") {
        incrementBounceCount(remoteEvent.recipient, d);
      } else if (remoteEvent.type === "complained") {
        incrementComplaintCount(remoteEvent.recipient, d);
      }
    }

    inserted++;
  }

  return inserted;
}

export async function syncAll(db?: Database): Promise<Record<string, number>> {
  const d = db || getDatabase();
  const providers = listProviders(d).filter((p) => p.active);
  const results: Record<string, number> = {};

  for (const provider of providers) {
    try {
      results[provider.id] = await syncProvider(provider.id, d);
    } catch (err) {
      console.error(`Failed to sync provider ${provider.id}: ${err instanceof Error ? err.message : err}`);
      results[provider.id] = 0;
    }
  }

  return results;
}
