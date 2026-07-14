/**
 * Scoped send keys — a credential bound to one owner (an agent or human). A key
 * authorizes sending only from addresses that owner OWNS or ADMINISTERS, so an
 * agent issued a key cannot send as addresses belonging to other principals.
 *
 * Tokens are shown once at creation; only their SHA-256 hash is stored.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "./database.js";
import { getDatabase, now, uuid } from "./database.js";
import { getOwner, getAddressOwnership, type Owner } from "./owners.local.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { canonicalSender } from "../lib/email-address.js";
import { selfHostedResource, selfHostedListQuery, selfHostedPage, ciso, cstr, cstrOrNull } from "./self-hosted-resource.local.js";

const TOKEN_PREFIX = "esk_";

const SEND_KEY_RESOURCE = "send-keys";

// The selfHosted `send-keys` resource is summary-only: the secret `key_hash` is NEVER
// stored on or fetched by a client (token verification is server-side). A selfHosted
// send-key maps its key_hash to "" (display/enumeration only; auth uses
// verifySendKey, which stays on the authoritative store).
function apiToSendKeySummary(e: Record<string, unknown>): SendKeySummary {
  return {
    id: cstr(e["id"]),
    owner_id: cstr(e["owner_id"]),
    prefix: cstr(e["prefix"]),
    label: cstrOrNull(e["label"]),
    created_at: ciso(e["created_at"]),
    last_used_at: cstrOrNull(e["last_used_at"]),
    revoked_at: cstrOrNull(e["revoked_at"]),
  };
}

export interface SendKey {
  id: string;
  owner_id: string;
  key_hash: string;
  prefix: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export type SendKeySummary = Omit<SendKey, "key_hash">;

export interface ListSendKeyOptions {
  limit?: number;
  offset?: number;
}

const SEND_KEY_COLUMNS = [
  "id",
  "owner_id",
  "key_hash",
  "prefix",
  "label",
  "created_at",
  "last_used_at",
  "revoked_at",
].join(", ");

const SEND_KEY_SUMMARY_COLUMNS = [
  "id",
  "owner_id",
  "prefix",
  "label",
  "created_at",
  "last_used_at",
  "revoked_at",
].join(", ");

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Extract the canonical sender address, or "" for an ambiguous/malformed From
 * (an empty string never matches a stored address, so the send is denied).
 */
function bareEmail(from: string): string {
  return canonicalSender(from) ?? "";
}

export function createSendKey(ownerId: string, label?: string, db?: Database): { token: string; key: SendKey } {
  // Self-hosted mode: FAIL LOUD instead of minting into the local SQLite island.
  // A send key is a credential whose SHA-256 hash MUST live on the authoritative
  // store that verifies it. The selfHosted `send_keys` resource is summary-only (no
  // key_hash column server-side), so a key minted locally can never be verified
  // by the selfHosted server — `sendkey list` (selfHosted) would show nothing and sends
  // authenticated by that token would be rejected. Rather than silently create
  // an unusable/split-brain key, refuse until the server exposes a dedicated
  // mint endpoint (POST /v1/send-keys that generates the token server-side,
  // stores the hash, and returns the token once).
  if (selfHostedResource(SEND_KEY_RESOURCE)) {
    throw new Error(
      "Creating a send key through the self-hosted metadata resource is not supported. " +
        "Use an operator-issued service API key, or run with EMAILS_MODE=local for local send keys.",
    );
  }
  const d = db || getDatabase();
  const owner = getOwner(ownerId, d);
  if (!owner) throw new Error(`Owner not found: ${ownerId}`);
  const token = TOKEN_PREFIX + randomBytes(24).toString("hex");
  const id = uuid();
  const prefix = token.slice(0, 12);
  d.run(
    "INSERT INTO send_keys (id, owner_id, key_hash, prefix, label, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, ownerId, hashToken(token), prefix, label ?? null, now()],
  );
  return { token, key: getSendKey(id, d)! };
}

export function getSendKey(id: string, db?: Database): SendKey | null {
  const d = db || getDatabase();
  return (d.query(`SELECT ${SEND_KEY_COLUMNS} FROM send_keys WHERE id = ?`).get(id) as SendKey | null) ?? null;
}

/** Resolve a token to its (non-revoked) key, stamping last_used_at. */
export function verifySendKey(token: string, db?: Database): SendKey | null {
  const d = db || getDatabase();
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const row = d.query(`SELECT ${SEND_KEY_COLUMNS} FROM send_keys WHERE key_hash = ?`).get(hashToken(token)) as SendKey | null;
  if (!row || row.revoked_at) return null;
  d.run("UPDATE send_keys SET last_used_at = ? WHERE id = ?", [now(), row.id]);
  return row;
}

export function listSendKeys(ownerId?: string, db?: Database, opts?: ListSendKeyOptions): SendKey[] {
  const selfHosted = selfHostedResource(SEND_KEY_RESOURCE);
  if (selfHosted) {
    const { query, limit, offset } = selfHostedListQuery(opts);
    if (ownerId) query["owner_id"] = ownerId;
    let rows = selfHosted.list(query).map((e) => ({ ...apiToSendKeySummary(e), key_hash: "" }) as SendKey);
    if (ownerId) rows = rows.filter((k) => k.owner_id === ownerId);
    rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return selfHostedPage(rows, limit, offset);
  }

  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  return (ownerId
    ? (limit !== null
        ? d.query(`SELECT ${SEND_KEY_COLUMNS} FROM send_keys WHERE owner_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(ownerId, limit, offset)
        : d.query(`SELECT ${SEND_KEY_COLUMNS} FROM send_keys WHERE owner_id = ? ORDER BY created_at DESC`).all(ownerId))
    : (limit !== null
        ? d.query(`SELECT ${SEND_KEY_COLUMNS} FROM send_keys ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset)
        : d.query(`SELECT ${SEND_KEY_COLUMNS} FROM send_keys ORDER BY created_at DESC`).all())) as SendKey[];
}

export function listSendKeySummaries(ownerId?: string, db?: Database, opts?: ListSendKeyOptions): SendKeySummary[] {
  const selfHosted = selfHostedResource(SEND_KEY_RESOURCE);
  if (selfHosted) {
    const { query, limit, offset } = selfHostedListQuery(opts);
    if (ownerId) query["owner_id"] = ownerId;
    let rows = selfHosted.list(query).map(apiToSendKeySummary);
    if (ownerId) rows = rows.filter((k) => k.owner_id === ownerId);
    rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return selfHostedPage(rows, limit, offset);
  }

  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  return (ownerId
    ? (limit !== null
        ? d.query(`SELECT ${SEND_KEY_SUMMARY_COLUMNS} FROM send_keys WHERE owner_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(ownerId, limit, offset)
        : d.query(`SELECT ${SEND_KEY_SUMMARY_COLUMNS} FROM send_keys WHERE owner_id = ? ORDER BY created_at DESC`).all(ownerId))
    : (limit !== null
        ? d.query(`SELECT ${SEND_KEY_SUMMARY_COLUMNS} FROM send_keys ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset)
        : d.query(`SELECT ${SEND_KEY_SUMMARY_COLUMNS} FROM send_keys ORDER BY created_at DESC`).all())) as SendKeySummary[];
}

export function listSendKeysByOwners(ownerIds: Iterable<string>, db?: Database): SendKey[] {
  const ids = [...new Set([...ownerIds].map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const d = db || getDatabase();
  const placeholders = ids.map(() => "?").join(", ");
  return d
    .query(`SELECT ${SEND_KEY_COLUMNS} FROM send_keys WHERE owner_id IN (${placeholders}) ORDER BY created_at DESC`)
    .all(...ids) as SendKey[];
}

export function listSendKeySummariesByOwners(ownerIds: Iterable<string>, db?: Database): SendKeySummary[] {
  const ids = [...new Set([...ownerIds].map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const d = db || getDatabase();
  const placeholders = ids.map(() => "?").join(", ");
  return d
    .query(`SELECT ${SEND_KEY_SUMMARY_COLUMNS} FROM send_keys WHERE owner_id IN (${placeholders}) ORDER BY created_at DESC`)
    .all(...ids) as SendKeySummary[];
}

export function revokeSendKey(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  return d.run("UPDATE send_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now(), id]).changes > 0;
}

/** Whether `ownerId` may send from `fromEmail` (owns or administers the address). */
export function canOwnerSendFrom(ownerId: string, fromEmail: string, db?: Database): boolean {
  const d = db || getDatabase();
  const email = bareEmail(fromEmail);
  // Resolve the address across providers; any matching address whose owner or
  // administrator is this owner authorizes the send.
  const rows = d.query("SELECT id FROM addresses WHERE LOWER(email) = ?").all(email) as Array<{ id: string }>;
  for (const r of rows) {
    const own = getAddressOwnership(r.id, d);
    if (own && (own.owner_id === ownerId || own.administrator_id === ownerId)) return true;
  }
  return false;
}

/**
 * Verify a send key and confirm it is authorized to send from `fromEmail`.
 * Throws on an invalid/revoked key or an out-of-scope From. Returns the owner.
 */
export function assertSendAuthorized(token: string, fromEmail: string, db?: Database): Owner {
  const d = db || getDatabase();
  const key = verifySendKey(token, d);
  if (!key) throw new Error("Send key is invalid or revoked");
  const owner = getOwner(key.owner_id, d);
  if (!owner) throw new Error("Send key owner no longer exists");
  if (!canOwnerSendFrom(owner.id, fromEmail, d)) {
    throw new Error(`Send key for '${owner.name}' is not authorized to send from ${bareEmail(fromEmail)}`);
  }
  return owner;
}
