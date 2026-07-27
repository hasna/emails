import { getDatabase, runInTransaction } from "../db/database.js";
import { getProvider, listActiveProviderSummaries } from "../db/providers.local.js";
import { upsertEventWithResult } from "../db/events.local.js";
import { incrementBounceCounts, incrementComplaintCounts } from "../db/contacts.local.js";
import { getAdapter } from "../providers/index.js";
import { getLocalStats } from "./stats.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import { getConfigValue } from "./config.js";
import type { Database } from "../db/database.js";
import type { ProviderAdapter, RemoteEvent } from "../providers/interface.js";
import type { EmailStatus } from "../types/index.js";

interface EmailLink {
  id: string;
  status: EmailStatus;
}

interface EmailStatusUpdate {
  id: string;
  status: EmailStatus;
}

const EMAIL_LINK_CHUNK_SIZE = 500;
const EMAIL_STATUS_UPDATE_CHUNK_SIZE = 500;
const EVENT_ID_CHUNK_SIZE = 500;

function resolveEmailLinks(providerId: string, remoteEvents: RemoteEvent[], db: Database): Map<string, EmailLink> {
  const messageIds = [...new Set(remoteEvents
    .map((event) => event.provider_message_id)
    .filter((id): id is string => !!id))];
  const links = new Map<string, EmailLink>();

  for (let i = 0; i < messageIds.length; i += EMAIL_LINK_CHUNK_SIZE) {
    const chunk = messageIds.slice(i, i + EMAIL_LINK_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.query(
      `SELECT provider_message_id, id, status
         FROM emails
        WHERE provider_id = ?
          AND provider_message_id IN (${placeholders})`,
    ).all(providerId, ...chunk) as Array<{ provider_message_id: string | null; id: string; status: EmailStatus }>;
    for (const row of rows) {
      if (row.provider_message_id) links.set(row.provider_message_id, { id: row.id, status: row.status });
    }
  }

  return links;
}

function resolveExistingProviderEventIds(providerId: string, remoteEvents: RemoteEvent[], db: Database): Set<string> {
  const eventIds = [...new Set(remoteEvents
    .map((event) => event.provider_event_id)
    .filter((id): id is string => !!id))];
  const existing = new Set<string>();

  for (let i = 0; i < eventIds.length; i += EVENT_ID_CHUNK_SIZE) {
    const chunk = eventIds.slice(i, i + EVENT_ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.query(
      `SELECT provider_event_id
         FROM events
        WHERE provider_id = ?
          AND provider_event_id IN (${placeholders})`,
    ).all(providerId, ...chunk) as Array<{ provider_event_id: string | null }>;
    for (const row of rows) {
      if (row.provider_event_id) existing.add(row.provider_event_id);
    }
  }

  return existing;
}

function applyEmailStatusUpdates(updates: EmailStatusUpdate[], db: Database): void {
  if (updates.length === 0) return;

  const byStatus = new Map<EmailStatus, string[]>();
  for (const update of updates) {
    const ids = byStatus.get(update.status) ?? [];
    ids.push(update.id);
    byStatus.set(update.status, ids);
  }

  for (const [status, ids] of byStatus) {
    for (let i = 0; i < ids.length; i += EMAIL_STATUS_UPDATE_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + EMAIL_STATUS_UPDATE_CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(", ");
      db.run(
        `UPDATE emails
            SET status = ?,
                updated_at = datetime('now')
          WHERE id IN (${placeholders})`,
        [status, ...chunk],
      );
    }
  }
}

const STATUS_MAP: Partial<Record<RemoteEvent["type"], EmailStatus>> = {
  delivered: "delivered",
  bounced: "bounced",
  complained: "complained",
};

/**
 * Bounce / complaint threshold alerts after a sync.
 *
 * READS THROUGH THE STORE SEAM NOW, which changes two things a caller has to know about.
 *
 *   * A THRESHOLD THAT CANNOT BE EVALUATED IS ANNOUNCED, not skipped. `bounce_rate` is
 *     provider-scoped and divides by the count of sent mail, which the seam cannot scope
 *     to a provider (src/lib/stats.ts explains why), so a provider-scoped bounce RATE is
 *     no longer measurable. Silently not alerting would read exactly like "your bounce
 *     rate is fine", so the reason is printed instead.
 *   * A LOWER BOUND IS STILL SAFE FOR A COUNT THRESHOLD, and only in that direction: if
 *     the number of complaints we could enumerate already exceeds the threshold, so does
 *     the true number. The comparison can therefore MISS an alert but can never invent
 *     one, which is the right way round for this check.
 */
async function checkAlerts(providerId: string, providerName: string, d: Database): Promise<void> {
  const bounceThreshold = Number(getConfigValue("bounce-alert-threshold") ?? 0);
  const complaintThreshold = Number(getConfigValue("complaint-alert-threshold") ?? 0);
  if (!bounceThreshold && !complaintThreshold) return;

  try {
    // The sync's own connection, not the process-wide one: a caller that handed a database
    // to `syncProvider` must have its alerts read the rows that sync just wrote.
    const stats = await getLocalStats(providerId, "30d", createSqliteEmailStore({ database: d }));
    const unmeasured = (field: string): string =>
      stats.gaps[field]?.reason ?? "the configured store reported no value";

    if (bounceThreshold) {
      if (stats.bounce_rate === null) {
        process.stderr.write(
          `\n⚠️  [${providerName}]: the bounce-rate alert (threshold ${bounceThreshold}%, last 30d) could `
            + `not be evaluated — ${unmeasured("bounce_rate")}\n`,
        );
      } else if (stats.bounce_rate > bounceThreshold) {
        process.stderr.write(
          `\n⚠️  ALERT [${providerName}]: Bounce rate ${stats.bounce_rate.toFixed(1)}% exceeds threshold ${bounceThreshold}% (last 30d)\n`,
        );
      }
    }
    if (complaintThreshold) {
      if (stats.complained === null) {
        process.stderr.write(
          `\n⚠️  [${providerName}]: the complaint alert (threshold ${complaintThreshold}, last 30d) could `
            + `not be evaluated — ${unmeasured("complained")}\n`,
        );
      } else if (stats.complained > complaintThreshold) {
        // The percentage is a separate question from the threshold: it needs the count of
        // sent mail, which is not provider-scopable. The count that DID trip the alert is
        // reported either way, so the alert never depends on the rate being available.
        const share = stats.sent === null || stats.sent === 0
          ? `rate unavailable — ${unmeasured("sent")}`
          : `${(stats.complained / stats.sent * 100).toFixed(2)}%`;
        process.stderr.write(
          `\n⚠️  ALERT [${providerName}]: ${stats.complained} complaints (${share}) exceeds threshold ${complaintThreshold} (last 30d)\n`,
        );
      }
    }
  } catch {
    // Don't fail sync if alert check errors
  }
}

export async function syncProvider(providerId: string, db?: Database, adapterOverride?: ProviderAdapter): Promise<number> {
  const d = db || getDatabase();
  const provider = getProvider(providerId, d);
  if (!provider) throw new Error(`Provider not found: ${providerId}`);

  const adapter = adapterOverride ?? getAdapter(provider);

  // Get last sync time from most recent event
  const lastEvent = d
    .query("SELECT occurred_at FROM events WHERE provider_id = ? ORDER BY occurred_at DESC LIMIT 1")
    .get(providerId) as { occurred_at: string } | null;

  const since = lastEvent?.occurred_at;

  const remoteEvents = await adapter.pullEvents(since);
  const emailLinks = resolveEmailLinks(providerId, remoteEvents, d);
  const existingProviderEventIds = resolveExistingProviderEventIds(providerId, remoteEvents, d);
  let inserted = 0;

  runInTransaction(d, () => {
    const bouncedRecipients: string[] = [];
    const complainedRecipients: string[] = [];
    const statusUpdates: EmailStatusUpdate[] = [];

    for (const remoteEvent of remoteEvents) {
      if (remoteEvent.provider_event_id && existingProviderEventIds.has(remoteEvent.provider_event_id)) continue;

      const emailLink = remoteEvent.provider_message_id ? emailLinks.get(remoteEvent.provider_message_id) : undefined;

      const upserted = upsertEventWithResult(
        {
          email_id: emailLink?.id ?? null,
          provider_id: providerId,
          provider_event_id: remoteEvent.provider_event_id,
          type: remoteEvent.type,
          recipient: remoteEvent.recipient ?? null,
          metadata: remoteEvent.metadata ?? {},
          occurred_at: remoteEvent.occurred_at,
        },
        d,
      );
      if (!upserted.created) continue;
      if (remoteEvent.provider_event_id) existingProviderEventIds.add(remoteEvent.provider_event_id);
      inserted++;

      // Update email status if we have a linked email
      if (emailLink) {
        const newStatus = STATUS_MAP[remoteEvent.type];
        if (newStatus && emailLink.status === "sent") {
          statusUpdates.push({ id: emailLink.id, status: newStatus });
          emailLink.status = newStatus;
        }
      }

      // Track bounce/complaint counts on contacts
      if (remoteEvent.recipient) {
        if (remoteEvent.type === "bounced") {
          bouncedRecipients.push(remoteEvent.recipient);
        } else if (remoteEvent.type === "complained") {
          complainedRecipients.push(remoteEvent.recipient);
        }
      }
    }

    applyEmailStatusUpdates(statusUpdates, d);
    incrementBounceCounts(bouncedRecipients, d);
    incrementComplaintCounts(complainedRecipients, d);
  });

  // Check bounce/complaint thresholds after sync
  if (inserted > 0) {
    await checkAlerts(providerId, provider.name, d);
  }

  return inserted;
}

export async function syncAll(db?: Database): Promise<Record<string, number>> {
  const d = db || getDatabase();
  const providers = listActiveProviderSummaries(undefined, d);
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
