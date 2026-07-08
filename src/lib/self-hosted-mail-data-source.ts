// SelfHostedMailDataSource — the MailDataSource backend for the fleet's
// self-hosted cloud flip.
//
// WHY THIS EXISTS (the client-flip that was missing):
// The inbox seam (`resolveMailDataSource`) previously had only two backends:
//   • SqliteMailDataSource — local SQLite.
//   • ApiMailDataSource    — the *mailery.co SaaS* client (MaileryCloudClient),
//     which speaks the tenant `/api/v1` shape (cursor pagination, camelCase
//     DTOs, /messages/groups, /messages/changes). That is NOT the shape our
//     self-hosted serve (`mailery.hasna.xyz/v1`) exposes.
//
// The self-hosted serve speaks the Hasna Service Contract v1 resource API — the
// same shape `src/db/cloud-store.ts` already uses for `domains`:
//   GET    /v1/messages?limit&offset   -> { messages: [ <row>, ... ] }
//   GET    /v1/messages/<id>           -> { message: <row> } | 404
//   POST   /v1/messages                -> { message: <row> }
//   PATCH  /v1/messages/<id>           -> { message: <row> }  (status only today)
//   DELETE /v1/messages/<id>           -> 200 | 404
// Rows are snake_case and carry the full inbound projection: direction,
// from_addr, to_addrs[], cc_addrs[], subject, body_text, body_html, status,
// message_id, in_reply_to, received_at, is_read, is_starred, labels[], headers,
// created_at, updated_at. Ordering is COALESCE(received_at, created_at) DESC.
//
// This backend maps that resource API onto the client's domain language
// (TuiMessage / MailboxCounts / MessageBody / …) so the CLI/MCP inbox reads the
// SHARED cloud store instead of the machine-local SQLite island.
//
// SECRET SAFETY: the bearer key is resolved from HASNA_MAILERY_API_KEY (via
// resolveCloudConfig) and only ever placed in an in-process `Authorization`
// header. It is never written to argv, logged, or embedded in an error message.

import { resolveCloudConfig } from "../db/cloud-store.js";
import type { AttachmentPath } from "../db/inbound.js";
import {
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
} from "../cli/tui/data.js";
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

// ── the /v1 message row (snake_case, as the self-hosted serve returns) ────────

interface V1Message {
  id: string;
  direction?: string;
  from_addr?: string | null;
  to_addrs?: string[] | null;
  cc_addrs?: string[] | null;
  subject?: string | null;
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
  created_at?: string | null;
  updated_at?: string | null;
}

export type SelfHostedFetch = (url: string, init: RequestInit) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

// A complete server id (uuidv7). Used verbatim; a shorter value is a prefix that
// resolveId matches over a bounded recent scan.
const FULL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Page size for /v1 list reads.
const PAGE_LIMIT = 500;
// Hard cap on rows walked for a full scan (counts/search/resolve). Large enough
// to cover a real mailbox without an unbounded walk.
const MAX_SCAN_ROWS = 100_000;
// How long a full scan is reused within one (short-lived) CLI/MCP invocation.
const SCAN_TTL_MS = 15_000;

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
    snippet: snippetOf(m.body_text),
    thread_id: null,
    provider_thread_id: null,
    attachments: 0,
    sentByMe: outbound,
  };
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
    attachments: [],
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
      return Boolean(m.is_starred) && !trash;
    case "sent":
      return outbound;
    case "archived":
      return archived;
    case "spam":
      return spam;
    case "trash":
      return trash;
    default:
      return false;
  }
}

// True when a source actually narrows the view (an unresolvable one yields nothing
// rather than silently widening to the whole store — parity with the SaaS backend).
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
// 2-minute wall" on `inbox` reads). Overridable for very large tenants.
function selfHostedTimeoutMs(): number {
  const raw = process.env["HASNA_MAILERY_HTTP_TIMEOUT"];
  const seconds = raw ? Number.parseInt(raw.trim(), 10) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000;
}

export interface SelfHostedMailDataSourceOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: SelfHostedFetch;
  now?: () => number;
  /** Per-request timeout in ms (default: HASNA_MAILERY_HTTP_TIMEOUT or 30s). */
  timeoutMs?: number;
}

export class SelfHostedMailDataSource implements MailDataSource {
  readonly mode = "cloud" as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: SelfHostedFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private scanCache: { at: number; rows: V1Message[] } | null = null;

  constructor(options: SelfHostedMailDataSourceOptions) {
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
    const init: RequestInit = { method, headers };
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
        throw new Error(`self-hosted mailery: ${method} ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`self-hosted mailery: cannot reach ${this.baseUrl} for ${method} ${path}`);
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

  private async listPage(limit: number, offset: number): Promise<V1Message[]> {
    const { status, json } = await this.request("GET", `/messages?limit=${limit}&offset=${offset}`);
    if (status < 200 || status >= 300) {
      throw new Error(`self-hosted mailery: GET /messages failed (HTTP ${status})`);
    }
    const list = (json as { messages?: unknown } | null)?.messages;
    return Array.isArray(list) ? (list as V1Message[]) : [];
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

  private async getRaw(id: string): Promise<V1Message | null> {
    const { status, json } = await this.request("GET", `/messages/${encodeURIComponent(id)}`);
    if (status === 404) return null;
    if (status < 200 || status >= 300) {
      throw new Error(`self-hosted mailery: GET /messages/<id> failed (HTTP ${status})`);
    }
    const wrapped = (json as { message?: V1Message } | null)?.message;
    return wrapped ?? (json && typeof json === "object" ? (json as V1Message) : null);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async resolveId(id: string): Promise<string> {
    const trimmed = id.trim();
    if (FULL_ID_RE.test(trimmed)) return trimmed;
    const rows = await this.scanAll();
    const matches = new Set<string>();
    for (const m of rows) {
      if (m.id === trimmed) return m.id;
      if (m.id.startsWith(trimmed)) matches.add(m.id);
    }
    if (matches.size === 1) return [...matches][0]!;
    if (matches.size > 1) {
      throw new Error(`Ambiguous email id prefix '${trimmed}' — it matches ${matches.size} messages. Use a longer id.`);
    }
    // No match in-scan: hand back the original so the server returns a clean 404.
    return trimmed;
  }

  async listMailbox(mailbox: Mailbox, opts?: MailboxListOptions): Promise<TuiMessage[]> {
    if (hasSourceScope(opts?.source) && !opts?.source?.address && !opts?.source?.domain) return [];
    const rows = await this.scanAll();
    const label = opts?.label?.trim().toLowerCase();
    let filtered = rows.filter((m) =>
      folderMatch(m, mailbox)
      && sourceMatch(m, opts?.source)
      && searchMatch(m, opts?.search)
      && (!label || labelsOf(m).some((l) => l.trim().toLowerCase() === label)),
    );
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
    const rows = await this.scanAll();
    const counts = emptyCounts();
    for (const m of rows) {
      if (!sourceMatch(m, opts?.source)) continue;
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

  async listMailboxSources(_opts?: ListMailboxSourcesOptions): Promise<MailboxSourceSummary[]> {
    // The self-hosted serve is a single shared store — expose it as one source so
    // `inbox sources` / status are informative rather than empty.
    const counts = await this.mailboxCounts();
    const rows = await this.scanAll();
    const latest = rows.reduce<string | null>((max, m) => {
      const d = messageDate(m);
      return d && (max === null || d > max) ? d : max;
    }, null);
    const total = counts.inbox + counts.archived + counts.spam + counts.trash;
    return [{
      id: "cloud",
      label: "Self-hosted cloud (mailery.hasna.xyz)",
      kind: "all",
      badges: ["cloud"],
      counts,
      total,
      unread: counts.unread,
      latestReceivedAt: latest,
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

  async getConversation(msg: TuiMessage): Promise<TuiThreadMessage[]> {
    const m = await this.getRaw(msg.id);
    return m ? [v1ToThreadMessage(m)] : [];
  }

  async getConversationBodies(msg: TuiMessage, _opts?: ConversationBodyOptions): Promise<TuiThreadBody[]> {
    const m = await this.getRaw(msg.id);
    if (!m) return [];
    return [{ item: v1ToThreadMessage(m), body: v1ToMessageBody(m) }];
  }

  async getAttachmentPaths(_id: string): Promise<AttachmentPath[]> {
    // The self-hosted serve does not expose attachment blobs over /v1 yet.
    return [];
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
    const rows = await this.scanAll();
    const since = opts?.since;
    const fromFilter = opts?.from?.trim().toLowerCase();
    const candidates = rows
      .filter((m) => (m.direction ?? "").toLowerCase() !== "outbound")
      .filter((m) => (m.to_addrs ?? []).map(bareEmail).includes(target))
      .filter((m) => (!since || messageDate(m) >= since))
      .filter((m) => (!fromFilter || (m.from_addr ?? "").toLowerCase().includes(fromFilter)))
      .sort((a, b) => messageDate(b).localeCompare(messageDate(a)));
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 50;
    return candidates.slice(0, limit).map((m) => ({
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
    const since = opts?.since;
    let messages = rows
      .filter((m) => (!since || messageDate(m) >= since))
      .sort((a, b) => messageDate(a).localeCompare(messageDate(b)));
    if (opts?.limit && opts.limit > 0) messages = messages.slice(-opts.limit);
    const tui = messages.map(v1ToTuiMessage);
    const watermark = tui.reduce<string | null>((max, m) => (max === null || m.date > max ? m.date : max), since ?? null);
    return { messages: tui, deletedIds: [], cursor: null, watermark };
  }

  // ── writes ─────────────────────────────────────────────────────────────

  // The self-hosted serve's PATCH persists only `status`/`provider_message_id`
  // today. Marking read is best-effort so `inbox read` still works; it does not
  // yet persist server-side.
  async setRead(id: string, read: boolean): Promise<void> {
    this.invalidate();
    try {
      await this.request("PATCH", `/messages/${encodeURIComponent(id)}`, { is_read: read });
    } catch {
      // best-effort: do not fail the read flow if the serve can't persist yet.
    }
  }

  async setArchived(_id: string, _archived: boolean): Promise<void> {
    throw new Error("Archiving is not yet supported on the self-hosted mailery serve (/v1 PATCH persists status only).");
  }

  async setStarred(_id: string, _starred: boolean): Promise<void> {
    throw new Error("Starring is not yet supported on the self-hosted mailery serve (/v1 PATCH persists status only).");
  }

  async addLabel(_id: string, _label: string): Promise<string[]> {
    throw new Error("Labels are not yet supported on the self-hosted mailery serve (/v1 PATCH persists status only).");
  }

  async removeLabel(_id: string, _label: string): Promise<string[]> {
    throw new Error("Labels are not yet supported on the self-hosted mailery serve (/v1 PATCH persists status only).");
  }

  async deleteMessage(id: string): Promise<void> {
    this.invalidate();
    const { status } = await this.request("DELETE", `/messages/${encodeURIComponent(id)}`);
    if (status !== 404 && (status < 200 || status >= 300)) {
      throw new Error(`self-hosted mailery: DELETE /messages/<id> failed (HTTP ${status})`);
    }
  }

  async bulk(input: MailBulkInput): Promise<MailBulkResult> {
    const action = input.action;
    if (action !== "delete") {
      throw new Error(`Bulk '${action}' is not yet supported on the self-hosted mailery serve.`);
    }
    const ids = input.ids ?? [];
    let affected = 0;
    for (const id of ids) {
      await this.deleteMessage(id);
      affected += 1;
    }
    return { action, affected, matched: ids.length, hasMore: false, nextCursor: null };
  }

  async send(input: MailSendInput): Promise<MailSendResult> {
    if (input.attachments && input.attachments.length > 0) {
      throw new Error("Attachments are not yet supported when sending through the self-hosted mailery serve.");
    }
    if (input.scheduledAt) {
      throw new Error("Scheduled send is not supported on the self-hosted mailery serve.");
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
      status: "sent",
      direction: "outbound",
    };
    if (input.cc) body["cc"] = input.cc.split(",").map((v) => v.trim()).filter(Boolean);
    this.invalidate();
    const { status, json } = await this.request("POST", "/messages", body);
    if (status < 200 || status >= 300) {
      throw new Error(`self-hosted mailery: POST /messages (send) failed (HTTP ${status})`);
    }
    const rec = (json as { message?: V1Message } | null)?.message;
    const id = rec?.id ?? "";
    return { id, messageId: rec?.message_id ?? id };
  }

  async clear(filter?: MailClearFilter): Promise<MailClearResult> {
    const rows = await this.scanAll();
    const mailbox: Mailbox = filter?.mailbox ?? "inbox";
    const targets = rows.filter((m) => folderMatch(m, mailbox) && sourceMatch(m, filter?.source));
    let cleared = 0;
    for (const m of targets) {
      await this.deleteMessage(m.id);
      cleared += 1;
    }
    return { cleared };
  }
}

/**
 * Build a SelfHostedMailDataSource from the fleet flip env, or null.
 *
 * The self-hosted flip is defined SPECIFICALLY by the app-scoped
 * HASNA_MAILERY_API_URL + HASNA_MAILERY_API_KEY vars (the fleet client-flip
 * contract). The bare MAILERY_API_URL / MAILERY_API_KEY belong to the mailery.co
 * SaaS client (ApiMailDataSource) and must NOT engage the self-hosted seam — so
 * this returns null unless the HASNA_-scoped vars are both present. resolveCloudConfig
 * then applies /v1 normalization, fail-closed partial-config handling, and respects
 * an explicit `local` mode (returns null on rollback).
 */
export function resolveSelfHostedMailDataSource(fetchImpl?: SelfHostedFetch): SelfHostedMailDataSource | null {
  if (!process.env["HASNA_MAILERY_API_URL"] || !process.env["HASNA_MAILERY_API_KEY"]) return null;
  const config = resolveCloudConfig();
  if (!config) return null;
  return new SelfHostedMailDataSource({ baseUrl: config.baseUrl, apiKey: config.apiKey, fetchImpl });
}
