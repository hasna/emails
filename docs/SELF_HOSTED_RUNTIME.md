# Mailery Self-Hosted Runtime

Mailery has three deployment modes:

- `local`: local SQLite and local files are the source of truth.
- `self-hosted`: Hasna-owned AWS internal service/API deployment where
  PostgreSQL/RDS, S3, Secrets Manager, SES, and provider state are the source of
  truth.
- `cloud`: Mailery Cloud API is the source of truth.

The per-domain aggregator, inbound readiness, outbound readiness, and DNS
authentication contract lives in [`DOMAIN_READINESS.md`](DOMAIN_READINESS.md).
That contract is intentionally per domain: a domain can be inbound-ready without
being outbound-ready, and DMARC is a sending-domain signal rather than a global
Mailery app blocker.

In Hasna self-hosted deployment, PostgreSQL/RDS owns mailbox, message, label,
provider, send, and state rows. S3 owns raw SES MIME objects and optional
attachment objects. A local SQLite install is not self-hosted and must not be
presented as a shared source of truth.

## Runtime Contract

Configure the Hasna self-hosted source-of-truth mode by setting
`HASNA_EMAILS_DATABASE_URL` in the deployment secret store and using
the `cloud` value for `MAILERY_MODE` on API-backed clients.

`EMAILS_DATABASE_URL` remains a compatibility fallback. Do not print, commit,
or paste connection strings.

The OSS package ships reference runtime environment-variable names and template
values only. These examples document the configuration shape that Hasna's
internal self-hosted deployment injects through private deployment config. The
public package does not export Hasna's concrete RDS database, S3 bucket, SES
identity, or Secrets Manager path names. Non-Hasna deployments may reuse the
same environment-variable shape as a service-runtime template, but that is not
the canonical Mailery `self-hosted` deployment mode.

When the Hasna self-hosted service runs runtime commands:

1. Pull configured runtime tables from PostgreSQL into the local cache.
2. Execute the requested command against the cache.
3. Flush changed cache tables back to PostgreSQL.

Long-running MCP and HTTP server processes must report whether they are using a
local source of truth or a service/API source of truth. Deprecated `remote` and
`hybrid` vocabulary is storage-sync compatibility language, not deployment mode.

## Commands

```bash
mailery self-hosted setup
mailery self-hosted status --json
mailery self-hosted migrate
mailery self-hosted migrate-local --json
```

`migrate-local` pushes existing local SQLite rows into the Hasna self-hosted
PostgreSQL/RDS source of truth. It does not pull first, because pulling would
overwrite the local data being migrated.

After a successful local-to-Hasna-self-hosted migration, production/runtime
commands should use the `cloud` value for `MAILERY_MODE` on API-backed clients.

At that point the local SQLite file is no longer the durable mailbox source of
truth. It is recreated or refreshed from PostgreSQL, used as a command/runtime
cache, and flushed back to PostgreSQL. Do not keep adding new production mail to
local-only providers or local-only inbox sources after the migration unless the
intent is explicitly test/import-only. Validate the cutover with:

```bash
mailery self-hosted status --json
mailery domains list --json
mailery inbox sources --json
```

The older storage commands remain available:

```bash
mailery storage status
mailery storage migrate
mailery storage migrate-local
mailery storage pull
mailery storage push
```

## S3 And Attachments

SES inbound writes raw MIME to S3. `mailery inbox sync-s3` records `raw_s3_url`
on inbound rows, stores attachment metadata, and, when configured, stores
attachments in S3 as `s3://` URLs. In source-of-truth mode the S3 materialization
tables are flushed to PostgreSQL after successful sync, so the local cache does
not become the durable owner of raw mail or attachments.
