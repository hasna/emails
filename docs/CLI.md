# CLI reference

This page describes the command tree shipped by `@hasna/emails` 1.3.3. It was
checked against the live `--help` output in both `local` and `self_hosted`
modes. Use `emails <command> --help` for every option and argument; Commander
help is the option-level source of truth.

## Global options

`emails` accepts `--json`, `--quiet`, `--verbose`, `--version`, and `--help`.
With `--json`, successful structured output is written to stdout and structured
errors are written to stderr.

## Root command tree

| Root command | Subcommands or purpose |
| --- | --- |
| `provider` | `add`, `list`, `remove`, `update`, `status`, `check`, `sync` |
| `domain` | `add`, `connect`, `adopt`, `list`, `dns`, `verify`, `status`, `usable`, `move-provider`, `remove`, `check`, `setup-cloudflare`, warming commands, `available`, `buy`, `purchase-status`, `list-registered`, `setup` |
| `domains` | `list`, `status`, `add`, `connect`, `dns`, `verify`, `check`, `enable-inbound`, `enable-outbound`, `disable-outbound` |
| `address` | `add`, `list`, `owner`, ownership changes/history, `suggest`, `provision`, `verify`, `set-verified`, `remove`, `suspend`, `activate`, `quota` |
| `send` | Send one message; supports templates, attachments, scheduling, tracking, and idempotency options where the selected store supports them. |
| `email` | `list`, `search`, `show`, `replies`, `thread`, `send` |
| `webhook` | `listen` for provider event webhooks. |
| `template` | `add`, `list`, `show`, `remove` |
| `contact` / `contacts` | `list`, `suppress`, `unsuppress` |
| `group` | `create`, `list`, `show`, `members`, `add`, `remove-member`, `delete` |
| `sequence` | `create`, `list`, `show`, `pause`, `archive`, enrollment commands, and `step add/list/remove` |
| `schedule` / `scheduled` | `list`, `cancel`, `run` |
| `inbox` | Code waiting, list/search/read, mailbox/source status, state changes, attachments, deletion, S3 sync, realtime setup/watch, SMTP listen, and local open. |
| `owner` | `register`, `list`, `addresses` |
| `alias` | `add`, `catch-all`, `global`, `list`, `remove`, `resolve` |
| `sendkey` | `create`, `list`, `revoke`, `check` |
| `send-intent` | `uncertain`, `reconcile` |
| `forwarding` | `add`, `list`, `enable`, `disable`, `remove`, `run`, `explain` |
| `aws` | `setup-inbound`, `status` |
| `agent` | `context` |
| `daemon` | `status`, `restart` |
| `logs` | `tail` |
| `db` | `migrate`, `status` for the self-hosted Postgres schema. |
| `self-hosted` | `key create/list/rotate/revoke` for operator application keys. |
| `auth` | `signup`, `login`, `logout`, `whoami`, `switch-tenant`, `verify-email`, `bootstrap` |
| `keys` | `list`, `create`, `revoke` tenant-scoped API keys. |
| `ui` | Start the full-screen OpenTUI client. |
| `serve` | Start the local dashboard or self-hosted service selected by mode. |
| `mcp` | Print or install MCP configuration for Claude Code, Codex, or Gemini. |
| `remove` / `uninstall` | Remove MCP configuration from supported agent clients. |
| `status` | Redacted health and next actions. |
| `stats`, `analytics`, `monitor` | Delivery statistics and monitoring. |
| `doctor` | Diagnostics; `doctor delivery <address>` diagnoses missing inbound mail. |
| `provision` | Registered compatibility namespace; intentionally not implemented (see below). |

Standalone aliases are also shipped for common actions: `addresses`, `log`,
`search`, `show`, `replies`, `conversation`, `test`, `export`, `pull`,
`preview`, `scheduler`, `batch`, `completion`, `verify-email`, `code`, `links`,
`forward`, `reply`, and `whoami`.

## Commands that intentionally refuse

Registration in help does not imply implementation. The following compatibility
and design-target commands fail with an actionable "not implemented in this
build" error in every deployment mode:

- every `emails provision *` subcommand;
- `emails domain connect`, `verify`, `status`, `setup-cloudflare`, and `setup`;
- `emails domains connect`, `verify`, `enable-inbound`, `enable-outbound`, and
  `disable-outbound`;
- `emails address provision`.

Use `emails domains status` for stored domain state, `emails domain check` for
live public DNS, `emails domain adopt` for an already verified provider domain,
and `emails aws setup-inbound` for SES/S3 inbound wiring.

## Mode differences

The root command names are the same in both modes, but storage and capability
checks may refuse an operation that the selected store cannot perform.
`emails inbox attachments` (cursor-based attachment inventory) is present only
for the self-hosted client; `emails inbox attachment <email-id>` exists in both
modes. `emails serve` defaults to the local dashboard at `127.0.0.1:3900` in
local mode and the self-hosted `/v1` service at `0.0.0.0:8080` in
`self_hosted` mode.

## Other shipped bins

`emails-mcp` uses stdio by default. `--http` opts into Streamable HTTP,
`-p/--port` selects the port, and HTTP refuses to start without
`EMAILS_MCP_HTTP_TOKEN`. `--stdio`, `--version`, and `--help` are also
available.

`emails-serve` starts the same mode-selected HTTP service and also ships these
operator commands:

- `ingest-worker`
- `ingest-s3-backfill`
- `attachment-repair-canary`
- `attachment-repair-ledger`
- `inbound-provenance-audit`
- `inbound-provenance-fence`

Run `emails-serve --help` before an operator workflow; these commands have
strict environment, provenance, and argument requirements.
