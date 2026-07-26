// Row and value shapes for the store seam.
//
// DERIVED FROM THE STRONGEST IMPLEMENTATION, ON PURPOSE. Every shape here was read
// off `TenantScopedStore` in src/server/self-hosted/store.ts — the tenant-scoped
// Postgres store — and not off the SQLite arm.
//
// That direction matters more than it looks. The facades carry exactly 30
// `export type * from "./<family>.local.js"` statements, which makes the SQLite arm — the
// less scope-aware of the two — the CONTRACT. A contract taken from an implementation
// inherits that implementation's blind spots, and this one has no way to express "I
// cannot do this", so BOTH arms answer with plausible wrong data instead: a stub-return
// scan finds roughly 47 such returns in `*.local.ts` and 32 in `*.remote.ts`, across the
// 293 exports that are mode-routed today. (A prior audit put it at "39 of 324"; that
// figure is not reproducible from this tree and is kept here only as provenance.) The fix
// is not to blame an arm — it is to stop deriving the contract from either one. Deriving
// from the strongest available implementation inverts the type authority, and the
// universal `Outcome` return does the rest: refusing is expressible, so answering
// "nothing" is no longer the only option.
//
// The shapes are COPIED rather than imported. Nothing in src/store/ imports from
// outside src/store/ (enforced by the seam guard), for three reasons: the seam must
// not drag `pg` into a client bundle; a nominal tie to a class with `private` fields
// is exactly the unsubstitutability this refactor exists to remove; and a
// declaration that can be read on its own is one a second implementation can be
// checked against. Field names, optionality and nullability are copied CHARACTER FOR
// CHARACTER from the server store — including the shapes it declares inline on a
// method rather than as a named type — so `TenantScopedStore` satisfies those
// operations structurally, with no `implements` clause and no internal change.
//
// ONE SHAPE HAS NO SERVER COUNTERPART: `AddressSendability`. The server answers that
// question through `evaluateOutboundPolicy` -> `OutboundPolicyDecision`, so the seam's
// shape is derived from that decision, NOT from the local arm's `Sendability`. The
// local one is worth reading as a warning: for an email it has never heard of it
// returns `{ sendable: true }` (src/db/address-lifecycle.local.ts), i.e. "I know
// nothing about this sender, go ahead". That is the plausible-wrong-answer failure in
// its purest form, and it is why this operation sits behind the `outboundPolicy`
// capability with a refusal available.
//
// SCOPE IS NOT AN ARGUMENT. In the Postgres store, unscoped access is a compile error
// because the tenant is fixed when the store is constructed, not passed per call.
// The seam keeps that property the only way a type declaration can: NO shape and NO
// method signature in src/store/ carries a tenant id. A caller holds an
// already-scoped store or it holds nothing. The seam guard asserts this.

/** Offset paging. Server clamps: limit defaults to 100, hard cap 500. */
export interface ListOptions {
  limit?: number;
  offset?: number;
}

/**
 * Keyset paging. `cursor` is opaque and comes from a previous page's `next_cursor`;
 * callers never construct or parse one. Behind the `keysetPagination` capability.
 */
export interface PageOptions {
  limit?: number;
  cursor?: string;
}

/** One keyset page. `next_cursor` is null exactly when this page is the last. */
export interface Page<TItem> {
  items: TItem[];
  next_cursor: string | null;
}

// ---- domains ---------------------------------------------------------------

export interface DomainRecord {
  id: string;
  domain: string;
  status: string;
  provider: string | null;
  verified: boolean;
  notes: string | null;
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

/** Writable domain provisioning fields; a patch may set any subset. */
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

export interface DomainInput {
  domain: string;
  status?: string;
  provider?: string | null;
  verified?: boolean;
  notes?: string | null;
}

/**
 * Writable domain fields on an UPDATE. `domain` is deliberately absent: the strongest
 * arm cannot rename a domain, because the name is what an inbound route is claimed on.
 * Reusing `DomainInput` for the patch would type a rename as legal and let a caller ask
 * for something no store can honour.
 */
export interface DomainPatch {
  status?: string;
  provider?: string | null;
  verified?: boolean;
  notes?: string | null;
}

// ---- addresses -------------------------------------------------------------

export interface AddressRecord {
  id: string;
  email: string;
  domain: string | null;
  display_name: string | null;
  status: string;
  verified: boolean;
  daily_quota: number | null;
  owner_id?: string | null;
  administrator_id?: string | null;
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

/** Writable ownership fields; either may be set, and null clears. */
export interface AddressOwnershipPatch {
  owner_id?: string | null;
  administrator_id?: string | null;
}

/** `domain` is absent: the strongest arm derives it from the email, never accepts it. */
export interface AddressInput {
  email: string;
  display_name?: string | null;
  status?: string;
  verified?: boolean;
  daily_quota?: number | null;
}

/**
 * Writable address fields on an UPDATE.
 *
 * `dailyQuotaSet` is carried over from the strongest arm verbatim, ugliness included,
 * because it encodes a distinction the seam must not lose: "not provided" (keep the
 * existing quota) versus an explicit clear (`daily_quota: null`, what `quota <id> none`
 * does). An optional field alone cannot express the difference, and collapsing them is
 * how a clear silently becomes a no-op.
 */
export interface AddressPatch {
  display_name?: string | null;
  status?: string;
  verified?: boolean;
  dailyQuotaSet?: boolean;
  daily_quota?: number | null;
}

/** Whether an address may send right now, and if not, why. */
export interface AddressSendability {
  sendable: boolean;
  reason: string | null;
  sent_today: number;
  daily_quota: number | null;
}

// ---- messages --------------------------------------------------------------

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

/**
 * List projection. Declared FLAT rather than as `Omit<MessageRecord, …>`: the
 * omission list is the interesting part of the contract (bodies, headers and
 * attachment payloads are ~73% of a page and are deliberately absent), and a
 * subtraction type hides it behind a name. Flat also keeps the seam free of the
 * derived-type machinery this refactor is trying to get out of.
 */
export interface MessageListRecord {
  id: string;
  direction: string;
  from_addr: string;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string | null;
  status: string;
  provider_message_id: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  received_at: string | null;
  is_read: boolean;
  is_starred: boolean;
  labels: string[];
  source_id: string | null;
  send_state: string;
  send_started_at: string | null;
  created_at: string;
  updated_at: string;
  snippet: string | null;
  /** Count only — full attachment metadata stays on the single-message read. */
  attachment_count: number;
}

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

/** Server-side folder names; predicates mirror the folder counts exactly. */
export type MessageFolder = "inbox" | "starred" | "sent" | "archived" | "spam" | "trash";

export const MESSAGE_FOLDERS: readonly MessageFolder[] = [
  "inbox",
  "starred",
  "sent",
  "archived",
  "spam",
  "trash",
];

/** Filters for a message list. Declared flat; `cursor` wins over `offset`. */
export interface ListMessagesOptions {
  limit?: number;
  offset?: number;
  cursor?: string;
  direction?: "inbound" | "outbound";
  to?: string;
  from?: string;
  subject?: string;
  search?: string;
  since?: string;
  /** Only messages with a recipient at one of these domains (lowercased). */
  domains?: string[];
  folder?: MessageFolder;
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

/**
 * Writable message flags; a patch may set any subset. Labels are edited one at a time
 * (`add_label` / `remove_label`) rather than by replacing the array, which is what the
 * strongest arm does: a whole-array write loses a concurrent label change instead of
 * merging with it.
 */
export interface MessageStatusPatch {
  status?: string;
  provider_message_id?: string | null;
  is_read?: boolean;
  is_starred?: boolean;
  archived?: boolean;
  add_label?: string;
  remove_label?: string;
}

/** Reconstructed raw MIME. Behind the `rawMessage` capability. */
export interface MessageRaw {
  raw: string;
  message_id: string | null;
}

// ---- attachments -----------------------------------------------------------

export interface StoredAttachment {
  filename: string;
  content_type: string;
  size: number;
  content_base64: string;
}

/**
 * The three-state answer to "give me these bytes", copied from the server store.
 *
 * `content_unavailable` is the shape worth preserving: metadata exists but the bytes
 * do not, because a legacy import backfilled filename/content_type/size for messages
 * whose payloads were never carried over. Collapsing that into `null` (or into an
 * empty attachment) is precisely the class of lie this seam removes — the caller
 * cannot tell "no such attachment" from "we lost the bytes" without it.
 */
export type StoredAttachmentLookup =
  | { state: "available"; attachment: StoredAttachment }
  | {
      state: "content_unavailable";
      attachment: { filename: string; content_type: string; size: number | null };
    }
  | { state: "invalid"; reason: string };

export interface AttachmentInventoryItem {
  message_id: string;
  /** 0-based position in the message's attachments array; the stable id. */
  attachment_index: number;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  /** Whether valid stored bytes exist. Metadata alone is NOT proof of content. */
  content_available: boolean;
  direction: string | null;
  received_at: string | null;
}

export interface AttachmentMeta {
  attachment_index: number;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  content_available: boolean;
}

export interface ListAttachmentsOptions {
  limit?: number;
  cursor?: string;
  direction?: "inbound" | "outbound";
  since?: string;
}

// ---- outbound policy -------------------------------------------------------

/**
 * Why a send was refused, copied verbatim from the server's `OutboundPolicyCode`.
 * These are the domain-specific refusal codes referred to in outcome.ts: they append
 * to `RefusalCode` as the send path migrates, rather than being converted, because
 * they are already spelled this way.
 */
export type OutboundPolicyCode =
  | "sender_not_registered"
  | "sender_inactive"
  | "sender_unverified"
  | "sender_not_ready"
  | "send_key_required"
  | "send_key_invalid"
  | "send_key_forbidden"
  | "recipient_suppressed"
  | "address_quota_exceeded"
  | "warming_limit_exceeded";

/**
 * The policy decision itself, field-for-field the server's `OutboundPolicyDecision`.
 * This is the shape `Outcome`/`Refusal` was modelled on, kept here unchanged so the two
 * converge instead of diverging: `allowed` + `code` + `message` + `status`.
 */
export type OutboundPolicyDecision =
  | { allowed: true }
  | { allowed: false; code: OutboundPolicyCode; message: string; status: 403 | 409 | 429 };

/** What the policy is evaluated against. */
export interface OutboundPolicyInput {
  from_addr: string;
  to_addrs: string[];
  send_key_token?: string | null;
  owner_id?: string | null;
}

// ---- send intents ----------------------------------------------------------

export interface SendIntentLookupResult {
  found: boolean;
  tombstoned: boolean;
  reconciliation_required: boolean;
  message: MessageRecord | null;
}

export interface SendIntentCancellationResult {
  outcome: "tombstoned" | "cancelled" | "reconciliation_required";
  tombstoned: true;
  reconciliation_required: boolean;
  message: MessageRecord | null;
}

// ---- rollups ---------------------------------------------------------------

export interface ThreadRollup {
  /** Normalized (Re:/Fwd:-stripped, lowercased) subject key grouping the thread. */
  thread_key: string;
  subject: string | null;
  message_count: number;
  unread_count: number;
  last_message_at: string | null;
  first_message_at: string | null;
  participants: string[];
}

export interface MailboxRollup {
  id: string;
  address: string;
  display_name: string | null;
  status: string;
  total: number;
  unread: number;
}

// ---- send keys -------------------------------------------------------------

/** Non-secret projection of a scoped send key. NEVER carries the key hash. */
export interface SendKeyRecord {
  id: string;
  owner_id: string | null;
  prefix: string | null;
  label: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A freshly minted key. The plaintext `token` is returned EXACTLY ONCE, at mint, and
 * is never readable again — so this shape must never be logged or cached.
 */
export interface MintedSendKey {
  token: string;
  key: SendKeyRecord;
}

// ---- generic tenant-scoped resource rows ------------------------------------

/**
 * A row of one of the uniform resource families (contacts, providers, templates,
 * groups, sequences, owners, scheduled, aliases, forwarding, warming, digests,
 * events, sandbox, webhook receipts …).
 *
 * `Record<string, unknown>` is honest here rather than lazy: the strongest
 * implementation serves these families through ONE generic, tenant-scoped CRUD path
 * whose columns are declared per resource in a spec table, so a hand-written
 * per-family row type would be a SECOND source of truth for the same column list —
 * the kind of duplication that goes stale silently. Each family's typed row lands
 * with that family's migration, next to the code that maps it.
 */
export type ResourceRow = Record<string, unknown>;

/** Writable fields for a resource create or update. */
export type ResourceInput = Record<string, unknown>;
