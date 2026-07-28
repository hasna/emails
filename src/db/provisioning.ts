// Provisioning lifecycle for domains and addresses, plus the append-only audit trail.
// ONE implementation; nothing here asks who is running it.
//
// The provisioning STATE fields are columns on the `domains` and `addresses` rows
// (migration 19). The audit trail is its own append-only table. This module provides typed
// read/write access to both, plus the daemon's "due work" query, and reaches all of it
// through the store seam (`src/store/`): `DomainsRepository`, `AddressesRepository` and
// `ProvisioningRepository`, whose records already carry every provisioning column
// (`src/store/records.ts`). Every export is ASYNCHRONOUS because every operation on the seam
// is, and takes an injectable store defaulting to the configured one.
//
// WHAT THIS FILE USED TO BE. A 44-line facade whose dispatch helper read the process-wide
// deployment word and handed NINETEEN exports to one of two sibling modules — a 509-line
// SQLite arm and a 401-line `curl`-bridge arm. It was the largest dispatch table in the
// programme.
//
// EVERY OPERATION HAS A STORE EQUIVALENT, so no export here requires a `Database` and none
// of them needed a seam widening. `src/store/` is byte-identical after this change. One
// widening is DESCRIBED and deliberately not made — see the note on `listProvisioningEvents`.
//
// ─── WHAT THE TWO ARMS ACTUALLY DID DIFFERENTLY, MEASURED RATHER THAN ASSUMED ─────────────
//
// FOURTEEN divergences, and the tally is: the SQLite arm was stronger on FIVE (1, 2, 4, 8, 9),
// the HTTP arm on TWO (7, 11), the two AGREED on three and the agreed behaviour is preserved
// (10, 12, 13), THREE are cases where neither arm was right and both are corrected (3, 5, 6),
// and ONE is resolved AWAY from both arms with the reason stated (14). An earlier version of
// this note said "nine, two and two", which does not add to thirteen or to anything else;
// adversarial review did the arithmetic.
//
//  1. FOURTEEN READS ANSWERED OUT OF ONE CLAMPED PAGE — twelve literal `list({ limit: 1000 })`
//     sites feeding fourteen exports, because one of them (`dueRows`) served both queue
//     operations and both sides of the summary. The service clamps that to 500 and the
//     SQLite resource path clamps to 500 as well. So above 500 rows that arm reported a
//     domain as "not provisioned", an address as having no provisioning row, a due-work
//     queue missing its tail, and a `ready` count that stopped at the page boundary — the
//     `daemon.remote.ts` header records the observed shape of it: "600 due domains rendered
//     as `Due work: 500 domain(s)`". Every read below enumerates to an EMPTY page and
//     refuses to answer if it could not finish. The SQLite arm, which used SQL predicates
//     and had no bound, is the stronger arm and is what the behaviour is resolved to.
//  2. THE `nameservers` WRITE WAS CORRUPTING THE COLUMN OVER HTTP. The deleted HTTP arm sent
//     `nameservers_json: JSON.stringify(list)`. The service's `extractDomainProvisioning`
//     runs that through `asStringArray`, which wraps a non-array string in a ONE-ELEMENT
//     array — so `["ns1.example.com","ns2.example.com"]` was stored as a single element
//     holding the raw JSON text. The seam's `DomainProvisioningPatch.nameservers_json` is
//     `string[]` and both stores encode it themselves, so the ARRAY is what goes down now.
//  3. UNDECLARED WRITE COLUMNS. Both deleted arms sent `updated_at` on every update and
//     `id` + `created_at` on every event insert. `/v1/provisioning` declares exactly five
//     writable columns — `entity_type`, `entity_id`, `from_state`, `to_state`, `detail_json`
//     — behind `additionalProperties: false`, so the real `HttpEmailStore` REFUSES a write
//     naming `id` or `created_at`; the deleted `curl` bridge did not validate them. Nothing
//     below sends a column the resource does not have. The identity and both timestamps come
//     from whichever store performed the write, and both stores stamp them.
//  4. THE TWO ARMS SORTED WITH DIFFERENT COLLATIONS, and one of them was LOCALE-DEPENDENT.
//     The SQLite arm sorted in SQL under that engine's BINARY collation; the HTTP arm sorted
//     in JavaScript with `localeCompare`, so the order it PRESENTED moved with the process
//     locale. (Not its page boundaries — those were the server's `ORDER BY`; an earlier
//     version of this note said otherwise and adversarial review corrected it.) Everything
//     below compares in UTF-16 code-unit order, which is deterministic on every machine.
//  5. NEITHER ARM HAD A TOTAL ORDER, so equal timestamps ordered arbitrarily. The SQLite arm
//     ordered addresses `created_at DESC` and due work `next_check_at ASC` with no
//     tiebreaker; the HTTP arm's comparator returned 0 for a tie and inherited whatever the
//     server sent. Rows written in a tight loop share a millisecond, so this was reachable.
//     Every ordering below carries an `id` tiebreaker, matching the direction the seam's own
//     `listAddresses` uses (`created_at DESC, id DESC`).
//  6. THE TWO STORES ORDER THE SAME TABLE OPPOSITE WAYS, which is why nothing below pushes a
//     `limit`/`offset` window down. `ListOptions` admits no ordering. The SQLite resource
//     path orders `provisioning_events` `created_at DESC, id DESC` (`describeTable`; the
//     table has no `updated_at`), and the service's spec orders the same resource
//     `created_at ASC`. The seam's `listAddresses` is `created_at DESC, id DESC` on SQLite
//     and `created_at DESC, id ASC` on the server. So the filtered set is enumerated in full,
//     sorted here, and only then grouped or windowed.
//  7. A MALFORMED `nameservers_json` READ AS "NO NAMESERVERS" LOCALLY AND THREW REMOTELY.
//     The SQLite arm used `parseJsonArray`, which answers `[]` for unparseable content AND
//     does not check that the elements are strings — so `["a", 1]` came back typed as
//     `string[]` while holding a number. The HTTP arm's `stringArray` rejected both. The HTTP
//     arm is the stronger one here: a domain whose nameserver list cannot be read is not a
//     domain with no nameservers, and `domain adopt` prints that list to an operator. The
//     deleted HTTP arm also accepted a bare `nameservers` key as a fallback for
//     `nameservers_json`; neither store emits one, and that fallback is not carried over.
//
//     THE GUARD BELOW ONLY REACHES HALF OF IT, and that is a STORE-LAYER DEFECT DESCRIBED AND
//     NOT FIXED. `mapDomain` in `src/store-sqlite/registry.ts` maps this column with the SAME
//     `parseJsonArray` and then casts each element with `String(...)`, so over the SQLite
//     store unparseable content is already `[]` and a numeric element is already a string by
//     the time this module sees it: the defect moved down rather than away. The HTTP store
//     copies the column through unvalidated (`optional()` in `src/store-http/mapping.ts`), so
//     the guard is live on that side. Fixing it means teaching that one mapper to fault, in
//     `src/store/`'s implementation rather than in the seam — and this change leaves
//     `src/store/` byte-identical, so it is recorded here instead.
//  8. ABSENT IS NOT `now()`. The deleted HTTP arm read an event's `created_at` through the
//     shared ISO coercion, which returns `new Date().toISOString()` for a MISSING value — so
//     an event row whose timestamp could not be read was reported as having happened at the
//     moment it was read. The column is `NOT NULL` in both schemas. That is a fault here.
//  9. A PATCH AGAINST A ROW THAT DOES NOT EXIST. The SQLite arm ran an UPDATE affecting zero
//     rows and then answered `null`; the HTTP arm's bridge threw on the 404. The seam
//     declares `DomainRecord | null` and answers `null`, which is the SQLite arm's behaviour
//     and the one the signature has always published.
// 10. BOTH `…ByIds` PLURALS SILENTLY DROP AN ID THEY COULD NOT RESOLVE, and both arms did:
//     the SQLite arm's `WHERE id IN (…)` simply returns fewer rows, and the HTTP arm filtered
//     a page it had already fetched. The map is keyed by rows FOUND, so an unresolved id is
//     absent rather than reported. That is preserved because both arms agreed — but every
//     one of the six production call sites reads it as `map.get(id) ?? 0` or
//     `?? undefined`, which turns "I could not find this domain" into "this domain has no
//     provisioning". The reason it is safe to preserve is the reason the truncation rule
//     above exists: absence now means the whole table was read and the row is not in it.
// 11. `provisioning_status` CAME BACK EMPTY IN ONE ARM AND RAW IN THE OTHER. The column is
//     `NOT NULL DEFAULT 'none'` in both schemas; the HTTP arm mapped a missing or empty value
//     to `"none"`, the SQLite arm cast whatever the row held. `""` is not a state, so the
//     HTTP arm's default is taken. A row that carries no `provisioning_status` KEY AT ALL is
//     a different fact — the store did not project the provisioning columns — and is a fault.
// 12. `TERMINAL_STATES` IS EXPORTED DATA AND THE TWO ARMS AGREED ON IT: both declared
//     `["ready", "failed", "none"]`, and the SQLite arm additionally hard-coded the same
//     three states as the SQL literal `('ready','failed','none')` rather than deriving them
//     from the constant. There is now one definition and the queue predicate is derived from
//     it, so the constant and the filter cannot drift.
// 13. `receive_strategy` IS CAST, NOT VALIDATED, in both arms and still is. A value outside
//     the three known strategies is passed through rather than rejected, because the column
//     has no CHECK in either schema and a migration that adds a fourth strategy must not make
//     every existing address unreadable.
// 14. AN EMPTY `domain_id` NAMES NO DOMAIN, and this is the one divergence resolved AWAY from
//     both arms. `addresses.domain_id` is a bare nullable TEXT column with no foreign key, and
//     `setAddressProvisioning(id, { domain_id: "" })` writes one — no store refuses it. The
//     deleted SQL tested `domain_id IS NOT NULL`, so `''` COUNTED as a domain: it produced a
//     `GROUP BY` bucket keyed on the empty string and a `ready` tally under it. Every read
//     below instead treats `''` the same way it treats absence, because a bucket keyed `''`
//     is a domain this module invented — nothing can join it to a `domains` row. The write is
//     deliberately left alone: refusing a column value the schema accepts is a product
//     decision, and the four reads now agree with each other, which the two arms did not.
//     Both adversarial reviewers found this independently, in both directions.
//
// ─── THE AGGREGATES, WHICH ARE THE HARD PART ──────────────────────────────────────────────
//
// THE SEAM PUBLISHES NO COUNT OPERATION. There is no `countAddresses`, no server-supplied
// total, no `has_more`. So `countReadyAddressesForDomain`, both `listReadyAddressCounts…`
// maps and `getProvisioningWorkSummary` — which were four SQL `COUNT(*)`s in the SQLite arm —
// are bounded client-side enumerations here, and a number taken from a bounded read is a
// LOWER BOUND unless the read reached the end of the table. The two shapes get two different
// answers, and the difference is the shape rather than the honesty:
//
//   * THE MAPS AND THE SINGLE COUNT REFUSE. `Map<string, number>` and a bare `number` have
//     nowhere to put "this is a bound". Every one of the six production call sites reads the
//     map as `counts.get(id) ?? 0` and feeds it to a readiness verdict, so a truncated map
//     would publish `0 ready addresses` — a confident, wrong readiness state — for a domain
//     the enumeration never reached. There is no honest value to return, so these throw.
//   * `getProvisioningWorkSummary` REPORTS A BOUND, because it CAN. Its four counts are
//     `number | null` and it carries a `StatusAvailability` record, which is the vocabulary
//     `emails status` and `daemon.remote.ts` already use: `renderStatusCount` prints `≥N`
//     for an incomplete read and `unavailable` for one that did not happen.
//     `src/cli/commands/daemon.local.ts` — its only consumer — renders it that way, and
//     turning `emails daemon status` into an exception would take away the operator's only
//     view of the queue at exactly the moment it is largest.
//
// A REFUSAL IS NEVER AN ANSWER. Every store refusal below becomes a thrown error naming the
// operation and carrying the store's own code, status and message, except inside
// `getProvisioningWorkSummary`, where it becomes an unavailable availability record with the
// same information and four nulls. Nothing answers `[]`, `0`, `false` or `null` for a read
// that did not happen.
//
// ─── WHAT IS SLOWER, STATED RATHER THAN LEFT TO BE DISCOVERED ─────────────────────────────
//
// `ListOptions` carries no filters and neither `listDomains` nor `listAddresses` accepts any,
// so every read that is not addressed by a single id enumerates its whole table. Against the
// local SQLite store that is a handful of in-process queries. Against an API store it is
// `ceil(rows / 500) + 1` requests per call — two for the largest installation recorded here
// (325 addresses, 75 domains). The SQLite arm did each of these in one indexed query, and
// that is a real cost this change accepts in exchange for not answering out of one page.
//
// AND WHAT IS NOT MERELY SLOWER, which the first version of this note left out. The
// enumeration is BOUNDED: 200 pages at 500 rows, minus one anchor row a page, is 99,801 rows.
// Past that the three count operations do not degrade, they THROW — on the local SQLite store
// too, where the deleted arm ran a `GROUP BY` with no bound at all. The callers that would
// go from working to failing are `GET /api/domains/readiness`, the MCP `emails://domains`
// resource, `emails inbox explain` and the TUI workspace. No installation recorded here is
// within three orders of magnitude of that ceiling, and the alternative — publishing a bound
// through a `Map<string, number>` that has nowhere to record it — is the fabricated readiness
// verdict this change exists to remove. It is a real cost and it is stated rather than left
// to be discovered. Adversarial review asked for it.
//
// A SEAM WIDENING, DESCRIBED AND NOT MADE. `ProvisioningRepository.listProvisioningEvents`
// takes a bare `ListOptions`, so the entity filter cannot be pushed down — even though BOTH
// implementations already support it (each delegates to a generic resource `list` that takes
// `filters`, and the service declares `entity_type`, `entity_id` and `to_state` as filters on
// that resource). Widening that one signature to `ListOptions & { filters?: Record<string,
// string> }` would turn `listProvisioningEvents` from a full scan of an append-only,
// unboundedly growing table into an indexed read. It is deliberately NOT made here: two
// audits are waiting on `src/store/`, and this change leaves it byte-identical. Until then
// the event scan runs on the same budget as the registry reads and refuses rather than
// truncating. (An earlier version of this sentence said "its own larger page budget", which
// contradicted the constant twenty lines down; both reviewers caught it.)
//
// ─── TWO BEHAVIOURS THAT CHANGE, NEITHER OF THEM A DIVERGENCE ─────────────────────────────
//
// `setAddressProvisioning(id, {})` NO LONGER BUMPS `updated_at`. Both deleted arms wrote
// `updated_at` unconditionally. On the SQLITE store `applyAddressProvisioning` returns the
// row without writing when the patch names no column, while `applyDomainProvisioning` still
// stamps it; on the HTTP store NEITHER stamps, because the service returns the row unchanged
// for an empty body. So this is one store's asymmetry rather than a seam property — an
// earlier version of this note claimed the latter — and it is not this module's to paper
// over. No caller passes an empty patch, and both shapes are pinned so neither can drift.
//
// ─── WHAT MUTATION TESTING FOUND, INCLUDING WHERE MY FIRST ACCOUNT OF IT WAS WRONG ───────
//
// Mutation testing reverted every change in this file and in the renderer one at a time. The
// first round was FORTY-FIVE mutants I chose myself, forty-two killed, and I published three
// survivors with three explanations. TWO OF THOSE THREE EXPLANATIONS WERE FALSE, and an
// independent reviewer's sixteen probes — chosen without seeing my list — found NINE further
// survivors my forty-five could not see. That is the honest shape of an author's own mutant
// list, and it is why the number below is the second one:
//
//   * `byNewestFirst`'s `id` tiebreaker. I called it redundant "against both real stores".
//     It is not. `src/store-sqlite/registry.ts` orders `listAddresses`
//     `created_at DESC, id DESC` but the SERVER orders it `created_at DESC, id ASC`
//     (`src/server/self-hosted/store.ts`) — which divergence 6 says twenty lines above, so the
//     claim contradicted its own file. The mutant survived because the HTTP variant of the
//     suite runs against a fixture that translates HTTP into the SQLite seam and therefore
//     serves SQLite's ordering, not because the term is dead. A case now drives the SERVER's
//     ordering through a store that pages consistently, and kills it. I also claimed no
//     fixture could exist because reordering trips the pager's shift detector; that was wrong
//     too — a fixture applying a consistent TOTAL order to the whole table pages cleanly.
//   * `readyDomainIdOf`'s `if (!provisioning.domain_id) return null`. I called it an equivalent
//     mutant. It is not: `nullableText` yields `""` for an empty column, `""` is falsy but not
//     null, and without the guard a ready address with `domain_id = ""` is tallied under an
//     empty key. That value is writable through this module (divergence 14) and reachable in
//     the schema. Covered now, in both directions.
//   * `positive(null)` in the renderer. The conclusion held; the MECHANISM I gave did not.
//     `formatDaemonStatus` has no early return — the call is skipped by `||` short-circuiting.
//     And `DaemonStatusView` is exported, so a caller can hand it `available: true` with null
//     counts even though `daemonStatus()` cannot.
//
// Both reviewers' probes are folded in, and the gaps they exposed are closed with cases rather
// than with prose: the `<=` boundary of the due predicate at exactly `asOf`; the ADDRESSES side
// of the combined availability record (its domains twin was covered and its own was not, so a
// truncated address enumeration would have printed bare integers — divergence 1, reintroduced);
// the `enumeration_cap_exceeded` / `enumeration_unstable` CODE rather than the prose tail both
// arms share; each of the four post-write re-assertion conjuncts separately; the non-capability
// refusal path; the empty-string `nameservers_json`; the identity half of the address guard;
// and the absence of the drain guidance when the queue really is empty.
//
// ONE SURVIVOR REMAINS, and it is a genuine equivalence rather than a gap: the defensive copies
// (`[...input.nameservers]` on the write, `[...decoded]` on the read). Both stores serialise
// immediately, so no caller can observe the aliasing either copy prevents. They stay because
// handing a caller's array to a store, or a store's array to a caller, is a hazard the next
// change should not have to rediscover.
//
// `recordProvisioningEvent` RETURNS THE STORED ROW, not the caller's input. Both deleted arms
// returned an object they built themselves from the arguments they were handed, so a store
// that persisted something else was never contradicted. The identity and the timestamp now
// come from the store because only the store can mint them, and the four caller-supplied
// fields are re-asserted against what came back. `detail` is NOT re-asserted: it round-trips
// through `jsonb` on one store, which does not preserve key order, so a strict comparison
// would fail on a write that succeeded.

import { now } from "./runtime.js";
import type { AddressState, DomainState } from "../lib/provision/state-machine.js";
import { enumerateStoreRows } from "../lib/status-facts-enumeration.js";
import {
  statusAvailable,
  statusUnavailable,
  type StatusAvailability,
} from "../lib/status-availability.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome, Refusal } from "../store/outcome.js";
import type { AddressRecord, DomainRecord, ResourceRow } from "../store/records.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Terminal states never re-enter the daemon queue.
 *
 * Both deleted arms declared this list, identically, and the SQLite arm ALSO hard-coded the
 * same three states as a SQL literal beside it. The queue predicate below is derived from
 * this constant so the two cannot drift.
 */
export const TERMINAL_STATES = ["ready", "failed", "none"] as const;

const TERMINAL_SET: ReadonlySet<string> = new Set<string>(TERMINAL_STATES);

/**
 * Persisted provisioning status. The canonical state names come from the
 * state machine (src/lib/provision/state-machine.ts); `none` is the
 * not-yet-started default for rows that were never enrolled in provisioning.
 */
export type DomainProvisioningStatus = DomainState | "none";

export type AddressProvisioningStatus = AddressState | "none";

export type ReceiveStrategy = "ses-s3" | "cf-routing" | "resend-webhook";

export interface DomainProvisioning {
  provisioning_status: DomainProvisioningStatus;
  purchase_provider: string | null;
  dns_provider: string;
  send_provider: string | null;
  cf_zone_id: string | null;
  registrar: string | null;
  nameservers: string[];
  mail_from_domain: string | null;
  last_error: string | null;
  next_check_at: string | null;
}

export interface DomainProvisioningInput {
  provisioning_status?: DomainProvisioningStatus;
  purchase_provider?: string | null;
  dns_provider?: string;
  send_provider?: string | null;
  cf_zone_id?: string | null;
  registrar?: string | null;
  nameservers?: string[];
  mail_from_domain?: string | null;
  last_error?: string | null;
  next_check_at?: string | null;
}

export interface AddressProvisioning {
  domain_id: string | null;
  receive_strategy: ReceiveStrategy | null;
  forward_to: string | null;
  routing_rule_id: string | null;
  provisioning_status: AddressProvisioningStatus;
  last_validated_at: string | null;
  last_error: string | null;
  next_check_at: string | null;
}

export interface AddressProvisioningInput {
  domain_id?: string | null;
  receive_strategy?: ReceiveStrategy | null;
  forward_to?: string | null;
  routing_rule_id?: string | null;
  provisioning_status?: AddressProvisioningStatus;
  last_validated_at?: string | null;
  last_error?: string | null;
  next_check_at?: string | null;
}

export interface ProvisioningEvent {
  id: string;
  entity_type: "domain" | "address";
  entity_id: string;
  from_state: string | null;
  to_state: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface AddressProvisioningByDomain {
  id: string;
  email: string;
  provisioning: AddressProvisioning;
}

/**
 * The daemon queue, as four counts that may be BOUNDS and an availability record that says
 * which.
 *
 * The four fields were plain `number`s taken from SQL `COUNT(*)`s. The seam has no count
 * operation, so they come from a bounded enumeration now and each is `number | null`:
 * `null` when the read did not happen at all, a LOWER BOUND when it happened but could not
 * reach the end of the table. `availability` carries which of those it is, in the same shape
 * `emails status` publishes, so `renderStatusCount` prints `≥N` or `unavailable` rather than
 * a confident integer. See the aggregates note in the module header.
 */
export interface ProvisioningWorkSummary {
  due_domains: number | null;
  due_addresses: number | null;
  failed_domains: number | null;
  failed_addresses: number | null;
  availability: StatusAvailability;
}

// ─── Enumeration budgets ────────────────────────────────────────────────────

/**
 * Pages one domain or address enumeration may fetch, at 500 rows a page — about 99,800 rows
 * (every page after the first re-requests the row it ended on).
 *
 * Far above the shared default of 40 pages because these reads must see the WHOLE table to
 * be correct: a due-work queue that stops early hides work, and a `ready` count that stops
 * early is a wrong readiness verdict. Running out is reported, never returned as a smaller
 * answer.
 */
const MAX_REGISTRY_PAGES = 200;

/**
 * Pages one provisioning-event enumeration may fetch.
 *
 * The event log is APPEND-ONLY and grows without bound, and the seam admits no filter on it
 * (see the widening described in the module header), so this is the read most likely to run
 * out. It gets the same budget rather than a larger one because 200 sequential requests
 * against an API store is already the point at which refusing beats continuing, and because
 * a bigger number would only move the cliff rather than remove it. The fix is the filter
 * push-down, and the refusal below names it.
 */
const MAX_EVENT_PAGES = 200;

// ─── Refusals, faults and the store handle ──────────────────────────────────

/**
 * The refusal, thrown.
 *
 * Names the OPERATION and carries the store's own code, status and message. It names no
 * setting and no command: a refusal that tells the caller which variable to flip is a refusal
 * documenting its own bypass.
 */
function storeRefusal(what: string, refusal: Refusal): Error {
  return new Error(
    `This installation's store cannot ${what} (${refusal.code}, ${refusal.status}): ${refusal.message}`,
  );
}

/**
 * The store this call should use: the injected one, or the configured one.
 *
 * Built per call rather than at module load, because a contradictory storage configuration is
 * a boot error raised by the resolution and it belongs to the call that needed a store, not to
 * whoever imported this module first.
 */
function storeFor(store: EmailStore | undefined): EmailStore {
  return store ?? createConfiguredEmailStore();
}

/** The unique, trimmed, non-empty ids of an argument that may repeat or hold blanks. */
function idSet(ids: Iterable<string>): Set<string> {
  return new Set([...ids].map((id) => id.trim()).filter(Boolean));
}

/** Code-unit order, not `localeCompare`. Divergence 4. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── Reading a store row ────────────────────────────────────────────────────

function rowText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * A provisioning column that is present and may be null.
 *
 * Nullability is the column's own: `purchase_provider`, `send_provider`, `cf_zone_id`,
 * `registrar`, `mail_from_domain`, `last_error`, `next_check_at`, `domain_id`,
 * `receive_strategy`, `forward_to`, `routing_rule_id` and `last_validated_at` are all
 * nullable in both schemas, and null means "not set". Absence is handled once, by the group
 * marker below, rather than eleven times here.
 */
function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * The provisioning column group is either projected or it is not, and this is where that is
 * decided — once, on the one column both schemas declare `NOT NULL DEFAULT 'none'`.
 *
 * A record with NO `provisioning_status` key is a store that did not project the provisioning
 * columns at all; reporting every row in it as `none`/`null` would report a fully provisioned
 * installation as an unprovisioned one. An EMPTY value is different and is `none`: that is
 * the column default and what the deleted HTTP arm answered (divergence 11).
 */
function provisioningStatusOf(row: Record<string, unknown>, kind: string, id: string): string {
  if (!Object.hasOwn(row, "provisioning_status")) {
    throw new Error(
      `This installation's store returned ${kind} ${id || "(no id)"} with no provisioning_status `
        + "column at all, so its provisioning columns were not projected; refusing to report it "
        + "as unprovisioned",
    );
  }
  return rowText(row["provisioning_status"]) || "none";
}

/**
 * `nameservers`, in whichever of the two shapes a store hands them back — and a FAULT for
 * anything else.
 *
 * Divergence 7. The seam declares `nameservers_json?: string[]` and the SQLite store maps the
 * column into one; a store that hands back the raw JSON text is still accepted, because that
 * is the column's storage shape and the deleted HTTP arm accepted it. What is NOT accepted is
 * unparseable content or an element that is not a string: the SQLite arm answered `[]` for
 * both, which reports a domain whose nameserver list cannot be read as a domain with no
 * nameservers.
 *
 * ABSENT IS `[]`, which both arms agreed on and which the column's `NOT NULL DEFAULT '[]'`
 * makes true: the group marker above has already established that the provisioning columns
 * were projected.
 */
function nameserversOf(value: unknown, id: string): string[] {
  if (value === null || value === undefined) return [];
  let decoded: unknown = value;
  if (typeof value === "string") {
    if (value.trim() === "") return [];
    try {
      decoded = JSON.parse(value);
    } catch {
      throw new Error(
        `Domain ${id || "(no id)"} has a nameservers_json column that is not JSON; refusing to `
          + "report it as a domain with no nameservers",
      );
    }
  }
  if (!Array.isArray(decoded)) {
    throw new Error(
      `Domain ${id || "(no id)"} has a nameservers_json column that is not an array; refusing to `
        + "report it as a domain with no nameservers",
    );
  }
  if (!decoded.every((item): item is string => typeof item === "string")) {
    throw new Error(
      `Domain ${id || "(no id)"} has a nameservers_json entry that is not a string; refusing to `
        + "report a nameserver list this store cannot read",
    );
  }
  return [...decoded];
}

/**
 * `dns_provider`: PRESENT, possibly EMPTY.
 *
 * The column is `NOT NULL DEFAULT 'cloudflare'`, so a null is a store that answered with
 * something that is not a domain row. An empty string is a VALUE — `setDomainProvisioning`
 * accepts one, and a value this module can write and then refuse to read back is a row it has
 * bricked.
 */
function dnsProviderOf(row: Record<string, unknown>, id: string): string {
  const value = row["dns_provider"];
  if (value === null || value === undefined) {
    throw new Error(
      `Domain ${id || "(no id)"} has a null dns_provider, which neither schema admits; refusing `
        + "to report it as a domain with no DNS provider",
    );
  }
  return String(value);
}

function domainProvisioningOf(record: DomainRecord): DomainProvisioning {
  const row = record as unknown as Record<string, unknown>;
  const id = record.id;
  return {
    provisioning_status: provisioningStatusOf(row, "domain", id) as DomainProvisioningStatus,
    purchase_provider: nullableText(row["purchase_provider"]),
    dns_provider: dnsProviderOf(row, id),
    send_provider: nullableText(row["send_provider"]),
    cf_zone_id: nullableText(row["cf_zone_id"]),
    registrar: nullableText(row["registrar"]),
    nameservers: nameserversOf(row["nameservers_json"], id),
    mail_from_domain: nullableText(row["mail_from_domain"]),
    last_error: nullableText(row["last_error"]),
    next_check_at: nullableText(row["next_check_at"]),
  };
}

function addressProvisioningOf(record: AddressRecord): AddressProvisioning {
  const row = record as unknown as Record<string, unknown>;
  return {
    domain_id: nullableText(row["domain_id"]),
    // Divergence 13: cast, not validated, in both arms and still.
    receive_strategy: nullableText(row["receive_strategy"]) as ReceiveStrategy | null,
    forward_to: nullableText(row["forward_to"]),
    routing_rule_id: nullableText(row["routing_rule_id"]),
    provisioning_status: provisioningStatusOf(row, "address", record.id) as AddressProvisioningStatus,
    last_validated_at: nullableText(row["last_validated_at"]),
    last_error: nullableText(row["last_error"]),
    next_check_at: nullableText(row["next_check_at"]),
  };
}

/**
 * An address, with the identity and mailbox its per-domain listing publishes.
 *
 * `id` and `email` are `NOT NULL` in both schemas and required by the seam's own record
 * shape, so an empty one is a store answering with something that is not an address.
 */
function addressByDomainOf(record: AddressRecord): AddressProvisioningByDomain {
  if (!record.id || !record.email) {
    throw new Error(
      `This installation's store returned an address with no readable ${record.id ? "email" : "id"}; `
        + "refusing to list it against a domain",
    );
  }
  return { id: record.id, email: record.email, provisioning: addressProvisioningOf(record) };
}

// ─── Enumerating the registry ───────────────────────────────────────────────

/**
 * Every domain or address the store holds, or an explanation of why not.
 *
 * PAGED TO AN EMPTY PAGE, never to a short one, because a clamped page is
 * byte-for-byte indistinguishable from the last page of a small table — the assumption that
 * produced divergence 1. `src/lib/status-facts-enumeration.ts` carries the accounting,
 * including the anchor row that catches a window moving under paging in both directions.
 */
async function readDomains(store: EmailStore, what: string): Promise<DomainRecord[]> {
  const enumeration = await enumerateStoreRows<DomainRecord>(
    (opts) => store.domains.listDomains(opts),
    { pageBudget: MAX_REGISTRY_PAGES, idOf: (row) => row.id || null },
  );
  requireWholeTable(enumeration, what, "domains");
  return enumeration.rows;
}

async function readAddresses(store: EmailStore, what: string): Promise<AddressRecord[]> {
  const enumeration = await enumerateStoreRows<AddressRecord>(
    (opts) => store.addresses.listAddresses(opts),
    { pageBudget: MAX_REGISTRY_PAGES, idOf: (row) => row.id || null },
  );
  requireWholeTable(enumeration, what, "addresses");
  return enumeration.rows;
}

interface EnumerationOutcome {
  refusal: Refusal | null;
  fault: string | null;
  complete: boolean;
  pages: number;
  duplicates: number;
  shifted: boolean;
}

/**
 * Turn anything short of a complete read into a throw.
 *
 * Three distinct reasons, kept apart because they mean different things to whoever sees them:
 * the store said no, the read threw, or the read happened and could not reach the end. None
 * of them is an empty result.
 */
function requireWholeTable(enumeration: EnumerationOutcome, what: string, family: string): void {
  if (enumeration.refusal) throw storeRefusal(what, enumeration.refusal);
  if (enumeration.fault !== null) {
    throw new Error(`This installation's store faulted while it ${what}: ${enumeration.fault}`);
  }
  if (!enumeration.complete) {
    throw new Error(
      `This installation's ${family} could not be read to the end (pages: ${enumeration.pages}, `
        + `duplicates: ${enumeration.duplicates}, shifted: ${enumeration.shifted}), so they cannot `
        + "be counted or ordered; refusing to answer from part of the table",
    );
  }
}

// ─── Domain provisioning ────────────────────────────────────────────────────

export async function getDomainProvisioning(
  id: string,
  store?: EmailStore,
): Promise<DomainProvisioning | null> {
  const outcome = await storeFor(store).domains.getDomain(id);
  if (!outcome.ok) throw storeRefusal("read a domain's provisioning state", outcome);
  return outcome.value === null ? null : domainProvisioningOf(outcome.value);
}

export async function listDomainProvisioningById(
  store?: EmailStore,
): Promise<Map<string, DomainProvisioning>> {
  const rows = await readDomains(storeFor(store), "list every domain's provisioning state");
  return new Map(rows.map((row) => [row.id, domainProvisioningOf(row)]));
}

/**
 * The provisioning state of each named domain, keyed by id.
 *
 * ENUMERATED RATHER THAN READ ID BY ID, and the choice is worth stating because the seam
 * offers both. `getDomain(id)` is a point read, but there is no BATCH point read, so
 * answering a 50-id question that way is 50 round trips whose failure modes differ per id;
 * enumerating the table is two against the largest installation recorded here. The cost is
 * the other way round for a one-id call, and that is accepted for one rule instead of a
 * size heuristic.
 *
 * AN ID THAT RESOLVES TO NO ROW IS ABSENT FROM THE MAP — divergence 10, preserved because
 * both arms did it. It is only safe because the enumeration above either saw the whole table
 * or threw.
 */
export async function listDomainProvisioningByIds(
  domainIds: Iterable<string>,
  store?: EmailStore,
): Promise<Map<string, DomainProvisioning>> {
  const ids = idSet(domainIds);
  if (ids.size === 0) return new Map();
  const rows = await readDomains(storeFor(store), "read the named domains' provisioning state");
  return new Map(
    rows.filter((row) => ids.has(row.id)).map((row) => [row.id, domainProvisioningOf(row)]),
  );
}

/**
 * Write the named provisioning columns of a domain and answer the row as it now stands.
 *
 * `null` means the domain does not exist (divergence 9). `nameservers` goes down as an ARRAY
 * (divergence 2) and `updated_at` is not sent at all (divergence 3) — both stores stamp it.
 */
export async function setDomainProvisioning(
  id: string,
  input: DomainProvisioningInput,
  store?: EmailStore,
): Promise<DomainProvisioning | null> {
  const patch: {
    provisioning_status?: string;
    purchase_provider?: string | null;
    dns_provider?: string;
    send_provider?: string | null;
    cf_zone_id?: string | null;
    registrar?: string | null;
    nameservers_json?: string[];
    mail_from_domain?: string | null;
    last_error?: string | null;
    next_check_at?: string | null;
  } = {};
  if (input.provisioning_status !== undefined) patch.provisioning_status = input.provisioning_status;
  if (input.purchase_provider !== undefined) patch.purchase_provider = input.purchase_provider;
  if (input.dns_provider !== undefined) patch.dns_provider = input.dns_provider;
  if (input.send_provider !== undefined) patch.send_provider = input.send_provider;
  if (input.cf_zone_id !== undefined) patch.cf_zone_id = input.cf_zone_id;
  if (input.registrar !== undefined) patch.registrar = input.registrar;
  if (input.nameservers !== undefined) patch.nameservers_json = [...input.nameservers];
  if (input.mail_from_domain !== undefined) patch.mail_from_domain = input.mail_from_domain;
  if (input.last_error !== undefined) patch.last_error = input.last_error;
  if (input.next_check_at !== undefined) patch.next_check_at = input.next_check_at;

  const outcome = await storeFor(store).provisioning.applyDomainProvisioning(id, patch);
  if (!outcome.ok) throw storeRefusal("write a domain's provisioning state", outcome);
  return outcome.value === null ? null : domainProvisioningOf(outcome.value);
}

// ─── Address provisioning ───────────────────────────────────────────────────

export async function getAddressProvisioning(
  id: string,
  store?: EmailStore,
): Promise<AddressProvisioning | null> {
  const outcome = await storeFor(store).addresses.getAddress(id);
  if (!outcome.ok) throw storeRefusal("read an address's provisioning state", outcome);
  return outcome.value === null ? null : addressProvisioningOf(outcome.value);
}

export async function listAddressProvisioningById(
  store?: EmailStore,
): Promise<Map<string, AddressProvisioning>> {
  const rows = await readAddresses(storeFor(store), "list every address's provisioning state");
  return new Map(rows.map((row) => [row.id, addressProvisioningOf(row)]));
}

/** See `listDomainProvisioningByIds` for why this enumerates and what an unresolved id means. */
export async function listAddressProvisioningByIds(
  addressIds: Iterable<string>,
  store?: EmailStore,
): Promise<Map<string, AddressProvisioning>> {
  const ids = idSet(addressIds);
  if (ids.size === 0) return new Map();
  const rows = await readAddresses(storeFor(store), "read the named addresses' provisioning state");
  return new Map(
    rows.filter((row) => ids.has(row.id)).map((row) => [row.id, addressProvisioningOf(row)]),
  );
}

/**
 * Newest first, with the identity as the tiebreaker.
 *
 * `created_at DESC` is what both arms published; the `id DESC` tiebreaker is new (divergence
 * 5) and matches the direction the seam's own `listAddresses` uses on the SQLite store. The
 * comparison is code-unit rather than `localeCompare` (divergence 4).
 */
function byNewestFirst(a: AddressRecord, b: AddressRecord): number {
  return compareText(b.created_at, a.created_at) || compareText(b.id, a.id);
}

/**
 * The address's owning domain, read WITHOUT mapping the rest of the row.
 *
 * Deliberately cheaper than a full map: an address that belongs to no domain, or to a domain
 * this call was not asked about, is skipped before anything else about it is validated. A row
 * that would fault must not fault a read it is not part of the answer to.
 */
function domainIdOf(record: AddressRecord): string | null {
  return nullableText((record as unknown as Record<string, unknown>)["domain_id"]);
}

function groupByDomain(rows: AddressRecord[]): Map<string, AddressProvisioningByDomain[]> {
  const byDomain = new Map<string, AddressProvisioningByDomain[]>();
  for (const row of [...rows].sort(byNewestFirst)) {
    const domainId = domainIdOf(row);
    if (!domainId) continue;
    const items = byDomain.get(domainId) ?? [];
    items.push(addressByDomainOf(row));
    byDomain.set(domainId, items);
  }
  return byDomain;
}

export async function listAddressProvisioningByDomain(
  store?: EmailStore,
): Promise<Map<string, AddressProvisioningByDomain[]>> {
  const rows = await readAddresses(storeFor(store), "group every address by its domain");
  return groupByDomain(rows);
}

export async function listAddressProvisioningByDomains(
  domainIds: Iterable<string>,
  store?: EmailStore,
): Promise<Map<string, AddressProvisioningByDomain[]>> {
  const ids = idSet(domainIds);
  if (ids.size === 0) return new Map();
  const rows = await readAddresses(storeFor(store), "group the named domains' addresses");
  return groupByDomain(rows.filter((row) => {
    const owning = domainIdOf(row);
    return owning !== null && ids.has(owning);
  }));
}

export async function listAddressProvisioningForDomain(
  domainId: string,
  store?: EmailStore,
): Promise<AddressProvisioningByDomain[]> {
  // AN EMPTY ARGUMENT NAMES NO DOMAIN, and neither does an empty column (divergence 14). Both
  // halves are needed for the four per-domain reads to agree: `groupByDomain` skips a row whose
  // owner is `''`, `idSet` drops a blank id before `listAddressProvisioningByDomains` can ask
  // about one — and this read used a bare `===`, so `listAddressProvisioningForDomain("")`
  // returned exactly the rows the other three had already decided were unowned. The
  // inconsistency was caught by the case written to pin the rule, which is the only reason it
  // is not still here.
  const wanted = domainId.trim();
  if (!wanted) return [];
  const rows = await readAddresses(storeFor(store), "list one domain's addresses");
  return [...rows]
    .filter((row) => {
      const owning = domainIdOf(row);
      return owning !== null && owning !== "" && owning === wanted;
    })
    .sort(byNewestFirst)
    .map(addressByDomainOf);
}

// ─── Ready-address counts ───────────────────────────────────────────────────

const READY = "ready";

/**
 * Whether an address row counts as a ready address of some domain.
 *
 * Both arms tested `domain_id IS NOT NULL AND provisioning_status = 'ready'` — the SQLite arm
 * in SQL, the HTTP arm per row over its one clamped page.
 */
function readyDomainIdOf(record: AddressRecord): string | null {
  const provisioning = addressProvisioningOf(record);
  if (!provisioning.domain_id) return null;
  return provisioning.provisioning_status === READY ? provisioning.domain_id : null;
}

function tallyReady(rows: AddressRecord[], ids: ReadonlySet<string> | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const domainId = readyDomainIdOf(row);
    if (domainId === null) continue;
    if (ids !== null && !ids.has(domainId)) continue;
    counts.set(domainId, (counts.get(domainId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Ready addresses per domain.
 *
 * A `Map<string, number>` has nowhere to record that a number is a bound, and every consumer
 * reads it as `counts.get(id) ?? 0` on the way to a readiness verdict — so a truncated read
 * would publish "0 ready addresses" for a domain the enumeration never reached. It refuses
 * instead. See the aggregates note in the module header.
 */
export async function listReadyAddressCountsByDomain(store?: EmailStore): Promise<Map<string, number>> {
  const rows = await readAddresses(storeFor(store), "count every domain's ready addresses");
  return tallyReady(rows, null);
}

export async function listReadyAddressCountsByDomains(
  domainIds: Iterable<string>,
  store?: EmailStore,
): Promise<Map<string, number>> {
  const ids = idSet(domainIds);
  if (ids.size === 0) return new Map();
  const rows = await readAddresses(storeFor(store), "count the named domains' ready addresses");
  return tallyReady(rows, ids);
}

/** One domain's ready addresses. Refuses rather than returning a bound; see the header. */
export async function countReadyAddressesForDomain(
  domainId: string,
  store?: EmailStore,
): Promise<number> {
  const rows = await readAddresses(storeFor(store), "count one domain's ready addresses");
  return rows.filter((row) => readyDomainIdOf(row) === domainId).length;
}

// ─── Writing address provisioning ───────────────────────────────────────────

/**
 * Write the named provisioning columns of an address and answer the row as it now stands.
 *
 * An EMPTY patch no longer bumps `updated_at`; see the module header. `null` means the
 * address does not exist.
 */
export async function setAddressProvisioning(
  id: string,
  input: AddressProvisioningInput,
  store?: EmailStore,
): Promise<AddressProvisioning | null> {
  const patch: {
    domain_id?: string | null;
    receive_strategy?: string | null;
    forward_to?: string | null;
    routing_rule_id?: string | null;
    provisioning_status?: string;
    last_validated_at?: string | null;
    last_error?: string | null;
    next_check_at?: string | null;
  } = {};
  if (input.domain_id !== undefined) patch.domain_id = input.domain_id;
  if (input.receive_strategy !== undefined) patch.receive_strategy = input.receive_strategy;
  if (input.forward_to !== undefined) patch.forward_to = input.forward_to;
  if (input.routing_rule_id !== undefined) patch.routing_rule_id = input.routing_rule_id;
  if (input.provisioning_status !== undefined) patch.provisioning_status = input.provisioning_status;
  if (input.last_validated_at !== undefined) patch.last_validated_at = input.last_validated_at;
  if (input.last_error !== undefined) patch.last_error = input.last_error;
  if (input.next_check_at !== undefined) patch.next_check_at = input.next_check_at;

  const outcome = await storeFor(store).provisioning.applyAddressProvisioning(id, patch);
  if (!outcome.ok) throw storeRefusal("write an address's provisioning state", outcome);
  return outcome.value === null ? null : addressProvisioningOf(outcome.value);
}

// ─── Audit trail ────────────────────────────────────────────────────────────

const ENTITY_TYPES: ReadonlySet<string> = new Set(["domain", "address"]);

/** A required text column of an event row, or a fault. Divergence 8. */
function requiredEventText(row: ResourceRow, column: string): string {
  const text = rowText(row[column]);
  if (!text) {
    throw new Error(
      `Provisioning event ${rowText(row["id"]) || "(no id)"} has no readable ${column}; refusing `
        + "to report it as a state transition",
    );
  }
  return text;
}

/**
 * The event's detail map.
 *
 * Two storage shapes: SQLite holds the JSON text, the service holds `jsonb` and hands back a
 * parsed object. Both are accepted. Unparseable content and a non-object become `{}`, which
 * is what BOTH deleted arms did (`parseJsonObject` locally, `cobj` remotely) and what the
 * column's `NOT NULL DEFAULT '{}'` means; the detail is diagnostic annotation on a transition
 * that is fully described by its two state columns, so it is the one field here that is not
 * worth failing a read over.
 */
function eventDetailOf(row: ResourceRow): Record<string, unknown> {
  // `??`, not a presence test. The deleted HTTP arm read `row["detail"] ?? row["detail_json"]`,
  // so a row carrying a NULL `detail` alongside a populated `detail_json` fell through to the
  // stored column. A presence test does not: it would take the null and answer `{}`, dropping a
  // detail map that is right there in the row.
  const value = row["detail"] ?? row["detail_json"];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function toProvisioningEvent(row: ResourceRow): ProvisioningEvent {
  const entityType = requiredEventText(row, "entity_type");
  if (!ENTITY_TYPES.has(entityType)) {
    throw new Error(
      `Provisioning event ${rowText(row["id"]) || "(no id)"} names entity_type ${entityType}, which `
        + "is neither a domain nor an address; refusing to report it against either",
    );
  }
  return {
    id: requiredEventText(row, "id"),
    entity_type: entityType as "domain" | "address",
    entity_id: requiredEventText(row, "entity_id"),
    from_state: nullableText(row["from_state"]),
    to_state: requiredEventText(row, "to_state"),
    detail: eventDetailOf(row),
    created_at: requiredEventText(row, "created_at"),
  };
}

/**
 * Append one state transition to the audit trail and answer the row that was stored.
 *
 * NEITHER `id` NOR `created_at` IS SENT (divergence 3): `/v1/provisioning` has no such
 * writable column and its request schema is closed, so naming them makes the HTTP store
 * refuse the write outright. Both stores mint the identity and stamp the timestamp, and both
 * echo the stored row, which is what comes back.
 *
 * THE FOUR CALLER-SUPPLIED FIELDS ARE RE-ASSERTED against what was stored, because a store
 * that persisted a different transition than the one it was asked for has written the wrong
 * history and the caller has no other way to find out. `detail` is deliberately excluded from
 * that check — it round-trips through `jsonb` on one store, which does not preserve key
 * order.
 */
export async function recordProvisioningEvent(
  entity_type: "domain" | "address",
  entity_id: string,
  from_state: string | null,
  to_state: string,
  detail: Record<string, unknown> = {},
  store?: EmailStore,
): Promise<ProvisioningEvent> {
  // VALIDATED BEFORE THE WRITE, not after. `to_state` and `entity_id` are `TEXT NOT NULL` in
  // both schemas and an EMPTY string satisfies that, so a blank one used to be committed and
  // then rejected by this module's own reader — a row written successfully, reported as a
  // failure, and thereafter poisoning `listProvisioningEvents` for that entity forever. That
  // is the accept-on-write / refuse-on-read shape, and the fix belongs on this side of the
  // store call. Adversarial review found it.
  if (!entity_id.trim()) {
    throw new Error("A provisioning event needs the id of the domain or address it describes.");
  }
  if (!to_state.trim()) {
    throw new Error("A provisioning event needs a to_state; refusing to record a transition to nothing.");
  }
  const outcome = await storeFor(store).provisioning.recordProvisioningEvent({
    entity_type,
    entity_id,
    from_state,
    to_state,
    detail_json: detail,
  });
  if (!outcome.ok) throw storeRefusal("record a provisioning event", outcome);
  const event = toProvisioningEvent(outcome.value);
  if (
    event.entity_type !== entity_type
    || event.entity_id !== entity_id
    || event.from_state !== from_state
    || event.to_state !== to_state
  ) {
    throw new Error(
      `This installation's store recorded a different provisioning event than the one it was `
        + `asked for (asked: ${entity_type} ${entity_id} ${String(from_state)} -> ${to_state}; `
        + `stored: ${event.entity_type} ${event.entity_id} ${String(event.from_state)} -> `
        + `${event.to_state}); refusing to report the transition as written`,
    );
  }
  return event;
}

/**
 * One entity's transitions, oldest first.
 *
 * A FULL SCAN OF AN APPEND-ONLY TABLE, because `ProvisioningRepository.listProvisioningEvents`
 * takes a bare `ListOptions` and admits no filter — see the widening described in the module
 * header. Both stores and the service already support the `entity_type` / `entity_id` filters
 * this read needs; only the seam signature does not expose them.
 *
 * OLDEST FIRST is what both arms published, and neither store serves it: the SQLite resource
 * path orders this table `created_at DESC, id DESC` and the service's spec orders it
 * `created_at ASC` (divergence 6). The `id` tiebreaker is new (divergence 5) — the SQLite arm
 * used `rowid`, which no store projects, and the HTTP arm had none at all.
 */
export async function listProvisioningEvents(
  entity_type: "domain" | "address",
  entity_id: string,
  store?: EmailStore,
): Promise<ProvisioningEvent[]> {
  const what = "read one entity's provisioning events";
  // Resolved ONCE, outside the pager: building a store per page would open a new handle (or a
  // new HTTP client, re-reading the service contract) for every 500 rows.
  const resolved = storeFor(store);
  const enumeration = await enumerateStoreRows<ResourceRow>(
    (opts) => resolved.provisioning.listProvisioningEvents(opts),
    {
      pageBudget: MAX_EVENT_PAGES,
      idOf: (row) => (typeof row["id"] === "string" ? row["id"] : null),
    },
  );
  if (enumeration.refusal) throw storeRefusal(what, enumeration.refusal);
  if (enumeration.fault !== null) {
    throw new Error(`This installation's store faulted while it ${what}: ${enumeration.fault}`);
  }
  if (!enumeration.complete) {
    throw new Error(
      `This installation's provisioning events could not be read to the end (pages: `
        + `${enumeration.pages}, duplicates: ${enumeration.duplicates}, shifted: `
        + `${enumeration.shifted}); this read has to scan the whole append-only log because the `
        + "store seam admits no entity filter on it, so it refuses rather than reporting part of "
        + "an entity's history as all of it",
    );
  }
  // FILTERED BEFORE MAPPED. The log holds every entity's transitions, and mapping validates
  // six columns — so mapping first would let ONE unreadable row belonging to some OTHER domain
  // fault a read it is not part of the answer to, and one such row would make every entity's
  // history unreadable. The two columns the filter needs are read off the raw row.
  return enumeration.rows
    .filter((row) => rowText(row["entity_type"]) === entity_type && rowText(row["entity_id"]) === entity_id)
    .map(toProvisioningEvent)
    .sort((a, b) => compareText(a.created_at, b.created_at) || compareText(a.id, b.id));
}

// ─── Daemon queue ───────────────────────────────────────────────────────────

/** A row's due-work facts, read once and reused by the queue and the summary. */
interface DueRow {
  id: string;
  status: string;
  next: string | null;
}

/**
 * The two columns the queue asks about, and NOT the rest of the row.
 *
 * A domain whose `nameservers_json` cannot be read is still a domain whose next check is due,
 * and refusing to schedule it because of a column the queue never looks at would let one
 * malformed row stop the whole daemon. The group marker still applies: a store that projected
 * no provisioning columns cannot be asked which rows are due.
 */
function dueRowOf(record: { id: string }, kind: "domain" | "address"): DueRow {
  const row = record as unknown as Record<string, unknown>;
  return {
    id: record.id,
    status: provisioningStatusOf(row, kind, record.id),
    next: nullableText(row["next_check_at"]),
  };
}

/**
 * Due now: a non-terminal row with a check time that has arrived.
 *
 * Both arms agreed on the predicate. The SQLite arm spelled the terminal set a second time as
 * a SQL literal; this derives it from `TERMINAL_STATES` so the exported constant and the
 * filter cannot disagree (divergence 12).
 */
function isDue(row: DueRow, asOf: string): boolean {
  return !TERMINAL_SET.has(row.status) && row.next !== null && row.next <= asOf;
}

/**
 * The domains whose next check has arrived, soonest first.
 *
 * NOTHING IS CLAIMED. Despite the name, neither deleted arm wrote anything: the SQLite arm was
 * a `SELECT id`, the HTTP arm a list-and-filter. There is no read-then-write here, so there is
 * no race to lose and no atomic claim for the seam to be unable to express. A caller that
 * wants exclusive ownership of a row still has to take it, and nothing in this repository
 * does — no provisioning reconciler ships in this build.
 */
export async function claimDueDomains(
  asOf?: string,
  store?: EmailStore,
): Promise<{ id: string }[]> {
  const ts = asOf || now();
  const rows = await readDomains(storeFor(store), "list the domains whose next check is due");
  return dueQueue(rows.map((row) => dueRowOf(row, "domain")), ts);
}

/** The addresses whose next check has arrived, soonest first. See `claimDueDomains`. */
export async function claimDueAddresses(
  asOf?: string,
  store?: EmailStore,
): Promise<{ id: string }[]> {
  const ts = asOf || now();
  const rows = await readAddresses(storeFor(store), "list the addresses whose next check is due");
  return dueQueue(rows.map((row) => dueRowOf(row, "address")), ts);
}

/**
 * Soonest check first, with the identity as the tiebreaker.
 *
 * `next_check_at ASC` is what both arms published. Neither had a tiebreaker, and rows
 * scheduled in one pass share a millisecond, so the order of a batch was arbitrary
 * (divergence 5). The comparison is code-unit rather than `localeCompare` (divergence 4).
 */
function dueQueue(rows: DueRow[], asOf: string): { id: string }[] {
  return rows
    .filter((row) => isDue(row, asOf))
    .sort((a, b) => compareText(a.next ?? "", b.next ?? "") || compareText(a.id, b.id))
    .map((row) => ({ id: row.id }));
}

/** What one side of the summary contributes: rows, or the reason there are none. */
interface DueSide {
  /** null => nothing was read. A count taken from this side would be a fabrication. */
  rows: DueRow[] | null;
  availability: StatusAvailability;
}

const QUEUE_SOURCE = "store:provisioning_queue";

/**
 * One side of the queue, as an availability record rather than a throw.
 *
 * The FOUR outcomes are kept apart, exactly as `src/lib/status-facts.ts` keeps them, because
 * they mean four different things to an operator reading `emails daemon status`:
 *
 *   capability refused   structural — this store models no such thing, and nothing the
 *                        operator does today clears it.
 *   any other refusal    a live failure on this call.
 *   fault                a live failure in transport or in a stored row.
 *   incomplete           rows WERE read; the counts are lower bounds and the renderer must
 *                        say so.
 *
 * A throw would collapse the first three into one and the fourth into nothing at all, which
 * is why this is the one aggregate that does not reuse `requireWholeTable`.
 */
async function readDueSide<TRecord extends { id: string }>(
  family: "domains" | "addresses",
  kind: "domain" | "address",
  list: (opts: { limit: number; offset: number }) => Promise<Outcome<TRecord[]>>,
): Promise<DueSide> {
  const enumeration = await enumerateStoreRows<TRecord>(list, {
    pageBudget: MAX_REGISTRY_PAGES,
    idOf: (row) => row.id || null,
  });

  if (enumeration.refusal !== null) {
    const refusal = enumeration.refusal;
    return {
      rows: null,
      availability: statusUnavailable(
        refusal.code === "capability_unavailable" ? "not_modelled_on_store" : "source_unreachable",
        `store_refusal:${refusal.code}`,
        QUEUE_SOURCE,
        `the configured store refused to list ${family}: ${refusal.message}`,
      ),
    };
  }
  if (enumeration.fault !== null) {
    return {
      rows: null,
      availability: statusUnavailable(
        "source_unreachable",
        `provisioning_queue_${family}`,
        QUEUE_SOURCE,
        `the ${family} inventory could not be read, so no queue count is reported: ${enumeration.fault}`,
      ),
    };
  }

  // Mapping happens AFTER the enumeration so a malformed row is a fault about the read
  // rather than an exception out of a status command.
  let rows: DueRow[];
  try {
    rows = enumeration.rows.map((row) => dueRowOf(row, kind));
  } catch (error) {
    return {
      rows: null,
      availability: statusUnavailable(
        "source_unreachable",
        `provisioning_queue_${family}`,
        QUEUE_SOURCE,
        `the ${family} inventory could not be read, so no queue count is reported: `
          + (error instanceof Error ? error.message : String(error)),
      ),
    };
  }

  if (!enumeration.complete) {
    const reason = enumeration.stable
      ? `enumeration_cap_exceeded:${enumeration.pages} pages — counts are lower bounds, not totals`
      : `enumeration_unstable:${enumeration.duplicates} duplicate row(s)`
        + `${enumeration.shifted ? " and a shifted window" : ""} across ${enumeration.pages} pages — `
        + "the store's list order is not total under limit/offset paging, so at least that many "
        + "rows were skipped; counts are lower bounds, not totals";
    return {
      rows,
      availability: { ...statusAvailable(QUEUE_SOURCE, "client_enumeration", false), reason },
    };
  }
  return { rows, availability: statusAvailable(QUEUE_SOURCE, "client_enumeration") };
}

/**
 * Available only when BOTH sides answered; complete only when BOTH are complete.
 *
 * One record covers four counts drawn from two independent enumerations, so it has to take
 * the worse of the two on each axis. Reporting the domains side as complete while the
 * addresses side was truncated would let a renderer print two of the four numbers without a
 * `≥` that they have not earned.
 */
function combineQueueAvailability(domains: DueSide, addresses: DueSide): StatusAvailability {
  const domainsFailed = !domains.availability.available;
  const addressesFailed = !addresses.availability.available;
  // BOTH SIDES FAILING IS ITS OWN FACT. Returning the first record would show only one of two
  // simultaneous failures — and if the domains side is a declared-false capability
  // (STRUCTURAL, nothing an operator can clear) while the addresses side is a live transport
  // fault, the outage that can be fixed is the one that disappears. `statusGapClass` reads the
  // code prefix to decide whether the installation is `degraded`, so hiding the live failure
  // behind the structural one is the "flag nobody reads" failure exactly. `readDueSide`'s own
  // note condemns collapsing these; the combiner must not reintroduce it. Adversarial review
  // caught this.
  if (domainsFailed && addressesFailed) {
    return statusUnavailable(
      "source_unreachable",
      "provisioning_queue_both",
      QUEUE_SOURCE,
      `neither side of the queue could be read — domains: ${domains.availability.reason ?? "no reason given"}`
        + ` · addresses: ${addresses.availability.reason ?? "no reason given"}`,
    );
  }
  if (domainsFailed) return domains.availability;
  if (addressesFailed) return addresses.availability;
  if (domains.availability.complete === false) return domains.availability;
  if (addresses.availability.complete === false) return addresses.availability;
  return statusAvailable(QUEUE_SOURCE, "client_enumeration");
}

/**
 * The daemon queue: due and failed work on each side.
 *
 * THE ONE AGGREGATE THAT REPORTS A BOUND INSTEAD OF REFUSING, because it is the only one
 * whose shape can carry it and the only one with a human-facing renderer. Its four counts are
 * `number | null` and `availability` says which; `src/cli/commands/daemon.local.ts` prints
 * them through `renderStatusCount`, so an incomplete read shows `≥N` and a read that did not
 * happen shows the reason rather than a zero. That is what its self-hosted sibling
 * (`daemon.remote.ts`) already does, and the defect it was written to fix — four counts taken
 * from one clamped page and printed as bare integers — is divergence 1 on this side of the
 * fence.
 */
export async function getProvisioningWorkSummary(
  asOf?: string,
  store?: EmailStore,
): Promise<ProvisioningWorkSummary> {
  const ts = asOf || now();
  const resolved = storeFor(store);
  const domains = await readDueSide<DomainRecord>("domains", "domain", (opts) =>
    resolved.domains.listDomains(opts));
  const addresses = await readDueSide<AddressRecord>("addresses", "address", (opts) =>
    resolved.addresses.listAddresses(opts));

  const availability = combineQueueAvailability(domains, addresses);
  // ONE RECORD, SO ALL FOUR NUMBERS SHARE ITS FATE. When either side could not be read the
  // record says `available: false`, and a payload that still carried the OTHER side's two real
  // integers under it would be a confident number sitting inside a declared gap — a JSON
  // consumer reading `failed_addresses: 0` has no way to see that `available` was false three
  // keys up. The renderer already prints the whole block as unavailable; this makes the payload
  // agree with it.
  const countDue = (side: DueSide): number | null =>
    !availability.available || side.rows === null ? null : side.rows.filter((row) => isDue(row, ts)).length;
  const countFailed = (side: DueSide): number | null =>
    !availability.available || side.rows === null ? null : side.rows.filter((row) => row.status === "failed").length;

  return {
    due_domains: countDue(domains),
    due_addresses: countDue(addresses),
    failed_domains: countFailed(domains),
    failed_addresses: countFailed(addresses),
    availability,
  };
}
