// The message families: messages, inbound, email content, thread/mailbox rollups.
//
// All four read the SAME unified stream (messages-sql.ts). `InboundRepository`
// is not a second storage: `listInbound` is `listMessages` with the folder
// defaulted to `inbox`, and every flag write goes through the one
// `updateMessageStatus` path. Keeping the two repositories named separately is
// the seam's decision (they map 1:1 onto today's `src/db/*` families and the
// seam guard checks that); keeping them behaviourally identical is this file's,
// and it is what makes the eventual collapse a deletion rather than a merge.

import type { SQLQueryBindings } from "bun:sqlite";
import type { Database } from "../db/database.js";
import { sqlEmailAddress } from "../db/email-address-sql.js";
import { cappedLimit, safeOffset } from "../db/pagination.js";
import { now, uuid } from "../db/runtime.js";
import type { StoreCapabilities } from "../store/capabilities.js";
import type {
  AttachmentInventoryItem,
  AttachmentMeta,
  ListAttachmentsOptions,
  ListMessagesOptions,
  ListOptions,
  MailboxRollup,
  MessageCountsRecord,
  MessageInput,
  MessageListRecord,
  MessageRaw,
  MessageRecord,
  MessageStatusPatch,
  Page,
  StoredAttachmentLookup,
  ThreadRollup,
} from "../store/records.js";
import type {
  EmailContentRepository,
  InboundRepository,
  MessagesRepository,
  ThreadsRepository,
} from "../store/repositories.js";
import type { Outcome, Refusal } from "../store/outcome.js";
import {
  decodeAttachmentCursor,
  decodeMessageCursor,
  encodeAttachmentCursor,
  encodeMessageCursor,
} from "./cursor.js";
import {
  DIRECTION_PREDICATES,
  FOLDER_LABELS,
  FOLDER_PREDICATES,
  MESSAGE_COUNT_COLUMNS,
  MESSAGE_LIST_COLUMNS,
  MESSAGE_RECORD_COLUMNS,
  UNIFIED_MESSAGES_SQL,
  countValue,
  flagValue,
  mapMessageListRecord,
  mapMessageRecord,
  recipientDomainPredicate,
  rowTable,
  textOrNullValue,
  textValue,
  type MessageRow,
} from "./messages-sql.js";
import { ambiguousId, guard, invalidInput, notFound, ok, unavailable } from "./outcome.js";
import { withImmediateTransaction } from "./transaction.js";

const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;
const UNIFIED_TABLE = "inbound_emails";
const LEDGER_TABLE = "emails";
const DELETE_CHUNK = 500;

/** LIKE metacharacters, escaped so an id prefix stays an anchored range scan. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function lowered(value: string): string {
  return `%${value.trim().toLowerCase()}%`;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function isFolderLabel(label: string): boolean {
  return (FOLDER_LABELS as readonly string[]).includes(normalizeLabel(label));
}

interface MessageQuery {
  where: string;
  params: SQLQueryBindings[];
}

/**
 * Filters shared by `listMessages`, `listInbound` and `messageCounts`, so a
 * message that a list shows and a count omits is not expressible.
 */
function messageFilters(opts: ListMessagesOptions | undefined): MessageQuery {
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (opts?.direction) conditions.push(DIRECTION_PREDICATES[opts.direction]);
  // A folder the record type does not name would otherwise be a TypeError rather
  // than an answer; a JS caller reaches this even though TypeScript cannot.
  if (opts?.folder) conditions.push(...(FOLDER_PREDICATES[opts.folder] ?? []));
  if (opts?.to?.trim()) {
    conditions.push("lower(COALESCE(m.to_addrs_json, '')) LIKE ?");
    params.push(lowered(opts.to));
  }
  if (opts?.from?.trim()) {
    conditions.push("lower(COALESCE(m.from_addr, '')) LIKE ?");
    params.push(lowered(opts.from));
  }
  if (opts?.subject?.trim()) {
    conditions.push("lower(COALESCE(m.subject, '')) LIKE ?");
    params.push(lowered(opts.subject));
  }
  if (opts?.search?.trim()) {
    const needle = lowered(opts.search);
    // Attachment filename and content type are part of the match surface, as on
    // the server: a message whose only occurrence of the term is an attachment
    // name must still be found.
    conditions.push(`(
      lower(COALESCE(m.from_addr, '')) LIKE ?
      OR lower(COALESCE(m.to_addrs_json, '')) LIKE ?
      OR lower(COALESCE(m.subject, '')) LIKE ?
      OR lower(COALESCE(m.body_text, '')) LIKE ?
      OR EXISTS (
        SELECT 1 FROM json_each(m.attachments_json) att
         WHERE lower(COALESCE(json_extract(att.value, '$.filename'), '')) LIKE ?
            OR lower(COALESCE(json_extract(att.value, '$.content_type'), '')) LIKE ?
      )
    )`);
    for (let index = 0; index < 6; index += 1) params.push(needle);
  }
  if (opts?.since?.trim()) {
    // julianday, not a string compare: this database holds both ISO and
    // `datetime('now')` timestamps and only a parsed comparison orders them.
    conditions.push("julianday(m.sort_ts) >= julianday(?)");
    params.push(opts.since.trim());
  }
  const domains = (opts?.domains ?? []).map((domain) => domain.trim().toLowerCase()).filter(Boolean);
  if (domains.length > 0) {
    conditions.push(recipientDomainPredicate(domains.length));
    params.push(...domains);
  }
  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function selectRow(db: Database, id: string): MessageRow | null {
  return db
    .query(`SELECT ${MESSAGE_RECORD_COLUMNS} FROM ${UNIFIED_MESSAGES_SQL} m WHERE m.id = ?`)
    .get(id) as MessageRow | null;
}

/** Merge `in_reply_to` into the headers blob, which is where this table keeps it. */
function headersFor(input: MessageInput): string {
  const headers: Record<string, unknown> = { ...(input.headers ?? {}) };
  // `in_reply_to` is a header on the wire and a column on the server. This table has
  // the headers blob and no column, so the value round-trips through the blob —
  // which is also where the unified read projects it from.
  if (input.in_reply_to && headers["In-Reply-To"] === undefined && headers["in-reply-to"] === undefined) {
    headers["In-Reply-To"] = input.in_reply_to;
  }
  return JSON.stringify(headers);
}

/**
 * The columns a CREATE writes: every one of them, with the seam's defaults, because
 * a new row has no prior state to preserve.
 */
function insertValues(input: MessageInput, timestamp: string): Record<string, SQLQueryBindings> {
  const labels = (input.labels ?? []).map((label) => String(label));
  const folderLabels = new Set(labels.filter(isFolderLabel).map(normalizeLabel));
  const direction = (input.direction ?? "outbound").trim().toLowerCase();
  return {
    from_address: input.from_addr,
    to_addresses: JSON.stringify(input.to_addrs ?? []),
    cc_addresses: JSON.stringify(input.cc_addrs ?? []),
    subject: input.subject ?? "",
    text_body: input.body_text ?? null,
    html_body: input.body_html ?? null,
    status: input.status ?? null,
    provider_message_id: input.provider_message_id ?? null,
    message_id: input.message_id ?? null,
    label_ids_json: JSON.stringify(labels.filter((label) => !isFolderLabel(label))),
    headers_json: headersFor(input),
    attachments_json: JSON.stringify(input.attachments ?? []),
    received_at: input.received_at ?? timestamp,
    is_read: input.is_read ? 1 : 0,
    is_starred: input.is_starred ? 1 : 0,
    is_archived: folderLabels.has("archived") ? 1 : 0,
    is_spam: folderLabels.has("spam") ? 1 : 0,
    is_trash: folderLabels.has("trash") ? 1 : 0,
    is_sent: direction === "outbound" ? 1 : 0,
    source_id: input.source_id ?? null,
    updated_at: timestamp,
  };
}

/**
 * The columns an UPSERT-onto-an-existing-row writes: ONLY the ones the input
 * actually carries.
 *
 * This is not an optimisation. Writing the full insert set on update meant a
 * re-imported message had its read flag, star, labels and received_at reset from
 * the input's defaults — so re-running an importer marked the whole mailbox unread,
 * dropped every label, and re-sorted it to now. An operation the seam documents as
 * IDEMPOTENT was destroying local state on every replay. Adversarial review
 * reproduced it; this is the fix.
 *
 * `created_at` is never in the set, and the flag columns are only touched when the
 * caller actually said something about them.
 */
function updateValues(input: MessageInput, timestamp: string): Record<string, SQLQueryBindings> {
  const values: Record<string, SQLQueryBindings> = { updated_at: timestamp };
  const put = (column: string, value: SQLQueryBindings): void => {
    values[column] = value;
  };
  put("from_address", input.from_addr);
  put("to_addresses", JSON.stringify(input.to_addrs ?? []));
  if (input.cc_addrs !== undefined) put("cc_addresses", JSON.stringify(input.cc_addrs));
  if (input.subject !== undefined) put("subject", input.subject ?? "");
  if (input.body_text !== undefined) put("text_body", input.body_text);
  if (input.body_html !== undefined) put("html_body", input.body_html);
  if (input.status !== undefined) put("status", input.status);
  if (input.provider_message_id !== undefined) put("provider_message_id", input.provider_message_id);
  if (input.message_id !== undefined) put("message_id", input.message_id);
  if (input.headers !== undefined || input.in_reply_to !== undefined) put("headers_json", headersFor(input));
  if (input.attachments !== undefined) put("attachments_json", JSON.stringify(input.attachments));
  if (input.received_at !== undefined) put("received_at", input.received_at);
  if (input.is_read !== undefined) put("is_read", input.is_read ? 1 : 0);
  if (input.is_starred !== undefined) put("is_starred", input.is_starred ? 1 : 0);
  if (input.direction !== undefined) {
    put("is_sent", input.direction.trim().toLowerCase() === "outbound" ? 1 : 0);
  }
  if (input.labels !== undefined) {
    const labels = input.labels.map((label) => String(label));
    const folderLabels = new Set(labels.filter(isFolderLabel).map(normalizeLabel));
    put("label_ids_json", JSON.stringify(labels.filter((label) => !isFolderLabel(label))));
    put("is_archived", folderLabels.has("archived") ? 1 : 0);
    put("is_spam", folderLabels.has("spam") ? 1 : 0);
    put("is_trash", folderLabels.has("trash") ? 1 : 0);
  }
  return values;
}

function insertUnifiedMessage(db: Database, input: MessageInput): string {
  const timestamp = now();
  const id = uuid();
  const values = insertValues(input, timestamp);
  const columns = Object.keys(values);
  db.run(
    `INSERT INTO ${UNIFIED_TABLE} (id, created_at, raw_size, attachment_paths, ${columns.join(", ")})
     VALUES (?, ?, 0, '[]', ${columns.map(() => "?").join(", ")})`,
    [id, timestamp, ...columns.map((column) => values[column] as SQLQueryBindings)],
  );
  return id;
}

function updateUnifiedMessage(db: Database, id: string, input: MessageInput): void {
  const values = updateValues(input, now());
  const columns = Object.keys(values);
  db.run(
    `UPDATE ${UNIFIED_TABLE} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`,
    [...columns.map((column) => values[column] as SQLQueryBindings), id],
  );
}

/**
 * The four ledger fields a caller may supply and this store cannot store.
 *
 * `createMessage` and `upsertMessage` are NOT capability-gated, so a caller handing
 * them an idempotency key or a send state gets no refusal from the capability
 * machinery — and the columns do not exist here. Accepting the field and dropping it
 * is precisely the failure the seam exists to remove (it is the same argument that
 * put `domains.notes` in the schema), so the write is refused and names the fields.
 */
function ledgerFieldRefusal(input: MessageInput): Refusal | null {
  const offending: string[] = [];
  if (input.idempotency_key !== undefined && input.idempotency_key !== null) offending.push("idempotency_key");
  if (input.send_payload_hash !== undefined && input.send_payload_hash !== null) offending.push("send_payload_hash");
  if (input.send_started_at !== undefined && input.send_started_at !== null) offending.push("send_started_at");
  if (input.send_state !== undefined && input.send_state !== "none") offending.push("send_state");
  if (offending.length === 0) return null;
  return invalidInput(
    `this store cannot record ${offending.join(", ")} on a message: it has no send-intent ledger ` +
      "(the sendIntentLedger capability is unavailable), and accepting the field without storing it " +
      "would report a write that did not happen",
  );
}

/** Reject a `since` SQLite cannot parse instead of silently matching nothing. */
function unparseableSince(db: Database, since: string): Refusal | null {
  const row = db.query("SELECT julianday(?) AS parsed").get(since) as { parsed: unknown } | null;
  if (row !== null && row.parsed !== null) return null;
  // julianday() answers NULL for an unparseable value, so every comparison against
  // it is NULL and every row is filtered out — an empty page indistinguishable from
  // a true empty result, which is the exact lie this seam removes. The strongest arm
  // errors on the same input (`$n::timestamptz`), so refusing matches it.
  return invalidInput(`since is not a timestamp SQLite can parse: ${since}`);
}

/**
 * Apply a status patch. Returns a refusal when the patch names state the row's
 * physical table cannot hold — which only happens for the legacy sent ledger,
 * whose rows have a status and a provider message id and nothing else. Dropping
 * those fields silently is the failure this whole seam is about; refusing is the
 * one honest alternative.
 */
function applyStatusPatch(db: Database, row: MessageRow, patch: MessageStatusPatch): Outcome<null> {
  const id = textValue(row["id"]);
  const table = rowTable(row);
  const sets: string[] = [];
  const params: SQLQueryBindings[] = [];
  const set = (column: string, value: SQLQueryBindings): void => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.status !== undefined) set("status", patch.status);
  if (patch.provider_message_id !== undefined) set("provider_message_id", patch.provider_message_id);

  const touchesFlags =
    patch.is_read !== undefined ||
    patch.is_starred !== undefined ||
    patch.archived !== undefined ||
    patch.add_label !== undefined ||
    patch.remove_label !== undefined;

  if (table === LEDGER_TABLE) {
    if (touchesFlags) {
      return invalidInput(
        `message ${id} is a row of the legacy sent ledger, which stores no read, star, archive or label state; ` +
          "this store will not pretend the write landed",
      );
    }
    if (sets.length === 0) return ok(null);
    set("updated_at", now());
    db.run(`UPDATE ${LEDGER_TABLE} SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
    return ok(null);
  }

  if (patch.is_read !== undefined) {
    set("is_read", patch.is_read ? 1 : 0);
    set("read_at", patch.is_read ? now() : null);
  }
  if (patch.is_starred !== undefined) set("is_starred", patch.is_starred ? 1 : 0);
  if (patch.archived !== undefined) set("is_archived", patch.archived ? 1 : 0);

  // Labels are edited ONE AT A TIME, never by replacing the caller's whole array,
  // because a whole-array write loses a concurrent label change instead of merging
  // with it. The three folder labels are the boolean columns; everything else lives
  // in the blob.
  //
  // The blob is read ONCE and written ONCE even when a patch both adds and removes,
  // because two independent read-modify-writes of the same column inside one
  // statement would silently drop the first edit.
  const stored = JSON.parse(textValue(row["labels_json"]) || "[]") as unknown[];
  let labels = stored.map((entry) => String(entry));
  let labelsTouched = false;
  for (const [label, remove] of [
    [patch.remove_label, true],
    [patch.add_label, false],
  ] as Array<[string | undefined, boolean]>) {
    if (label === undefined) continue;
    if (isFolderLabel(label)) {
      set(`is_${normalizeLabel(label)}`, remove ? 0 : 1);
      continue;
    }
    labelsTouched = true;
    labels = remove
      ? labels.filter((entry) => normalizeLabel(entry) !== normalizeLabel(label))
      : labels.some((entry) => normalizeLabel(entry) === normalizeLabel(label))
        ? labels
        : [...labels, label];
  }
  if (labelsTouched) set("label_ids_json", JSON.stringify(labels));

  if (sets.length === 0) return ok(null);
  set("updated_at", now());
  db.run(`UPDATE ${UNIFIED_TABLE} SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  return ok(null);
}

function patchMessage(db: Database, id: string, patch: MessageStatusPatch): Outcome<MessageRecord | null> {
  return guard(() =>
    withImmediateTransaction(db, () => {
      const row = selectRow(db, id);
      if (!row) return ok(null);
      const applied = applyStatusPatch(db, row, patch);
      if (!applied.ok) return applied;
      const updated = selectRow(db, id);
      return ok(updated ? mapMessageRecord(updated) : null);
    }),
  );
}

function readCounts(db: Database, opts: { domains?: string[] } | undefined): MessageCountsRecord {
  const { where, params } = messageFilters({ domains: opts?.domains });
  const row = db
    .query(`SELECT ${MESSAGE_COUNT_COLUMNS} FROM ${UNIFIED_MESSAGES_SQL} m ${where}`)
    .get(...params) as Record<string, unknown> | null;
  return {
    inbox: countValue(row?.["inbox"]),
    unread: countValue(row?.["unread"]),
    starred: countValue(row?.["starred"]),
    sent: countValue(row?.["sent"]),
    archived: countValue(row?.["archived"]),
    spam: countValue(row?.["spam"]),
    trash: countValue(row?.["trash"]),
    total: countValue(row?.["total"]),
    latest_received_at: textOrNullValue(row?.["latest_received_at"]),
  };
}

function listPage(db: Database, opts: ListMessagesOptions | undefined): Outcome<Page<MessageListRecord>> {
  const cursor = opts?.cursor ? decodeMessageCursor(opts.cursor) : null;
  if (opts?.cursor && !cursor) return invalidInput("the page cursor is malformed");
  const { where, params } = messageFilters(opts);
  const limit = cappedLimit(opts?.limit, DEFAULT_PAGE, MAX_PAGE);
  const offset = cursor ? 0 : safeOffset(opts?.offset);
  const conditions: string[] = [];
  const cursorParams: SQLQueryBindings[] = [];
  if (cursor) {
    // Strictly before the cursor in (sort_ts DESC, id DESC): total, so a resumed
    // scan re-enters at the very next row.
    conditions.push("(m.sort_ts < ? OR (m.sort_ts = ? AND m.id < ?))");
    cursorParams.push(cursor.ts, cursor.ts, cursor.id);
  }
  const whereSql = conditions.length === 0
    ? where
    : where
      ? `${where} AND ${conditions.join(" AND ")}`
      : `WHERE ${conditions.join(" AND ")}`;
  const rows = db
    .query(
      `SELECT ${MESSAGE_LIST_COLUMNS} FROM ${UNIFIED_MESSAGES_SQL} m ${whereSql}
        ORDER BY m.sort_ts DESC, m.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, ...cursorParams, limit, offset) as MessageRow[];
  const last = rows.length === limit ? rows[rows.length - 1] : undefined;
  const nextCursor = last ? encodeMessageCursor(textValue(last["sort_ts"]), textValue(last["id"])) : null;
  return ok({ items: rows.map(mapMessageListRecord), next_cursor: nextCursor });
}

export function createMessagesRepository(db: Database, capabilities: StoreCapabilities): MessagesRepository {
  return {
    async listMessages(opts?: ListMessagesOptions): Promise<Outcome<Page<MessageListRecord>>> {
      if (!capabilities.keysetPagination) return unavailable("keysetPagination");
      return guard(() => {
        const since = opts?.since?.trim() ? unparseableSince(db, opts.since.trim()) : null;
        return since ?? listPage(db, opts);
      });
    },

    async getMessage(id: string): Promise<Outcome<MessageRecord | null>> {
      return guard(() => {
        const row = selectRow(db, id);
        return ok(row ? mapMessageRecord(row) : null);
      });
    },

    async resolveMessageId(idOrPrefix: string): Promise<Outcome<{ id: string }>> {
      const value = idOrPrefix.trim();
      if (!value) return invalidInput("a message id or prefix is required");
      return guard(() => {
        const rows = db
          .query(
            `SELECT m.id FROM ${UNIFIED_MESSAGES_SQL} m
              WHERE m.id LIKE ? ESCAPE '\\' ORDER BY m.id LIMIT 2`,
          )
          .all(`${escapeLike(value)}%`) as Array<{ id: string }>;
        // Divergence from the strongest arm, deliberately: it returns a well-formed
        // UUID verbatim with no round trip, so a non-existent full id resolves and
        // 404s later. Here it is looked up, because the seam documents this operation
        // as distinguishing "no such message" (404) from "your prefix matched
        // several" (409), and it cannot do that without asking.
        if (rows.length === 0) return notFound(`no message matches ${value}`);
        // 404 and 409 are different answers, and every caller has to tell them
        // apart — which is why this returns an Outcome and not a nullable id.
        if (rows.length > 1) return ambiguousId(`the id prefix ${value} matches more than one message`);
        return ok({ id: (rows[0] as { id: string }).id });
      });
    },

    async createMessage(input: MessageInput): Promise<Outcome<MessageRecord>> {
      const refused = ledgerFieldRefusal(input);
      if (refused) return refused;
      return guard(() =>
        withImmediateTransaction(db, () => {
          const id = insertUnifiedMessage(db, input);
          const row = selectRow(db, id);
          if (!row) throw new Error(`message ${id} disappeared immediately after insert`);
          return ok(mapMessageRecord(row));
        }),
      );
    },

    async upsertMessage(input: MessageInput): Promise<Outcome<{ record: MessageRecord; inserted: boolean }>> {
      const sourceId = input.source_id?.trim();
      if (!sourceId) return invalidInput("upsertMessage requires a source_id to fence on");
      const refused = ledgerFieldRefusal(input);
      if (refused) return refused;
      return guard<{ record: MessageRecord; inserted: boolean }>(() =>
        // The read-then-write is why this needs a write lock up front: two
        // concurrent upserts of the same source_id must produce one row and one
        // `inserted: true`, not two rows or a lost update.
        withImmediateTransaction(db, () => {
          const existing = db
            .query(`SELECT id FROM ${UNIFIED_TABLE} WHERE source_id = ?`)
            .get(sourceId) as { id: string } | null;
          if (existing) {
            updateUnifiedMessage(db, existing.id, { ...input, source_id: sourceId });
            const row = selectRow(db, existing.id);
            if (!row) throw new Error(`message ${existing.id} disappeared during upsert`);
            return ok({ record: mapMessageRecord(row), inserted: false });
          }
          const id = insertUnifiedMessage(db, { ...input, source_id: sourceId });
          const row = selectRow(db, id);
          if (!row) throw new Error(`message ${id} disappeared during upsert`);
          return ok({ record: mapMessageRecord(row), inserted: true });
        }),
      );
    },

    async updateMessageStatus(id: string, patch: MessageStatusPatch): Promise<Outcome<MessageRecord | null>> {
      return patchMessage(db, id, patch);
    },

    async deleteMessage(id: string): Promise<Outcome<boolean>> {
      return guard(() =>
        withImmediateTransaction(db, () => {
          // BOTH tables, by existence rather than by the driver's `changes`. The
          // union carries no cross-table uniqueness guarantee, so resolving the
          // physical table from whichever row the read happened to return could
          // report a delete it had not performed. `changes` is also the wrong
          // counter here — it includes the rows the cascade and the delete trigger
          // remove from other tables.
          const inUnified = db.query(`SELECT 1 AS ok FROM ${UNIFIED_TABLE} WHERE id = ?`).get(id) !== null;
          const inLedger = db.query(`SELECT 1 AS ok FROM ${LEDGER_TABLE} WHERE id = ?`).get(id) !== null;
          if (!inUnified && !inLedger) return ok(false);
          if (inUnified) db.run(`DELETE FROM ${UNIFIED_TABLE} WHERE id = ?`, [id]);
          if (inLedger) db.run(`DELETE FROM ${LEDGER_TABLE} WHERE id = ?`, [id]);
          return ok(true);
        }),
      );
    },

    async messageCounts(opts?: { domains?: string[] }): Promise<Outcome<MessageCountsRecord>> {
      return guard(() => ok(readCounts(db, opts)));
    },

    async getMessageRaw(_id: string): Promise<Outcome<MessageRaw | null>> {
      // Nothing here stores RFC 5322 bytes. `raw_s3_url` points at an object this
      // store cannot read and `raw_size` counts bytes it does not hold, so the only
      // way to answer would be to SYNTHESISE a MIME document out of the projected
      // columns and present it as the message that was received. That is the
      // fabricated-answer failure, not a raw message.
      return unavailable("rawMessage");
    },
  };
}

export function createInboundRepository(db: Database, capabilities: StoreCapabilities): InboundRepository {
  const flagWrite = (id: string, patch: MessageStatusPatch): Promise<Outcome<MessageRecord | null>> =>
    Promise.resolve(patchMessage(db, id, patch));

  return {
    async listInbound(opts?: ListMessagesOptions): Promise<Outcome<Page<MessageListRecord>>> {
      if (!capabilities.keysetPagination) return unavailable("keysetPagination");
      // Literally `listMessages` with a default folder. The inbox is not separate
      // storage here any more than it is on the server.
      const scoped: ListMessagesOptions = { ...opts, folder: opts?.folder ?? "inbox" };
      return guard(() => {
        const since = opts?.since?.trim() ? unparseableSince(db, opts.since.trim()) : null;
        return since ?? listPage(db, scoped);
      });
    },

    async getUnreadCount(): Promise<Outcome<number>> {
      return guard(() => ok(readCounts(db, undefined).unread));
    },

    setInboundRead(id: string, read: boolean): Promise<Outcome<MessageRecord | null>> {
      return flagWrite(id, { is_read: read });
    },

    setInboundStarred(id: string, starred: boolean): Promise<Outcome<MessageRecord | null>> {
      return flagWrite(id, { is_starred: starred });
    },

    setInboundArchived(id: string, archived: boolean): Promise<Outcome<MessageRecord | null>> {
      return flagWrite(id, { archived });
    },

    addInboundLabel(id: string, label: string): Promise<Outcome<MessageRecord | null>> {
      if (!label.trim()) return Promise.resolve(invalidInput("a label is required"));
      return flagWrite(id, { add_label: label });
    },

    removeInboundLabel(id: string, label: string): Promise<Outcome<MessageRecord | null>> {
      if (!label.trim()) return Promise.resolve(invalidInput("a label is required"));
      return flagWrite(id, { remove_label: label });
    },

    async clearInboundEmails(opts?: { domains?: string[] }): Promise<Outcome<number>> {
      return guard(() =>
        withImmediateTransaction(db, () => {
          // Scoped to inbound rows of the unified table. The legacy ledger holds
          // outbound mail only, so "clear the inbound mail" never touches it.
          const { where, params } = messageFilters({ domains: opts?.domains, direction: "inbound" });
          const ids = db
            .query(
              `SELECT m.id FROM ${UNIFIED_MESSAGES_SQL} m ${where}
                ${where ? "AND" : "WHERE"} m.store_table = ?`,
            )
            .all(...params, UNIFIED_TABLE) as Array<{ id: string }>;
          if (ids.length === 0) return ok(0);
          // Chunked, so the statement never depends on how many bound parameters the
          // driver happens to have been built to allow.
          for (let start = 0; start < ids.length; start += DELETE_CHUNK) {
            const chunk = ids.slice(start, start + DELETE_CHUNK);
            db.run(
              `DELETE FROM ${UNIFIED_TABLE} WHERE id IN (${chunk.map(() => "?").join(", ")})`,
              chunk.map((row) => row.id),
            );
          }
          // The count is the number of MESSAGES removed, which is the number of ids
          // matched inside this write transaction — deliberately not the driver's
          // `changes`, which also counts the rows the cascade and the delete trigger
          // remove from `inbound_recipients`, `inbound_labels` and `mail_messages`.
          // Reporting those would tell the caller it deleted twice the mail it did.
          return ok(ids.length);
        }),
      );
    },
  };
}

export function createEmailContentRepository(db: Database, capabilities: StoreCapabilities): EmailContentRepository {
  return {
    async getMessageAttachment(_id: string, _index: number): Promise<Outcome<StoredAttachmentLookup | null>> {
      // This database stores attachment METADATA (filename, content type, size)
      // and, for some inbound rows, a local file path or object URL — never the
      // payload bytes themselves. The capability doc is explicit that metadata
      // alone is not this capability, so the answer is a refusal rather than an
      // empty attachment or a `content_unavailable` that implies bytes existed.
      return unavailable("attachmentContent");
    },

    async listAttachments(opts?: ListAttachmentsOptions): Promise<Outcome<Page<AttachmentInventoryItem>>> {
      if (!capabilities.keysetPagination) return unavailable("keysetPagination");
      const cursor = opts?.cursor ? decodeAttachmentCursor(opts.cursor) : null;
      if (opts?.cursor && !cursor) return invalidInput("the page cursor is malformed");
      return guard(() => {
        const conditions: string[] = [];
        const params: SQLQueryBindings[] = [];
        if (opts?.direction) conditions.push(DIRECTION_PREDICATES[opts.direction]);
        if (opts?.since?.trim()) {
          const refused = unparseableSince(db, opts.since.trim());
          if (refused) return refused;
          conditions.push("julianday(m.sort_ts) >= julianday(?)");
          params.push(opts.since.trim());
        }
        if (cursor) {
          conditions.push(
            "(m.sort_ts < ? OR (m.sort_ts = ? AND m.id < ?) OR (m.sort_ts = ? AND m.id = ? AND att.key > ?))",
          );
          params.push(cursor.ts, cursor.ts, cursor.id, cursor.ts, cursor.id, cursor.idx);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const limit = cappedLimit(opts?.limit, DEFAULT_PAGE, MAX_PAGE);
        const rows = db
          .query(
            `SELECT m.id AS message_id, att.key AS attachment_index, att.value AS element,
                    m.direction AS direction, m.received_at AS received_at, m.sort_ts AS sort_ts
               FROM ${UNIFIED_MESSAGES_SQL} m, json_each(m.attachments_json) att
               ${where}
              ORDER BY m.sort_ts DESC, m.id DESC, att.key ASC
              LIMIT ?`,
          )
          .all(...params, limit) as Array<Record<string, unknown>>;
        const items = rows.map((row) => inventoryItem(row, capabilities));
        const last = rows.length === limit ? rows[rows.length - 1] : undefined;
        const nextCursor = last
          ? encodeAttachmentCursor(
              textValue(last["sort_ts"]),
              textValue(last["message_id"]),
              countValue(last["attachment_index"]),
            )
          : null;
        return ok({ items, next_cursor: nextCursor });
      });
    },

    async listAttachmentsForMessageIds(_ids: string[]): Promise<Outcome<Record<string, AttachmentMeta[]>>> {
      // Gated on `attachmentContent` because the row shape REPORTS per-attachment
      // content availability. Returning a map of metadata with
      // `content_available: false` everywhere would answer a question this store
      // cannot answer, so it refuses instead.
      return unavailable("attachmentContent");
    },
  };
}

function attachmentField(element: unknown, key: string): unknown {
  if (!element || typeof element !== "object" || Array.isArray(element)) return undefined;
  return (element as Record<string, unknown>)[key];
}

function inventoryItem(row: Record<string, unknown>, capabilities: StoreCapabilities): AttachmentInventoryItem {
  let element: unknown = null;
  try {
    element = JSON.parse(textValue(row["element"]));
  } catch {
    element = null;
  }
  const size = attachmentField(element, "size");
  const parsedSize = typeof size === "number" ? size : Number(size);
  return {
    message_id: textValue(row["message_id"]),
    attachment_index: countValue(row["attachment_index"]),
    filename: textOrNullValue(attachmentField(element, "filename")),
    content_type: textOrNullValue(attachmentField(element, "content_type")),
    size_bytes: Number.isFinite(parsedSize) ? parsedSize : null,
    sha256: textOrNullValue(attachmentField(element, "sha256")),
    // DERIVED FROM THE CAPABILITY, not from the row. `content_available` means
    // "a download of these bytes would succeed"; with `attachmentContent` false
    // no download can succeed, so the only true answer is false. Echoing a
    // stored flag here would promise bytes the download path refuses to serve.
    content_available: capabilities.attachmentContent && typeof attachmentField(element, "content_base64") === "string",
    direction: textOrNullValue(row["direction"]),
    received_at: textOrNullValue(row["received_at"]),
  };
}

/** Strip any run of leading `Re:` / `Fwd:` / `Fw:` markers, as the server does. */
function threadKeyFor(subject: string | null): string {
  const stripped = (subject ?? "").toLowerCase().replace(/^(?:\s*(?:re|fwd|fw)\s*:\s*)+/g, "").trim();
  return stripped.length > 0 ? stripped : "(no subject)";
}

export function createThreadsRepository(db: Database, capabilities: StoreCapabilities): ThreadsRepository {
  return {
    async listThreads(opts?: ListOptions): Promise<Outcome<ThreadRollup[]>> {
      if (!capabilities.mailRollups) return unavailable("mailRollups");
      return guard(() => {
        // The subject normalisation is a repeated-prefix strip, which SQLite has
        // no expression for (no regexp_replace), so the grouping happens here over
        // a narrow projection rather than in SQL. The columns read are the same
        // five the server's CTE reads.
        const rows = db
          .query(
            `SELECT m.subject AS subject, m.from_addr AS from_addr, m.is_read AS is_read,
                    m.direction AS direction, m.sort_ts AS sort_ts
               FROM ${UNIFIED_MESSAGES_SQL} m`,
          )
          .all() as Array<Record<string, unknown>>;
        const threads = new Map<string, ThreadRollup & { participants: string[] }>();
        for (const row of rows) {
          const subject = textOrNullValue(row["subject"]);
          const key = threadKeyFor(subject);
          const ts = textOrNullValue(row["sort_ts"]);
          const existing = threads.get(key);
          const outbound = textValue(row["direction"]).toLowerCase() === "outbound";
          const unread = !flagValue(row["is_read"]) && !outbound ? 1 : 0;
          const from = textValue(row["from_addr"]);
          if (!existing) {
            threads.set(key, {
              thread_key: key,
              subject,
              message_count: 1,
              unread_count: unread,
              last_message_at: ts,
              first_message_at: ts,
              participants: from ? [from] : [],
            });
            continue;
          }
          existing.message_count += 1;
          existing.unread_count += unread;
          if (subject !== null && (existing.subject === null || subject > existing.subject)) existing.subject = subject;
          if (ts !== null && (existing.last_message_at === null || ts > existing.last_message_at)) {
            existing.last_message_at = ts;
          }
          if (ts !== null && (existing.first_message_at === null || ts < existing.first_message_at)) {
            existing.first_message_at = ts;
          }
          if (from && !existing.participants.includes(from)) existing.participants.push(from);
        }
        const ordered = [...threads.values()].sort((a, b) =>
          (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""),
        );
        const limit = cappedLimit(opts?.limit, DEFAULT_PAGE, MAX_PAGE);
        const offset = safeOffset(opts?.offset);
        return ok(ordered.slice(offset, offset + limit));
      });
    },

    async listMailboxes(): Promise<Outcome<{ mailboxes: MailboxRollup[]; counts: MessageCountsRecord }>> {
      if (!capabilities.mailRollups) return unavailable("mailRollups");
      return guard(() => {
        // Registered addresses, each with its inbound rollup — the server's shape.
        // The recipient match EXTRACTS the address from each stored `to` entry with
        // the same fragment the local repositories use, so a `Display Name <addr>`
        // recipient counts. A whole-string equality silently counted only the bare
        // form and under-reported the mailbox; the `domains` filter next to it had
        // always parsed, so the file held two matchers that disagreed.
        const rows = db
          .query(
            `SELECT a.id AS id, a.email AS address, a.display_name AS display_name,
                    COALESCE(a.status, 'active') AS status,
                    (SELECT COUNT(*) FROM ${UNIFIED_MESSAGES_SQL} m
                      WHERE lower(COALESCE(m.direction, '')) <> 'outbound'
                        AND EXISTS (
                          SELECT 1 FROM json_each(m.to_addrs_json) recipient
                           WHERE ${sqlEmailAddress("recipient.value")} = lower(TRIM(a.email))
                        )) AS total,
                    (SELECT COUNT(*) FROM ${UNIFIED_MESSAGES_SQL} m
                      WHERE lower(COALESCE(m.direction, '')) <> 'outbound'
                        AND m.is_read = 0
                        AND EXISTS (
                          SELECT 1 FROM json_each(m.to_addrs_json) recipient
                           WHERE ${sqlEmailAddress("recipient.value")} = lower(TRIM(a.email))
                        )) AS unread
               FROM addresses a
              ORDER BY a.email ASC`,
          )
          .all() as Array<Record<string, unknown>>;
        const mailboxes: MailboxRollup[] = rows.map((row) => ({
          id: textValue(row["id"]),
          address: textValue(row["address"]),
          display_name: textOrNullValue(row["display_name"]),
          status: textValue(row["status"]),
          total: countValue(row["total"]),
          unread: countValue(row["unread"]),
        }));
        return ok({ mailboxes, counts: readCounts(db, undefined) });
      });
    },
  };
}
