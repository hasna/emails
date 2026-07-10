// Postgres repository for the Emails self-hosted service.
//
// Amendment A1 (PURE REMOTE): every method reads/writes the self_hosted Postgres
// directly through the product-owned storage utilities' typed query client. No cache, no
// local mirror.

import { randomUUID } from "node:crypto";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import type { SelfHostedResourceSpec, ResourceColumn } from "./resources.js";

export interface DomainRecord {
  id: string;
  domain: string;
  status: string;
  provider: string | null;
  verified: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface AddressRecord {
  id: string;
  email: string;
  domain: string | null;
  display_name: string | null;
  status: string;
  verified: boolean;
  daily_quota: number | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  direction: string;
  from_addr: string;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  status: string;
  provider_message_id: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  received_at: string | null;
  is_read: boolean;
  is_starred: boolean;
  labels: string[];
  headers: Record<string, unknown>;
  attachments: unknown[];
  source_id: string | null;
  idempotency_key: string | null;
  send_payload_hash: string | null;
  send_state: string;
  send_started_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Fields a caller may supply when writing a message (outbound or inbound). */
export interface MessageInput {
  from_addr: string;
  to_addrs: string[];
  cc_addrs?: string[];
  subject?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  status?: string;
  provider_message_id?: string | null;
  direction?: string;
  message_id?: string | null;
  in_reply_to?: string | null;
  received_at?: string | null;
  is_read?: boolean;
  is_starred?: boolean;
  labels?: string[];
  headers?: Record<string, unknown>;
  attachments?: unknown[];
  /** Stable upstream id; when set, writes upsert on it (idempotent re-runs). */
  source_id?: string | null;
  idempotency_key?: string | null;
  send_payload_hash?: string | null;
  send_state?: string;
  send_started_at?: string | null;
}

/** Columns selected for a message row (explicit so new columns are intentional). */
const MESSAGE_COLUMNS =
  "id, direction, from_addr, to_addrs, cc_addrs, subject, body_text, body_html, status, " +
  "provider_message_id, message_id, in_reply_to, received_at, is_read, is_starred, labels, " +
  "headers, attachments, source_id, idempotency_key, send_payload_hash, send_state, send_started_at, " +
  "created_at, updated_at";

export class IdempotencyKeyConflictError extends Error {
  constructor() {
    super("idempotency key was already used for a different send payload");
    this.name = "IdempotencyKeyConflictError";
  }
}

export interface ListOptions {
  limit?: number;
  offset?: number;
}

export interface ListMessagesOptions extends ListOptions {
  direction?: "inbound" | "outbound";
  to?: string;
}

export interface MessageCountsRecord {
  inbox: number;
  unread: number;
  starred: number;
  sent: number;
  archived: number;
  spam: number;
  trash: number;
  total: number;
  latest_received_at: string | null;
}

export interface StoredAttachment {
  filename: string;
  content_type: string;
  size: number;
  content_base64: string;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) return 100;
  return Math.min(Math.max(1, Math.floor(limit)), 500);
}

function clampOffset(offset: number | undefined): number {
  if (!offset || Number.isNaN(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

/** Normalize a possibly-string JSONB column into a string[]. */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
    } catch {
      return value.trim() ? [value.trim()] : [];
    }
  }
  return [];
}

/** Normalize a possibly-string JSONB array column into a plain array. */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Normalize a possibly-string JSONB object column into a plain object. */
function toObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Normalize a TIMESTAMPTZ column (Date or string from the driver) to ISO 8601. */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/** Coerce a raw DB row into a fully-typed MessageRecord (JSONB columns parsed). */
function mapMessageRow(row: Record<string, unknown>): MessageRecord {
  const attachments = toArray(row["attachments"]).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const { content_base64: _content, ...metadata } = item as Record<string, unknown>;
    return metadata;
  });
  return {
    ...(row as unknown as MessageRecord),
    to_addrs: toStringArray(row["to_addrs"]),
    cc_addrs: toStringArray(row["cc_addrs"]),
    labels: toStringArray(row["labels"]),
    attachments,
    headers: toObject(row["headers"]),
    is_read: Boolean(row["is_read"]),
    is_starred: Boolean(row["is_starred"]),
    received_at: toIso(row["received_at"]),
    send_started_at: toIso(row["send_started_at"]),
    created_at: toIso(row["created_at"]) ?? "",
    updated_at: toIso(row["updated_at"]) ?? "",
  };
}

export class EmailsSelfHostedStore {
  constructor(private readonly client: TypedQueryClient) {}

  // ---- domains ------------------------------------------------------------
  async listDomains(opts: ListOptions = {}): Promise<DomainRecord[]> {
    return this.client.many<DomainRecord>(
      `SELECT * FROM domains ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [clampLimit(opts.limit), clampOffset(opts.offset)],
    );
  }

  async getDomain(id: string): Promise<DomainRecord | null> {
    return this.client.get<DomainRecord>(`SELECT * FROM domains WHERE id = $1`, [id]);
  }

  async getDomainByName(domain: string): Promise<DomainRecord | null> {
    return this.client.get<DomainRecord>(`SELECT * FROM domains WHERE domain = $1`, [
      domain.trim().toLowerCase(),
    ]);
  }

  async createDomain(input: {
    domain: string;
    status?: string;
    provider?: string | null;
    verified?: boolean;
    notes?: string | null;
  }): Promise<DomainRecord> {
    const id = randomUUID();
    return this.client.one<DomainRecord>(
      `INSERT INTO domains (id, domain, status, provider, verified, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        id,
        input.domain.trim().toLowerCase(),
        input.status ?? "pending",
        input.provider ?? null,
        input.verified ?? false,
        input.notes ?? null,
      ],
    );
  }

  async updateDomain(
    id: string,
    patch: { status?: string; provider?: string | null; verified?: boolean; notes?: string | null },
  ): Promise<DomainRecord | null> {
    return this.client.get<DomainRecord>(
      `UPDATE domains SET
         status   = COALESCE($2, status),
         provider = COALESCE($3, provider),
         verified = COALESCE($4, verified),
         notes    = COALESCE($5, notes),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.status ?? null,
        patch.provider ?? null,
        patch.verified ?? null,
        patch.notes ?? null,
      ],
    );
  }

  async deleteDomain(id: string): Promise<boolean> {
    const rows = await this.client.many<{ id: string }>(
      `DELETE FROM domains WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  // ---- addresses ----------------------------------------------------------
  async listAddresses(opts: ListOptions = {}): Promise<AddressRecord[]> {
    return this.client.many<AddressRecord>(
      `SELECT * FROM addresses ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [clampLimit(opts.limit), clampOffset(opts.offset)],
    );
  }

  async getAddress(id: string): Promise<AddressRecord | null> {
    return this.client.get<AddressRecord>(`SELECT * FROM addresses WHERE id = $1`, [id]);
  }

  async createAddress(input: {
    email: string;
    display_name?: string | null;
    status?: string;
    verified?: boolean;
    daily_quota?: number | null;
  }): Promise<AddressRecord> {
    const id = randomUUID();
    const email = input.email.trim().toLowerCase();
    const domain = email.includes("@") ? email.slice(email.indexOf("@") + 1) : null;
    return this.client.one<AddressRecord>(
      `INSERT INTO addresses (id, email, domain, display_name, status, verified, daily_quota)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [id, email, domain, input.display_name ?? null, input.status ?? "active", input.verified ?? false, input.daily_quota ?? null],
    );
  }

  async updateAddress(
    id: string,
    // `dailyQuotaSet` distinguishes "not provided" (keep existing) from an
    // explicit clear (`daily_quota: null`, the CLI's `quota <id> none`). COALESCE
    // alone cannot clear a column to NULL, so quota uses a CASE gated on the flag.
    patch: {
      display_name?: string | null;
      status?: string;
      verified?: boolean;
      dailyQuotaSet?: boolean;
      daily_quota?: number | null;
    },
  ): Promise<AddressRecord | null> {
    return this.client.get<AddressRecord>(
      `UPDATE addresses SET
         display_name = COALESCE($2, display_name),
         status       = COALESCE($3, status),
         verified     = COALESCE($4, verified),
         daily_quota  = CASE WHEN $5 THEN $6 ELSE daily_quota END,
         updated_at   = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.display_name ?? null,
        patch.status ?? null,
        patch.verified ?? null,
        patch.dailyQuotaSet ?? false,
        patch.dailyQuotaSet ? patch.daily_quota ?? null : null,
      ],
    );
  }

  async deleteAddress(id: string): Promise<boolean> {
    const rows = await this.client.many<{ id: string }>(
      `DELETE FROM addresses WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  // ---- messages (outbound ledger + inbound mail) -------------------------
  //
  // Ordering is by original receipt time when known, else insertion time, so an
  // imported inbox reads in true chronological order rather than import order.
  async listMessages(opts: ListMessagesOptions = {}): Promise<MessageRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.direction === "inbound") where.push(`lower(COALESCE(direction, '')) <> 'outbound'`);
    if (opts.direction === "outbound") where.push(`lower(COALESCE(direction, '')) = 'outbound'`);
    if (opts.to?.trim()) {
      params.push(`%${opts.to.trim().toLowerCase()}%`);
      where.push(`lower(to_addrs::text) LIKE $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(clampLimit(opts.limit));
    const limitIndex = params.length;
    params.push(clampOffset(opts.offset));
    const offsetIndex = params.length;
    const rows = await this.client.many<Record<string, unknown>>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages ${whereSql}
       ORDER BY COALESCE(received_at, created_at) DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params,
    );
    return rows.map(mapMessageRow);
  }

  async messageCounts(): Promise<MessageCountsRecord> {
    const row = await this.client.get<Record<string, unknown>>(
      `WITH m AS (
         SELECT
           (lower(COALESCE(direction, '')) = 'outbound') AS is_out,
           (labels @> '["archived"]'::jsonb) AS is_arch,
           (labels @> '["spam"]'::jsonb OR lower(COALESCE(status, '')) = 'spam') AS is_spam,
           (labels @> '["trash"]'::jsonb) AS is_trash,
           is_read, is_starred, COALESCE(received_at, created_at) AS ts
         FROM messages
       )
       SELECT
         count(*) FILTER (WHERE is_out) AS sent,
         count(*) FILTER (WHERE NOT is_out AND NOT is_arch AND NOT is_spam AND NOT is_trash) AS inbox,
         count(*) FILTER (WHERE NOT is_out AND NOT is_arch AND NOT is_spam AND NOT is_trash AND NOT is_read) AS unread,
         count(*) FILTER (WHERE is_starred AND NOT is_trash) AS starred,
         count(*) FILTER (WHERE is_arch) AS archived,
         count(*) FILTER (WHERE is_spam) AS spam,
         count(*) FILTER (WHERE is_trash) AS trash,
         count(*) AS total,
         max(ts) FILTER (WHERE NOT is_out) AS latest_received_at
       FROM m`,
    );
    const number = (value: unknown): number => {
      const parsed = typeof value === "number" ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const latest = row?.["latest_received_at"];
    return {
      inbox: number(row?.["inbox"]), unread: number(row?.["unread"]), starred: number(row?.["starred"]),
      sent: number(row?.["sent"]), archived: number(row?.["archived"]), spam: number(row?.["spam"]),
      trash: number(row?.["trash"]), total: number(row?.["total"]),
      latest_received_at: latest instanceof Date ? latest.toISOString() : latest ? String(latest) : null,
    };
  }

  async getMessage(id: string): Promise<MessageRecord | null> {
    const row = await this.client.get<Record<string, unknown>>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = $1`,
      [id],
    );
    return row ? mapMessageRow(row) : null;
  }

  async getMessageAttachment(id: string, index: number): Promise<StoredAttachment | null> {
    if (!Number.isInteger(index) || index < 0) return null;
    const row = await this.client.get<{ attachment: unknown }>(
      `SELECT attachments -> $2::int AS attachment FROM messages WHERE id = $1`,
      [id, index],
    );
    const value = row?.attachment;
    let attachment: unknown;
    try { attachment = typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return null;
    const record = attachment as Record<string, unknown>;
    if (typeof record["content_base64"] !== "string") return null;
    return {
      filename: String(record["filename"] ?? `attachment-${index + 1}`),
      content_type: String(record["content_type"] ?? "application/octet-stream"),
      size: Number(record["size"] ?? 0) || 0,
      content_base64: record["content_base64"],
    };
  }

  /**
   * Look up an existing message by a stable upstream key, matching EITHER the
   * `source_id` (this ingest path's idempotency key) OR the `message_id`
   * (the S3 object key stored by the history backfill). Returns the row id, or
   * null. Used by the ingest worker to avoid re-inserting mail already present
   * from the local→self_hosted history import, whose rows carry the same object key
   * in `message_id` but a different `source_id`.
   */
  async findMessageIdByKey(key: string): Promise<string | null> {
    if (!key) return null;
    const row = await this.client.get<{ id: string }>(
      `SELECT id FROM messages WHERE source_id = $1 OR message_id = $1 LIMIT 1`,
      [key],
    );
    return row ? row.id : null;
  }

  /** Positional insert params shared by createMessage and upsertMessage. */
  private messageInsertParams(input: MessageInput): unknown[] {
    return [
      randomUUID(),
      (input.direction ?? "outbound").trim() || "outbound",
      input.from_addr.trim(),
      JSON.stringify(input.to_addrs ?? []),
      JSON.stringify(input.cc_addrs ?? []),
      input.subject ?? null,
      input.body_text ?? null,
      input.body_html ?? null,
      input.status ?? "queued",
      input.provider_message_id ?? null,
      input.message_id ?? null,
      input.in_reply_to ?? null,
      input.received_at ?? null,
      input.is_read ?? false,
      input.is_starred ?? false,
      JSON.stringify(input.labels ?? []),
      JSON.stringify(input.headers ?? {}),
      JSON.stringify(input.attachments ?? []),
      input.source_id ?? null,
      input.idempotency_key ?? null,
      input.send_payload_hash ?? null,
      input.send_state ?? "none",
      input.send_started_at ?? null,
    ];
  }

  private static readonly INSERT_COLS =
    "id, direction, from_addr, to_addrs, cc_addrs, subject, body_text, body_html, status, " +
    "provider_message_id, message_id, in_reply_to, received_at, is_read, is_starred, labels, " +
    "headers, attachments, source_id, idempotency_key, send_payload_hash, send_state, send_started_at";

  private static readonly INSERT_VALUES =
    "$1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, " +
    "$16::jsonb, $17::jsonb, $18::jsonb, $19, $20, $21, $22, $23";

  async createMessage(input: MessageInput): Promise<MessageRecord> {
    const row = await this.client.one<Record<string, unknown>>(
      `INSERT INTO messages (${EmailsSelfHostedStore.INSERT_COLS})
       VALUES (${EmailsSelfHostedStore.INSERT_VALUES})
       RETURNING ${MESSAGE_COLUMNS}`,
      this.messageInsertParams(input),
    );
    return mapMessageRow(row);
  }

  /** Persist a unique outbound intent before any provider side effect. */
  async reserveSendIntent(
    input: MessageInput & { idempotency_key: string; send_payload_hash: string },
  ): Promise<{ record: MessageRecord; created: boolean }> {
    const inserted = await this.client.get<Record<string, unknown>>(
      `INSERT INTO messages (${EmailsSelfHostedStore.INSERT_COLS})
       VALUES (${EmailsSelfHostedStore.INSERT_VALUES})
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING ${MESSAGE_COLUMNS}`,
      this.messageInsertParams({ ...input, direction: "outbound", status: "queued", send_state: "pending" }),
    );
    if (inserted) return { record: mapMessageRow(inserted), created: true };
    const existing = await this.client.get<Record<string, unknown>>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE idempotency_key = $1`,
      [input.idempotency_key],
    );
    if (!existing) throw new Error("send intent conflict could not be reconciled");
    const record = mapMessageRow(existing);
    if (record.send_payload_hash !== input.send_payload_hash) throw new IdempotencyKeyConflictError();
    return { record, created: false };
  }

  async claimSendIntent(id: string): Promise<MessageRecord | null> {
    const row = await this.client.get<Record<string, unknown>>(
      `UPDATE messages SET send_state = 'sending', send_started_at = now(), updated_at = now()
       WHERE id = $1 AND send_state = 'pending'
       RETURNING ${MESSAGE_COLUMNS}`,
      [id],
    );
    return row ? mapMessageRow(row) : null;
  }

  async completeSendIntent(id: string, providerMessageId: string): Promise<MessageRecord> {
    const row = await this.client.get<Record<string, unknown>>(
      `UPDATE messages SET send_state = 'sent', status = 'sent', provider_message_id = $2, updated_at = now()
       WHERE id = $1 RETURNING ${MESSAGE_COLUMNS}`,
      [id, providerMessageId],
    );
    if (!row) throw new Error("send intent disappeared during completion");
    return mapMessageRow(row);
  }

  async markSendUncertain(id: string): Promise<MessageRecord | null> {
    const row = await this.client.get<Record<string, unknown>>(
      `UPDATE messages SET send_state = 'uncertain', status = 'uncertain', updated_at = now()
       WHERE id = $1 AND send_state <> 'sent'
       RETURNING ${MESSAGE_COLUMNS}`,
      [id],
    );
    return row ? mapMessageRow(row) : null;
  }

  /**
   * Idempotent write keyed on `source_id`: inserts a new row, or updates the
   * existing row with the same source_id (so re-running an import never
   * duplicates). Requires `source_id`. Returns whether a new row was inserted
   * (Postgres `xmax = 0` distinguishes insert from update in an upsert).
   */
  async upsertMessage(input: MessageInput): Promise<{ record: MessageRecord; inserted: boolean }> {
    if (!input.source_id) {
      throw new Error("upsertMessage requires a source_id");
    }
    const row = await this.client.one<Record<string, unknown>>(
      `INSERT INTO messages (${EmailsSelfHostedStore.INSERT_COLS})
       VALUES (${EmailsSelfHostedStore.INSERT_VALUES})
       ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO UPDATE SET
         direction           = EXCLUDED.direction,
         from_addr           = EXCLUDED.from_addr,
         to_addrs            = EXCLUDED.to_addrs,
         cc_addrs            = EXCLUDED.cc_addrs,
         subject             = EXCLUDED.subject,
         body_text           = EXCLUDED.body_text,
         body_html           = EXCLUDED.body_html,
         status              = EXCLUDED.status,
         provider_message_id = EXCLUDED.provider_message_id,
         message_id          = EXCLUDED.message_id,
         in_reply_to         = EXCLUDED.in_reply_to,
         received_at         = EXCLUDED.received_at,
         is_read             = EXCLUDED.is_read,
         is_starred          = EXCLUDED.is_starred,
         labels              = EXCLUDED.labels,
         headers             = EXCLUDED.headers,
         attachments         = EXCLUDED.attachments,
         updated_at          = now()
       RETURNING ${MESSAGE_COLUMNS}, (xmax = 0) AS inserted`,
      this.messageInsertParams(input),
    );
    const inserted = Boolean(row["inserted"]);
    return { record: mapMessageRow(row), inserted };
  }

  async updateMessageStatus(
    id: string,
    patch: {
      status?: string;
      provider_message_id?: string | null;
      is_read?: boolean;
      is_starred?: boolean;
      archived?: boolean;
      add_label?: string;
      remove_label?: string;
    },
  ): Promise<MessageRecord | null> {
    const current = await this.getMessage(id);
    if (!current) return null;
    const labels = new Map(current.labels.map((label) => [label.toLowerCase(), label]));
    if (patch.archived === true) labels.set("archived", "archived");
    if (patch.archived === false) labels.delete("archived");
    if (patch.add_label?.trim()) labels.set(patch.add_label.trim().toLowerCase(), patch.add_label.trim());
    if (patch.remove_label?.trim()) labels.delete(patch.remove_label.trim().toLowerCase());
    const row = await this.client.get<Record<string, unknown>>(
      `UPDATE messages SET
         status              = COALESCE($2, status),
         provider_message_id = COALESCE($3, provider_message_id),
         is_read             = COALESCE($4, is_read),
         is_starred          = COALESCE($5, is_starred),
         labels              = $6::jsonb,
         updated_at          = now()
       WHERE id = $1
       RETURNING ${MESSAGE_COLUMNS}`,
      [
        id,
        patch.status ?? null,
        patch.provider_message_id ?? null,
        patch.is_read ?? null,
        patch.is_starred ?? null,
        JSON.stringify([...labels.values()]),
      ],
    );
    return row ? mapMessageRow(row) : null;
  }

  async deleteMessage(id: string): Promise<boolean> {
    const rows = await this.client.many<{ id: string }>(
      `DELETE FROM messages WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  // ---- generic resources (contacts/providers/templates/groups/…) ----------
  //
  // Table + column names come from the trusted SELF_HOSTED_RESOURCES registry (never
  // user input); all VALUES are bound parameters. JSONB columns are cast so
  // arrays/objects round-trip; the returned rows keep JSONB as parsed values.

  /** Coerce/encode a request value for a column per its declared kind. */
  private static encodeColumn(col: ResourceColumn, value: unknown): unknown {
    if (value === undefined) return null;
    if (col.json) return JSON.stringify(value ?? null);
    if (col.bool) return Boolean(value);
    if (col.int) {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : 0;
    }
    return value ?? null;
  }

  async listResource(
    spec: SelfHostedResourceSpec,
    opts: ListOptions & { filters?: Record<string, unknown> } = {},
  ): Promise<Record<string, unknown>[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    for (const key of spec.filters ?? []) {
      const raw = opts.filters?.[key];
      if (raw === undefined) continue;
      const col = spec.columns.find((c) => c.name === key);
      params.push(EmailsSelfHostedStore.encodeColumn(col ?? { name: key }, raw));
      where.push(`${key} = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(clampLimit(opts.limit), clampOffset(opts.offset));
    return this.client.many<Record<string, unknown>>(
      `SELECT * FROM ${spec.table} ${whereSql} ORDER BY ${spec.orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
  }

  async getResource(spec: SelfHostedResourceSpec, id: string): Promise<Record<string, unknown> | null> {
    return this.client.get<Record<string, unknown>>(`SELECT * FROM ${spec.table} WHERE id = $1`, [id]);
  }

  async createResource(spec: SelfHostedResourceSpec, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cols = ["id"];
    const placeholders = ["$1"];
    const params: unknown[] = [randomUUID()];
    for (const col of spec.columns) {
      if (!(col.name in body)) continue;
      params.push(EmailsSelfHostedStore.encodeColumn(col, body[col.name]));
      cols.push(col.name);
      placeholders.push(col.json ? `$${params.length}::jsonb` : `$${params.length}`);
    }
    return this.client.one<Record<string, unknown>>(
      `INSERT INTO ${spec.table} (${cols.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
      params,
    );
  }

  async updateResource(
    spec: SelfHostedResourceSpec,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const col of spec.columns) {
      if (!(col.name in body)) continue;
      params.push(EmailsSelfHostedStore.encodeColumn(col, body[col.name]));
      sets.push(col.json ? `${col.name} = $${params.length}::jsonb` : `${col.name} = $${params.length}`);
    }
    if (sets.length === 0) return this.getResource(spec, id);
    sets.push("updated_at = now()");
    return this.client.get<Record<string, unknown>>(
      `UPDATE ${spec.table} SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );
  }

  async deleteResource(spec: SelfHostedResourceSpec, id: string): Promise<boolean> {
    const rows = await this.client.many<{ id: string }>(
      `DELETE FROM ${spec.table} WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }
}
