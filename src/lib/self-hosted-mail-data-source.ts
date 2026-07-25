// SelfHostedMailDataSource maps the operator-configured Emails service onto the
// common mailbox interface. The service speaks a versioned resource API — the
// same shape `src/db/self-hosted-store.ts` already uses for `domains`:
//   GET    /v1/messages?limit&offset   -> { messages: [ <summary row>, ... ] }
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
  MailChanges,
  MailChangesQuery,
  MailClearFilter,
  MailClearResult,
  MailDataSource,
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
  attachments?: Array<{
    filename?: string;
    content_type?: string;
    size?: number;
    /** Serves >= the content_available contract report stored-byte presence. */
    content_available?: boolean;
  }> | null;
  /** List rows carry only the count; full metadata comes from the detail read. */
  attachment_count?: number;
  created_at?: string | null;
  updated_at?: string | null;
}

export type SelfHostedFetch = (url: string, init: RequestInit) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

// A complete server id (uuidv7). Used verbatim; a shorter value is a prefix that
// resolveId matches over a bounded recent scan.
const FULL_ID_RE = /^(?:[A-Za-z0-9_-]+:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Page size for /v1 list reads.
const PAGE_LIMIT = 500;
// Hard cap on rows walked for a full scan (counts/search/resolve). Large enough
// to cover a real mailbox without an unbounded walk.
const MAX_SCAN_ROWS = 100_000;
// How long a full scan is reused within one (short-lived) CLI/MCP invocation.
const SCAN_TTL_MS = 15_000;
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
  };
}

function v1AttachmentMetadata(m: V1Message): AttachmentPath[] {
  const metadata = Array.isArray(m.attachments) ? m.attachments : [];
  // `||`, not `??`: inbound MIME parts routinely carry filename="" (unnamed
  // inline parts), and an empty name is dropped by every display merge, which
  // silently shifts the download indexes of everything after it. Placeholder
  // names keep each entry addressable — same rule as db/inbound.remote.ts.
  return metadata.map((attachment, index) => ({
    filename: String(attachment?.filename || `attachment-${index + 1}`),
    content_type: String(attachment?.content_type || "application/octet-stream"),
    size: Number(attachment?.size ?? 0) || 0,
    // Only a BOOLEAN from the serve is a statement about stored bytes. An older
    // serve omits the field entirely; leaving it undefined keeps that "unknown"
    // and stops the renderer from declaring a fetchable payload unavailable.
    ...(typeof attachment?.content_available === "boolean"
      ? { content_available: attachment.content_available }
      : {}),
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

function searchMatch(m: V1Message, query?: string): boolean {
  const q = query?.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    m.from_addr ?? "",
    (m.to_addrs ?? []).join(" "),
    m.subject ?? "",
    m.body_text ?? "",
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
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private scanCache: { at: number; rows: V1Message[] } | null = null;

  constructor(options: SelfHostedMailDataSourceOptions) {
    const url = new URL(options.baseUrl);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("Self-hosted Emails requires HTTPS except for loopback development URLs.");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.now = options.now ?? Date.now;
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
    offset: number,
    opts: {
      direction?: "inbound" | "outbound";
      since?: string;
      to?: string;
      from?: string;
      subject?: string;
      search?: string;
    } = {},
  ): Promise<V1Message[]> {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    params.set("offset", String(offset));
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
    const list = (json as { messages?: unknown } | null)?.messages;
    return Array.isArray(list) ? (list as V1Message[]) : [];
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

  // Full, TTL-cached scan (bounded). Reused across counts/status/search/labels
  // within one short-lived invocation; writes reset it.
  private async scanAll(): Promise<V1Message[]> {
    const cached = this.scanCache;
    if (cached && this.now() - cached.at < SCAN_TTL_MS) return cached.rows;
    const rows: V1Message[] = [];
    for (let offset = 0; offset < MAX_SCAN_ROWS; offset += PAGE_LIMIT) {
      const page = await this.listPage(PAGE_LIMIT, offset);
      rows.push(...page);
      if (page.length < PAGE_LIMIT) break;
    }
    this.scanCache = { at: this.now(), rows };
    return rows;
  }

  private invalidate(): void {
    this.scanCache = null;
  }

  private async searchMatchWithDetails(message: V1Message, search: string | undefined): Promise<{ message: V1Message; matches: boolean }> {
    let candidate = message;
    let matches = searchMatch(candidate, search);
    if (!matches && search?.trim() && message.body_text == null) {
      candidate = (await this.getRaw(message.id)) ?? message;
      matches = searchMatch(candidate, search);
    }
    return { message: candidate, matches };
  }

  private async listFilteredMailboxPage(mailbox: Mailbox, scope: SelfHostedScope | undefined, opts?: MailboxListOptions): Promise<V1Message[]> {
    const offset = opts?.offset && opts.offset > 0 ? opts.offset : 0;
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 200;
    const wanted = offset + limit;
    const pageLimit = Math.min(PAGE_LIMIT, Math.max(50, wanted));
    const direction = mailbox === "sent" ? "outbound" : "inbound";
    const since = normalizeSince(opts?.since);
    const matches = new Map<string, V1Message>();
    for (const sourceFilters of scopeServerFilterSets(scope)) {
      let filterMatches = 0;
      for (let serverOffset = 0; serverOffset < MAX_SCAN_ROWS && filterMatches < wanted; serverOffset += pageLimit) {
        const page = await this.listPage(pageLimit, serverOffset, {
          direction,
          since,
          ...sourceFilters,
          search: opts?.search,
        });
        for (const message of page) {
          if (!folderMatch(message, mailbox) || !scopeMatch(message, scope) || !isOnOrAfter(message, since)) continue;
          // Part of the QUERY, not a post-filter over the page: applied here the
          // walk keeps paging until `limit` matching rows exist.
          if (opts?.read === true && !readMatch(message)) continue;
          const { message: candidate, matches: matchesSearch } = await this.searchMatchWithDetails(message, opts?.search);
          if (matchesSearch) {
            if (!matches.has(candidate.id)) filterMatches += 1;
            matches.set(candidate.id, candidate);
          }
        }
        if (page.length < pageLimit) break;
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
      for (let offset = 0; offset < MAX_SCAN_ROWS; offset += PAGE_LIMIT) {
        const page = await this.listPage(PAGE_LIMIT, offset, filters);
        for (const message of page) {
          if (scopeMatch(message, scope)) seen.set(message.id, message);
        }
        if (page.length < PAGE_LIMIT) break;
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
    for (let offset = 0; offset < MAX_THREAD_CANDIDATE_ROWS; offset += PAGE_LIMIT) {
      const page = await this.listPage(Math.min(PAGE_LIMIT, MAX_THREAD_CANDIDATE_ROWS - offset), offset, { subject: key });
      candidates.push(...page);
      if (page.length < PAGE_LIMIT) break;
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
    if (!opts?.label && opts?.sort !== "oldest") {
      return (await this.listFilteredMailboxPage(mailbox, scope, opts)).map(v1ToTuiMessage);
    }
    const rows = await this.scanAll();
    const label = opts?.label?.trim().toLowerCase();
    const since = normalizeSince(opts?.since);
    let filtered: V1Message[] = [];
    for (const row of rows) {
      if (!folderMatch(row, mailbox)
        || !scopeMatch(row, scope)
        || !isOnOrAfter(row, since)
        || (opts?.read === true && !readMatch(row))
        || (label && !labelsOf(row).some((l) => l.trim().toLowerCase() === label))
      ) continue;
      const { message, matches } = await this.searchMatchWithDetails(row, opts?.search);
      if (matches) filtered.push(message);
    }
    filtered.sort((a, b) => {
      const da = messageDate(a);
      const db = messageDate(b);
      return opts?.sort === "oldest" ? da.localeCompare(db) : db.localeCompare(da);
    });
    const offset = opts?.offset && opts.offset > 0 ? opts.offset : 0;
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 200;
    return filtered.slice(offset, offset + limit).map(v1ToTuiMessage);
  }

  async mailboxCounts(opts?: { source?: MailboxSource }): Promise<MailboxCounts> {
    const scope = selfHostedScopeOf(opts?.source);
    if (!scope) return (await this.serverStats()).counts;
    const rows = await this.scanScopeRows(scope);
    const counts = emptyCounts();
    for (const m of rows) {
      if (!scopeMatch(m, scope)) continue;
      for (const folder of MAILBOXES) {
        if (folderMatch(m, folder)) counts[folder] += 1;
      }
    }
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

  async listLabelSummaries(opts?: ListLabelSummaryOptions): Promise<LabelSummary[]> {
    const rows = await this.scanAll();
    const tally = new Map<string, number>();
    for (const m of rows) {
      for (const raw of labelsOf(m)) {
        const name = raw.trim();
        if (!name) continue;
        tally.set(name, (tally.get(name) ?? 0) + 1);
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
    for (let offset = 0; offset < MAX_SCAN_ROWS && candidates.length < limit; offset += pageLimit) {
      const page = await this.listPage(pageLimit, offset, {
        direction: "inbound",
        to: target,
        since,
        from: opts?.from,
        subject: opts?.subject,
      });
      for (const message of page) {
        if ((message.direction ?? "").toLowerCase() === "outbound") continue;
        if (!(message.to_addrs ?? []).map(bareEmail).includes(target)) continue;
        if (!isOnOrAfter(message, since)) continue;
        if (fromFilter && !(message.from_addr ?? "").toLowerCase().includes(fromFilter)) continue;
        if (subjectFilter && !(message.subject ?? "").toLowerCase().includes(subjectFilter)) continue;
        candidates.push(message);
        if (candidates.length >= limit) break;
      }
      if (page.length < pageLimit) break;
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

  async changesSince(opts?: MailChangesQuery): Promise<MailChanges> {
    const rows = await this.scanAll();
    const since = normalizeSince(opts?.since);
    let messages = rows
      .filter((m) => isOnOrAfter(m, since))
      .sort((a, b) => messageDate(a).localeCompare(messageDate(b)));
    if (opts?.limit && opts.limit > 0) messages = messages.slice(-opts.limit);
    const tui = messages.map(v1ToTuiMessage);
    const watermark = tui.reduce<string | null>((max, m) => (max === null || m.date > max ? m.date : max), since ?? null);
    return { messages: tui, deletedIds: [], cursor: null, watermark };
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
    if (status < 200 || status >= 300) {
      throw new Error(`self-hosted Emails: POST /messages/send failed (HTTP ${status})`);
    }
    const rec = (json as { message?: V1Message } | null)?.message;
    const id = rec?.id ?? "";
    return { id, messageId: rec?.message_id ?? id };
  }

  async clear(filter?: MailClearFilter): Promise<MailClearResult> {
    // Resolve the scope BEFORE the scan: an unsupported one must refuse, never
    // widen. A silently-empty scope here would have deleted nothing while
    // reporting success — and the reverse mistake would delete the whole store.
    const scope = selfHostedScopeOf(filter?.source);
    const rows = await this.scanAll();
    const mailbox: Mailbox = filter?.mailbox ?? "inbox";
    const targets = rows.filter((m) => folderMatch(m, mailbox) && scopeMatch(m, scope));
    let cleared = 0;
    for (const m of targets) {
      await this.deleteMessage(m.id);
      cleared += 1;
    }
    return { cleared };
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
