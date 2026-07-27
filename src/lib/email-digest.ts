// ONE inbox-digest implementation. There is no arm to pick, and nothing here asks where
// this installation keeps its mail.
//
// WHAT THIS FILE USED TO BE, because the shape is the bug. `email-digest.ts` was a
// nineteen-line facade that read the process-wide deployment word (`src/lib/mode.ts`,
// via the dispatcher at the old `email-digest.ts:7-14`) and handed each of four exports
// to one of two sibling modules:
//
//   * `email-digest.local.ts` (329 lines) held the real implementation — one SQLite
//     SELECT over `inbound_emails` with four correlated sub-selects into
//     `email_agent_runs`, plus the summarising and the row write;
//   * `email-digest.remote.ts` (107 lines) held a SECOND COPY of the two PURE functions
//     (`resolveEmailDigestWindow`, `formatEmailDigest`), byte-for-byte identical to the
//     first, a `loadEmailDigest` that duplicated the cache-then-generate control flow,
//     and a `generateEmailDigest` that threw.
//
// HALF THE ROUTED SURFACE WAS PURE. Two of the four exports touch no store at all, and
// they were identical in both arms, so the deployment word decided nothing about them
// except that a date-window calculation and a report formatter existed twice and were
// free to drift. They are one copy again, and a test asserts that a window resolved by
// the collapsed function still bounds every period the way the deleted pair did.
//
// WHAT REPLACES THE ARM CHOICE. Both the message read and the digest row read/write go
// through the store seam (`src/store/`), so "can this installation summarise its own
// inbox?" is the STORE'S OWN ANSWER rather than a deployment word. A store that cannot
// serve a read returns a typed refusal, and every refusal here THROWS.
//
// A REFUSAL IS NEVER REPORTED AS AN EMPTY DIGEST, and on this surface that rule has a
// specific teeth-bearing consequence: a digest row is CACHED. `loadEmailDigest` serves
// the newest stored `ok` row for the period, so a refused message read that got written
// out as `message_count: 0` with "no inbound messages" would not merely be wrong once —
// it would be served as the authoritative answer for that period until something else
// overwrote it. So the read is checked before anything is written, and a refusal or a
// transport fault throws with no row saved.
//
// WHAT THE COLLAPSE LOSES, STATED UP FRONT RATHER THAN DISCOVERED: per-message AI
// classification. The deleted local arm joined `email_agent_runs` for a categoriser
// category, agent labels, an agent priority and an agent summary, and folded all four
// into the digest. `EmailStore` declares NO agent-run family — there is no repository,
// no record shape and no operation for it anywhere in `src/store/repositories.ts` — so
// no store can be asked. The digest is now computed from what the seam does model:
// stored message labels, the starred flag and the read flag. The row records which
// computation produced it in `model` (`DIGEST_MODEL` below), because a stored row is
// the only place that fact can live. If the seam should model agent runs, that is a
// `src/store/` change and this PR does not make one.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO:
//
//   1. It never asks WHICH store it holds. `src/store-resolution.ts` is explicit that
//      construction is the only place that answer is visible and that its plan union is
//      not a runtime label for callers to branch on. There is no branch here on the store
//      kind or on the descriptor.
//   2. It does not reach into an arm. The period parser and the period label come from
//      the digest ROW family's facade (`src/db/email-digests.ts`), never from that
//      family's `.local` module — reaching into an arm is what the deleted code did, and
//      it is how a call ends up serving local rows under a configuration that names
//      something else.
//
// STATED PLAINLY so no reviewer has to infer it: that facade still dispatches on the
// axis internally (`src/db/email-digests.ts:14-21`), so this module's dependency on the
// axis is TRANSITIVE, not gone. What is gone is this family's OWN mode decision, and the
// two functions imported from it are the pure period parser and the period label, which
// are byte-identical in both of that family's arms. The transitive part goes when the
// digest ROW family is collapsed in turn; the axis itself is deleted in phase 9 and in
// no earlier phase.

import { emailDigestPeriodLabel, normalizeEmailDigestPeriod, type EmailDigest, type EmailDigestPeriod } from "../db/email-digests.js";
import { parseJsonArray, parseJsonObject } from "../db/json.js";
import { now } from "../db/runtime.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Refusal } from "../store/outcome.js";
import type { MessageListRecord, ResourceRow } from "../store/records.js";
import { enumerateStoreRows } from "./status-facts-enumeration.js";

export interface EmailDigestWindow {
  period: EmailDigestPeriod;
  since: string;
  until: string;
}

export interface GenerateEmailDigestOptions {
  period?: EmailDigestPeriod | string;
  /**
   * How many in-window messages the digest may summarise, newest first. Preserved
   * from the deleted local arm, clamp for clamp: at least 1, at most
   * `MAX_DIGEST_LIMIT`, defaulting to `DEFAULT_DIGEST_LIMIT`.
   *
   * It is a SAMPLE BUDGET and not a filter, so a window holding more than this many
   * messages produces a digest whose counts are lower bounds. That is reported rather
   * than assumed — see `coverageNote`.
   */
  limit?: number;
  /**
   * ACCEPTED AND IGNORED, and it was ignored by both deleted arms too.
   *
   * It once gated an external-provider (LLM) generation path that no longer exists;
   * the local arm read it into `opts` and never branched on it. Kept because
   * `src/server/routes/inbound-sequences.ts` passes it, and removing it would be a
   * compile break that bought nothing. Documented rather than silently dropped.
   */
  offline?: boolean;
  now?: Date;
  /**
   * Injected only by tests. There is exactly one production path, and it is
   * `createConfiguredEmailStore()`; handing in a store lets a test exercise a refusal
   * without an operator configuration behind it.
   *
   * This REPLACES the deleted local arm's `db?: Database`. The seam is asynchronous and
   * has no `Database` in any signature, so a SQLite handle is no longer expressible
   * here.
   */
  store?: EmailStore;
}

export interface LoadEmailDigestOptions extends GenerateEmailDigestOptions {
  fresh?: boolean;
  /** ACCEPTED AND IGNORED. Neither deleted arm branched on it either. */
  allowLocalFallback?: boolean;
}

/** The digest budget when a caller names none. The deleted local arm's default. */
const DEFAULT_DIGEST_LIMIT = 160;

/** The largest budget a caller may ask for. The deleted local arm's ceiling. */
const MAX_DIGEST_LIMIT = 500;

/**
 * Pages the message sample may fetch before it gives up.
 *
 * A bound is needed because rows NEWER than the window's upper edge are returned by
 * the store (the seam has a `since` filter and no `until` — see `sampleWindow`) and
 * filtered out here, so a page can contribute nothing and the scan still has to
 * advance. 40 pages of up to 500 rows is 20,000 rows of headroom above the window,
 * which no real installation reaches for the one period whose upper edge is in the
 * past. Running out is REPORTED, never hidden, and reporting it as an empty digest is
 * refused outright.
 */
const MAX_SAMPLE_PAGES = 40;

/**
 * Digest rows one `loadEmailDigest` may page through while looking for the newest.
 *
 * Same 500-row page ceiling both stores clamp to, and the same reason for a bound.
 * Running out throws: see `latestDigestRow`.
 */
const MAX_DIGEST_ROW_PAGES = 40;

/**
 * WHICH COMPUTATION PRODUCED A ROW, recorded in the row.
 *
 * Deliberately NOT the deleted arm's `local-emails-digest`. That name described a
 * computation that read per-message AI classification out of `email_agent_runs`; this
 * one cannot, because the store seam models no agent runs. Two rows produced by two
 * different computations must not be indistinguishable in storage, and `model` is the
 * only field that can carry the difference.
 */
const DIGEST_MODEL = "store-inbox-digest-v1";

/** `provider` on the row: this library computed the digest, no external model did. */
const DIGEST_PROVIDER = "local";

/** Highlights kept, matching the deleted arm. */
const MAX_HIGHLIGHTS = 6;

/** Action items kept, matching the deleted arm. */
const MAX_ACTION_ITEMS = 6;

/** Important ids kept, matching the deleted arm and the row family's write cap. */
const MAX_IMPORTANT_IDS = 30;

/** Label counts reported in the summary line, matching the deleted arm. */
const MAX_SUMMARY_LABELS = 4;

/**
 * Per-line length cap for the stored string arrays.
 *
 * The deleted arm did not cap them itself: it inherited the cap from the row family's
 * write normaliser, which collapses whitespace, de-duplicates and slices at 500. This
 * write goes through the store seam's generic resource path, which normalises nothing,
 * so the same shaping happens here and the stored values keep the shape they had.
 */
const MAX_DIGEST_LINE_CHARS = 500;

/**
 * Lines stored in the `highlights` and `action_items` arrays. Twelve, which is the cap the
 * deleted arm inherited from that same write normaliser — twice what it ever generated,
 * and kept at the value it was rather than tightened to what this code happens to produce.
 */
const MAX_STORED_LINES = 12;

/**
 * FOLDER STATE IS NOT A TOPIC LABEL, and the seam's record does not separate them.
 *
 * `MessageListRecord.labels` is the server's shape, and the SQLite store's mapper folds
 * its `is_archived` / `is_spam` / `is_trash` columns INTO that array
 * (`src/store-sqlite/messages-sql.ts`, `labelsFor`). The deleted arm read
 * `label_ids_json` only and had those three as separate booleans, so counting them here
 * would add `archived (12)` to a digest's topic labels and report a folder as a subject.
 * They are excluded, which keeps `label_counts` meaning what it meant.
 *
 * NOT IMPORTED from the store implementation that names the same three, deliberately. The
 * only other list of them lives in `src/store-sqlite/messages-sql.ts`, and importing a
 * concrete store into a lib module is the coupling this program is removing — worse than a
 * three-word literal. The seam's own `MESSAGE_FOLDERS` is a different set (it includes
 * `inbox`, `starred` and `sent`, which are predicates rather than stored state), so it is
 * not the source of truth for this question either.
 */
const FOLDER_LABELS = new Set(["archived", "spam", "trash"]);

interface DigestSourceEmail {
  id: string;
  from_address: string;
  subject: string;
  received_at: string;
  is_read: boolean;
  is_starred: boolean;
  labels: string[];
}

interface DigestSample {
  emails: DigestSourceEmail[];
  /**
   * false => the window holds more messages than `emails` carries, because the caller's
   * budget filled or the page bound ran out. Every count derived from `emails` is then a
   * LOWER BOUND and is published as one.
   */
  complete: boolean;
}

interface DigestOutput {
  summary: string;
  highlights: string[];
  action_items: string[];
  important_email_ids: string[];
  /**
   * Carried on the output rather than recomputed at write time, so the row cannot end
   * up describing one message set in its counts and another in its prose.
   */
  label_counts: Record<string, number>;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * The window a period names, in local time. Unchanged from both deleted arms, which
 * held identical copies of it.
 */
export function resolveEmailDigestWindow(periodInput: EmailDigestPeriod | string | undefined, at = new Date()): EmailDigestWindow {
  const period = normalizeEmailDigestPeriod(typeof periodInput === "string" ? periodInput : periodInput ?? "today");
  const todayStart = startOfLocalDay(at);
  if (period === "today") {
    return { period, since: todayStart.toISOString(), until: at.toISOString() };
  }
  if (period === "yesterday") {
    const since = addDays(todayStart, -1);
    return { period, since: since.toISOString(), until: todayStart.toISOString() };
  }
  if (period === "last7") {
    return { period, since: addDays(todayStart, -6).toISOString(), until: at.toISOString() };
  }
  const monthStart = new Date(at.getFullYear(), at.getMonth(), 1);
  return { period, since: monthStart.toISOString(), until: at.toISOString() };
}

/**
 * The refusal, thrown.
 *
 * Names the OPERATION and carries the store's own code, status and message. It names no
 * setting and no command: a refusal that tells the caller which variable to flip is a
 * refusal documenting its own bypass, and this repo has already had to delete one.
 */
function storeRefusal(what: string, refusal: Refusal): Error {
  return new Error(
    `This installation's store cannot ${what} (${refusal.code}, ${refusal.status}): ${refusal.message}`,
  );
}

function normalizedLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-").replace(/^ai:/, "").slice(0, 64);
}

function importantFromLabels(labels: string[]): boolean {
  return labels.map(normalizedLabel).some((label) => (
    label === "important"
    || label === "priority"
    || label === "urgent"
    || label === "action-required"
    || label === "follow-up"
    || label === "security"
    || label === "customer"
  ));
}

function truncate(value: string | null | undefined, limit: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).replace(/\s+\S*$/, "").trim()}...`;
}

/** One stored line: whitespace collapsed, capped, blank dropped, order preserved. */
function digestLines(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const line = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_DIGEST_LINE_CHARS);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/** Topic labels only: the three folder labels the store folds in are not topics. */
function topicLabels(labels: string[]): string[] {
  return labels.map(normalizedLabel).filter((label) => label && !FOLDER_LABELS.has(label));
}

/**
 * One digest source row, projected from the seam's list record.
 *
 * `received_at` is non-null here by construction — `inWindow` rejects a null one, the
 * same way the deleted arm's `received_at >= ?` predicate did — so the projection can
 * declare it as a string without a fabricated fallback.
 */
function toSourceEmail(row: MessageListRecord): DigestSourceEmail {
  return {
    id: row.id,
    from_address: row.from_addr,
    subject: row.subject && row.subject.trim() ? row.subject : "(no subject)",
    received_at: row.received_at as string,
    is_read: row.is_read,
    is_starred: row.is_starred,
    labels: row.labels,
  };
}

/**
 * Whether a returned row really belongs to the digest window and to the digest.
 *
 * THE STORE'S `since` FILTER IS NOT THIS CHECK, and re-asserting the window here is not
 * belt-and-braces:
 *
 *   * THE SEAM HAS NO `until`. `ListMessagesOptions` carries `since` and no upper bound,
 *     so a read for yesterday's window also returns everything received since — the
 *     whole of today included. Without this check a "yesterday" digest would summarise
 *     today's mail.
 *   * SQLite'S `since` IS NOT COMPARED AGAINST `received_at`. It filters on the store's
 *     ordering key, `COALESCE(received_at, created_at)`
 *     (`src/store-sqlite/messages.ts`, `messageFilters`), so a row with no received
 *     timestamp and a recent `created_at` passes it. The deleted arm compared
 *     `received_at` directly and dropped such a row; so does this.
 *
 * `direction` is re-asserted for the same reason the recipient scope is re-asserted in
 * the verification-code family: the store's own filter is the cheap narrowing, and a
 * store whose filter is looser than the question must not be able to put a SENT message
 * into a digest of received mail.
 *
 * THE COMPARISON IS A STRING COMPARISON, and that is inherited rather than introduced:
 * the deleted arm's predicate was `e.received_at >= ? AND e.received_at < ?` in SQL,
 * which is also a string comparison over the same column. It is exact for the ISO-8601
 * timestamps this library writes and it orders a legacy `YYYY-MM-DD HH:MM:SS` value
 * (SQLite's `datetime('now')` form) wrongly, exactly as before. Widening it here would
 * change which rows a digest covers, which is not this PR's change to make.
 */
function inWindow(row: MessageListRecord, window: EmailDigestWindow): boolean {
  if (row.direction.trim().toLowerCase() === "outbound") return false;
  const received = row.received_at;
  if (!received) return false;
  return received >= window.since && received < window.until;
}

/**
 * The newest in-window inbound messages, through the store seam, and whether they are
 * ALL of them.
 *
 * The row set is the deleted local arm's, predicate for predicate: inbound only
 * (`direction: "inbound"` is the seam's spelling of that arm's `is_sent = 0`, and it
 * excludes the legacy outbound ledger table for the same reason that arm read only
 * `inbound_emails`), received inside the window, and with NO FOLDER FILTER — so archived
 * mail is included, as it was, along with mail the store filed as spam or trash, which
 * that arm also included.
 *
 * `InboundRepository.listInbound` is NOT used, and this is the sharpest call in the
 * file. It looks like the obvious operation and it is the wrong one: it DEFAULTS THE
 * FOLDER TO `inbox` (`src/store-sqlite/messages.ts`, `listInbound`), whose predicate is
 * `NOT archived AND NOT spam AND NOT trash`. A digest of "everything that arrived" would
 * silently have become a digest of "everything still in the inbox", and the drop would
 * be invisible in the output — the count would simply be smaller.
 *
 * PAGING IS KEYSET, not offset. `next_cursor` is null exactly when a page is the last
 * (`src/store/records.ts`, `Page`), so end-of-table is the store's own signal and a
 * SHORT PAGE IS NEVER READ AS THE END — the failure that published a 500-row clamp as a
 * complete total elsewhere in this program is not reachable from here.
 */
async function sampleWindow(store: EmailStore, window: EmailDigestWindow, limit: number): Promise<DigestSample> {
  // One row past the budget, so "the budget is exactly full" and "there is more" are
  // distinguishable rather than assumed.
  const pageLimit = Math.min(Math.max(limit + 1, 1), MAX_DIGEST_LIMIT);
  const collected: DigestSourceEmail[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let reachedEnd = false;

  while (pages < MAX_SAMPLE_PAGES) {
    const listed = await store.messages.listMessages({
      direction: "inbound",
      since: window.since,
      limit: pageLimit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!listed.ok) throw storeRefusal("read the inbound mail in a digest window", listed);
    pages += 1;

    for (const row of listed.value.items) {
      if (!inWindow(row, window)) continue;
      collected.push(toSourceEmail(row));
    }
    if (collected.length > limit) break;
    if (listed.value.next_cursor === null) {
      reachedEnd = true;
      break;
    }
    cursor = listed.value.next_cursor;
  }

  const complete = reachedEnd && collected.length <= limit;
  // AN UNFINISHED SCAN THAT FOUND NOTHING IS NOT AN EMPTY WINDOW. With no row in hand
  // the scan never even reached the window's upper edge, so it has no evidence about
  // how much mail the window holds — and "this period has no inbound messages" is the
  // single most misleading sentence this module can write. Refused outright.
  if (!complete && collected.length === 0) {
    throw new Error(
      `This installation's store still had messages to scan after ${MAX_SAMPLE_PAGES} pages without ` +
        "reaching the digest window, so the window's contents are unknown; refusing to report it as empty",
    );
  }
  return { emails: collected.slice(0, limit), complete };
}

function countLabels(emails: DigestSourceEmail[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const email of emails) {
    for (const label of topicLabels(email.labels)) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function importantEmailIds(emails: DigestSourceEmail[]): string[] {
  return [
    ...new Set(
      emails
        .filter((email) => email.is_starred || importantFromLabels(email.labels))
        .map((email) => email.id),
    ),
  ].slice(0, MAX_IMPORTANT_IDS);
}

/**
 * The machine-readable coverage note stored on the row, or null when there is nothing
 * to report.
 *
 * PREFIXED so a reader can match on it without parsing prose, and stored in `error`
 * with `status` left at `ok`: the digest IS a digest, it is simply a floor rather than a
 * total, and marking it `error` would hide it from `loadEmailDigest` (which serves only
 * `ok` rows) and so serve a stale row forever instead.
 */
function coverageNote(sample: DigestSample): string | null {
  if (sample.complete) return null;
  return (
    `sample_bounded: this digest summarises the newest ${sample.emails.length} inbound messages in the ` +
    "window and the window holds more, so message_count and every count derived from it are lower bounds"
  );
}

function digestOutput(sample: DigestSample, window: EmailDigestWindow): DigestOutput {
  const emails = sample.emails;
  const unread = emails.filter((email) => !email.is_read).length;
  const important = importantEmailIds(emails);
  const labelCounts = countLabels(emails);
  const topLabels = Object.entries(labelCounts)
    .slice(0, MAX_SUMMARY_LABELS)
    .map(([label, count]) => `${label} (${count})`);
  const label = emailDigestPeriodLabel(window.period);
  // EVERY COUNT IN A BOUNDED DIGEST IS A LOWER BOUND, not just the message total: the
  // unread and important tallies are taken over the same truncated sample. The summary
  // says so once, in the sentence that carries the numbers.
  const bounded = !sample.complete;
  const summary = emails.length
    ? `${label} has ${bounded ? "at least " : ""}${emails.length} inbound message${emails.length === 1 ? "" : "s"}, `
      + `${bounded ? "at least " : ""}${unread} unread, and ${bounded ? "at least " : ""}${important.length} marked important`
      + `${topLabels.length ? `. Top labels: ${topLabels.join(", ")}` : ""}.`
      + (bounded ? " The read was bounded, so these are lower bounds rather than totals." : "")
    : `${label} has no inbound messages in this installation's store.`;
  const highlights = emails.slice(0, MAX_HIGHLIGHTS).map((email) => {
    const from = email.from_address.replace(/\s+/g, " ").trim() || "unknown sender";
    return `${from} - ${truncate(email.subject, MAX_DIGEST_LINE_CHARS)}`;
  });
  const actionItems = emails
    .filter((email) => !email.is_read || important.includes(email.id))
    .slice(0, MAX_ACTION_ITEMS)
    .map((email) => `${truncate(email.subject, MAX_DIGEST_LINE_CHARS)} from ${email.from_address}`);
  return {
    summary,
    highlights,
    action_items: actionItems,
    important_email_ids: important,
    label_counts: labelCounts,
  };
}

/** A JSON array column, whichever of the two shapes a store returns it in. */
function rowArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  // SQLite holds these columns as TEXT and hands back the JSON string verbatim; the API
  // holds them as jsonb and hands back either a native array or, for a row written as a
  // JSON string, the string. Both shapes are accepted rather than one being assumed.
  return parseJsonArray<unknown>(typeof value === "string" ? value : null).map((item) => String(item));
}

/** A JSON object column, whichever of the two shapes a store returns it in. */
function rowCounts(value: unknown): Record<string, number> {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : parseJsonObject<Record<string, unknown>>(typeof value === "string" ? value : null);
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(source)) {
    const count = Number(raw);
    if (Number.isFinite(count)) out[key] = count;
  }
  return out;
}

function rowText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function rowTextOrNull(value: unknown): string | null {
  const text = rowText(value);
  return text ? text : null;
}

/**
 * A stored digest row, mapped to the row family's record.
 *
 * `period` and `status` are VALIDATED rather than cast. The row family's own mappers
 * throw on a value outside the enum, and a digest whose period cannot be read is
 * corrupt stored data — a fault, not a value — so this agrees with them instead of
 * quietly widening the type.
 */
function toEmailDigest(row: ResourceRow): EmailDigest {
  const period = rowText(row["period"]);
  if (period !== "today" && period !== "yesterday" && period !== "last7" && period !== "month") {
    throw new Error(`Invalid digest period in storage: ${period}`);
  }
  const status = rowText(row["status"]);
  if (status !== "ok" && status !== "error") {
    throw new Error(`Invalid digest status in storage: ${status}`);
  }
  const provider = rowText(row["provider"]);
  const count = Number(row["message_count"]);
  return {
    id: rowText(row["id"]),
    period,
    since: rowText(row["since"]),
    until: rowText(row["until"]),
    provider: provider === "external" ? "external" : "local",
    model: rowText(row["model"]),
    status,
    message_count: Number.isFinite(count) ? count : 0,
    summary: rowTextOrNull(row["summary"]),
    highlights: rowArray(row["highlights"] ?? row["highlights_json"]),
    action_items: rowArray(row["action_items"] ?? row["action_items_json"]),
    important_email_ids: rowArray(row["important_email_ids"] ?? row["important_email_ids_json"]),
    label_counts: rowCounts(row["label_counts"] ?? row["label_counts_json"]),
    error: rowTextOrNull(row["error"]),
    started_at: rowText(row["started_at"]),
    completed_at: rowText(row["completed_at"]),
    created_at: rowText(row["created_at"]),
  };
}

/**
 * The newest stored `ok` digest for a period, or null when there genuinely is none.
 *
 * NEITHER STORE'S LIST ORDER CAN ANSWER THIS, and that is why the whole set is read
 * rather than the first row. The SQLite resource path orders these rows by `created_at`
 * (`src/store-sqlite/resources.ts`, `describeTable`) and the service orders them by
 * `completed_at` (`src/server/self-hosted/resources.ts`, the `email-digests` spec), and
 * neither ordering is part of the seam's contract for
 * `ResourceRepository.list`. "Newest" is decided here, on `completed_at`, which is what
 * the deleted arms' `ORDER BY completed_at DESC` meant.
 *
 * A TRUNCATED OR UNSTABLE SCAN THROWS. `null` from this function means "no digest has
 * been generated for this period", and `loadEmailDigest` acts on it by generating one; a
 * scan that could not be finished has not established that, and answering `null` would
 * turn "I could not look properly" into a fresh row that silently replaces an existing
 * one nobody could see.
 */
async function latestDigestRow(store: EmailStore, period: EmailDigestPeriod): Promise<EmailDigest | null> {
  const filters = { period, status: "ok" };
  const enumeration = await enumerateStoreRows<ResourceRow>(
    (opts) => store.emailDigests.list({ ...opts, filters }),
    {
      pageBudget: MAX_DIGEST_ROW_PAGES,
      idOf: (row) => (typeof row["id"] === "string" ? row["id"] : null),
    },
  );
  if (enumeration.refusal) throw storeRefusal("read this installation's stored digests", enumeration.refusal);
  if (enumeration.fault !== null) {
    throw new Error(`This installation's store faulted reading its stored digests: ${enumeration.fault}`);
  }
  if (!enumeration.complete) {
    throw new Error(
      "This installation's stored digests could not be read to the end "
        + `(pages: ${enumeration.pages}, duplicates: ${enumeration.duplicates}, shifted: ${enumeration.shifted}), `
        + "so which one is newest cannot be established; refusing to report that none exists",
    );
  }

  let newest: EmailDigest | null = null;
  for (const row of enumeration.rows) {
    const digest = toEmailDigest(row);
    // THE FILTER IS RE-ASSERTED ON WHAT CAME BACK. A store whose equality filter is
    // looser than the question — or that ignores it, as the generic API list route does
    // for a parameter it does not declare — would otherwise let another period's digest
    // be served as this one's, and a `status: "error"` row be served as a good digest.
    // The refusal channel exists for "I cannot filter"; a superset answered as a
    // filtered result is a wrong result and is treated as a fault.
    if (digest.period !== period || digest.status !== "ok") {
      throw new Error(
        "This installation's store answered a filtered digest read with rows outside the filter; "
          + "refusing to treat them as this period's digest",
      );
    }
    if (newest === null || digest.completed_at.localeCompare(newest.completed_at) > 0) newest = digest;
  }
  return newest;
}

/**
 * Write the digest row and hand back the STORE'S OWN copy of it.
 *
 * The returned row is re-read rather than reconstructed from the input, and three fields
 * are checked against what was written. The generic resource route ACCEPTS a body key
 * the resource has no column for and drops it silently, which is the "accepted and
 * dropped" class in its purest form; both stores refuse an unknown column up front, and
 * this check is what notices if one ever stops.
 */
async function saveDigestRow(store: EmailStore, input: {
  window: EmailDigestWindow;
  output: DigestOutput;
  messageCount: number;
  note: string | null;
  startedAt: string;
}): Promise<EmailDigest> {
  const completedAt = now();
  const created = await store.emailDigests.create({
    period: input.window.period,
    since: input.window.since,
    until: input.window.until,
    provider: DIGEST_PROVIDER,
    model: DIGEST_MODEL,
    status: "ok",
    message_count: input.messageCount,
    summary: input.output.summary,
    highlights_json: digestLines(input.output.highlights, MAX_STORED_LINES),
    action_items_json: digestLines(input.output.action_items, MAX_STORED_LINES),
    important_email_ids_json: digestLines(input.output.important_email_ids, MAX_IMPORTANT_IDS),
    label_counts_json: input.output.label_counts,
    error: input.note,
    started_at: input.startedAt,
    completed_at: completedAt,
  });
  if (!created.ok) throw storeRefusal("store a generated digest", created);
  const digest = toEmailDigest(created.value);
  if (
    !digest.id
    || digest.period !== input.window.period
    || digest.status !== "ok"
    || digest.message_count !== input.messageCount
  ) {
    throw new Error(
      "This installation's store accepted a digest write and answered with a different row; "
        + "refusing to report the digest as saved",
    );
  }
  return digest;
}

/**
 * Generate a digest for a period from the messages the store holds, save it, and return
 * the stored row.
 *
 * NOTHING IS WRITTEN UNTIL THE READ HAS SUCCEEDED. A refused or faulted message read
 * throws before `saveDigestRow` is reached, because a digest row is cached and a
 * fabricated empty one would be served as this period's answer until something replaced
 * it.
 */
export async function generateEmailDigest(
  periodOrOptions: EmailDigestPeriod | string | GenerateEmailDigestOptions = "today",
  optsOrDeps: GenerateEmailDigestOptions = {},
): Promise<EmailDigest> {
  const opts = typeof periodOrOptions === "object"
    ? periodOrOptions
    : { ...(optsOrDeps as GenerateEmailDigestOptions), period: periodOrOptions };
  // Built here rather than at module load: a contradictory storage configuration is a
  // boot error from the resolution, and it belongs to the call that needed a store.
  const store = opts.store ?? createConfiguredEmailStore();
  const window = resolveEmailDigestWindow(opts.period, opts.now);
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_DIGEST_LIMIT, MAX_DIGEST_LIMIT));
  const startedAt = now();

  const sample = await sampleWindow(store, window, limit);
  const output = digestOutput(sample, window);
  return saveDigestRow(store, {
    window,
    output,
    messageCount: sample.emails.length,
    note: coverageNote(sample),
    startedAt,
  });
}

/**
 * The newest stored digest for a period, generating one when there is none.
 *
 * `fresh` skips the stored row and generates. Both deleted arms had this control flow;
 * only one of them could carry it out.
 */
export async function loadEmailDigest(
  periodOrOptions: EmailDigestPeriod | string | LoadEmailDigestOptions = "today",
  optsOrDeps: LoadEmailDigestOptions = {},
): Promise<EmailDigest> {
  const opts = typeof periodOrOptions === "object"
    ? periodOrOptions
    : { ...(optsOrDeps as LoadEmailDigestOptions), period: periodOrOptions };
  const store = opts.store ?? createConfiguredEmailStore();
  const period = normalizeEmailDigestPeriod(typeof opts.period === "string" ? opts.period : opts.period ?? "today");
  if (!opts.fresh) {
    const latest = await latestDigestRow(store, period);
    if (latest) return latest;
  }
  return generateEmailDigest({ ...opts, period, store });
}

export function formatEmailDigest(digest: EmailDigest): string {
  const lines = [
    `${emailDigestPeriodLabel(digest.period)} digest`,
    `  window: ${digest.since} to ${digest.until}`,
    `  messages: ${digest.message_count}`,
    `  provider: ${digest.provider} ${digest.model}`,
    "",
    `Summary: ${digest.summary ?? "(no summary)"}`,
  ];
  // THE NOTE IS PRINTED. Both deleted formatters dropped `error` on the floor, so a row
  // that recorded WHY its numbers are floors — or that recorded a failed generation —
  // rendered identically to a complete one. A caveat nobody can see is not a caveat.
  if (digest.error) {
    lines.push("", `Note: ${digest.error}`);
  }
  if (digest.highlights.length) {
    lines.push("", "Highlights:");
    for (const item of digest.highlights) lines.push(`- ${item}`);
  }
  if (digest.action_items.length) {
    lines.push("", "Action items:");
    for (const item of digest.action_items) lines.push(`- ${item}`);
  }
  if (digest.important_email_ids.length) {
    lines.push("", `Important email ids: ${digest.important_email_ids.join(", ")}`);
  }
  return lines.join("\n");
}
