# Domain readiness

Emails supports two deployment modes:

- `local`: SQLite and local files are authoritative.
- `self_hosted`: the operator's Postgres, S3, queues and provider accounts are authoritative.

Provider integrations are capabilities, not deployment modes. AWS SES/S3/SNS/SQS,
Route53, Cloudflare and Resend always use credentials supplied by the operator
and communicate directly with those providers. Additional mailbox providers are
not supported as provider backends.

A sending domain is ready only after ownership, DKIM and SPF evidence is valid.
Inbound readiness additionally requires an active provider route and durable
source such as SES to S3/SQS.

No shipped command publishes DNS. `emails domain dns` prints the records to
publish and `emails aws setup-inbound` prints the MX record it needs, both for
you to apply at your DNS provider; nothing purchases a domain or changes MX
implicitly. (`emails domain buy` purchases explicitly, and `emails domain adopt`
refuses to wire SES inbound when public root MX belongs to another provider
unless `--force-mx-switch` is passed.)

Useful checks — these run in every configuration, because they resolve public
DNS and need no server:

```bash
emails domain dns example.com --provider <provider>   # records the domain must publish
emails domain check example.com                       # what is actually published, plus root-MX owner
```

`emails domain verify`, `emails domain status`, `emails domains connect`,
`emails domains enable-inbound|enable-outbound|disable-outbound` and
`emails provision *` are NOT implemented in this build. Running any of them
prints what is missing and which command to use instead.

Self-hosted API clients must explicitly configure `EMAILS_MODE=self_hosted`,
`EMAILS_SELF_HOSTED_URL`, and `EMAILS_SELF_HOSTED_API_KEY`. No endpoint, account,
database, bucket or secret path is supplied by the package.
