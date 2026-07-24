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
// SECRET SAFETY: the bearer key is resolved from EMAILS_SELF_HOSTED_API_KEY (via
// resolveSelfHostedConfig) and only ever placed in an in-process `Authorization`
// header. It is never written to argv, logged, or embedded in an error message.

import { resolveSelfHostedConfig } from "../db/self-hosted-store.js";
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
  provider_message_id?: string | null;
  message_id?: string | null;
  in_reply_to?: string | null;
  received_at?: string | null;
  is_read?: boolean;
  is_starred?: boolean;
  labels?: string[] | null;
  headers?: Record<string, unknown> | null;
  attachments?: Array<{ filename?: string; content_type?: string; size?: number }> | null;
  /** List rows carry only the count; full metadata comes from the detail read. */
  attachment_count?: number;
  created_at?: string | null;
  updated_at?: string | null;
}

export type SelfHostedFetch = (url: string, init: RequestInit) => Promise<{
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

function bareEmail(value: string): string {
  const angled = value.match(/<([^>]+)>/);
  return (angled ? angled[1]! : value).trim().toLowerCase();
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
    subject: m.subject || "(no subject)",
    date: messageDate(m),
    is_read: outbound ? true : isRead,
    is_starred: Boolean(m.is_starred),
    labels: visibleLabels(labelsOf(m), isRead),
    snippet: snippetOf(m.snippet ?? m.body_text),
    thread_id: null,
    provider_thread_id: null,
    attachments,
    sentByMe: outbound,
  };
}

function v1AttachmentMetadata(m: V1Message): AttachmentPath[] {
  const metadata = Array.isArray(m.attachments) ? m.attachments : [];
  return metadata.map((attachment, index) => ({
    filename: String(attachment?.filename ?? `attachment-${index + 1}`),
    content_type: String(attachment?.content_type ?? "application/octet-stream"),
    size: Number(attachment?.size ?? 0) || 0,
  }));
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
  return {
    kind: (m.direction ?? "").toLowerCase() === "outbound" ? "sent" : "received",
    storage: "inbound",
    id: m.id,
    from: m.from_addr ?? "",
    subject: m.subject || "(no subject)",
    at: messageDate(m),
  };
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

// True when a source actually narrows the view (an unresolvable one yields nothing
// rather than silently widening to the whole operator-owned store).
function hasSourceScope(source?: MailboxSource): boolean {
  return Boolean(source && (source.sourceId || source.providerId || source.address || source.domain || source.s3Bucket || source.legacy || source.unknown));
}

function sourceMatch(m: V1Message, source?: MailboxSource): boolean {
  if (!hasSourceScope(source)) return true;
  const recipients = (m.to_addrs ?? []).map(bareEmail);
  const address = source?.address?.trim().toLowerCase();
  if (address) return recipients.includes(address) || bareEmail(m.from_addr ?? "") === address;
  const domain = source?.domain?.trim().toLowerCase();
  if (domain) return recipients.some((r) => r.endsWith(`@${domain}`));
  // provider/s3/legacy/unknown scoping has no equivalent in the self-hosted
  // serve → narrow to nothing.
  return false;
}

function sourceServerFilterSets(source: MailboxSource | undefined): Array<{ to?: string; from?: string }> {
  const address = source?.address?.trim().toLowerCase();
  if (address) return [{ to: address }, { from: address }];
  const domain = source?.domain?.trim().toLowerCase();
  return domain ? [{ to: domain }] : [{}];
}

function sanitizedAttachmentSearchText(m: V1Message): string {
  if (!Array.isArray(m.attachments)) return "";
  return m.attachments.flatMap((attachment) => {
    const clean = (value: unknown): string =>
      typeof value === "string"
        ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim()
        : "";
    return [clean(attachment?.filename), clean(attachment?.content_type)];
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
  fetchImpl?: SelfHostedFetch;
  now?: () => number;
  /** Per-request timeout in ms (default: EMAILS_SELF_HOSTED_HTTP_TIMEOUT or 30s). */
  timeoutMs?: number;
}

export class SelfHostedMailDataSource implements MailDataSource {
  readonly mode = "self_hosted" as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: SelfHostedFetch;
  private readonly timeoutMs: number;

  constructor(options: SelfHostedMailDataSourceOptions) {
    const url = new URL(options.baseUrl);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("Self-hosted Emails requires HTTPS except for loopback development URLs.");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? selfHostedTimeoutMs();
    this.fetchImpl = options.fetchImpl
      ?? ((url, init) => fetch(url, init) as unknown as ReturnType<SelfHostedFetch>);
  }

  // ── transport (bearer key only in-header, never logged) ──────────────────

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
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
    const text = await res.text();
    let json: unknown = null;
    if (text && text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
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
    } = {},
  ): Promise<V1MessagePage> {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (position.cursor) params.set("cursor", position.cursor);
    else if (position.offset !== undefined && position.offset > 0) params.set("offset", String(position.offset));
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
    const attachmentSearchMetadataComplete = attachmentMetadata.every((attachment) =>
      typeof attachment.filename === "string" && typeof attachment.content_type === "string");
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

  private async listFilteredMailboxPage(mailbox: Mailbox, opts?: MailboxListOptions): Promise<V1Message[]> {
    const offset = opts?.offset && opts.offset > 0 ? opts.offset : 0;
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 200;
    const wanted = offset + limit;
    const pageLimit = Math.min(PAGE_LIMIT, Math.max(50, wanted));
    const direction = mailbox === "sent" ? "outbound" : "inbound";
    const since = normalizeSince(opts?.since);
    const label = opts?.label?.trim().toLowerCase();
    const matchesLocally = async (message: V1Message): Promise<V1Message | null> => {
      if (!folderMatch(message, mailbox)
        || !sourceMatch(message, opts?.source)
        || !isOnOrAfter(message, since)
        || (label && !labelsOf(message).some((value) => value.trim().toLowerCase() === label))
      ) return null;
      const { message: candidate, matches } = await this.searchMatchWithDetails(message, opts?.search);
      return matches ? candidate : null;
    };

    if (opts?.sort === "oldest") {
      // The server is newest-first. Retain only the request-bounded oldest tail
      // while walking the cursor chain, never the whole mailbox.
      const tail: V1Message[] = [];
      const filters = sourceServerFilterSets(opts?.source);
      // Address scopes need a to/from union. A single unfiltered cursor walk
      // preserves global ordering and avoids duplicate rows across that union.
      const sourceFilters = filters.length > 1 ? [{}] : filters;
      for (const filtersForRequest of sourceFilters) {
        for await (const page of this.listPages(PAGE_LIMIT, {
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
    for (const sourceFilters of sourceServerFilterSets(opts?.source)) {
      let filterMatches = 0;
      for await (const page of this.listPages(pageLimit, {
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

  private async forEachSourceRow(source: MailboxSource | undefined, visit: (message: V1Message) => void): Promise<void> {
    if (hasSourceScope(source) && !source?.address && !source?.domain) return;
    const address = source?.address?.trim().toLowerCase();
    for (const filters of sourceServerFilterSets(source)) {
      for await (const page of this.listPages(PAGE_LIMIT, filters)) {
        for (const message of page) {
          if (!sourceMatch(message, source)) continue;
          // The address union is `to=address` followed by `from=address`.
          // Rows matching both belong to the first stream only, so traversal is
          // exact-once without retaining every visited id.
          if (filters.from && address && (message.to_addrs ?? []).map(bareEmail).includes(address)) continue;
          visit(message);
        }
      }
    }
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
    if (hasSourceScope(opts?.source) && !opts?.source?.address && !opts?.source?.domain) return [];
    return (await this.listFilteredMailboxPage(mailbox, opts)).map(v1ToTuiMessage);
  }

  async mailboxCounts(opts?: { source?: MailboxSource }): Promise<MailboxCounts> {
    if (!hasSourceScope(opts?.source)) return (await this.serverStats()).counts;
    const counts = emptyCounts();
    await this.forEachSourceRow(opts?.source, (m) => {
      for (const folder of MAILBOXES) {
        if (folderMatch(m, folder)) counts[folder] += 1;
      }
    });
    return counts;
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

  async listMailboxSources(_opts?: ListMailboxSourcesOptions): Promise<MailboxSourceSummary[]> {
    // The self-hosted serve is a single shared store — expose it as one source so
    // `inbox sources` / status are informative rather than empty.
    const { counts, latestReceivedAt } = await this.serverStats();
    const receivedTotal = counts.inbox + counts.archived + counts.spam + counts.trash;
    return [{
      id: "self_hosted",
      label: "Self-hosted Emails",
      kind: "all",
      badges: ["self_hosted"],
      counts,
      total: receivedTotal,
      unread: counts.unread,
      latestReceivedAt,
    }];
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
    return m ? [v1ToThreadMessage(m)] : [];
  }

  async getConversationBodies(msg: TuiMessage, _opts?: ConversationBodyOptions): Promise<TuiThreadBody[]> {
    const m = await this.getRaw(msg.id);
    if (!m) return [];
    return [{ item: v1ToThreadMessage(m), body: v1ToMessageBody(m) }];
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

  async listLabelSummaries(opts?: ListLabelSummaryOptions): Promise<LabelSummary[]> {
    const tally = new Map<string, number>();
    for await (const page of this.listPages(PAGE_LIMIT)) {
      for (const m of page) {
        for (const raw of labelsOf(m)) {
          const name = raw.trim();
          if (!name) continue;
          tally.set(name, (tally.get(name) ?? 0) + 1);
        }
      }
    }
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
    const { status } = await this.request("PATCH", `/messages/${encodeURIComponent(id)}`, { is_read: read });
    if (status < 200 || status >= 300) throw new Error(`self-hosted emails: mark read failed (HTTP ${status})`);
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    const { status } = await this.request("PATCH", `/messages/${encodeURIComponent(id)}`, { archived });
    if (status < 200 || status >= 300) throw new Error(`self-hosted emails: archive update failed (HTTP ${status})`);
  }

  async setStarred(id: string, starred: boolean): Promise<void> {
    const { status } = await this.request("PATCH", `/messages/${encodeURIComponent(id)}`, { is_starred: starred });
    if (status < 200 || status >= 300) throw new Error(`self-hosted emails: star update failed (HTTP ${status})`);
  }

  async addLabel(id: string, label: string): Promise<string[]> {
    const { status, json } = await this.request("PATCH", `/messages/${encodeURIComponent(id)}`, { add_label: label });
    if (status < 200 || status >= 300) throw new Error(`self-hosted emails: add label failed (HTTP ${status})`);
    return labelsOf((json as { message?: V1Message } | null)?.message ?? {} as V1Message);
  }

  async removeLabel(id: string, label: string): Promise<string[]> {
    const { status, json } = await this.request("PATCH", `/messages/${encodeURIComponent(id)}`, { remove_label: label });
    if (status < 200 || status >= 300) throw new Error(`self-hosted emails: remove label failed (HTTP ${status})`);
    return labelsOf((json as { message?: V1Message } | null)?.message ?? {} as V1Message);
  }

  async deleteMessage(id: string): Promise<void> {
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
    const { status, json } = await this.request("POST", "/messages/send", body);
    if (status < 200 || status >= 300) {
      throw new Error(`self-hosted Emails: POST /messages/send failed (HTTP ${status})`);
    }
    const rec = (json as { message?: V1Message } | null)?.message;
    const id = rec?.id ?? "";
    return { id, messageId: rec?.message_id ?? id };
  }

  async clear(filter?: MailClearFilter): Promise<MailClearResult> {
    const mailbox: Mailbox = filter?.mailbox ?? "inbox";
    const targets = new Set<string>();
    for await (const page of this.listPages(PAGE_LIMIT)) {
      for (const m of page) {
        if (!folderMatch(m, mailbox) || !sourceMatch(m, filter?.source)) continue;
        targets.add(m.id);
      }
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
  // present, else the operator API key (resolveSelfHostedConfig decides).
  return new SelfHostedMailDataSource({ baseUrl: config.baseUrl, apiKey: config.credential, fetchImpl });
}
