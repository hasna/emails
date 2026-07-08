// Generic /v1 resource registry for the Mailery self_hosted cloud service.
//
// The original service handled only domains/addresses/messages by hand. The
// fleet client-flip needs the SAME resource CRUD vocabulary for the remaining
// list-backed resources (contacts, providers, templates, groups, sequences,
// owners, send-keys, scheduled) so a flipped client's `contact list`, `provider
// list`, etc. read cloud data instead of the local SQLite island (the
// split-brain the client-side routing fails-closed on until these exist).
//
// Every column here is a fixed, trusted identifier from THIS file (never user
// input), so table/column names are safe to interpolate; all VALUES are bound
// parameters. Secret material (provider credentials, send-key hashes) is
// deliberately absent — the cloud resources carry only non-secret metadata.

export interface ResourceColumn {
  name: string;
  /** JSONB column: value is JSON-encoded and cast with ::jsonb. */
  json?: boolean;
  /** BOOLEAN column: value coerced to a real boolean. */
  bool?: boolean;
  /** INTEGER column. */
  int?: boolean;
}

export interface CloudResourceSpec {
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
}

export const CLOUD_RESOURCES: CloudResourceSpec[] = [
  {
    path: "contacts",
    table: "contacts",
    orderBy: "updated_at DESC",
    filters: ["suppressed"],
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
    table: "cloud_providers",
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
];

export function resourceSpecForPath(path: string): CloudResourceSpec | undefined {
  return CLOUD_RESOURCES.find((r) => r.path === path);
}
