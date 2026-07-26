// Mode seam for the system-status facts.
//
// The status payload is assembled ONCE (src/lib/agent-context.ts) from this
// seam, so both modes emit the identical shape (src/lib/status-types.ts) and a
// `--json` consumer cannot silently read one mode's zeros as the other's counts.
// Only the FACT GATHERING differs: local reads SQLite aggregates, self_hosted
// enumerates the operator's `/v1` API and reports an explicit reason for the
// handful of fields no `/v1` route answers.

import * as local from "./status-facts.local.js";
import * as remote from "./status-facts.remote.js";
import { getEmailsMode } from "./mode.js";
import type { MailboxSourceSummary } from "./mail-types.js";
import type {
  AddressesStatusBlock,
  DatabaseStatusBlock,
  DomainsStatusBlock,
  InboundBucketsStatusBlock,
  ProvidersStatusBlock,
  ProvisioningStatusBlock,
  RealtimeStatusBlock,
  SourcesStatusBlock,
} from "./status-types.js";
import type { StatusAvailability } from "./status-availability.js";

export interface StatusFactsInput {
  /** Mailbox-view sources already resolved by the assembler (mode-agnostic). */
  mailboxSources: MailboxSourceSummary[];
  domainLimit: number;
  usableFromLimit: number;
  sourceLimit: number;
}

export interface StatusFactsBundle {
  database: DatabaseStatusBlock;
  providers: ProvidersStatusBlock;
  domains: DomainsStatusBlock;
  addresses: AddressesStatusBlock;
  inboundBuckets: InboundBucketsStatusBlock;
  realtime: RealtimeStatusBlock;
  sources: SourcesStatusBlock;
  provisioning: ProvisioningStatusBlock;
  /** Absolute dotted path -> why that field is null. */
  gaps: Record<string, StatusAvailability>;
}

export function collectStatusFacts(input: StatusFactsInput): StatusFactsBundle {
  return getEmailsMode() === "self_hosted"
    ? remote.collectStatusFacts(input)
    : local.collectStatusFacts(input);
}
