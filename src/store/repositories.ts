// One repository per existing `src/db/*` family, declared as an interface.
//
// FOUR RULES, and they are the substance of this file.
//
// 1. EVERYTHING IS ASYNC. Not a style preference — a hard requirement. The current
//    repositories are synchronous only because the HTTP arm shells out to `curl` via
//    `spawnSync` to fake a blocking network call, and that trick dies with this
//    refactor. Every operation here returns a Promise, including the ones SQLite
//    could answer synchronously, so no caller's control flow depends on which store
//    it holds.
//
// 2. NO BASE CLASSES, NO DEFAULT BODIES. There is no abstract class here, no
//    `implements`-able parent, no supplied method body, no optional-everything
//    variant of an interface, and no runtime merging of defaults. Every
//    implementation stands alone, which is what makes a MISSING METHOD a `tsc` error
//    instead of an inherited no-op that returns a plausible wrong answer. The seam
//    guard enforces this by scanning the code (comments stripped) for the forms that
//    would reintroduce it.
//
// 3. DERIVED FROM THE STRONGEST ARM — with the exceptions named, not glossed over.
//    Record shapes, parameter shapes, nullability and method names follow
//    `TenantScopedStore` (src/server/self-hosted/store.ts), the tenant-scoped Postgres
//    store, wherever it HAS the operation. Where it does not, the honest accounting is:
//
//      * 22 operations have no counterpart there and were taken from the local arm
//        (`suspendAddress` / `activateAddress` / `setAddressQuota` /
//        `getAddressSendability`; the inbound flag and count operations; three send-key
//        operations; the two provisioning-event operations). They are the surface the
//        server has never grown, and declaring them here is what makes that visible.
//      * `listInbound` exists in NEITHER arm under that name. It is new, and named for
//        the folder-scoped read the server serves from the messages table.
//      * the 14 uniform families use short names (`list` / `get` / `create` / `update` /
//        `remove`) because the server serves them through ONE generic path
//        (`listResource(spec, …)`) whose first argument is a resource spec the seam
//        deliberately does not expose. There is no per-family name to preserve.
//
//    So: `TenantScopedStore` does NOT satisfy these interfaces as-is, and an adapter is
//    required. Rule 4 alone guarantees that — the class returns bare values. Copying its
//    names and shapes still pays: the adapter is mechanical, field-for-field, and
//    reviewable, and the seam inherits the tenant-scoped semantics rather than the
//    permissive ones. The interfaces are declared INDEPENDENTLY rather than derived from
//    the class, because a class with `private` fields is nominally typed — a
//    field-subtraction or member-selection type over it would carry that nominality into
//    the seam and rebuild exactly the unsubstitutability this refactor removes.
//
// 4. EVERY OPERATION RETURNS AN OUTCOME. Not only the capability-gated ones. An
//    earlier draft returned plain values from operations "every store can always
//    perform" and reserved `Outcome<T>` for the gated ones — which left 42 of 65
//    operations with NO WAY TO SAY "I cannot", so for `listDomains`, `listSendKeys`,
//    `getUnreadCount`, `messageCounts` and every uniform family's `list`, an empty
//    array or a zero remained the only expressible answer. That is precisely the bug
//    this seam exists to remove, so the split rule is gone: the refusal channel is
//    universal, and a caller cannot reach `.value` without checking `ok` first.
//    Operations that are ALSO capability-gated name their capability in their doc
//    comment; for those, a false capability makes the typed refusal the ONLY legal
//    answer.
//
// SCOPE IS NEVER AN ARGUMENT. No signature below takes a tenant id. In the Postgres
// store the tenant is fixed at construction, which is why unscoped access there is a
// compile error rather than a runtime check; the seam preserves that by making an
// already-scoped store the only thing a caller can hold.

import type { Outcome } from "./outcome.js";
import type {
  AddressInput,
  AddressOwnershipPatch,
  AddressPatch,
  AddressProvisioningPatch,
  AddressRecord,
  AddressSendability,
  AttachmentInventoryItem,
  AttachmentMeta,
  DomainInput,
  DomainPatch,
  DomainProvisioningPatch,
  DomainRecord,
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
  MintedSendKey,
  OutboundPolicyCode,
  OutboundPolicyDecision,
  OutboundPolicyInput,
  Page,
  ResourceInput,
  ResourceRow,
  SendIntentCancellationResult,
  SendIntentLookupResult,
  SendKeyRecord,
  StoredAttachmentLookup,
  ThreadRollup,
} from "./records.js";

// ---- domains and addresses --------------------------------------------------

export interface DomainsRepository {
  listDomains(opts?: ListOptions): Promise<Outcome<DomainRecord[]>>;
  getDomain(id: string): Promise<Outcome<DomainRecord | null>>;
  /**
   * Look up by name WITHIN the caller's scope. The scoping is the contract, not an
   * optimization: an unscoped name lookup both leaks another tenant's domain and
   * wrongly blocks per-tenant registration of the same name.
   */
  getDomainByName(domain: string): Promise<Outcome<DomainRecord | null>>;
  createDomain(input: DomainInput): Promise<Outcome<DomainRecord>>;
  updateDomain(id: string, patch: DomainPatch): Promise<Outcome<DomainRecord | null>>;
  deleteDomain(id: string): Promise<Outcome<boolean>>;
}

export interface AddressesRepository {
  listAddresses(opts?: ListOptions): Promise<Outcome<AddressRecord[]>>;
  getAddress(id: string): Promise<Outcome<AddressRecord | null>>;
  createAddress(input: AddressInput): Promise<Outcome<AddressRecord>>;
  updateAddress(id: string, patch: AddressPatch): Promise<Outcome<AddressRecord | null>>;
  deleteAddress(id: string): Promise<Outcome<boolean>>;
}

export interface AddressLifecycleRepository {
  suspendAddress(id: string): Promise<Outcome<AddressRecord | null>>;
  activateAddress(id: string): Promise<Outcome<AddressRecord | null>>;
  /** A null quota clears the limit. */
  setAddressQuota(id: string, dailyQuota: number | null): Promise<Outcome<AddressRecord | null>>;
  applyAddressOwnership(id: string, patch: AddressOwnershipPatch): Promise<Outcome<AddressRecord | null>>;
  /**
   * Capability: `outboundPolicy`.
   *
   * Gated because "sendable" is a POLICY answer — registration, readiness, quota,
   * warming, suppression — and a store that cannot evaluate policy must refuse the
   * question rather than answer `sendable: true`. "No policy configured" and "policy
   * passed" are different facts, and conflating them is how an unverified sender
   * gets through.
   */
  getAddressSendability(email: string): Promise<Outcome<AddressSendability>>;
}

export interface ProvisioningRepository {
  applyDomainProvisioning(id: string, patch: DomainProvisioningPatch): Promise<Outcome<DomainRecord | null>>;
  applyAddressProvisioning(id: string, patch: AddressProvisioningPatch): Promise<Outcome<AddressRecord | null>>;
  recordProvisioningEvent(event: ResourceInput): Promise<Outcome<ResourceRow>>;
  listProvisioningEvents(opts?: ListOptions): Promise<Outcome<ResourceRow[]>>;
}

// ---- messages ---------------------------------------------------------------

export interface MessagesRepository {
  /**
   * Capability: `keysetPagination`.
   *
   * Gated on the PAGE CONTRACT, not on listing. A store that can only do
   * LIMIT/OFFSET over a non-total sort order silently returns duplicates and skips
   * rows as pages advance, so it must refuse rather than hand back a page it cannot
   * make stable.
   */
  listMessages(opts?: ListMessagesOptions): Promise<Outcome<Page<MessageListRecord>>>;
  getMessage(id: string): Promise<Outcome<MessageRecord | null>>;
  /**
   * Resolve a possibly-abbreviated id.
   *
   * An `Outcome` rather than the tri-state `{ id } | { ambiguous: true } | null` the
   * server currently returns: "no such message" and "your prefix matched several" are
   * different refusals (404 vs 409) and every caller has to tell them apart, which a
   * bare null cannot express.
   */
  resolveMessageId(idOrPrefix: string): Promise<Outcome<{ id: string }>>;
  createMessage(input: MessageInput): Promise<Outcome<MessageRecord>>;
  /** Idempotent write keyed on `source_id`; reports whether a row was inserted. */
  upsertMessage(input: MessageInput): Promise<Outcome<{ record: MessageRecord; inserted: boolean }>>;
  updateMessageStatus(id: string, patch: MessageStatusPatch): Promise<Outcome<MessageRecord | null>>;
  deleteMessage(id: string): Promise<Outcome<boolean>>;
  messageCounts(opts?: { domains?: string[] }): Promise<Outcome<MessageCountsRecord>>;
  /** Capability: `rawMessage`. */
  getMessageRaw(id: string): Promise<Outcome<MessageRaw | null>>;
}

export interface EmailContentRepository {
  /**
   * Capability: `attachmentContent`.
   *
   * The three-state lookup is preserved through the refusal boundary: a store that
   * HAS the capability still distinguishes "available" from "we hold metadata but not
   * the bytes", and a store that lacks it refuses. Collapsing either into null is the
   * exact lie this seam exists to prevent.
   */
  getMessageAttachment(id: string, index: number): Promise<Outcome<StoredAttachmentLookup | null>>;
  /** Capability: `keysetPagination` (the inventory is a resumable keyset scan). */
  listAttachments(opts?: ListAttachmentsOptions): Promise<Outcome<Page<AttachmentInventoryItem>>>;
  /** Capability: `attachmentContent` (reports per-row content availability). */
  listAttachmentsForMessageIds(ids: string[]): Promise<Outcome<Record<string, AttachmentMeta[]>>>;
}

/**
 * The inbox surface.
 *
 * DERIVATION NOTE, and it is a finding rather than a decision: this family exists
 * because the SQLite arm keeps inbound mail in a SEPARATE TABLE. The strongest arm
 * does not — it serves the inbox from the same messages table using `direction` and
 * folder predicates, which is why the operations below are expressed as folder-scoped
 * message reads and flag writes rather than as their own storage. The family boundary
 * is therefore a storage artifact that is scheduled to collapse into
 * `MessagesRepository`; it is kept separate here only so this PR maps 1:1 onto
 * today's `src/db/*` families and stays reviewable.
 */
export interface InboundRepository {
  /** Capability: `keysetPagination`. */
  listInbound(opts?: ListMessagesOptions): Promise<Outcome<Page<MessageListRecord>>>;
  getUnreadCount(): Promise<Outcome<number>>;
  setInboundRead(id: string, read: boolean): Promise<Outcome<MessageRecord | null>>;
  setInboundStarred(id: string, starred: boolean): Promise<Outcome<MessageRecord | null>>;
  setInboundArchived(id: string, archived: boolean): Promise<Outcome<MessageRecord | null>>;
  addInboundLabel(id: string, label: string): Promise<Outcome<MessageRecord | null>>;
  removeInboundLabel(id: string, label: string): Promise<Outcome<MessageRecord | null>>;
  /** Deletes within scope only; returns the number of rows removed. */
  clearInboundEmails(opts?: { domains?: string[] }): Promise<Outcome<number>>;
}

export interface ThreadsRepository {
  /** Capability: `mailRollups`. */
  listThreads(opts?: ListOptions): Promise<Outcome<ThreadRollup[]>>;
  /** Capability: `mailRollups`. */
  listMailboxes(): Promise<Outcome<{ mailboxes: MailboxRollup[]; counts: MessageCountsRecord }>>;
}

/**
 * The idempotency-fenced send ledger.
 *
 * Every operation is gated on `sendIntentLedger` because the fence is only real with
 * transactions and advisory locks. A store without them cannot approximate this: a
 * non-atomic "reserve" hands the same intent to two senders and mails the message
 * twice, which is strictly worse than refusing to accept the send at all.
 */
export interface SendIntentsRepository {
  /** Capability: `sendIntentLedger`. */
  lookupSendIntent(key: string): Promise<Outcome<SendIntentLookupResult>>;
  /** Capability: `sendIntentLedger`. */
  reserveSendIntent(key: string, input: MessageInput): Promise<Outcome<MessageRecord>>;
  /** Capability: `sendIntentLedger`. */
  claimSendIntent(id: string): Promise<Outcome<MessageRecord | null>>;
  /** Capability: `sendIntentLedger`. */
  completeSendIntent(id: string, providerMessageId: string): Promise<Outcome<MessageRecord>>;
  /** Capability: `sendIntentLedger`. */
  markSendFailed(id: string, reason: string): Promise<Outcome<MessageRecord | null>>;
  /** Capability: `sendIntentLedger`. */
  cancelSendIntent(key: string): Promise<Outcome<SendIntentCancellationResult>>;
  /** Capability: `sendIntentLedger`. */
  listUncertainSendIntents(opts?: ListOptions): Promise<Outcome<MessageRecord[]>>;
  /** Capability: `sendIntentLedger`. */
  markSendUncertain(id: string, providerMessageId?: string | null): Promise<Outcome<MessageRecord | null>>;
  /** Capability: `sendIntentLedger`. Re-arms a DEFINITIVE provider reject for retry. */
  rearmFailedSendIntent(id: string): Promise<Outcome<MessageRecord | null>>;
  /** Capability: `sendIntentLedger`. */
  reconcileUncertainSendIntent(id: string, evidence: string): Promise<Outcome<MessageRecord | null>>;
  /** Capability: `outboundPolicy`. Records WHY a send was refused, using the policy code. */
  markSendBlocked(id: string, reason: OutboundPolicyCode): Promise<Outcome<MessageRecord | null>>;
  /**
   * Capability: `outboundPolicy`.
   *
   * The operation `Outcome` was modelled on. Its decision — allowed, or a `code` +
   * `message` + `status` refusal — is where the refusal vocabulary in outcome.ts came
   * from, so leaving it off the seam would have declared a capability with nothing
   * behind it. Note the double discriminant: `Outcome` says whether the store could
   * EVALUATE the policy, and the value says whether the policy ALLOWS the send. A store
   * that cannot evaluate must refuse the outer one, never allow the inner one.
   */
  evaluateOutboundPolicy(input: OutboundPolicyInput): Promise<Outcome<OutboundPolicyDecision>>;
}

// ---- send keys --------------------------------------------------------------

export interface SendKeysRepository {
  listSendKeys(opts?: ListOptions): Promise<Outcome<SendKeyRecord[]>>;
  getSendKey(id: string): Promise<Outcome<SendKeyRecord | null>>;
  /** The plaintext token is returned once, here, and is never readable again. */
  mintSendKey(input: { owner_id: string; label?: string | null }): Promise<Outcome<MintedSendKey>>;
  /** Returns null for an unknown, malformed, or revoked token. */
  verifySendKey(token: string): Promise<Outcome<SendKeyRecord | null>>;
  revokeSendKey(id: string): Promise<Outcome<SendKeyRecord | null>>;
  /**
   * Capability: `outboundPolicy`.
   *
   * Gated for the same reason as `getAddressSendability`: a store that cannot check
   * authorization must refuse, never return `false`-as-unknown or `true`-as-default.
   */
  isOwnerAuthorizedFrom(ownerId: string, fromEmail: string): Promise<Outcome<boolean>>;
}

// ---- attachment repair ------------------------------------------------------

/**
 * Provenance-bound repair of attachment payloads. Every operation is gated on
 * `attachmentRepair`: repair rewrites stored bytes under a lease and a ledger, and a
 * store that cannot hold the lease must not perform the rewrite.
 *
 * The run/entry shapes stay `ResourceRow` in this PR. They are the one place where the
 * server's own types carry a tenant id, and the seam admits no tenant id in any
 * signature or shape; giving them typed, scope-free equivalents is part of migrating
 * this family rather than of declaring the seam.
 */
export interface AttachmentRepairRepository {
  /** Capability: `attachmentRepair`. */
  createOrGetAttachmentRepairRun(input: ResourceInput): Promise<Outcome<ResourceRow>>;
  /** Capability: `attachmentRepair`. */
  getAttachmentRepairRun(runId: string): Promise<Outcome<ResourceRow | null>>;
  /** Capability: `attachmentRepair`. */
  listPendingAttachmentRepairEntries(runId: string, limit?: number): Promise<Outcome<ResourceRow[]>>;
  /** Capability: `attachmentRepair`. */
  claimAttachmentRepairEntry(runId: string, entryId: string): Promise<Outcome<ResourceRow | null>>;
  /** Capability: `attachmentRepair`. */
  recordAttachmentRepairEntryOutcome(entryId: string, result: ResourceInput): Promise<Outcome<ResourceRow>>;
}

// ---- the uniform tenant-scoped resource families ----------------------------

/**
 * The shape the strongest arm serves ten-plus families through: one generic,
 * tenant-scoped CRUD path whose per-resource columns, filters and ordering come from
 * a spec table.
 *
 * This is a generic TYPE ALIAS, and the distinction from a base class is exact and
 * load-bearing. An alias has no runtime identity, supplies no method body, and is
 * structurally invisible — every implementation must still declare every method, so
 * `tsc` still fails on a missing one. What is banned is inheritance: a parent whose
 * default body can answer a call the child never implemented. Writing these families
 * out longhand instead would be fifteen near-identical blocks whose drift no test
 * would catch, which is a worse failure than the one being avoided.
 */
export type ResourceRepository<TRow> = {
  list(opts?: ListOptions & { filters?: Record<string, string> }): Promise<Outcome<TRow[]>>;
  get(id: string): Promise<Outcome<TRow | null>>;
  create(input: ResourceInput): Promise<Outcome<TRow>>;
  update(id: string, patch: ResourceInput): Promise<Outcome<TRow | null>>;
  remove(id: string): Promise<Outcome<boolean>>;
};

// One named repository per family, so `EmailStore` maps 1:1 onto today's `src/db/*`
// and a reviewer can check the correspondence by eye. The row type is `ResourceRow`
// for now BY DESIGN, not by omission: the column list already has a single source of
// truth in the server's resource spec table, and hand-copying it here would create a
// second one that goes stale silently. Each family's typed row (and with it a
// genuinely distinct repository type) lands with that family's migration, next to the
// code that maps it.
export type ContactsRepository = ResourceRepository<ResourceRow>;
export type GroupsRepository = ResourceRepository<ResourceRow>;
export type OwnersRepository = ResourceRepository<ResourceRow>;
export type ProvidersRepository = ResourceRepository<ResourceRow>;
export type TemplatesRepository = ResourceRepository<ResourceRow>;
export type SequencesRepository = ResourceRepository<ResourceRow>;
export type ScheduledRepository = ResourceRepository<ResourceRow>;
export type AliasesRepository = ResourceRepository<ResourceRow>;
export type ForwardingRepository = ResourceRepository<ResourceRow>;
export type WarmingRepository = ResourceRepository<ResourceRow>;
export type EventsRepository = ResourceRepository<ResourceRow>;
export type EmailDigestsRepository = ResourceRepository<ResourceRow>;
export type WebhookReceiptsRepository = ResourceRepository<ResourceRow>;
export type SandboxRepository = ResourceRepository<ResourceRow>;
