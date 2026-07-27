// ONE message stream, assembled from the two tables SQLite happens to keep it in.
//
// THE FINDING THIS FILE ENCODES. `emails` and `inbound` are not two families.
// The strongest arm (the tenant-scoped Postgres store) serves the whole inbox
// from ONE `messages` table and separates inbound from outbound with a
// predicate — `lower(COALESCE(direction,'')) <> 'outbound'` — plus six folder
// predicates over labels and status. SQLite's split into `emails` and
// `inbound_emails` is a storage artifact of how the two arms grew, not a domain
// distinction, so this file lifts the strongest arm's SHAPE (one stream,
// direction + folder predicates) and SQLite's real query logic underneath it.
//
// Concretely:
//   * READS union both tables. `inbound_emails` has carried both directions
//     since `is_sent` landed; `emails` is the legacy provider-scoped sent
//     ledger. Reading only one of them would under-report the Sent folder,
//     which is the plausible-wrong-answer failure in miniature.
//   * WRITES go to `inbound_emails` alone, because it is the only one of the two
//     with folder state, labels and a nullable provider. `emails.provider_id` is
//     NOT NULL with a foreign key, and the seam's `MessageInput` carries no
//     provider — that column is exactly the shape this refactor declines to
//     lift. Legacy ledger rows stay readable, and updatable in the two columns
//     they actually have.
//
// FOLDER PREDICATES ARE COPIED FROM THE SERVER, SEMANTICS FIRST. There, archived
// / spam / trash live in the `labels` JSON; here they are indexed boolean
// columns. The predicates below are the same set membership expressed against
// those columns, and the row mapper folds the three flags back INTO `labels` so
// the record shape a caller sees is the server's, not SQLite's.

import { sqlEmailDomain } from "../db/email-address-sql.js";
import { parseJsonArray, parseJsonObject } from "../db/json.js";
import type {
  MessageFolder,
  MessageListRecord,
  MessageRecord,
} from "../store/records.js";

/** Folder state the server keeps in `labels` and SQLite keeps in boolean columns. */
export const FOLDER_LABELS = ["archived", "spam", "trash"] as const;

/** List snippet budget, copied from the server so pages stay comparable. */
const MESSAGE_SNIPPET_CHARS = 140;

/**
 * The ORDERING KEY, canonicalised.
 *
 * Timestamps in this database are written in two formats: `toISOString()` from
 * application code and `datetime('now')` (`YYYY-MM-DD HH:MM:SS`) from column
 * defaults. Ordering the raw strings is deterministic but NOT chronological —
 * `'T'` sorts after `' '`, so a default-stamped row and an ISO row on the same
 * second come back in the wrong order. That is tolerable for a LIMIT/OFFSET list
 * and fatal for the `keysetPagination` claim, whose whole content is that the
 * order is total AND meaningful. `strftime` normalises both forms; the COALESCE
 * keeps a value SQLite cannot parse in the order (as itself) rather than
 * collapsing every such row to NULL and destroying totality.
 */
function sortKey(column: string): string {
  return `COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ${column}), ${column})`;
}

/** Guard a JSON column so `json_each` / `json_array_length` cannot fault on it. */
function jsonArrayColumn(column: string): string {
  return `CASE WHEN json_valid(${column}) AND json_type(${column}) = 'array' THEN ${column} ELSE '[]' END`;
}

function jsonObjectColumn(column: string): string {
  return `CASE WHEN json_valid(${column}) AND json_type(${column}) = 'object' THEN ${column} ELSE '{}' END`;
}

/**
 * The unified message stream. Column names follow the seam's `MessageRecord`,
 * not either table's, so every query below reads like the server's.
 *
 * `store_table` is the one column that is neither: the writers need to know
 * which physical table a row came from, because the legacy ledger accepts fewer
 * patches than the unified table does. It never leaves this module's mappers.
 */
export const UNIFIED_MESSAGES_SQL = `(
  SELECT
    e.id AS id,
    'outbound' AS direction,
    e.from_address AS from_addr,
    ${jsonArrayColumn("e.to_addresses")} AS to_addrs_json,
    ${jsonArrayColumn("e.cc_addresses")} AS cc_addrs_json,
    e.subject AS subject,
    ec.text_body AS body_text,
    ec.html AS body_html,
    e.status AS status,
    e.provider_message_id AS provider_message_id,
    e.message_id AS message_id,
    e.in_reply_to AS in_reply_to,
    e.sent_at AS received_at,
    0 AS is_read,
    0 AS is_starred,
    0 AS is_archived,
    0 AS is_spam,
    0 AS is_trash,
    '[]' AS labels_json,
    ${jsonObjectColumn("ec.headers_json")} AS headers_json,
    '[]' AS attachments_json,
    e.attachment_count AS attachment_count,
    NULL AS source_id,
    e.idempotency_key AS idempotency_key,
    e.created_at AS created_at,
    e.updated_at AS updated_at,
    ${sortKey("COALESCE(e.sent_at, e.created_at)")} AS sort_ts,
    'emails' AS store_table
  FROM emails e
  LEFT JOIN email_content ec ON ec.email_id = e.id
  UNION ALL
  SELECT
    i.id,
    CASE WHEN i.is_sent = 1 THEN 'outbound' ELSE 'inbound' END,
    i.from_address,
    ${jsonArrayColumn("i.to_addresses")},
    ${jsonArrayColumn("i.cc_addresses")},
    i.subject,
    i.text_body,
    i.html_body,
    COALESCE(i.status, CASE WHEN i.is_sent = 1 THEN 'sent' ELSE 'received' END),
    i.provider_message_id,
    i.message_id,
    CASE WHEN json_valid(i.headers_json)
      THEN COALESCE(
        json_extract(i.headers_json, '$."In-Reply-To"'),
        json_extract(i.headers_json, '$."in-reply-to"')
      )
      ELSE NULL END,
    i.received_at,
    i.is_read,
    i.is_starred,
    i.is_archived,
    i.is_spam,
    i.is_trash,
    ${jsonArrayColumn("i.label_ids_json")},
    ${jsonObjectColumn("i.headers_json")},
    ${jsonArrayColumn("i.attachments_json")},
    json_array_length(${jsonArrayColumn("i.attachments_json")}),
    i.source_id,
    NULL,
    i.created_at,
    COALESCE(i.updated_at, i.created_at),
    ${sortKey("COALESCE(i.received_at, i.created_at)")},
    'inbound_emails'
  FROM inbound_emails i
)`;

// The server's predicates, expressed against this stream's columns.
const NOT_OUTBOUND_SQL = "lower(COALESCE(m.direction, '')) <> 'outbound'";
const OUTBOUND_SQL = "lower(COALESCE(m.direction, '')) = 'outbound'";
const ARCHIVED_SQL = "m.is_archived = 1";
const SPAM_SQL = "(m.is_spam = 1 OR lower(COALESCE(m.status, '')) = 'spam')";
const TRASH_SQL = "m.is_trash = 1";

export const FOLDER_PREDICATES: Record<MessageFolder, readonly string[]> = {
  inbox: [NOT_OUTBOUND_SQL, `NOT (${ARCHIVED_SQL})`, `NOT ${SPAM_SQL}`, `NOT (${TRASH_SQL})`],
  starred: ["m.is_starred = 1", NOT_OUTBOUND_SQL, `NOT (${ARCHIVED_SQL})`, `NOT ${SPAM_SQL}`, `NOT (${TRASH_SQL})`],
  sent: [OUTBOUND_SQL],
  archived: [ARCHIVED_SQL, NOT_OUTBOUND_SQL, `NOT ${SPAM_SQL}`, `NOT (${TRASH_SQL})`],
  spam: [SPAM_SQL, NOT_OUTBOUND_SQL],
  trash: [TRASH_SQL, NOT_OUTBOUND_SQL],
};

export const DIRECTION_PREDICATES = {
  inbound: NOT_OUTBOUND_SQL,
  outbound: OUTBOUND_SQL,
} as const;

/**
 * "A recipient of this message is at one of these domains." The server answers
 * this from its parsed `message_recipients` table; SQLite parses the stored
 * `to_addrs` array on the fly with the same address-extraction fragment the
 * local repositories already use for display-name forms (`Ops <ops@x>`).
 */
export function recipientDomainPredicate(count: number): string {
  const placeholders = new Array(count).fill("?").join(", ");
  return `EXISTS (
    SELECT 1 FROM json_each(m.to_addrs_json) recipient
     WHERE ${sqlEmailDomain("recipient.value")} IN (${placeholders})
  )`;
}

/** The COUNT aggregate behind `messageCounts`, folder-for-folder the server's. */
export const MESSAGE_COUNT_COLUMNS = `
  COUNT(*) FILTER (WHERE ${OUTBOUND_SQL}) AS sent,
  COUNT(*) FILTER (WHERE ${FOLDER_PREDICATES.inbox.join(" AND ")}) AS inbox,
  COUNT(*) FILTER (WHERE ${FOLDER_PREDICATES.inbox.join(" AND ")} AND m.is_read = 0) AS unread,
  COUNT(*) FILTER (WHERE ${FOLDER_PREDICATES.starred.join(" AND ")}) AS starred,
  COUNT(*) FILTER (WHERE ${FOLDER_PREDICATES.archived.join(" AND ")}) AS archived,
  COUNT(*) FILTER (WHERE ${FOLDER_PREDICATES.spam.join(" AND ")}) AS spam,
  COUNT(*) FILTER (WHERE ${FOLDER_PREDICATES.trash.join(" AND ")}) AS trash,
  COUNT(*) AS total,
  MAX(CASE WHEN ${NOT_OUTBOUND_SQL} THEN m.sort_ts END) AS latest_received_at
`;

/** Every column a full `MessageRecord` needs. */
export const MESSAGE_RECORD_COLUMNS = `
  m.id, m.direction, m.from_addr, m.to_addrs_json, m.cc_addrs_json, m.subject,
  m.body_text, m.body_html, m.status, m.provider_message_id, m.message_id,
  m.in_reply_to, m.received_at, m.is_read, m.is_starred, m.is_archived,
  m.is_spam, m.is_trash, m.labels_json, m.headers_json, m.attachments_json,
  m.attachment_count, m.source_id, m.idempotency_key, m.created_at,
  m.updated_at, m.sort_ts, m.store_table
`;

/**
 * List columns. Bodies, headers and attachment payload metadata are absent by
 * design (they were ~73% of a page on the server); only a bounded snippet source
 * is carried, and it is collapsed to `MESSAGE_SNIPPET_CHARS` in the mapper.
 */
export const MESSAGE_LIST_COLUMNS = `
  m.id, m.direction, m.from_addr, m.to_addrs_json, m.cc_addrs_json, m.subject,
  m.status, m.provider_message_id, m.message_id, m.in_reply_to, m.received_at,
  m.is_read, m.is_starred, m.is_archived, m.is_spam, m.is_trash, m.labels_json,
  m.source_id, m.attachment_count, m.created_at, m.updated_at, m.sort_ts,
  substr(COALESCE(m.body_text, ''), 1, 400) AS snippet_source
`;

export type MessageRow = Record<string, unknown>;

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function flag(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Fold the boolean folder columns back into `labels`.
 *
 * This is the direction that matters: the seam's record shape has no
 * `is_archived`, because the strongest arm keeps that state in the label set. A
 * store that dropped the flags here would report an archived message as an inbox
 * message with nothing to distinguish it.
 */
function labelsFor(row: MessageRow): string[] {
  const stored = parseJsonArray<unknown>(textOrNull(row["labels_json"])).map((label) => String(label));
  const present = new Set(stored.map((label) => label.trim().toLowerCase()));
  const folders: Array<[string, unknown]> = [
    ["archived", row["is_archived"]],
    ["spam", row["is_spam"]],
    ["trash", row["is_trash"]],
  ];
  const extra = folders
    .filter(([label, value]) => flag(value) && !present.has(label))
    .map(([label]) => label);
  return [...stored, ...extra];
}

/** Which physical table a row came from. Never leaves this module's callers. */
export function rowTable(row: MessageRow): string {
  return text(row["store_table"]);
}

export function mapMessageRecord(row: MessageRow): MessageRecord {
  return {
    id: text(row["id"]),
    direction: text(row["direction"]),
    from_addr: text(row["from_addr"]),
    to_addrs: parseJsonArray<unknown>(textOrNull(row["to_addrs_json"])).map((value) => String(value)),
    cc_addrs: parseJsonArray<unknown>(textOrNull(row["cc_addrs_json"])).map((value) => String(value)),
    subject: textOrNull(row["subject"]),
    body_text: textOrNull(row["body_text"]),
    body_html: textOrNull(row["body_html"]),
    status: text(row["status"]),
    provider_message_id: textOrNull(row["provider_message_id"]),
    message_id: textOrNull(row["message_id"]),
    in_reply_to: textOrNull(row["in_reply_to"]),
    received_at: textOrNull(row["received_at"]),
    is_read: flag(row["is_read"]),
    is_starred: flag(row["is_starred"]),
    labels: labelsFor(row),
    headers: parseJsonObject(textOrNull(row["headers_json"])),
    attachments: parseJsonArray<unknown>(textOrNull(row["attachments_json"])),
    source_id: textOrNull(row["source_id"]),
    idempotency_key: textOrNull(row["idempotency_key"]),
    // The three ledger fields. `'none'` is not a placeholder invented here: it is
    // the server's own DEFAULT for a message that never entered the send-intent
    // ledger (migration 0011), and no message in this store ever has — the
    // `sendIntentLedger` capability is declared false and every ledger operation
    // refuses. Reporting anything else would claim a state machine that is not there.
    send_payload_hash: null,
    send_state: "none",
    send_started_at: null,
    created_at: text(row["created_at"]),
    updated_at: text(row["updated_at"]),
  };
}

export function mapMessageListRecord(row: MessageRow): MessageListRecord {
  const snippet = text(row["snippet_source"]).replace(/\s+/g, " ").trim().slice(0, MESSAGE_SNIPPET_CHARS);
  return {
    id: text(row["id"]),
    direction: text(row["direction"]),
    from_addr: text(row["from_addr"]),
    to_addrs: parseJsonArray<unknown>(textOrNull(row["to_addrs_json"])).map((value) => String(value)),
    cc_addrs: parseJsonArray<unknown>(textOrNull(row["cc_addrs_json"])).map((value) => String(value)),
    subject: textOrNull(row["subject"]),
    status: text(row["status"]),
    provider_message_id: textOrNull(row["provider_message_id"]),
    message_id: textOrNull(row["message_id"]),
    in_reply_to: textOrNull(row["in_reply_to"]),
    received_at: textOrNull(row["received_at"]),
    is_read: flag(row["is_read"]),
    is_starred: flag(row["is_starred"]),
    labels: labelsFor(row),
    source_id: textOrNull(row["source_id"]),
    send_state: "none",
    send_started_at: null,
    created_at: text(row["created_at"]),
    updated_at: text(row["updated_at"]),
    snippet: snippet.length > 0 ? snippet : null,
    attachment_count: count(row["attachment_count"]),
  };
}

export { count as countValue, flag as flagValue, text as textValue, textOrNull as textOrNullValue };
