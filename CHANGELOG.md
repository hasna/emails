# Changelog

All notable changes to `@hasna/mailery` (formerly `@hasna/emails`) are documented here.

## [Unreleased]

- **fix(self-hosted): a message that provably left is no longer parked without the proof.** On the provider-accepted-then-ledger-write-failed path the row was written `send_state = 'uncertain'` with `provider_message_id = NULL`, even though the provider had just returned an id. `emails log` then rendered a delivered message in the not-delivered style, and because `reconcile --outcome sent` requires the provider message id, the only outcome an operator could actually record was `not_sent` — filing a delivered message as failed, the exact inversion this release exists to prevent. `markSendUncertain` now persists the provider message id and a `send_uncertain_reason` note on the row. Both tests that covered this path asserted the HTTP response only; they now assert the row and the reconcile round-trip.
- fix(providers): an access-key-only SES provider row whose access key id matches a COMPLETE ambient pair resolves to that ambient identity instead of throwing. Rows in that shape predate the both-or-neither rule (`provider add --access-key` with no secret relied on the environment) and the identity is the same one named twice, not a mixed one. Every other partial pair — a different ambient identity, or no ambient secret at all — is still refused, and the error now names the exact remediation command.
- **fix(self-hosted): SES credentials are actually used (2026-07-25 incident, cause 2).** `buildSelfHostedSender` hardcoded `access_key: null, secret_key: null`, so the SES client ALWAYS fell through to the AWS default chain — the deployment IAM role — no matter what credentials had been configured. The sender now signs with `EMAILS_SES_ACCESS_KEY_ID` + `EMAILS_SES_SECRET_ACCESS_KEY` when both are present in the server environment, and with the deployment IAM role otherwise (unchanged default for existing self-hosters). Half a pair is a hard startup error rather than a silent completion from the ambient chain. The names are scoped on purpose: the generic `AWS_*` names would re-point every AWS client in the process (S3 inbound, SQS ingest), not just SES. Optional `EMAILS_SES_CONFIGURATION_SET` is now threaded into `SendEmailCommand` so SES metrics are attributable in a shared account.
- **fix(providers): credentials are never silently dropped again.** `SESAdapter` used to pair `provider.access_key` with the *ambient* `AWS_SECRET_ACCESS_KEY` when only one half was present — signing with an identity belonging to neither source. Credential resolution is now a single exported rule (`resolveSesCredentials`): a provider row's pair is used exclusively, a partial pair is rejected, and only a complete ambient pair (with session token) is used as a fallback.
- **fix(cli): `emails provider add/update` no longer lies about credentials.** In self_hosted mode the credential flags were accepted, stripped by the client before the request, and the command then reported `Provider credentials are invalid: Could not load credentials from any providers` — the credentials were never transmitted and were never invalid. The command now (a) refuses `--api-key/--access-key/--secret-key` against a self-hosted server with an error naming the server-side variables to set instead, and (b) validates with the credentials the operator actually supplied, *before* persisting, instead of validating the stored (credential-free) row against this machine's ambient AWS chain. When there is nothing to validate it says so rather than implying a check happened.
- **feat(self-hosted): reconcile sends with an unknown outcome (2026-07-25, criterion 6).** New `GET /v1/messages/send-intents/uncertain` and `POST /v1/messages/send-intents/reconcile`, plus `emails send-intent uncertain` and `emails send-intent reconcile <id> --outcome sent|not-sent --evidence …`. Reconciliation is one row at a time, guarded on `send_state = 'uncertain'` (a proven outcome is never overwritten), requires the provider message id to assert `sent`, requires a non-empty evidence note, and persists the outcome, the evidence and the resolving principal on the row. Previously there was no way to even *list* the messages whose delivery was unknown.
- fix(cli): `emails send --provider <id>` was parsed and then discarded in both modes. It is now honoured in local mode and rejected with an explicit error in self_hosted mode (the server selects the outbound provider), so it can never be silently ignored.
- fix(self-hosted): corrected the comment in `auth/mailer.ts` that asserted the sender "already targets" a specific SES account via the deployment role. It does not, and there is no cross-account assume-role anywhere in the codebase; operators trusted the claim.
- fix(build): `scripts/generate-selfhost-sdk.ts` anchored its nullable-`message` patches on whole interface literals, so adding a sibling field to a response schema broke SDK generation and the `verify` CI job. The patches are now anchored on the interface name and the property.
- **fix(self-hosted): a send failure now says what actually happened (2026-07-25 incident).** A synchronous provider reject (e.g. SES sandbox `MessageRejected` for any unverified/external recipient) was swallowed by a bare `catch`, marked `uncertain`, and answered with a generic 502 "send outcome is uncertain" — operators read it as an infra failure, retried, and duplicated ledger rows for mail that never left. Now:
  - a definitive provider 4xx reject returns **422** with the REAL provider error, `reason: provider_rejected`, `sent: false`, `retry_safe: true`; the ledger row lands in the new `send_state = 'failed'` (no reconciliation required, excluded from quota usage);
  - retrying the same `idempotency_key` after a definitive reject re-arms the SAME ledger row (never a duplicate) and can succeed;
  - a provider success followed by a ledger-finalization failure returns **202 with `sent: true`, the provider message id, and an explicit warning** — a successful send never again presents as an error (this is what caused the triple-send of real client mail);
  - an indeterminate failure (network / provider 5xx) stays 502 but now names the provider error, sets `sent: null`, and says the message may or may not have been sent; every provider send error is logged instead of discarded.
- fix(self-hosted): every provider-accepted `/v1/messages/send` response — fresh success, idempotent replay of a sent intent, or a post-send finalization failure — now carries top-level `sent: true` and `provider_message_id`, so clients check ONE place for "did it go out" instead of inferring from the HTTP status. A rejected intent whose retry cannot be re-armed answers **503 `sent: false`, `reason: rearm_failed`, `retry_safe: true`** instead of a generic 500 that hides whether anything was sent (nothing was).
- fix(cli): `emails send` prints the provider's message id (preferring the top-level echo, then the record's `provider_message_id`) instead of falling back to the ledger row id, and `emails show` displays the ledger Status (highlighted when not delivered) so a single-message view can no longer present a never-sent message as delivered.
- fix(cli): `emails log --json` now serializes `to`, `cc`, `cc_addresses`, `status`, and `send_state` (operators scripting against `to`/`cc` read null during the incident), and the table shows a Status column with non-delivered states highlighted — an `uncertain`/`failed` send no longer renders identically to a delivered one. `emails send` relays the server's error detail on failure and prints the sent-but-finalization-failed warning on success.
- **BREAKING (aliased): rename `@hasna/emails` → `@hasna/mailery`** (repo/brand `open-emails` → `open-mailery`), mirroring the open-skills ↔ platform-skills split. Back-compat is preserved throughout, so existing installs keep working:
  - bins: canonical `mailery`/`mailery-mcp`/`mailery-serve`, with `emails`/`emails-mcp`/`emails-serve` kept as aliases.
  - env: prefix moved `EMAILS_*` → `MAILERY_*` via a startup dual-read shim (`MAILERY_*` wins, `EMAILS_*` still read as fallback). Hosted/cloud control-plane env vars (`MAILERY_API_URL`, `MAILERY_CLOUD_*`, `HASNA_MAILERY_ENV_FILE`, storage-mode, …) are intentionally NOT bridged and remain rejected — this stays a cloud-free OSS package.
  - MCP: server/registration name → `mailery` (the `emails-mcp` bin alias keeps existing registrations working).
  - self-hosted API keys: app slug → `mailery`; the verifier also accepts the legacy `emails` slug so already-issued keys keep authenticating.
  - `MAILERY_MODE` is now a first-class mode selector (accepts `local`/`self_hosted`; `cloud`/`remote`/`hybrid` still rejected).
  - Deferred follow-ups (unchanged in this release): the local data dir (`~/.hasna/emails`), the `emails://` MCP resource scheme, the internal `EMAILS_*` literals + docker/deploy env-var names, and the `emails:*` API scopes. The GitHub repo rename and npm publish are also deferred (owner go).
- rebuild the product as local-first and operator-owned AWS self-hosting, with no Hasna SaaS control plane.
- add durable idempotent self-hosted sends, authenticated attachment retrieval, mailbox mutations, signed replay-safe webhooks, and additive Mailery-to-Emails compatibility bridges.
- harden deployment with separate migration/runtime database roles, readiness health checks, immutable container/action pins, and explicit local/self-hosted mode validation.
- fix: `inbox read` no longer claims self-hosted attachments cannot be downloaded. Each metadata entry now shows its authenticated download index and the exact `inbox attachment … --download` command. Messages ingested with their payload download immediately; metadata-only imports still answer with an explicit "no stored content" error, so the hint is an instruction, not a guarantee that the bytes exist.
- fix: attachment download indexes are carried through `mergeAttachmentDetails` instead of being inferred from the rendered position. A metadata entry with an empty filename is skipped for display, so any renderer counting its own rows advertised an index that downloads a *different* attachment.
- fix: keep nameless inbound attachment parts addressable in the self-hosted client (`filename: ""` now falls back to `attachment-N`, matching `db/inbound.remote.ts`) instead of dropping them and shifting every later download index.
- fix: `listReplies` / `listReplyPromptParts` re-read the selected replies by id. They matched on list rows, which no longer carry `body_text`, so reply bodies and reply prompts came back empty against a current serve.
- fix: self-hosted attachment metadata now states whether the payload bytes actually exist (`content_available`), on the per-message detail read, `GET /v1/attachments` and `POST /v1/attachments/batch`. Historical/legacy imports carry filename/content_type/size for bytes that were never stored, so every metadata surface — and the CLI on top of it — presented 56k unrecoverable attachments as one `--download` away; the fetch then failed. `inbox read` and `inbox attachment` now say "metadata only; payload not stored — not downloadable" for those entries and suppress the download hint, while attachments with stored bytes are advertised exactly as before. A serve that does not report availability still renders as before (unknown ≠ unavailable). Fixes #36.
- fix: address ownership works in self_hosted mode instead of refusing. `emails address owner|set-owner|transfer-owner|unassign-owner|owner-history` and the five matching MCP tools were hard-blocked with the claim that ownership "has no /v1 equivalent"/"reads local rows" — untrue: `db/owners.ts` already routes them to `/v1/owners`, `owner_id`/`administrator_id` on `/v1/addresses/<id>`, and `/v1/address-ownership-events`, and `emails owner list` used that same path unguarded. The guards and the false comments are gone.
- fix: `emails address list` / `emails addresses` no longer hardcode `owner: null` / `administrator: null`. The projection is hydrated through `enrichAddresses`, so an owned address is reported as owned in the table, under `--verbose`, and in `--json` instead of silently rendering "-". `--verbose` now actually shows the expanded owner/admin/quota fields its help text promises (quota shows the configured limit only; the send ledger is server-owned).
- test: the shared `/v1` stub now returns real lean list rows (no bodies, no headers, no attachments array; `snippet` + `attachment_count` instead). Modelling the pre-slimming row is what let published `1.2.6` report `attachments: 0` against a live serve while every test passed.

## [0.6.117] - 2026-07-09
- chore: rename package back to `@hasna/emails` and free the `mailery`/`mailery-mcp`/`mailery-serve` bins for the separate cloud CLI (`@hasnatools/mailery`). Remaining bins: `emails`, `emails-mcp`, `emails-serve`. The Mailery product/brand name, `mailery.co`, and cloud API-key app id are unchanged.

## [0.6.69] - 2026-06-29
- fix: block raw S3 bucket sync when configured child prefixes could bypass retired source lifecycle rules.

## [0.6.68] - 2026-06-29
- fix: repair inbound-derived mailbox/source canonical state for orphaned provider history.
- fix: keep canonical message/state rows aligned when local inbound mail is deleted or cleared.
- fix: block inactive or ambiguous Gmail live-source resolution and retired S3 source bypasses.
- fix: list registered S3 sources and make unknown source filters match no mail.
- chore: retire the old hosted command surface from the public package.
- docs: document the Bun runtime requirement for global installs.

## [0.6.67] - 2026-06-29
- fix: backfill legacy SES/S3 object-key rows to exact `raw_s3_url` provenance.
- fix: preserve configured S3 source counts after exact S3 source filtering.

## [0.4.21] - 2026-03-14
- feat: auto-unenroll from active sequences when contact replies to an email
- chore: update CHANGELOG for v0.4.18-0.4.20

## [0.4.20] - 2026-03-14
- feat: webhook signature verification — Resend (svix HMAC-SHA256 + replay protection), SES/SNS structure check
- feat: `emails serve --webhook-secret whsec_...` for verified webhook endpoint
- feat: `emails send --dry-run` — preview what would be sent without sending
- fix: export `verifyResendSignature`, `verifySnsStructure` from library

## [0.4.19] - 2026-03-14
- docs: add `AGENTS.md` — 202-line AI agent guide covering 59 MCP tools and all workflows

## [0.4.18] - 2026-03-14
- feat: `emails conversation <id>` — full thread view (sent email + replies)
- chore: update CHANGELOG for v0.4.14-v0.4.17

## [0.4.17] - 2026-03-14
- feat: reply tracking — inbound emails auto-linked to sent emails via `In-Reply-To`/`References` headers
- feat: `emails replies <id>` — show conversation thread for a sent email
- feat: `emails show` now displays reply count
- feat: `list_replies` MCP tool
- fix: `in_reply_to_email_id` added to `InboundEmail` interface (migration 14)

## [0.4.16] - 2026-03-14
- fix: MCP `send_email` now enforces domain warming limits (CLI parity)

## [0.4.15] - 2026-03-14
- feat: domain warming limits enforced on `emails send` — blocks at daily limit, warns at 80%
- feat: `--force` flag bypasses warming check

## [0.4.14] - 2026-03-14
- feat: domain warming schedules — exponential ramp-up for new sending domains
- feat: `emails domain warm/warm-status/warm-list/warm-pause/warm-resume`
- feat: MCP `create_warming_schedule`, `get_warming_status`, `list_warming_schedules`, `update_warming_status`
- feat: REST `GET/POST/PUT/DELETE /api/warming`
- fix: `Email` and `EmailRow` interfaces now include `idempotency_key`
- DB: migration 13 (warming_schedules table)

## [0.4.13] - 2026-03-14
- feat: `verify_email_address` MCP tool (format + MX + SMTP probe)
- feat: `batch_send` MCP tool (send template to list of recipients)
- docs: added `CHANGELOG.md`
- chore: 54 MCP tools total

## [0.4.12] - 2026-03-14
- fix: MCP `send_email` now uses `sendWithFailover` wrapper (was bypassing failover)
- feat: export sequences, inbound, tracking, send modules from package root
- feat: added `getFailoverProviderIds` export

## [0.4.11] - 2026-03-14
- test: add `config.ts` tests (8 tests covering all config functions)

## [0.4.10] - 2026-03-14
- fix: `emails serve` now binds to `127.0.0.1` by default (use `--host 0.0.0.0` for all interfaces)
- feat: `emails serve --all` starts HTTP + webhook + SMTP listeners in one command

## [0.4.9] - 2026-03-14
- refactor: split CLI `index.tsx` (2416 lines) into 14 modular command files
- fix: open redirect vulnerability in tracking `/track/click` endpoint
- fix: `require("net")` → ESM `import` in `email-verify.ts`

## [0.4.8] - 2026-03-14
- feat: local open/click tracking (`--track-opens --track-clicks` on send)
- feat: `emails sequence enroll-bulk --csv` for bulk CSV enrollment
- feat: Chart.js analytics charts in dashboard (daily volume, delivery doughnut, hourly bar)
- feat: Inbound + Sequences pages in dashboard

## [0.4.7] - 2026-03-14
- feat: email sequences / drip campaigns (`emails sequence create/step/enroll`)
- feat: `emails verify-email` — format + MX + optional SMTP probe
- docs: README updated for all v0.4.x features

## [0.4.6] - 2026-03-14
- feat: inbound email processing (SMTP server port 2525, webhook endpoint)
- feat: `emails inbound listen/list/show/open/clear`
- feat: multi-provider failover (`emails config set failover-providers id1,id2`)

## [0.4.5] - 2026-03-14
- feat: bounce/complaint rate alerts with configurable thresholds
- feat: idempotency keys on send (`--idempotency-key`)
- DB: migration 10 (idempotency_key column on emails)

## [0.4.4] - 2026-03-14
- feat: `List-Unsubscribe` header injection (RFC 8058) via `--unsubscribe-url`
- feat: custom `headers` on `SendEmailOptions`

## [0.4.3] - 2026-03-14
- feat: sandbox provider (`emails provider add --type sandbox`)
- feat: dashboard improvements (search, sync, auto-refresh, DNS modal, Contacts/Templates pages)
- feat: 20+ missing REST endpoints (contacts, templates, groups, sequences, analytics, sandbox, email-content)
- feat: 7 new MCP tools (get_analytics, run_doctor, export_emails, etc.)
- feat: expanded library exports in `src/index.ts`
- DB: migration 9 (expanded provider type CHECK to include gmail/sandbox)

## [0.4.2] - 2026-03-14
- fix: 25MB attachment size limit, max 10 attachments per send
- feat: rate limiting on server endpoints (pull: 5/min, verify: 10/min)

## [0.4.1] - 2026-03-14
- test: comprehensive Resend adapter tests (72 tests)
- test: comprehensive SES adapter tests (42 tests)
- docs: README.md created

## [0.4.0] - 2026-03-14
- feat: 15 QoL features (scheduling, batch send, groups, analytics, webhook, doctor, shell completion)
- feat: email templates with variable substitution
- feat: contacts tracking with auto-suppress on 3+ bounces
- feat: CSV export (emails + events)
- 293 tests

## [0.3.0] - 2026-03-14
- feat: 13 QoL features (config, log, test, templates, contacts, export, health, colored output)
- 175 tests

## [0.2.0] - 2026-03-14
- feat: Gmail provider via OAuth2
- feat: `connect-aws` SES support added to open-connectors

## [0.1.0] - 2026-03-14
- feat: initial release — Resend + AWS SES providers
- feat: CLI + MCP server + HTTP dashboard
- feat: domains, addresses, emails, events, sync
- 100 tests
