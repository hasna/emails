# Emails Domain Readiness

Emails is a multi-domain mail aggregator and sender. An Emails install can
manage many domains, and each domain has its own ownership, inbound, outbound,
DNS, provider, and safety state. No single DMARC, DKIM, SPF, MX, or SES setting
makes the whole app ready or not ready.

This document is the canonical OSS contract for domain readiness.

## Deployment Modes

Emails has exactly two OSS user-visible modes.

| Mode | Owner | Source of truth | Client access |
| --- | --- | --- | --- |
| `local` | User machine | Local SQLite/files | Local CLI/MCP/API process |
| `self_hosted` | User or organization | Self-hosted Emails service backed by shared cloud/Postgres state | API-key-authenticated CLI/MCP/API calls |

Legacy aliases accepted by compatibility code are not supported OSS runtime modes. User-facing docs and CLI output should say `local` or `self_hosted`.

## Domain Types

Every domain belongs to exactly one operational scope.

| Type | Example | Meaning |
| --- | --- | --- |
| Self-hosted domain | `example.com` in a user AWS account | A user-owned domain managed by the self-hosted Emails service. |
| Local-only domain | `example.test` or imported mail | A local development or imported-mail domain with no provider readiness guarantee. |

Self-hosted domains must not depend on a hosted SaaS control plane to function.

## Lifecycle

The canonical lifecycle is per domain:

```text
added -> ownership_verified -> inbound_ready -> outbound_ready -> monitored -> restricted
```

`suspended` is a terminal or administrative state that can replace `restricted`
when the domain must be fully disabled.

| State | Meaning |
| --- | --- |
| `added` | The domain row exists, but Emails has not proven ownership or provider readiness. |
| `ownership_verified` | The operator or platform has proved control over the domain through DNS, provider identity, or explicit trusted configuration. |
| `inbound_ready` | Mail for the domain can be received through the configured inbound provider and stored in the active source of truth. |
| `outbound_ready` | Emails may send with `From:` addresses on this domain through the configured provider. |
| `monitored` | Real outbound data is flowing and bounce, complaint, delivery, and authentication signals are being observed. |
| `restricted` | The domain can still exist and receive mail, but one or more risky operations are disabled. |
| `suspended` | The domain is disabled for both sending and operational changes until manual or automated remediation. |

Inbound and outbound readiness are independent. A domain can aggregate inbound
mail without being allowed to send. A send-only domain can send without moving
root MX to Emails, as long as provider and authentication requirements are met.

## Readiness Signals

Emails should store and report these signals per domain.

| Signal | Scope | Required for |
| --- | --- | --- |
| Ownership verification | Domain | Inbound and outbound setup beyond local-only/imported use |
| MX routing | Domain | Inbound readiness when Emails receives mail for the domain |
| Provider inbound route | Domain/provider | Inbound readiness |
| DKIM verification | Domain/provider | Outbound readiness |
| SPF or custom MAIL FROM alignment | Domain/provider | Outbound readiness |
| DMARC record | Domain | Monitoring and production-grade outbound posture |
| SES/account production access | Provider/account | Real self-hosted SES outbound at scale |
| Bounce/complaint/reject events | Domain/provider | Monitored state and restriction automation |

DMARC is intentionally listed as a domain signal, not an app signal. It should
not block local mail viewing or self-hosted inbound aggregation. It matters when
Emails sends from that domain and wants a production-grade sender posture.

## Mode-Specific Rules

### Local

Local mode is the OSS default. Local SQLite and files are the source of truth.
Domain readiness is advisory unless the user configures a real sending or
receiving provider.

Local mode may:

- import, browse, and search mail;
- sync from configured sources;
- use local/test send providers when explicitly configured;
- show DNS and authentication checks for real domains.

Local mode must not:

- silently claim a domain is production-ready;
- send through a real provider without provider credentials and per-domain outbound readiness;
- require a hosted account.

Typical local setup:

```bash
emails domains add example.com --provider <provider-id>
emails domains connect example.com --provider <provider-id> --source-of-truth local --dry-run
emails domains status example.com --json
```

For a local-only/imported-mail domain, DNS output is guidance. It becomes a hard
send requirement only when the user chooses a real sending provider.

### Self-Hosted

Self-hosted mode uses the self-hosted Emails service as the source of truth. The
CLI, MCP server, and API clients authenticate with an API key and read/write
email state through that service. The service stores domain, mailbox, message,
provider, send, and operational state in the shared cloud/Postgres deployment.

Self-hosted mode may use AWS RDS/S3/SES, but the OSS contract is not
AWS-exclusive. AWS-specific helpers are implementation details for SES/S3
operators.

Self-hosted mode must:

- verify each domain independently;
- store inbound and outbound readiness in the self-hosted service;
- fail closed before sending from a domain that is not outbound-ready;
- keep local SQLite out of the supported source-of-truth path;
- avoid storing operator-specific secret names, bucket names, or account IDs in public defaults.

Typical self-hosted setup:

```bash
export HASNA_EMAILS_MODE=self_hosted
export HASNA_EMAILS_API_URL='<self-hosted-service-url>'
export HASNA_EMAILS_API_KEY='<redacted-api-key>'

emails self-hosted status --json
emails domains connect example.com --provider <ses-id> --source-of-truth postgres --dns-provider route53 --no-register-provider
emails domains dns example.com --json
emails domains verify example.com
emails domains enable-inbound example.com
emails domains enable-outbound example.com
```

`domains connect` is for domains the operator already owns. It does not require
a hosted account, and `--no-register-provider` keeps the command to source-of
truth metadata plus DNS tasks when the provider identity already exists. Domain
purchase remains a separate registrar action (`domain buy` / `domain setup`) and
must be explicit.

## Sending Guard

Every outbound send path should use a single domain guard before provider send:

```text
resolve From domain
load active mode
load domain provider state
require ownership_verified
require outbound_ready
require provider/account send capability
send or fail closed with the exact missing requirement
```

The guard must reject:

- sending as an unknown domain;
- sending as a domain owned by a different provider scope;
- sending with DKIM/SPF/custom MAIL FROM missing when the provider requires it;
- sending through SES when the active account is sandboxed and the target flow requires production access.

## DNS Output Contract

Every domain readiness command or API should expose:

- required records;
- current observed records;
- missing records;
- conflicting records;
- exact next action;
- whether the command is advisory, planned, or mutating.

DNS output must never silently overwrite MX records. Any MX migration requires
explicit user consent and a preview of the previous records.

## Command/API Implications

These surfaces should read from the same readiness state:

```bash
emails domains status example.com --json
emails domains dns example.com --json
emails domains verify example.com
emails domains connect example.com --provider <provider-id> --source-of-truth local --dry-run
emails domains connect example.com --provider <provider-id> --source-of-truth postgres --dns-provider route53 --no-register-provider
emails address usable --send
emails agent context --json
```

MCP tools should expose the same state through domain/status resources and include
`cli_equivalent` hints back to the `emails` commands.

## Completion Criteria

The domain-readiness implementation is complete when:

- local and self-hosted vocabulary is consistent in docs and CLI output;
- the OSS package can represent many domains with independent lifecycle state;
- inbound and outbound readiness are independent;
- all real send paths use the same fail-closed domain guard;
- self-hosted mode proves CLI/MCP/API reads and writes use the API-key-authenticated service;
- tests cover DNS parsing, lifecycle transitions, send guard failures, and source-of-truth behavior without requiring live secrets.
