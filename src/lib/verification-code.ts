// ONE verification-code reader. There is no arm to pick, and nothing here asks where
// this installation keeps its mail.
//
// WHAT THIS FILE USED TO BE, because the shape is the bug. `verification-code.ts` was an
// eighteen-line facade that read the process-wide deployment word and handed each of
// three exports to one of two sibling modules:
//
//   * `verification-code.local.ts` held the real implementation — a synchronous SQLite
//     read over `inbound_recipients JOIN inbound_emails`;
//   * `verification-code.remote.ts` held a SECOND COPY of the two pure functions,
//     byte-for-byte identical to the first, plus a `listVerificationCodeCandidates`
//     that threw.
//
// Two of the three exports never touched a store at all, so mode-routing them bought
// nothing and cost the worst thing available on this surface: two copies of the
// code-extraction regexes, free to drift, in a module whose whole job is deciding which
// digits in an email are a one-time secret. They are one copy again.
//
// WHAT REPLACES THE ARM CHOICE. The candidate read goes through the store seam
// (`src/store/`), so "can this installation answer which inbound mail is addressed to
// this recipient?" is the STORE'S OWN ANSWER rather than a mode word:
//
//   * both stores declare `keysetPagination: true` (src/store-sqlite/index.ts,
//     src/store-http/index.ts), so both can serve the paged inbound read this needs;
//   * a store that cannot serve it returns a typed refusal, and this function THROWS
//     that refusal.
//
// A REFUSAL IS NEVER REPORTED AS AN EMPTY CANDIDATE LIST, and on this surface that rule
// is not a style preference. `[]` here means "no verification email has arrived yet",
// which is what every caller polls on — `emails inbox code --watch` loops on it and the
// latest-inbound-email tool answers null from it. A store that could not be consulted
// answering `[]` is therefore a reader that waits forever for mail it can already see,
// or reports "no code" for a mailbox that has one. It has to fail loudly.
//
// NO CODE EVER REACHES A DIAGNOSTIC. Nothing in this module logs, and no error string
// built here interpolates a message body, a subject, a candidate row, or an extracted
// code — only the operation that failed and the store's own refusal code, status and
// message. The returned `code` on a match is the function's contract and the only place
// a code appears.
//
// NOTHING IS CONSUMED, AND THAT IS PRESERVED DELIBERATELY. Neither deleted arm had any
// single-use, expiry or attempt-count semantics: both were pure reads that never marked
// a message read, never archived it, never deleted it and never decremented anything,
// and the service's single-message route has no read-marking side effect either. So
// there is no hash-before-consume ordering to get wrong here, and the ordering this
// collapse keeps is "no write at all" — asserted by a test, because a future store whose
// single-message read marked the row would silently make a re-read of the same code
// impossible.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO:
//
//   1. It never asks WHICH store it holds. `src/store-resolution.ts` is explicit that
//      construction is the only place that answer is visible and that its plan union is
//      not a runtime label for callers to branch on. A branch here on the store kind, or
//      on the descriptor, would be the same switch with a nicer spelling.
//   2. It does not reimplement address normalisation. The inbound family owns the
//      transform that decides what `Ops <ops@acme.com>` addresses, and this module
//      imports that family's FACADE — never an arm. Reaching into a `.local` module is
//      what the deleted local arm did, and it is how a call ends up serving local rows
//      under a configuration that names something else.
//
// STATED PLAINLY so no reviewer has to infer it: that facade still dispatches on the
// axis internally, so this module's dependency on the axis is TRANSITIVE, not gone. What
// is gone is this family's OWN mode decision. The transitive part goes when the inbound
// family is collapsed in turn, and the axis itself is deleted in phase 9 and in no
// earlier phase.

import { normalizeEmailAddress, type InboundEmail } from "../db/inbound.js";
import { safeLimit } from "../db/pagination.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Refusal } from "../store/outcome.js";
import type { MessageListRecord, MessageRecord } from "../store/records.js";

export interface VerificationCodeEmail {
  id: string;
  from_address: string;
  subject: string;
  text_body: string | null;
  html_body: string | null;
  received_at: string;
}

export interface VerificationCodeCandidateOptions {
  limit?: number;
  since?: string;
  from?: string;
  subject?: string;
}

export interface VerificationCodeMatch<T extends VerificationCodeEmail = InboundEmail> {
  code: string;
  email: T;
  confidence: "high" | "medium";
}

const CODE_CONTEXT_RE = /(?:code|verification|verify|temporary|one[-\s]?time|otp|passcode)[^\d]{0,80}(\d[\d\s-]{3,12}\d)/gi;
const STANDALONE_CODE_RE = /(?<!\d)(\d{4,10})(?!\d)/g;

function normalizeCode(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

export function extractVerificationCodes(text: string): string[] {
  const ordered = new Map<string, number>();
  for (const match of text.matchAll(CODE_CONTEXT_RE)) {
    const code = normalizeCode(match[1] ?? "");
    if (code.length >= 4 && code.length <= 10) ordered.set(code, (ordered.get(code) ?? 0) + 2);
  }
  for (const match of text.matchAll(STANDALONE_CODE_RE)) {
    const code = normalizeCode(match[1] ?? "");
    if (code.length >= 4 && code.length <= 10) ordered.set(code, (ordered.get(code) ?? 0) + (code.length === 6 ? 1 : 0));
  }
  return [...ordered.entries()]
    .sort((a, b) => b[1] - a[1] || (b[0].length === 6 ? 1 : 0) - (a[0].length === 6 ? 1 : 0))
    .map(([code]) => code);
}

/**
 * The page size floor for the candidate scan, and the default candidate budget.
 *
 * Read from `safeLimit`'s own documented fallback rather than re-spelled, so this module
 * and the pagination helper the deleted arm used cannot disagree about what "no limit
 * given" means.
 */
const DEFAULT_CANDIDATE_LIMIT = safeLimit(undefined);

/**
 * How many pages the candidate scan will walk before it gives up.
 *
 * A bound is needed because the store's recipient filter is a SUPERSET of the exact match
 * this function requires (see `addressedTo`), so a page can contribute zero candidates and
 * the scan has to be able to advance past it without becoming unbounded.
 *
 * REACHING THE BOUND THROWS. It does NOT return the candidates found so far, and that is
 * the whole reason the bound is written as a refusal rather than a `break`: a truncated
 * scan reported as a complete answer is "no code has arrived" for a mailbox that may well
 * have one, and "I could not finish looking" and "there is nothing there" have opposite
 * security meanings on this surface. The scan only reaches the bound when the store still
 * has pages AND the caller's budget is unfilled, which is not a normal mailbox.
 */
const MAX_CANDIDATE_PAGES = 20;

/**
 * The refusal, thrown.
 *
 * The message names the OPERATION and carries the store's own code, status and text. It
 * deliberately interpolates nothing from a candidate row: not a body, not a subject, not
 * a code. It also names no setting and no command — a refusal that tells the caller which
 * variable to set is a refusal documenting its own bypass, and this repo has already had
 * to delete one.
 */
function storeRefusal(what: string, refusal: Refusal): Error {
  return new Error(
    `This installation's store cannot ${what} (${refusal.code}, ${refusal.status}): ${refusal.message}`,
  );
}

/** One address, normalised the way the local recipient index normalises them. */
function normalizedAddress(value: string): string {
  return normalizeEmailAddress(value) ?? String(value ?? "").trim().toLowerCase();
}

/**
 * The recipient this read is scoped to.
 *
 * `normalizeEmailAddress` is the inbound family's parser and it is the SAME transform the
 * local database applies when it indexes recipients (`normalizedRecipientSql` in
 * src/db/database.ts strips a display name's angle brackets, lowercases and trims), so
 * using it keeps the collapsed read scoped to exactly the rows the deleted arm's
 * `inbound_recipients.address = ?` matched.
 *
 * The fallback to the trimmed text when the parser rejects the input is deliberate and is
 * applied to BOTH sides of the comparison below: the parser requires a dotted domain, so
 * a real mailbox such as `me@localhost` would otherwise be unmatchable — the deleted arm
 * returned an empty list for it, silently. Comparison stays exact string equality either
 * way, so the fallback cannot widen the scope.
 *
 * A blank address REFUSES rather than answering `[]`. Both arms answered `[]`, which on
 * this surface reads as "no code has arrived" — so a missing address made a watch loop
 * wait forever for mail nobody could ever be sent.
 */
function candidateRecipient(address: string): string {
  const trimmed = String(address ?? "").trim();
  if (!trimmed) {
    throw new Error("listVerificationCodeCandidates needs a recipient address to scope the read to");
  }
  return normalizedAddress(trimmed);
}

/**
 * Whether `row` is really addressed to `target`.
 *
 * THE STORE'S `to` FILTER IS NOT THIS CHECK, and the difference matters here more than
 * anywhere else in the tree. Both stores implement it as a substring match — SQLite as
 * `lower(to_addrs_json) LIKE '%…%'`, the API as a query parameter on the message list —
 * so a read for `me@example.com` also matches a message addressed to
 * `notme@example.com`. On a surface that hands back one-time codes that is a disclosure
 * path, not a cosmetic difference. So the filter is used as a cheap server-side narrowing
 * and the exact equality the deleted arm got from SQL is re-asserted here.
 *
 * Recipients come from `to_addrs` only, never `cc_addrs`: the local recipient index was
 * populated from `to_addresses` alone, so there is no cc reachability to preserve and
 * adding it would widen the scope beyond either deleted arm.
 */
function addressedTo(row: MessageListRecord, target: string): boolean {
  return row.to_addrs.map(normalizedAddress).includes(target);
}

function matchesText(value: string | null, needle: string | undefined): boolean {
  if (!needle) return true;
  return (value ?? "").toLowerCase().includes(needle);
}

/**
 * A candidate, projected from the store's full message record.
 *
 * `received_at` falls back to `created_at` because the seam's record allows a null
 * received timestamp and this projection does not — the same fallback the store's own
 * ordering key applies, so a candidate's timestamp agrees with the position it was
 * returned in.
 */
function toCandidate(record: MessageRecord): VerificationCodeEmail {
  return {
    id: record.id,
    from_address: record.from_addr,
    subject: record.subject ?? "",
    text_body: record.body_text,
    html_body: record.body_html,
    received_at: record.received_at ?? record.created_at,
  };
}

/**
 * The inbound mail addressed to `address` that could carry a verification code, newest
 * first, through the store seam.
 *
 * The row set is the deleted local arm's, predicate for predicate: inbound only
 * (`direction: "inbound"` is the seam's spelling of that arm's `is_sent = 0`), scoped to
 * one exact recipient, and with NO folder filter — so archived mail is included, as it
 * was, and so is mail the store filed as spam or trash, which that arm also included and
 * which is where verification mail routinely lands. `InboundRepository.listInbound` is
 * NOT used for this: it defaults the folder to the inbox, whose predicate excludes
 * archived, spam and trash, so it would silently drop a code the user had already filed.
 *
 * Filters are re-applied after the store answers. That is a second line of defence, not a
 * substitute for asking the store: if a store's filter semantics are looser than the
 * question, the worst outcome is "no candidate" rather than "a code from a sender you did
 * not ask about".
 *
 * @param store injected only by tests. There is exactly one production path, and it is
 *   `createConfiguredEmailStore()`; handing in a store lets a test exercise a refusal
 *   without an operator configuration behind it.
 */
export async function listVerificationCodeCandidates(
  address: string,
  opts: VerificationCodeCandidateOptions = {},
  store?: EmailStore,
): Promise<VerificationCodeEmail[]> {
  const target = candidateRecipient(address);
  // Built here rather than at module load: a contradictory storage configuration is a
  // boot error from the resolution, and it belongs to the call that needed a store — not
  // to whoever happened to import this module first.
  const resolved = store ?? createConfiguredEmailStore();

  const budget = safeLimit(opts.limit);
  const pageLimit = Math.max(budget, DEFAULT_CANDIDATE_LIMIT);
  const since = opts.since?.trim();
  const from = opts.from?.trim();
  const subject = opts.subject?.trim();
  const fromFilter = from?.toLowerCase();
  const subjectFilter = subject?.toLowerCase();

  const candidates: VerificationCodeEmail[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_CANDIDATE_PAGES; page += 1) {
    const listed = await resolved.messages.listMessages({
      direction: "inbound",
      to: target,
      limit: pageLimit,
      ...(cursor === undefined ? {} : { cursor }),
      ...(since ? { since } : {}),
      ...(from ? { from } : {}),
      ...(subject ? { subject } : {}),
    });
    if (!listed.ok) throw storeRefusal("read the inbound mail addressed to a recipient", listed);

    for (const row of listed.value.items) {
      // Re-asserted rather than trusted: a sent message can quote a code the user typed,
      // so serving one as an inbound candidate would answer "what code did I receive?"
      // with a code the caller sent.
      if (row.direction.trim().toLowerCase() === "outbound") continue;
      if (!addressedTo(row, target)) continue;
      if (!matchesText(row.from_addr, fromFilter)) continue;
      if (!matchesText(row.subject, subjectFilter)) continue;

      // The list projection carries no bodies by design, and the body is where the code
      // is, so each candidate needs the single-message read. This is the same
      // list-then-read shape the deleted arm's API data source already performed.
      const detail = await resolved.messages.getMessage(row.id);
      if (!detail.ok) throw storeRefusal("read a stored inbound message", detail);
      // A row listed and then absent is a concurrent delete, not a refusal: the store
      // answered both times. Skipping it is the honest projection of "it is gone".
      if (detail.value === null) continue;

      candidates.push(toCandidate(detail.value));
      if (candidates.length >= budget) return candidates;
    }

    if (listed.value.next_cursor === null) return candidates;
    cursor = listed.value.next_cursor;
  }

  // Deliberately not `return candidates`. See MAX_CANDIDATE_PAGES: the store still has
  // pages and the budget is not full, so what is in hand is an INCOMPLETE answer, and the
  // one thing this function must never do is present an incomplete scan as "nothing here".
  throw new Error(
    `This installation's store still had inbound mail to scan after ${MAX_CANDIDATE_PAGES} pages ` +
      "and the candidate list is incomplete; narrow the read with a since, from or subject filter",
  );
}

export function findVerificationCode<T extends VerificationCodeEmail = InboundEmail>(
  emails: T[],
  filters: { from?: string; subject?: string } = {},
): VerificationCodeMatch<T> | null {
  const from = filters.from?.toLowerCase();
  const subject = filters.subject?.toLowerCase();
  const sorted = [...emails].sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));

  for (const email of sorted) {
    if (from && !email.from_address.toLowerCase().includes(from)) continue;
    if (subject && !email.subject.toLowerCase().includes(subject)) continue;
    const body = [email.subject, email.text_body ?? "", email.html_body ?? ""].join("\n");
    const [code] = extractVerificationCodes(body);
    if (!code) continue;
    const high = /code|verification|verify|temporary|otp|passcode/i.test(body);
    return { code, email, confidence: high ? "high" : "medium" };
  }

  return null;
}
