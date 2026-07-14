import type { Database } from "./database.js";
import type {
  CreateMailMessageInput,
  MailMessage,
  MailMessageRow,
  MailboxMessageState,
  MailboxMessageStateRow,
  UpsertMailboxMessageStateInput,
} from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";
import { parseJsonArray, parseJsonObject } from "./json.js";

function rowToMessage(row: MailMessageRow): MailMessage {
  return {
    id: row.id,
    rfc_message_id: row.rfc_message_id,
    subject: row.subject,
    from_address: row.from_address,
    to_addresses: parseJsonArray<string>(row.to_addresses),
    cc_addresses: parseJsonArray<string>(row.cc_addresses),
    bcc_addresses: parseJsonArray<string>(row.bcc_addresses),
    text_body: row.text_body,
    html_body: row.html_body,
    headers: parseJsonObject(row.headers_json),
    attachments: parseJsonArray(row.attachments_json),
    raw_s3_url: row.raw_s3_url,
    metadata_s3_url: row.metadata_s3_url,
    raw_size: row.raw_size,
    sent_at: row.sent_at,
    received_at: row.received_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToState(row: MailboxMessageStateRow): MailboxMessageState {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    mail_message_id: row.mail_message_id,
    folder_id: row.folder_id,
    source_id: row.source_id,
    source_dedupe_key: row.source_dedupe_key,
    direction: row.direction,
    provider_message_id: row.provider_message_id,
    provider_thread_id: row.provider_thread_id,
    thread_id: row.thread_id,
    labels: parseJsonArray<string>(row.labels_json),
    is_read: !!row.is_read,
    read_at: row.read_at,
    is_archived: !!row.is_archived,
    is_starred: !!row.is_starred,
    is_spam: !!row.is_spam,
    is_trash: !!row.is_trash,
    received_at: row.received_at,
    sent_at: row.sent_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createMailMessage(input: CreateMailMessageInput, db?: Database): MailMessage {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();
  d.run(
    `INSERT INTO mail_messages
      (id, rfc_message_id, subject, from_address, to_addresses, cc_addresses, bcc_addresses,
       text_body, html_body, headers_json, attachments_json, raw_s3_url, metadata_s3_url,
       raw_size, sent_at, received_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.rfc_message_id ?? null,
      input.subject ?? "",
      input.from_address ?? null,
      JSON.stringify(input.to_addresses ?? []),
      JSON.stringify(input.cc_addresses ?? []),
      JSON.stringify(input.bcc_addresses ?? []),
      input.text_body ?? null,
      input.html_body ?? null,
      JSON.stringify(input.headers ?? {}),
      JSON.stringify(input.attachments ?? []),
      input.raw_s3_url ?? null,
      input.metadata_s3_url ?? null,
      input.raw_size ?? 0,
      input.sent_at ?? null,
      input.received_at ?? null,
      timestamp,
      timestamp,
    ],
  );
  return getMailMessage(id, d)!;
}

export function getMailMessage(id: string, db?: Database): MailMessage | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM mail_messages WHERE id = ?").get(id) as MailMessageRow | null;
  return row ? rowToMessage(row) : null;
}

export function upsertMailboxMessageState(input: UpsertMailboxMessageStateInput, db?: Database): MailboxMessageState {
  const d = db || getDatabase();
  if (input.source_id && input.source_dedupe_key) {
    const existing = d
      .query("SELECT * FROM mailbox_message_state WHERE source_id = ? AND source_dedupe_key = ? LIMIT 1")
      .get(input.source_id, input.source_dedupe_key) as MailboxMessageStateRow | null;
    if (existing) return rowToState(existing);
  }

  const id = uuid();
  const timestamp = now();
  d.run(
    `INSERT INTO mailbox_message_state
      (id, mailbox_id, mail_message_id, folder_id, source_id, source_dedupe_key, direction,
       provider_message_id, provider_thread_id, thread_id, labels_json, is_read, read_at,
       is_archived, is_starred, is_spam, is_trash, received_at, sent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.mailbox_id,
      input.mail_message_id,
      input.folder_id ?? null,
      input.source_id ?? null,
      input.source_dedupe_key ?? null,
      input.direction ?? "inbound",
      input.provider_message_id ?? null,
      input.provider_thread_id ?? null,
      input.thread_id ?? null,
      JSON.stringify(input.labels ?? []),
      input.is_read ? 1 : 0,
      input.read_at ?? null,
      input.is_archived ? 1 : 0,
      input.is_starred ? 1 : 0,
      input.is_spam ? 1 : 0,
      input.is_trash ? 1 : 0,
      input.received_at ?? null,
      input.sent_at ?? null,
      timestamp,
      timestamp,
    ],
  );
  return getMailboxMessageState(id, d)!;
}

export function getMailboxMessageState(id: string, db?: Database): MailboxMessageState | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM mailbox_message_state WHERE id = ?").get(id) as MailboxMessageStateRow | null;
  return row ? rowToState(row) : null;
}

export function listMailboxMessageStates(mailboxId: string, db?: Database): MailboxMessageState[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM mailbox_message_state WHERE mailbox_id = ? ORDER BY COALESCE(received_at, sent_at, created_at) DESC")
    .all(mailboxId) as MailboxMessageStateRow[];
  return rows.map(rowToState);
}
