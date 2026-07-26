import type { Database } from "./database.js";
import { getDatabase, uuid, now } from "./database.js";
import { canonicalSender } from "../lib/email-address.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import {
  selfHostedResource,
  selfHostedListQuery,
  selfHostedPage,
  cbool,
  cnum,
  ciso,
  cstr,
  cstrOrNull,
} from "./self-hosted-resource.local.js";

const CONTACT_RESOURCE = "contacts";

export interface Contact {
  id: string;
  email: string;
  name: string | null;
  send_count: number;
  bounce_count: number;
  complaint_count: number;
  last_sent_at: string | null;
  suppressed: boolean;
  created_at: string;
  updated_at: string;
}

/** Map a selfHosted API contact entity to the local Contact shape. */
function apiToContact(e: Record<string, unknown>): Contact {
  const updatedAt = ciso(e["updated_at"]);
  return {
    id: cstr(e["id"]),
    email: cstr(e["email"]),
    name: cstrOrNull(e["name"]),
    send_count: cnum(e["send_count"]),
    bounce_count: cnum(e["bounce_count"]),
    complaint_count: cnum(e["complaint_count"]),
    last_sent_at: cstrOrNull(e["last_sent_at"]),
    suppressed: cbool(e["suppressed"]),
    created_at: ciso(e["created_at"], updatedAt),
    updated_at: updatedAt,
  };
}

interface ContactRow {
  id: string;
  email: string;
  name: string | null;
  send_count: number;
  bounce_count: number;
  complaint_count: number;
  last_sent_at: string | null;
  suppressed: number;
  created_at: string;
  updated_at: string;
}

const CONTACT_READ_CHUNK_SIZE = 500;
const CONTACT_WRITE_CHUNK_SIZE = 200;
type ContactCountColumn = "send_count" | "bounce_count" | "complaint_count";

function rowToContact(row: ContactRow): Contact {
  return {
    ...row,
    suppressed: !!row.suppressed,
  };
}

/**
 * Find a single selfHosted contact by exact email. Passes an `email` filter (honored
 * server-side once the additive contacts filter is deployed) and also filters
 * in-memory so it stays correct against an older server that ignores unknown
 * query params.
 */
function findSelfHostedContactByEmail(selfHosted: NonNullable<ReturnType<typeof selfHostedResource>>, email: string): Contact | null {
  const rows = selfHosted.list({ email, limit: 500 }).map(apiToContact);
  // Canonical comparison: the server stores whatever spelling it was given, and
  // an exact match would miss a mixed-case or display-name form (which for a
  // SUPPRESSION lookup means silently permitting the send).
  const wanted = canonicalSender(email) ?? email.trim().toLowerCase();
  return rows.find((c) => c.email === email)
    ?? rows.find((c) => (canonicalSender(c.email) ?? c.email.trim().toLowerCase()) === wanted)
    ?? null;
}

export function upsertContact(email: string, db?: Database): Contact {
  // Self-hosted mode: find-or-create against the /v1/contacts API so a flipped client
  // no longer writes contacts to the local SQLite island while `contact list`
  // reads the selfHosted (the split-brain bug).
  const selfHosted = selfHostedResource(CONTACT_RESOURCE);
  if (selfHosted) {
    const existing = findSelfHostedContactByEmail(selfHosted, email);
    if (existing) return existing;
    return apiToContact(selfHosted.create({
      email,
      name: null,
      send_count: 0,
      bounce_count: 0,
      complaint_count: 0,
      last_sent_at: null,
      suppressed: false,
    }));
  }

  const d = db || getDatabase();
  const existing = d.query("SELECT * FROM contacts WHERE email = ?").get(email) as ContactRow | null;
  if (existing) return rowToContact(existing);

  const id = uuid();
  const timestamp = now();
  d.run(
    `INSERT INTO contacts (id, email, name, send_count, bounce_count, complaint_count, last_sent_at, suppressed, created_at, updated_at)
     VALUES (?, ?, NULL, 0, 0, 0, NULL, 0, ?, ?)`,
    [id, email, timestamp, timestamp],
  );

  return getContact(email, d)!;
}

export function getContact(email: string, db?: Database): Contact | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM contacts WHERE email = ?").get(email) as ContactRow | null;
  if (!row) return null;
  return rowToContact(row);
}

export interface ListContactOptions {
  suppressed?: boolean;
  limit?: number;
  offset?: number;
}

export function listContacts(opts?: ListContactOptions, db?: Database): Contact[] {
  const selfHosted = selfHostedResource(CONTACT_RESOURCE);
  if (selfHosted) {
    const { query, limit, offset } = selfHostedListQuery(opts);
    if (opts?.suppressed !== undefined) query["suppressed"] = opts.suppressed;
    let rows = selfHosted.list(query).map(apiToContact);
    if (opts?.suppressed !== undefined) rows = rows.filter((c) => c.suppressed === opts.suppressed);
    rows.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    return selfHostedPage(rows, limit, offset);
  }

  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: Array<number> = [];
  if (opts?.suppressed !== undefined) {
    conditions.push("suppressed = ?");
    params.push(opts.suppressed ? 1 : 0);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  if (limit !== null) {
    params.push(limit, offset);
  }
  const rows = d
    .query(`SELECT * FROM contacts${where} ORDER BY updated_at DESC${limit !== null ? " LIMIT ? OFFSET ?" : ""}`)
    .all(...params) as ContactRow[];
  return rows.map(rowToContact);
}

function setSelfHostedContactSuppressed(selfHosted: NonNullable<ReturnType<typeof selfHostedResource>>, email: string, suppressed: boolean): void {
  const existing = findSelfHostedContactByEmail(selfHosted, email) ?? upsertContact(email);
  selfHosted.update(existing.id, { suppressed });
}

export function suppressContact(email: string, db?: Database): void {
  const selfHosted = selfHostedResource(CONTACT_RESOURCE);
  if (selfHosted) return setSelfHostedContactSuppressed(selfHosted, email, true);
  const d = db || getDatabase();
  upsertContact(email, d);
  d.run("UPDATE contacts SET suppressed = 1, updated_at = ? WHERE email = ?", [now(), email]);
}

export function unsuppressContact(email: string, db?: Database): void {
  const selfHosted = selfHostedResource(CONTACT_RESOURCE);
  if (selfHosted) return setSelfHostedContactSuppressed(selfHosted, email, false);
  const d = db || getDatabase();
  upsertContact(email, d);
  d.run("UPDATE contacts SET suppressed = 0, updated_at = ? WHERE email = ?", [now(), email]);
}

export function incrementSendCount(email: string, db?: Database): void {
  incrementSendCounts([email], db);
}

export function incrementSendCounts(emails: Iterable<string>, db?: Database): void {
  incrementContactCounts(emails, "send_count", { updateLastSentAt: true }, db);
}

function incrementContactCounts(
  emails: Iterable<string>,
  column: ContactCountColumn,
  opts: { updateLastSentAt?: boolean; autoSuppressBounces?: boolean } = {},
  db?: Database,
): void {
  const counts = new Map<string, number>();
  for (const email of emails) {
    counts.set(email, (counts.get(email) ?? 0) + 1);
  }
  if (counts.size === 0) return;

  const selfHosted = selfHostedResource(CONTACT_RESOURCE);
  if (selfHosted) {
    // In self-hosted mode the service is authoritative for message sends and
    // derived contact counters. The client must not mirror send-count writes
    // into the local SQLite island.
    return;
  }

  const d = db || getDatabase();
  const timestamp = now();
  const entries = Array.from(counts.entries());

  for (let i = 0; i < entries.length; i += CONTACT_WRITE_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CONTACT_WRITE_CHUNK_SIZE);
    const valuesSql = chunk.map(() => "(?, ?, NULL, 0, 0, 0, NULL, 0, ?, ?)").join(", ");
    const insertParams: string[] = [];
    for (const [email] of chunk) {
      insertParams.push(uuid(), email, timestamp, timestamp);
    }

    d.run(
      `INSERT INTO contacts (id, email, name, send_count, bounce_count, complaint_count, last_sent_at, suppressed, created_at, updated_at)
       VALUES ${valuesSql}
       ON CONFLICT(email) DO NOTHING`,
      insertParams,
    );

    const caseSql = chunk.map(() => "WHEN ? THEN ?").join(" ");
    const placeholders = chunk.map(() => "?").join(", ");
    const updateParams: Array<string | number> = [];
    for (const [email, count] of chunk) {
      updateParams.push(email, count);
    }
    if (opts.updateLastSentAt) {
      updateParams.push(timestamp);
    }
    updateParams.push(timestamp);
    for (const [email] of chunk) {
      updateParams.push(email);
    }

    d.run(
      `UPDATE contacts
          SET ${column} = ${column} + CASE email ${caseSql} ELSE 0 END,
              ${opts.updateLastSentAt ? "last_sent_at = ?," : ""}
              updated_at = ?
        WHERE email IN (${placeholders})`,
      updateParams,
    );

    if (opts.autoSuppressBounces) {
      d.run(
        `UPDATE contacts
            SET suppressed = 1,
                updated_at = ?
          WHERE bounce_count >= 3
            AND email IN (${placeholders})`,
        [timestamp, ...chunk.map(([email]) => email)],
      );
    }
  }
}

export function incrementBounceCount(email: string, db?: Database): void {
  incrementBounceCounts([email], db);
}

export function incrementBounceCounts(emails: Iterable<string>, db?: Database): void {
  incrementContactCounts(emails, "bounce_count", { autoSuppressBounces: true }, db);
}

export function incrementComplaintCount(email: string, db?: Database): void {
  incrementComplaintCounts([email], db);
}

export function incrementComplaintCounts(emails: Iterable<string>, db?: Database): void {
  incrementContactCounts(emails, "complaint_count", {}, db);
}

export function isContactSuppressed(email: string, db?: Database): boolean {
  const selfHosted = selfHostedResource(CONTACT_RESOURCE);
  if (selfHosted) return findSelfHostedContactByEmail(selfHosted, email)?.suppressed === true;

  const d = db || getDatabase();
  const row = d.query("SELECT suppressed FROM contacts WHERE email = ?").get(email) as { suppressed: number } | null;
  return row?.suppressed === 1;
}

/**
 * Suppressed addresses among `emails`, matched CANONICALLY.
 *
 * A recipient may be written `Display Name <a@b.com>` or in a different case
 * than the stored contact, and `contacts.email` has no `COLLATE NOCASE`. An
 * exact string comparison therefore let either form slip straight past a
 * suppression — while the self-hosted server, which canonicalizes both sides
 * (`canonicalAddress` -> `canonicalSender`), refused the same send. Local
 * enforcement must not be the weaker one.
 *
 * The returned set contains both the stored spelling and its canonical form, so
 * a caller may test either; `suppressedRecipientsAmong` does the canonical test
 * for them.
 */
export function getSuppressedEmailSet(emails: Iterable<string>, db?: Database): Set<string> {
  const suppressed = new Set<string>();
  // Look up the address as typed AND its canonical form, so a display-name or
  // mixed-case recipient still resolves to the stored contact.
  const lookups = new Set<string>();
  for (const raw of emails) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    lookups.add(trimmed);
    const canonical = canonicalSender(trimmed);
    if (canonical) lookups.add(canonical);
  }
  const uniqueEmails = [...lookups];
  if (uniqueEmails.length === 0) return suppressed;

  const record = (email: string) => {
    suppressed.add(email);
    const canonical = canonicalSender(email);
    if (canonical) suppressed.add(canonical);
  };

  const selfHosted = selfHostedResource(CONTACT_RESOURCE);
  if (selfHosted) {
    for (const email of uniqueEmails) {
      const contact = findSelfHostedContactByEmail(selfHosted, email);
      if (contact?.suppressed) record(contact.email);
    }
    return suppressed;
  }

  const d = db || getDatabase();
  for (let i = 0; i < uniqueEmails.length; i += CONTACT_READ_CHUNK_SIZE) {
    const chunk = uniqueEmails.slice(i, i + CONTACT_READ_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    // `lower(email)` on BOTH sides: a contact stored as `Blocked@ext.com` must
    // still suppress a send to `blocked@ext.com` and vice versa.
    const rows = d
      .query(`SELECT email FROM contacts WHERE suppressed = 1 AND lower(email) IN (${placeholders})`)
      .all(...chunk.map((value) => value.toLowerCase())) as Array<{ email: string }>;
    for (const row of rows) {
      record(row.email);
    }
  }

  return suppressed;
}

/**
 * The subset of `recipients` that is suppressed, compared canonically and
 * returned in the caller's original spelling (so a warning names what the
 * operator typed). One helper so every send surface asks the same question.
 */
export function suppressedRecipientsAmong(recipients: Iterable<string>, db?: Database): string[] {
  const list = [...recipients];
  const suppressed = getSuppressedEmailSet(list, db);
  if (suppressed.size === 0) return [];
  return list.filter((recipient) => {
    if (suppressed.has(recipient) || suppressed.has(recipient.trim())) return true;
    const canonical = canonicalSender(recipient);
    return canonical !== null && suppressed.has(canonical);
  });
}
