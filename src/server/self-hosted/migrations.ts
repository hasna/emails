// Schema migrations for the Emails self_hosted service (Postgres).
//
// These run through the product-owned migration ledger (checksummed,
// idempotent, drift/downgrade-guarded). They own ONLY the tables the
// self_hosted /v1 API manages in the operator-owned database.

import { defineMigration, type Migration } from "../../storage-kit/index.js";
import { apiKeyMigrations } from "@hasna/contracts/auth";

/**
 * Compatibility bridge for operator databases that already have legacy local
 * Emails tables named `domains` or `addresses`.
 *
 * The released 0001 migration uses `CREATE TABLE IF NOT EXISTS`; against a
 * legacy table with the same name, creation is skipped and later indexes/reads
 * need the self-hosted base columns to exist. This migration runs before 0001
 * and is intentionally a no-op for fresh databases.
 */
const LEGACY_TABLE_COMPATIBILITY_SCHEMA = defineMigration(
  "0000_emails_legacy_selfhosted_table_compatibility",
  `
  DO $$
  BEGIN
    IF to_regclass('public.domains') IS NOT NULL THEN
      ALTER TABLE domains ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE domains ADD COLUMN IF NOT EXISTS provider TEXT;
      ALTER TABLE domains ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE domains ADD COLUMN IF NOT EXISTS notes TEXT;
    END IF;

    IF to_regclass('public.addresses') IS NOT NULL THEN
      ALTER TABLE addresses ADD COLUMN IF NOT EXISTS domain TEXT;
      ALTER TABLE addresses ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
    END IF;
  END $$;
  `,
);

/** Emails self_hosted domain schema: sending domains, addresses, message ledger. */
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
 * gate + `emails address verify` / markVerified flow). The original self_hosted
 * `addresses` table (0001) omitted it, so a client flipped to the self_hosted store
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
 * self_hosted column the quota would silently only persist on the local island
 * (split-brain). Nullable: NULL means "no quota" (the CLI's `quota <id> none`).
 */
const ADDRESS_QUOTA_SCHEMA = defineMigration(
  "0004_mailery_addresses_daily_quota",
  `
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS daily_quota INTEGER;
  `,
);

/**
 * Generic list-backed resources for self-hosted clients.
 *
 * Adds the self_hosted tables behind the /v1 resource CRUD used by `contact list`,
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

/**
 * Additive rename bridge. The first five migration ids and SQL bodies shipped
 * under the old product name and must remain checksum-stable for upgrades.
 * Fresh databases run those historical migrations and immediately cross this
 * bridge; existing databases retain every provider row while adopting the new
 * table name.
 */
const EMAILS_RENAME_BRIDGE = defineMigration(
  "0006_emails_rename_bridge",
  `
  DO $$
  BEGIN
    IF to_regclass('public.cloud_providers') IS NOT NULL
       AND to_regclass('public.self_hosted_providers') IS NULL THEN
      ALTER TABLE cloud_providers RENAME TO self_hosted_providers;
    ELSIF to_regclass('public.cloud_providers') IS NOT NULL
       AND to_regclass('public.self_hosted_providers') IS NOT NULL THEN
      INSERT INTO self_hosted_providers (id, name, type, region, active, created_at, updated_at)
      SELECT id, name, type, region, active, created_at, updated_at FROM cloud_providers
      ON CONFLICT (id) DO NOTHING;
      DROP TABLE cloud_providers;
    END IF;
  END $$;

  ALTER TABLE messages ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS send_payload_hash TEXT;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS send_state TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS send_started_at TIMESTAMPTZ;
  CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency_key_uidx
    ON messages (idempotency_key) WHERE idempotency_key IS NOT NULL;
  `,
);

/**
 * Prepares legacy local-store rows for the immutable 0007 backfill.
 *
 * 0007 was deployed and applied in production, so its checksum must remain
 * stable. This prep migration runs before 0007 on fresh upgrades and sanitizes
 * malformed legacy JSON/timestamp text so the historical casts in 0007 do not
 * abort the whole migration.
 */
const LEGACY_MESSAGES_BACKFILL_PREP = defineMigration(
  "0006b_emails_legacy_messages_backfill_prep",
  `
  CREATE OR REPLACE FUNCTION pg_temp.emails_safe_jsonb_text(value TEXT, fallback JSONB)
  RETURNS TEXT
  LANGUAGE plpgsql
  AS $fn$
  DECLARE
    parsed JSONB;
  BEGIN
    IF value IS NULL OR btrim(value) = '' THEN
      RETURN fallback::text;
    END IF;
    parsed := value::jsonb;
    IF jsonb_typeof(parsed) IS DISTINCT FROM jsonb_typeof(fallback) THEN
      RETURN fallback::text;
    END IF;
    RETURN parsed::text;
  EXCEPTION WHEN others THEN
    RETURN fallback::text;
  END;
  $fn$;

  CREATE OR REPLACE FUNCTION pg_temp.emails_safe_timestamptz_text(value TEXT, fallback TEXT DEFAULT NULL)
  RETURNS TEXT
  LANGUAGE plpgsql
  AS $fn$
  DECLARE
    parsed TIMESTAMPTZ;
  BEGIN
    IF value IS NULL OR btrim(value) = '' THEN
      RETURN fallback;
    END IF;
    parsed := value::timestamptz;
    RETURN parsed::text;
  EXCEPTION WHEN others THEN
    RETURN fallback;
  END;
  $fn$;

  DO $$
  BEGIN
    IF to_regclass('public.inbound_emails') IS NOT NULL THEN
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS headers_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS attachments_json TEXT NOT NULL DEFAULT '[]';

      UPDATE inbound_emails
      SET
        to_addresses = pg_temp.emails_safe_jsonb_text(to_addresses::text, '[]'::jsonb),
        cc_addresses = pg_temp.emails_safe_jsonb_text(cc_addresses::text, '[]'::jsonb),
        headers_json = pg_temp.emails_safe_jsonb_text(headers_json::text, '{}'::jsonb),
        attachments_json = pg_temp.emails_safe_jsonb_text(attachments_json::text, '[]'::jsonb),
        received_at = COALESCE(
          pg_temp.emails_safe_timestamptz_text(received_at::text),
          pg_temp.emails_safe_timestamptz_text(created_at::text),
          now()::text
        ),
        created_at = COALESCE(
          pg_temp.emails_safe_timestamptz_text(created_at::text),
          pg_temp.emails_safe_timestamptz_text(received_at::text),
          now()::text
        );
    END IF;

    IF to_regclass('public.emails') IS NOT NULL THEN
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS bcc_addresses TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '{}';

      UPDATE emails
      SET
        to_addresses = pg_temp.emails_safe_jsonb_text(to_addresses::text, '[]'::jsonb),
        cc_addresses = pg_temp.emails_safe_jsonb_text(cc_addresses::text, '[]'::jsonb),
        bcc_addresses = pg_temp.emails_safe_jsonb_text(bcc_addresses::text, '[]'::jsonb),
        tags = pg_temp.emails_safe_jsonb_text(tags::text, '{}'::jsonb),
        sent_at = COALESCE(
          pg_temp.emails_safe_timestamptz_text(sent_at::text),
          pg_temp.emails_safe_timestamptz_text(created_at::text),
          pg_temp.emails_safe_timestamptz_text(updated_at::text),
          now()::text
        ),
        created_at = COALESCE(
          pg_temp.emails_safe_timestamptz_text(created_at::text),
          pg_temp.emails_safe_timestamptz_text(sent_at::text),
          now()::text
        ),
        updated_at = COALESCE(
          pg_temp.emails_safe_timestamptz_text(updated_at::text),
          pg_temp.emails_safe_timestamptz_text(sent_at::text),
          pg_temp.emails_safe_timestamptz_text(created_at::text),
          now()::text
        );
    END IF;
  END $$;
  `,
);

/**
 * Legacy local-store backfill into the self-hosted message ledger.
 *
 * Some production operator databases predate the `/v1/messages` table and carry
 * the original local-store `inbound_emails` and `emails` tables. The self-hosted
 * API reads only `messages`, so without this bridge authentication works while
 * the inbox appears empty. The `source_id` values are stable, table-qualified
 * identifiers; reruns are no-ops and live S3 ingestion can still dedupe by the
 * raw object key stored in `message_id`.
 */
const LEGACY_MESSAGES_BACKFILL = defineMigration(
  "0007_emails_legacy_messages_backfill",
  `
  DO $$
  BEGIN
    IF to_regclass('public.inbound_emails') IS NOT NULL THEN
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS provider_history_id TEXT;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS raw_s3_url TEXT;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS in_reply_to_email_id TEXT;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_read INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_starred INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_archived INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_spam INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_trash INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS headers_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS attachments_json TEXT NOT NULL DEFAULT '[]';

      INSERT INTO messages (
        id,
        direction,
        from_addr,
        to_addrs,
        cc_addrs,
        subject,
        body_text,
        body_html,
        status,
        provider_message_id,
        message_id,
        in_reply_to,
        received_at,
        is_read,
        is_starred,
        labels,
        headers,
        attachments,
        source_id,
        send_state,
        created_at,
        updated_at
      )
      SELECT
        'legacy-inbound:' || inbound_emails.id,
        'inbound',
        COALESCE(NULLIF(inbound_emails.from_address, ''), '(unknown sender)'),
        COALESCE(NULLIF(inbound_emails.to_addresses, '')::jsonb, '[]'::jsonb),
        COALESCE(NULLIF(inbound_emails.cc_addresses, '')::jsonb, '[]'::jsonb),
        NULLIF(inbound_emails.subject, ''),
        inbound_emails.text_body,
        inbound_emails.html_body,
        CASE
          WHEN lower(COALESCE(NULLIF(inbound_emails.is_trash::text, ''), '0')) NOT IN ('0', 'false', 'f', 'no') THEN 'trash'
          WHEN lower(COALESCE(NULLIF(inbound_emails.is_spam::text, ''), '0')) NOT IN ('0', 'false', 'f', 'no') THEN 'spam'
          ELSE 'received'
        END,
        inbound_emails.provider_history_id,
        COALESCE(
          CASE
            WHEN NULLIF(inbound_emails.raw_s3_url, '') LIKE 's3://%/%'
              THEN regexp_replace(inbound_emails.raw_s3_url, '^s3://[^/]+/', '')
            ELSE NULLIF(inbound_emails.raw_s3_url, '')
          END,
          NULLIF(inbound_emails.message_id, '')
        ),
        inbound_emails.in_reply_to_email_id,
        COALESCE(NULLIF(inbound_emails.received_at::text, '')::timestamptz, NULLIF(inbound_emails.created_at::text, '')::timestamptz, now()),
        lower(COALESCE(NULLIF(inbound_emails.is_read::text, ''), '0')) NOT IN ('0', 'false', 'f', 'no'),
        lower(COALESCE(NULLIF(inbound_emails.is_starred::text, ''), '0')) NOT IN ('0', 'false', 'f', 'no'),
        to_jsonb(array_remove(ARRAY[
          CASE WHEN lower(COALESCE(NULLIF(inbound_emails.is_archived::text, ''), '0')) NOT IN ('0', 'false', 'f', 'no') THEN 'archived' END,
          CASE WHEN lower(COALESCE(NULLIF(inbound_emails.is_spam::text, ''), '0')) NOT IN ('0', 'false', 'f', 'no') THEN 'spam' END,
          CASE WHEN lower(COALESCE(NULLIF(inbound_emails.is_trash::text, ''), '0')) NOT IN ('0', 'false', 'f', 'no') THEN 'trash' END
        ], NULL)),
        COALESCE(NULLIF(inbound_emails.headers_json, '')::jsonb, '{}'::jsonb),
        COALESCE(NULLIF(inbound_emails.attachments_json, '')::jsonb, '[]'::jsonb),
        'legacy:inbound_emails:' || inbound_emails.id,
        'none',
        COALESCE(NULLIF(inbound_emails.created_at::text, '')::timestamptz, NULLIF(inbound_emails.received_at::text, '')::timestamptz, now()),
        COALESCE(NULLIF(inbound_emails.created_at::text, '')::timestamptz, NULLIF(inbound_emails.received_at::text, '')::timestamptz, now())
      FROM inbound_emails
      ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING;
    END IF;

    IF to_regclass('public.emails') IS NOT NULL THEN
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS bcc_addresses TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS reply_to TEXT;
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

      INSERT INTO messages (
        id,
        direction,
        from_addr,
        to_addrs,
        cc_addrs,
        subject,
        status,
        provider_message_id,
        received_at,
        is_read,
        is_starred,
        labels,
        headers,
        attachments,
        source_id,
        idempotency_key,
        send_state,
        created_at,
        updated_at
      )
      SELECT
        'legacy-sent:' || emails.id,
        'outbound',
        COALESCE(NULLIF(emails.from_address, ''), '(unknown sender)'),
        COALESCE(NULLIF(emails.to_addresses, '')::jsonb, '[]'::jsonb),
        COALESCE(NULLIF(emails.cc_addresses, '')::jsonb, '[]'::jsonb),
        NULLIF(emails.subject, ''),
        COALESCE(NULLIF(emails.status, ''), 'sent'),
        emails.provider_message_id,
        NULL::timestamptz,
        TRUE,
        FALSE,
        '[]'::jsonb,
        jsonb_strip_nulls(jsonb_build_object(
          'bcc_addresses', COALESCE(NULLIF(emails.bcc_addresses, '')::jsonb, '[]'::jsonb),
          'reply_to', NULLIF(emails.reply_to, ''),
          'tags', COALESCE(NULLIF(emails.tags, '')::jsonb, '{}'::jsonb)
        )),
        '[]'::jsonb,
        'legacy:emails:' || emails.id,
        NULLIF(emails.idempotency_key, ''),
        CASE WHEN lower(COALESCE(emails.status, 'sent')) = 'sent' THEN 'sent' ELSE 'none' END,
        COALESCE(NULLIF(emails.created_at::text, '')::timestamptz, NULLIF(emails.sent_at::text, '')::timestamptz, now()),
        COALESCE(NULLIF(emails.updated_at::text, '')::timestamptz, NULLIF(emails.sent_at::text, '')::timestamptz, NULLIF(emails.created_at::text, '')::timestamptz, now())
      FROM emails
      ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING;
    END IF;
  END $$;
  `,
);

/**
 * Post-backfill dedupe for race/repair cases where S3 ingestion already wrote
 * a message row keyed by the same raw object key stored in `message_id` before
 * the legacy row was bridged by 0007. Keep the live-ingested row and remove the
 * synthetic legacy duplicate.
 */
const LEGACY_MESSAGES_BACKFILL_DEDUPE = defineMigration(
  "0008_emails_legacy_messages_backfill_dedupe",
  `
  DELETE FROM messages legacy
  USING messages existing
  WHERE legacy.id LIKE 'legacy-inbound:%'
    AND legacy.message_id IS NOT NULL
    AND legacy.message_id <> ''
    AND existing.id <> legacy.id
    AND existing.message_id = legacy.message_id
    AND existing.id NOT LIKE 'legacy-inbound:%';
  `,
);

/** All migrations, in order: api-keys table (auth), the core schema, inbound. */
export function emailsSelfHostedMigrations(): Migration[] {
  const authMigrations = apiKeyMigrations().map((m) => defineMigration(m.id, m.sql));
  return [
    ...authMigrations,
    LEGACY_TABLE_COMPATIBILITY_SCHEMA,
    CORE_SCHEMA,
    INBOUND_SCHEMA,
    ADDRESS_VERIFIED_SCHEMA,
    ADDRESS_QUOTA_SCHEMA,
    RESOURCE_SCHEMA,
    EMAILS_RENAME_BRIDGE,
    LEGACY_MESSAGES_BACKFILL_PREP,
    LEGACY_MESSAGES_BACKFILL,
    LEGACY_MESSAGES_BACKFILL_DEDUPE,
  ];
}
