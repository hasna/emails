// Provider types
export type ProviderType = "resend" | "ses" | "sandbox";

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  api_key: string | null;
  region: string | null;
  access_key: string | null;
  secret_key: string | null;
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
  oauth_refresh_token: string | null;
  oauth_access_token: string | null;
  oauth_token_expiry: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type ProviderSummary = Pick<Provider, "id" | "name" | "type" | "region" | "active" | "created_at" | "updated_at">;

export interface CreateProviderInput {
  name: string;
  type: ProviderType;
  api_key?: string;
  region?: string;
  access_key?: string;
  secret_key?: string;
}

export interface ProviderRow {
  id: string;
  name: string;
  type: string;
  api_key: string | null;
  region: string | null;
  access_key: string | null;
  secret_key: string | null;
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
  oauth_refresh_token: string | null;
  oauth_access_token: string | null;
  oauth_token_expiry: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

// Canonical mailbox / ingestion-source model
export type MailboxStatus = "active" | "inactive";
export type MailboxSourceType = "ses" | "ses_s3" | "resend" | "sandbox" | "legacy_inbound" | "manual";
export type MailboxSourceStatus = "active" | "inactive" | "legacy";

export interface Mailbox {
  id: string;
  address: string;
  display_name: string | null;
  owner_id: string | null;
  status: MailboxStatus;
  created_at: string;
  updated_at: string;
}

export interface MailboxRow {
  id: string;
  address: string;
  display_name: string | null;
  owner_id: string | null;
  status: MailboxStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateMailboxInput {
  address: string;
  display_name?: string | null;
  owner_id?: string | null;
  status?: MailboxStatus;
}

export interface ProviderProvenanceSnapshot {
  id: string;
  name: string;
  type: ProviderType;
  region: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MailboxSource {
  id: string;
  mailbox_id: string;
  provider_id: string | null;
  type: MailboxSourceType;
  name: string;
  external_account_id: string | null;
  external_mailbox: string | null;
  status: MailboxSourceStatus;
  settings: Record<string, unknown>;
  provider_snapshot: ProviderProvenanceSnapshot | Record<string, unknown>;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MailboxSourceRow {
  id: string;
  mailbox_id: string;
  provider_id: string | null;
  type: MailboxSourceType;
  name: string;
  external_account_id: string | null;
  external_mailbox: string | null;
  status: MailboxSourceStatus;
  settings_json: string;
  provider_snapshot_json: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateMailboxSourceInput {
  mailbox_id: string;
  provider_id?: string | null;
  type: MailboxSourceType;
  name: string;
  external_account_id?: string | null;
  external_mailbox?: string | null;
  status?: MailboxSourceStatus;
  settings?: Record<string, unknown>;
  provider_snapshot?: ProviderProvenanceSnapshot | Record<string, unknown>;
  last_synced_at?: string | null;
}

// Domain types
export type DnsStatus = "pending" | "verified" | "failed";
export type DomainType = "system" | "self_hosted" | "local_only";
export type DomainSourceOfTruth = "local" | "postgres";
export type DomainOwnershipStatus = "pending" | "verified" | "failed";
export type DomainRouteStatus = "pending" | "ready" | "disabled" | "failed";
export type DomainMonitoringStatus = "none" | "monitoring" | "clean" | "risky";

export interface Domain {
  id: string;
  provider_id: string;
  domain: string;
  domain_type: DomainType;
  source_of_truth: DomainSourceOfTruth;
  ownership_status: DomainOwnershipStatus;
  inbound_status: DomainRouteStatus;
  outbound_status: DomainRouteStatus;
  monitoring_status: DomainMonitoringStatus;
  dkim_status: DnsStatus;
  spf_status: DnsStatus;
  dmarc_status: DnsStatus;
  dns_records: Record<string, unknown>;
  provider_metadata: Record<string, unknown>;
  verified_at: string | null;
  last_dns_check_at: string | null;
  last_inbound_check_at: string | null;
  last_outbound_check_at: string | null;
  last_monitored_at: string | null;
  restricted_at: string | null;
  suspended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DnsRecord {
  type: "TXT" | "CNAME" | "MX";
  name: string;
  value: string;
  purpose: "DKIM" | "SPF" | "DMARC" | "MX" | "MAIL_FROM" | "SES_IDENTITY";
}

/**
 * Whether a provider type publishes DNS records at all.
 *
 * THE AMBIGUITY THIS EXISTS TO REMOVE. An empty `DnsRecord[]` means three
 * different things and the array cannot say which:
 *
 *   - `sandbox` returns `[]` unconditionally. It captures mail in the local
 *     store and never hands it to a DNS-authenticated sender, so the domain has
 *     no DKIM/SPF/DMARC of its own. Empty is the COMPLETE answer.
 *   - `resend` returns `[]` when the domain is not in the account — an
 *     unfinished setup — and also when a `domains.list()`/`domains.get()` call
 *     failed, because that adapter discards `result.error`. So a `[]` from a
 *     publishing provider must not be reported as one specific cause.
 *   - `ses` cannot return `[]` at all; it always appends SPF and DMARC.
 *
 * `providerDnsPublishing()` in `src/providers/index.ts` is the only producer.
 * The discriminated union makes `reason` non-omittable in TypeScript; the
 * renderer validates it again at runtime, because `formatDnsTable` is a package
 * `exports` entry and untyped callers reach it.
 */
export type DnsPublishingSupport =
  | { publishes: true }
  | {
      publishes: false;
      /**
       * Why this provider type has no records to publish, in operator-facing
       * words. A CLAUSE, not a sentence: no leading capital, no trailing period —
       * the renderer embeds it after a colon and adds the period itself.
       */
      reason: string;
      /** What to do instead. A full sentence, with its own terminating period. */
      instead?: string;
    };

// Address lifecycle status. `active` can send/receive; `suspended` is blocked
// from sending (and excluded from delivery) but retained.
export type AddressStatus = "active" | "suspended";

// Email address (sender identity)
export interface EmailAddress {
  id: string;
  provider_id: string;
  email: string;
  display_name: string | null;
  verified: boolean;
  owner_id: string | null;
  administrator_id: string | null;
  status: AddressStatus;
  daily_quota: number | null;
  created_at: string;
  updated_at: string;
}

export interface AddressRow {
  id: string;
  provider_id: string;
  email: string;
  display_name: string | null;
  verified: number;
  owner_id: string | null;
  administrator_id: string | null;
  status: AddressStatus | null;
  daily_quota: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAddressInput {
  provider_id: string;
  email: string;
  display_name?: string;
}

// Attachment
export interface Attachment {
  filename: string;
  content: string; // base64 encoded
  content_type: string;
}

// Send email options
export interface SendEmailOptions {
  provider_id?: string;
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string;
  subject: string;
  html?: string;
  text?: string;
  attachments?: Attachment[];
  tags?: Record<string, string>;
  headers?: Record<string, string>;
  unsubscribe_url?: string;  // Auto-injects List-Unsubscribe + List-Unsubscribe-Post headers (RFC 8058)
  idempotency_key?: string;  // If provided and already sent, returns existing email instead of re-sending
  auth_token?: string;       // Scoped send key (esk_…); restricts sending to addresses the key's owner owns/administers
  bypass_warming?: boolean;  // Trusted local override for active domain warming limits
}

// Email log
export type EmailStatus = "sent" | "delivered" | "bounced" | "complained" | "failed";

/**
 * One entry in the outbound sent ledger.
 *
 * THREE FIELDS ARE NULLABLE BECAUSE A STORE MAY NOT PUBLISH THEM, and that is a different
 * fact from the value being empty. The store seam's message projections
 * (`MessageRecord` / `MessageListRecord`, src/store/records.ts) carry no `provider_id`, no
 * `bcc_addrs` and no `tags`, so `src/db/emails.ts` answers `null` for all three rather than
 * the `"self_hosted"` / `[]` / `{}` the deleted HTTP arm invented — three comfortable
 * values indistinguishable from three real ones. `src/lib/sent-ledger.local.ts`, which
 * writes the `emails` table directly, fills all three.
 *
 * `reply_to` was already nullable and is the one field where "there is no reply-to" and
 * "this store does not record one" still collide; separating them needs a second field on
 * this published type and is named in the `src/db/emails.ts` header rather than left to be
 * discovered.
 */
export interface Email {
  id: string;
  /** null when the store does not record which provider sent the message. */
  provider_id: string | null;
  provider_message_id: string | null;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  /** null when the store does not record a bcc list. NOT "there were no bcc recipients". */
  bcc_addresses: string[] | null;
  reply_to: string | null;
  subject: string;
  status: EmailStatus;
  has_attachments: boolean;
  attachment_count: number;
  /** null when the store does not record tags. NOT "this message has no tags". */
  tags: Record<string, string> | null;
  idempotency_key?: string | null;
  sent_at: string;
  created_at: string;
  updated_at: string;
}

export interface EmailRow {
  id: string;
  provider_id: string;
  provider_message_id: string | null;
  from_address: string;
  to_addresses: string;
  cc_addresses: string;
  bcc_addresses: string;
  reply_to: string | null;
  subject: string;
  status: string;
  has_attachments: number;
  attachment_count: number;
  tags: string;
  idempotency_key?: string | null;
  sent_at: string;
  created_at: string;
  updated_at: string;
}

// Event
export type EventType = "delivered" | "bounced" | "complained" | "opened" | "clicked" | "unsubscribed";

export interface EmailEvent {
  id: string;
  email_id: string | null;
  provider_id: string;
  provider_event_id: string | null;
  type: EventType;
  recipient: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}

export type EventSummary = Omit<EmailEvent, "metadata">;

export interface EventRow {
  id: string;
  email_id: string | null;
  provider_id: string;
  provider_event_id: string | null;
  type: string;
  recipient: string | null;
  metadata: string;
  occurred_at: string;
  created_at: string;
}

// Stats
export interface Stats {
  provider_id: string;
  period: string;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  opened: number;
  clicked: number;
  delivery_rate: number;
  bounce_rate: number;
  open_rate: number;
}

// Filter types
export interface EmailFilter {
  provider_id?: string;
  status?: EmailStatus | EmailStatus[];
  from_address?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface EventFilter {
  email_id?: string;
  provider_id?: string;
  type?: EventType | EventType[];
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

// Error classes
export class ProviderNotFoundError extends Error {
  constructor(public providerId: string) {
    super(`Provider not found: ${providerId}`);
    this.name = "ProviderNotFoundError";
  }
}

export class DomainNotFoundError extends Error {
  constructor(public domainId: string) {
    super(`Domain not found: ${domainId}`);
    this.name = "DomainNotFoundError";
  }
}

export class AddressNotFoundError extends Error {
  constructor(public addressId: string) {
    super(`Email address not found: ${addressId}`);
    this.name = "AddressNotFoundError";
  }
}

export class EmailNotFoundError extends Error {
  constructor(public emailId: string) {
    super(`Email not found: ${emailId}`);
    this.name = "EmailNotFoundError";
  }
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}
