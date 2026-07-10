# @hasna/emails

Emails is an open-source email management CLI + MCP server - send, receive, sync, and manage email via Resend, AWS SES, and Cloudflare-routed inbound mail.

[![npm](https://img.shields.io/npm/v/@hasna/emails)](https://www.npmjs.com/package/@hasna/emails)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

Emails is built for the Bun runtime. Install Bun 1.3 or newer before installing
the CLI with npm.

```bash
npm install -g @hasna/emails
```

## Open Source And Self-Hosted

Users install the open-source package: `@hasna/emails`.

Emails stays local-first by default: local SQLite, local provider credentials,
and local MCP. Self-hosted mode is a remote-service mode: the CLI, MCP server,
and API client authenticate with an API key and read/write email state through
the self-hosted Emails service backed by the shared cloud/Postgres deployment.
The per-domain readiness contract for local and self-hosted operation lives in
[`docs/DOMAIN_READINESS.md`](docs/DOMAIN_READINESS.md).

The Hasna Tools Mailery SaaS control plane is not part of this OSS package. End
users and open-source contributors should use `@hasna/emails`, the `emails`
CLI, `emails-mcp`, and `emails-serve` for OSS local/self-hosted operation.

## Quick Start

```bash
# Add a provider (SES or Resend)
emails provider add --name production-ses --type ses --region us-east-1 --access-key ... --secret-key ...
emails provider add --name production-resend --type resend --api-key ...

# Set up a domain (buy + DNS + SES in one command)
emails domain setup example.com --provider <id> --email you@example.com ...

# Or connect a domain you already own without a hosted SaaS dependency
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

# Use the self-hosted Emails service as source of truth
export HASNA_EMAILS_API_URL="https://emails.example.com"
export HASNA_EMAILS_API_KEY="<redacted>"
emails self-hosted status
```

## Domain Modes

Emails is a multi-domain aggregator. Every domain is tracked independently, so
DNS, inbound, outbound, and safety state belong to the domain, not to the app as
a whole.

Use these setup paths:

| Mode | Who owns the mail source of truth | Domain setup path |
| --- | --- | --- |
| `local` | The local SQLite/files install | `emails domains add` or `emails domains connect --source-of-truth local`; DNS checks are advisory unless using a real send/receive provider. |
| `self_hosted` | The self-hosted Emails service backed by shared cloud/Postgres state | Configure the service API URL and API key, then run `emails domains connect --source-of-truth postgres`; CLI/MCP/API reads and writes go through the service. |

Authentication records are required only for the capability you enable:

- Inbound aggregation needs an inbound route, usually MX plus SES/S3 or another
  configured source.
- Outbound sending needs ownership verification plus DKIM and SPF/custom MAIL
  FROM alignment for the selected provider.
- DMARC is per sending domain. It does not block local viewing or inbound
  aggregation, but it should be present before production sending and monitored
  before moving from `p=none` to stricter policies.

For self-hosted operation, configure the self-hosted service API URL and API
key, then run with `HASNA_EMAILS_MODE=self_hosted`. In that mode, CLI, MCP, and
API calls read and write through the API-key-authenticated service. Email state
comes from the shared cloud/Postgres service, not a local SQLite source of
truth.

## Emails UI (`emails ui`)

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
emails storage           # legacy/local storage maintenance commands
emails self-hosted       # API-key self-hosted service setup/status/migrate commands
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

Emails CLI commands are compact by default so agent terminals do not fill with
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

## Self-Hosted Runtime

The canonical two-mode OSS runtime contract lives in
[`docs/SELF_HOSTED_RUNTIME.md`](docs/SELF_HOSTED_RUNTIME.md). The per-domain
aggregator and sending-readiness contract lives in
[`docs/DOMAIN_READINESS.md`](docs/DOMAIN_READINESS.md).

Emails has exactly two supported OSS modes:

- `local` - all reads and writes stay in local SQLite/files.
- `self_hosted` - CLI, MCP, and API calls authenticate with an API key and talk
  to the self-hosted Emails service. The service owns email state in the shared
  cloud/Postgres deployment.

Configure self-hosted clients with the service URL and API key issued by the
operator. Do not print, commit, or paste the key.

```bash
export HASNA_EMAILS_MODE=self_hosted
export HASNA_EMAILS_API_URL="https://emails.example.com"
export HASNA_EMAILS_API_KEY="<redacted>"

emails self-hosted status
emails self-hosted migrate
emails domains list --json
emails inbox sources --json
```

In `self_hosted` mode, local SQLite is not a supported source of truth and there
is no supported mixed local/remote runtime. Treat local-only mail as test/import data until
it is explicitly moved into the self-hosted service by an operator-approved
migration path.

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

- Health: `GET http://127.0.0.1:8861/health` -> `{"status":"ok","name":"emails"}`
- Override port with `MCP_HTTP_PORT` or `--port`

## License

Apache-2.0 — see [LICENSE](LICENSE)
