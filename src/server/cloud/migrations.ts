// Schema migrations for the Mailery self_hosted cloud service (Postgres).
//
// These run through the vendored storage kit's MigrationLedger (checksummed,
// idempotent, drift/downgrade-guarded). They own ONLY the tables the
// self_hosted /v1 API manages; they never touch the live mailery.co SaaS
// database (a separate database on the shared cluster).

import { defineMigration, type Migration } from "../../generated/storage-kit/index.js";
import { apiKeyMigrations } from "@hasna/contracts/auth";

/** Mailery self_hosted domain schema: sending domains, addresses, message ledger. */
const CORE_SCHEMA = defineMigration(
  "0001_mailery_selfhosted_core",
  `
  CREATE TABLE IF NOT EXISTS domains (
    id          TEXT PRIMARY KEY,
    domain      TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'pending',
    provider    TEXT,
    verified    BOOLEAN NOT NULL DEFAULT FALSE,
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS domains_status_idx ON domains (status);

  CREATE TABLE IF NOT EXISTS addresses (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    domain        TEXT,
    display_name  TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS addresses_domain_idx ON addresses (domain);

  CREATE TABLE IF NOT EXISTS messages (
    id                   TEXT PRIMARY KEY,
    from_addr            TEXT NOT NULL,
    to_addrs             JSONB NOT NULL DEFAULT '[]'::jsonb,
    subject              TEXT,
    body_text            TEXT,
    body_html            TEXT,
    status               TEXT NOT NULL DEFAULT 'queued',
    provider_message_id  TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS messages_from_idx ON messages (from_addr);
  CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (created_at DESC);
  `,
);

/**
 * Inbound-message support for the shared message store.
 *
 * The original `messages` table (0001) is an outbound-only ledger. This
 * migration widens it so the SAME table can faithfully hold *inbound* mail
 * (received email) alongside sent messages, which the /v1 API needs both for
 * importing history and for future SES-inbound ingestion. Every column is
 * additive and nullable/defaulted, so existing outbound rows and readers are
 * unaffected.
 *
 * Idempotency: `source_id` is the stable identifier of the upstream record (the
 * local row id for a history import, or the provider/receipt id for live
 * ingestion). A partial UNIQUE index lets writers upsert on it, so re-running an
 * import never creates duplicates.
 */
const INBOUND_SCHEMA = defineMigration(
  "0002_mailery_messages_inbound",
  `
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS direction   TEXT NOT NULL DEFAULT 'outbound';
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS cc_addrs    JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_id  TEXT;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS in_reply_to TEXT;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read     BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_starred  BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS labels      JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS headers     JSONB NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_id   TEXT;

  CREATE UNIQUE INDEX IF NOT EXISTS messages_source_id_uidx
    ON messages (source_id) WHERE source_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS messages_direction_idx ON messages (direction);
  CREATE INDEX IF NOT EXISTS messages_received_idx ON messages (received_at DESC);
  CREATE INDEX IF NOT EXISTS messages_message_id_idx ON messages (message_id);
  `,
);

/**
 * Address verification support.
 *
 * The client `addresses` resource carries a `verified` flag (the send-readiness
 * gate + `emails address verify` / markVerified flow). The original cloud
 * `addresses` table (0001) omitted it, so a client flipped to the cloud store
 * could not persist verification. This additive column closes that gap so the
 * full address CRUD — including verify — round-trips through /v1/addresses.
 */
const ADDRESS_VERIFIED_SCHEMA = defineMigration(
  "0003_mailery_addresses_verified",
  `
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;
  `,
);

/**
 * Per-address daily send quota.
 *
 * `emails address quota <id> <perDay>` (setAddressQuota) caps sends per UTC day
 * for an address. A flipped client routes this write to /v1/addresses; without a
 * cloud column the quota would silently only persist on the local island
 * (split-brain). Nullable: NULL means "no quota" (the CLI's `quota <id> none`).
 */
const ADDRESS_QUOTA_SCHEMA = defineMigration(
  "0004_mailery_addresses_daily_quota",
  `
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS daily_quota INTEGER;
  `,
);

/**
 * Generic list-backed resources for the fleet client-flip.
 *
 * Adds the cloud tables behind the /v1 resource CRUD used by `contact list`,
 * `provider list`, `template list`, `group list`, `sequence list`, `owner
 * list`, `sendkey list` and `scheduled list`. Without these, a flipped client
 * fails closed (HTTP 404) on those reads rather than silently reading its local
 * SQLite island. Every table carries id/created_at/updated_at plus NON-SECRET
 * columns only: provider credentials and send-key hashes are never stored here.
 */
const RESOURCE_SCHEMA = defineMigration(
  "0005_mailery_selfhosted_resources",
  `
  CREATE TABLE IF NOT EXISTS contacts (
    id               TEXT PRIMARY KEY,
    email            TEXT NOT NULL UNIQUE,
    name             TEXT,
    send_count       INTEGER NOT NULL DEFAULT 0,
    bounce_count     INTEGER NOT NULL DEFAULT 0,
    complaint_count  INTEGER NOT NULL DEFAULT 0,
    last_sent_at     TIMESTAMPTZ,
    suppressed       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS contacts_suppressed_idx ON contacts (suppressed);

  CREATE TABLE IF NOT EXISTS cloud_providers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    region      TEXT,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS templates (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,
    subject_template  TEXT NOT NULL DEFAULT '',
    html_template     TEXT,
    text_template     TEXT,
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS contact_groups (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    description  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sequences (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT,
    status       TEXT NOT NULL DEFAULT 'active',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS owners (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL DEFAULT 'human',
    name          TEXT NOT NULL,
    contact_email TEXT,
    external_id   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS send_keys (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT,
    prefix        TEXT,
    label         TEXT,
    last_used_at  TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS send_keys_owner_idx ON send_keys (owner_id);

  CREATE TABLE IF NOT EXISTS scheduled_emails (
    id                TEXT PRIMARY KEY,
    provider_id       TEXT,
    from_address      TEXT,
    to_addresses      JSONB NOT NULL DEFAULT '[]'::jsonb,
    cc_addresses      JSONB NOT NULL DEFAULT '[]'::jsonb,
    bcc_addresses     JSONB NOT NULL DEFAULT '[]'::jsonb,
    reply_to          TEXT,
    subject           TEXT NOT NULL DEFAULT '',
    html              TEXT,
    text_body         TEXT,
    attachments_json  JSONB NOT NULL DEFAULT '[]'::jsonb,
    template_name     TEXT,
    template_vars     JSONB,
    scheduled_at      TIMESTAMPTZ,
    status            TEXT NOT NULL DEFAULT 'pending',
    error             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS scheduled_emails_status_idx ON scheduled_emails (status);
  CREATE INDEX IF NOT EXISTS scheduled_emails_scheduled_idx ON scheduled_emails (scheduled_at);
  `,
);

/** All migrations, in order: api-keys table (auth), the core schema, inbound. */
export function maileryCloudMigrations(): Migration[] {
  const authMigrations = apiKeyMigrations().map((m) => defineMigration(m.id, m.sql));
  return [
    ...authMigrations,
    CORE_SCHEMA,
    INBOUND_SCHEMA,
    ADDRESS_VERIFIED_SCHEMA,
    ADDRESS_QUOTA_SCHEMA,
    RESOURCE_SCHEMA,
  ];
}
