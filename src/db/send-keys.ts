/**
 * Scoped send keys — a credential bound to one owner (an agent or human). A key
 * authorizes sending only from addresses that owner OWNS or ADMINISTERS.
 *
 * Self-hosted-ONLY: the `send-keys` resource is summary-only — the secret
 * `key_hash` is NEVER stored on or fetched by a client (token verification is
 * server-side). Minting and verification therefore have no client-side /v1
 * equivalent and run on the authoritative server.
 */
import { now } from "./runtime.js";
import { getAddressOwnership, type Owner } from "./owners.js";
import { findAddressesByEmail } from "./addresses.js";
import { canonicalSender } from "../lib/email-address.js";
import { selfHostedResource, selfHostedListQuery, selfHostedPage, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const SEND_KEY_RESOURCE = "send-keys";

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

/** A self-hosted send key never exposes its hash to the client. */
function summaryToKey(summary: SendKeySummary): SendKey {
  return { ...summary, key_hash: "" };
}

/**
 * Extract the canonical sender address, or "" for an ambiguous/malformed From
 * (an empty string never matches a stored address, so the send is denied).
 */
function bareEmail(from: string): string {
  return canonicalSender(from) ?? "";
}

export function createSendKey(_ownerId: string, _label?: string): { token: string; key: SendKey } {
  // A send key's SHA-256 hash MUST live on the authoritative server that
  // verifies it. The self-hosted `send-keys` resource is summary-only (no
  // key_hash column), so a client-minted key could never be verified. Refuse
  // until the server exposes a dedicated mint endpoint.
  throw new Error(
    "Creating a send key is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

export function getSendKey(id: string): SendKey | null {
  const record = selfHostedResource(SEND_KEY_RESOURCE).get(id);
  return record ? summaryToKey(apiToSendKeySummary(record)) : null;
}

/** Resolve a token to its (non-revoked) key, stamping last_used_at. */
export function verifySendKey(_token: string): SendKey | null {
  // Token verification requires the secret key_hash, which is never exposed to
  // the client; the server authenticates send keys on `/v1/send`.
  throw new Error(
    "verifySendKey is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

export function listSendKeys(ownerId?: string, opts?: ListSendKeyOptions): SendKey[] {
  const { query, limit, offset } = selfHostedListQuery(opts);
  if (ownerId) query["owner_id"] = ownerId;
  let rows = selfHostedResource(SEND_KEY_RESOURCE).list(query).map((e) => summaryToKey(apiToSendKeySummary(e)));
  if (ownerId) rows = rows.filter((k) => k.owner_id === ownerId);
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return selfHostedPage(rows, limit, offset);
}

export function listSendKeySummaries(ownerId?: string, opts?: ListSendKeyOptions): SendKeySummary[] {
  const { query, limit, offset } = selfHostedListQuery(opts);
  if (ownerId) query["owner_id"] = ownerId;
  let rows = selfHostedResource(SEND_KEY_RESOURCE).list(query).map(apiToSendKeySummary);
  if (ownerId) rows = rows.filter((k) => k.owner_id === ownerId);
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return selfHostedPage(rows, limit, offset);
}

export function listSendKeysByOwners(ownerIds: Iterable<string>): SendKey[] {
  const ids = new Set([...ownerIds].map((id) => id.trim()).filter(Boolean));
  if (ids.size === 0) return [];
  return selfHostedResource(SEND_KEY_RESOURCE)
    .list({ limit: 1000 })
    .map((e) => summaryToKey(apiToSendKeySummary(e)))
    .filter((k) => ids.has(k.owner_id))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

export function listSendKeySummariesByOwners(ownerIds: Iterable<string>): SendKeySummary[] {
  const ids = new Set([...ownerIds].map((id) => id.trim()).filter(Boolean));
  if (ids.size === 0) return [];
  return selfHostedResource(SEND_KEY_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToSendKeySummary)
    .filter((k) => ids.has(k.owner_id))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

export function revokeSendKey(id: string): boolean {
  const store = selfHostedResource(SEND_KEY_RESOURCE);
  const record = store.get(id);
  if (!record || cstrOrNull(record["revoked_at"])) return false;
  store.update(id, { revoked_at: now() });
  return true;
}

/** Whether `ownerId` may send from `fromEmail` (owns or administers the address). */
export function canOwnerSendFrom(ownerId: string, fromEmail: string): boolean {
  const email = bareEmail(fromEmail);
  if (!email) return false;
  // Any matching address whose owner or administrator is this owner authorizes.
  for (const address of findAddressesByEmail(email)) {
    const own = getAddressOwnership(address.id);
    if (own && (own.owner_id === ownerId || own.administrator_id === ownerId)) return true;
  }
  return false;
}

/**
 * Verify a send key and confirm it is authorized to send from `fromEmail`.
 * Throws on an invalid/revoked key or an out-of-scope From. Returns the owner.
 */
export function assertSendAuthorized(_token: string, _fromEmail: string): Owner {
  // Depends on verifySendKey, which is server-side only (see above).
  throw new Error(
    "assertSendAuthorized is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}
