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
  // Provisioning lifecycle state (mirrors the local domains provisioning
  // columns). Present once migration 0010 has run; optional so older/fake rows
  // still satisfy the type.
  provisioning_status?: string;
  purchase_provider?: string | null;
  dns_provider?: string;
  send_provider?: string | null;
  cf_zone_id?: string | null;
  registrar?: string | null;
  nameservers_json?: string[];
  mail_from_domain?: string | null;
  last_error?: string | null;
  next_check_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** Writable domain provisioning fields (a PATCH may set any subset). */
export interface DomainProvisioningPatch {
  provisioning_status?: string;
  purchase_provider?: string | null;
  dns_provider?: string;
  send_provider?: string | null;
  cf_zone_id?: string | null;
  registrar?: string | null;
  nameservers_json?: string[];
  mail_from_domain?: string | null;
  last_error?: string | null;
  next_check_at?: string | null;
}

export interface AddressRecord {
  id: string;
  email: string;
  domain: string | null;
  display_name: string | null;
  status: string;
  verified: boolean;
  daily_quota: number | null;
  // Provisioning lifecycle state (mirrors the local addresses provisioning
  // columns). Present once migration 0010 has run; optional so older/fake rows
  // still satisfy the type.
  domain_id?: string | null;
  receive_strategy?: string | null;
  forward_to?: string | null;
  routing_rule_id?: string | null;
  provisioning_status?: string;
  last_validated_at?: string | null;
  last_error?: string | null;
  next_check_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** Writable address provisioning fields (a PATCH may set any subset). */
export interface AddressProvisioningPatch {
  domain_id?: string | null;
  receive_strategy?: string | null;
  forward_to?: string | null;
  routing_rule_id?: string | null;
  provisioning_status?: string;
  last_validated_at?: string | null;
  last_error?: string | null;
  next_check_at?: string | null;
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
  since?: string;
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

/** One subject-rolled-up conversation for the threads mail-view. */
export interface ThreadRollup {
  /** Normalized (Re:/Fwd:-stripped, lowercased) subject key that groups the thread. */
  thread_key: string;
  subject: string | null;
  message_count: number;
  unread_count: number;
  last_message_at: string | null;
  first_message_at: string | null;
  participants: string[];
}

/** One mailbox (a registered address) with its inbound folder rollup. */
export interface MailboxRollup {
  id: string;
  address: string;
  display_name: string | null;
  status: string;
  total: number;
  unread: number;
}

/** Reconstructed raw MIME for a stored message. */
export interface MessageRaw {
  raw: string;
  message_id: string | null;
}

/** Assemble a minimal RFC 5322 message from a stored row (no original bytes kept). */
function buildRawMime(rec: MessageRecord): string {
  const h = rec.headers ?? {};
  const lines: string[] = [];
  const push = (name: string, value: unknown) => {
    const v = value === null || value === undefined ? "" : String(value);
    if (v.trim()) lines.push(`${name}: ${v.replace(/[\r\n]+/g, " ")}`);
  };
  push("Date", (h["Date"] as string) ?? rec.received_at ?? rec.created_at);
  push("From", (h["From"] as string) ?? rec.from_addr);
  push("To", (h["To"] as string) ?? rec.to_addrs.join(", "));
  if (rec.cc_addrs.length) push("Cc", (h["Cc"] as string) ?? rec.cc_addrs.join(", "));
  push("Subject", (h["Subject"] as string) ?? rec.subject);
  push("Message-ID", rec.message_id ?? (h["Message-ID"] as string));
  if (rec.in_reply_to) push("In-Reply-To", rec.in_reply_to);
  const isHtml = !rec.body_text && !!rec.body_html;
  push("Content-Type", isHtml ? "text/html; charset=utf-8" : "text/plain; charset=utf-8");
  const body = rec.body_text ?? rec.body_html ?? "";
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
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

  /**
   * Apply a subset of domain provisioning fields (migration 0010 columns). Only
   * keys PRESENT in `patch` are written, so a null is an explicit clear while an
   * absent key is left untouched. `nameservers_json` is a JSONB array.
   */
  async applyDomainProvisioning(id: string, patch: DomainProvisioningPatch): Promise<DomainRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (name: string, value: unknown, jsonb = false) => {
      params.push(jsonb ? JSON.stringify(value ?? null) : value ?? null);
      sets.push(jsonb ? `${name} = $${params.length}::jsonb` : `${name} = $${params.length}`);
    };
    if ("provisioning_status" in patch) set("provisioning_status", patch.provisioning_status);
    if ("purchase_provider" in patch) set("purchase_provider", patch.purchase_provider);
    if ("dns_provider" in patch) set("dns_provider", patch.dns_provider);
    if ("send_provider" in patch) set("send_provider", patch.send_provider);
    if ("cf_zone_id" in patch) set("cf_zone_id", patch.cf_zone_id);
    if ("registrar" in patch) set("registrar", patch.registrar);
    if ("nameservers_json" in patch) set("nameservers_json", patch.nameservers_json ?? [], true);
    if ("mail_from_domain" in patch) set("mail_from_domain", patch.mail_from_domain);
    if ("last_error" in patch) set("last_error", patch.last_error);
    if ("next_check_at" in patch) set("next_check_at", patch.next_check_at);
    if (sets.length === 0) return this.getDomain(id);
    sets.push("updated_at = now()");
    return this.client.get<DomainRecord>(
      `UPDATE domains SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );
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

  /**
   * Apply a subset of address provisioning fields (migration 0010 columns).
   * Only keys PRESENT in `patch` are written (null clears, absent leaves as-is).
   */
  async applyAddressProvisioning(id: string, patch: AddressProvisioningPatch): Promise<AddressRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (name: string, value: unknown) => {
      params.push(value ?? null);
      sets.push(`${name} = $${params.length}`);
    };
    if ("domain_id" in patch) set("domain_id", patch.domain_id);
    if ("receive_strategy" in patch) set("receive_strategy", patch.receive_strategy);
    if ("forward_to" in patch) set("forward_to", patch.forward_to);
    if ("routing_rule_id" in patch) set("routing_rule_id", patch.routing_rule_id);
    if ("provisioning_status" in patch) set("provisioning_status", patch.provisioning_status);
    if ("last_validated_at" in patch) set("last_validated_at", patch.last_validated_at);
    if ("last_error" in patch) set("last_error", patch.last_error);
    if ("next_check_at" in patch) set("next_check_at", patch.next_check_at);
    if (sets.length === 0) return this.getAddress(id);
    sets.push("updated_at = now()");
    return this.client.get<AddressRecord>(
      `UPDATE addresses SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );
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
    if (opts.since?.trim()) {
      params.push(opts.since.trim());
      where.push(`COALESCE(received_at, created_at) >= $${params.length}::timestamptz`);
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
         count(*) FILTER (WHERE NOT is_out AND is_starred AND NOT is_arch AND NOT is_spam AND NOT is_trash) AS starred,
         count(*) FILTER (WHERE NOT is_out AND is_arch AND NOT is_spam AND NOT is_trash) AS archived,
         count(*) FILTER (WHERE NOT is_out AND is_spam) AS spam,
         count(*) FILTER (WHERE NOT is_out AND is_trash) AS trash,
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

  // ---- mail-views (threads / mailboxes / raw) ----------------------------
  //
  // The self-hosted `messages` table is a single unified inbound+outbound
  // ledger, so these are read-only rollups over it (not simple CRUD). Threads
  // are grouped by a normalized (Re:/Fwd:-stripped) subject key — the server
  // keeps no thread_id column.

  /** Subject-rolled-up conversation list, newest activity first. */
  async listThreads(opts: ListOptions = {}): Promise<ThreadRollup[]> {
    const rows = await this.client.many<Record<string, unknown>>(
      `WITH t AS (
         SELECT
           NULLIF(btrim(regexp_replace(lower(COALESCE(subject, '')), '^(\\s*(re|fwd|fw)\\s*:\\s*)+', '', 'g')), '') AS thread_key,
           subject, from_addr, is_read, direction,
           COALESCE(received_at, created_at) AS ts
         FROM messages
       )
       SELECT
         COALESCE(thread_key, '(no subject)') AS thread_key,
         max(subject) AS subject,
         count(*) AS message_count,
         count(*) FILTER (WHERE is_read = false AND lower(COALESCE(direction, '')) <> 'outbound') AS unread_count,
         max(ts) AS last_message_at,
         min(ts) AS first_message_at,
         array_agg(DISTINCT from_addr) AS participants
       FROM t
       GROUP BY COALESCE(thread_key, '(no subject)')
       ORDER BY max(ts) DESC
       LIMIT $1 OFFSET $2`,
      [clampLimit(opts.limit), clampOffset(opts.offset)],
    );
    const num = (v: unknown): number => {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    return rows.map((row) => ({
      thread_key: String(row["thread_key"] ?? ""),
      subject: row["subject"] === null || row["subject"] === undefined ? null : String(row["subject"]),
      message_count: num(row["message_count"]),
      unread_count: num(row["unread_count"]),
      last_message_at: toIso(row["last_message_at"]),
      first_message_at: toIso(row["first_message_at"]),
      participants: toStringArray(row["participants"]),
    }));
  }

  /**
   * Registered addresses as mailboxes, each with an inbound folder rollup, plus
   * the global folder counts. Per-mailbox counts use the same recipient
   * substring match as listMessages' `to` filter (consistent, tolerant of
   * display-name forms).
   */
  async listMailboxes(): Promise<{ mailboxes: MailboxRollup[]; counts: MessageCountsRecord }> {
    const rows = await this.client.many<Record<string, unknown>>(
      `SELECT
         a.id AS id,
         a.email AS address,
         a.display_name AS display_name,
         a.status AS status,
         count(m.id) AS total,
         count(m.id) FILTER (WHERE m.is_read = false) AS unread
       FROM addresses a
       LEFT JOIN messages m
         ON lower(COALESCE(m.direction, '')) <> 'outbound'
        AND lower(m.to_addrs::text) LIKE '%' || lower(a.email) || '%'
       GROUP BY a.id, a.email, a.display_name, a.status
       ORDER BY a.email ASC`,
    );
    const num = (v: unknown): number => {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const mailboxes: MailboxRollup[] = rows.map((row) => ({
      id: String(row["id"] ?? ""),
      address: String(row["address"] ?? ""),
      display_name: row["display_name"] === null || row["display_name"] === undefined ? null : String(row["display_name"]),
      status: String(row["status"] ?? ""),
      total: num(row["total"]),
      unread: num(row["unread"]),
    }));
    const counts = await this.messageCounts();
    return { mailboxes, counts };
  }

  /** Reconstruct a minimal raw MIME representation for a stored message. */
  async getMessageRaw(id: string): Promise<MessageRaw | null> {
    const rec = await this.getMessage(id);
    if (!rec) return null;
    return { raw: buildRawMime(rec), message_id: rec.message_id };
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
    if (col.num) {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    return value ?? null;
  }

  /** Primary-key column for a spec (a server-minted `id` unless overridden). */
  private static keyColumn(spec: SelfHostedResourceSpec): string {
    return spec.idColumn ?? "id";
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
    const key = EmailsSelfHostedStore.keyColumn(spec);
    return this.client.get<Record<string, unknown>>(`SELECT * FROM ${spec.table} WHERE ${key} = $1`, [id]);
  }

  async createResource(spec: SelfHostedResourceSpec, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const key = EmailsSelfHostedStore.keyColumn(spec);
    const cols: string[] = [];
    const placeholders: string[] = [];
    const params: unknown[] = [];
    // A UUID-keyed resource mints its own `id`. A natural-key resource (idColumn
    // set) takes the key value from the body — it is not server-generated.
    if (spec.idColumn === undefined) {
      params.push(randomUUID());
      cols.push("id");
      placeholders.push("$1");
    }
    for (const col of spec.columns) {
      if (!(col.name in body)) continue;
      params.push(EmailsSelfHostedStore.encodeColumn(col, body[col.name]));
      cols.push(col.name);
      placeholders.push(col.json ? `$${params.length}::jsonb` : `$${params.length}`);
    }
    const insertHead = `INSERT INTO ${spec.table} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`;
    // UUID-keyed: a plain insert always returns exactly one row (unchanged path).
    if (spec.idColumn === undefined) {
      return this.client.one<Record<string, unknown>>(`${insertHead} RETURNING *`, params);
    }
    // Natural-key: upsert-on-conflict so create is an idempotent "ensure". DO
    // NOTHING can return zero rows, so read (not one()) and fall back to select.
    const inserted = await this.client.get<Record<string, unknown>>(
      `${insertHead} ON CONFLICT (${key}) DO NOTHING RETURNING *`,
      params,
    );
    if (inserted) return inserted;
    const existing = await this.getResource(spec, String(body[key] ?? ""));
    if (existing) return existing;
    throw new Error(`create on ${spec.path} produced no row`);
  }

  async updateResource(
    spec: SelfHostedResourceSpec,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const key = EmailsSelfHostedStore.keyColumn(spec);
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const col of spec.columns) {
      if (!(col.name in body)) continue;
      if (col.name === key) continue; // never rewrite the primary key
      params.push(EmailsSelfHostedStore.encodeColumn(col, body[col.name]));
      sets.push(col.json ? `${col.name} = $${params.length}::jsonb` : `${col.name} = $${params.length}`);
    }
    if (sets.length === 0) return this.getResource(spec, id);
    sets.push("updated_at = now()");
    return this.client.get<Record<string, unknown>>(
      `UPDATE ${spec.table} SET ${sets.join(", ")} WHERE ${key} = $1 RETURNING *`,
      params,
    );
  }

  async deleteResource(spec: SelfHostedResourceSpec, id: string): Promise<boolean> {
    const key = EmailsSelfHostedStore.keyColumn(spec);
    const rows = await this.client.many<{ id: string }>(
      `DELETE FROM ${spec.table} WHERE ${key} = $1 RETURNING ${key} AS id`,
      [id],
    );
    return rows.length > 0;
  }
}
