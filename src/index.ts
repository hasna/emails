// Public API — types
export type {
  Provider,
  ProviderSummary,
  ProviderType,
  CreateProviderInput,
  Domain,
  DnsStatus,
  DnsRecord,
  DnsPublishingSupport,
  EmailAddress,
  CreateAddressInput,
  Attachment,
  SendEmailOptions,
  Email,
  EmailStatus,
  EmailEvent,
  EventSummary,
  EventType,
  Stats,
  EmailFilter,
  EventFilter,
} from "./types/index.js";

export {
  ProviderNotFoundError,
  DomainNotFoundError,
  AddressNotFoundError,
  EmailNotFoundError,
  ProviderConfigError,
} from "./types/index.js";

// DB functions
export {
  createProvider,
  getProvider,
  listProviders,
  listProviderSummaries,
  updateProvider,
  deleteProvider,
  getActiveProvider,
} from "./db/providers.js";

export {
  createDomain,
  getDomain,
  getDomainByName,
  listDomains,
  updateDomain,
  deleteDomain,
  updateDnsStatus,
} from "./db/domains.js";

export {
  createAddress,
  getAddress,
  getAddressByEmail,
  listAddresses,
  updateAddress,
  deleteAddress,
  markVerified,
} from "./db/addresses.js";

// THE SENT-LEDGER FAMILY CHANGED SHAPE IN FOUR WAYS, and this is a published entry point, so
// the break is stated here rather than only in the commit that caused it.
//
//  * ALL SIX ARE ASYNC now, because they read through the store seam and every seam operation
//    is a promise. This is the dangerous half of the break, because it fails QUIETLY in a
//    consumer that does not await: `email.status` on a promise is `undefined`, `if (email)` is
//    always truthy, and `emails.length` is `undefined` — so a "no such email" branch becomes
//    unreachable and an empty ledger renders as `undefined`.
//  * THEIR LAST PARAMETER IS WIDENED, NOT REPLACED. `getEmail(id, store?)`,
//    `listEmails(filter?, store?)`, `searchEmails(query, opts?, store?)`,
//    `updateEmailStatus(id, status, store?)` and `deleteEmail(id, store?)` now take an
//    `EmailStore` OR the `Database` this surface has published for its whole 1.x life. An
//    earlier revision of this change NARROWED it to `EmailStore`, which is a breaking change
//    to a released entrypoint; the synthetic-consumer gate below caught it. A `Database` now
//    becomes a SQLite store bound to that handle, so the parameter finally means what it has
//    always said — the deleted facade used the handle's PRESENCE to pick an arm.
//  * `createEmail` NOW REFUSES, ALWAYS, by throwing. No store behind this package can write a
//    provider-scoped sent-ledger row: `MessageInput` carries no `provider_id`, `bcc_addrs`,
//    `reply_to` or `tags`, both stores refuse an `idempotency_key`, and the SQLite store writes
//    messages to a table that `email_content` and `events` do not hold foreign keys into. See
//    `src/db/emails.ts` for the four checks and the two seam widenings that would bring it
//    back. A local installation still records a send through `createSentEmailLedger`.
//  * THREE FIELDS ON `Email` ARE NULLABLE now — `provider_id`, `bcc_addresses` and `tags` —
//    because no message projection on the seam publishes them, and `null` there means "this
//    store does not record it" rather than the `"self_hosted"` / `[]` / `{}` the deleted HTTP
//    arm invented. A consumer that renders `bcc_addresses.length` or spreads `tags` breaks at
//    compile time, which is the point. `listEmails` also REFUSES a `provider_id` filter for
//    the same reason, rather than ignoring it and returning another provider's mail.
//
// These need a MAJOR version at release. The version is deliberately not bumped in the change
// that introduced them, and `CHANGELOG.md`'s `[Unreleased]` section is digest-frozen, so this
// comment and the pull request are where the break is recorded.
export {
  createEmail,
  getEmail,
  listEmails,
  searchEmails,
  updateEmailStatus,
  deleteEmail,
} from "./db/emails.js";

// ALL SIX OF THESE ARE ASYNC NOW, and this is a published entry point, so the break is
// stated here rather than only in the commit that caused it. The events family reads and
// writes through the store seam and every seam operation is a promise. The dangerous
// consumer is one that does not await: `listEvents(...).length` on a promise is
// `undefined` and `if (getEvent(id))` is always truthy — the fabricated-value failure
// mode this refactor exists to remove, so it must not go unannounced. Two behavioural
// changes ride along, both toward honesty: an unfiltered listing REFUSES (throws) when
// the table cannot be fully enumerated instead of returning a short set that looks
// complete, and `createEvent` returns the row the store actually holds instead of an
// echo of its input (see src/db/events.ts for both).
export {
  createEvent,
  getEvent,
  listEvents,
  listEventSummaries,
  getEventsByEmail,
  upsertEvent,
} from "./db/events.js";

// BOTH OF THESE CHANGED SHAPE, and this is a published entry point, so the break is stated
// here rather than only in the commit that caused it.
//
//  * `getEmailContent` is ASYNC now. It reads through the store seam and every seam operation
//    is a promise. This is the dangerous half of the break, because it fails QUIETLY in a
//    consumer that does not await: `content.text_body` on a promise is `undefined`, and
//    `if (content)` is always truthy, so a caller's "no body" branch becomes unreachable and a
//    body renders as the text `undefined`. That is the fabricated-value failure mode this
//    refactor exists to remove, so it must not go unannounced.
//  * `storeEmailContent` now REFUSES, always, by throwing `EmailContentWriteUnsupportedError`.
//    No store behind this package can write a body onto an existing message — see
//    `src/db/email-content.ts` for the six checks and for what should replace it. The error
//    TYPE is exported below precisely so a consumer can catch this and nothing else, rather
//    than string-matching a message or catching every `Error`.
//
// Both need a MAJOR version at release. The version is deliberately not bumped in the change
// that introduced them, and `CHANGELOG.md`'s `[Unreleased]` section is digest-frozen, so this
// comment and the pull request are where the break is recorded.
export {
  storeEmailContent,
  getEmailContent,
  EmailContentWriteUnsupportedError,
  type EmailContent,
  type EmailContentInput,
} from "./db/email-content.js";

export {
  upsertContact, getContact, listContacts, suppressContact,
  unsuppressContact, incrementSendCount, incrementBounceCount,
  incrementSendCounts, incrementBounceCounts, incrementComplaintCount,
  incrementComplaintCounts, isContactSuppressed,
  getSuppressedEmailSet,
} from "./db/contacts.js";

export {
  createTemplate, getTemplate, getTemplateByName, listTemplates, listTemplateSummaries,
  deleteTemplate, renderTemplate,
} from "./db/templates.js";
export type { Template, TemplateSummary } from "./db/templates.js";

export {
  createGroup, getGroup, getGroupByName, listGroups, deleteGroup,
  addMember, removeMember, listMembers, listMemberSummaries, getMember,
  getMemberCount, getMemberCounts,
} from "./db/groups.js";
export type { GroupMember, GroupMemberSummary } from "./db/groups.js";

export {
  createOwner, getOwner, getOwnerByName, listOwners,
  getOwnerByExternalId, getOwnerByContactEmail,
  assignAddressOwner, transferAddressOwner, unassignAddressOwner,
  getAddressOwnership, listAddressOwnershipEvents, getAddressOwnershipEvent,
  listAddressesByOwner,
} from "./db/owners.js";
export type {
  Owner, OwnerType, CreateOwnerInput, AddressOwnership,
  AddressOwnershipAction, AddressOwnershipEvent,
} from "./db/owners.js";

// ALL NINE VALUES BELOW CHANGED SHAPE, and this is a published entry point, so the break is
// stated here rather than only in the commit that caused it. The send-key family collapsed onto
// the store seam; there are THREE separate breaks and a consumer has to apply all three.
//
//  1. EVERY ONE IS ASYNC. `createSendKey`, `getSendKey`, `verifySendKey`, `listSendKeys`,
//     `listSendKeySummaries`, `listSendKeySummariesByOwners`, `revokeSendKey`,
//     `canOwnerSendFrom` and `assertSendAuthorized` all return promises now, because every
//     operation on the seam does. This is the half that fails QUIETLY in a consumer that does
//     not await: `key.revoked_at` on a promise is `undefined`, `if (key)` is always truthy, and
//     `if (canOwnerSendFrom(...))` — a SEND-SCOPE GATE — is truthy for a promise that resolves
//     to `false`. That last one is an authorization bypass in a consumer that forgets the
//     `await`, so it is named first and named loudly.
//  2. `SendKey` NO LONGER CARRIES `key_hash`, and `SendKeySummary` is now an alias of it. The
//     field held the real SHA-256 on a local installation and a fabricated `""` on a
//     self-hosted one; the seam's record has no hash at all and the service redacts the
//     column, so reading `.key_hash` is now a compile error rather than a comparison that
//     silently never matches. `owner_id` and `prefix` are `string | null` (the seam's
//     nullability — a key outlives a deleted owner), and `updated_at` is new.
//  3. THE THIRD ARGUMENT IS A STORE, NOT A DATABASE HANDLE. `createSendKey(ownerId, label,
//     store?)`, `getSendKey(id, store?)`, `revokeSendKey(id, store?)`,
//     `canOwnerSendFrom(ownerId, from, store?)`, `assertSendAuthorized(token, from, store?)`.
//     The two owner-scoped listings are `(ownerId?, opts?, store?)` — the shape the facade
//     already published — and `listSendKeySummariesByOwners(ownerIds, store?)`.
//
// WHAT IS NOT A BREAK, because a reader will look for it: the listings still answer newest
// first, `revokeSendKey` still answers `false` for an unknown OR an already-revoked key, and
// `verifySendKey` still answers `null` for an unknown, malformed or revoked token.
export {
  createSendKey, getSendKey, verifySendKey, listSendKeys, listSendKeySummaries,
  listSendKeySummariesByOwners,
  revokeSendKey, canOwnerSendFrom, assertSendAuthorized,
} from "./db/send-keys.js";
export type { SendKey, SendKeySummary } from "./db/send-keys.js";

// EVERY VALUE EXPORTED BELOW CHANGED SHAPE, and this is a published entry point, so the break
// is stated here rather than only in the commit that caused it. #124 recorded its breaks in this
// file; #125 carried more of them and recorded none, because it never touched this file.
//
// The trap is that the seven exports did not move together. FIVE went through the store seam and
// TWO stayed on raw SQLite and got stricter instead, so there is no single rule a consumer can
// apply to this block.
//
//  * FIVE ARE ASYNC now — `createForwardingRule`, `getForwardingRule`, `listForwardingRules`,
//    `setForwardingRuleEnabled`, `removeForwardingRule` — because they read and write through
//    the store seam and every seam operation is a promise. This is the dangerous half, for the
//    same reason as `getEmailContent` above: it fails QUIETLY in a consumer that does not await.
//    `rule.enabled` on a promise is `undefined`, `if (rule)` is always truthy, so a "no such
//    rule" branch becomes unreachable and a disabled rule reads as enabled.
//  * THE SAME FIVE changed their STORE PARAMETER TYPE from `Database` to `EmailStore` — the
//    SECOND parameter for four of them and the THIRD for `setForwardingRuleEnabled`, whose
//    signature is `(id, enabled, store?)` (`src/db/forwarding.ts:457,526,559,588,610`). Passing
//    a `Database` handle — the documented way to scope these to one database — now passes a
//    value of the wrong type.
//  * TRANSACTION SCOPING IS GONE, not merely retyped. `runInTransaction`
//    (`src/db/database.ts:2723`) is `runInTransaction<T>(db, fn: () => T): T` — synchronous,
//    SAVEPOINT-based, with no async variant. So the five above can no longer be scoped in a
//    transaction at all: an `async` callback returns a promise that the SAVEPOINT commits
//    around rather than waits for. This is the one break here with no compile-time signal and
//    no runtime error — the writes simply land outside the transaction that appears to hold
//    them.
//  * `listPendingForwarding` and `recordForwardingDelivery` are still SYNCHRONOUS and still take
//    a raw `Database`, but that argument is now REQUIRED (`:652-655`, `:701-703`). It used to be
//    optional and defaulted to `getDatabase()`.
//  * `listPendingForwarding` also lost its `limit = 100` default, so its FIRST argument is
//    required too. A `listPendingForwarding()` call that worked now throws — and it throws from
//    the finite-limit guard at `:657` (`Pending-forwarding limit must be a finite number.`),
//    NOT from a property access on the missing database handle, which is never reached.
//  * `listPendingForwarding(limit, opts)` — options as the SECOND argument, no database — was a
//    WORKING PUBLISHED CALL FORM and is now a type error that passes `opts` where a `Database`
//    is required. The pre-#125 published module was the routing barrel
//    (`4691c5d^1:src/db/forwarding.ts`), whose `localCompat` shim was literally
//    `listPendingForwarding: (limit, opts) => local.listPendingForwarding(limit, undefined, opts)`.
//    That shim served every non-self-hosted caller that did not pass a handle, and the barrel's
//    `as typeof remote` cast meant the PUBLISHED TYPE was the remote arm's signature, not the
//    local arm's. Verifying this block against `forwarding.local.ts` instead of that barrel is
//    how the break was missed the first time.
//
// All of it needs a MAJOR version at release. The version is deliberately not bumped in the
// change that introduced them, and `CHANGELOG.md`'s `[Unreleased]` section is digest-frozen, so
// this comment and the pull request are where the break is recorded.
export {
  createForwardingRule, getForwardingRule, listForwardingRules,
  setForwardingRuleEnabled, removeForwardingRule, listPendingForwarding,
  recordForwardingDelivery,
} from "./db/forwarding.js";
export type {
  ForwardingRule, ForwardingDelivery, ForwardingMode,
  ForwardingDeliveryStatus, PendingForwarding,
} from "./db/forwarding.js";

export {
  createScheduledEmail, listScheduledEmails, listScheduledEmailSummaries, getScheduledEmail,
  cancelScheduledEmail, getDueEmails, markSent, markFailed,
} from "./db/scheduled.js";
export type { ScheduledEmail, ScheduledEmailSummary } from "./db/scheduled.js";

// SHAPE CHANGES ON ALL SIX, recorded here because this is the published surface.
//
//  * ALL SIX ARE NOW ASYNC. Both deleted arms were synchronous; every operation on the store
//    seam returns a promise, so these return promises too. An un-awaited call is TRUTHY, so a
//    consumer that forgets `await` reads a pending promise as a captured email and its fields
//    as `undefined` — without necessarily failing to compile.
//  * THE TRAILING `db?: Database` SLOT IS NOW `store?: EmailStore` on all six, and
//    `listSandboxEmails` / `listSandboxEmailSummaries` lose the `Database | number` third
//    parameter that reconciled two incompatible arm signatures: their third parameter is the
//    offset, and the store is fourth.
//  * `getSandboxCount` RETURNS `Promise<number | null>` rather than `Promise<number>`. The
//    seam publishes no aggregate, so a count is a bounded enumeration; `null` means the
//    enumeration did not reach the end of the table and any number would be a lower bound
//    rather than a total. It is never `0` for that case — a refusal or a fault throws — and
//    the reason a bound is not published as a bare number is in `src/db/sandbox.ts`,
//    divergence 8.
export {
  storeSandboxEmail, listSandboxEmails, listSandboxEmailSummaries, getSandboxEmail,
  clearSandboxEmails, getSandboxCount,
} from "./db/sandbox.js";

// Runtime utilities and first-class local SQLite lifecycle.
export { uuid, now } from "./db/runtime.js";
export { resolveResourceId, resolveResourceIdOrThrow, listResourceIdMatches } from "./db/self-hosted-store.js";
export {
  closeDatabase,
  databaseFileExists,
  getDatabase,
  getDatabasePath,
  isDatabaseOpen,
  listPartialIdMatches,
  resetDatabase,
  resolvePartialId,
  resolvePartialIdOrThrow,
  runInTransaction,
} from "./db/database.js";
export type { Database } from "./db/database.js";

// Lib functions
export { getLocalStats, formatStatsTable } from "./lib/stats.js";
// `StatsReport` is what `getLocalStats` returns, and it is NOT `Stats` (below, from
// src/types/index.ts, which stays the shape a provider adapter reports). Its counts and
// rates are nullable, and it carries why: measured through the store seam, a figure is a
// total, a lower bound, or absent with a reason. A consumer that cannot name the type
// cannot narrow those nulls.
export type { StatsEventType, StatsReport } from "./lib/stats.js";
export { generateSpfRecord, generateDmarcRecord, formatDnsTable } from "./lib/dns.js";
export { getAnalytics, formatAnalytics } from "./lib/analytics.js";
export { parseCsv } from "./lib/csv.js";
export { extractEmailLinks, formatEmailLinks } from "./lib/email-links.js";
export type { ExtractEmailLinksInput, ExtractedEmailLink, EmailLinkSource } from "./lib/email-links.js";
export {
  DEFAULT_ATTACHMENT_DOWNLOAD_BYTES,
  MAX_ATTACHMENT_DOWNLOAD_BYTES,
  decodeAttachmentPayload,
  normalizeAttachmentByteLimit,
  validateAttachmentFilename,
  writeAttachmentFile,
} from "./lib/attachment-download.js";
export type {
  AttachmentContent,
  AvailableAttachmentContent,
  MissingAttachmentContent,
  SavedAttachment,
  UnavailableAttachmentContent,
} from "./lib/attachment-download.js";
export {
  formatEmailDigest,
  generateEmailDigest,
  loadEmailDigest,
  resolveEmailDigestWindow,
} from "./lib/email-digest.js";
export type {
  EmailDigestWindow,
  GenerateEmailDigestOptions,
  LoadEmailDigestOptions,
} from "./lib/email-digest.js";
export {
  emailDigestPeriodLabel,
  getEmailDigest,
  getLatestEmailDigest,
  listEmailDigests,
  normalizeEmailDigestPeriod,
  saveEmailDigest,
} from "./db/email-digests.js";
export type {
  EmailDigest,
  EmailDigestPeriod,
  EmailDigestProvider,
  EmailDigestStatus,
  ListEmailDigestsOptions,
  SaveEmailDigestInput,
} from "./db/email-digests.js";
export { formatDnsCheck } from "./lib/dns-check-format.js";
export type { DnsCheckResult } from "./lib/dns-check-format.js";
export { formatDiagnostics } from "./lib/diagnostics-format.js";
export type { DoctorCheck } from "./lib/diagnostics-format.js";
// PUBLISHED SHAPE CHANGE, recorded at the export site.
//
// EIGHT of the exports below became ASYNCHRONOUS when `src/db/provisioning` collapsed onto
// the store seam: `buildDomainLifecycleSummary`, `buildDomainLifecycleSummaries`,
// `listDomainLifecycleSummaries`, `getDomainLifecycleSummary`,
// `updateDomainLifecycleReadiness`, `enableDomainInboundReadiness`,
// `enableDomainOutboundReadiness` and `disableDomainOutboundReadiness`. Every lifecycle
// summary carries the domain's provisioning columns and its ready-address count, and both now
// come from `src/store/`, where every operation returns a promise. `createDomainReadinessService`
// is unchanged as a function and its three METHODS return promises, which the
// `DomainReadinessService` interface declares.
//
// A caller that does not `await` them gets a promise, and a promise is TRUTHY — so
// `if (getDomainLifecycleSummary(id).readiness.send_ready)` is now a type error, but
// `enableDomainInboundReadiness(id)` on its own is a silently floating write. The three
// affected routes in `src/server/routes/core.ts` are awaited; two of those three did NOT
// produce a `tsc` error, because `json(data: unknown)` accepts a promise and serialises it
// as `{}`.
//
// `assessDomainLifecycleReadiness`, `defaultDomainSourceOfTruth` and
// `resolveDomainLifecycleRecord` are unchanged: none of them reads provisioning state.
export {
  assessDomainLifecycleReadiness,
  buildDomainLifecycleSummaries,
  buildDomainLifecycleSummary,
  createDomainReadinessService,
  defaultDomainSourceOfTruth,
  disableDomainOutboundReadiness,
  enableDomainInboundReadiness,
  enableDomainOutboundReadiness,
  getDomainLifecycleSummary,
  listDomainLifecycleSummaries,
  resolveDomainLifecycleRecord,
  updateDomainLifecycleReadiness,
} from "./lib/domain-readiness-service.js";
export type {
  BuildDomainLifecycleSummaryOptions,
  DomainDnsLifecycleStatus,
  DomainLifecycleReadiness,
  DomainLifecycleSummary,
  DomainReadinessMutationInput,
  DomainReadinessMutationResult,
  DomainReadinessProviderSummary,
  DomainReadinessService,
  ListDomainLifecycleSummaryOptions,
  ResolveDomainLifecycleOptions,
} from "./lib/domain-readiness-service.js";
export {
  assessDomainReadiness,
  formatDomainReadinessState,
} from "./lib/domain-readiness.js";
export type {
  DomainReadiness,
  DomainReadinessSignals,
  DomainReadinessState,
} from "./lib/domain-readiness.js";
export {
  domainInboundReadinessSignals,
  listDomainLiveS3Sources,
} from "./lib/domain-inbound-evidence.js";
export { exportEmailsCsv, exportEmailsJson, exportEventsCsv, exportEventsJson } from "./lib/export.js";
export {
  CANONICAL_OPEN_EMAILS_S3_BUCKET,
  CANONICAL_OPEN_EMAILS_S3_REGION,
  CANONICAL_OPEN_EMAILS_SECRET_PATHS,
  CANONICAL_OPEN_EMAILS_RDS_CLUSTER,
  CANONICAL_OPEN_EMAILS_RDS_DATABASE,
  CANONICAL_OPEN_EMAILS_RDS_SECRET_PATH,
  getCanonicalOpenEmailsRdsConfig,
  getInboundAttachmentStorageConfig,
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  setAgentConfigValue,
  AGENT_WRITABLE_CONFIG_KEYS,
  isAgentWritableConfigKey,
  agentConfigKeyRefusal,
  getDefaultProviderId,
} from "./lib/config.js";
export { log, setLogLevel } from "./lib/logger.js";
export { colorStatus, colorDnsStatus, truncate, formatDate } from "./lib/format.js";
export { formatVerifyResult } from "./lib/email-verify-format.js";
export type { VerifyResult } from "./lib/email-verify-format.js";
export {
  formatProviderHealth,
} from "./lib/provider-health-format.js";
export type { ProviderHealth } from "./lib/provider-health-format.js";

// New modules (v0.4.x)
export {
  verifyResendSignature, verifySnsStructure,
  parseResendWebhook, parseSesWebhook,
} from "./lib/webhook-events.js";
export type { WebhookEvent } from "./lib/webhook-events.js";
// NO SHAPE CHANGED HERE AND THE BEHAVIOUR DID, recorded at the export site by the convention the
// forwarding block below established. `createWebhookServer` keeps its name, its four parameters
// and its `Bun.Server` return — the facade published the local arm's declaration, so what a
// consumer compiled against is what it still compiles against. The four pure parsers/verifiers
// re-exported above are untouched and were identical in both deleted arms.
//
// WHAT CHANGED IS WHICH CONFIGURATIONS STAND UP A LISTENER. The deleted second arm threw for an
// API-configured installation, and that refusal is PRESERVED — but it is now decided by STORAGE
// CONFIGURATION rather than by the deployment word, and the two do not agree everywhere.
//
// SIX CLASSES NEWLY REFUSE and ONE NEWLY SUCCEEDS, measured over a 648-combination grid and
// enumerated with counts in `src/lib/webhook.ts`'s header. Since `CHANGELOG.md`'s `[Unreleased]`
// section is digest-frozen and the version is not bumped, THIS COMMENT IS THE CHANGELOG for the
// break, so the classes are listed here in full rather than summarised — an earlier version of this
// note said "five configurations" and omitted the largest one, which is the single most likely way
// a consumer notices this release:
//
//   * A DATABASE PATH AND AN API SETTING CONFIGURED TOGETHER — 231 of the 276 changed
//     combinations, 84% of the change. Previously ran against the local database; now refused as a
//     two-store contradiction. If you set both, this is the one that will reach you.
//   * both database-path settings naming DIFFERENT files (24) — previously ran on the documented
//     `HASNA_`-wins precedence.
//   * an API url that does not parse (9).
//   * API storage, resolved (6) — the class the deleted arm existed for.
//   * an API url with no credential (3).
//   * a client-env pointer set whose API url is absent from the environment (3).
//
// And ONE newly succeeds: storage resolves to a local database while the deployment word claims a
// server-side deployment — in 21 of those 24 combinations the local database is EXPLICITLY
// configured, so this is not merely "nothing was set", and main's refusal there came from the mode
// read throwing rather than from the deleted arm.
//
// (A refused data directory also changes answer — from "bound, then 500 per callback" to a
// construction-time refusal — but it sits OUTSIDE that grid, because an untrusted ancestor is not
// an environment value; it is described in the module header rather than counted here.)
//
// A consumer that called this on an API-configured installation and got a running server now gets a
// thrown refusal instead — which is the point, because that server bound a port the provider does
// not post to and, with a stale local database present, wrote its events into a file nothing reads.
//
// The throw is at CONSTRUCTION, not per request, so a caller that treats a returned server as proof
// it can receive callbacks is still correct; a caller that never expected a throw is not. Also new
// at construction: resolving local storage CREATES AND HARDENS the data directory, which main did
// on the first callback instead.
//
// This needs a MAJOR version at release. The version is deliberately not bumped here, and
// `CHANGELOG.md`'s `[Unreleased]` section is digest-frozen, so this comment and the pull request
// are where the break is recorded.
export { createWebhookServer } from "./lib/webhook.js";
export { injectOpenPixel, injectClickTracking, prepareTrackedHtml } from "./lib/tracking.js";
export { getFailoverProviderIds } from "./lib/config.js";
export {
  resolveAddressRef, enrichAddress, listEnrichedAddresses,
  getAddressOwnershipDetail, setAddressOwnerByRef,
  transferAddressOwnerByRef, unassignAddressOwnerByRef,
  getAddressOwnershipHistoryByRef, suggestAddressLocalParts,
} from "./lib/address-ownership.js";
export type { EnrichedAddress, AddressOwnershipDetail } from "./lib/address-ownership.js";
export {
  createSequence, getSequence, listSequences, updateSequence, deleteSequence,
  addStep, listSteps, removeStep,
  enroll, unenroll, listEnrollments, getDueEnrollments, advanceEnrollment,
} from "./db/sequences.js";
export {
  storeInboundEmail, getInboundEmail, getInboundEmailSummary, listInboundEmails, listInboundEmailSummaries,
  listInboundEmailsForOwner, listInboundEmailSummariesForOwner,
  getInboundAttachmentPaths,
  setInboundReadSummary, setInboundArchivedSummary, setInboundStarredSummary,
  addInboundLabelSummary, removeInboundLabelSummary,
  getReceivedInboundCount, getLatestReceivedInboundAt,
  deleteInboundEmail, clearInboundEmails,
  listReplies, listReplySummaries, getReplyCount,
} from "./db/inbound.js";
export type { InboundEmail, InboundEmailSummary } from "./db/inbound.js";

export {
  createWarmingSchedule, getWarmingSchedule, listWarmingSchedules, updateWarmingStatus, deleteWarmingSchedule,
} from "./db/warming.js";
export { describeWarmingProgress, generateWarmingPlan, getTodayLimit, getTodaySentCount, getTodaySentCountsByDomain, formatWarmingStatus, warmingDayIndex } from "./lib/warming.js";
export type { WarmingSchedule, WarmingDay, WarmingProgress } from "./lib/warming.js";

// NO SHAPE CHANGED HERE AND THE BEHAVIOUR DID, which is the harder break to notice, so it is
// recorded at the export site by the convention the block above established. `processForwardingRules`
// (exported as a lazy wrapper further down) keeps its name, its signature, its `Promise` and all
// three of these types unchanged — the facade published the local arm's declarations, so what a
// consumer compiled against is what it still compiles against.
//
// WHAT CHANGED IS WHICH CONFIGURATIONS RUN. The deleted second arm threw for an API-configured
// installation, and that refusal is preserved — but it is now decided by STORAGE CONFIGURATION
// rather than by the deployment word, and the two do not agree everywhere. Five configurations
// answer differently, enumerated in `src/lib/forwarding.ts`'s header; four newly refuse (API
// storage with no deployment word, a stale client-secret pointer, two database paths at once, a
// refused data directory) and ONE newly RUNS (deployment word self-hosted with no storage setting
// naming anything). A consumer that called this on an API-configured installation and read
// `attempted: 0` as "nothing to forward" now gets a thrown refusal instead — which is the point,
// because that zero was a claim about mail this side never looked at.
//
// This needs a MAJOR version at release alongside the block above. The version is deliberately not
// bumped here, and `CHANGELOG.md`'s `[Unreleased]` section is digest-frozen, so this comment and
// the pull request are where the break is recorded.
export type { ForwardingRunOptions, ForwardingRunResult, ForwardingRunItem } from "./lib/forwarding.js";

// Provider factory
// `providerDnsPublishing` ships with `getAdapter` on purpose: a consumer that
// formats an adapter's records with `formatDnsTable` needs the descriptor for its
// second argument, and re-deriving the sandbox special-case is the drift the
// helper exists to prevent.
export { getAdapter, providerDnsPublishing } from "./providers/index.js";
export type { ProviderAdapter, RemoteDomain, RemoteAddress, RemoteEvent } from "./providers/interface.js";

type SyncModule = typeof import("./lib/sync.js");
type SendModule = typeof import("./lib/send.js");
type BatchModule = typeof import("./lib/batch.js");
type DoctorModule = typeof import("./lib/doctor.js");
type HealthModule = typeof import("./lib/health.js");
type DnsCheckModule = typeof import("./lib/dns-check.js");
type EmailVerifyModule = typeof import("./lib/email-verify.js");
type ForwardingModule = typeof import("./lib/forwarding.js");

export async function syncProvider(...args: Parameters<SyncModule["syncProvider"]>): Promise<Awaited<ReturnType<SyncModule["syncProvider"]>>> {
  const { syncProvider } = await import("./lib/sync.js");
  return syncProvider(...args);
}

export async function syncAll(...args: Parameters<SyncModule["syncAll"]>): Promise<Awaited<ReturnType<SyncModule["syncAll"]>>> {
  const { syncAll } = await import("./lib/sync.js");
  return syncAll(...args);
}

export async function sendWithFailover(...args: Parameters<SendModule["sendWithFailover"]>): Promise<Awaited<ReturnType<SendModule["sendWithFailover"]>>> {
  const { sendWithFailover } = await import("./lib/send.js");
  return sendWithFailover(...args);
}

export async function batchSend(...args: Parameters<BatchModule["batchSend"]>): Promise<Awaited<ReturnType<BatchModule["batchSend"]>>> {
  const { batchSend } = await import("./lib/batch.js");
  return batchSend(...args);
}

export async function runDiagnostics(...args: Parameters<DoctorModule["runDiagnostics"]>): Promise<Awaited<ReturnType<DoctorModule["runDiagnostics"]>>> {
  const { runDiagnostics } = await import("./lib/doctor.js");
  return runDiagnostics(...args);
}

export async function processForwardingRules(...args: Parameters<ForwardingModule["processForwardingRules"]>): Promise<Awaited<ReturnType<ForwardingModule["processForwardingRules"]>>> {
  const { processForwardingRules } = await import("./lib/forwarding.js");
  return processForwardingRules(...args);
}

export async function checkProviderHealth(...args: Parameters<HealthModule["checkProviderHealth"]>): Promise<Awaited<ReturnType<HealthModule["checkProviderHealth"]>>> {
  const { checkProviderHealth } = await import("./lib/health.js");
  return checkProviderHealth(...args);
}

export async function checkAllProviders(...args: Parameters<HealthModule["checkAllProviders"]>): Promise<Awaited<ReturnType<HealthModule["checkAllProviders"]>>> {
  const { checkAllProviders } = await import("./lib/health.js");
  return checkAllProviders(...args);
}

export async function checkDnsRecords(...args: Parameters<DnsCheckModule["checkDnsRecords"]>): Promise<Awaited<ReturnType<DnsCheckModule["checkDnsRecords"]>>> {
  const { checkDnsRecords } = await import("./lib/dns-check.js");
  return checkDnsRecords(...args);
}

export async function verifyEmailAddress(...args: Parameters<EmailVerifyModule["verifyEmailAddress"]>): Promise<Awaited<ReturnType<EmailVerifyModule["verifyEmailAddress"]>>> {
  const { verifyEmailAddress } = await import("./lib/email-verify.js");
  return verifyEmailAddress(...args);
}
