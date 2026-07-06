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

/** All migrations, in order: api-keys table (auth) then the domain schema. */
export function maileryCloudMigrations(): Migration[] {
  const authMigrations = apiKeyMigrations().map((m) => defineMigration(m.id, m.sql));
  return [...authMigrations, CORE_SCHEMA];
}
