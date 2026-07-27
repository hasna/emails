// ONE address lifecycle. There is no arm to pick, and nothing here asks where this
// installation keeps its mail.
//
// WHAT THIS FILE USED TO BE, because the shape is the bug. `address-lifecycle.ts` was a
// 28-line facade that built a dispatch helper, read the process-wide deployment word, and
// handed each of six exports to one of two sibling modules:
//
//   * `address-lifecycle.local.ts` (153 lines) held THREE implementations, not one — a
//     local SQLite path, a second path that noticed the deployment word and wrote to the
//     operator dataset instead, and (for the two counting exports) a third that returned
//     0 without reading anything;
//   * `address-lifecycle.remote.ts` (85 lines) held a fourth: status and quota writes
//     through the operator dataset, and send accounting hard-wired to 0.
//
// Both arms are gone. This is the FIRST `src/db/*` family to be collapsed, so the shape
// below is deliberately the template: the data comes through the store seam
// (`src/store/`), the injectable is the store and not a database handle, and every fact
// this family can no longer determine is named in the value it returns rather than
// approximated by a comfortable default.
//
// ─── THE ONE THING A READER MUST KNOW ABOUT THIS FAMILY ──────────────────────────────
//
// `AddressLifecycleRepository.getAddressSendability` EXISTS on the seam and is gated on
// the `outboundPolicy` capability, which BOTH stores declare FALSE
// (src/store-sqlite/index.ts, src/store-http/index.ts; see the `outboundPolicy` entry in
// `HTTP_STORE_MISSING_ROUTES`). Delegating this family's `getAddressSendability` to that
// operation would therefore have shipped a send gate that refuses on every configuration
// this package can be run in — a 100% failure rate that no fixture with a permissive fake
// store would have caught. So sendability here is COMPOSED from the two facts the seam
// does project, and the composition is exactly the two checks the deleted local arm
// performed and no more:
//
//   1. is there a registered address row for this sender, and is it suspended?
//   2. does that row carry a daily quota, and has today's send count reached it?
//
// It is NOT a policy evaluation. Sender readiness, suppression, warming limits and
// send-key scope are what `outboundPolicy` covers and what neither store has; this
// function answers the narrower question both deleted arms actually answered, and says so.
//
// ─── WHAT IS DELIBERATELY PRESERVED, INCLUDING ONE WEAKNESS ──────────────────────────
//
// AN UNREGISTERED SENDER IS STILL REPORTED SENDABLE. Both deleted arms did that, and
// src/store/records.ts calls it out by name as the plausible-wrong-answer failure in its
// purest form ("I know nothing about this sender, go ahead"). It is kept because changing
// it here would silently deny every send from an address this installation has not
// registered, which is a product decision and not a refactor — and because the honest
// place to fix it is the `outboundPolicy` capability that would let a store answer the
// question properly. What has changed is that the answer is no longer reachable by
// accident: a store that could not be enumerated raises rather than falling through to
// this branch (see `matchingAddresses`).
//
// ─── WHAT THIS FILE CAN NO LONGER DETERMINE, STATED RATHER THAN DERIVED ──────────────
//
//  1. `provider_id`. The three write operations used to return the local entity type,
//     whose `provider_id` is a required string. `AddressRecord` — the seam's address
//     shape — HAS NO SUCH FIELD, because the strongest arm's address model has no
//     provider dimension. The deleted remote arm coped by emitting `""` for it, which is
//     a fabricated id in every CLI and MCP payload it produced. These functions return
//     `AddressRecord` instead, so the field is ABSENT rather than wrong. Callers that
//     need the provider behind an address read it from the addresses family.
//  2. An exact count of today's sends, in general. The seam has NO aggregate: `list` with
//     a limit and an offset (or a cursor) is the only read, and it is clamped at 500 rows
//     server-side. Every count below is therefore a bounded enumeration that reports a
//     LOWER BOUND when it hits its budget, and `null` — never `0` — when it could not be
//     completed at all.
//  3. Which server-side policy a send would actually meet. The service evaluates outbound
//     policy inside its own send route and exposes no probe, so a `sendable: true` here
//     means "this installation's stored suspension and quota state does not block it",
//     not "the service will accept it".
//
// ─── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────────────
//
//  1. It never asks WHICH store it holds. `src/store-resolution.ts` is explicit that
//     construction is the only place that answer is visible and that its plan union is
//     not a runtime label for callers to branch on. There is no branch here on the store
//     kind, on the descriptor, or on a capability name.
//  2. It does not reach into another family's arm. The deleted local arm imported
//     `addresses.local.ts` and the deleted remote arm imported `addresses.remote.ts` —
//     which is how a lifecycle write ends up landing in the dataset the operator did not
//     configure. Nothing here imports either; the address rows come from the seam.
//  3. It does not touch the deployment-mode axis module, the dispatch layer, the curl
//     bridge, or any mode-gated branch in another family. Those are phase 9's, and only
//     once the ratchet in src/mode-axis-ratchet.test.ts reads zero.

import { AddressNotFoundError } from "../types/index.js";
import { canonicalSender } from "../lib/email-address.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome, Refusal } from "../store/outcome.js";
import type { AddressRecord, MessageListRecord } from "../store/records.js";

/**
 * Rows requested per page.
 *
 * 500 is what the SQLite store and the service both clamp a list at, so it is the most
 * that can come back from one request. It is a REQUEST and not an assumption: the address
 * enumeration below advances by rows RECEIVED and stops only on an EMPTY page.
 */
const PAGE_SIZE = 500;

/**
 * How many pages the address lookup may cost.
 *
 * The seam has NO by-email read: `ListOptions` is `{ limit, offset }` and carries no
 * filter, so finding the row for a sender means paging the registry and matching
 * client-side. That is the same composition `HTTP_STORE_MISSING_ROUTES` already records
 * for `getDomainByName` ("O(domains) per lookup"), and it is accepted here for the same
 * reason: the alternative is asking another family's mode-routed arm, which is what the
 * deleted arms did.
 *
 * 20 pages bounds one lookup at 10,000 address rows. Past that the answer is UNKNOWN and
 * this family raises — it does not report "not registered", because "not registered" is
 * the branch that lets a send through.
 */
const MAX_ADDRESS_PAGES = 20;

/**
 * How many pages one send count may cost.
 *
 * 40 pages bounds a count at 20,000 outbound rows for a single sender for a single UTC
 * day. Past that the count is a floor, and `null` is reported rather than the floor
 * wherever a floor cannot be interpreted safely.
 */
const MAX_MESSAGE_PAGES = 40;

/**
 * The refusal, thrown.
 *
 * The message names the OPERATION and carries the store's own code, status and text. It
 * names no setting and no command: a refusal that tells the caller which variable to set
 * is a refusal documenting its own bypass.
 */
function storeRefusal(what: string, refusal: Refusal): Error {
  return new Error(
    `This installation's store cannot ${what} (${refusal.code}, ${refusal.status}): ${refusal.message}`,
  );
}

/** The store this call runs against. Built per call, so a configuration error belongs to
 * the call that needed a store rather than to whoever imported this module first. */
function storeFor(store: EmailStore | undefined): EmailStore {
  return store ?? createConfiguredEmailStore();
}

/**
 * One address, canonicalised the way this package canonicalises a sender everywhere else.
 *
 * `canonicalSender` returns null for an ambiguous or malformed value; the fallback keeps
 * the deleted arms' behaviour of comparing the trimmed lowercase text in that case, so a
 * value neither arm could parse still matches the row it used to match.
 */
function canonicalAddress(value: string): string {
  return canonicalSender(value) ?? String(value ?? "").trim().toLowerCase();
}

/** The current UTC day as `YYYY-MM-DD`. */
function utcDay(instant: Date = new Date()): string {
  return instant.toISOString().slice(0, 10);
}

/** The instant a `since` filter must use to select the whole of `day`. */
function startOfUtcDay(day: string): string {
  return `${day}T00:00:00.000Z`;
}

/**
 * When a list row happened, as a `YYYY-MM-DD` day, or null when the row carries no usable
 * stamp.
 *
 * `received_at` is the field to read and that is a finding rather than a preference: the
 * seam's list projection has NO `sent_at`, and the SQLite store maps the legacy ledger's
 * `sent_at` onto `received_at` (src/store-sqlite/messages-sql.ts) precisely so one field
 * answers "when did this row happen" for both directions. `created_at` is the fallback for
 * a row whose send instant was never stamped, which is what the local arm's
 * `COALESCE(sent_at, created_at)` sort key already assumed.
 */
function dayOf(row: MessageListRecord): string | null {
  const stamp = row.received_at ?? row.created_at;
  if (typeof stamp !== "string" || stamp.trim() === "") return null;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? utcDay(new Date(parsed)) : null;
}

/** What a bounded enumeration saw. */
interface Enumerated<TRow> {
  rows: TRow[];
  /**
   * True only when the scan reached the end of the table. For an OFFSET enumeration that
   * is an EMPTY page and nothing else — a SHORT page is a store's clamp, not end-of-table,
   * and stopping on one publishes the clamp as a complete answer.
   */
  complete: boolean;
}

/**
 * Every address row, within a budget.
 *
 * TWO RULES, each of them a bug this function would otherwise have:
 *
 *  1. ONLY AN EMPTY PAGE ENDS THE SCAN. A store may serve fewer rows than were asked for.
 *  2. THE OFFSET ADVANCES BY ROWS RECEIVED, NOT ROWS REQUESTED. Advancing by `PAGE_SIZE`
 *     after a store served 100 skips rows 100-499 and then calls the undercount exact.
 *
 * A refusal propagates: a partial enumeration is never presented as the registry.
 */
async function enumerateAddresses(store: EmailStore): Promise<Enumerated<AddressRecord>> {
  const rows: AddressRecord[] = [];
  for (let page = 0; page < MAX_ADDRESS_PAGES; page += 1) {
    const listed = await store.addresses.listAddresses({ limit: PAGE_SIZE, offset: rows.length });
    if (!listed.ok) throw storeRefusal("read this installation's sender addresses", listed);
    if (listed.value.length === 0) return { rows, complete: true };
    rows.push(...listed.value);
  }
  return { rows, complete: false };
}

/**
 * The registered rows for one sender, in the order this family resolves ties.
 *
 * THE ORDER IS AN ARM DIVERGENCE, RESOLVED RATHER THAN INHERITED. The local arm selected
 * with `ORDER BY CASE WHEN status = 'suspended' THEN 0 ELSE 1 END, created_at DESC LIMIT
 * 1` — a total order in which a suspended row always wins and the newest row wins among
 * the rest. The remote arm took the first element of whatever order the operator dataset
 * happened to return, so two installations holding the same two rows for one email could
 * disagree about whether that email may send. The local arm's order is kept: it is the
 * defined one, and it is the one that resolves a tie toward DENYING a send.
 *
 * THE MATCH IS EXACT, and that is also a finding. `ListMessagesOptions.to` and `.from` are
 * SUBSTRING matches on both stores, and a reader who inherits that looseness on an address
 * lookup matches `ceo@acme.com` against a row for `xceo@acme.com`. Address rows are not
 * filtered by the store at all here, so the exactness is this function's own job.
 *
 * A TRUNCATED ENUMERATION RAISES. "I did not find a row" and "I did not finish looking"
 * are different facts, and only one of them may reach the branch that reports a sender
 * unrestricted.
 */
async function matchingAddresses(store: EmailStore, target: string): Promise<AddressRecord[]> {
  const { rows, complete } = await enumerateAddresses(store);
  const matches = rows.filter((row) => canonicalAddress(row.email) === target);
  if (!complete && matches.length === 0) {
    throw new Error(
      `This installation's store still had sender addresses to page through after ${MAX_ADDRESS_PAGES} ` +
        "pages, so whether this sender is registered could not be determined; refusing to report it " +
        "as unrestricted",
    );
  }
  return matches.sort((left, right) => {
    const leftSuspended = left.status === "suspended" ? 0 : 1;
    const rightSuspended = right.status === "suspended" ? 0 : 1;
    if (leftSuspended !== rightSuspended) return leftSuspended - rightSuspended;
    return String(right.created_at).localeCompare(String(left.created_at));
  });
}

/** A bounded count of one sender's sends within one UTC day. */
interface SendCount {
  /** Rows counted. A LOWER BOUND unless `complete` is true. */
  count: number;
  /** True when the scan reached the end of the store's answer for this question. */
  complete: boolean;
}

/**
 * How many messages this sender sent during `day`, counted through the seam.
 *
 * WHAT THE ROW SET IS, predicate for predicate against the deleted local arm's
 * `SELECT COUNT(*) FROM emails WHERE <extracted from_address> = ? AND sent_at LIKE
 * '<day>%'`:
 *
 *   * `direction: "outbound"` is the seam's spelling of "a row this installation sent".
 *     It is BROADER than the deleted query, which read only the legacy `emails` ledger:
 *     the seam's stream unions that ledger with the outbound rows in the unified table, so
 *     a send recorded only there now counts toward the quota where before it did not. That
 *     is an under-count fixed, not a semantic changed.
 *   * `from` is passed so the store narrows the scan, and is RE-ASSERTED EXACTLY on every
 *     returned row. Both stores implement it as a substring match, so without the second
 *     check a quota for `ceo@acme.com` would be consumed by sends from `xceo@acme.com`.
 *     Passing it is an optimisation; the client-side equality is the contract.
 *   * `since` is passed for the same reason and is likewise re-asserted. `since` is a
 *     lower bound only, where `LIKE '<day>%'` bounded the day on BOTH sides, so a row
 *     stamped in the future would otherwise be counted against today.
 *   * NO FOLDER FILTER, deliberately. `InboundRepository.listInbound` defaults the folder
 *     to the inbox, whose predicate excludes archived, spam and trash — and an outbound row
 *     a user later filed or binned still consumed a send that day. The deleted ledger query
 *     had no folder awareness at all, so leaving the filter off is what preserves its row
 *     set.
 *
 * TERMINATION USES THE CURSOR, not an empty page, and the difference from
 * `enumerateAddresses` is deliberate. `Page.next_cursor` is documented on the seam as
 * "null exactly when this page is the last", and both stores derive it from their own
 * knowledge of the table rather than from the page length a caller can see. Offset paging
 * offers no such signal, which is why the address scan may only trust an empty page.
 *
 * `stopAt` short-circuits as soon as enough rows have been counted to answer a quota
 * question. The count is then a floor by construction, and `complete` says so.
 */
async function countSendsOnDay(
  store: EmailStore,
  target: string,
  day: string,
  stopAt?: number,
): Promise<SendCount> {
  let count = 0;
  let cursor: string | undefined;

  for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
    const listed = await store.messages.listMessages({
      direction: "outbound",
      from: target,
      since: startOfUtcDay(day),
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!listed.ok) throw storeRefusal("read this installation's outbound messages", listed);

    for (const row of listed.value.items) {
      if (canonicalAddress(row.from_addr) !== target) continue;
      if (dayOf(row) !== day) continue;
      count += 1;
      // Enough is enough: a quota question is answered the moment the floor reaches it.
      if (stopAt !== undefined && count >= stopAt) return { count, complete: false };
    }

    if (listed.value.next_cursor === null) return { count, complete: true };
    cursor = listed.value.next_cursor;
  }

  return { count, complete: false };
}

/**
 * Apply one lifecycle write and project its result.
 *
 * `null` from the seam means the row does not exist WITHIN THIS CALLER'S SCOPE, which is
 * what the deleted arms raised `AddressNotFoundError` for, so it is raised here too — both
 * arms checked existence with a separate read first and then wrote, which is two round
 * trips and a race; the seam's write reports it in one.
 */
async function applyWrite(
  id: string,
  what: string,
  write: (store: EmailStore) => Promise<Outcome<AddressRecord | null>>,
  store?: EmailStore,
): Promise<AddressRecord> {
  const outcome = await write(storeFor(store));
  if (!outcome.ok) throw storeRefusal(what, outcome);
  if (outcome.value === null) throw new AddressNotFoundError(id);
  return outcome.value;
}

/**
 * Suspend a sender address.
 *
 * Idempotent, on both stores and therefore here: suspending an already-suspended row
 * writes the same status again and returns the row. Neither deleted arm made it an error
 * and neither store does.
 *
 * @param store injected only by tests. There is exactly one production path, and it is
 *   `createConfiguredEmailStore()`.
 */
export async function suspendAddress(id: string, store?: EmailStore): Promise<AddressRecord> {
  return applyWrite(id, "suspend a sender address", (s) => s.addressLifecycle.suspendAddress(id), store);
}

/** Reactivate a suspended sender address. Idempotent, for the same reason as `suspendAddress`. */
export async function activateAddress(id: string, store?: EmailStore): Promise<AddressRecord> {
  return applyWrite(id, "activate a sender address", (s) => s.addressLifecycle.activateAddress(id), store);
}

/**
 * Set (or clear, with null) the per-address daily send quota.
 *
 * THE ARGUMENT CHECK STAYS ON THIS SIDE, and it is a deliberate second copy. The SQLite
 * store refuses a negative quota with `invalid_input`; the HTTP store deliberately does
 * NOT pre-validate, so that the service's rule stays the only copy of it, and relies on
 * the service answering 400. That is right for a store, and it means the ERROR AN OPERATOR
 * SEES for the same bad input differs by configuration — including the case where the
 * service is older than the rule. This is an exported function's own precondition, it is
 * strictly narrower than either store's, and checking it here makes `emails address quota
 * <id> -1` fail the same way everywhere and without a round trip. A store that refuses
 * anyway is still surfaced as its own refusal.
 */
export async function setAddressQuota(
  id: string,
  quota: number | null,
  store?: EmailStore,
): Promise<AddressRecord> {
  if (quota !== null && (!Number.isInteger(quota) || quota < 0)) {
    throw new Error(`Invalid daily quota: ${quota} (must be a non-negative integer or null)`);
  }
  return applyWrite(id, "set a sender address quota", (s) => s.addressLifecycle.setAddressQuota(id, quota), store);
}

/**
 * How many emails `email` has sent so far during the current UTC day, or `null` when the
 * store could not be enumerated to the end within the page budget.
 *
 * `number | null` AND NOT `number`, because the seam has no aggregate and the deleted arms
 * had two different lies in this position: the local arm's `COUNT(*)` was exact but read
 * only the legacy ledger, and the remote arm returned a hard-coded `0` for a question
 * about quota — a fabricated number that made every quota on an API-configured
 * installation unenforceable at the client gate. A count that did not reach the end of the
 * table is not a count, and `0` is the one value it must never be reported as.
 */
export async function countSendsToday(email: string, store?: EmailStore): Promise<number | null> {
  const target = canonicalAddress(email);
  const counted = await countSendsOnDay(storeFor(store), target, utcDay());
  return counted.complete ? counted.count : null;
}

/**
 * Today's send count for many addresses.
 *
 * ONE COUNT PER ADDRESS, where the local arm used a single `GROUP BY`. The efficiency is a
 * real loss and it is named rather than hidden: the seam has no grouped aggregate, and the
 * alternative — one unfiltered scan of the whole day bucketed client-side — is unbounded
 * in the number of senders and would report a floor for every address instead of an answer
 * for each. Deduplicated and canonicalised first, so the map is keyed the way the deleted
 * arms keyed it and a repeated address costs one scan.
 */
export async function countSendsTodayByAddress(
  emails: Iterable<string>,
  store?: EmailStore,
): Promise<Map<string, number | null>> {
  const targets = [...new Set([...emails].map(canonicalAddress).filter(Boolean))];
  const counts = new Map<string, number | null>();
  if (targets.length === 0) return counts;

  const resolved = storeFor(store);
  const day = utcDay();
  for (const target of targets) {
    const counted = await countSendsOnDay(resolved, target, day);
    counts.set(target, counted.complete ? counted.count : null);
  }
  return counts;
}

/**
 * Whether `email` may send right now, and if not, why.
 *
 * The shape follows the seam's `AddressSendability` (`sendable` / `reason` / `sent_today` /
 * `daily_quota`) rather than the deleted arms' two-field object, with one field added:
 * `sent_today_is_lower_bound`, because `sent_today` is assembled by enumeration and a
 * caller that reads it as a total will publish a store's clamp as an exact usage figure.
 */
/** One check `getAddressSendability` performs. Never the whole outbound policy. */
export type SendabilityCheck = "registration" | "suspension" | "quota";

export interface Sendability {
  sendable: boolean;
  /** Why not, or null when the sender is not blocked. */
  reason: string | null;
  /**
   * The checks that produced this answer, in the order they ran.
   *
   * Present in EVERY outcome INCLUDING a `sendable: true` one, because what this function
   * cannot determine has to be visible where the answer is and not only in a comment above
   * it. The seam's own `getAddressSendability` is gated on the `outboundPolicy` capability
   * and BOTH stores refuse it, so sender readiness, recipient suppression, warming limits
   * and send-key scope are NOT consulted here: `sendable: true` means the listed checks
   * passed and nothing more. An unregistered sender is answered by `["registration"]` alone,
   * which is the honest spelling of "nothing is known about this address".
   */
  evaluated: readonly SendabilityCheck[];
  /**
   * Today's sends. `null` when the question was not asked (no quota is set, so no count is
   * needed) or could not be answered.
   */
  sent_today: number | null;
  /** True when `sent_today` is a floor rather than a total. */
  sent_today_is_lower_bound: boolean;
  /** The quota the answer was measured against, or null when the row carries none. */
  daily_quota: number | null;
}

/** Every unblocked answer, so the null-valued fields cannot drift between branches. */
function sendable(fields: Partial<Sendability> = {}): Sendability {
  return {
    sendable: true,
    reason: null,
    evaluated: ["registration"],
    sent_today: null,
    sent_today_is_lower_bound: false,
    daily_quota: null,
    ...fields,
  };
}

/**
 * Whether `email` is allowed to send right now.
 *
 * The two checks, in the order the deleted local arm ran them and with its comparisons
 * unchanged:
 *
 *  * SUSPENSION beats quota, and a suspended row beats an active one for the same email.
 *  * The quota comparison is `used >= quota`, so a quota of 0 blocks every send. Both arms
 *    did that and `setAddressQuota` accepts 0, so it is a usable "stop this address"
 *    setting and not an edge case.
 *
 * AN INDETERMINATE COUNT NEVER ALLOWS A SEND. If the scan hits its budget with the floor
 * still under the quota, this function raises rather than reporting `sendable: true` — the
 * quota may or may not be exhausted, and only one of those two answers is safe to guess.
 * Blocking on a FLOOR that has reached the quota is sound in the other direction: a floor
 * at or above the limit proves the limit is met.
 *
 * @param store injected only by tests.
 */
export async function getAddressSendability(email: string, store?: EmailStore): Promise<Sendability> {
  const target = canonicalAddress(email);
  const resolved = storeFor(store);

  const matches = await matchingAddresses(resolved, target);
  // Unregistered senders are unrestricted. Preserved from both deleted arms; see the
  // header for why it is preserved rather than fixed here.
  if (matches.length === 0) return sendable();

  const record = matches[0]!;
  if ((record.status ?? "active") === "suspended") {
    return {
      sendable: false,
      reason: `Address ${target} is suspended`,
      evaluated: ["registration", "suspension"],
      sent_today: null,
      sent_today_is_lower_bound: false,
      daily_quota: record.daily_quota,
    };
  }

  // `undefined` is off-contract — `AddressRecord.daily_quota` is `number | null` and not
  // optional — and it is treated as "no quota", which is what both deleted arms did with it
  // (`used >= undefined` is false). Worth stating because the HTTP store maps an ABSENT
  // `daily_quota` column to `null`, so a service that stopped sending the field would read as
  // unlimited here. That conflation lives in the store's mapper, not in this family.
  const quota = record.daily_quota;
  if (quota === null || quota === undefined) {
    return sendable({ evaluated: ["registration", "suspension"] });
  }

  const day = utcDay();
  const counted = await countSendsOnDay(resolved, target, day, quota);
  if (counted.count >= quota) {
    const used = counted.complete ? `${counted.count}` : `at least ${counted.count}`;
    return {
      sendable: false,
      reason: `Address ${target} reached its daily quota (${used} of ${quota} sent today)`,
      evaluated: ["registration", "suspension", "quota"],
      sent_today: counted.count,
      sent_today_is_lower_bound: !counted.complete,
      daily_quota: quota,
    };
  }
  if (!counted.complete) {
    throw new Error(
      `This installation's store still had outbound messages to page through after ${MAX_MESSAGE_PAGES} ` +
        `pages, so whether this sender has reached its daily quota of ${quota} could not be ` +
        "determined; refusing to report it as sendable",
    );
  }
  return sendable({
    evaluated: ["registration", "suspension", "quota"],
    sent_today: counted.count,
    daily_quota: quota,
  });
}
