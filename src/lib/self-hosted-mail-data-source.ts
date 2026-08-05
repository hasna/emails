// SelfHostedMailDataSource maps the operator-configured Emails service onto the
// common mailbox interface. The service speaks a versioned resource API — the
// same shape `src/db/self-hosted-store.ts` already uses for `domains`:
//   GET    /v1/messages?limit&cursor   -> { messages: [ <summary row>, ... ], next_cursor }
//   GET    /v1/messages/<id>           -> { message: <full row> } | 404
//   POST   /v1/messages                -> { message: <row> }
//   PATCH  /v1/messages/<id>           -> { message: <row> }
//   DELETE /v1/messages/<id>           -> 200 | 404
// Rows are snake_case. List rows carry metadata and a short `snippet`; detail
// rows carry the full body_text/body_html projection. Ordering is
// COALESCE(received_at, created_at) DESC.
//
// This backend maps that resource API onto the client's domain language
// (TuiMessage / MailboxCounts / MessageBody / …) so the CLI/MCP inbox reads the
// SHARED self_hosted store instead of the machine-local SQLite island.
//
// SECRET SAFETY: the bearer credential is resolved from the configured client
// environment (via resolveSelfHostedConfig) and only ever placed in an
// in-process `Authorization` header. It is never written to argv, logged, or
// embedded in an error message.

import { resolveSelfHostedConfig } from "../db/self-hosted-store.js";
import {
  EMAILS_SELF_HOSTED_API_KEY_ENV,
  EMAILS_SESSION_TOKEN_ENV,
  type EmailsClientCredentialCandidate,
} from "./client-env.js";
import { getEmailsMode } from "./mode.js";
import {
  type AttachmentPath,
  type ConversationBodyOptions,
  type LabelSummary,
  type ListLabelSummaryOptions,
  type ListMailboxSourcesOptions,
  MAILBOXES,
  type Mailbox,
  type MailboxCounts,
  type MailboxListOptions,
  type MailboxSource,
  type MailboxSourceSummary,
  type MailboxStatusOptions,
  type MailboxStatusSummary,
  type MessageBody,
  type TuiMessage,
  type TuiThreadBody,
  type TuiThreadMessage,
  mailboxLabel,
  renderMarkdown,
  SELF_HOSTED_PROVIDER_CLEAR_UNSUPPORTED,
} from "./mail-types.js";
import type {
  MailBulkInput,
  MailBulkResult,
  MailClearFilter,
  MailClearResult,
  MailDataSource,
  MailInsertionsPage,
  MailInsertionsQuery,
  MailSendInput,
  MailSendResult,
} from "./mail-data-source.js";
import {
  findVerificationCode,
  type VerificationCodeCandidateOptions,
  type VerificationCodeEmail,
  type VerificationCodeMatch,
} from "./verification-code.js";
import {
  decodeAttachmentPayload,
  normalizeAttachmentByteLimit,
  type AttachmentContent,
} from "./attachment-download.js";
import {
  DEFAULT_SELF_HOSTED_MAX_RESPONSE_BYTES,
  parseSelfHostedErrorJson,
  parseSelfHostedSuccessJson,
  projectSelfHostedMailErrorBody,
  readSelfHostedResponseText,
  selfHostedTransportLimit,
  validateSelfHostedMailSuccessResponse,
} from "./self-hosted-wire.js";
// ── the /v1 message row (snake_case, as the self-hosted serve returns) ────────

interface V1Message {
  id: string;
  direction?: string;
  from_addr?: string | null;
  to_addrs?: string[] | null;
  cc_addrs?: string[] | null;
  subject?: string | null;
  snippet?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  status?: string | null;
  send_state?: string | null;
  provider_message_id?: string | null;
  message_id?: string | null;
  in_reply_to?: string | null;
  received_at?: string | null;
  is_read?: boolean;
  is_starred?: boolean;
  labels?: string[] | null;
  headers?: Record<string, unknown> | null;
  /**
   * Outbound-policy denial code. List rows carry it as its own column (full
   * headers are stripped from list pages for payload size); the detail read
   * carries it inside `headers`. Read both, prefer the explicit column.
   */
  policy_denial?: string | null;
  attachments?: unknown[] | null;
  /** List rows carry only the count; full metadata comes from the detail read. */
  attachment_count?: number;
  created_at?: string | null;
  updated_at?: string | null;
}

export type SelfHostedFetch = (url: string, init: RequestInit) => Promise<{
  body?: ReadableStream<Uint8Array> | null;
  headers?: { get(name: string): string | null };
  status: number;
  text(): Promise<string>;
}>;

interface V1MessagePage {
  messages: V1Message[];
  /** Undefined means a successful legacy response omitted next_cursor. */
  nextCursor: string | null | undefined;
}

interface V1MessagePagePosition {
  cursor?: string;
  offset?: number;
}

interface MailChangesCursorEnvelopeV2 {
  version: 2;
  /** Current-server keyset cursor; null means resume through legacy offset. */
  serverCursor: string | null;
  /** Brent-cycle anchor cursor; exact comparison, constant encoded size. */
  cycleAnchor: string | null;
  /** Current Brent-cycle comparison window, always a bounded power of two. */
  cyclePower: number;
  /** Number of transitions since cycleAnchor was last advanced. */
  cycleLength: number;
  /** Number of continuation pages traversed across all calls. */
  pageCount: number;
  /** Rows consumed from the original result set, or null for a raw cursor with unknown depth. */
  offset: number | null;
  /** Original stable lower bound for the whole cursor walk. */
  since: string | null;
}

interface DecodedMailChangesCursor {
  serverCursor: string | null;
  cycleAnchor: string | null;
  cyclePower: number;
  cycleLength: number;
  pageCount: number;
  offset: number | null;
  since: string | null;
}

// A complete server id (uuidv7). Used verbatim; a shorter value is a prefix that
// the server resolves with an indexed tenant-scoped lookup.
const FULL_ID_RE = /^(?:[A-Za-z0-9_-]+:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Page size for /v1 list reads.
const PAGE_LIMIT = 500;
// Legacy servers use OFFSET and reject a starting offset beyond this value.
const LEGACY_MAX_OFFSET = 100_000;
const MAIL_CHANGES_CURSOR_NAMESPACE_PREFIX = "emails-self-hosted:v";
const MAIL_CHANGES_CURSOR_V1_PREFIX = `${MAIL_CHANGES_CURSOR_NAMESPACE_PREFIX}1:`;
const MAIL_CHANGES_CURSOR_V2_PREFIX = `${MAIL_CHANGES_CURSOR_NAMESPACE_PREFIX}2:`;
const MAIL_CHANGES_CURSOR_MAX_ENCODED_CHARS = 8_192;
const MAIL_CHANGES_CURSOR_MAX_DECODED_BYTES = 6_144;
const MAIL_CHANGES_SERVER_CURSOR_MAX_BYTES = 1_024;
const MAIL_CHANGES_CURSOR_MAX_PAGES = 100_000;
const MAIL_CHANGES_CURSOR_MAX_CYCLE_POWER = 131_072;
const MAIL_CHANGES_CURSOR_MAX_ROWS = MAIL_CHANGES_CURSOR_MAX_PAGES * PAGE_LIMIT;
const MAIL_CHANGES_CURSOR_V1_MAX_SEEN = 256;
const MAIL_CHANGES_CURSOR_V1_KEYS = [
  "offset",
  "seenServerCursors",
  "serverCursor",
  "since",
  "version",
  "watermark",
] as const;
const MAIL_CHANGES_CURSOR_V2_KEYS = [
  "cycleAnchor",
  "cycleLength",
  "cyclePower",
  "offset",
  "pageCount",
  "serverCursor",
  "since",
  "version",
] as const;
// Hard cap on rows walked for a full scan (counts/search/resolve). Large enough
// to cover a real mailbox without an unbounded walk.
const MAX_SCAN_ROWS = 100_000;

// ── server-side folder pushdown ───────────────────────────────────────────────
//
// GET /v1/messages accepts an index-backed `?folder=` filter (the serve rejects
// unknown values by name). The client sends it so a scarce folder — starred,
// archived, spam, trash — is answered by the server instead of by walking the
// whole store client-side; `folderMatch` remains the second gate, so a server
// that predates the parameter and ignores it still yields correct results.
// `unread` is not a server folder: it maps to `inbox` and stays client-side.
type ServerListFolder = "inbox" | "starred" | "sent" | "archived" | "spam" | "trash";

function serverListFolderOf(mailbox: Mailbox): ServerListFolder {
  return mailbox === "unread" ? "inbox" : mailbox;
}

// Hard cap on /messages requests for ONE filtered folder listing. Only a server
// that ignores `?folder=` (or a pathologically deep offset) can reach it: with
// the pushdown honoured, pages are match-dense and the page loop breaks as soon
// as the requested window fills. Sized to the same worst case as MAX_SCAN_ROWS.
const MAX_FILTER_WALK_REQUESTS = 200;

function filterWalkExhausted(mailbox: Mailbox, scannedRows: number): Error {
  return new Error(
    `self-hosted emails: listing the ${mailbox} folder scanned ${scannedRows} rows over `
      + `${MAX_FILTER_WALK_REQUESTS} requests without completing. This server ignored the `
      + "GET /v1/messages ?folder= filter (it predates server-side folder listing) — "
      + "upgrade the emails-serve deployment, or narrow the listing with --since.",
  );
}
// How long a full scan is reused within one (short-lived) CLI/MCP invocation.
const SCAN_TTL_MS = 15_000;

// ── label summaries: a bounded, cached, coalesced sample ─────────────────────
//
// Label summaries feed a SIDEBAR LIST — "which labels exist, roughly how many",
// capped at ~80 entries. The local seam answers it with one SQL GROUP BY; the
// self-hosted seam has no server-side aggregate, so it can only tally rows it
// has dragged over HTTP. Tallying the WHOLE store to render that list cost ~340
// requests and ~145 MB of JSON against the real mailbox (~170k messages), and
// the TUI re-issues it on every 30s refresh — so crawls overlapped and stacked
// until the process sat on a full core (task be9b3bb0).
//
// So the walk is bounded like every other walk in this module, and the tally is
// shared. THE COUNTS ARE THEREFORE A SAMPLE, not a census: they describe the most
// recent MAX_LABEL_SCAN_REQUESTS pages (newest-first ordering), so on a store
// larger than that a label's count is a lower bound and a label used only in old
// mail can be missing entirely. That is a deliberate accuracy trade for sidebar
// metadata, and it is the same one src/cli/tui/data.remote.ts already makes with
// SELF_HOSTED_MAIL_SCAN_CAP=5000.
const MAX_LABEL_SCAN_REQUESTS = 10;
// Must exceed the TUI's own sidebar refresh cadence (30s), or every refresh pays
// for a fresh walk and the cache buys nothing.
const LABEL_TALLY_TTL_MS = 60_000;

// ── scoped folder counts: bounded, cached, coalesced ─────────────────────────
//
// Folder counts for ONE inbox sit on the same Promise.all as the label summaries
// above (src/cli/tui-solid/context/emails-state.tsx), behind the same 30s TUI
// refresh, and were the larger of the two walks. `scanScopeRows` follows the
// cursor chain with no request bound, no cache and no coalescing, and follows it
// TWICE for an address because the to/from union is two filter sets. Its only
// bound counts MATCHED rows (`seen.size > MAX_SCAN_ROWS`), so a serve that
// ignores ?to=/?from= matches little per page and never terminates early at all.
//
// THE FIX DELIBERATELY DOES NOT LIVE IN scanScopeRows. That helper is also the
// preflight for the destructive clear(), which deletes exactly what the walk
// returns — a budget or a TTL pushed down into it would make clear() delete a
// partial or stale subset of a mailbox while reporting a plausible count. So the
// counting walk is its own thing, and clear() keeps the exact, uncached,
// complete walk its contract depends on.
//
// Unlike the label tally, these counts are PER SCOPE — one inbox's numbers must
// never be served for another — so the cache is keyed rather than store-wide.
//
// THE BOUND IS ON ROWS, NOT REQUESTS, and that distinction was measured rather
// than reasoned. An earlier revision capped this walk at 200 REQUESTS on the
// argument that 200 x PAGE_LIMIT is MAX_SCAN_ROWS "so a store that works now
// keeps working". That is FALSE whenever pages are not full: adversarial review
// ran two stores that resolve exactly on the current code and would have thrown
// under the request cap —
//
//   300 pages x 2 rows   -> inbox=600    requests=600
//   120 pages x 500 rows -> inbox=60000  requests=240
//
// Both sit far below MAX_SCAN_ROWS, so a request cap is strictly tighter than
// the row cap it claimed to mirror. The walk is therefore bounded on rows
// actually SCANNED, against the same MAX_SCAN_ROWS constant that bounds this
// path today. The only change in kind is that today's bound counts rows MATCHED
// (`seen.size`), which a serve ignoring ?to=/?from= barely grows — that is what
// made the walk unbounded in practice.
//
// The request cap below is a runaway guard only. It cannot fire before the row
// bound unless a serve averages under ten rows per page, and it exists so that a
// serve handing back near-empty pages with fresh cursors terminates instead of
// spinning forever (empty pages never advance the row bound).
const MAX_SCOPED_COUNT_REQUESTS = 10_000;
// Must exceed the TUI's 30s sidebar refresh, for the same reason as the tally.
const SCOPED_COUNT_TTL_MS = 60_000;

// ── remembering a walk that failed closed ────────────────────────────────────
//
// THE BOUND ABOVE MAKES ONE WALK FINITE. IT DOES NOT MAKE THE SEQUENCE OF WALKS
// FINITE. Only a walk that COMPLETES reaches the cache write at the end of the
// walk body, so a scope that trips the bound was remembered nowhere: the TUI
// catches the throw into `lastError`, reschedules the sidebar 30s later, and
// pays the whole walk again. Measured on the regression added with this change:
// the second call issued 201 further requests, and would have kept doing so for
// as long as the inbox stayed selected.
//
// That is the STEADY STATE on the real mailbox rather than an edge case —
// 174_482 messages against a MAX_SCAN_ROWS of 100_000 cannot complete, so the
// production configuration is exactly the one that never caches.
//
// The failure is STRUCTURAL: it is a property of the store's size against a
// compile-time constant, so it cannot resolve on the 60s timescale that suits a
// count. Re-deriving it also costs the MAXIMUM walk the bound allows (~200
// requests) rather than a typical one, so it is the most expensive thing to
// recompute and the least likely to have changed. Hence a longer window than
// SCOPED_COUNT_TTL_MS.
//
// It is deliberately not permanent. A scope that failed during a serve deploy,
// or before an operator narrowed the read, has to become countable again
// without restarting the TUI — and a write invalidates it immediately, so a
// clear() or a move is reflected at once rather than after the window.
const SCOPED_COUNT_FAILURE_TTL_MS = 15 * 60_000;

// Both figures are the REAL ones. An earlier revision reported
// `requests * PAGE_LIMIT`, which invented a row count — a 600-row store claimed
// "scanned 100500 rows … holds more than 100000 messages" and so corroborated
// the wrong one of the two causes it offers.
function scopedCountWalkExhausted(scannedRows: number, requests: number): Error {
  return new Error(
    `self-hosted emails: scoped folder counts scanned ${scannedRows} rows over `
      + `${requests} requests without completing. Either this server ignored the `
      + "GET /v1/messages ?to=/?from= recipient filters, or this one address holds more "
      + `than ${MAX_SCAN_ROWS} messages — upgrade the emails-serve deployment, or scope the `
      + "read to a domain instead of an address.",
  );
}

// The cache key IS the scope, so two scopes can never share an entry. Both
// fields are already lower-cased by selfHostedScopeOf, and the separator cannot
// occur in either, so distinct scopes cannot collide on one key.
function scopedCountsKey(scope: SelfHostedScope): string {
  return `a=${scope.address ?? ""} d=${scope.domain ?? ""}`;
}
// Hard cap on rows walked while collecting one conversation. The candidate read
// is already narrowed server-side by the subject filter, so this only bounds a
// pathological "everyone uses the same subject" store.
const MAX_THREAD_CANDIDATE_ROWS = 2_000;

// The synthetic source id `listMailboxSources()` publishes for the whole shared
// store. `emails inbox sources` prints it and `--source <id>` must accept it
// back — the round-trip is the contract, so it lives next to both ends of it.
export const SELF_HOSTED_SOURCE_ID = "self_hosted";
// The id local mode uses for the same "no narrowing" scope; accepted as an alias
// so a script written against local mode keeps working here.
const ALL_SOURCE_ID = "all";

function bareEmail(value: string): string {
  const angled = value.match(/<([^>]+)>/);
  return (angled ? angled[1]! : value).trim().toLowerCase();
}

/** An RFC 5322 Message-ID without its angle brackets (same rule as db/inbound.remote.ts). */
function bareMessageId(value: string | null | undefined): string {
  return String(value ?? "").replace(/[<>]/g, "").trim();
}

// The conversation key of a subject. The self-hosted store has NO thread_id
// column: its one server-side notion of a conversation is the normalized
// (Re:/Fwd:-stripped, lower-cased, trimmed) subject that
// `GET /v1/messages/threads` groups by — see store.listThreads, whose SQL this
// mirrors expression-for-expression:
//   NULLIF(btrim(regexp_replace(lower(COALESCE(subject,'')),
//                               '^(\s*(re|fwd|fw)\s*:\s*)+', '', 'g')), '')
// Keeping the two in lock-step is what makes this client's thread view agree
// with the server's own thread rollup instead of inventing a third answer.
const THREAD_SUBJECT_PREFIX_RE = /^(?:\s*(?:re|fwd|fw)\s*:\s*)+/;

/** Normalized conversation key, or null when the subject is empty (no key exists). */
export function threadKeyOfSubject(subject: string | null | undefined): string | null {
  const stripped = String(subject ?? "").toLowerCase().replace(THREAD_SUBJECT_PREFIX_RE, "").trim();
  return stripped || null;
}

function snippetOf(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

function messageDate(m: V1Message): string {
  return m.received_at || m.created_at || "";
}

function normalizeSince(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`Invalid date: ${value}`);
  return new Date(time).toISOString();
}

function validCursorTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 64) {
    throw new Error(`self-hosted emails: malformed changes cursor ${field}`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`self-hosted emails: malformed changes cursor ${field}`);
  }
  return value;
}

function validServerCursor(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= MAIL_CHANGES_SERVER_CURSOR_MAX_BYTES
    && !/[\u0000-\u001F\u007F]/.test(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function decodeCursorEnvelopeJson(raw: string, prefix: string): Record<string, unknown> {
  if (raw.length > MAIL_CHANGES_CURSOR_MAX_ENCODED_CHARS) {
    throw new Error("changes cursor is too large");
  }
  const encoded = raw.slice(prefix.length);
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("changes cursor is not canonical base64url");
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length > MAIL_CHANGES_CURSOR_MAX_DECODED_BYTES
    || decoded.toString("base64url") !== encoded
  ) {
    throw new Error("changes cursor payload is too large or non-canonical");
  }
  const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("changes cursor payload is not an object");
  }
  return parsed as Record<string, unknown>;
}

function validCursorOffset(value: unknown, serverCursor: string | null): number | null {
  if (value === null) {
    if (serverCursor === null) throw new Error("missing legacy offset");
    return null;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAIL_CHANGES_CURSOR_MAX_ROWS) {
    throw new Error("invalid offset");
  }
  const offset = value as number;
  if (serverCursor === null && (offset === 0 || offset > LEGACY_MAX_OFFSET)) {
    throw new Error("invalid legacy offset");
  }
  return offset;
}

function decodeLegacyMailChangesCursor(raw: string): DecodedMailChangesCursor {
  const parsed = decodeCursorEnvelopeJson(raw, MAIL_CHANGES_CURSOR_V1_PREFIX);
  if (!hasExactKeys(parsed, MAIL_CHANGES_CURSOR_V1_KEYS) || parsed["version"] !== 1) {
    throw new Error("invalid legacy cursor schema");
  }
  const serverCursor = parsed["serverCursor"];
  if (serverCursor !== null && !validServerCursor(serverCursor)) {
    throw new Error("invalid server cursor");
  }
  const rawSeenServerCursors = parsed["seenServerCursors"];
  if (!Array.isArray(rawSeenServerCursors)
    || rawSeenServerCursors.length > MAIL_CHANGES_CURSOR_V1_MAX_SEEN
  ) {
    throw new Error("invalid seen server cursors");
  }
  const seenServerCursors = rawSeenServerCursors.map((cursor) => {
    if (!validServerCursor(cursor)) throw new Error("invalid seen server cursor");
    return cursor;
  });
  if (new Set(seenServerCursors).size !== seenServerCursors.length) {
    throw new Error("duplicate seen server cursor");
  }
  if (serverCursor !== null && !seenServerCursors.includes(serverCursor)) {
    throw new Error("current server cursor is not in cursor history");
  }
  let cycle = emptyCursorCycleState();
  for (const cursor of seenServerCursors) {
    cycle = advanceCursorCycle(cycle, cursor);
  }
  return {
    serverCursor,
    ...cycle,
    pageCount: seenServerCursors.length,
    offset: validCursorOffset(parsed["offset"], serverCursor),
    since: validCursorTimestamp(parsed["since"], "since"),
  };
}

interface CursorCycleState {
  cycleAnchor: string | null;
  cyclePower: number;
  cycleLength: number;
}

function emptyCursorCycleState(): CursorCycleState {
  return { cycleAnchor: null, cyclePower: 1, cycleLength: 0 };
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

/**
 * Advance Brent's cycle detector by one opaque server cursor.
 *
 * The state is exact and constant-size: unlike a Bloom filter it cannot reject
 * a unique cursor. The independent page cap remains the final bound for a
 * non-cyclic but unending server.
 */
function advanceCursorCycle(state: CursorCycleState, nextCursor: string): CursorCycleState {
  if (state.cycleAnchor === null) {
    return { cycleAnchor: nextCursor, cyclePower: 1, cycleLength: 0 };
  }
  if (nextCursor === state.cycleAnchor) {
    throw new Error("self-hosted emails: pagination cursor repeated or did not advance");
  }
  const nextLength = state.cycleLength + 1;
  if (nextLength === state.cyclePower) {
    return {
      cycleAnchor: nextCursor,
      cyclePower: Math.min(state.cyclePower * 2, MAIL_CHANGES_CURSOR_MAX_CYCLE_POWER),
      cycleLength: 0,
    };
  }
  return { ...state, cycleLength: nextLength };
}

function decodeCurrentMailChangesCursor(raw: string): DecodedMailChangesCursor {
  const parsed = decodeCursorEnvelopeJson(raw, MAIL_CHANGES_CURSOR_V2_PREFIX);
  if (!hasExactKeys(parsed, MAIL_CHANGES_CURSOR_V2_KEYS) || parsed["version"] !== 2) {
    throw new Error("invalid cursor schema");
  }
  const serverCursor = parsed["serverCursor"];
  if (serverCursor !== null && !validServerCursor(serverCursor)) {
    throw new Error("invalid server cursor");
  }
  const pageCount = parsed["pageCount"];
  if (!Number.isSafeInteger(pageCount)
    || (pageCount as number) < 0
    || (pageCount as number) > MAIL_CHANGES_CURSOR_MAX_PAGES
  ) {
    throw new Error("invalid page count");
  }
  const cycleAnchor = parsed["cycleAnchor"];
  if (cycleAnchor !== null && !validServerCursor(cycleAnchor)) {
    throw new Error("invalid cycle anchor");
  }
  const cyclePower = parsed["cyclePower"];
  if (!Number.isSafeInteger(cyclePower)
    || !isPowerOfTwo(cyclePower as number)
    || (cyclePower as number) > MAIL_CHANGES_CURSOR_MAX_CYCLE_POWER
  ) {
    throw new Error("invalid cycle power");
  }
  const cycleLength = parsed["cycleLength"];
  if (!Number.isSafeInteger(cycleLength)
    || (cycleLength as number) < 0
    || (cycleLength as number) >= (cyclePower as number)
  ) {
    throw new Error("invalid cycle length");
  }
  if (cycleAnchor === null
    && (serverCursor !== null || cyclePower !== 1 || cycleLength !== 0)
  ) {
    throw new Error("invalid empty cycle state");
  }
  return {
    serverCursor,
    cycleAnchor,
    cyclePower: cyclePower as number,
    cycleLength: cycleLength as number,
    pageCount: pageCount as number,
    offset: validCursorOffset(parsed["offset"], serverCursor),
    since: validCursorTimestamp(parsed["since"], "since"),
  };
}

function encodeMailChangesCursor(state: DecodedMailChangesCursor): string {
  const envelope: MailChangesCursorEnvelopeV2 = {
    version: 2,
    serverCursor: state.serverCursor,
    cycleAnchor: state.cycleAnchor,
    cyclePower: state.cyclePower,
    cycleLength: state.cycleLength,
    pageCount: state.pageCount,
    offset: state.offset,
    since: state.since,
  };
  const decoded = Buffer.from(JSON.stringify(envelope), "utf8");
  if (decoded.length > MAIL_CHANGES_CURSOR_MAX_DECODED_BYTES) {
    throw new Error("self-hosted emails: changes cursor exceeded its bounded size limit");
  }
  const encoded = `${MAIL_CHANGES_CURSOR_V2_PREFIX}${decoded.toString("base64url")}`;
  if (encoded.length > MAIL_CHANGES_CURSOR_MAX_ENCODED_CHARS) {
    throw new Error("self-hosted emails: changes cursor exceeded its bounded size limit");
  }
  return encoded;
}

function decodeMailChangesCursor(raw: string): DecodedMailChangesCursor | null {
  if (!raw.startsWith(MAIL_CHANGES_CURSOR_NAMESPACE_PREFIX)) return null;
  try {
    if (raw.startsWith(MAIL_CHANGES_CURSOR_V2_PREFIX)) {
      return decodeCurrentMailChangesCursor(raw);
    }
    if (raw.startsWith(MAIL_CHANGES_CURSOR_V1_PREFIX)) {
      return decodeLegacyMailChangesCursor(raw);
    }
    throw new Error("unsupported changes cursor version");
  } catch {
    throw new Error("self-hosted emails: malformed changes cursor envelope");
  }
}

function validateRawChangesCursor(raw: string): string {
  if (!validServerCursor(raw)) {
    throw new Error("self-hosted emails: malformed raw changes cursor");
  }
  return raw;
}

function nextCursorPageCount(pageCount: number): number {
  const next = pageCount + 1;
  if (next > MAIL_CHANGES_CURSOR_MAX_PAGES) {
    throw new Error(
      `self-hosted emails: pagination exceeded the ${MAIL_CHANGES_CURSOR_MAX_PAGES}-page safety limit`,
    );
  }
  return next;
}

function messageTime(m: V1Message): number {
  const time = Date.parse(messageDate(m));
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function isOnOrAfter(m: V1Message, since: string | undefined): boolean {
  if (!since) return true;
  return messageTime(m) >= Date.parse(since);
}

function labelsOf(m: V1Message): string[] {
  return Array.isArray(m.labels) ? m.labels.filter((l): l is string => typeof l === "string") : [];
}

function hasLabel(m: V1Message, name: string): boolean {
  return labelsOf(m).some((l) => l.trim().toLowerCase() === name);
}

// Drop the redundant system `unread` label on a read message (parity with local,
// which has no such label — see mail-data-source visibleLabels()).
function visibleLabels(labels: string[], isRead: boolean): string[] {
  return isRead ? labels.filter((l) => l.trim().toLowerCase() !== "unread") : labels;
}

function v1ToTuiMessage(m: V1Message): TuiMessage {
  const isRead = Boolean(m.is_read);
  const outbound = (m.direction ?? "").toLowerCase() === "outbound";
  const attachments =
    typeof m.attachment_count === "number" ? m.attachment_count : v1AttachmentMetadata(m).length;
  return {
    kind: outbound ? "sent" : "inbound",
    id: m.id,
    from: m.from_addr ?? "",
    to: (m.to_addrs ?? []).join(", "),
    cc: (m.cc_addrs ?? []).join(", "),
    subject: m.subject || "(no subject)",
    date: messageDate(m),
    is_read: outbound ? true : isRead,
    is_starred: Boolean(m.is_starred),
    labels: visibleLabels(labelsOf(m), isRead),
    snippet: snippetOf(m.snippet ?? m.body_text),
    // The conversation this row belongs to, named the way the server names it
    // (the `thread_key` of GET /v1/messages/threads). Derived from the subject
    // the row already carries, so it costs no extra round-trip and is present on
    // list rows as well as detail reads. Null only when the subject is empty —
    // there is genuinely no conversation key then, and lumping every empty
    // subject under one id would be a fabricated grouping.
    thread_id: threadKeyOfSubject(m.subject),
    // Genuinely absent: the self-hosted store keeps no upstream/provider thread
    // id column, so there is nothing truthful to project here.
    provider_thread_id: null,
    attachments,
    sentByMe: outbound,
    // Surface the ledger truth: a row stuck in `uncertain`/`failed` must never
    // render identically to a delivered message (2026-07-25 incident).
    ...(typeof m.status === "string" && m.status ? { status: m.status } : {}),
    ...(typeof m.send_state === "string" && m.send_state ? { send_state: m.send_state } : {}),
    // And the REASON, not just the state. `blocked` alone is not actionable: the
    // send was refused by a local policy gate before any provider was contacted,
    // and until this was projected the cause was reachable only by calling
    // GET /v1/messages/{id} by hand (2026-07-27).
    ...(v1PolicyDenial(m) ? { policy_denial: v1PolicyDenial(m)! } : {}),
  };
}

/**
 * The denial code for a row, from the list column or from the detail read's
 * headers — whichever this row carries. Null when the row was not refused.
 */
function v1PolicyDenial(m: V1Message): string | null {
  const explicit = typeof m.policy_denial === "string" ? m.policy_denial.trim() : "";
  if (explicit) return explicit;
  const fromHeaders = m.headers?.["policy_denial"];
  if (typeof fromHeaders !== "string") return null;
  const trimmed = fromHeaders.trim();
  return trimmed ? trimmed : null;
}

function attachmentRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function v1AttachmentMetadata(m: V1Message): AttachmentPath[] {
  const metadata = Array.isArray(m.attachments) ? m.attachments : [];
  // `||`, not `??`: inbound MIME parts routinely carry filename="" (unnamed
  // inline parts), and an empty name is dropped by every display merge, which
  // silently shifts the download indexes of everything after it. Placeholder
  // names keep each entry addressable — same rule as db/inbound.remote.ts.
  return metadata.map((attachment, index) => {
    const record = attachmentRecord(attachment);
    return {
      filename: String(record?.filename || `attachment-${index + 1}`),
      content_type: String(record?.content_type || "application/octet-stream"),
      size: Number(record?.size ?? 0) || 0,
      // A malformed array element is an explicit non-downloadable placeholder,
      // preserving its authenticated index. A valid legacy object that omits
      // the newer verdict remains unknown so callers may probe as before.
      ...(record === null
        ? { content_available: false }
        : typeof record.content_available === "boolean"
          ? { content_available: record.content_available }
          : {}),
    };
  });
}

function v1ToMessageBody(m: V1Message): MessageBody {
  const isRead = Boolean(m.is_read);
  const flags = [...new Set([
    ...visibleLabels(labelsOf(m), isRead),
    m.is_starred ? "starred" : "",
    isRead ? "" : "unread",
  ].filter(Boolean))];
  return {
    from: m.from_addr ?? "",
    to: (m.to_addrs ?? []).join(", "),
    cc: (m.cc_addrs ?? []).join(", "),
    subject: m.subject || "(no subject)",
    date: messageDate(m),
    text: m.body_text ?? null,
    html: m.body_html ?? null,
    summary: "",
    flags,
    attachments: v1AttachmentMetadata(m),
  };
}

function v1ToThreadMessage(m: V1Message): TuiThreadMessage {
  const outbound = (m.direction ?? "").toLowerCase() === "outbound";
  return {
    kind: outbound ? "sent" : "received",
    // Same storage mapping local mode uses (data.local getConversation): a sent
    // message reads back through the sent-mail projection, everything else
    // through the inbound one. Reporting "inbound" for an outbound row made
    // threadItemToMessage() re-label our own sends as received mail.
    storage: outbound ? "email" : "inbound",
    id: m.id,
    from: m.from_addr ?? "",
    subject: m.subject || "(no subject)",
    at: messageDate(m),
  };
}

// "Already read", using the SAME rule the row projection reports as `is_read`
// (an outbound message is never unread), so `--read` can never hide a row that
// the very same listing renders as read.
function readMatch(m: V1Message): boolean {
  return (m.direction ?? "").toLowerCase() === "outbound" || Boolean(m.is_read);
}

function emptyCounts(): MailboxCounts {
  return { inbox: 0, unread: 0, starred: 0, sent: 0, archived: 0, spam: 0, trash: 0 };
}

// Which folder(s) a message belongs to (a message can count toward several).
function folderMatch(m: V1Message, folder: Mailbox): boolean {
  const outbound = (m.direction ?? "").toLowerCase() === "outbound";
  const archived = hasLabel(m, "archived");
  const spam = hasLabel(m, "spam") || (m.status ?? "").toLowerCase() === "spam";
  const trash = hasLabel(m, "trash");
  switch (folder) {
    case "inbox":
      return !outbound && !archived && !spam && !trash;
    case "unread":
      return !outbound && !m.is_read && !archived && !spam && !trash;
    case "starred":
      return !outbound && Boolean(m.is_starred) && !archived && !spam && !trash;
    case "sent":
      return outbound;
    case "archived":
      return !outbound && archived && !spam && !trash;
    case "spam":
      return !outbound && spam;
    case "trash":
      return !outbound && trash;
    default:
      return false;
  }
}

/**
 * The subset of a MailboxSource the self-hosted /v1 store can actually express.
 * `undefined` means "the whole shared store" (no narrowing).
 */
interface SelfHostedScope {
  address?: string;
  domain?: string;
}

/** Scope selectors that describe LOCAL ingestion provenance the /v1 store does not record. */
function unsupportedScopeSelectors(source: MailboxSource): string[] {
  const selectors: string[] = [];
  const providerId = source.providerId?.trim();
  const s3Bucket = source.s3Bucket?.trim();
  if (providerId) selectors.push(`--provider ${providerId}`);
  if (s3Bucket) selectors.push(`--source s3:${s3Bucket}`);
  if (source.legacy) selectors.push("--source legacy");
  return selectors;
}

/**
 * Narrow a caller's MailboxSource to what the self-hosted serve can honour.
 *
 * A /v1 message row records WHO the mail was addressed to, never which local
 * ingestion stream or provider credential carried it — that provenance only
 * exists in local mode's SQLite. Previously every such scope silently collapsed
 * to "match nothing", so `--provider <id>` printed "No mail found" and
 * `inbox mailboxes --source <id>` printed all-zero folder counts for a store
 * that was full of mail. Both are indistinguishable from a genuinely empty
 * mailbox, so they are refused with a message that says what IS supported.
 *
 * The whole-store ids this backend itself publishes (`self_hosted`, plus local
 * mode's `all`) resolve to no narrowing, so the id printed by
 * `emails inbox sources` round-trips into `--source`.
 */
function selfHostedScopeOf(source?: MailboxSource): SelfHostedScope | undefined {
  if (!source) return undefined;
  const address = source.address?.trim().toLowerCase() || undefined;
  const domain = source.domain?.trim().toLowerCase() || undefined;
  const sourceId = source.sourceId?.trim() || undefined;
  const wholeStore = !sourceId || sourceId === SELF_HOSTED_SOURCE_ID || sourceId === ALL_SOURCE_ID;

  const unsupported = unsupportedScopeSelectors(source);
  // An id that is neither a whole-store id nor a mailbox scope names an
  // ingestion source this store does not have.
  if (!wholeStore && unsupported.length === 0 && !address && !domain) {
    unsupported.push(`--source ${sourceId}`);
  }
  if (source.unknown && unsupported.length === 0) unsupported.push(`--source ${sourceId ?? "<unknown>"}`);
  if (unsupported.length > 0) {
    throw new Error(
      `Self-hosted mail is one shared store with no ingestion-source or provider provenance on its messages, `
      + `so ${unsupported.join(" and ")} cannot be applied. Scope by mailbox instead `
      + `(--address <email> or --domain <domain>), or use --source ${SELF_HOSTED_SOURCE_ID} for the whole store. `
      + "`emails inbox sources` lists the scopes this store supports.",
    );
  }
  if (!address && !domain) return undefined;
  return { ...(address ? { address } : {}), ...(domain ? { domain } : {}) };
}

function scopeMatch(m: V1Message, scope?: SelfHostedScope): boolean {
  if (!scope) return true;
  const recipients = (m.to_addrs ?? []).map(bareEmail);
  if (scope.address) return recipients.includes(scope.address) || bareEmail(m.from_addr ?? "") === scope.address;
  if (scope.domain) return recipients.some((r) => r.endsWith(`@${scope.domain}`));
  return true;
}

function scopeServerFilterSets(scope: SelfHostedScope | undefined): Array<{ to?: string; from?: string }> {
  if (scope?.address) return [{ to: scope.address }, { from: scope.address }];
  return scope?.domain ? [{ to: scope.domain }] : [{}];
}

function sanitizedAttachmentSearchText(m: V1Message): string {
  if (!Array.isArray(m.attachments)) return "";
  return m.attachments.flatMap((attachment) => {
    const record = attachmentRecord(attachment);
    const clean = (value: unknown): string =>
      typeof value === "string"
        ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim()
        : "";
    return [clean(record?.["filename"]), clean(record?.["content_type"])];
  }).filter(Boolean).join(" ");
}

function searchMatch(m: V1Message, query?: string): boolean {
  const q = query?.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    m.from_addr ?? "",
    (m.to_addrs ?? []).join(" "),
    m.subject ?? "",
    m.body_text ?? "",
    sanitizedAttachmentSearchText(m),
  ].join(" ").toLowerCase();
  return hay.includes(q);
}

// Bounded per-request timeout so a slow/unreachable self-hosted serve FAILS
// FAST instead of hanging until an external wall (the reported ">30s hang /
// timeout wall on `inbox` reads). Overridable for large stores.
function selfHostedTimeoutMs(): number {
  const raw = process.env["EMAILS_SELF_HOSTED_HTTP_TIMEOUT"];
  const seconds = raw ? Number.parseInt(raw.trim(), 10) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000;
}

export interface SelfHostedMailDataSourceOptions {
  baseUrl: string;
  apiKey: string;
  credentials?: readonly EmailsClientCredentialCandidate[];
  fetchImpl?: SelfHostedFetch;
  now?: () => number;
  /** Per-request timeout in ms (default: EMAILS_SELF_HOSTED_HTTP_TIMEOUT or 30s). */
  timeoutMs?: number;
  /** Maximum response bytes read before failing closed (default: 8 MiB). */
  maxResponseBytes?: number;
}

export class SelfHostedMailDataSource implements MailDataSource {
  readonly mode = "self_hosted" as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly credentials: readonly EmailsClientCredentialCandidate[];
  private readonly fetchImpl: SelfHostedFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private scanCache: { at: number; rows: V1Message[] } | null = null;
  private labelTallyCache: { at: number; tally: Map<string, number> } | null = null;
  private labelTallyInFlight: { generation: number; promise: Promise<{ tally: Map<string, number> }> } | null = null;
  // Fences the tally against a write that lands MID-WALK. Clearing the cache is
  // not enough on its own: a walk already in flight would still install its
  // now-stale result afterwards and serve it for a full TTL.
  private labelTallyGeneration = 0;
  private scopedCountsCache = new Map<string, { at: number; counts: MailboxCounts }>();
  private scopedCountsInFlight = new Map<string, { generation: number; promise: Promise<MailboxCounts> }>();
  // A walk that failed CLOSED is a result too, and until it was remembered here
  // it was the only outcome this class recomputed from scratch on every refresh.
  private scopedCountsFailureCache = new Map<string, { at: number; error: unknown }>();
  // Its own fence, moving in lockstep with the tally's but kept separate so the
  // shipped label path is untouched by this change.
  private scopedCountsGeneration = 0;

  constructor(options: SelfHostedMailDataSourceOptions) {
    const url = new URL(options.baseUrl);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("Self-hosted Emails requires HTTPS except for loopback development URLs.");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.credentials = options.credentials?.length
      ? options.credentials
      : [{ setting: EMAILS_SELF_HOSTED_API_KEY_ENV, value: options.apiKey }];
    this.now = options.now ?? Date.now;
    this.timeoutMs = selfHostedTransportLimit(options.timeoutMs, selfHostedTimeoutMs(), "timeoutMs");
    this.maxResponseBytes = selfHostedTransportLimit(
      options.maxResponseBytes,
      DEFAULT_SELF_HOSTED_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
    this.fetchImpl = options.fetchImpl
      ?? ((url, init) => fetch(url, init) as unknown as ReturnType<SelfHostedFetch>);
  }

  // ── transport (bearer key only in-header, never logged) ──────────────────

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    for (let index = 0; index < this.credentials.length; index += 1) {
      const candidate = this.credentials[index]!;
      const response = await this.requestOnce(candidate.value, method, path, body);
      if (index < this.credentials.length - 1 && this.shouldTryNextCredential(candidate, response)) continue;
      return response;
    }
    return this.requestOnce(this.apiKey, method, path, body);
  }

  private shouldTryNextCredential(
    candidate: EmailsClientCredentialCandidate,
    response: { status: number; json: unknown },
  ): boolean {
    return candidate.setting === EMAILS_SESSION_TOKEN_ENV
      && response.status === 401
      && this.errorReason(response.json) === "reauthenticate";
  }

  private errorReason(body: unknown): string | null {
    if (!body || typeof body !== "object") return null;
    const fields = body as { reason?: unknown; code?: unknown };
    if (typeof fields.reason === "string") return fields.reason;
    if (typeof fields.code === "string") return fields.code;
    return null;
  }

  private async requestOnce(
    credential: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential}`,
      Accept: "application/json",
    };
    // Never let fetch follow a redirect with the bearer header. `manual` keeps
    // the redirect response at this trust boundary so it can be rejected below
    // before any response body is read or a second origin is contacted.
    const init: RequestInit = { method, headers, redirect: "manual" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    // Bound the request so a slow/unreachable serve fails fast and loud rather
    // than hanging. AbortSignal.timeout aborts the underlying fetch.
    const timer = AbortSignal.timeout(this.timeoutMs);
    init.signal = timer;
    let res: Awaited<ReturnType<SelfHostedFetch>>;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (error) {
      if (timer.aborted || (error as Error)?.name === "TimeoutError" || (error as Error)?.name === "AbortError") {
        throw new Error(`self-hosted emails: ${method} ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`self-hosted emails: cannot reach ${this.baseUrl} for ${method} ${path}`);
    }
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`self-hosted emails: ${method} ${path} redirect refused`);
    }
    const text = await readSelfHostedResponseText(res, { method, path }, this.maxResponseBytes);
    let json: unknown = null;
    if (res.status >= 200 && res.status < 300) {
      json = parseSelfHostedSuccessJson(text, { status: res.status, method, path });
      validateSelfHostedMailSuccessResponse(method, path, res.status, json);
    } else {
      const parsed = parseSelfHostedErrorJson(text, {
        status: res.status,
        method,
        path,
      });
      json = projectSelfHostedMailErrorBody(method, path, res.status, parsed);
    }
    return { status: res.status, json };
  }

  private async listPage(
    limit: number,
    position: V1MessagePagePosition = {},
    opts: {
      direction?: "inbound" | "outbound";
      since?: string;
      to?: string;
      from?: string;
      subject?: string;
      search?: string;
      folder?: ServerListFolder;
    } = {},
  ): Promise<V1MessagePage> {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (position.cursor) params.set("cursor", position.cursor);
    else if (position.offset !== undefined && position.offset > 0) params.set("offset", String(position.offset));
    if (opts.folder) params.set("folder", opts.folder);
    if (opts.direction) params.set("direction", opts.direction);
    if (opts.since) params.set("since", opts.since);
    if (opts.to) params.set("to", opts.to);
    if (opts.from) params.set("from", opts.from);
    if (opts.subject) params.set("subject", opts.subject);
    if (opts.search) params.set("search", opts.search);
    const { status, json } = await this.request("GET", `/messages?${params.toString()}`);
    if (status < 200 || status >= 300) {
      throw new Error(`self-hosted emails: GET /messages failed (HTTP ${status})`);
    }
    const body = json as { messages?: unknown; next_cursor?: unknown } | null;
    const messages = Array.isArray(body?.messages) ? (body.messages as V1Message[]) : [];
    const nextCursor = body?.next_cursor;
    if (nextCursor === undefined) return { messages, nextCursor };
    if (nextCursor !== null && !validServerCursor(nextCursor)) {
      throw new Error("self-hosted emails: GET /messages returned a malformed next_cursor");
    }
    return { messages, nextCursor };
  }

  private async *listPages(
    limit: number,
    opts: {
      direction?: "inbound" | "outbound";
      since?: string;
      to?: string;
      from?: string;
      subject?: string;
      search?: string;
      folder?: ServerListFolder;
    } = {},
  ): AsyncGenerator<V1Message[]> {
    let cursor: string | undefined;
    let legacyOffset: number | undefined;
    let consumedRows = 0;
    let cycle = emptyCursorCycleState();
    let pageCount = 0;
    while (true) {
      const page = await this.listPage(limit, { cursor, offset: legacyOffset }, opts);
      const consumedAfterPage = consumedRows + page.messages.length;

      // Validate the continuation before exposing the page to a consumer.
      // This is especially important for destructive consumers such as clear().
      if (page.nextCursor === undefined
        && page.messages.length === limit
        && consumedAfterPage > LEGACY_MAX_OFFSET
      ) {
        throw new Error(
          "self-hosted emails: legacy pagination reached offset cap 100000 on a full page; "
          + "upgrade the server to cursor pagination instead of accepting partial results",
        );
      }
      const hasContinuation = typeof page.nextCursor === "string"
        || (page.nextCursor === undefined && page.messages.length === limit);
      const continuationPageCount = hasContinuation
        ? nextCursorPageCount(pageCount)
        : pageCount;
      if (typeof page.nextCursor === "string") {
        cycle = advanceCursorCycle(cycle, page.nextCursor);
      }

      yield page.messages;
      consumedRows = consumedAfterPage;
      pageCount = continuationPageCount;

      if (page.nextCursor === null) return;
      if (typeof page.nextCursor === "string") {
        cursor = page.nextCursor;
        legacyOffset = undefined;
        continue;
      }
      if (page.messages.length < limit) return;
      cursor = undefined;
      legacyOffset = consumedRows;
    }
  }

  private async serverStats(): Promise<{ counts: MailboxCounts; total: number; latestReceivedAt: string | null }> {
    const { status, json } = await this.request("GET", "/messages/counts");
    if (status < 200 || status >= 300) {
      throw new Error(`self-hosted emails: GET /messages/counts failed (HTTP ${status})`);
    }
    const body = ((json as { counts?: unknown } | null)?.counts ?? json) as Record<string, unknown> | null;
    const number = (key: string): number => {
      const raw = body?.[key];
      const parsed = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      counts: {
        inbox: number("inbox"),
        unread: number("unread"),
        starred: number("starred"),
        sent: number("sent"),
        archived: number("archived"),
        spam: number("spam"),
        trash: number("trash"),
      },
      total: number("total"),
      latestReceivedAt: typeof body?.["latest_received_at"] === "string" ? body["latest_received_at"] : null,
    };
  }

  private async searchMatchWithDetails(message: V1Message, search: string | undefined): Promise<{ message: V1Message; matches: boolean }> {
    let candidate = message;
    let matches = searchMatch(candidate, search);
    const attachmentMetadata = Array.isArray(message.attachments) ? message.attachments : [];
    const attachmentMetadataCount = attachmentMetadata.length;
    const attachmentSearchMetadataComplete = attachmentMetadata.every((attachment) => {
      const record = attachmentRecord(attachment);
      return typeof record?.["filename"] === "string" && typeof record["content_type"] === "string";
    });
    const attachmentMetadataComplete =
      message.attachment_count === 0
      || (typeof message.attachment_count === "number"
        && attachmentMetadataCount >= message.attachment_count
        && attachmentSearchMetadataComplete)
      || (message.attachment_count === undefined
        && Array.isArray(message.attachments)
        && attachmentSearchMetadataComplete);
    if (!matches && search?.trim() && (message.body_text == null || !attachmentMetadataComplete)) {
      candidate = (await this.getRaw(message.id)) ?? message;
      matches = searchMatch(candidate, search);
    }
    return { message: candidate, matches };
  }

  // Full, TTL-cached cursor walk. Writes invalidate it. Legacy offset servers
  // fail closed at their 100000-row ceiling inside listPages().
  private async scanAll(): Promise<V1Message[]> {
    const cached = this.scanCache;
    if (cached && this.now() - cached.at < SCAN_TTL_MS) return cached.rows;
    const rows: V1Message[] = [];
    for await (const page of this.listPages(PAGE_LIMIT)) {
      if (rows.length + page.length > MAX_SCAN_ROWS) {
        throw new Error(
          `self-hosted emails: full-store scan exceeded the ${MAX_SCAN_ROWS}-row safety limit`,
        );
      }
      rows.push(...page);
    }
    this.scanCache = { at: this.now(), rows };
    return rows;
  }

  private invalidate(): void {
    this.scanCache = null;
    // Labelling a message changes the tally, so a write must drop it too — and
    // must also fence any walk currently in flight, whose rows predate this
    // write. Without the generation bump that walk would install a stale tally
    // the moment it finished and serve it for a full TTL.
    this.labelTallyCache = null;
    this.labelTallyGeneration += 1;
    // Every write this class performs can move a message between folders, so the
    // scoped counts must drop too — and any counting walk already in flight must
    // be fenced, since its pages predate this write.
    this.scopedCountsCache.clear();
    // A remembered failure must drop on the same write, or a clear() or a move
    // that makes the scope countable again keeps reporting the old failure for
    // the rest of its (deliberately long) window.
    this.scopedCountsFailureCache.clear();
    this.scopedCountsGeneration += 1;
  }

  private async listFilteredMailboxPage(mailbox: Mailbox, scope: SelfHostedScope | undefined, opts?: MailboxListOptions): Promise<V1Message[]> {
    const offset = opts?.offset && opts.offset > 0 ? opts.offset : 0;
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 200;
    const wanted = offset + limit;
    const pageLimit = Math.min(PAGE_LIMIT, Math.max(50, wanted));
    const direction = mailbox === "sent" ? "outbound" : "inbound";
    const since = normalizeSince(opts?.since);
    const label = opts?.label?.trim().toLowerCase();
    const matchesLocally = async (message: V1Message): Promise<V1Message | null> => {
      if (!folderMatch(message, mailbox)
        || !scopeMatch(message, scope)
        || !isOnOrAfter(message, since)
        || (opts?.read === true && !readMatch(message))
        || (label && !labelsOf(message).some((value) => value.trim().toLowerCase() === label))
      ) return null;
      const { message: candidate, matches } = await this.searchMatchWithDetails(message, opts?.search);
      return matches ? candidate : null;
    };

    // One request budget for the whole call, across every filter set and both
    // sort branches. Only reachable when the server ignores the `?folder=`
    // pushdown (see MAX_FILTER_WALK_REQUESTS): the alternative was the shipped
    // behaviour — a silent, store-wide, 50-rows-per-request walk that made
    // `inbox list --folder starred` look like a hang against a six-figure store
    // (task a3f8e019).
    let walkRequests = 0;
    let scannedRows = 0;
    const budgeted = async function* (this: SelfHostedMailDataSource, requestLimit: number, requestOpts: Parameters<SelfHostedMailDataSource["listPage"]>[2]): AsyncGenerator<V1Message[]> {
      for await (const page of this.listPages(requestLimit, requestOpts)) {
        walkRequests += 1;
        if (walkRequests > MAX_FILTER_WALK_REQUESTS) throw filterWalkExhausted(mailbox, scannedRows);
        scannedRows += page.length;
        yield page;
      }
    }.bind(this);
    const folder = serverListFolderOf(mailbox);

    if (opts?.sort === "oldest") {
      // The server is newest-first. Retain only the request-bounded oldest tail
      // while walking the cursor chain, never the whole mailbox.
      const tail: V1Message[] = [];
      const filters = scopeServerFilterSets(scope);
      // Address scopes need a to/from union. A single unfiltered cursor walk
      // preserves global ordering and avoids duplicate rows across that union.
      const sourceFilters = filters.length > 1 ? [{}] : filters;
      for (const filtersForRequest of sourceFilters) {
        for await (const page of budgeted(PAGE_LIMIT, {
          folder,
          direction,
          since,
          ...filtersForRequest,
          search: opts?.search,
        })) {
          for (const message of page) {
            const candidate = await matchesLocally(message);
            if (candidate) tail.push(candidate);
          }
          if (tail.length > wanted) {
            tail.splice(0, tail.length - wanted);
          }
        }
      }
      return tail
        .slice(-wanted)
        .sort((a, b) => messageDate(a).localeCompare(messageDate(b)))
        .slice(offset, offset + limit);
    }

    const matches = new Map<string, V1Message>();
    for (const sourceFilters of scopeServerFilterSets(scope)) {
      let filterMatches = 0;
      for await (const page of budgeted(pageLimit, {
          folder,
          direction,
          since,
          ...sourceFilters,
          search: opts?.search,
      })) {
        for (const message of page) {
          const candidate = await matchesLocally(message);
          if (candidate) {
            if (!matches.has(candidate.id)) filterMatches += 1;
            matches.set(candidate.id, candidate);
          }
        }
        if (filterMatches >= wanted) break;
      }
    }
    return [...matches.values()]
      .sort((a, b) => messageDate(b).localeCompare(messageDate(a)))
      .slice(offset, offset + limit);
  }

  private async scanScopeRows(scope?: SelfHostedScope): Promise<V1Message[]> {
    if (!scope) return this.scanAll();

    const seen = new Map<string, V1Message>();
    const collect = async (filters: { direction?: "inbound" | "outbound"; to?: string; from?: string }) => {
      for await (const page of this.listPages(PAGE_LIMIT, filters)) {
        for (const message of page) {
          if (scopeMatch(message, scope)) seen.set(message.id, message);
        }
        if (seen.size > MAX_SCAN_ROWS) {
          throw new Error(
            `self-hosted emails: scoped scan exceeded the ${MAX_SCAN_ROWS}-row safety limit`,
          );
        }
      }
    };

    for (const filters of scopeServerFilterSets(scope)) await collect(filters);

    return [...seen.values()];
  }

  /**
   * Every message in the conversation `target` belongs to, oldest first.
   *
   * Two grouping rules, both grounded in data the serve actually returns:
   *  1. the normalized subject key — the server's OWN conversation key (see
   *     threadKeyOfSubject / store.listThreads), and
   *  2. the RFC 5322 Message-ID <-> In-Reply-To links carried on every row, which
   *     keep a reply attached even when its subject was edited.
   *
   * Candidates are narrowed SERVER-side by `?subject=` (a case-folded substring
   * match, so it over-fetches "Re: …" and near-misses; LIKE metacharacters in a
   * subject can only widen it further), then filtered here on exact key
   * equality. That keeps one conversation read at one or two requests instead of
   * the full-store scan the label/oldest paths pay.
   *
   * A message with an empty subject has no conversation key at all, so it stands
   * alone — collapsing every empty-subject message into one thread would be a
   * fabrication, not a thread.
   */
  private async conversationRows(target: V1Message): Promise<V1Message[]> {
    const key = threadKeyOfSubject(target.subject);
    const members = new Map<string, V1Message>([[target.id, target]]);
    if (!key) return [...members.values()];

    const candidates: V1Message[] = [];
    for await (const page of this.listPages(PAGE_LIMIT, { subject: key })) {
      candidates.push(...page);
      if (candidates.length >= MAX_THREAD_CANDIDATE_ROWS) {
        candidates.length = MAX_THREAD_CANDIDATE_ROWS;
        break;
      }
    }

    const unlinked: V1Message[] = [];
    for (const candidate of candidates) {
      if (candidate.id === target.id) continue;
      if (threadKeyOfSubject(candidate.subject) === key) members.set(candidate.id, candidate);
      else unlinked.push(candidate);
    }

    // Reference closure over the rows the subject read did NOT already claim: a
    // reply whose subject was rewritten still points at a member's Message-ID.
    // Runs to a fixpoint — one pass per link depth — bounded by the candidate
    // count so a pathological chain cannot spin.
    for (let pass = 0, remaining = unlinked.length; pass <= remaining && unlinked.length > 0; pass += 1) {
      const memberMessageIds = new Set<string>();
      const memberParentIds = new Set<string>();
      for (const member of members.values()) {
        const own = bareMessageId(member.message_id);
        if (own) memberMessageIds.add(own);
        const parent = bareMessageId(member.in_reply_to);
        if (parent) memberParentIds.add(parent);
      }
      let added = false;
      for (let index = unlinked.length - 1; index >= 0; index -= 1) {
        const candidate = unlinked[index]!;
        const own = bareMessageId(candidate.message_id);
        const parent = bareMessageId(candidate.in_reply_to);
        if ((parent && memberMessageIds.has(parent)) || (own && memberParentIds.has(own))) {
          members.set(candidate.id, candidate);
          unlinked.splice(index, 1);
          added = true;
        }
      }
      if (!added) break;
    }

    return [...members.values()].sort((a, b) => messageDate(a).localeCompare(messageDate(b)));
  }

  private async getRaw(id: string): Promise<V1Message | null> {
    const { status, json } = await this.request("GET", `/messages/${encodeURIComponent(id)}`);
    if (status === 404) return null;
    // The server resolves an id PREFIX and 409s when the prefix is not unique.
    if (status === 409) {
      throw new Error(`Ambiguous email id prefix '${id}' — it matches multiple messages. Use a longer id.`);
    }
    if (status < 200 || status >= 300) {
      throw new Error(`self-hosted emails: GET /messages/<id> failed (HTTP ${status})`);
    }
    const wrapped = (json as { message?: V1Message } | null)?.message;
    return wrapped ?? (json && typeof json === "object" ? (json as V1Message) : null);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async resolveId(id: string): Promise<string> {
    const trimmed = id.trim();
    if (FULL_ID_RE.test(trimmed)) return trimmed;
    // The server resolves an id PREFIX itself now (indexed, tenant-scoped), so a
    // single GET replaces the old full-inbox scanAll() that made short-id reads
    // take minutes: a hit returns the canonical full id; a miss (404 -> null)
    // hands back the original so the caller's fetch returns a clean not-found.
    // An ambiguous prefix (409) throws from getRaw with a "use a longer id" hint.
    const m = await this.getRaw(trimmed);
    return m ? m.id : trimmed;
  }

  async listMailbox(mailbox: Mailbox, opts?: MailboxListOptions): Promise<TuiMessage[]> {
    const scope = selfHostedScopeOf(opts?.source);
    return (await this.listFilteredMailboxPage(mailbox, scope, opts)).map(v1ToTuiMessage);
  }

  /**
   * Folder counts for ONE scope, tallied as the pages arrive.
   *
   * Deliberately not `scanScopeRows` (see MAX_SCOPED_COUNT_REQUESTS above):
   * that helper is the destructive clear()'s preflight and must stay exact,
   * uncached and complete. This one also never RETAINS the rows — counting needs
   * a tally and, for the to/from union, the ids already seen; materialising every
   * message of a six-figure mailbox into an array was most of this path's cost.
   */
  private async scopedCounts(scope: SelfHostedScope): Promise<MailboxCounts> {
    const key = scopedCountsKey(scope);
    const generation = this.scopedCountsGeneration;
    const cached = this.scopedCountsCache.get(key);
    if (cached && this.now() - cached.at < SCOPED_COUNT_TTL_MS) return { ...cached.counts };
    // A remembered failure is re-thrown as the ORIGINAL error, not a fresh one
    // wrapped in "(cached)": its text already names both causes and both
    // remedies, and that advice is exactly as true the second time. Rewording it
    // per-hit would drift the message that the sibling walks' errors are matched
    // against, to tell the reader something they cannot act on differently.
    const failed = this.scopedCountsFailureCache.get(key);
    if (failed && this.now() - failed.at < SCOPED_COUNT_FAILURE_TTL_MS) throw failed.error;
    // Coalesce: the TUI starts a new sidebar load every 30s without awaiting the
    // previous one, so without this the walks stack instead of replacing one
    // another — the accumulation behind the climbing idle CPU. A walk from an
    // OLDER generation is not joinable, because its pages predate a write.
    const inFlight = this.scopedCountsInFlight.get(key);
    if (inFlight && inFlight.generation === generation) return { ...(await inFlight.promise) };

    const walk = (async () => {
      const counts = emptyCounts();
      const seen = new Set<string>();
      try {
        for (const filters of scopeServerFilterSets(scope)) {
          // PER FILTER SET, not across the union. An address scope reads the same
          // store twice (?to= then ?from=) and today's bound counts DEDUPED
          // matches, so a store of 60_000 rows read twice is 60_000 against that
          // bound and would be 120_000 against a shared one — which would have
          // thrown on a store that completes today. Each set gets the same
          // MAX_SCAN_ROWS headroom the single-scan path already has.
          let requests = 0;
          let scannedRows = 0;
          for await (const page of this.listPages(PAGE_LIMIT, filters)) {
            requests += 1;
            scannedRows += page.length;
            if (scannedRows > MAX_SCAN_ROWS || requests > MAX_SCOPED_COUNT_REQUESTS) {
              throw scopedCountWalkExhausted(scannedRows, requests);
            }
            for (const message of page) {
              // An address scope is a union of two server reads, so the same
              // message can arrive twice; count it once.
              if (!scopeMatch(message, scope) || seen.has(message.id)) continue;
              seen.add(message.id);
              for (const folder of MAILBOXES) {
                if (folderMatch(message, folder)) counts[folder] += 1;
              }
            }
          }
        }
      } catch (error) {
        // Remembered under the SAME generation fence the success path uses: a
        // write that landed mid-walk may be exactly what makes this scope
        // countable again, so a failure from before it must not be installed.
        if (this.scopedCountsGeneration === generation) {
          this.scopedCountsFailureCache.set(key, { at: this.now(), error });
        }
        throw error;
      }
      // Only install if no write landed while this walk was running: those pages
      // are already stale, and caching them would serve pre-write counts for a
      // full TTL.
      if (this.scopedCountsGeneration === generation) this.scopedCountsCache.set(key, { at: this.now(), counts });
      return counts;
    })();

    const pending = { generation, promise: walk };
    this.scopedCountsInFlight.set(key, pending);
    try {
      // Copied on the way out so a caller holding the result cannot mutate the
      // cached entry that later callers will be served.
      return { ...(await walk) };
    } finally {
      // Never clear a NEWER walk that replaced this one after an invalidate.
      if (this.scopedCountsInFlight.get(key) === pending) this.scopedCountsInFlight.delete(key);
    }
  }

  async mailboxCounts(opts?: { source?: MailboxSource }): Promise<MailboxCounts> {
    const scope = selfHostedScopeOf(opts?.source);
    // The whole store has an exact server-side aggregate; only a scope has to be
    // counted client-side, because /v1/messages/counts takes no recipient filter.
    if (!scope) return (await this.serverStats()).counts;
    return this.scopedCounts(scope);
  }

  async listMailboxStatus(opts?: MailboxStatusOptions): Promise<MailboxStatusSummary> {
    const counts = await this.mailboxCounts({ source: opts?.source });
    return {
      counts,
      folders: MAILBOXES.map((folder) => ({
        id: folder,
        folder,
        label: mailboxLabel(folder),
        count: counts[folder],
      })),
    };
  }

  async listMailboxSources(opts?: ListMailboxSourcesOptions): Promise<MailboxSourceSummary[]> {
    // The self-hosted serve is a single shared store — expose it as one source so
    // `inbox sources` / status are informative rather than empty.
    const { counts, latestReceivedAt } = await this.serverStats();
    const receivedTotal = counts.inbox + counts.archived + counts.spam + counts.trash;
    const sources: MailboxSourceSummary[] = [{
      id: SELF_HOSTED_SOURCE_ID,
      label: "Self-hosted Emails",
      kind: "all",
      badges: ["self_hosted"],
      counts,
      total: receivedTotal,
      unread: counts.unread,
      latestReceivedAt,
    }];
    // `--search` / `--limit` are honoured over the same fields local mode matches
    // (data.local listMailboxSources), so a caller that filters gets a filtered
    // list rather than the full one served back unchanged.
    const query = opts?.search?.trim().toLowerCase();
    const filtered = query
      ? sources.filter((source) => [source.id, source.label, source.kind, ...source.badges]
        .some((value) => String(value ?? "").toLowerCase().includes(query)))
      : sources;
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 100;
    return filtered.slice(0, limit);
  }

  async getMessage(id: string): Promise<TuiMessage | null> {
    const m = await this.getRaw(id);
    return m ? v1ToTuiMessage(m) : null;
  }

  async getMessageBody(msg: TuiMessage): Promise<MessageBody | null> {
    const m = await this.getRaw(msg.id);
    return m ? v1ToMessageBody(m) : null;
  }

  // Fetch a message AND its body from a SINGLE row read. A `read` needs both, and
  // the raw row already carries the body, so this collapses the old
  // getMessage()+getMessageBody() double round-trip into one. The `id` may be a
  // short prefix — the server resolves it — so `read <shortid>` is one GET.
  async getMessageWithBody(id: string): Promise<{ msg: TuiMessage; body: MessageBody } | null> {
    const m = await this.getRaw(id);
    return m ? { msg: v1ToTuiMessage(m), body: v1ToMessageBody(m) } : null;
  }

  async getConversation(msg: TuiMessage): Promise<TuiThreadMessage[]> {
    const m = await this.getRaw(msg.id);
    if (!m) return [];
    return (await this.conversationRows(m)).map(v1ToThreadMessage);
  }

  async getConversationBodies(msg: TuiMessage, opts?: ConversationBodyOptions): Promise<TuiThreadBody[]> {
    const m = await this.getRaw(msg.id);
    if (!m) return [];
    const rows = await this.conversationRows(m);
    // Same windowing as local mode: `limit` keeps the NEWEST N of the thread
    // (data.local getConversationBodies), because a conversation is read from
    // its most recent turn backwards.
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : undefined;
    const windowed = limit && rows.length > limit ? rows.slice(-limit) : rows;
    const bodies: TuiThreadBody[] = [];
    for (const row of windowed) {
      // List rows carry no body; re-read only the rows in the window.
      const full = row.body_text == null && row.body_html == null ? (await this.getRaw(row.id)) ?? row : row;
      bodies.push({ item: v1ToThreadMessage(full), body: v1ToMessageBody(full) });
    }
    return bodies;
  }

  async getAttachmentPaths(id: string): Promise<AttachmentPath[]> {
    const message = await this.getRaw(id);
    return message ? v1AttachmentMetadata(message) : [];
  }

  async getAttachmentContent(id: string, index: number, opts?: { maxBytes?: number }): Promise<AttachmentContent> {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("attachment index must be a non-negative integer");
    const maxBytes = normalizeAttachmentByteLimit(opts?.maxBytes);
    const { status, json } = await this.request(
      "GET",
      `/messages/${encodeURIComponent(id)}/attachments/${index}?max_bytes=${maxBytes}`,
    );
    if (status === 404) return decodeAttachmentPayload({ code: "attachment_not_found" }, index, maxBytes);
    if (status === 409) return decodeAttachmentPayload(json, index, maxBytes);
    if (status < 200 || status >= 300) {
      const body = json && typeof json === "object" ? json as Record<string, unknown> : {};
      throw new Error(`self-hosted emails: attachment download failed (HTTP ${status}, ${String(body["code"] ?? "unknown_error")})`);
    }
    return decodeAttachmentPayload(json, index, maxBytes);
  }

  // The tally is store-wide and option-independent — `search` and `limit` are
  // applied to its OUTPUT — so one cached tally serves every caller, whatever
  // options they pass.
  private async labelTally(): Promise<{ tally: Map<string, number> }> {
    const generation = this.labelTallyGeneration;
    const cached = this.labelTallyCache;
    if (cached && this.now() - cached.at < LABEL_TALLY_TTL_MS) return cached;
    // Coalesce: the TUI starts a new sidebar load every 30s without awaiting the
    // previous one. Without this, those calls each open their own cursor walk and
    // the walks stack up instead of replacing one another. A walk from an OLDER
    // generation is not joinable — its rows predate a write — so a caller after
    // an invalidate starts a fresh walk rather than inheriting stale counts.
    const inFlight = this.labelTallyInFlight;
    if (inFlight && inFlight.generation === generation) return inFlight.promise;

    const walk = (async () => {
      const tally = new Map<string, number>();
      let requests = 0;
      for await (const page of this.listPages(PAGE_LIMIT)) {
        requests += 1;
        for (const m of page) {
          for (const raw of labelsOf(m)) {
            const name = raw.trim();
            if (!name) continue;
            tally.set(name, (tally.get(name) ?? 0) + 1);
          }
        }
        // Stop at the budget rather than throwing: this is sidebar metadata, so
        // it must degrade to a recent-window sample, never break the sidebar.
        if (requests >= MAX_LABEL_SCAN_REQUESTS) break;
      }
      const entry = { at: this.now(), tally };
      // Only install if no write landed while this walk was running. Otherwise
      // these rows are already stale and caching them would serve pre-write
      // counts for a full TTL.
      if (this.labelTallyGeneration === generation) this.labelTallyCache = entry;
      return entry;
    })();

    const pending = { generation, promise: walk };
    this.labelTallyInFlight = pending;
    try {
      return await walk;
    } finally {
      // Never clear a NEWER walk that replaced this one after an invalidate.
      if (this.labelTallyInFlight === pending) this.labelTallyInFlight = null;
    }
  }

  async listLabelSummaries(opts?: ListLabelSummaryOptions): Promise<LabelSummary[]> {
    const { tally } = await this.labelTally();
    const search = opts?.search?.trim().toLowerCase();
    let summaries: LabelSummary[] = [...tally.entries()]
      .filter(([name]) => !search || name.toLowerCase().includes(search))
      .map(([name, count]) => ({ name, count, popular: count >= 5 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    if (opts?.limit && opts.limit > 0) summaries = summaries.slice(0, opts.limit);
    return summaries;
  }

  async verificationCandidates(address: string, opts?: VerificationCodeCandidateOptions): Promise<VerificationCodeEmail[]> {
    const target = address.trim().toLowerCase();
    const since = normalizeSince(opts?.since);
    const fromFilter = opts?.from?.trim().toLowerCase();
    const subjectFilter = opts?.subject?.trim().toLowerCase();
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 50;
    const candidates: V1Message[] = [];
    const pageLimit = Math.min(PAGE_LIMIT, Math.max(50, limit));
    candidatePages:
    for await (const page of this.listPages(pageLimit, {
        direction: "inbound",
        to: target,
        since,
        from: opts?.from,
        subject: opts?.subject,
      })) {
      for (const message of page) {
        if ((message.direction ?? "").toLowerCase() === "outbound") continue;
        if (!(message.to_addrs ?? []).map(bareEmail).includes(target)) continue;
        if (!isOnOrAfter(message, since)) continue;
        if (fromFilter && !(message.from_addr ?? "").toLowerCase().includes(fromFilter)) continue;
        if (subjectFilter && !(message.subject ?? "").toLowerCase().includes(subjectFilter)) continue;
        candidates.push(message);
        if (candidates.length >= limit) break candidatePages;
      }
    }
    const detailed: V1Message[] = [];
    for (const candidate of candidates.slice(0, limit)) {
      detailed.push((await this.getRaw(candidate.id)) ?? candidate);
    }
    return detailed.map((m) => ({
      id: m.id,
      from_address: m.from_addr ?? "",
      subject: m.subject ?? "",
      text_body: m.body_text ?? null,
      html_body: m.body_html ?? null,
      received_at: messageDate(m),
    }));
  }

  async findLatest(
    address: string,
    opts?: VerificationCodeCandidateOptions & { from?: string; subject?: string },
  ): Promise<VerificationCodeMatch<VerificationCodeEmail> | null> {
    const candidates = await this.verificationCandidates(address, opts);
    return findVerificationCode(candidates, { from: opts?.from, subject: opts?.subject });
  }

  async listInsertionsSince(opts?: MailInsertionsQuery): Promise<MailInsertionsPage> {
    const requestedSince = normalizeSince(opts?.receivedSince);
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : undefined;
    const messages: V1Message[] = [];
    const decodedCursor = opts?.cursor ? decodeMailChangesCursor(opts.cursor) : null;
    const rawCursor = !decodedCursor && opts?.cursor
      ? validateRawChangesCursor(opts.cursor)
      : undefined;
    let cursor = decodedCursor?.serverCursor ?? rawCursor;
    let legacyOffset = decodedCursor?.serverCursor === null ? decodedCursor.offset ?? undefined : undefined;
    let consumedRows: number | null = decodedCursor ? decodedCursor.offset : rawCursor ? null : 0;
    const since = decodedCursor ? decodedCursor.since ?? undefined : requestedSince;
    if (decodedCursor
      && requestedSince !== undefined
      && requestedSince !== decodedCursor.since
    ) {
      throw new Error(
        "self-hosted emails: receivedSince must match the value bound to the insertion cursor",
      );
    }
    let nextCursor: string | null = null;
    let cycle: CursorCycleState = decodedCursor
      ? {
          cycleAnchor: decodedCursor.cycleAnchor,
          cyclePower: decodedCursor.cyclePower,
          cycleLength: decodedCursor.cycleLength,
        }
      : emptyCursorCycleState();
    let pageCount = decodedCursor?.pageCount ?? 0;
    if (rawCursor) cycle = advanceCursorCycle(cycle, rawCursor);
    while (true) {
      const remaining = limit === undefined ? PAGE_LIMIT : Math.max(1, limit - messages.length);
      const pageLimit = Math.min(PAGE_LIMIT, remaining);
      const page = await this.listPage(pageLimit, { cursor, offset: legacyOffset }, { since });
      const consumedAfterPage = consumedRows === null ? null : consumedRows + page.messages.length;

      if (page.nextCursor === undefined && page.messages.length === pageLimit) {
        if (rawCursor) {
          throw new Error(
            "self-hosted emails: raw cursor pagination returned a full page without next_cursor; "
            + "upgrade the server or rerun without cursor because the traversal depth is unknown",
          );
        }
        if (consumedAfterPage === null) {
          throw new Error(
            "self-hosted emails: a legacy page omitted next_cursor after a raw server cursor; "
            + "restart the scan without that cursor or upgrade the server",
          );
        }
        if (consumedAfterPage > LEGACY_MAX_OFFSET) {
          throw new Error(
            "self-hosted emails: legacy pagination reached offset cap 100000 on a full page; "
            + "upgrade the server to cursor pagination instead of accepting partial results",
          );
        }
      }

      for (const message of page.messages) {
        if (!isOnOrAfter(message, since)) continue;
        messages.push(message);
      }
      consumedRows = consumedAfterPage;

      let nextServerCursor: string | undefined;
      let nextLegacyOffset: number | undefined;
      if (typeof page.nextCursor === "string") {
        cycle = advanceCursorCycle(cycle, page.nextCursor);
        nextServerCursor = page.nextCursor;
      } else if (page.nextCursor === undefined && page.messages.length === pageLimit) {
        nextLegacyOffset = consumedRows ?? undefined;
      }

      const hasContinuation = nextServerCursor !== undefined || nextLegacyOffset !== undefined;
      if (!hasContinuation) {
        nextCursor = null;
        break;
      }
      const continuationPageCount = nextCursorPageCount(pageCount);
      nextCursor = encodeMailChangesCursor({
        serverCursor: nextServerCursor ?? null,
        ...cycle,
        pageCount: continuationPageCount,
        offset: consumedRows,
        since: since ?? null,
      });
      if (limit !== undefined && messages.length >= limit) break;

      cursor = nextServerCursor;
      legacyOffset = nextLegacyOffset;
      pageCount = continuationPageCount;
    }
    messages.sort((a, b) => messageDate(a).localeCompare(messageDate(b)));
    return {
      semantics: "insert_only",
      insertions: messages.map(v1ToTuiMessage),
      cursor: nextCursor,
    };
  }

  // ── writes ─────────────────────────────────────────────────────────────

  // Mailbox mutations are persisted by the self-hosted serve.
  async setRead(id: string, read: boolean): Promise<void> {
    this.invalidate();
    const { status } = await this.request("PATCH", `/messages/${encodeURIComponent(id)}`, { is_read: read });
    if (status < 200 || status >= 300) throw new Error(`self-hosted emails: mark read failed (HTTP ${status})`);
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    this.invalidate();
    const { status } = await this.request("PATCH", `/messages/${encodeURIComponent(id)}`, { archived });
    if (status < 200 || status >= 300) throw new Error(`self-hosted emails: archive update failed (HTTP ${status})`);
  }

  async setStarred(id: string, starred: boolean): Promise<void> {
    this.invalidate();
    const { status } = await this.request("PATCH", `/messages/${encodeURIComponent(id)}`, { is_starred: starred });
    if (status < 200 || status >= 300) throw new Error(`self-hosted emails: star update failed (HTTP ${status})`);
  }

  async addLabel(id: string, label: string): Promise<string[]> {
    this.invalidate();
    const { status, json } = await this.request("PATCH", `/messages/${encodeURIComponent(id)}`, { add_label: label });
    if (status < 200 || status >= 300) throw new Error(`self-hosted emails: add label failed (HTTP ${status})`);
    return labelsOf((json as { message?: V1Message } | null)?.message ?? {} as V1Message);
  }

  async removeLabel(id: string, label: string): Promise<string[]> {
    this.invalidate();
    const { status, json } = await this.request("PATCH", `/messages/${encodeURIComponent(id)}`, { remove_label: label });
    if (status < 200 || status >= 300) throw new Error(`self-hosted emails: remove label failed (HTTP ${status})`);
    return labelsOf((json as { message?: V1Message } | null)?.message ?? {} as V1Message);
  }

  async deleteMessage(id: string): Promise<void> {
    this.invalidate();
    const { status } = await this.request("DELETE", `/messages/${encodeURIComponent(id)}`);
    if (status !== 404 && (status < 200 || status >= 300)) {
      throw new Error(`self-hosted emails: DELETE /messages/<id> failed (HTTP ${status})`);
    }
  }

  async bulk(input: MailBulkInput): Promise<MailBulkResult> {
    const action = input.action;
    const ids = input.ids ?? [];
    let affected = 0;
    for (const id of ids) {
      if (action === "delete") await this.deleteMessage(id);
      else if (action === "read") await this.setRead(id, true);
      else if (action === "unread") await this.setRead(id, false);
      else if (action === "archive") await this.setArchived(id, true);
      else if (action === "unarchive") await this.setArchived(id, false);
      else if (action === "star") await this.setStarred(id, true);
      else if (action === "unstar") await this.setStarred(id, false);
      else if (action === "label" && input.label) await this.addLabel(id, input.label);
      else if (action === "unlabel" && input.label) await this.removeLabel(id, input.label);
      else throw new Error(`Bulk '${action}' is not supported on the self-hosted emails serve.`);
      affected += 1;
    }
    return { action, affected, matched: ids.length, hasMore: false, nextCursor: null };
  }

  async send(input: MailSendInput): Promise<MailSendResult> {
    if (input.scheduledAt) {
      throw new Error("Scheduled send is not supported on the self-hosted emails serve.");
    }
    if (input.providerId) {
      // The /v1 send contract has no provider selector: the server sends with
      // the single operator-configured provider (EMAILS_SEND_PROVIDER + its
      // server-side credentials). Accepting the flag and ignoring it made an
      // operator believe mail had been re-routed to another SES account when it
      // had not.
      throw new Error(
        "--provider is not supported in self_hosted mode: the server selects the outbound provider "
          + "(EMAILS_SEND_PROVIDER) and holds its credentials. Re-run without --provider.",
      );
    }
    if (input.unsubscribeUrl) {
      // Same class as --provider above: the POST /v1/messages/send contract carries
      // no unsubscribe_url field, so the RFC 8058 List-Unsubscribe headers cannot be
      // honored on this path. Accepting the flag and mailing WITHOUT the headers is
      // a compliance failure the operator cannot see — refuse before the request.
      throw new Error(
        "--unsubscribe-url is not supported against the emails serve send API: its send contract "
          + "carries no unsubscribe_url field, so the List-Unsubscribe headers would be silently "
          + "dropped. Re-run without --unsubscribe-url, or send through a local provider.",
      );
    }
    const to = input.to.split(",").map((v) => v.trim()).filter(Boolean);
    const useMarkdown = input.markdown !== false;
    const html = input.html ?? (useMarkdown ? renderMarkdown(input.body) : undefined);
    const body: Record<string, unknown> = {
      from: input.from,
      to,
      subject: input.subject,
      text: input.body,
      html,
      idempotency_key: input.idempotencyKey ?? crypto.randomUUID(),
    };
    if (input.attachments?.length) body["attachments"] = input.attachments;
    if (input.cc) body["cc"] = input.cc.split(",").map((v) => v.trim()).filter(Boolean);
    if (input.bcc) body["bcc"] = input.bcc.split(",").map((v) => v.trim()).filter(Boolean);
    if (input.replyTo) body["reply_to"] = input.replyTo;
    this.invalidate();
    const { status, json } = await this.request("POST", "/messages/send", body);
    const payload = (json ?? {}) as {
      message?: V1Message;
      error?: unknown;
      warning?: unknown;
      sent?: unknown;
      in_progress?: unknown;
      provider_message_id?: unknown;
    };
    if (status < 200 || status >= 300) {
      const reason = typeof (json as Record<string, unknown> | null)?.["reason"] === "string"
        ? ` (${String((json as Record<string, unknown>)["reason"])})`
        : "";
      throw new Error(`self-hosted Emails: POST /messages/send failed (HTTP ${status})${reason}`);
    }
    const rec = payload.message;
    const id = rec?.id ?? "";
    // Prefer the PROVIDER's message id (top-level echo first — it is present
    // even when ledger finalization failed and the record row is stale) over
    // the RFC Message-ID header, and only fall back to the ledger row id.
    const providerMessageId = typeof payload.provider_message_id === "string" && payload.provider_message_id
      ? payload.provider_message_id
      : rec?.provider_message_id ?? null;
    return {
      id,
      messageId: providerMessageId ?? rec?.message_id ?? id,
      ...(payload.in_progress === true ? { inProgress: true as const } : {}),
      // A 2xx with a warning means the message WAS sent but a post-send step
      // failed — success that the caller must see, never re-send.
      ...(typeof payload.warning === "string" && payload.warning ? { warning: payload.warning } : {}),
    };
  }

  async clear(filter?: MailClearFilter): Promise<MailClearResult> {
    // Resolve the scope before the scan so unsupported provenance selectors
    // refuse rather than widening. The complete cursor walk is preflighted
    // before the first destructive request.
    //
    // `providerId` is one of those selectors: a /v1 message row carries no
    // provider dimension, so the scope is unexpressible here — and dropping it
    // silently would turn "clear one provider" into "clear the whole tenant
    // folder" while reporting a plausible count. The local backend honours the
    // same argument, so a silent widening would also make the guarantee depend
    // on configuration. Refuse instead.
    if (filter?.providerId) throw new Error(SELF_HOSTED_PROVIDER_CLEAR_UNSUPPORTED);
    const scope = selfHostedScopeOf(filter?.source);
    const mailbox: Mailbox = filter?.mailbox ?? "inbox";
    const targets = new Set<string>();
    for (const message of await this.scanScopeRows(scope)) {
      if (folderMatch(message, mailbox) && scopeMatch(message, scope)) targets.add(message.id);
    }
    for (const id of targets) await this.deleteMessage(id);
    return { cleared: targets.size };
  }
}

/**
 * Build the self-hosted data source only from explicit operator configuration.
 * No URL or credential implies a mode, and no package-owned endpoint exists.
 */
export function resolveSelfHostedMailDataSource(fetchImpl?: SelfHostedFetch): SelfHostedMailDataSource | null {
  if (getEmailsMode() !== "self_hosted") return null;
  const config = resolveSelfHostedConfig();
  if (!config) return null;
  // `apiKey` here is the Bearer credential slot — a user session token when
  // present, else the next configured credential (resolveSelfHostedConfig decides).
  return new SelfHostedMailDataSource({
    baseUrl: config.baseUrl,
    apiKey: config.credential,
    credentials: [
      { setting: config.credentialSetting ?? EMAILS_SELF_HOSTED_API_KEY_ENV, value: config.credential },
      ...(config.credentialFallbacks ?? []),
    ],
    fetchImpl,
  });
}
