// Shape of the `emails status` / `emails agent context` payload.
//
// ONE type, ONE shape, both modes. The self_hosted and local assemblers share
// this interface so a script or agent consuming `--json` sees the same keys
// regardless of mode; a field the running mode cannot answer is `null` and
// registered in `gaps`, never a plausible-looking zero.
//
// See src/lib/status-availability.ts for why `null` (and not 0 / [] / "unknown")
// is the sentinel.

import type { InboundBucket } from "./config.js";
import type { EnrichedAddress } from "./address-ownership.js";
import type { EmailsMode, EmailsModeLabel, EmailsModeSource } from "./mode.js";
import type { MailboxSourceSummary, MailboxStatusSummary } from "./mail-types.js";
import type { StatusAvailability } from "./status-availability.js";

/**
 * One domain row in the readiness sample.
 *
 * `state` / `send_ready` / `receive_ready` are nullable because the self-hosted
 * `/v1` domain entity carries no DKIM/SPF/DMARC evidence and no inbound/outbound
 * route state — only a single `verified` boolean. Deriving three DNS verdicts
 * from that boolean (which src/db/domains.remote.ts apiToDomain does) invents
 * evidence, so status reports null + a reason instead.
 */
export interface DomainStatusRow {
  id: string;
  domain: string;
  provider_id: string;
  provider_name: string | null;
  state: string | null;
  send_ready: boolean | null;
  receive_ready: boolean | null;
  ready_addresses: number | null;
  /** Real provisioning lifecycle column (both modes). */
  provisioning_status: string | null;
  last_error: string | null;
  next_check_at: string | null;
  issues: string[];
  fix_commands: string[];
}

export interface ProvidersStatusBlock {
  availability: StatusAvailability;
  total: number | null;
  active: number | null;
  by_type: Record<string, number> | null;
}

export interface DomainsStatusBlock {
  availability: StatusAvailability;
  total: number | null;
  /**
   * Domains the source marks verified. This is a REAL count of a real column —
   * unlike `send_ready`, it makes no claim about DNS records the client never
   * checked.
   */
  verified: number | null;
  send_ready: number | null;
  receive_ready: number | null;
  usable: DomainStatusRow[] | null;
  usable_limit: number;
  usable_truncated: boolean;
}

export interface AddressesStatusBlock {
  availability: StatusAvailability;
  total: number | null;
  active: number | null;
  verified: number | null;
  owned: number | null;
  ready_to_receive: number | null;
  usable_from: EnrichedAddress[] | null;
  usable_from_limit: number;
  usable_from_truncated: boolean;
}

export interface RealtimeStatusBlock {
  availability: StatusAvailability;
  queue_configured: boolean | null;
  queue_url: string | null;
  last_poll_at: string | null;
  last_error: string | null;
}

export interface InboundBucketsStatusBlock {
  availability: StatusAvailability;
  items: InboundBucket[] | null;
  total: number | null;
}

export interface InboxStatusBlock {
  total: number;
  unread: number;
  latest_received_at: string | null;
  inbound_buckets: InboundBucketsStatusBlock;
  realtime: RealtimeStatusBlock;
}

/** Ingestion sources configured server-side (`GET /v1/sources`). */
export interface ConfiguredSourcesStatusBlock {
  availability: StatusAvailability;
  total: number | null;
  by_status: Record<string, number> | null;
  latest_last_synced_at: string | null;
}

export interface SourcesStatusBlock {
  availability: StatusAvailability;
  total: number | null;
  active: number | null;
  legacy: number | null;
  orphaned: number | null;
  items: MailboxSourceSummary[];
  limit: number;
  truncated: boolean;
  configured: ConfiguredSourcesStatusBlock;
}

export interface ProvisioningStatusBlock {
  availability: StatusAvailability;
  domains_pending: number | null;
  domains_failed: number | null;
  addresses_pending: number | null;
  addresses_failed: number | null;
}

export interface DatabaseStatusBlock {
  availability: StatusAvailability;
  data_dir: string | null;
}

export interface NextAction {
  /**
   * null means "no action is needed", stated explicitly. An empty
   * `next_actions` array would make the same claim silently, which is the
   * fabrication this payload exists to avoid.
   */
  command: string | null;
  reason: string;
}

export interface EmailSystemStatus {
  generated_at: string;
  mode: {
    current: EmailsMode;
    label: EmailsModeLabel;
    source: EmailsModeSource;
    warning: string | null;
  };
  /**
   * true when something went WRONG: a source that should have answered did not
   * (`source_unreachable`), or a count is only a lower bound. It is deliberately
   * NOT true merely because a field is structurally unanswerable in this mode —
   * both modes always carry such fields, so an "any gap" definition would pin
   * `degraded` to true forever and make the gate meaningless. Structural limits
   * live in `limited` / `limitations`.
   *
   * A script gates on one expression:
   *   `emails status --json | jq -e '.degraded == false'`
   */
  degraded: boolean;
  /**
   * true when at least one field cannot be answered in this mode BY DESIGN
   * (`not_applicable`, `not_modelled_over_v1`, `server_route_absent`). Expected,
   * permanent, and not an incident — but still published, because the fields it
   * covers are `null` and a consumer must not read them as zeros.
   */
  limited: boolean;
  /** Dotted paths of every field/block that could not be answered. */
  unavailable: string[];
  /** Dotted paths of the `unavailable` subset that is structural, not a fault. */
  limitations: string[];
  /** Dotted paths of the `unavailable` subset caused by a live read failure. */
  failures: string[];
  /** Dotted paths of blocks whose numbers are lower bounds, not totals. */
  incomplete: string[];
  /** Dotted path -> why it is unavailable. Machines match on the reason's code prefix. */
  gaps: Record<string, StatusAvailability>;
  database: DatabaseStatusBlock;
  providers: ProvidersStatusBlock;
  domains: DomainsStatusBlock;
  addresses: AddressesStatusBlock;
  inbox: InboxStatusBlock;
  mailboxes: MailboxStatusSummary;
  sources: SourcesStatusBlock;
  provisioning: ProvisioningStatusBlock;
  /**
   * Derived, mode-aware remediation steps. NEVER an unexplained empty list: when
   * there is nothing to fix the list carries one entry saying so, because `[]`
   * is itself a claim ("nothing to do") rather than an omission.
   */
  next_actions: NextAction[];
  cli_equivalents: Record<string, string>;
}

/**
 * A block plus the relative paths of the fields it had to null out. The
 * assembler merges `gaps` under the block's prefix.
 */
export interface StatusFactResult<T> {
  value: T;
  gaps: Record<string, StatusAvailability>;
}
