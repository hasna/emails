# Email-address provisioning

> **Status: the stateful provisioning workflow is not implemented.** Every
> `emails provision *` command and the MCP tools `provision_domain`,
> `provision_address`, and `provision_status` returns an actionable error. The
> package ships no provisioning reconciler or `/v1` provisioning route.

The registered commands preserve compatibility and make the missing capability
explicit; registration in `--help` is not a claim that they work. The internal
provisioning records and state-machine helpers are not connected to a shipped
orchestrator.

## Supported operator workflow

For a domain already registered and verified in SES, use the manual path:

```bash
emails provider add --name production-ses --type ses --region us-east-1
emails domain adopt example.com --provider <ses-id> --no-inbound
emails domain dns example.com --provider <ses-id>
emails domain check example.com --provider <ses-id>
emails address add hello@example.com --provider <ses-id>
```

`domain dns` prints expected records and `domain check` reads public DNS. Neither
publishes DNS. `domain verify`, despite appearing in help for compatibility, is
not implemented; use `domain check` for the live result.

When SES should also receive the domain, omit `--no-inbound` from `domain adopt`
or run the explicit inbound setup:

```bash
emails aws setup-inbound \
  --domain example.com \
  --bucket operator-owned-inbound-bucket \
  --provider <ses-id>

# Publish the MX value printed by setup-inbound, then ingest mail:
emails inbox sync-s3 --source <source-id>
emails inbox sources
emails inbox mailboxes
```

Both `domain adopt` and `aws setup-inbound` mutate the AWS account selected by
the executing machine's profile/credentials. In a self-hosted client they are
still operator-side infrastructure commands; the `/v1` server does not perform
that work. Run them only from an operator-controlled machine against the
intended account.

`domain adopt` refuses SES inbound setup if another provider owns public root
MX. Use `--force-mx-switch` only for an intentional inbound migration. For a
send-only SES identity behind Google Workspace or another mailbox provider,
keep `--no-inbound` and preserve the existing MX.

The inbound bucket may also come from `EMAILS_INBOUND_S3_BUCKET` or the
`inbound_s3_bucket` config value written by `domain adopt`. There is no
`emails config` command in this build.

## Local MCP infrastructure helpers

Local mode also exposes direct, operator-credentialed infrastructure tools:

- `setup_domain_for_email` can buy through Route 53 Domains, create a
  Cloudflare zone, delegate nameservers, register the mail provider domain, and
  publish email DNS in Cloudflare;
- `setup_cloudflare_dns` publishes DKIM/SPF/DMARC and optional MX records;
- `setup_ses_inbound` creates the S3 bucket and SES receipt rules.

These are one-shot infrastructure helpers, not the missing resumable
`provision_*` workflow. They are refused in `self_hosted` mode because otherwise
they would mutate infrastructure using the client machine's ambient cloud
credentials while recording state in the operator's shared service.

## Mailbox model

SES, Resend, and Cloudflare routing are capabilities or ingestion paths, not
IMAP/POP mailboxes. SES can archive raw MIME to S3; `emails inbox sync-s3` parses
it into the selected Emails store. Cloudflare Email Routing forwards mail and
does not create a stored mailbox here. Resend inbound is persisted only when a
configured webhook delivers it to this application.

App-level forwarding under `emails forwarding` runs only after this package has
received or synced the source message. If Google Workspace, Microsoft 365, or
another provider owns root MX and mail never enters Emails, configure forwarding
at that provider.

## Unimplemented target

The intended resumable domain/address state machine, retry/status commands,
daemon, and round-trip acceptance runner remain design work. Their historical
design is preserved in [PLAN-PROVISIONING.md](PLAN-PROVISIONING.md); it is not an
operator runbook and its example future commands must not be used as current
instructions.
