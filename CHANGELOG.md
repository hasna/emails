# Changelog

All notable changes to `@hasna/emails` are documented here.

## [Unreleased]

- **BREAKING fix(status): `emails status` no longer fabricates its own output.** In self_hosted mode `buildSystemStatus()` hardcoded `providers { total: 0, active: 0, by_type: {} }`, `domains { total: 0, send_ready: 0, receive_ready: 0, usable: [] }`, `addresses { total: 0, active: 0, verified: 0, owned: 0, ready_to_receive: 0, usable_from: [] }`, `inbox.inbound_buckets: []`, `inbox.realtime.queue_configured: false`, `sources.legacy/orphaned: 0`, four provisioning zeros and `next_actions: []` — while the operator's server held 37 providers, 75 domains and 325 addresses that `emails provider list` and `emails domain list` printed in the SAME session. The rendered line `Capabilities: 0/0 active provider credential(s)` and `0 listed usable sender(s)` told agents the system was unusable minutes after mail had demonstrably been sent from `andrei@hasna.com`. Every one of those fields is now either read from the server or `null` with a machine-readable reason:
  - real, from `/v1`: `providers.total/active/by_type`, `domains.total` + a new `domains.verified` (the actual column, not three DNS verdicts invented from one boolean), `addresses.total/active/verified/owned/ready_to_receive`, per-domain `provisioning_status`/`last_error`/`next_check_at`/`ready_addresses`, all four `provisioning.*` counts, and a new `sources.configured` block from the previously unread `GET /v1/sources`.
  - honestly unavailable, with a stable reason code: `domains.send_ready`/`receive_ready` (`not_modelled_over_v1:domain_dns_evidence`), `addresses.usable_from` (`server_route_absent:/v1/senders` — send eligibility is resolved server-side from the SES identity set, and `verified` is NOT a proxy: 319 of 325 production rows are `verified: false` and still send), `inbox.inbound_buckets` and `inbox.realtime.*` (server-owned ingestion), `sources.active/legacy/orphaned` (no `/v1` classification), and `database.data_dir`.
  - **`--json` blast radius:** these fields change type from `number`/`array` to `number | null` / `T[] | null`. That break is deliberate — a consumer doing arithmetic now gets `NaN`/a compile error instead of silently trusting a zero. New top-level `degraded` (boolean), `unavailable` (dotted paths), `incomplete` (paths whose counts are lower bounds) and `gaps` (path → `{ available, reason, source, basis, complete }`) let a script gate on one expression: `emails status --json | jq -e '.degraded == false'`. The human renderer prints an unmeasured field as `unavailable — <reason>`, a bounded count as `≥N`, and a mandatory `Data gaps (N):` section.
- fix(status): the payload is assembled ONCE for both modes (`src/lib/status-types.ts` + the `status-facts.local`/`.remote` seam), so local and self_hosted are structurally identical. Local mode previously shared the same fabricated zeros — `buildSystemStatus()` had no mode branch at all — and also hardcoded `database.data_dir: null`; it now reports its real SQLite aggregates and derives `data_dir` from the actual database path (so an `EMAILS_DB_PATH` override is reported correctly instead of naming a directory the data is not in).
- fix(status): counts are no longer silent lower bounds. Every `/v1` list route is limit/offset-only and the server clamps each page to 500 rows, so a count taken from one `.list({ limit: 1000 })` call quietly caps at 500. New `enumerateSelfHostedRows` pages to the end, de-duplicates by id, and reports `complete: false` when its page budget runs out — in which case the numbers render with `≥` and the block is listed in `incomplete`. `exportEventsJson`/`exportEventsCsv` were truncating the same way and now enumerate; the remaining `.list({ limit: 1000 })` call sites are tracked as follow-up.
- fix(mcp): the domains resource fed a hardcoded `ready_addresses: 0` and `provisioning: null` into `assessDomainReadiness`, publishing a readiness VERDICT derived from unmeasured inputs; both are now read from the real `/v1` columns. The domain/address resource error branches returned `total: 0` with an empty list — strictly less honest than their own success paths, which already returned `total: null` — and now return `null` plus an `availability` record. Both `agentContextResourcePayload` implementations coerced a null `usable_from` back to `[]`; they share one sampler that preserves the null.
- fix(cli): `emails inbox sync-status` painted a yellow literal `0` for an S3 bucket count it never inspected and `0 legacy, 0 orphaned` for a classification that does not exist over `/v1`. The renderer (previously duplicated byte-for-byte in `inbox.local.ts` and `inbox.remote.ts`) is now one implementation that prints `unavailable — <reason>`, and `--json` carries `degraded`/`unavailable`/`gaps`.
- fix(cli): JSON errors no longer promise a command that refuses. The default `fix_commands` was `["emails status --json", "emails doctor --json"]` on every unmatched error — in self_hosted mode `emails doctor` refuses, so `emails doctor --json` failed and then told the caller to run `emails doctor --json`. Suggestions (and `status.next_actions`, and the sync-status hints) are filtered through one mode registry, and `emails provision status` is no longer proposed where it refuses.
- fix(cli): `emails send --dry-run` had no mode branch, so in LOCAL mode the one command whose entire purpose is predicting a send announced `(self-hosted)`, quoted the server's attachment caps, and predicted that scheduling was unavailable — which is false locally. The preview now names the mode that would run the send and states that mode's caps; the caps themselves are defined once (`src/lib/send-attachment-limits.ts`) and imported by both the predictor and the server that enforces them.
- fix(doctor): `runDiagnostics` in self_hosted mode reported `Self-hosted API: pass` purely because the local client config PARSED, without ever making a request — a fabricated green light reachable from MCP and the SDK. It now probes `GET /health` and `GET /ready` and reports the actual HTTP outcome; a parsed configuration is a `warn` that says it is not a health signal.
- **fix(status): a de-duplicated page count is no longer published as a total.** Review found the second version of the same defect in the first fix: `sources.configured.total` reported **3473 with `complete: true`** against a production `/v1/sources` table that holds **3899** rows. The generic list route ordered by `status ASC, type ASC, created_at ASC` — not a unique sort — so limit/offset paging returned 3899 rows containing 426 duplicates, and the pager's de-duplication turned an inflated count into an 11% undercount that still claimed to be final. Two changes: the enumeration now reports `stable: false` / `complete: false` whenever it sees a duplicate (a duplicate PROVES rows were skipped), so the number renders as `≥N`, joins `incomplete`, and sets `degraded`; and the server appends each resource's primary key to every list `ORDER BY` (`resourceListOrderBy`, plus the bespoke `domains`/`addresses` listers) so the paging window is stable and the count is exact once deployed.
- **fix(status): `degraded` is a gate again, not a permanent red light.** It was defined as "any field is unavailable", and both modes always carry structurally-unanswerable fields (self-hosted: no local SQLite dir, no `/v1/senders`, no DNS evidence, server-owned buckets/queue — 19 paths in production; local: no server source inventory). So `degraded` was true on every healthy deployment, the advertised `jq -e '.degraded == false'` could never pass, and one test asserted that permanent red as correct. Gaps are now CLASSIFIED by reason code (`src/lib/status-availability.ts` `statusGapClass`): structural absences are published as `limited` + `limitations[]`, live read failures as `degraded` + `failures[]`, bounded counts as `incomplete[]`. An unclassifiable reason counts as a failure, never as an expected limitation. Production now reports `degraded: false`, `limited: true`, `failures: []` and 19 named limitations — and flips to `degraded: true` for the `/v1/sources` lower bound above until the server fix is deployed. The human "Data gaps" section is gated on the gaps themselves rather than on `degraded`, so a healthy-but-limited payload still prints every reason; it is split into "Read failures", "Lower bounds" and "Data gaps".
- fix(status): every path in `unavailable` now resolves in `gaps`. Block-level gaps (`database`, `inbox.realtime`, …) were listed as unavailable with their reason reachable only from the block itself, so `gaps[path]` returned undefined for them. The four `inbox sync-status` subset views (CLI, MCP tool, both MCP resources) each enumerated their own selection of gap fields and all four omitted `incomplete`; they now share `statusGapSignals(status)`, so a subset consumer cannot read a lower bound as a total.
- **test: a regression guard for the whole class.** `src/lib/agent-context.self-hosted.test.ts` seeds the `/v1` stub and asserts exact counts, that the payload is not structurally the zeroed template, that `status.providers.total === listProviderSummaries().length` (the live contradiction, as a failing test), and that an unreachable source yields `null` + `source_unreachable` rather than `0`. `src/lib/status-fabrication-scan.test.ts` parses the TypeScript AST of every registered status builder and fails CI on any object-literal count initialised with a numeric literal or inventory initialised with `[]` (now including the completeness claims `complete`/`stable` on the enumeration itself) — against pre-fix code it pinpoints `agent-context.ts:116-144` and `resources.remote.ts:46/63/100`. The old test named "reports empty provider/domain/address/provisioning aggregates" asserted the fabrication and kept it green in CI; it is deleted. The `/v1` test stub now applies the server's real limit/offset windowing, so a test harness can no longer be more generous than the server it stands in for, and can be told to emulate a non-total list order so the duplicate-and-skip undercount is reproducible. `src/server/self-hosted/list-order.test.ts` fails if any resource pages over a non-unique sort, and `src/lib/agent-context.local.test.ts` covers local-mode counts, `degraded: false` on a healthy install, and the difference between a measured zero and an unmeasured field.
- **fix(status): a remedy that refuses in EVERY mode is no longer proposed in the one mode the registry did not cover.** The mode registry listed `emails provision` under self_hosted only, so the provisioning-failure branch of `next_actions` still offered `emails provision status` in LOCAL mode — where `src/cli/commands/provision.ts` throws `... is not implemented in this build` exactly as it does self-hosted. A per-mode list can only ever fix one mode; `NEVER_AVAILABLE_COMMANDS` (sourced from the `notImplementedAnywhere(...)` call sites) refuses regardless of mode, and the failure is now remedied with `emails domain list --json` / `emails address list --json`, which run. `src/lib/agent-context.local.test.ts` mirrors the self-hosted guard: every `next_actions[].command` must be runnable in local mode.
- fix(status): the provisioning-failure line and its `next_actions` reason no longer print an unmeasured count. `${domains_failed}`/`?? 0` rendered the literal `null address(es)` (and claimed `0 address(es)`) when one half was measured and the other was not; both now go through `renderStatusCount`, which says `unavailable`.
- **fix(events): an event listing that could not be enumerated to the end is refused, not windowed and returned.** `listFilteredEvents` computed `enumerateSelfHostedRows(...).complete` and discarded it, so once `events` — one row per delivery, open and click, the fastest-growing table in the system — crossed the pager's 20_000-row budget, or the server's paging window shifted, `export events` (MCP) and the dashboard events route handed back a JSON/CSV file that looked complete and was not. It now throws, naming the cause and the way to narrow the read. The filters `/v1/events` declares (`email_id`, `provider_id`, single `type`) are sent SERVER-side so a narrow read stays inside the budget, and are still applied client-side so the result is unchanged against a server that ignores unknown query params.
- fix(domains): `emails domain list` enumerates instead of single-calling. The server clamps every page to 500 and defaults to 100, so `--limit 1000` returned 500 rows as if that were the page and an unlimited `listDomains()` returned 100. A table that fits in one page still costs exactly one request. The remaining `.list({ limit: 1000 })` call sites are tracked as follow-up.
- test: the `/v1` stub records the query string of every generic list request (`GET /v1/__list_queries?resource=`), so a test can prove a client pushed its filters server-side instead of dragging the whole table over and filtering in memory.

## 1.3.1 (2026-07-26)

### Security

- pin `fast-uri` to 3.1.4, fixing CVE-2026-16221/GHSA-v2hh-gcrm-f6hx after the seven-day quarantine.
- keep bundled OpenTUI Solid/keymap build inputs dev-only, so vulnerable `brace-expansion` is absent from production installs and runtime images, without suppression or a quarantine bypass.

- add cursor-based, metadata-only attachment inventory across the self-hosted
  CLI/MCP contract, truthful unavailable-content and unknown-size responses,
  and structured self-hosted configuration failures with no SQLite fallback.
- add the tenant-scoped exact-canary attachment repair ledger and
  recipient-less-only trusted S3-key routing fallback.
- regenerate the canonical `@hasna/emails/selfhost` SDK and align the
  config-driven production cutover requirements through migration 0020.

## [1.3.0] - 2026-07-25

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
- **revert the unreleased `@hasna/emails` → `@hasna/mailery` rename.** The package publishes as `@hasna/emails` again, matching npm (`@hasna/emails` latest 1.2.6), the git remote (`hasna/emails`), and the `emails` bin production deploys at `emails.hasna.xyz` v1.2.7. `@hasna/mailery` on npm is the **abandoned 0.6.x line** (last publish 0.6.116), and `[0.6.117]` below had already renamed back and freed the `mailery`/`mailery-mcp`/`mailery-serve` bins for the separate cloud CLI. Publishing 1.2.7 as `@hasna/mailery` would have resurrected the abandoned name, stranded every `@hasna/emails` install at 1.2.6, and re-taken the cloud CLI's bins. Reverted with it:
  - bins: `emails`/`emails-mcp`/`emails-serve` only; `repository.url`, `hasna.contract.json` (`name`, `bins`, `migrateCommand`), and the CI identity assert point at `hasna/emails`.
  - env: the `MAILERY_*` → `EMAILS_*` startup bridge (`src/lib/env-compat.ts`) is deleted. `EMAILS_*` is the only prefix. `MAILERY_MODE`/`HASNA_MAILERY_MODE` are rejected as removed-runtime variables again — for any value, not just `cloud`/`remote`/`hybrid` — so a leftover Mailery variable can no longer silently choose this package's mode.
  - MCP: server/registration name and command back to `emails`/`emails-mcp`.
  - self-hosted API keys: canonical app slug is `emails` again. Keys minted while the unreleased rename was deployed carry the `mailery` slug, so it is retained as a verifier **alias** — those keys keep authenticating and stay visible to `key list`/`key rotate`/`key revoke`.
- remove superseded and dead scaffolding: `sdk/` (a second, hand-maintained REST client declaring `@hasna/emails-sdk` 0.6.69 that nothing built, published, or regenerated — while root `bun test` still collected its tests and reported it green; `src/selfhost.ts`, generated from the live OpenAPI doc and drift-checked in CI, is the real client); `src/storage-kit/mode.ts` plus `createSelfHostedPoolFromEnv`, `createMigrationLedger`, and `KIT_VERSION` (fork-template residue with no callers — `src/lib/mode.ts` and `src/server/self-hosted/env.ts` are the live resolvers); `scripts/nightly_sync.sh` (unreferenced unattended `git add -A && commit && pull` pointed at a path that does not exist); `scripts/docker-prune-file-deps.mjs` (unreferenced build shim for `file:` deps the manifest no longer has); and the `dashboard/dist` `files` entry (no script produced it, no code read it, the directory does not exist).
- **remove 5,022 LOC of unreachable product code and the 2,022 LOC of tests that kept it green (52 files).** None of it was loadable from any shipped entrypoint (`src/index.ts`, `src/storage.ts`, `src/selfhost.ts`, `src/cli/index.tsx`, `src/mcp/index.ts`, `src/server/index.ts`, `src/cli/tui/runtime.tsx`). Removed: the unregistered `emails inbound` command tree (folded into `emails inbox` back in the CLI restructure), the provisioning orchestrator/DNS-plan/round-trip/reconciler daemon, the BrandSight/GCD DNS client and its config keys, the never-wired `MailCache`, `cloudflare-routing`, `inbound-recipients` and `aws-inbound-ingest` modules, the dead `db/mailboxes|messages|sources|triage|email-agents` module families, the mode-routing facades whose every caller already imported the `.local` sibling (`db/threads`, `db/webhook-receipts`, `lib/sent-ledger`, `lib/inbound`), the `cli/tui/App.tsx` re-export shim, and a set of individually unreferenced exports. `src/entrypoint-reachability.test.ts` now fails CI if product code drifts back out of the shipped module graph.
- **fix: stop telling operators that unimplemented provisioning "runs on the self-hosted server".** It does not: there is no `/v1` provisioning route and the container runs no reconciler, so the message was false in both `local` and `self_hosted` mode. `emails provision *` and the `provision_domain`/`provision_address`/`provision_status` MCP tools now say the feature is not implemented in this build and name the commands that do work (`emails domain adopt`, `emails aws setup-inbound`, `emails address add`). `docs/PROVISIONING.md` carries the same status banner.
- **fix: `emails daemon status` no longer advertises `emails provision daemon`,** a command whose action was an unconditional throw. The provisioning queue counters it reports are never drained in this build, so the payload now states `queue.drainable: false` and the text output says so when work is pending. `start_commands.provisioner_once` / `provisioner_loop` are gone from the JSON.
- **fix: `emails domain setup-brandsight` is removed rather than advertised.** It was listed in `--help` with a full option set while its only implementation was unreachable, so it could never do anything but throw.
- fix: `assessDomainReadiness` and `emails doctor delivery` suggested `emails provision domain … --dry-run` as a remediation; they now suggest `emails domain adopt`, which runs.
- rebuild the product as local-first and operator-owned AWS self-hosting, with no Hasna SaaS control plane.
- add durable idempotent self-hosted sends, authenticated attachment retrieval, mailbox mutations, signed replay-safe webhooks, and explicit compatibility for previously issued API keys.
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
