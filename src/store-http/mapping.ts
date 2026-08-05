// Wire JSON -> seam records.
//
// THE ONE RULE: A MAPPER NEVER INVENTS A VALUE. If a field the seam declares
// required is absent from the response, that is a FAULT and this module throws.
// It does not default to `[]`, `0`, `false` or `null`.
//
// That rule is the whole reason this file is separate and this long. A mapper that
// defaults is the plausible-wrong-answer failure at record level, and it is worse
// here than anywhere else in the store: the refusal channel cannot help, because the
// call SUCCEEDED — the API answered 200 and the store handed back a record whose
// `labels` were dropped on the floor. The conformance suite asserts every written
// field reads back for exactly this reason, and a defaulting mapper is how a store
// passes the id assertions while losing the content.
//
// Optionality is copied from records.ts, not decided here: a field the seam declares
// optional (`provisioning_status?`, `owner_id?`) is passed through when the service
// sends it and left absent when it does not, because "the API did not disclose this"
// and "the value is null" are different facts.
//
// THE TWO FIELDS THAT ARE ALWAYS NULL, stated rather than hidden:
// `idempotency_key` and `send_payload_hash`. The service strips both from every
// message it returns (`publicMessage`, src/server/self-hosted/service.ts:167-170), so
// no response can carry them. They are mapped to null — and `createMessage` /
// `upsertMessage` REFUSE a caller who tries to write them, so there is no write whose
// read-back this null could contradict. Without that refusal this mapping would be a
// lie; with it, it is the API declining to disclose a field nothing can set.

import type {
  AddressRecord,
  AttachmentInventoryItem,
  AttachmentMeta,
  DomainRecord,
  MailboxRollup,
  MessageCountsRecord,
  MessageListRecord,
  MessageRecord,
  SendKeyRecord,
  ThreadRollup,
} from "../store/records.js";
import { EmailsApiFault } from "./outcome.js";

function fault(what: string, detail: string): never {
  throw new EmailsApiFault(200, `the Emails API answered ${what} with ${detail}`);
}

export function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fault(what, "a body that is not an object");
  }
  return value as Record<string, unknown>;
}

export function asArrayOf(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) fault(what, "a body that is not an array");
  return value;
}

/**
 * Unwrap `{ <key>: value }`, the envelope the bespoke routes use.
 *
 * The generic resource routes answer with a BARE row instead, which is why this is a
 * named step rather than something every mapper assumes.
 */
export function envelope(body: unknown, key: string, what: string): unknown {
  const wrapper = asRecord(body, what);
  if (!(key in wrapper)) fault(what, `no "${key}" in the response body`);
  return wrapper[key];
}

function requiredString(row: Record<string, unknown>, key: string, what: string): string {
  const value = row[key];
  if (typeof value !== "string") fault(what, `a non-string ${key}`);
  return value;
}

/**
 * A field the seam declares REQUIRED but NULLABLE.
 *
 * ABSENCE IS A FAULT HERE, NOT A NULL, and the distinction is the whole reason this
 * helper is separate from `optional()`. An earlier version returned null when the key was
 * missing, which quietly invented the most consequential value in the record for several
 * fields: an absent `revoked_at` read as "this send key is live", an absent `daily_quota`
 * as "no send limit", an absent `provider_message_id` as "never dispatched". Those are
 * plausible wrong answers arriving on a 200, which is the class this whole store exists
 * to remove — and the file's own headline rule already forbade it. Adversarial review
 * caught the inconsistency.
 *
 * A key that is PRESENT and null is the documented value and passes through. Fields the
 * seam declares optional (`?`) never reach here; they go through `optional()`.
 */
function nullableString(row: Record<string, unknown>, key: string, what: string): string | null {
  if (!(key in row)) fault(what, `no ${key}`);
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fault(what, `a non-string ${key}`);
  return value;
}

function requiredBoolean(row: Record<string, unknown>, key: string, what: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") fault(what, `a non-boolean ${key}`);
  return value;
}

function requiredNumber(row: Record<string, unknown>, key: string, what: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) fault(what, `a non-numeric ${key}`);
  return value;
}

/** Required but nullable, numeric. Absence is a fault — see `nullableString`. */
function nullableNumber(row: Record<string, unknown>, key: string, what: string): number | null {
  if (!(key in row)) fault(what, `no ${key}`);
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) fault(what, `a non-numeric ${key}`);
  return value;
}

function requiredStringArray(row: Record<string, unknown>, key: string, what: string): string[] {
  const value = row[key];
  if (!Array.isArray(value)) fault(what, `a non-array ${key}`);
  return value.map((entry) => {
    if (typeof entry !== "string") fault(what, `a non-string entry in ${key}`);
    return entry;
  });
}

/** Copy an OPTIONAL field only when the service sent it. */
function optional(target: Record<string, unknown>, row: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    if (key in row) target[key] = row[key];
  }
}

/**
 * An OPTIONAL `*_json` column the seam declares as a DECODED array of strings
 * (`nameservers_json?: string[]`) — which server releases through 1.3.x send as
 * a JSON-encoded STRING (`"[]"` rather than `[]`).
 *
 * The string form is decoded ONCE and held to the declared shape. A value that
 * is neither the declared array of strings nor a string decoding to one is a
 * FAULT, not a pass-through and not a default: an unreadable nameserver list is
 * not a domain with no nameservers, and copying the raw value forward hands the
 * seam a record its own type says cannot exist. Decoding is not inventing — the
 * headline rule holds. Absent stays absent, because the field is optional and
 * "the API did not disclose this" is a different fact from every value.
 */
function optionalSerializedStringArray(
  target: Record<string, unknown>,
  row: Record<string, unknown>,
  key: string,
  what: string,
): void {
  if (!(key in row)) return;
  let value: unknown = row[key];
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      fault(what, `a non-array ${key}`);
    }
  }
  if (!Array.isArray(value)) fault(what, `a non-array ${key}`);
  for (const entry of value) {
    if (typeof entry !== "string") fault(what, `a non-string entry in ${key}`);
  }
  target[key] = value;
}

// ---- domains ----------------------------------------------------------------

const DOMAIN_OPTIONAL = [
  "provisioning_status",
  "purchase_provider",
  "dns_provider",
  "send_provider",
  "cf_zone_id",
  "registrar",
  "mail_from_domain",
  "last_error",
  "next_check_at",
];

export function domainRecord(value: unknown, what: string): DomainRecord {
  const row = asRecord(value, what);
  const mapped: Record<string, unknown> = {
    id: requiredString(row, "id", what),
    domain: requiredString(row, "domain", what),
    status: requiredString(row, "status", what),
    provider: nullableString(row, "provider", what),
    verified: requiredBoolean(row, "verified", what),
    notes: nullableString(row, "notes", what),
    created_at: requiredString(row, "created_at", what),
    updated_at: requiredString(row, "updated_at", what),
  };
  optional(mapped, row, DOMAIN_OPTIONAL);
  optionalSerializedStringArray(mapped, row, "nameservers_json", what);
  return mapped as unknown as DomainRecord;
}

// ---- addresses --------------------------------------------------------------

const ADDRESS_OPTIONAL = [
  "owner_id",
  "administrator_id",
  "domain_id",
  "receive_strategy",
  "forward_to",
  "routing_rule_id",
  "provisioning_status",
  "last_validated_at",
  "last_error",
  "next_check_at",
];

export function addressRecord(value: unknown, what: string): AddressRecord {
  const row = asRecord(value, what);
  const mapped: Record<string, unknown> = {
    id: requiredString(row, "id", what),
    email: requiredString(row, "email", what),
    domain: nullableString(row, "domain", what),
    display_name: nullableString(row, "display_name", what),
    status: requiredString(row, "status", what),
    verified: requiredBoolean(row, "verified", what),
    daily_quota: nullableNumber(row, "daily_quota", what),
    created_at: requiredString(row, "created_at", what),
    updated_at: requiredString(row, "updated_at", what),
  };
  optional(mapped, row, ADDRESS_OPTIONAL);
  return mapped as unknown as AddressRecord;
}

// ---- messages ---------------------------------------------------------------

export function messageRecord(value: unknown, what: string): MessageRecord {
  const row = asRecord(value, what);
  const headers = row["headers"];
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    fault(what, "a non-object headers map");
  }
  return {
    id: requiredString(row, "id", what),
    direction: requiredString(row, "direction", what),
    from_addr: requiredString(row, "from_addr", what),
    to_addrs: requiredStringArray(row, "to_addrs", what),
    cc_addrs: requiredStringArray(row, "cc_addrs", what),
    subject: nullableString(row, "subject", what),
    body_text: nullableString(row, "body_text", what),
    body_html: nullableString(row, "body_html", what),
    status: requiredString(row, "status", what),
    provider_message_id: nullableString(row, "provider_message_id", what),
    message_id: nullableString(row, "message_id", what),
    in_reply_to: nullableString(row, "in_reply_to", what),
    received_at: nullableString(row, "received_at", what),
    is_read: requiredBoolean(row, "is_read", what),
    is_starred: requiredBoolean(row, "is_starred", what),
    labels: requiredStringArray(row, "labels", what),
    headers: headers as Record<string, unknown>,
    attachments: asArrayOf(row["attachments"], `${what} attachments`),
    source_id: nullableString(row, "source_id", what),
    // Stripped from every response by design; see the header note.
    idempotency_key: null,
    send_payload_hash: null,
    send_state: requiredString(row, "send_state", what),
    send_started_at: nullableString(row, "send_started_at", what),
    created_at: requiredString(row, "created_at", what),
    updated_at: requiredString(row, "updated_at", what),
  };
}

export function messageListRecord(value: unknown, what: string): MessageListRecord {
  const row = asRecord(value, what);
  return {
    id: requiredString(row, "id", what),
    direction: requiredString(row, "direction", what),
    from_addr: requiredString(row, "from_addr", what),
    to_addrs: requiredStringArray(row, "to_addrs", what),
    cc_addrs: requiredStringArray(row, "cc_addrs", what),
    subject: nullableString(row, "subject", what),
    status: requiredString(row, "status", what),
    provider_message_id: nullableString(row, "provider_message_id", what),
    message_id: nullableString(row, "message_id", what),
    in_reply_to: nullableString(row, "in_reply_to", what),
    received_at: nullableString(row, "received_at", what),
    is_read: requiredBoolean(row, "is_read", what),
    is_starred: requiredBoolean(row, "is_starred", what),
    labels: requiredStringArray(row, "labels", what),
    source_id: nullableString(row, "source_id", what),
    send_state: requiredString(row, "send_state", what),
    send_started_at: nullableString(row, "send_started_at", what),
    created_at: requiredString(row, "created_at", what),
    updated_at: requiredString(row, "updated_at", what),
    snippet: nullableString(row, "snippet", what),
    attachment_count: requiredNumber(row, "attachment_count", what),
    // Optional on the wire (an older server does not send it), so a missing value
    // maps to null rather than failing the row. Without this, a `blocked` message
    // loses its reason again the moment this mapper replaces the older one.
    policy_denial: nullableString(row, "policy_denial", what),
  };
}

export function messageCounts(value: unknown, what: string): MessageCountsRecord {
  const row = asRecord(value, what);
  return {
    inbox: requiredNumber(row, "inbox", what),
    unread: requiredNumber(row, "unread", what),
    starred: requiredNumber(row, "starred", what),
    sent: requiredNumber(row, "sent", what),
    archived: requiredNumber(row, "archived", what),
    spam: requiredNumber(row, "spam", what),
    trash: requiredNumber(row, "trash", what),
    total: requiredNumber(row, "total", what),
    latest_received_at: nullableString(row, "latest_received_at", what),
  };
}

// ---- attachments ------------------------------------------------------------

export function attachmentInventoryItem(value: unknown, what: string): AttachmentInventoryItem {
  const row = asRecord(value, what);
  return {
    message_id: requiredString(row, "message_id", what),
    attachment_index: requiredNumber(row, "attachment_index", what),
    filename: nullableString(row, "filename", what),
    content_type: nullableString(row, "content_type", what),
    size_bytes: nullableNumber(row, "size_bytes", what),
    sha256: nullableString(row, "sha256", what),
    content_available: requiredBoolean(row, "content_available", what),
    direction: nullableString(row, "direction", what),
    received_at: nullableString(row, "received_at", what),
  };
}

export function attachmentMeta(value: unknown, what: string): AttachmentMeta {
  const row = asRecord(value, what);
  return {
    attachment_index: requiredNumber(row, "attachment_index", what),
    filename: nullableString(row, "filename", what),
    content_type: nullableString(row, "content_type", what),
    size_bytes: nullableNumber(row, "size_bytes", what),
    sha256: nullableString(row, "sha256", what),
    content_available: requiredBoolean(row, "content_available", what),
  };
}

// ---- rollups ----------------------------------------------------------------

export function threadRollup(value: unknown, what: string): ThreadRollup {
  const row = asRecord(value, what);
  return {
    thread_key: requiredString(row, "thread_key", what),
    subject: nullableString(row, "subject", what),
    message_count: requiredNumber(row, "message_count", what),
    unread_count: requiredNumber(row, "unread_count", what),
    last_message_at: nullableString(row, "last_message_at", what),
    first_message_at: nullableString(row, "first_message_at", what),
    participants: requiredStringArray(row, "participants", what),
  };
}

export function mailboxRollup(value: unknown, what: string): MailboxRollup {
  const row = asRecord(value, what);
  return {
    id: requiredString(row, "id", what),
    address: requiredString(row, "address", what),
    display_name: nullableString(row, "display_name", what),
    status: requiredString(row, "status", what),
    total: requiredNumber(row, "total", what),
    unread: requiredNumber(row, "unread", what),
  };
}

// ---- send keys ---------------------------------------------------------------

/**
 * The non-secret projection. `key_hash` is stripped rather than passed through:
 * `redactColumns` already keeps it off the service's response, and a mapper that
 * copied unknown keys verbatim would republish it the moment a drifted table
 * reintroduced one. The seam's own conformance case asserts its absence.
 */
export function sendKeyRecord(value: unknown, what: string): SendKeyRecord {
  const row = asRecord(value, what);
  return {
    id: requiredString(row, "id", what),
    owner_id: nullableString(row, "owner_id", what),
    prefix: nullableString(row, "prefix", what),
    label: nullableString(row, "label", what),
    last_used_at: nullableString(row, "last_used_at", what),
    revoked_at: nullableString(row, "revoked_at", what),
    created_at: requiredString(row, "created_at", what),
    updated_at: requiredString(row, "updated_at", what),
  };
}
