# AGENTS.md - @hasna/emails

This file guides AI coding agents working with `@hasna/emails` - an email management CLI, MCP server, and library supporting Resend, AWS SES, and Cloudflare-routed inbound mail.

## Naming (read before "fixing" any Mailery reference)

This product is **open-emails**: repo `hasna/emails`, package `@hasna/emails`,
bins `emails*`, env prefix `EMAILS_*`. **Mailery is a separate, unrelated
product and is not a name for this one** (owner ruling 2026-07-27).

The string `mailery` still appears in this tree on purpose. It is either a
guard that enforces the ruling, a frozen compatibility constant (migration IDs,
the `mailery` API-key alias slug, legacy event source, `legacy-inbound@local.mailery`),
or a banned env selector that must stay named to be rejected. **Do not
bulk-rename it.** Read [docs/NAMING.md](docs/NAMING.md) first — it lists what
breaks for each one.

## What This Package Does

`@hasna/emails` manages the full email lifecycle locally:
- **Send** transactional emails via Resend or SES
- **Receive** inbound emails via SMTP listener or webhooks
- **Track** delivery events, opens, clicks, replies
- **Manage** domains, addresses, templates, contacts, sequences
- **Serve** a local dashboard and REST API

All local data is stored in `~/.hasna/emails/emails.db` by default. Existing
`~/.emails` data is migrated forward automatically. Use `HASNA_EMAILS_DB_PATH`
or `EMAILS_DB_PATH` for isolated tests and smoke runs.

## MCP Setup (Recommended for AI Agents)

Install the MCP server into Claude Code:
```bash
emails mcp --claude
emails mcp --claude --dry-run   # show the exact install command without mutating config
```

This gives you 100+ MCP tools plus orientation resources for agents.

## Key MCP Tools for Common Tasks

### Send an email
```
send_email(from, to, subject, html?, text?, provider_id?, template?, template_vars?, attachments?, unsubscribe_url?, idempotency_key?)
```

### Manage providers
```
list_providers()                          → see configured providers
add_provider(name, type, ...)             → add resend/ses/sandbox
update_provider(id, ...)                  → update credentials
```

### Domain management
```
add_domain(provider_id, domain)           → register domain with provider
get_dns_records(domain)                   → get DKIM/SPF/DMARC records
verify_domain(domain)                     → re-check DNS status
provision_domain(domain, provider_id, add_mx?) → NOT IMPLEMENTED in this build; use `emails domain adopt` + `emails aws setup-inbound`
create_warming_schedule(domain, target)   → start gradual volume ramp-up
get_warming_status(domain)                → check today's limit
```

### Email operations
```
list_emails(limit?, status?, since?)      → browse sent emails
search_emails(query, limit?)              → full-text search
get_email(id)                             → get email details
get_email_content(id)                     → get full HTML/text body
list_replies(email_id)                    → get all replies to a sent email
```

### Contacts & suppression
```
list_contacts(suppressed?)                → browse contacts
suppress_contact(email)                   → add to suppression list
unsuppress_contact(email)                 → remove from suppression list
```

### Templates
```
add_template(name, subject_template, html_template?, text_template?)
list_templates()
send_email(template=name, template_vars={key:val}, ...)  → send with template
```

### Sequences (drip campaigns)
```
create_sequence(name, description?)
add_sequence_step(sequence_id, step_number, delay_hours, template_name)
enroll_contact(sequence_id, contact_email)
list_enrollments(sequence_id?)
```

### Inbox / inbound emails
```
list_inbound_emails(limit?, provider_id?)
get_inbound_email(id)
prepare_inbox(email, provider_id?, create_missing?)
wait_for_code(email, timeout_seconds?)
list_usable_from_addresses(send?, receive?)
```

### Forwarding
```
add_forwarding_rule(source_address, target_address, provider_id?, from_address?, enabled?)
list_forwarding_rules(source_address?, enabled?, limit?, offset?)
run_forwarding_rules(provider_id?, from_address?, limit?, backfill?)
```

Forwarding rules are app-level: they forward mail only after this app has
received the source mailbox via SES/S3, Cloudflare-routed inbound storage, SMTP, or webhooks. For domains whose root MX belongs to
Google Workspace, Microsoft 365, Cloudflare Email Routing, or another mailbox
provider, use provider-native forwarding unless the source mailbox is delivered
into this app. `run_forwarding_rules` processes only messages received after
the rule was created unless `backfill=true` is explicitly set.

### Analytics & diagnostics
```
get_analytics(period?)                    → daily volume, top recipients, hourly distribution
get_stats(period?)                        → delivery/bounce/complaint rates
run_doctor(live?)                        → diagnostic check; live=true validates provider credentials remotely
diagnose_inbound_delivery(address)        → missing-mail diagnosis, including public MX ownership
```

### Sandbox (development)
```
add_provider(name, type="sandbox")        → capture emails locally (never send)
list_sandbox_emails(provider_id?)        → browse captured emails
clear_sandbox_emails()                    → wipe sandbox
```

### Export
```
export_emails(format?, provider_id?, since?, until?, limit?, offset?)  → CSV or JSON
export_events(format?, provider_id?, since?, until?, limit?, offset?)  → CSV or JSON
```

### Agent orientation resources
```
emails://agent/context     → redacted operating context and next commands
emails://status            → provider/inbox/source health snapshot
emails://domains           → domain readiness and provisioning context
emails://addresses         → enriched address, owner, and receive state
emails://recent-errors     → latest provisioning/source errors
```

## Workflows

### First-time setup
```
1. add_provider(name="my-resend", type="resend", api_key="re_xxx")
2. add_domain(provider_id=<id>, domain="example.com")
3. get_dns_records("example.com") → configure in DNS registrar
4. verify_domain("example.com") → check status
5. send_email(from="hello@example.com", to="test@test.com", subject="Test", text="Hello!")
```

### Existing mailbox provider + SES sending
> `emails provision *` is NOT implemented in this build (see `docs/PROVISIONING.md`).
> Provisioning is manual.
```
1. Run `emails domain check example.com` to detect current root MX ownership.
2. Use `emails domain adopt example.com --provider <ses-id>` for an already-registered, SES-verified domain.
3. Preserve root MX for send-only SES setup when Google Workspace or another mailbox provider already receives mail: `emails domain adopt example.com --provider <ses-id> --no-inbound`.
4. `emails domain adopt` refuses SES inbound wiring when public root MX belongs to another provider; pass `--force-mx-switch` only for an intentional inbound migration to SES/S3.
```

### Bulk campaign
```
1. add_template(name="welcome", subject_template="Welcome {{name}}!", html_template="<h1>Hi {{name}}</h1>")
2. batch_send(recipients=[{email, vars},...], template_name="welcome", from_address="hello@example.com")
```

### Drip sequence
```
1. create_sequence(name="onboarding")
2. add_sequence_step(sequence_id, step_number=1, delay_hours=0, template_name="welcome")
3. add_sequence_step(sequence_id, step_number=2, delay_hours=72, template_name="followup")
4. enroll_contact(sequence_id, contact_email="user@example.com")
# Run `emails scheduler` or the daemon/reconciler flow to process due steps
```

### Dev/test (never send real emails)
```
1. add_provider(name="dev", type="sandbox")
2. send_email(provider_id=<sandbox-id>, ...) → captured locally
3. list_sandbox_emails() → inspect what would have been sent
```

## Important Constraints

1. **DB location**: Default is `~/.hasna/emails/emails.db`; old `~/.emails` data is auto-migrated. Use `HASNA_EMAILS_DB_PATH` or `EMAILS_DB_PATH` for testing.
2. **Provider credentials**: Never expose credentials in code — they're stored in the local DB. When listing providers, credentials are automatically redacted (`"***"`).
3. **Domain warming**: If a warming schedule is active for a domain, `send_email` will block at the daily limit. Use `get_warming_status(domain)` first.
4. **Suppression**: Always check `list_contacts(suppressed=true)` before bulk sends.
5. **Attachment limits**: Local/provider flows may allow up to 25MB per attachment and 10 attachments. The self-hosted JSON send API is intentionally smaller: 5 inline attachments, 512KiB each, 768KiB total.
6. **Server binding**: `emails serve` defaults to `127.0.0.1:3900` (localhost only). External local-dashboard binding requires both `EMAILS_ALLOW_REMOTE=1` and `--host 0.0.0.0`, and should sit behind an authenticating proxy or firewall.

## Development

```bash
bun install          # install dependencies
bun test             # run tests (EMAILS_DB_PATH=:memory: for isolation)
bun run build        # build all bundles
bun run dev:cli      # run CLI in dev mode
bun run dev:mcp      # run MCP server in dev mode
bun run dev:serve    # run HTTP server in dev mode
```

## Project Structure

```
src/
├── cli/
│   ├── index.tsx              # thin, lazy-loading command orchestrator
│   ├── utils.ts               # shared helpers
│   ├── tui/                   # OpenTUI Emails UI dashboard
│   └── commands/              # modular command files
│       ├── send.ts            # send, log, search, show, replies, conversation
│       ├── provider.ts        # provider CRUD
│       ├── domain.ts          # domain + warming commands
│       ├── sequences.ts       # drip campaigns
│       ├── inbox.ts           # SMTP listener + inbound email management
│       └── ...                # provider/domain/inbox/address/provision/etc.
├── db/                        # SQLite CRUD modules
│   ├── database.ts            # migrations + schema + legacy path migration
│   ├── emails.ts, providers.ts, domains.ts, ...
│   ├── sequences.ts, warming.ts, inbound.ts, sandbox.ts
│   └── *.test.ts
├── lib/                       # business logic
│   ├── send.ts                # sendWithFailover wrapper
│   ├── sync.ts                # pull events from providers
│   ├── warming.ts             # schedule generation + limit checks
│   ├── tracking.ts            # open/click pixel injection
│   ├── inbound.ts             # MIME parsing + SMTP server
│   ├── email-verify.ts        # MX + SMTP probe verification
│   ├── address-ownership.ts   # owner/admin address authorization helpers
│   ├── agent-context.ts       # redacted agent orientation snapshots
│   └── ...
├── providers/                 # provider adapters
│   ├── resend.ts, ses.ts, sandbox.ts
│   └── interface.ts           # ProviderAdapter interface
├── mcp/                       # MCP server, modular tools, contracts, and resources
├── server/                    # local dashboard API plus self-hosted /v1 service
└── index.ts                   # library exports
```

## Adding New Features

The codebase follows these patterns:
- **New DB table**: Add the SQLite migration/ensure-schema work in `db/database.ts`; if self-hosted, also add an immutable migration under `server/self-hosted/migrations.ts` and store/RLS coverage
- **New CLI command**: Add to appropriate `cli/commands/*.ts` file
- **New MCP tool**: Add `server.tool(...)` in `mcp/tools/*.ts` and wire a new registrar from `mcp/server.ts` when needed
- **New REST endpoint**: Add local dashboard routes under `server/routes/`; add self-hosted `/v1` routes and OpenAPI under `server/self-hosted/`
- **New library export**: Add to `src/index.ts`

Test: `bun run test` — the hermetic runner owns DB isolation and must stay at 0 failures.
