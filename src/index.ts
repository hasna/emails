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

export {
  createEmail,
  getEmail,
  listEmails,
  searchEmails,
  updateEmailStatus,
  deleteEmail,
} from "./db/emails.js";

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
//  * THE SAME FIVE changed their SECOND PARAMETER TYPE from `Database` to `EmailStore`
//    (`src/db/forwarding.ts:457,526,559,588,610`). Passing a `Database` handle — the documented
//    way to scope these to one database, and the only way to scope them in a transaction — now
//    passes a value of the wrong type.
//  * `listPendingForwarding` and `recordForwardingDelivery` are still SYNCHRONOUS and still take
//    a raw `Database`, but that argument is now REQUIRED (`:652-655`, `:701-703`). It used to be
//    optional and defaulted to `getDatabase()`, so an existing no-argument call does not fail to
//    compile in JS — it throws on a property access of `undefined` at runtime.
//  * `listPendingForwarding` also lost its `limit = 100` default, so its FIRST argument is
//    required too. A `listPendingForwarding()` call that worked now throws.
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
