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
export EMAILS_AWS_REGION=us-east-1  # SES; use an IAM role
# export RESEND_API_KEY="..."       # required for Resend
emails db migrate
emails self-hosted key create
emails-serve
```

Run key management on the operator host with the same database and signing-key
environment. `key create` persists only a token hash and metadata and displays
the plaintext token once. `emails self-hosted key list` never shows tokens or
hashes; `emails self-hosted key revoke <kid>` disables a key immediately. The
service rejects signed keys that are absent from its database.

Postgres is authoritative. Local mode uses SQLite. There is no remote, hybrid,
dual-write or synchronization mode between them.

The AWS reference path remains direct and user-owned: SES for sending, S3 for
raw inbound mail and attachments, SNS/SQS with a DLQ for ingestion, Route53 for
DNS, and RDS Postgres for application state. Cloudflare, Resend and Gmail are
optional direct provider integrations using credentials supplied by the user.
