// Postgres repository for the Mailery self_hosted cloud service.
//
// Amendment A1 (PURE REMOTE): every method reads/writes the cloud Postgres
// directly through the vendored storage kit's typed query client. No cache, no
// local mirror.

import { randomUUID } from "node:crypto";
import type { TypedQueryClient } from "../../generated/storage-kit/index.js";

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
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  from_addr: string;
  to_addrs: string[];
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  status: string;
  provider_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
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

export class MaileryCloudStore {
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
  }): Promise<AddressRecord> {
    const id = randomUUID();
    const email = input.email.trim().toLowerCase();
    const domain = email.includes("@") ? email.slice(email.indexOf("@") + 1) : null;
    return this.client.one<AddressRecord>(
      `INSERT INTO addresses (id, email, domain, display_name, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, email, domain, input.display_name ?? null, input.status ?? "active"],
    );
  }

  async updateAddress(
    id: string,
    patch: { display_name?: string | null; status?: string },
  ): Promise<AddressRecord | null> {
    return this.client.get<AddressRecord>(
      `UPDATE addresses SET
         display_name = COALESCE($2, display_name),
         status       = COALESCE($3, status),
         updated_at   = now()
       WHERE id = $1
       RETURNING *`,
      [id, patch.display_name ?? null, patch.status ?? null],
    );
  }

  async deleteAddress(id: string): Promise<boolean> {
    const rows = await this.client.many<{ id: string }>(
      `DELETE FROM addresses WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  // ---- messages (outbound ledger) ----------------------------------------
  async listMessages(opts: ListOptions = {}): Promise<MessageRecord[]> {
    const rows = await this.client.many<MessageRecord>(
      `SELECT * FROM messages ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [clampLimit(opts.limit), clampOffset(opts.offset)],
    );
    return rows.map((r) => ({ ...r, to_addrs: toStringArray(r.to_addrs) }));
  }

  async getMessage(id: string): Promise<MessageRecord | null> {
    const row = await this.client.get<MessageRecord>(`SELECT * FROM messages WHERE id = $1`, [id]);
    return row ? { ...row, to_addrs: toStringArray(row.to_addrs) } : null;
  }

  async createMessage(input: {
    from_addr: string;
    to_addrs: string[];
    subject?: string | null;
    body_text?: string | null;
    body_html?: string | null;
    status?: string;
    provider_message_id?: string | null;
  }): Promise<MessageRecord> {
    const id = randomUUID();
    const row = await this.client.one<MessageRecord>(
      `INSERT INTO messages (id, from_addr, to_addrs, subject, body_text, body_html, status, provider_message_id)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        input.from_addr.trim(),
        JSON.stringify(input.to_addrs ?? []),
        input.subject ?? null,
        input.body_text ?? null,
        input.body_html ?? null,
        input.status ?? "queued",
        input.provider_message_id ?? null,
      ],
    );
    return { ...row, to_addrs: toStringArray(row.to_addrs) };
  }

  async updateMessageStatus(
    id: string,
    patch: { status?: string; provider_message_id?: string | null },
  ): Promise<MessageRecord | null> {
    const row = await this.client.get<MessageRecord>(
      `UPDATE messages SET
         status              = COALESCE($2, status),
         provider_message_id = COALESCE($3, provider_message_id),
         updated_at          = now()
       WHERE id = $1
       RETURNING *`,
      [id, patch.status ?? null, patch.provider_message_id ?? null],
    );
    return row ? { ...row, to_addrs: toStringArray(row.to_addrs) } : null;
  }

  async deleteMessage(id: string): Promise<boolean> {
    const rows = await this.client.many<{ id: string }>(
      `DELETE FROM messages WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }
}
