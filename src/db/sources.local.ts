import type { Database } from "./database.js";
import type {
  CreateMailboxSourceInput,
  MailboxSource,
  MailboxSourceRow,
  ProviderProvenanceSnapshot,
} from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";
import { parseJsonObject } from "./json.js";

function rowToSource(row: MailboxSourceRow): MailboxSource {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    provider_id: row.provider_id,
    type: row.type,
    name: row.name,
    external_account_id: row.external_account_id,
    external_mailbox: row.external_mailbox,
    status: row.status,
    settings: parseJsonObject(row.settings_json),
    provider_snapshot: parseJsonObject(row.provider_snapshot_json),
    last_synced_at: row.last_synced_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getProviderSnapshot(providerId: string, db: Database): ProviderProvenanceSnapshot | Record<string, unknown> {
  const row = db
    .query("SELECT id, name, type, region, active, created_at, updated_at FROM providers WHERE id = ?")
    .get(providerId) as {
      id: string;
      name: string;
      type: ProviderProvenanceSnapshot["type"];
      region: string | null;
      active: number | boolean;
      created_at: string;
      updated_at: string;
    } | null;
  if (!row) return {};
  return {
    ...row,
    active: !!row.active,
  };
}

export function createMailboxSource(input: CreateMailboxSourceInput, db?: Database): MailboxSource {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();
  const providerSnapshot = input.provider_snapshot ?? (input.provider_id ? getProviderSnapshot(input.provider_id, d) : {});
  d.run(
    `INSERT INTO mailbox_sources
      (id, mailbox_id, provider_id, type, name, external_account_id, external_mailbox, status,
       settings_json, provider_snapshot_json, last_synced_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.mailbox_id,
      input.provider_id ?? null,
      input.type,
      input.name,
      input.external_account_id ?? null,
      input.external_mailbox ?? null,
      input.status ?? "active",
      JSON.stringify(input.settings ?? {}),
      JSON.stringify(providerSnapshot),
      input.last_synced_at ?? null,
      timestamp,
      timestamp,
    ],
  );
  return getMailboxSource(id, d)!;
}

export function getMailboxSource(id: string, db?: Database): MailboxSource | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM mailbox_sources WHERE id = ?").get(id) as MailboxSourceRow | null;
  return row ? rowToSource(row) : null;
}

export function listMailboxSources(mailboxId: string, db?: Database): MailboxSource[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM mailbox_sources WHERE mailbox_id = ? ORDER BY status ASC, type ASC, created_at ASC")
    .all(mailboxId) as MailboxSourceRow[];
  return rows.map(rowToSource);
}
