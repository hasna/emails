// The seam itself: what a store IS.
//
// Two implementations will satisfy this, and only two, ever:
//
//   * SqliteEmailStore — the local, default, on-disk SQLite database.
//   * HttpEmailStore    — a client of an Emails API.
//
// THERE IS NO CLIENT-SIDE POSTGRES STORE, and there will not be one. Postgres is the
// SERVER's internal storage and is reached only through the API; it is never a client
// transport. "Local" means SQLite. If a caller means "somewhere else", it means the
// API. Any third implementation would be a deployment-mode axis growing back under a
// new name.
//
// No product code consumes this yet — `src/storage.ts` re-exports the core types and
// nothing else reads them. It declares the contract so the two implementations can be
// built against it and checked against each other, and so the operations that today
// return plausible wrong data have somewhere to say "no" instead.

import type { StoreCapabilities } from "./capabilities.js";
import type { StoreDescriptor } from "./descriptor.js";
import type {
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

export interface EmailStore {
  /**
   * DIAGNOSTICS ONLY. Branching on this is forbidden — see descriptor.ts for the
   * shape that makes it impractical and for what happened the last time a label like
   * this was allowed to narrow.
   */
  readonly descriptor: StoreDescriptor;

  /**
   * What this store can do. When a capability is false, every operation that needs it
   * has exactly ONE legal answer: the typed refusal from `capabilityRefusal()`. Never
   * an empty array, never a zero, never a silent no-op.
   */
  readonly capabilities: StoreCapabilities;

  // One repository per `src/db/*` family, named so the correspondence with today's
  // code is checkable by eye and by the seam guard.
  readonly domains: DomainsRepository;
  readonly addresses: AddressesRepository;
  readonly addressLifecycle: AddressLifecycleRepository;
  readonly provisioning: ProvisioningRepository;
  readonly messages: MessagesRepository;
  readonly emailContent: EmailContentRepository;
  readonly inbound: InboundRepository;
  readonly threads: ThreadsRepository;
  readonly sandbox: SandboxRepository;
  readonly emailDigests: EmailDigestsRepository;
  readonly scheduled: ScheduledRepository;
  readonly events: EventsRepository;
  readonly webhookReceipts: WebhookReceiptsRepository;
  readonly contacts: ContactsRepository;
  readonly groups: GroupsRepository;
  readonly sequences: SequencesRepository;
  readonly templates: TemplatesRepository;
  readonly owners: OwnersRepository;
  readonly providers: ProvidersRepository;
  readonly sendKeys: SendKeysRepository;
  readonly aliases: AliasesRepository;
  readonly forwarding: ForwardingRepository;
  readonly warming: WarmingRepository;

  // Families the STRONGEST arm has and `src/db/*` never did. They are declared here,
  // rather than deferred, because they are the reason the seam is shaped this way: the
  // send-intent ledger is what makes synchronous repositories impossible, and both are
  // the clearest cases of a capability that a store must refuse rather than fake.
  readonly sendIntents: SendIntentsRepository;
  readonly attachmentRepair: AttachmentRepairRepository;
}
