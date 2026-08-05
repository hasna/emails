# PLAN — Deleting the deployment-mode axis (open-emails)

> Status: IN PROGRESS — phases 1–3 have landed and phase 4 is actively collapsing
> repository families (verified 2026-07-29). The live ratchet currently reports
> 14 two-arm families; use its test output rather than the baseline counts below.
> Owner: agents. Gates: `src/mode-axis-ratchet.test.ts`, `src/store-seam.test.ts`.
> Every number in this file was measured on `6646cc8` (`origin/main`) with Bun 1.3.14. Re-measure
> before trusting one; the commands are in §10.
>
> **A NOTE ON SPELLING, and it is load-bearing.** This file is inside the ratchet's scanned corpus,
> and six of its eleven counters match plain text in *any* tracked file — docs included. Writing the
> deployment-mode variable, the mode predicate, the mode reader/resolver/parser or the resource-gate
> call *with its parentheses* would raise a ceiling and turn CI red for the document describing the
> deletion. So this plan names those identifiers by role and by `file:line` instead of by spelling,
> exactly as `src/mode-axis-ratchet.test.ts` does with its own metric keys. Do not "fix" it.

## 1. Goal

Delete the deployment-mode axis outright. Not deprecate it, not hide it behind a default, not keep a
compatibility shim: **remove the variable, the two-arm modules, the dispatch layer and every branch
that reads them**, and leave no dead code behind.

The axis is a forbidden "switch" under the adopted OSS boundary policy, whose model is **one
deployment story — "you run it"**. Where the data physically lives is a deployment detail of *your*
installation, not a product variant with two personalities, two code paths and two truths.

## 2. The binding constraint — exactly TWO client stores, forever

| Store | What it is | Status |
|---|---|---|
| `SqliteEmailStore` | The local, default, on-disk SQLite database. | to build (§6, phase 1) |
| `HttpEmailStore` | A client of an Emails API. | to build (§6, phase 2) |

**There is no third, and Postgres is not a candidate.** Postgres is the *server's internal storage*
and is reached only through the API — **never a client transport**. An earlier design proposed a
client-side Postgres store as its central idea. That design is **rejected**. If a caller means
"local", it means SQLite; if it means "somewhere else", it means the API.

This is stated here, in `src/store/email-store.ts:8-12`, and enforced structurally by the seam guard,
because a third client store *is* the deployment-mode axis growing back under a new name. Anyone who
finds themselves adding one has mis-read this plan.

## 3. Why halfway is not an option

The one-line version, and the strongest argument in the program:

> The deployment-mode variable set to `self_hosted` means **opposite things in two of the three
> shipped binaries.** In the `emails` CLI it means *"become an HTTP client"*. In `emails-serve` it
> means *"become a Postgres server"*. (`emails-mcp` reads it too, and inherits the CLI's meaning.)

Two definitions of the same predicate exist today and prove it:

| Definition | File | Question it answers |
|---|---|---|
| client | `src/db/self-hosted-store.ts:170` | "am I an HTTP client?" |
| server | `src/server/self-hosted/env.ts:52` | "am I a Postgres server?" |

One variable, two contradictory semantics. No amount of documentation fixes that; renaming it moves
the contradiction; defaulting it hides the contradiction. Only deletion resolves it.

## 4. Baseline state on `6646cc8` — what existed and what it measured

### 4.1 The ratchet (`src/mode-axis-ratchet.test.ts`)

Eleven metrics, each pinned as a **ceiling that may only decrease** (`<=`, never `===`). Lowering one
is the point of the program and needs no argument; raising one must be argued in review. The table
below is the historical measurement on `6646cc8`, when every metric sat exactly
at its ceiling and no phase had landed. It is not the current tree's count:

| Metric | Ceiling = today | What it counts |
|---|---|---|
| `twoArmFamilies` | 43 | facades with two or more implementation arms — **structural, no identifier** |
| `remoteArmModules` | 43 | `src/**/*.remote.*` HTTP-arm modules |
| `routedFacadeDefinitions` | 30 | definitions of the dispatch helper — in 30 of the 43 facades; the other 13 dispatch without it |
| `routedCallExpressions` | 293 | dispatch call sites — exports whose implementation is picked at runtime |
| `selfHostedResourceBranches` | 47 | mode-gated resource-gate branches inside `*.local.*` |
| `selfHostedResourceReferences` | 203 | the same gate anywhere in the tree (superset of the above) |
| `isSelfHostedModeReferences` | 70 | the mode predicate — **both** definitions from §3 |
| `getEmailsModeReferences` | 78 | the process-wide mode read |
| `resolveEmailsModeReferences` | 74 | mode resolution, both variants |
| `normalizeEmailsModeReferences` | 16 | the parser that admits the two mode values |
| `emailsModeEnvReferences` | 242 | the variable itself, tree-wide: TypeScript, docs, Terraform, compose |

Corpus on `6646cc8`: **638 tracked files, 637 scanned, 7,631,658 characters** (adding this file makes
it 639/638 and moves no metric — the spelling discipline above is what buys that); floors are 500 files
and 5,000,000 characters, and they live inside the scan function so no single test can be run over a
corpus small enough to satisfy `<=` trivially. **228 test files hold 169 of the 242 variable
references** — so a mass test deletion is the obvious fake reduction, and the floors exist to make it
fail. (The prose *inside* the ratchet still quotes 624/623/~7.4M and 226/159 from when it was
written. Those are comments, not assertions; the ceilings are what is enforced.)

**Ten of the eleven counters are keyed on names.** A mechanical rename of the dispatch helper, the
variable and the arm-file suffix drives all ten to zero with all 43 families, 293 dispatch sites and
242 references still standing. `twoArmFamilies` is the one computed from file structure, which is why
it is listed first and why the deletion PR must be **read**, not merely measured.

### 4.2 The seam (`src/store/`) — types only at the baseline

At the baseline it was declared but not implemented. The current tree contains
both SQLite and HTTP stores plus the shared conformance suite described in
phases 1–3. Historical baseline figures follow:

| Fact | Value on `6646cc8` |
|---|---|
| Repositories on `EmailStore` | 25 (23 mapped 1:1 onto `src/db/*` families + `sendIntents`, `attachmentRepair`) |
| Declared operations | **70**, and every one returns `Promise<Outcome<…>>` |
| Capability-gated operations | 27, across 7 capability keys |
| Ungated operations | 43 — still returning `Outcome`, see §5 |
| Conformance cases shipped | **0** (`CONFORMANCE_CASES` is frozen empty; all 7 capabilities are uncovered) |
| Implementations | **none** |
| Consumers | **none** — `src/storage.ts` re-exports the types, `src/store-seam.test.ts` guards them |

What the guard already forbids, so it does not have to be re-litigated per PR: no classes, no
inheritance, no `implements`-able parent, no default bodies, no member-selection/subtraction from an
existing type, no runtime merging of defaults, no scope identifier in any signature, and no
synchronous operation. `src/store/**` imports nothing from outside itself.

### 4.3 The two-arm families — 43 of them

| Area | Count | Families |
|---|---|---|
| `src/db/` | 21 | address-lifecycle, addresses, aliases, contacts, domains, email-content, email-digests, emails, events, forwarding, groups, inbound, owners, providers, provisioning, sandbox, scheduled, send-keys, sequences, templates, warming |
| `src/lib/` | 13 | analytics, batch, delivery-doctor, doctor, email-digest, forwarding, s3-sync, send, stats, status-facts, sync, verification-code, webhook |
| `src/cli/commands/` | 6 | daemon, email-log, inbox, misc, serve, sync |
| `src/cli/tui/` | 1 | data |
| `src/mcp/` | 2 | resources, tools/email-ops |

Two `src/db` families (`threads`, `webhook-receipts`) are already single-armed and have repositories
on the seam waiting for them.

The HTTP arm is synchronous **only** because `src/db/self-hosted-store.ts:259` shells out to `curl`
through `spawnSync` to fake a blocking network call. That bridge dies with the axis, which is why
every seam operation is a `Promise` even where SQLite could answer synchronously.

## 5. Two hard rules

**5.1 Every operation returns the outcome type — not only the capability-gated ones.**

An earlier draft of the seam returned plain values from operations "every store can always perform"
and reserved `Outcome<T>` for the gated ones. That left **42 of 65 operations with no way to say
"I cannot"** (`src/store/repositories.ts:46-56`), so for the list operations, the unread count and the
message counts, **an empty array or a zero was the only expressible answer**. That is precisely the
lie this refactor exists to remove, so the split rule is gone: the refusal channel is universal, a
caller cannot reach `.value` without checking `ok`, and `tsc` — not code review — enforces it. Today
that means 70 of 70 operations carry it, 27 of them additionally capability-gated. Do not
reintroduce the split under any argument about ergonomics.

**5.2 The mode-gated branches inside the local-arm modules die WITH the axis, never before.**

The 47 `selfHostedResourceBranches` are the local arm asking whether it is really the local arm. They
**fail loud** today: when the client is configured for the API and the endpoint does not exist yet,
the call throws rather than degrading. Delete them early — before the axis and the dispatch layer are
gone — and the same calls fall through to local SQLite and **silently serve local rows under a
self-hosted configuration.** That is the split-brain bug the module was written to close
(`src/db/self-hosted-resource.local.ts:1-15`). Deleting them is part of phase 9 and of no earlier
phase.

## 6. The phases

Dependency order. Each phase is one or more PRs; **every PR is individually green and individually
reviewable**, and none is large enough that a reviewer will wave it through. Every phase from 4
onward lowers at least one ratchet metric, and the lowered numbers are the diff a reviewer reads
first.

| # | Lands | Gate |
|---|---|---|
| 1 | `SqliteEmailStore` + shared conformance suite — **landed** | uniform-coverage assertion passes; every capability covered |
| 2 | `HttpEmailStore` against the same suite — **landed** | both stores execute every case |
| 3 | Configuration-driven store resolution — **landed** | both-configured is a boot error, proven by test |
| 4 | `src/db` families migrated, lowest fan-in first | ratchet drops each PR |
| 5 | CLI command families + TUI data layer | strictly after their db families |
| 6 | MCP surfaces collapsed, mode guards deleted | one registration path, no mode read in `src/mcp/**` |
| 7 | One mailbox view over the store | both `MailDataSource` backends retired |
| 8 | One send service | exactly-once ledger present in every configuration |
| 9 | **The axis deleted** | **ratchet reads zero on all eleven metrics** |
| 10 | Mode exports dropped from the published surface | major version |

**Phase 1 — `SqliteEmailStore` behind the seam.** The first implementation, plus the **shared
conformance suite** the second one will be held to. The suite's runner must assert that *every*
implementation executed *every* case (`assertUniformCaseCoverage`); a case list that shrinks
mid-run, a store counted twice, or an empty run must all throw rather than certify. The gate for this
PR is that `capabilityCoverageGaps()` returns empty — an unexercised capability is exactly where a
refusal quietly degenerates into "returns nothing".

**Phase 2 — `HttpEmailStore`.** Same suite, no new cases written to suit it. Where the API cannot do
something, the store declares the capability false and returns the typed refusal; the harness already
fails a store that answers an unavailable capability with `{ ok: true, value: [] }`, and fails one
that refuses a capability it declared available. Both directions matter.

**Phase 3 — configuration-driven resolution.** Selection follows from **which of the database path or
the API URL is configured** — not from a mode word. **Both configured is a hard boot error, never a
precedence rule.** A precedence rule is the axis with extra steps: it answers "which one wins?"
instead of "which one did you mean?", and the wrong answer is silent. One configured → that store.
Neither → the default local SQLite path. Both → refuse to start, naming both settings.

`src/store-resolution.ts` is that resolution. Two further configurations it refuses rather than
resolves, both of which would otherwise pick a store silently: an API URL with no credential (that
store answers 401 to everything, which is indistinguishable from one that legitimately declines
everything), and a set vault pointer whose payload is not in the environment (the pointer names an
API, so falling through to local SQLite serves local rows under an API configuration). It reads
storage settings only, and a source-text assertion — not a convention — keeps it from reading the
axis this program is deleting.

Phase 3 also closed the gap phase 2 documented: `/v1` had **no route that recorded a message without
sending it**, so `createMessage`/`upsertMessage` — ungated on the seam, hence with no capability to
declare false and no legal refusal — could not be served for outbound input at all.
`POST /v1/messages/record` serves both, in either direction, and refuses the four send-ledger
columns so a row recorded there can never carry a fence the send path did not produce; the
inbound-only 409 on `POST /v1/messages` is unchanged. The conformance suite now runs against the
**real service** over HTTP with Postgres behind it in the `selfhost-postgres` job (40 passed /
8 refused / 0 failed, with neutering controls that must turn it red), which is how the live run
found and fixed the Postgres upsert writing its whole column set on a replay — resetting read, star
and label state on the one operation whose contract is that a replay changes nothing it was not
told about.

**Phase 4 — migrate the two-arm `src/db` families, one at a time, lowest consumer fan-in first.**
Fan-in measured on `6646cc8` by resolving relative import specifiers and counting the **non-test**
modules that import the family from outside its own arms:

| Tier | Families (prod fan-in) |
|---|---|
| first | address-lifecycle 2, email-content 2, events 2, scheduled 2 |
| then | aliases 3, forwarding 3, groups 3, inbound 3, sandbox 3, send-keys 3, sequences 3, warming 3 |
| then | email-digests 4, emails 4, owners 4, provisioning 4, templates 4, contacts 5 |
| last | addresses 7, domains 8, providers 12 |

Each family's PR deletes its `.remote.*` arm, its facade's dispatch helper and its dispatch call
sites, and lowers `twoArmFamilies`, `remoteArmModules`, `routedFacadeDefinitions` and
`routedCallExpressions` together. The `*.local.*` mode-gated branches inside it stay (§5.2).

**Phase 5 — CLI command families and the TUI data layer.** Strictly after the db families they
import; `src/cli/tui/data` has the largest fan-in of the 43 two-arm families (16 production
importers; next is `src/db/providers` at 12) and goes last within the phase. The branches on the data
source's `mode` label — 5 at `src/cli/commands/send.ts:136` and
`src/cli/commands/inbox.local.ts:178,496,1006,1011`, plus 3 pass-throughs at
`src/cli/commands/inbox.remote.ts:427,679` and the TUI state, as recorded in
`src/store/descriptor.ts:6-9` — are deployment-mode decisions wearing a data-source costume and go
with them. **That recorded count of 8 is the sites at the top of the call chain, not all of them**:
the two pass-throughs feed two further branches on the same value at
`src/cli/commands/inbox.remote.ts:1095,1107`, and `src/lib/mail-data-source.ts:487` compares it for
memoisation. Grep the label, do not work from the list. Do not replace it with another
narrow union; `StoreDescriptor.kind` is deliberately `string` so no `switch` over it can be
exhaustive (`src/store/descriptor.ts`).

**Phase 6 — collapse the MCP surfaces and delete the mode guards.** `src/mcp/resources.ts`,
`src/mcp/tools/email-ops.ts`, `src/mcp/tools/sequences.ts` and `src/mcp/tools/infrastructure.ts` each
choose a registration or refuse a tool based on the mode read. One registration path, one tool set;
a tool that a given store genuinely cannot serve refuses with the capability refusal rather than
being unregistered, so the answer to "why is this tool missing?" stops depending on an environment
variable.

**Phase 7 — one mailbox view over the store.** `src/lib/mail-data-source.ts` (510 lines) and
`src/lib/self-hosted-mail-data-source.ts` (1,660 lines) are two implementations of the same inbox.
Replace both with one view built on `MessagesRepository` / `InboundRepository` / `ThreadsRepository`,
and retire the backends. This is the phase that removes the largest block of duplicated behaviour and
the parity tests that exist only to compare the two.

**Phase 8 — one send service.** The idempotency-fenced send ledger is the strongest arm's and the
local arm has never had it. `SendIntentsRepository` declares 12 operations, all capability-gated: 10
on `sendIntentLedger` and 2 (`markSendBlocked`, `evaluateOutboundPolicy`) on `outboundPolicy`. The
interface's own header comment claims all 12 are gated on the ledger; it is wrong, and the split
matters — a store can hold the fence without being able to evaluate policy, and vice versa.
One send service carries the **exactly-once ledger in every configuration**. A store that cannot hold
the fence transactionally must refuse the send, not approximate it: a non-atomic reserve hands the
same intent to two senders and mails the message twice, which is strictly worse than refusing.

**Phase 9 — delete the axis.** `src/lib/mode.ts`, the dispatch layer, the `curl`-based bridge in
`src/db/self-hosted-store.ts`, the mode-gated branches in the `*.local.*` modules, and every remaining
mode-gated branch. **Gated on the ratchet reading zero on all eleven metrics**, at which point
`src/mode-axis-ratchet.test.ts` and `scripts/mode-axis-ratchet-lib.mjs` are deleted along with the
axis they measure. Zero is *necessary and not sufficient* — see §4.1 — so this PR gets a real read,
not a numbers check.

**Phase 10 — drop the mode exports from the published surface.** `src/storage.ts` currently exports
**fourteen** mode symbols from `@hasna/emails/storage`: six functions, four constants and four types
(`src/storage.ts:2-21`). Count the constants — they are what the tree-wide metric sees, and omitting
them understates the phase. Removing them is a breaking
change to a public package: **major version**, with the removal listed explicitly in the changelog.
No re-export shim, no deprecated alias — a shim is a compatibility layer for an axis that no longer
exists, which is the same mistake in a smaller box.

## 7. Traps already paid for

Each of these cost real time in this repository. They are recorded so the next person does not buy
them again.

1. **A guard that scans a tarball built without running its build step certifies an empty artifact.**
   The historical vacuous run of the pack scan packed 6 entries, scanned 5 files holding zero product
   code, and printed a clean bill of health (recorded at `scripts/no-cloud-artifact-scan.mjs:11-17`).
   It now carries two independent floors (100 files **and** 1,000,000 bytes), because a file count
   alone is cleared by 100 empty stubs and a byte total alone by one big file. A real artifact scans
   **756 text files and 12,646,868 bytes** after `bun run build` on `6646cc8` — the script's own
   comment still says 696 files and 8.0 MB, so its "the byte floor is about an eighth of today's
   payload" rationale is now nearer a twelfth. The floor is still doing its job; the prose is stale.
   **Any new guard needs a floor, and the floor belongs inside the function every assertion goes
   through — not in one test that can be skipped.**
2. **Ban patterns without positive controls can be neutered while CI stays green.** A pattern that
   stops matching silently passes everything; a pattern widened until it matches anything blocks
   unrelated work. Every ban pattern and every ratchet metric therefore carries fixtures that MUST
   match and fixtures that MUST NOT, checked against the pattern itself rather than against repo
   content — because repo counts are *supposed* to reach zero, and a "this metric found something"
   check would have to be deleted exactly when it matters most. **This includes path selectors**: a
   one-character typo in an arm-file selector once drove a 47-unit metric to zero with every other
   assertion green (`src/mode-axis-ratchet.test.ts:42-47`; the `pathHits`/`pathMisses` fixtures and
   the assertion at `:259-262` are the fix). Traps 1 and 2 survive only as prose in the guards
   themselves — there is no commit left to read them from, which is the reason to keep writing them
   down.
3. **A ratchet keyed on symbol names is defeated by a rename.** Ten of the eleven metrics are; that is
   why `twoArmFamilies` is computed from file structure and why the metric list is asserted to contain
   exactly one identifier-independent counter. **Any future ratchet needs at least one structural
   metric.**
4. **A fidelity check must compare structurally, not through a normaliser that flattens the very
   difference it is hunting.** The ratchet originally normalised the one compatibility bridge out of
   its own corpus — subtracting an occurrence of the exact text it counts — and now measures the raw
   corpus (`c96011b`). The no-cloud guard's remaining bridge is pinned by unique structural anchors
   plus a `sha256` digest of the complete byte range, so insertion, reordering, duplication or
   movement to another path all fail closed instead of being normalised away.

## 8. Non-goals

- **Do NOT remove org/tenancy scoping.** The amended boundary policy places the org model in the OSS
  layer; only commercial metered operation sits in the paid hosted product. Tenancy vocabulary is
  legitimate here and the no-cloud guard deliberately does not flag it. Note that scope is *structural*
  on the seam — no signature takes a scope identifier, because the tenant is fixed at construction —
  and that property is asserted, not conventional.
- **Do NOT delete existing mail.** No phase migrates, rewrites or drops stored messages. A store swap
  changes where reads go, not what exists.
- **Do NOT take a hard dependency on the identity package.** It plugs in behind the seam later. Taking
  the dependency now couples the deletion to an unrelated integration and gives the axis somewhere to
  hide.
- Do not rename anything as a substitute for deleting it (§4.1).

## 9. Definition of done

1. All eleven ratchet metrics read zero, and the ratchet and its scan library are deleted.
2. No `*.remote.*` module, no dispatch helper, no dispatch call site, no mode variable, predicate,
   reader, resolver or parser remains in the tree — including docs, Terraform and compose.
3. Exactly two implementations of `EmailStore` exist, both passing the same conformance suite with
   uniform case coverage and no capability gaps.
4. The published surface carries no mode symbol, and the major version records the removal.
5. No compatibility shim, no deprecated alias, no dead branch.

## 10. Verification

Run all four on every PR in this program; they are the same four this plan's own PR was checked with,
green on `6646cc8`:

```
bunx tsc --noEmit                 # clean
bun run test                      # 2528 pass, 138 skip, 0 fail (2666 tests, 228 files)
bun run no-cloud:source           # 26 pass, 0 fail
bun run build && bun run no-cloud:pack   # build first, or trap #1 applies to you
```

The ratchet runs inside `bun run test`; to read the numbers on their own:

```
bun test src/mode-axis-ratchet.test.ts src/store-seam.test.ts
```

A failing ratchet prints the metric, its ceiling, the new count and the highest-count files. A
*lowered* count never fails — that is the whole design.
