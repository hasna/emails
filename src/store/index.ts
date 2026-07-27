// The store seam's public surface.
//
// Every re-export is NAMED. `export type * from "./x.js"` is what the repository
// facades do about thirty times today, and it is how the weakest arm became the
// contract: a star re-export from one implementation makes that implementation's
// shapes authoritative silently, and nobody reviewing a new export notices it join the
// contract. Listing names costs a line each and makes every addition a visible diff.
//
// NO PRODUCT CODE CONSUMES THIS YET, by design. This PR declares the seam; the two
// implementations and their call sites arrive after it, checked against a contract that
// already exists rather than one discovered while writing them.
//
// The single importer is `src/storage.ts`, which re-exports the core types (types only —
// `export type` is erased, so no runtime export and no bundled code). That exists because
// src/entrypoint-reachability.test.ts correctly refuses to let an unimported module sit
// in the tree: unreachable code rots while its own unit tests stay green, which is
// exactly the shape of a seam nothing uses. Allowlisting eight files there would have
// been exempting that guard rather than satisfying it.

export type { Outcome, Refusal, RefusalCode, RefusalStatus, Success } from "./outcome.js";

export type { StoreDescriptor } from "./descriptor.js";

export {
  CAPABILITY_KEYS,
  capabilityRefusal,
  isCapabilityRefusal,
  unavailableCapabilities,
} from "./capabilities.js";
export type { CapabilityKey, StoreCapabilities } from "./capabilities.js";

export { MESSAGE_FOLDERS } from "./records.js";
export type {
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
  MessageFolder,
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
  PageOptions,
  ResourceInput,
  ResourceRow,
  SendIntentCancellationResult,
  SendIntentLookupResult,
  SendKeyRecord,
  StoredAttachment,
  StoredAttachmentLookup,
  ThreadRollup,
} from "./records.js";

export type {
  AddressLifecycleRepository,
  AddressesRepository,
  AliasesRepository,
  AttachmentRepairRepository,
  ContactsRepository,
  DomainsRepository,
  EmailContentRepository,
  EmailDigestsRepository,
  EventsRepository,
  ForwardingRepository,
  GroupsRepository,
  InboundRepository,
  MessagesRepository,
  OwnersRepository,
  ProvidersRepository,
  ProvisioningRepository,
  ResourceRepository,
  SandboxRepository,
  ScheduledRepository,
  SendIntentsRepository,
  SendKeysRepository,
  SequencesRepository,
  TemplatesRepository,
  ThreadsRepository,
  WarmingRepository,
  WebhookReceiptsRepository,
} from "./repositories.js";

export type { EmailStore } from "./email-store.js";

export {
  CONFORMANCE_CASES,
  assertUniformCaseCoverage,
  capabilityCoverageGaps,
  conformanceFailures,
  runConformanceSuite,
} from "./conformance.js";
export type {
  CaseResult,
  ConformanceCase,
  ConformanceReport,
  ImplementationReport,
} from "./conformance.js";
