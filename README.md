# @hasna/emails

Open-source email infrastructure for local SQLite workflows and operator-owned self-hosted deployments, with a CLI, MCP server, library, dashboard, Resend, AWS SES, and Cloudflare-routed inbound mail.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

> **This product is `open-emails`. Mailery is not a name for it.** (Owner
> ruling, 2026-07-27 — see [docs/NAMING.md](docs/NAMING.md).)
>
> This package publishes as **`@hasna/emails`** and ships the `emails`,
> `emails-mcp`, and `emails-serve` bins. `@hasna/mailery` on npm is the
> abandoned 0.6.x line, and the `mailery*` bins belong to the separate cloud CLI
> — neither is this package. The env prefix is `EMAILS_*`. This stays a
> **cloud-free** OSS package: Mailery is a separate, unrelated product, not a
> hosted version of this one.

## Install

Emails is built for the Bun runtime. Install Bun 1.3 or newer, then install the
CLI with Bun.

```bash
bun install -g @hasna/emails
```

## Deployment modes

Emails has exactly two modes: `local` and `self_hosted`. Local mode keeps SQLite, files, and credentials on the current machine. Self-hosted mode connects to an Emails service deployed in user-owned infrastructure. Provider integrations always use user-supplied credentials; the package has no hosted account or control-plane service.

Local provider credentials are envelope-encrypted with a root key kept outside
SQLite. Rotation, locked-keyring recovery, and backup rebind procedures are in
[Provider credential storage](docs/PROVIDER_SECRETS.md).

## Quick Start

```bash
# Add a provider (SES or Resend). Prefer an AWS profile locally or the
# deployment IAM role in self-hosted AWS; avoid storing long-lived AWS keys.
AWS_PROFILE=emails-operator emails provider add --name production-ses --type ses --region us-east-1
emails provider add --name production-resend --type resend --api-key ...

# Register a domain you already own and have verified with the provider
emails domain adopt example.com --provider <id>

# See the DNS records the domain must publish, then confirm what is live
emails domain dns example.com --provider <id>
emails domain check example.com

# Buy a domain first, if you do not own one yet
emails domain available example.com
emails domain buy example.com --email you@example.com ...

# SES send-only setup preserves existing MX, such as Google Workspace
emails domain adopt example.com --provider <ses-id> --no-inbound

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

# Operate a self-hosted PostgreSQL service
EMAILS_MODE=self_hosted EMAILS_DATABASE_URL=postgres://... EMAILS_API_SIGNING_KEY=... emails db migrate
EMAILS_MODE=self_hosted EMAILS_DATABASE_URL=postgres://... EMAILS_API_SIGNING_KEY=... emails self-hosted key create
```

## Domain Modes

Emails is a multi-domain aggregator. Every domain is tracked independently, so
DNS, inbound, outbound, and safety state belong to the domain, not to the app as
a whole.

Use these setup paths:

The source of truth follows the mode; it is not a per-domain choice. A domain
created or connected through this client is owned by the app's `/v1` database, so
`source_of_truth` is reported as `postgres` and is not an input.

| Mode | Who owns the mail source of truth |
| --- | --- |
| `local` | The local SQLite/files install |
| `self_hosted` | Your PostgreSQL/S3/SES or equivalent infrastructure |

The domain setup path is the same either way, because none of it is served over
the wire: `emails domain add` (or `emails domain adopt` for a domain the
provider has already verified), then `emails domain dns <domain>` for the
records to publish, then `emails domain check <domain>` to confirm what is live.
`emails domain add` provisions the SES receipt rule into the inbound S3 bucket
by default and refuses — before registering anything — when it cannot, so a
domain never ends up half-provisioned and silently bouncing; pass `--send-only`
to deliberately register a domain that should not receive. `emails aws
setup-inbound` creates the S3 bucket and SES receipt rules on its own, and
`emails domain readiness` audits the whole inbound chain per domain (MX, SES
receipt rule, app registration, S3 delivery evidence) to catch drift.

Authentication records are required only for the capability you enable:

- Inbound aggregation needs an inbound route, usually MX plus SES/S3 or another
  configured source.
- Outbound sending needs ownership verification plus DKIM and SPF/custom MAIL
  FROM alignment for the selected provider.
- DMARC is per sending domain. It does not block local viewing or inbound
  aggregation, but it should be present before production sending and monitored
  before moving from `p=none` to stricter policies.

Self-hosted clients must set `EMAILS_MODE=self_hosted`,
`EMAILS_SELF_HOSTED_URL`, and one bearer credential:
`EMAILS_SESSION_TOKEN`, `EMAILS_IDP_TOKEN`, or
`EMAILS_SELF_HOSTED_API_KEY` (in that precedence order). The service uses
`EMAILS_DATABASE_URL`, `EMAILS_API_SIGNING_KEY`,
`EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS`, and `EMAILS_AUTH_FROM`; Postgres is authoritative
and there is no hybrid SQLite synchronization mode.

After applying migrations, issue client keys on the operator host with
`emails self-hosted key create`. The plaintext token is displayed once and only
its SHA-256 hash plus lifecycle metadata is stored in Postgres. Inspect metadata
with `emails self-hosted key list` and immediately disable a key with
`emails self-hosted key revoke <kid> --reason "rotation"`. The service denies
validly signed but unrecorded keys.

`emails self-hosted key rotate` issues an Emails key while retaining the active
Mailery-era key for rollback. Verify clients on the new key, then explicitly
revoke the old key after the rollback window closes.

## Emails UI (`emails ui`)

A full-screen Solid/OpenTUI mail client with a persistent mailbox sidebar and a
workspace for message lists, the reader, and domain status. Inbox can be scoped
to all addresses or one address and filtered by ingestion source, folder,
label, and search. Grouping, digests, attachment/link/raw views, live read
state, local refresh, background auto-pull, and `auto`/`light`/`dark` themes are
available in both local and self-hosted clients.

```bash
emails ui
emails ui --mailbox unread
```

The app uses visible buttons and the Shortcuts command palette for actions.
The address and source dialogs select mailbox scope; sidebar labels filter
mailbox content, and mail categories show Primary, Social, Promotions, Updates,
and Forums separately from custom labels. Reader dialogs expose attachments,
links, and raw details. Composer writes **markdown** rendered to HTML on send.
Settings controls sync, defaults, and display. Folders: Inbox · Unread ·
Starred · Sent · Archived · Spam · Trash.

## Command Structure

The table below covers every primary root namespace. Standalone compatibility
aliases and the full subcommand matrix are in [docs/CLI.md](docs/CLI.md); the
runtime `emails <command> --help` output remains the option-level source of
truth.

```
emails ui                # Mailbox UI - inbox, compose, domains, settings
emails provider          # provider credentials/capabilities (ses, resend, sandbox)
emails domain / domains  # domain records, purchase, DNS checks, warming
emails domain warm       # domain warming schedules: warm, warm-status, warm-list,
                         #   warm-pause, warm-resume, warm-complete, warm-delete
emails address           # manage sender addresses (add, suspend, activate, quota)
emails status            # redacted system status + next useful actions
emails agent context     # agent-oriented context snapshot and workflows
emails daemon            # background queue/realtime status and restart guidance
emails logs tail         # local daemon/sync/inbound/scheduler log tails
emails owner             # ownership: register human/agent owners
emails alias             # per-domain aliases + catch-all routing
emails forwarding        # app-level forwarding for locally received/synced mail
emails sendkey           # scoped send keys (restrict an agent to its own addresses)
emails send-intent       # inspect/reconcile uncertain self-hosted send outcomes
emails send              # send an email
emails reply / forward   # reply (in-thread) or forward a sent/inbound email
emails email             # sent email: list, search, show, replies, thread
emails inbox             # mailbox folders, sources, sync, read/star/archive/label, watch
emails template          # email templates
emails contact           # contacts (suppression list)
emails group             # recipient groups
emails sequence          # drip sequences
emails schedule          # scheduled emails: list, cancel, run
emails db                # self-hosted PostgreSQL migration and status commands
emails self-hosted key   # operator API-key create/list/rotate/revoke
emails auth              # self-hosted signup/login/logout/tenant sessions
emails keys              # tenant-scoped API keys for the active organization
emails whoami            # current self-hosted principal and organization
emails aws               # AWS setup: SES receipt rules, S3 inbound bucket
emails stats             # delivery statistics (--inbox for received mail)
emails analytics         # email analytics
emails doctor            # system diagnostics
emails doctor delivery   # diagnose missing inbound mail for one address
emails provision         # registered but intentionally NOT IMPLEMENTED
emails serve             # local dashboard or self-hosted /v1 service, by mode
emails mcp               # install MCP server
emails remove            # remove MCP configuration from supported agent clients
```

### Compact Output and Gradual Disclosure

Emails CLI commands are compact by default so agent terminals do not fill with
large records. List and status commands show essential fields, bounded row
counts, and hints for the next detail command. Use these flags when you need
more:

```bash
emails address list              # compact table
emails address list --verbose    # expanded owner/admin/quota rows
emails domains status            # per-domain records and DNS state
emails provider list --limit 50  # explicit larger page
emails contact list --suppressed # compact filtered contact list
emails template show <name>      # detail path for template bodies
emails sequence show <name>      # detail path for steps/enrollments
emails forwarding list --source ops@example.com
emails agent context             # compact agent context summary
emails agent context --verbose   # full redacted context snapshot
emails agent context --json      # full machine-readable context
emails email show <id>           # detail path for one sent email
emails inbox read <id>           # detail path for one inbound email
emails inbox attachments --limit 100 --direction inbound --json
emails inbox attachments --cursor <opaque-next-cursor> --json
emails inbox attachment <exact-id> --download --index 0 --output-dir ./attachments
```

Self-hosted attachment inventory is cursor-based, not offset-based. Each page
contains `items` and an opaque `next_cursor`; pass that cursor back unchanged to
continue. Inventory rows contain only safe metadata:
`message_id`, `attachment_index`, `filename`, `content_type`, `size_bytes`,
`sha256`, `content_available`, `direction`, and `received_at`. A missing or
unparseable size is `null` in JSON and is displayed as `unknown size`; it is
never rewritten as zero. `content_available: false` means metadata exists but
the stored bytes do not. Downloading that attachment returns HTTP `409` with
code `attachment_content_unavailable`, rather than a successful empty file.

Attachment byte downloads use descriptor-relative, no-overwrite writes so an
output-directory symlink swap cannot redirect bytes. That secure filesystem
primitive currently requires Linux (`/proc/self/fd`); macOS and other platforms
fail closed before writing a file. Metadata-only attachment reads remain
cross-platform.

`--json` remains the machine-readable path. Broad MCP list tools default to
their existing bounded summary page size for compatibility; use each tool's
`limit`/`offset` inputs or the matching detail tool/resource for larger or full
records. `emails://agent/context` is sampled for orientation; use
`emails://agent/context/full` for the full redacted MCP resource.

## Principals, aliases and scoped send keys

Every address can have an **owner** that is a human or an agent. A human-owned
address must be administered by an agent (the agent operates it on the human's
behalf); agent-owned addresses are self-administered.

```bash
# Register owners and assign an address (human-owned, agent-administered)
emails owner register Morgan --type human --email morgan@example.com
emails owner register Atlas  --type agent
emails address add morgan@example.com --provider <ses-id>
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
emails address add ops@example.com --provider <ses-id>
emails address set-owner ops@example.com --owner Atlas
emails address suggest --domain example.com
emails address suspend <id>     # block sending from this address
emails address activate <id>
emails address quota <id> 200   # max 200 sends/day (use 'none' to clear)
```

## Domain warming

A new sending domain that jumps straight to full volume gets throttled or
filtered. A warming schedule ramps it: 50/day on day 1, roughly doubling every
two days until it reaches the target. While a schedule is `active`, sends from
that domain are refused once the day's limit is reached; `paused` and `completed`
schedules impose no cap.

```bash
emails domain warm example.com --target 5000            # start the ramp (today)
emails domain warm example.com --target 5000 --start-date 2026-08-01
emails domain warm-status example.com                   # day N/total, today's limit vs sent
emails domain warm-list                                 # every schedule, one row each
emails domain warm-list --status active --json
emails domain warm-pause example.com                    # suspend the cap (deliverability issue)
emails domain warm-resume example.com
emails domain warm-complete example.com                 # graduated: no cap applies
emails domain warm-delete example.com --yes             # remove it (needed to retarget)
```

One schedule per domain: `warm` refuses to shadow an existing one. `--target` and
`--start-date` are fixed at creation, so retargeting means `warm-delete` then
`warm` again. The ramp is anchored on the **UTC** calendar date, the same anchor
the self-hosted server enforces the cap with, so `warm-status` reports the limit
that will actually be applied regardless of your machine's timezone.

Schedules live in the `warming_schedules` store, so they work the same whether
the client is on local SQLite or pointed at a self-hosted server (where the
server also enforces the limit on `/v1/messages/send`). The MCP twins are
`create_warming_schedule`, `get_warming_status`, `list_warming_schedules`, and
`update_warming_status`.

## DNS and inbound safety

`emails domain check <domain>` detects common root MX owners, including Google
Workspace, Microsoft 365, Cloudflare Email Routing, Zoho, Proton, and AWS SES.
SES send-only provisioning does not require changing root MX and is the safest
path when an existing mailbox provider already receives mail.

Publishing SES inbound MX is only for domains that should receive through
SES/S3. `emails domain adopt` refuses to wire SES inbound when public MX already
belongs to another provider; `--force-mx-switch` overrides it for intentional
migrations after confirming mailbox ownership can move. `emails aws
setup-inbound` writes no DNS at all — it prints the MX record for you to
publish.

## MCP Server

100+ tools for AI agents — send/read mail, provisioning, ownership, aliases, scoped
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
emails inbox attachments --limit 100 --direction inbound --json
curl 'localhost:3900/api/sources'
curl 'localhost:3900/api/mailboxes?source_id=legacy'
```

The MCP tool `list_attachments` accepts `limit`, opaque `cursor`, `direction`,
and `since`. Its production transport envelope contains exactly `items`,
`next_cursor`, and `cli_equivalent`; the latter is the equivalent compatibility
CLI command, including the JSON flag, for auditability and handoff. Attachment
content is never included in inventory output.

```bash
emails-mcp            # stdio transport (default)
```

## REST API

`emails serve` selects the server by deployment mode:

- In local mode it exposes the static dashboard and its unauthenticated,
  loopback-oriented management API under `/api/*` on `127.0.0.1:3900`.
- In `self_hosted` mode it exposes the authenticated PostgreSQL-backed `/v1`
  service on `0.0.0.0:8080`; `/openapi.json` is the formal wire contract.
- Scoped send keys remain part of the local send authorization model; there is
  no separate hosted-agent API surface in this OSS server.

```bash
emails serve   # local dashboard on 127.0.0.1
EMAILS_ALLOW_REMOTE=1 emails serve --host 0.0.0.0  # only behind an authenticating proxy/firewall

curl localhost:3900/api/providers
curl localhost:3900/api/sources
curl 'localhost:3900/api/mailboxes?source_id=legacy'
```

## Library API

Import the stable API from `@hasna/emails`. The public entrypoint covers
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
  getDatabase,
  closeDatabase,
  runInTransaction,
  resolvePartialId,
} from "@hasna/emails";

const db = getDatabase();
runInTransaction(db, () => {
  // CRUD helpers accept an optional Database for isolated local workflows.
});
closeDatabase();
```

The provider factory and the DNS helpers are exported too. `providerDnsPublishing`
answers whether a provider type publishes DNS records at all, so an empty record
list renders as "nothing to publish here" rather than "nothing found" — a
`sandbox` provider captures mail locally and has no DKIM/SPF/DMARC of its own:

```ts
import { getAdapter, providerDnsPublishing, formatDnsTable } from "@hasna/emails";

const records = await getAdapter(provider).getDnsRecords("example.com");
console.log(formatDnsTable(records, providerDnsPublishing(provider)));
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
`emails serve`. Configure `EMAILS_SNS_TOPIC_ARNS` and
`EMAILS_AWS_ACCOUNT_IDS`; the route verifies the AWS signature and exact
allowlists before it confirms or syncs a notification.

## Self-Hosted Runtime (PostgreSQL/S3/SES)

The server uses operator-owned Postgres and provider accounts. A client must
configure `EMAILS_MODE=self_hosted`, `EMAILS_SELF_HOSTED_URL`, and one of
`EMAILS_SESSION_TOKEN`, `EMAILS_IDP_TOKEN`, or
`EMAILS_SELF_HOSTED_API_KEY`. The service requires `EMAILS_DATABASE_URL`,
`EMAILS_API_SIGNING_KEY`, `EMAILS_SEND_PROVIDER=ses|resend`,
`EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS`, and `EMAILS_AUTH_FROM`. SES uses the
deployment IAM role; Resend uses `RESEND_API_KEY`. See
[docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) for signup, sessions,
tenant-scoped keys, and optional IdP verification.

`EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS` is the allowlist of email domains that may sign up, log in, or be invited (comma- or space-separated globs, `*` matching one DNS label — e.g. `example.com` or `example.*`), and `EMAILS_AUTH_FROM` is the sender identity for confirmation/reset/invite mail. **Neither has a default and the service refuses to boot without them**: this package ships no domain and no sender of its own, so a default would either lock your auth surface to someone else's organisation or open signup to everyone. See [docs/SELF_HOSTED_RUNTIME.md](docs/SELF_HOSTED_RUNTIME.md).

Self-hosted client commands fail closed when the mode, URL, or selected bearer
credential is missing or invalid. With `--json`, the CLI emits one structured error object on
stderr, exits nonzero, and leaves stdout empty. It does not open, create, or
fall back to the local SQLite database.

Expose the service through an HTTPS reverse proxy or load balancer with edge
rate limits, the 1 MiB request limit, bounded upstream timeouts, and network
rules that keep Postgres and the container port private. The generated client
rejects remote plaintext HTTP. Self-hosted sends require an idempotency key and
support at most five inline attachments (512 KiB each, 768 KiB total);
scheduled sends are not implemented by the self-hosted API. Mailbox read,
star, archive, label, delete, bulk-by-explicit-id, and authenticated attachment
retrieval are supported. Outbound rows carrying a send idempotency key are a
durable delivery ledger and return `409` on delete so their replay fence cannot
be erased; ordinary inbound and non-idempotent rows remain deletable.

For an operator retry, reuse the same `emails send --idempotency-key <key>`.
Changing the payload under that key is rejected, and an uncertain provider
outcome must be reconciled before another send.

### Legacy attachment repair

The self-hosted repair ledger is tenant-scoped, bounded, idempotent, and
checkpointed. Create a repair with
`POST /v1/attachments/repairs`; omitting `apply` is a dry run. Each manifest
entry may contain only `object_key`, `recipients`, and
`canary_message_ids`. The canary IDs must be the exact complete set currently
bound to that canonical object, not a sample. Caller-supplied buckets and raw
payloads are rejected: the service uses only its configured canonical S3
bucket, fetches only named object keys, never scans the bucket, and never emits
object keys, recipients, payload bytes, or internal errors in the repair
summary.

Inspect a repair with `GET /v1/attachments/repairs/{id}` and resume one bounded
page with `POST /v1/attachments/repairs/{id}/resume`. The response reports
inventory counters `repaired`, `would_repair`, `unavailable`, `pending`, and
`retrying`, plus the matching `entry_*` counters, `attempts`, and `checkpoint`.
`retrying` is the transient subset of `pending`; terminally invalid or
unrepairable rows become `unavailable`. A malformed repair UUID returns HTTP
`400` with code `invalid_attachment_repair_id`.

An apply is fail-closed and must prove the exact reviewed dry run for the same
tenant and current manifest:

1. Create the dry run with a stable `idempotency_key`, omit `apply`, and do not
   send any `reviewed_dry_run_*` fields.
2. Resume/read it until `status` is `completed` and both item and entry totals
   have zero `pending`, `retrying`, `unavailable`, and `operator_action`.
3. Review the returned public `repair` summary and compute its lowercase
   SHA-256 using recursively key-sorted canonical JSON (object keys sorted,
   array order preserved). This is the same
   `attachmentRepairRunResultSha256` calculation enforced by the service.
4. Submit the same exact `entries` with a separate apply `idempotency_key`,
   `apply: true`, and the two proof fields `reviewed_dry_run_id` and
   `reviewed_dry_run_result_sha256`.

Before creating the apply ledger, the service tenant-scopes the reviewed ID,
checks the completed zero-failure result and hash, then recreates or looks up
the reviewed dry run using the deployment-owned canonical bucket, the exact
current entries, and `apply: false`. This manifest check is read-only and does
not create an alias or consume repair quota. Any wrong tenant, ID, manifest,
hash, or unfinished/failed result returns the same non-leaking HTTP `409`
`attachment_repair_review_mismatch`; no apply run is created or processed.

### Recipient routing trust boundary

For SES/S3 ingestion, explicit envelope recipients are authoritative. The
worker may derive a catch-all address from the trusted SES-written S3 key path
only when the notification contains no recipients and normal routing resolved
no group. That derived address is still revalidated through tenant routing.
Malformed, partial, or unresolved explicit recipients are quarantined and are
never replaced by S3-key fallback. MIME `To`/`Cc` headers are
sender-controlled and are never used to select a tenant.

```bash
export EMAILS_MODE=self_hosted
export EMAILS_SELF_HOSTED_URL="https://emails.example.com"
export EMAILS_SELF_HOSTED_API_KEY="..."

# On the self-hosted server
export EMAILS_DATABASE_URL="postgresql://..."
export EMAILS_API_SIGNING_KEY="..."
export EMAILS_SEND_PROVIDER=ses
export EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS="example.com"  # your own signup domains
export EMAILS_AUTH_FROM="no-reply@example.com"          # a verified sender identity
emails db migrate
emails-serve
```

There is no hybrid cache or bidirectional database synchronization mode.

## Data

Local mode stores SQLite data and attachment files in `~/.hasna/emails/`.
Self-hosted mode uses the operator-configured PostgreSQL and object-storage
services and never falls back to that local directory.

## Transport

**stdio is the default** (one server per client, no listening socket). The shared
Streamable HTTP transport is opt-in via `--http`, because it publishes every MCP
tool — `send_email`, `add_forwarding_rule`, `set_config`, `create_send_key` — to
anything that can reach the port:

```bash
emails-mcp                     # stdio (default)
emails-mcp --stdio             # same, explicit
MCP_STDIO=1 emails-mcp         # same

# HTTP: opt-in, and refuses to start without a bearer token
EMAILS_MCP_HTTP_TOKEN="$(openssl rand -hex 32)" emails-mcp --http
EMAILS_MCP_HTTP_TOKEN=... emails-mcp --http --port 8861   # or --port=8861
```

- Health: `GET http://127.0.0.1:8861/health` -> `{"status":"ok","name":"emails"}`
- Override port with `MCP_HTTP_PORT`, `--port <n>`, or `--port=<n>`

### HTTP transport authorization

A loopback bind is not an authorization boundary. Any local process can reach the
port, and a web page can reach it too by re-resolving its own hostname to
`127.0.0.1` (DNS rebinding) — at which point the browser considers the request
same-origin and CORS never applies. So the HTTP transport:

- **Requires `Authorization: Bearer <token>` on `/mcp`**, matching
  `EMAILS_MCP_HTTP_TOKEN` (minimum 16 characters). Without the variable set, the
  server refuses to start rather than listening unauthenticated.
- **Validates the `Host` header on every path.** Default allowlist is the
  loopback names at the bound port (`127.0.0.1:<port>`, `localhost:<port>`,
  `[::1]:<port>`). Override with `EMAILS_MCP_ALLOWED_HOSTS` (comma-separated) —
  required if you bind a wildcard address or front the server with a proxy.
- **Validates `Origin` when the client sends one**, against
  `EMAILS_MCP_ALLOWED_ORIGINS` (default: the loopback origins at the bound port).
  Native MCP clients send no `Origin` and are unaffected.

`/health` stays unauthenticated so liveness probes keep working; it returns only
the static `{"status":"ok","name":"emails"}` and is still behind the `Host`
allowlist.

Client configuration, e.g. for the MCP TypeScript SDK:

```ts
new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8861/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.EMAILS_MCP_HTTP_TOKEN}` } },
});
```

## License

Apache-2.0 — see [LICENSE](LICENSE)
