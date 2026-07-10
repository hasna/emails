# Emails Self-Hosted Runtime

Emails has exactly two OSS deployment modes:

- `local`: local SQLite and local files are the source of truth.
- `self_hosted`: CLI, MCP, and API clients authenticate with an API key and talk to the self-hosted Emails service. The service owns email state in the shared cloud/Postgres deployment.

The per-domain aggregator, inbound readiness, outbound readiness, and DNS
authentication contract lives in [`DOMAIN_READINESS.md`](DOMAIN_READINESS.md).
That contract is intentionally per domain: a domain can be inbound-ready without
being outbound-ready, and DMARC is a sending-domain signal rather than a global
Emails app blocker.

## Runtime Contract

Configure self-hosted clients with the service URL and an API key issued by the
operator:

```bash
export HASNA_EMAILS_MODE=self_hosted
export HASNA_EMAILS_API_URL='<self-hosted-service-url>'
export HASNA_EMAILS_API_KEY='<redacted-api-key>'
```

Do not print, commit, or paste API keys. The self-hosted service is the only
source of truth in this mode: CLI commands, MCP tools, and API clients read and
write email state through the API-key-authenticated service, and that service
persists state in the shared cloud/Postgres deployment.

The OSS package must not present a mixed local/remote runtime as supported.
Local SQLite remains the `local` mode source of truth only. In `self_hosted`
mode, local-only mail is test/import data unless an operator explicitly migrates
it into the self-hosted service.

## Commands

```bash
emails self-hosted setup
emails self-hosted status --json
emails self-hosted migrate
emails domains list --json
emails inbox sources --json
```

`migrate` applies the self-hosted service schema. Local-to-service data movement
is an operator-approved migration task, not an automatic mixed local/remote runtime.

## S3 And Attachments

SES inbound may write raw MIME to S3, and attachment materialization may use S3
behind the self-hosted service. The public OSS client contract is still the same:
clients authenticate with an API key and read/write through the self-hosted
Emails service; the service owns the shared Postgres/S3 state.
