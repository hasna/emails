# @hasna/emails

Mailery is an email management CLI + MCP server - send, receive, sync, and manage email via Resend, AWS SES, and Cloudflare-routed inbound mail.

[![npm](https://img.shields.io/npm/v/@hasna/emails)](https://www.npmjs.com/package/@hasna/emails)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

Mailery is built for the Bun runtime. Install Bun 1.3 or newer before installing
the CLI with npm.

```bash
npm install -g @hasna/emails
```

## Open Core And Cloud

Users install the open-source package: `@hasna/emails`.

Mailery stays local-first by default: local SQLite, local provider credentials,
and local MCP. Self-hosted mode uses user-owned PostgreSQL/S3/SES as source of
truth with local SQLite as a runtime cache. Mailery Cloud is an opt-in
hosted source of truth at `https://mailery.co`; the same public CLI can sign up,
create an agent API key, create a billing link, create hosted mailboxes, read
hosted messages, generate hosted digests, and pull cloud mail into local SQLite.
The per-domain readiness contract for local, self-hosted, and cloud operation
lives in [`docs/DOMAIN_READINESS.md`](docs/DOMAIN_READINESS.md).

The SaaS control plane is private Hasna Tools infrastructure. End users and
open-source contributors should not install or depend on private Hasna Tools
platform packages.

`@hasna/emails` is the canonical package. It was briefly published as
`@hasna/mailery`; that name has been retired here and freed for the separate
Hasna Tools cloud CLI, so new installs and docs should use `@hasna/emails`.

## Quick Start

```bash
# Add a provider (SES or Resend)
emails provider add --name production-ses --type ses --region us-east-1 --access-key ... --secret-key ...
emails provider add --name production-resend --type resend --api-key ...

# Set up a domain (buy + DNS + SES in one command)
emails domain setup example.com --provider <id> --email you@example.com ...

# Or connect a domain you already own without buying or calling Mailery Cloud
emails domains connect example.com --provider <id> --source-of-truth local --dry-run
emails domains connect example.com --provider <id> --source-of-truth postgres --dns-provider route53 --no-register-provider

# Or configure DNS for an existing domain via Cloudflare
emails domain setup-cloudflare example.com --provider <id>

# Check public DNS before changing inbound routing
emails domain check example.com

# SES send-only setup preserves existing MX, such as Google Workspace
emails provision domain example.com --provider <ses-id> --dry-run

# Send an email
emails send --from you@example.com --to them@example.com --subject "Hi" --body "Hello"

# Pull inbound mail from SES/S3 or Cloudflare-routed storage
emails inbox source add-s3 --bucket <bucket> --prefix inbound/example.com/ --provider <provider-id>
emails inbox sync-s3 --bucket <bucket> --prefix inbound/example.com/

# Inspect mailbox folders and ingestion sources
emails inbox mailboxes
emails inbox sources
emails inbox list --folder unread --source provider:<id>

# Check sent email log
emails email list

# Use self-hosted PostgreSQL/S3/SES as source of truth
emails self-hosted status
emails self-hosted migrate-local
```

## Mailery Cloud

Cloud commands are non-interactive enough for agents and CI. Use `--no-open`
when creating billing links from a headless environment.

```bash
# Show the hosted service status
emails cloud --api-url https://mailery.co status

# Create or log into a hosted account, generate an agent API key, and create a
# hosted billing link without opening a browser
emails cloud setup \
  --api-url https://mailery.co \
  --email you@example.com \
  --password "$MAILERY_PASSWORD" \
  --api-key-name "Agent CLI" \
  --scope mail_read mail_write billing_read \
  --billing \
  --no-open

# Hosted mailbox and message workflow
emails cloud mailbox add agent@example.com --provider manual
emails cloud messages list --limit 20
emails cloud messages pull --limit 20
emails inbox list --limit 20

# Billing and domains
emails cloud billing overview
emails cloud billing subscribe --plan starter --no-open
emails cloud domain available example-agent-mail.com
emails cloud domain setup example-agent-mail.com --address agent --catch-all --mx-migration-consent
```

The starter SaaS plan is currently `$10/month` and grants hosted credits. Domain
setup can return DNS records in safe planning mode before any domain purchase or
MX migration is performed.

## Domain Modes

Mailery is a multi-domain aggregator. Every domain is tracked independently, so
DNS, inbound, outbound, and safety state belong to the domain, not to the app as
a whole.

Use these setup paths:

| Mode | Who owns the mail source of truth | Domain setup path |
| --- | --- | --- |
| `local` | The local SQLite/files install | `emails domains add` or `emails domains connect --source-of-truth local`; DNS checks are advisory unless using a real send/receive provider. |
| `self_hosted` | Your PostgreSQL/S3/SES or equivalent infrastructure | `emails domains connect --source-of-truth postgres`, then publish the returned DNS tasks and enable inbound/outbound when evidence is ready. |
| `cloud` | Mailery Cloud at `https://mailery.co` | `emails cloud domain setup`; SaaS billing and tenant checks are handled by the hosted control plane. |

Authentication records are required only for the capability you enable:

- Inbound aggregation needs an inbound route, usually MX plus SES/S3 or another
  configured source.
- Outbound sending needs ownership verification plus DKIM and SPF/custom MAIL
  FROM alignment for the selected provider.
- DMARC is per sending domain. It does not block local viewing or inbound
  aggregation, but it should be present before production sending and monitored
  before moving from `p=none` to stricter policies.

For self-hosted migration, run `emails self-hosted migrate-local` once, switch
to `MAILERY_MODE=self_hosted` with `HASNA_EMAILS_STORAGE_MODE=remote`, and treat
PostgreSQL/S3 as the durable source of truth. Local SQLite is then only a runtime
cache prepared from and flushed back to the self-hosted source.

## Mailery UI (`emails ui`)

A full-screen OpenTUI mail client with a responsive dashboard shell. Wide
terminals use a two-column admin layout with persistent navigation, mailbox
metrics, operations health, folders, actions, and a focused workspace. Inbox on
wide terminals uses a split message list + preview reader. Narrow terminals collapse to
a compact single-column view with the same Inbox, Compose, Domains, and
Settings dialog. Inbox starts at all addresses and can be filtered to one email
address when needed. Mailbox source status is exposed through CLI/API/MCP
surfaces without treating provider credentials as inboxes. Live read-state,
local refresh, background auto-pull, and an `auto`/`light`/`dark` color theme
keep the mailbox current and readable across terminals.

```bash
emails ui
emails ui --mailbox unread
```

The app uses visible buttons and the Shortcuts command palette for actions.
Mailbox filtering is handled by the mailbox dialog, which lists all mailboxes
and configured/observed recipient addresses. Sidebar labels filter mailbox
content, and Gmail-style Categories show Primary, Social, Promotions, Updates,
and Forums separately from custom labels. Reader shows
attachments with size/type. Composer writes **markdown** rendered to HTML on
send. Settings opens as a simple menu dialog for sync, defaults, and display
controls. Folders: Inbox · Unread · Starred · Sent · Archived · Spam · Trash.

## Command Structure

```
emails ui                # Mailbox UI - inbox, compose, domains, settings
emails provider          # provider credentials/capabilities (ses, resend, sandbox)
emails domain            # add/verify/buy/setup/dns/check domains
emails address           # manage sender addresses (add, suspend, activate, quota)
emails status            # redacted system status + next useful actions
emails agent context     # agent-oriented context snapshot and workflows
emails daemon            # background queue/realtime status and restart guidance
emails logs tail         # local daemon/sync/inbound/scheduler log tails
emails owner             # tenancy: register human/agent owners
emails alias             # per-domain aliases + catch-all routing
emails forwarding        # app-level forwarding for locally received/synced mail
emails sendkey           # scoped send keys (restrict an agent to its own addresses)
emails send              # send an email
emails reply / forward   # reply (in-thread) or forward a sent/inbound email
emails email             # sent email: list, search, show, replies, conversation
emails inbox             # mailbox folders, sources, sync, read/star/archive/label, watch
emails template          # email templates
emails contact           # contacts (suppression list)
emails group             # recipient groups
emails sequence          # drip sequences
emails schedule          # scheduled emails: list, cancel, run
emails triage            # AI triage: classify, prioritize, draft replies
emails storage           # self-hosted PostgreSQL storage: status, migrate, migrate-local, push, pull
emails self-hosted       # source-of-truth runtime setup/status/migrate commands
emails cloud             # optional Mailery Cloud signup/login/billing/mailbox/message/digest/domain workflow
emails aws               # AWS setup: SES receipt rules, S3 inbound bucket
emails config            # configuration (key=value)
emails stats             # delivery statistics (--inbox for received mail)
emails analytics         # email analytics
emails doctor            # system diagnostics
emails doctor delivery   # diagnose missing inbound mail for one address
emails serve             # HTTP server + dashboard + authenticated /api/v1
emails mcp               # install MCP server
```

### Compact Output and Gradual Disclosure

Mailery CLI commands are compact by default so agent terminals do not fill with
large records. List and status commands show essential fields, bounded row
counts, and hints for the next detail command. Use these flags when you need
more:

```bash
emails address list              # compact table
emails address list --verbose    # expanded owner/admin/quota rows
emails domain status --verbose   # includes per-domain issue and fix lines
emails provider list --limit 50  # explicit larger page
emails contact list --suppressed # compact filtered contact list
emails template show <name>      # detail path for template bodies
emails sequence show <name>      # detail path for steps/enrollments
emails forwarding list --source ops@example.com
emails agent context             # compact agent context summary
emails agent context --verbose   # full redacted context snapshot
emails agent context --json      # full machine-readable context
emails config list --verbose     # full redacted config values
emails config keys --verbose     # include examples for every key
emails email show <id>           # detail path for one sent email
emails inbox read <id>           # detail path for one inbound email
```

`--json` remains the machine-readable path. Broad MCP list tools default to
their existing bounded summary page size for compatibility; use each tool's
`limit`/`offset` inputs or the matching detail tool/resource for larger or full
records. `emails://agent/context` is sampled for orientation; use
`emails://agent/context/full` for the full redacted MCP resource.

## Tenancy, aliases & scoped send keys

Every address can have an **owner** that is a human or an agent. A human-owned
address must be administered by an agent (the agent operates it on the human's
behalf); agent-owned addresses are self-administered.

```bash
# Register owners and assign an address (human-owned, agent-administered)
emails owner register Morgan --type human --email morgan@example.com
emails owner register Atlas  --type agent
emails provision address morgan@example.com --provider <ses-id> --owner Morgan --administrator Atlas
emails address owner morgan@example.com
emails address set-owner morgan@example.com --owner Morgan --administrator Atlas
emails address transfer-owner morgan@example.com --owner Atlas --reason "handoff" --yes
emails address unassign-owner morgan@example.com --reason "retired" --yes
emails address owner-history morgan@example.com

# Scoped send keys — an agent can only send from addresses it owns/administers
emails sendkey create Atlas --label ci        # prints the esk_... token ONCE
emails sendkey check  Atlas morgan@example.com # authorized
emails sendkey list / revoke <id>

# Per-domain aliases + catch-all
emails alias add support@example.com ops@example.com
emails alias catch-all example.com inbox@example.com   # *@example.com -> inbox@
emails alias global inbox@example.com                  # protected global catch-all (ALL domains)
emails alias resolve anything@example.com              # show where it routes

# App-level forwarding: forwards only mail already received or synced locally.
# Use provider-native forwarding when the mailbox provider owns root MX.
emails forwarding explain support@example.com
emails forwarding add support@example.com archive@example.net --provider <provider-id>
emails forwarding run --provider <provider-id>            # future mail only
emails forwarding run --provider <provider-id> --backfill # intentionally include older synced mail

# Address lifecycle
emails address provision ops@example.com --provider <ses-id> --owner Atlas
emails address suggest --domain example.com
emails address suspend <id>     # block sending from this address
emails address activate <id>
emails address quota <id> 200   # max 200 sends/day (use 'none' to clear)
```

## DNS and inbound safety

`emails domain check <domain>` detects common root MX owners, including Google
Workspace, Microsoft 365, Cloudflare Email Routing, Zoho, Proton, and AWS SES.
SES send-only provisioning does not require changing root MX and is the safest
path when an existing mailbox provider already receives mail.

Publishing SES inbound MX is only for domains that should receive through
SES/S3. Commands that can add SES inbound MX refuse to proceed when public MX
already belongs to another provider. `--force-mx-switch` is available for
intentional migrations after confirming mailbox ownership can move.

## MCP Server

100+ tools for AI agents — send/read mail, provisioning, tenancy, aliases, scoped
send keys, inbound read-state, real-time sync, agent context, source-aware
mailbox status, ownership lookup/assignment/transfer audit, and
verification-code waiting.

Terminology used by the CLI, REST API, MCP tools, and TUI:

- **Provider**: credentials and capability, such as SES send rights, Resend API access, or a sandbox.
- **Source**: an ingestion stream that brings mail into local storage, such as `provider:<id>`, `s3:<bucket>`, Cloudflare-routed inbound storage, `legacy`, or `orphaned:<id>`.
- **Mailbox**: the user-visible scope being browsed, such as all mail, one address, or one domain.
- **Folder**: a mailbox view such as `inbox`, `unread`, `sent`, `starred`, `archived`, `spam`, or `trash`.

Useful source-aware surfaces:

```bash
emails inbox sources --json
emails inbox mailboxes --source provider:<id> --json
emails inbox search invoice --folder sent --source provider:<id> --json
curl 'localhost:3900/api/sources'
curl 'localhost:3900/api/mailboxes?source_id=legacy'
```

```bash
emails-mcp
```

## REST API

`emails serve` exposes a dashboard plus two API surfaces:

- **Dashboard / management API** under `/api/*` (providers, domains, addresses, emails, stats).
- **Authenticated programmatic API** under `/api/v1/*` for agents/apps, keyed on a
  scoped send key (`Authorization: Bearer esk_…`). Every call is scoped to the
  key owner's addresses, so one caller can't act as another tenant:

```bash
emails serve   # or: emails-serve   (HOST=0.0.0.0 to allow other machines)

curl -H "Authorization: Bearer $ESK" localhost:3900/api/v1/addresses
curl -H "Authorization: Bearer $ESK" -X POST localhost:3900/api/v1/provision/address -d '{"email":"ops@example.com"}'
curl -H "Authorization: Bearer $ESK" -X POST localhost:3900/api/v1/send -d '{"from":"ops@example.com","to":"x@y.com","subject":"hi","text":"yo"}'
curl -H "Authorization: Bearer $ESK" 'localhost:3900/api/v1/inbox?limit=50&offset=0&search=invoice'  # scoped, paginated inbox
```

## Library API

Import the stable local API from `@hasna/emails`. The public entrypoint covers
provider/domain/address CRUD, sending, inbound storage and listing, templates,
contacts and suppression, sequences, exports, ownership helpers, and scoped send
keys.

```ts
import {
  sendWithFailover,
  createProvider,
  createAddress,
  storeInboundEmail,
  createTemplate,
  suppressContact,
  createSequence,
  exportEmailsJson,
  createOwner,
  setAddressOwnerByRef,
  createSendKey,
} from "@hasna/emails";
```

## Inbound Email (AWS SES -> S3)

```bash
# Set up S3 bucket + SES receipt rules
emails aws setup-inbound --domain example.com --bucket my-emails

# Pull received emails on demand
emails inbox sync-s3 --bucket my-emails --prefix inbound/example.com/

# Read-state / organize (works for SES-S3, SMTP, Cloudflare-routed, and legacy imported mail)
emails inbox list --unread            # filters: --unread/--read/--starred/--archived/--label <l>
emails inbox latest ops@example.com --json
emails inbox wait ops@example.com --timeout 120
emails inbox wait-code ops@example.com --from openai --timeout 120
emails inbox sync-status --json       # S3 and realtime status
emails inbox explain <id>             # route/owner/readiness trace
emails inbox read <id>                # opening marks it read
emails inbox star|archive|label <id>  # --undo / --remove to reverse
```

### Real-time inbound (no manual sync)

Push delivery so mail lands automatically. `setup-realtime` wires SES → SNS → SQS
(and attaches the topic to the receipt rule); `watch` long-polls and auto-syncs:

```bash
emails inbox setup-realtime example.com   # creates SNS topic + SQS queue, saves the queue URL
emails inbox watch                        # auto-delivers new mail in real-time (--once to poll once)
```

Alternatively, point an SNS HTTP subscription at `POST /webhook/ses-inbound` on
`emails serve` auto-confirms the subscription and syncs on each notification.

## Self-Hosted Runtime (PostgreSQL/S3/SES)

The canonical local/self-hosted/cloud runtime contract lives in
[`docs/SELF_HOSTED_RUNTIME.md`](docs/SELF_HOSTED_RUNTIME.md). The per-domain
aggregator and sending-readiness contract lives in
[`docs/DOMAIN_READINESS.md`](docs/DOMAIN_READINESS.md). Together these documents
are the source of truth for the active migration from local-authoritative mail to
a self-hosted PostgreSQL/S3 runtime.

Mailery is local-first. The public OSS default is local SQLite and files under
`~/.hasna/emails/`, with no remote dependency. Self-hosted runtime is opt-in,
and uses the `emails` slug for database URL compatibility: use
`HASNA_EMAILS_DATABASE_URL`, not `HASNA_MAILERY_DATABASE_URL`.

For managed or self-hosted PostgreSQL, set `HASNA_EMAILS_DATABASE_URL` to the
database connection string without printing or committing it. Self-hosted
installs can use the fallback `EMAILS_DATABASE_URL`.

Mailery modes:

- `local` - all reads/writes stay in local SQLite/files.
- `self_hosted` - user/org-owned infrastructure. PostgreSQL is the source of
  truth for provider, mailbox, message, label, send, and state rows. S3 stores
  raw SES MIME and optional attachment objects. Local SQLite is a runtime cache
  that is prepared from PostgreSQL and flushed back after CLI commands; long
  running MCP/server processes flush periodically. For Hasna's own self-hosted
  deployment this means AWS RDS plus SES/S3, but the concrete cluster, bucket,
  and secret-path values live in private deployment secrets and are not package
  defaults.
- `cloud` - Hasna-operated Mailery Cloud SaaS at `https://mailery.co`.

Deprecated `remote` and `hybrid` values are accepted as aliases only for the
deployment mode (`MAILERY_MODE`, `HASNA_EMAILS_MODE`, or legacy config keys) and
map to `self_hosted`. The lower-level storage sync mode remains separate:
`HASNA_EMAILS_STORAGE_MODE=remote` means PostgreSQL source of truth with local
runtime cache. `HASNA_EMAILS_STORAGE_MODE=hybrid` keeps local SQLite as source
and only syncs when `emails storage pull`, `emails storage push`, or
`emails storage sync --force` is run explicitly.

```bash
# Configure RDS/PostgreSQL
export HASNA_EMAILS_DATABASE_URL="postgres://..."
# Optional self-hosted fallback:
# export EMAILS_DATABASE_URL="postgres://..."

# Optional explicit mode; default is local without a DB URL, self_hosted with one.
export MAILERY_MODE=self_hosted
export HASNA_EMAILS_STORAGE_MODE=remote

# Optional AWS/S3 settings for self-hosted inbound and attachments.
# Use your own bucket names and account-specific secrets.
export EMAILS_INBOUND_S3_BUCKET="your-mailery-inbound-bucket"
emails config set attachment_storage s3
emails config set attachment_s3_bucket "your-mailery-attachments-bucket"

# Check source-of-truth runtime status
emails self-hosted status

# Apply PostgreSQL migrations
emails self-hosted migrate

# One-time local SQLite → self-hosted PostgreSQL migration
emails self-hosted migrate-local
```

Storage internals are intentionally kept off the default library entrypoint.
Import them from the explicit subpath when building storage tooling:

```ts
import { getStorageStatus, prepareSelfHostedRuntimeCache } from "@hasna/emails/storage";
```

See `docs/SELF_HOSTED_RUNTIME.md` for the source-of-truth contract.

## Data

Stored in `~/.hasna/emails/` (SQLite + attachments).

## Transport

The shared Streamable HTTP transport is the default (one process, many agents); pass
`--stdio` for a per-client stdio server:

```bash
emails-mcp                     # http://127.0.0.1:8861/mcp (default)
emails-mcp --port 8861         # explicit port
emails-mcp --stdio             # stdio transport (one server per client)
MCP_STDIO=1 emails-mcp         # same
```

- Health: `GET http://127.0.0.1:8861/health` -> `{"status":"ok","name":"mailery"}`
- Override port with `MCP_HTTP_PORT` or `--port`

## License

Apache-2.0 — see [LICENSE](LICENSE)
