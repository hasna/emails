// Provider delivery-event sync. ONE implementation; nothing here asks where this
// installation is deployed.
//
// WHAT THIS FILE USED TO BE. An 11-line facade that read the process-wide deployment
// word and handed its two exports to one of two sibling arms: a 258-line SQLite
// ingestion pipeline and a 20-line throwing stub for the HTTP client. Both arms are
// gone; the pipeline now lives here and the stub's refusal is derived from STORAGE
// CONFIGURATION (`readStorageWiring`, src/lib/storage-wiring.ts) instead of from the
// deployment word. This module qualifies under that helper's stated rule: pulling
// delivery events is work THIS INSTALLATION PERFORMS ITSELF when it owns its
// database — with its own provider adapters, whose credentials live beside its own
// rows — and work the SERVICE performs instead when the mail is reached through an
// Emails API. The service publishes no client-driven counterpart to this ingestion,
// so "0 events synced" on an API-configured installation would be a claim about mail
// this side never looked at; the only honest answer there is a refusal that names
// the setting to change.
//
// ─── WHY THE PIPELINE HOLDS A `Database`, AND NOT THE STORE SEAM ─────────────────────
//
// The atomicity ruling for this collapse (2026-07-28) is the reason, and it is worth
// keeping in one place:
//
//   1. The seam (`src/store/`) exposes NO transaction primitive, deliberately: its
//      operations are `Promise`-shaped, `runInTransaction` (src/db/database.ts) is
//      synchronous with no async variant, and a SAVEPOINT that commits around an
//      `await` commits around NOTHING — the awaited writes land outside it, silently.
//      A client-side transaction spanning seam calls is also unimplementable against
//      the HTTP store.
//   2. Each seam operation is atomic within its own store; compound atomicity is not
//      the seam's to promise.
//   3. This sync IS a compound write — event inserts, sent-mail status transitions and
//      contact bounce/complaint counters must land together or not at all, because a
//      half-applied batch under an already-advanced cursor is never pulled again. So
//      the compound write stays in code that legitimately holds a `Database` handle
//      (the ruling's second-preference shape), where the transaction callback below is
//      FULLY SYNCHRONOUS: the network pull happens before it, the alert read after it,
//      and nothing inside it awaits.
//
// Beyond atomicity, three of the pipeline's reads are not expressible on the seam
// today and would each need a widening that `src/db/emails.ts` already documents
// refusing: the sent-ledger lookup by provider + provider_message_id (no message
// projection on the seam carries either), the per-provider latest-event cursor (no
// ordering and no aggregate on the seam's generic list), and the idempotent event
// upsert keyed on provider + provider_event_id (the generic `create` is not an
// upsert). `src/store/` is byte-identical after this change, so those stay here,
// beside the handle that can answer them.
//
// The local-arm import below (`providers.local`) is the same shape
// `src/lib/forwarding.ts` uses for the same reason: it takes the explicit `Database`
// this pipeline threads, and this pipeline is only reachable on an installation whose
// store IS that database. The contacts family has collapsed onto the store seam; its
// calls below hand it the same `Database`, which it binds to a SQLite store scoped to
// exactly these rows.
//
// THE EVENTS FAMILY HAS COLLAPSED TOO, and its idempotent upsert is now async (it
// reads and writes through the seam), so this transaction cannot call it: an `await`
// inside the callback commits the SAVEPOINT around nothing (the header's ruling).
// This is exactly the outcome the header already names — "the idempotent event upsert
// keyed on provider + provider_event_id (the generic `create` is not an upsert) …
// stay[s] here, beside the handle that can answer them" — so the upsert this
// transaction performs is `insertEventIfNew` below: the deleted SQLite arm's own
// `INSERT OR IGNORE` riding the same partial unique index, byte-equivalent dedup
// semantics, scoped to this pipeline.

import { getDatabase, runInTransaction, now, uuid } from "../db/database.js";
import { withExplicitDatabaseRoute } from "../db/database-routing.js";
import { getProviderWithCredentials, listActiveProviderSummaries } from "../db/providers.local.js";
import { incrementBounceCounts, incrementComplaintCounts } from "../db/contacts.js";
import { getAdapter } from "../providers/index.js";
import { getLocalStats } from "./stats.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import { getConfigValue } from "./config.js";
import { readStorageWiring } from "./storage-wiring.js";
import { API_BASE_URL_SETTING } from "../store-resolution.js";
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

/**
 * The local database this ingestion runs against, or a REFUSAL naming why there is
 * none. Reached only when the caller supplied no `Database`.
 *
 * NOTHING RETURNS `0` FROM HERE. Zero events synced is the shape of a healthy pull
 * over a provider with nothing new to report, and handing that back for "there is no
 * event ledger on this side to write" is the exact substitution this programme exists
 * to remove.
 */
function configuredDeliveryEventLedger(): Database {
  const wiring = readStorageWiring(process.env);
  switch (wiring.kind) {
    case "database_file":
    case "database_in_memory":
      // The configuration names a local database, so this installation keeps its own
      // mail and pulls its own provider events. `getDatabase()` resolves the same path
      // this wiring read did, through the same function.
      return getDatabase();
    case "api":
      // THE SETTING IS NAMED, and that is not a refusal documenting its own bypass:
      // the operator has told this installation where its mail lives, and where its
      // mail lives is exactly what decides whether it ingests its own provider events.
      throw new Error(
        "This installation reads its mail through an Emails API, so provider delivery-event "
          + "ingestion belongs to that service: the event ledger, the sent-mail statuses and the "
          + "contact bounce/complaint counters this sync writes — and the provider credentials it "
          + "pulls with — exist only beside a local database. Reporting zero events synced would be "
          + `a claim about mail this side never looked at. Unset ${API_BASE_URL_SETTING} to sync `
          + "into a local database, or let the service that owns the mail pull its own events.",
      );
    case "unresolved":
      // "DID NOT RESOLVE" rather than "does not name one store": this arm also catches
      // the unambiguous default whose data directory is itself refused, and the
      // resolver's own message says which fault it was.
      throw new Error(
        "This installation's storage did not resolve to one store, so whether it ingests its own "
          + `provider events is not known: ${wiring.message}`,
      );
  }
}

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

/**
 * The idempotent event insert this pipeline's TRANSACTION performs — synchronous, on
 * the explicit handle, because the collapsed events family (src/db/events.ts) is
 * async and an `await` inside `runInTransaction` commits the SAVEPOINT around
 * nothing. This is the deleted SQLite arm's own upsert, kept byte-equivalent in its
 * dedup semantics: one `INSERT OR IGNORE` riding the partial unique index
 * `idx_events_provider_event (provider_id, provider_event_id)`, so a duplicate
 * delivery is skipped by the SCHEMA and never by a read that could go stale between
 * batches. An event with no `provider_event_id` has no identity to deduplicate on
 * and is a plain insert — the same behaviour the deleted arm had.
 *
 * Returns whether a row was actually inserted, which is the only thing the loop
 * below consumes (the pre-computed `existingProviderEventIds` set already answers
 * "which one was it" for skipped rows).
 *
 * THE FALLTHROUGH IS LOAD-BEARING, exactly as it was in the deleted arm: `OR IGNORE`
 * swallows EVERY ignorable constraint failure, not just the unique key — a CHECK
 * violation (a type outside the declared set) also "ignores". So a swallowed insert
 * is re-checked against the dedup key, and only a row that genuinely exists is a
 * skip; anything else re-runs as a PLAIN insert so the real constraint error THROWS
 * and rolls the surrounding transaction back, instead of a malformed event being
 * silently dropped and the cursor advancing past it forever.
 */
function insertEventIfNew(
  d: Database,
  input: {
    email_id: string | null;
    provider_id: string;
    provider_event_id: string | null;
    type: RemoteEvent["type"];
    recipient: string | null;
    metadata: Record<string, unknown>;
    occurred_at: string;
  },
): boolean {
  const columns = `(id, email_id, provider_id, provider_event_id, type, recipient, metadata, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const bind = () => [
    uuid(),
    input.email_id,
    input.provider_id,
    input.provider_event_id,
    input.type,
    input.recipient,
    JSON.stringify(input.metadata),
    input.occurred_at,
    now(),
  ];
  if (input.provider_event_id) {
    const result = d.run(`INSERT OR IGNORE INTO events ${columns}`, bind());
    if (result.changes > 0) return true;
    const existing = d
      .query("SELECT 1 AS present FROM events WHERE provider_id = ? AND provider_event_id = ?")
      .get(input.provider_id, input.provider_event_id) as { present: number } | null;
    if (existing) return false;
  }
  d.run(`INSERT INTO events ${columns}`, bind());
  return true;
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
 * READS THROUGH THE STORE SEAM, which changes two things a caller has to know about.
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
  const d = db ?? configuredDeliveryEventLedger();
  // EVERY REPOSITORY CALL BELOW CARRIES `d` INSIDE AN EXPLICIT-HANDLE SCOPE
  // (`withExplicitDatabaseRoute`), which is the routing layer's own rule for a caller
  // that holds a `Database`: a call made WITH the handle is scoped to that database and
  // never consults process-wide routing. Without the scope, the not-yet-collapsed
  // repositories this pipeline calls into interrogate their own routing and can refuse
  // an environment their caller has already resolved. The scope is DEPTH-COUNTED,
  // SYNCHRONOUS state, so nothing wrapped here awaits — the same constraint the
  // transaction below is under, for the same reason.
  const provider = withExplicitDatabaseRoute([d], () => getProviderWithCredentials(providerId, d));
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

  // THE CALLBACK IS SYNCHRONOUS AND MUST STAY SO — see the header. An `await` inside
  // it would commit the surrounding SAVEPOINT around nothing. The contact-counter
  // writes are therefore OUTSIDE it: the collapsed contacts family is async (it reads
  // and writes through the store seam), so the recipients are collected here and
  // counted after the commit. What that moves out of the atomic unit is named in
  // src/db/contacts.ts — a crash between the commit and the counter write loses the
  // bump, where the old single-transaction shape could not.
  const bouncedRecipients: string[] = [];
  const complainedRecipients: string[] = [];
  withExplicitDatabaseRoute([d], () => runInTransaction(d, () => {
    const statusUpdates: EmailStatusUpdate[] = [];

    for (const remoteEvent of remoteEvents) {
      if (remoteEvent.provider_event_id && existingProviderEventIds.has(remoteEvent.provider_event_id)) continue;

      const emailLink = remoteEvent.provider_message_id ? emailLinks.get(remoteEvent.provider_message_id) : undefined;

      const created = insertEventIfNew(d, {
        email_id: emailLink?.id ?? null,
        provider_id: providerId,
        provider_event_id: remoteEvent.provider_event_id ?? null,
        type: remoteEvent.type,
        recipient: remoteEvent.recipient ?? null,
        metadata: remoteEvent.metadata ?? {},
        occurred_at: remoteEvent.occurred_at,
      });
      if (!created) continue;
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
  }));
  await incrementBounceCounts(bouncedRecipients, d);
  await incrementComplaintCounts(complainedRecipients, d);

  // Check bounce/complaint thresholds after sync
  if (inserted > 0) {
    await checkAlerts(providerId, provider.name, d);
  }

  return inserted;
}

export async function syncAll(db?: Database): Promise<Record<string, number>> {
  const d = db ?? configuredDeliveryEventLedger();
  // NOT wrapped in the explicit-handle scope, and the absence is measured rather than
  // an oversight: this callee reads the handed-in handle directly and consults no
  // routing of its own (src/db/providers.local.ts), so a scope here is dead code — a
  // mutation run proved its removal unobservable. The scoped calls in `syncProvider`
  // are the ones whose callees do interrogate routing.
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
