// Generic /v1 resource registry for the Emails self_hosted self_hosted service.
//
// The original service handled only domains/addresses/messages by hand. The
// Self-hosted clients need the same resource CRUD vocabulary for the remaining
// list-backed resources (contacts, providers, templates, groups, sequences,
// owners, send-keys, scheduled) so a flipped client's `contact list`, `provider
// list`, etc. read self_hosted data instead of the local SQLite island (the
// split-brain the client-side routing fails-closed on until these exist).
//
// Every column here is a fixed, trusted identifier from THIS file (never user
// input), so table/column names are safe to interpolate; all VALUES are bound
// parameters. Secret material (provider credentials, send-key hashes) is
// deliberately absent — the self_hosted resources carry only non-secret metadata.

export interface ResourceColumn {
  name: string;
  /** JSONB column: value is JSON-encoded and cast with ::jsonb. */
  json?: boolean;
  /** BOOLEAN column: value coerced to a real boolean. */
  bool?: boolean;
  /** INTEGER column. */
  int?: boolean;
  /** REAL / DOUBLE PRECISION column: value coerced to a finite number. */
  num?: boolean;
}

/**
 * A body-supplied foreign-key column that references another tenant-scoped table.
 * The tenant-scoped store rejects a create whose FK id resolves to a row in a
 * DIFFERENT tenant (design adversarial fix M4). Only real cross-tenant references
 * are blocked; a dangling/denormalized id (e.g. a free-text `provider_id` slug
 * that is not a real row) is allowed, so loose usage is preserved.
 */
export interface ResourceForeignKey {
  /** Column on THIS resource holding the referenced id. */
  column: string;
  /** Referenced Postgres table (must carry `tenant_id`). */
  table: string;
  /** Referenced key column (defaults to "id"). */
  idColumn?: string;
}

export interface SelfHostedResourceSpec {
  /** URL path segment under /v1 (e.g. "send-keys"). */
  path: string;
  /** Postgres table name. */
  table: string;
  /** Writable columns (id/created_at/updated_at are handled separately). */
  columns: ResourceColumn[];
  /** ORDER BY clause for list (trusted). */
  orderBy: string;
  /** Optional simple equality filters accepted as query params -> column. */
  filters?: string[];
  /**
   * Primary-key column for get/update/delete and the create conflict target.
   * Defaults to "id" (a server-minted UUID). A resource whose natural key is NOT
   * a UUID (e.g. email_agent_settings keyed by `agent_key`) sets this so generic
   * CRUD addresses rows by that column and creates upsert on it (ON CONFLICT DO
   * NOTHING) instead of minting an id.
   */
  idColumn?: string;
  /**
   * Tenant-scoping metadata (design §6 Layer 1 / WI-1b). EVERY resource is
   * tenant-scoped by the store uniformly (each query filters/stamps `tenant_id`);
   * these two fields carry the per-resource specifics that a blanket rule cannot.
   *
   * `compositeKey`: the natural key is unique PER TENANT, so the create upsert
   * conflicts on `(tenant_id, idColumn)` rather than the id alone. Set for
   * `email-agents` (PK became `(tenant_id, agent_key)` in migration 0012).
   */
  compositeKey?: boolean;
  /** FK columns validated against the caller's tenant before insert (M4). */
  foreignKeys?: ResourceForeignKey[];
}

export const SELF_HOSTED_RESOURCES: SelfHostedResourceSpec[] = [
  {
    path: "contacts",
    table: "contacts",
    orderBy: "updated_at DESC",
    filters: ["suppressed", "email"],
    columns: [
      { name: "email" },
      { name: "name" },
      { name: "send_count", int: true },
      { name: "bounce_count", int: true },
      { name: "complaint_count", int: true },
      { name: "last_sent_at" },
      { name: "suppressed", bool: true },
    ],
  },
  {
    path: "providers",
    table: "self_hosted_providers",
    orderBy: "created_at DESC",
    filters: ["type"],
    columns: [
      { name: "name" },
      { name: "type" },
      { name: "region" },
      { name: "active", bool: true },
    ],
  },
  {
    path: "templates",
    table: "templates",
    orderBy: "created_at DESC",
    columns: [
      { name: "name" },
      { name: "subject_template" },
      { name: "html_template" },
      { name: "text_template" },
      { name: "metadata", json: true },
    ],
  },
  {
    path: "groups",
    table: "contact_groups",
    orderBy: "name ASC",
    columns: [{ name: "name" }, { name: "description" }],
  },
  {
    path: "sequences",
    table: "sequences",
    orderBy: "created_at DESC",
    columns: [{ name: "name" }, { name: "description" }, { name: "status" }],
  },
  {
    path: "owners",
    table: "owners",
    orderBy: "created_at DESC",
    filters: ["type"],
    columns: [
      { name: "type" },
      { name: "name" },
      { name: "contact_email" },
      { name: "external_id" },
    ],
  },
  {
    path: "send-keys",
    table: "send_keys",
    orderBy: "created_at DESC",
    filters: ["owner_id"],
    foreignKeys: [{ column: "owner_id", table: "owners" }],
    columns: [
      { name: "owner_id" },
      { name: "prefix" },
      { name: "label" },
      { name: "last_used_at" },
      { name: "revoked_at" },
    ],
  },
  {
    path: "scheduled",
    table: "scheduled_emails",
    orderBy: "scheduled_at ASC",
    filters: ["status"],
    foreignKeys: [{ column: "provider_id", table: "self_hosted_providers" }],
    columns: [
      { name: "provider_id" },
      { name: "from_address" },
      { name: "to_addresses", json: true },
      { name: "cc_addresses", json: true },
      { name: "bcc_addresses", json: true },
      { name: "reply_to" },
      { name: "subject" },
      { name: "html" },
      { name: "text_body" },
      { name: "attachments_json", json: true },
      { name: "template_name" },
      { name: "template_vars", json: true },
      { name: "scheduled_at" },
      { name: "status" },
      { name: "error" },
    ],
  },
  // ---- self-hosted-only parity resources -----------------------------------
  // Added so a self-hosted client covers EVERY resource the deleted local
  // SQLite store carried. Columns mirror the local schema in snake_case.
  {
    // Per-domain aliases + catch-all routing (local table `aliases`).
    path: "aliases",
    table: "aliases",
    orderBy: "domain ASC, local_part ASC",
    filters: ["domain", "local_part", "target_address"],
    columns: [
      { name: "domain" },
      { name: "local_part" },
      { name: "target_address" },
      { name: "protected", bool: true },
    ],
  },
  {
    // App-level inbound forwarding rules (local table `forwarding_rules`).
    path: "forwarding",
    table: "forwarding_rules",
    orderBy: "source_address ASC, target_address ASC",
    filters: ["source_address", "target_address", "mode"],
    foreignKeys: [{ column: "provider_id", table: "self_hosted_providers" }],
    columns: [
      { name: "source_address" },
      { name: "target_address" },
      { name: "mode" },
      { name: "provider_id" },
      { name: "from_address" },
      { name: "enabled", bool: true },
    ],
  },
  {
    // Domain warm-up schedules (local table `warming_schedules`).
    path: "warming",
    table: "warming_schedules",
    orderBy: "created_at DESC",
    filters: ["status", "domain"],
    foreignKeys: [{ column: "provider_id", table: "self_hosted_providers" }],
    columns: [
      { name: "domain" },
      { name: "provider_id" },
      { name: "target_daily_volume", int: true },
      { name: "start_date" },
      { name: "status" },
    ],
  },
  {
    // Stored AI triage results (local table `email_triage`).
    path: "triage",
    table: "email_triage",
    orderBy: "triaged_at DESC",
    filters: ["label", "priority", "sentiment", "email_id", "inbound_email_id"],
    columns: [
      { name: "email_id" },
      { name: "inbound_email_id" },
      { name: "label" },
      { name: "priority", int: true },
      { name: "summary" },
      { name: "sentiment" },
      { name: "draft_reply" },
      { name: "confidence", num: true },
      { name: "model" },
      { name: "triaged_at" },
    ],
  },
  {
    // Append-only domain/address provisioning audit (local table
    // `provisioning_events`). Domain/address provisioning STATE fields live on
    // the domains/addresses resources; this resource is the state-transition log.
    path: "provisioning",
    table: "provisioning_events",
    orderBy: "created_at ASC",
    filters: ["entity_type", "entity_id", "to_state"],
    columns: [
      { name: "entity_type" },
      { name: "entity_id" },
      { name: "from_state" },
      { name: "to_state" },
      { name: "detail_json", json: true },
    ],
  },
  {
    // S3 / inbound mailbox sources (local table `mailbox_sources`).
    path: "sources",
    table: "mailbox_sources",
    orderBy: "status ASC, type ASC, created_at ASC",
    filters: ["mailbox_id", "provider_id", "type", "status"],
    foreignKeys: [{ column: "provider_id", table: "self_hosted_providers" }],
    columns: [
      { name: "mailbox_id" },
      { name: "provider_id" },
      { name: "type" },
      { name: "name" },
      { name: "external_account_id" },
      { name: "external_mailbox" },
      { name: "status" },
      { name: "settings_json", json: true },
      { name: "provider_snapshot_json", json: true },
      { name: "last_synced_at" },
    ],
  },
  {
    // Delivery/engagement events (local table `events`).
    path: "events",
    table: "events",
    orderBy: "occurred_at DESC",
    filters: ["email_id", "provider_id", "type", "recipient"],
    foreignKeys: [{ column: "provider_id", table: "self_hosted_providers" }],
    columns: [
      { name: "email_id" },
      { name: "provider_id" },
      { name: "provider_event_id" },
      { name: "type" },
      { name: "recipient" },
      { name: "metadata", json: true },
      { name: "occurred_at" },
    ],
  },
  {
    // Inbound AI agent settings (local table `email_agent_settings`). Natural
    // key is `agent_key` (a small fixed enum), NOT a UUID — creates upsert on it.
    path: "email-agents",
    table: "email_agent_settings",
    idColumn: "agent_key",
    // Natural key is unique PER TENANT (PK is (tenant_id, agent_key) after 0012),
    // so the create upsert conflicts on the composite, not agent_key alone.
    compositeKey: true,
    orderBy: "agent_key ASC",
    columns: [
      { name: "agent_key" },
      { name: "enabled", bool: true },
      { name: "always_on", bool: true },
      { name: "provider" },
      { name: "model" },
      { name: "apply_labels", bool: true },
      { name: "use_network_tools", bool: true },
      { name: "config_json", json: true },
    ],
  },
  {
    // Per-inbound AI agent run ledger (local table `email_agent_runs`).
    path: "email-agent-runs",
    table: "email_agent_runs",
    orderBy: "completed_at DESC",
    filters: ["agent_key", "inbound_email_id", "status"],
    columns: [
      { name: "agent_key" },
      { name: "inbound_email_id" },
      { name: "provider" },
      { name: "model" },
      { name: "status" },
      { name: "category" },
      { name: "labels_json", json: true },
      { name: "priority", int: true },
      { name: "confidence", num: true },
      { name: "risk_score", int: true },
      { name: "summary" },
      { name: "reasoning" },
      { name: "tool_calls_json", json: true },
      { name: "output_json", json: true },
      { name: "error" },
      { name: "started_at" },
      { name: "completed_at" },
    ],
  },
  {
    // Persisted inbox digest snapshots (local table `email_digests`).
    path: "email-digests",
    table: "email_digests",
    orderBy: "completed_at DESC",
    filters: ["period", "status"],
    columns: [
      { name: "period" },
      { name: "since" },
      { name: "until" },
      { name: "provider" },
      { name: "model" },
      { name: "status" },
      { name: "message_count", int: true },
      { name: "summary" },
      { name: "highlights_json", json: true },
      { name: "action_items_json", json: true },
      { name: "important_email_ids_json", json: true },
      { name: "label_counts_json", json: true },
      { name: "error" },
      { name: "started_at" },
      { name: "completed_at" },
    ],
  },
  // ---- self-hosted-only parity resources (round 2) --------------------------
  // Every resource the self-hosted client routes to that had no server endpoint
  // yet (it 404'd at runtime). Columns mirror the client's expected fields in
  // snake_case; created_at/updated_at exist on every table so the generic
  // updater (`SET ... updated_at = now()`) works even on the append-only ones.
  {
    // Contact-group membership (local table `group_members`). The local natural
    // key was composite (group_id, email); the /v1 CRUD needs a single `id`, so
    // the table carries a server-minted `id` PLUS a UNIQUE(group_id, email).
    path: "group-members",
    table: "group_members",
    orderBy: "added_at ASC, email ASC",
    filters: ["group_id", "email"],
    foreignKeys: [{ column: "group_id", table: "contact_groups" }],
    columns: [
      { name: "group_id" },
      { name: "email" },
      { name: "name" },
      // The client sends `vars` pre-serialized (JSON.stringify), mirroring the
      // original local SQLite TEXT column, so this is a TEXT column too: the JSON
      // string round-trips verbatim and the client's `cobj` parses it. (Declaring
      // it json here would double-encode into a jsonb string scalar.)
      { name: "vars" },
      { name: "added_at" },
    ],
  },
  {
    // Steps of a drip sequence (local table `sequence_steps`).
    path: "sequence-steps",
    table: "sequence_steps",
    orderBy: "step_number ASC",
    filters: ["sequence_id"],
    foreignKeys: [{ column: "sequence_id", table: "sequences" }],
    columns: [
      { name: "sequence_id" },
      { name: "step_number", int: true },
      { name: "delay_hours", int: true },
      { name: "template_name" },
      { name: "from_address" },
      { name: "subject_override" },
      { name: "created_at" },
    ],
  },
  {
    // Contact enrollments in a sequence (local table `sequence_enrollments`).
    path: "sequence-enrollments",
    table: "sequence_enrollments",
    orderBy: "enrolled_at DESC",
    filters: ["sequence_id", "status"],
    foreignKeys: [
      { column: "sequence_id", table: "sequences" },
      { column: "provider_id", table: "self_hosted_providers" },
    ],
    columns: [
      { name: "sequence_id" },
      { name: "contact_email" },
      { name: "provider_id" },
      { name: "current_step", int: true },
      { name: "status" },
      { name: "enrolled_at" },
      { name: "next_send_at" },
      { name: "completed_at" },
    ],
  },
  {
    // Append-only address ownership audit trail (local table
    // `address_ownership_events`). The client MINTS the event id and then reads
    // it straight back by that id, so this resource honors the client-supplied
    // `id` (idColumn) rather than server-minting a different one.
    path: "address-ownership-events",
    table: "address_ownership_events",
    idColumn: "id",
    orderBy: "created_at DESC",
    filters: ["address_id", "action"],
    foreignKeys: [
      { column: "address_id", table: "addresses" },
      { column: "owner_id", table: "owners" },
      { column: "administrator_id", table: "owners" },
      { column: "previous_owner_id", table: "owners" },
      { column: "previous_administrator_id", table: "owners" },
    ],
    columns: [
      { name: "id" },
      { name: "address_id" },
      { name: "action" },
      { name: "previous_owner_id" },
      { name: "previous_administrator_id" },
      { name: "owner_id" },
      { name: "administrator_id" },
      { name: "actor" },
      { name: "reason" },
      { name: "created_at" },
    ],
  },
  {
    // Webhook idempotency ledger (local table `webhook_receipts`). Append-only;
    // the client dedupes by (provider, event_id) via a bounded list scan.
    path: "webhook-receipts",
    table: "webhook_receipts",
    orderBy: "completed_at DESC",
    filters: ["provider", "event_id"],
    columns: [
      { name: "provider" },
      { name: "event_id" },
      { name: "resource_id" },
      { name: "completed_at" },
    ],
  },
  {
    // Captured outbound for the sandbox provider (local table `sandbox_emails`).
    // to/cc/bcc arrive as raw arrays (jsonb, encoded once). attachments_json /
    // headers_json arrive PRE-serialized from the client (mirroring the original
    // SQLite TEXT columns), so they are TEXT here — the JSON string round-trips
    // verbatim and the client's carray/cobj parse it (declaring them json would
    // double-encode into a jsonb string scalar).
    path: "sandbox-emails",
    table: "sandbox_emails",
    orderBy: "created_at DESC",
    filters: ["provider_id"],
    foreignKeys: [{ column: "provider_id", table: "self_hosted_providers" }],
    columns: [
      { name: "provider_id" },
      { name: "from_address" },
      { name: "to_addresses", json: true },
      { name: "cc_addresses", json: true },
      { name: "bcc_addresses", json: true },
      { name: "reply_to" },
      { name: "subject" },
      { name: "html" },
      { name: "text_body" },
      { name: "attachments_json" },
      { name: "headers_json" },
      { name: "created_at" },
    ],
  },
];

export function resourceSpecForPath(path: string): SelfHostedResourceSpec | undefined {
  return SELF_HOSTED_RESOURCES.find((r) => r.path === path);
}
