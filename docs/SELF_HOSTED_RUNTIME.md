# Self-hosted runtime

Self-hosted means the operator owns the deployment, provider accounts and data.
Emails does not provide or infer a hosted endpoint.

Client configuration:

```bash
export EMAILS_MODE=self_hosted
export EMAILS_SELF_HOSTED_URL="https://emails.example.com"
export EMAILS_SELF_HOSTED_API_KEY="..."
emails inbox list
```

Service configuration:

```bash
export EMAILS_MODE=self_hosted
export EMAILS_DATABASE_URL="postgresql://..."
export EMAILS_API_SIGNING_KEY="..." # 32+ characters
export EMAILS_SEND_PROVIDER=ses     # or resend
export EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS="example.com"   # required; your own domains
export EMAILS_AUTH_FROM="no-reply@example.com"           # required; a verified sender identity
export EMAILS_AWS_REGION=us-east-1
# SES identity — pick ONE:
#   (a) nothing: sign with the deployment IAM role of the account the service runs in
#   (b) an explicit SES key pair, injected from your secret store:
# export EMAILS_SES_ACCESS_KEY_ID="..."
# export EMAILS_SES_SECRET_ACCESS_KEY="..."
# export EMAILS_SES_CONFIGURATION_SET="..."  # optional; makes SES metrics attributable
# export RESEND_API_KEY="..."       # required for Resend
#
# SES credentials are resolved from the SERVER environment, never per provider:
# `emails provider add --access-key/--secret-key` does not reach a self-hosted
# server, and `emails send --provider` is ignored by the send route. When the
# host has an instance/task role for a production-access SES account, set
# nothing more. When production-access SES lives in a different account, supply
# the sending IAM user's credentials to the server process:
#
#   export AWS_ACCESS_KEY_ID="..."            # repoints the SDK default chain
#   export AWS_SECRET_ACCESS_KEY="..."
#
# On AWS these must be injected from a secret store by reference (see
# deploy/aws/README.md, "Sending through SES in a different account"), never
# written into a plaintext container `environment` block, a shell profile, or
# the repository.
emails db migrate
emails self-hosted key create
emails-serve
```

## Auth: signup domain allowlist and sender identity

Two auth variables are **required** and have **no defaults** — the service refuses
to boot without them, naming the missing one:

| Variable | Purpose |
| --- | --- |
| `EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS` | Comma- or space-separated allowlist of email domains permitted to sign up, log in, or be invited. `*` matches exactly one DNS label, so `example.*` allows `example.com` and `example.org` but not `sub.example.com`. |
| `EMAILS_AUTH_FROM` | Sender identity for confirmation / password-reset / invite mail. Must be verified in the provider account the service actually signs into. |

Neither ships a default on purpose. A built-in allowlist would pin every install
to one organisation's domains and reject the operator's own staff with a
deliberately opaque 403 (the gate never reveals whether an account exists, so a
wrong allowlist looks like a broken login); a permit-all fallback would silently
open signup on upgrade. Likewise, a default `EMAILS_AUTH_FROM` would only be
sendable by whoever published the build.

`*` matches exactly one DNS label, never a dot, so a subdomain can never sneak in
through a wildcard. Two consequences worth stating: a single bare `*` is rejected
(one label would allow `root@localhost`), and `*.*`, while accepted, is effectively
**permit-all** — if that is what you want, say so deliberately.

Related optional auth variables: `EMAILS_AUTH_PRODUCT_NAME` (name shown in the
email copy) and `EMAILS_AUTH_VERIFY_URL_BASE` / `EMAILS_AUTH_RESET_URL_BASE` /
`EMAILS_AUTH_INVITE_URL_BASE` (override the links, which otherwise derive from
`EMAILS_PUBLIC_BASE_URL`).

## Outbound SES credentials

The service signs outbound SES calls with **one** identity, resolved at boot:

1. `EMAILS_SES_ACCESS_KEY_ID` + `EMAILS_SES_SECRET_ACCESS_KEY` when both are set;
2. otherwise the deployment IAM role (the AWS SDK default chain).

Setting only one of the pair is a hard startup error — half a key pair would
otherwise be completed from the ambient chain and sign with a mixed identity.

The names are deliberately scoped rather than the generic `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`: the service's task/instance role may hold unrelated
grants (S3 for inbound, SQS for the ingest worker), and the generic names would
re-point every AWS client in the process, not just SES.

Inject the values as **secret references** (AWS Secrets Manager / SSM / your
secret store), never as plaintext deployment config, and never in the
repository.

The self-hosted `providers` resource stores non-secret metadata only
(`name`, `type`, `region`, `active`). `emails provider add --access-key …`
against a self-hosted server therefore **fails with an explicit error** naming
these variables, instead of accepting the flags and dropping the values.

## Reconciling an unknown send outcome

If a provider call fails without a definitive answer (network error, provider
5xx), the ledger row is marked `send_state = 'uncertain'`: the message may or
may not have gone out. Those rows must be closed out against real provider
evidence, one at a time:

```bash
emails send-intent uncertain
emails send-intent reconcile <message-id> --outcome not-sent \
  --evidence "no SES Send datapoint for this window"
emails send-intent reconcile <message-id> --outcome sent \
  --provider-message-id <ses-message-id> \
  --evidence "SES delivery event for this MessageId"
```

Reconciliation only ever transitions an `uncertain` row; a proven outcome is
never overwritten, and the evidence plus the resolving principal are persisted
on the row.

Run key management on the operator host with the same database and signing-key
environment. `key create` persists only a token hash and metadata and displays
the plaintext token once. `emails self-hosted key list` never shows tokens or
hashes; `emails self-hosted key revoke <kid>` disables a key immediately. The
service rejects signed keys that are absent from its database.

For a rename cutover, run `emails self-hosted key rotate`. It creates a new
Emails application key but deliberately retains the active Mailery-era key.
Move clients, verify reads and sends, keep the old key for the agreed rollback
window, and revoke it explicitly only after rollback is no longer required.

Postgres is authoritative. Local mode uses SQLite. There is no remote, hybrid,
dual-write or synchronization mode between them.

The AWS reference path remains direct and user-owned: SES for sending, S3 for
raw inbound mail and attachments, SNS/SQS with a DLQ for ingestion, Route53 for
DNS, and RDS Postgres for application state. Cloudflare and Resend are optional
direct integrations using credentials supplied by the user. No additional
mailbox-provider import backend is included in this OSS package.

## Production boundary

- Put `emails-serve` behind an HTTPS ALB/reverse proxy. Apply per-key/IP rate
  limits, a 1 MiB request cap, bounded timeouts, and firewall rules; do not
  expose the container or Postgres directly to the internet.
- Use an AWS task/instance role with only the required SES, S3, SQS and SNS
  actions. Local operators should prefer `AWS_PROFILE`; long-lived access keys
  are discouraged.
- Use separate database roles. `emails-migrate` owns DDL; `emails-serve` uses
  the runtime role with table/sequence DML only. The provided Compose init
  script establishes those grants on a new database.
- Self-hosted sends require a durable idempotency key. Inline attachments are
  limited to five, 512 KiB each and 768 KiB total. Scheduled sends are not
  supported by the self-hosted API. Explicit-id bulk mailbox mutations are.
- Resend webhook signatures are mandatory. SES inbound requires a verified AWS
  SNS signature plus exact topic ARN and AWS account allowlists.

## Reproducible dependency pins

The Dockerfile, Compose database image, and CI actions use immutable digests or
commit SHAs. Refresh them in a reviewed dependency update: verify the upstream
tag/release, resolve its current digest/SHA, run the full isolated suite and
Postgres integration job, then record the change in the changelog. Never
silently retag a deployment.
