// MailDataSource — the read/write seam the TUI/CLI/MCP will sit behind.
//
// There are exactly two backends:
//   • SqliteMailDataSource — `local` mode. A thin async wrapper over the EXISTING
//     local read/write logic (src/db/inbound.ts + src/cli/tui/data.ts). It does not
//     duplicate that logic; it calls it. SQLite stays the local source of truth.
//   • ApiMailDataSource — `cloud` mode (incl. "self-hosted" = cloud pointed at a
//     privately-hosted server via a configurable base URL). A thin HTTP client over
//     MaileryCloudClient + a bounded, server-authoritative read cache (mail-cache).
//     It is NOT a full mirror and holds NO DB credentials — it reads a small window
//     and lets a JMAP-changesSince delta feed (listMessageChanges + tombstones,
//     keyed off a watermark) invalidate exactly what changed. Writes bypass+invalidate.
//
// The seam speaks the client's existing domain language (TuiMessage / Folder /
// MailboxCounts / MessageBody / …) so the eventual rewire of the callers is minimal:
// SqliteMailDataSource returns those types verbatim, and ApiMailDataSource translates
// cloud DTOs into them.
//
// This module is ADDITIVE: nothing here is wired into callers yet.

import { getConfigValue } from "./config.js";
import { getDatabase, resolvePartialIdOrThrow } from "../db/database.js";
import { MailCache, countsCacheKey, messagePageCacheKey } from "./mail-cache.js";
import {
  MaileryCloudClient,
  type MaileryCloudGroupCounts,
  type MaileryCloudLabelSummary,
  type MaileryCloudMailbox,
  type MaileryCloudMessage,
  type MaileryCloudMessageListItem,
  type MaileryCloudMessageWithAttachments,
} from "./mailery-cloud-client.js";
import { getMaileryMode, type MaileryMode } from "./mode.js";
import { SelfHostedMailDataSource, resolveSelfHostedMailDataSource } from "./self-hosted-mail-data-source.js";
import {
  type AttachmentPath,
  addInboundLabelSummary,
  clearInboundEmails,
  deleteInboundEmail,
  getInboundAttachmentPaths,
  getInboundEmailSummary,
  type InboundEmailSummary,
  listInboundEmailSummaries,
  removeInboundLabelSummary,
  setInboundArchivedFlag,
  setInboundReadFlag,
  setInboundStarredFlag,
} from "../db/inbound.js";
import {
  type ComposeInput,
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
  getConversation as localGetConversation,
  getConversationBodies as localGetConversationBodies,
  getMessageBody as localGetMessageBody,
  listLabelSummaries as localListLabelSummaries,
  listMailbox as localListMailbox,
  listMailboxSources as localListMailboxSources,
  listMailboxStatus as localListMailboxStatus,
  mailboxCounts as localMailboxCounts,
  mailboxLabel,
  renderMarkdown,
  sendComposed as localSendComposed,
} from "../cli/tui/data.js";
import {
  findVerificationCode,
  listVerificationCodeCandidates,
  type VerificationCodeCandidateOptions,
  type VerificationCodeEmail,
  type VerificationCodeMatch,
} from "./verification-code.js";

// ── seam-level DTOs (shared by both backends) ────────────────────────────────

export type MailDataSourceMode = "local" | "cloud";

export interface MailChangesQuery {
  /** Watermark: only messages created-or-changed at/after this ISO timestamp. */
  since?: string;
  /** Folder scope (cloud maps to a group; local narrows the recent-message read). */
  mailbox?: Mailbox;
  /** Source/mailbox scope. */
  source?: MailboxSource;
  limit?: number;
  /**
   * Continuation cursor from a prior MailChanges.cursor. When the delta feed had
   * more than one call could drain, pass this back (with the SAME `since`) to resume
   * with no gap. Cloud only.
   */
  cursor?: string;
}

export interface MailChanges {
  /** Created-or-changed messages since the watermark (deduped by id). */
  messages: TuiMessage[];
  /** Ids tombstoned since the watermark. */
  deletedIds: string[];
  /** Continuation cursor if the delta feed had more (else null). */
  cursor: string | null;
  /** The advanced watermark to pass as `since` on the next call. */
  watermark: string | null;
}

export interface MailBulkInput {
  action: string;
  ids?: string[];
  mailbox?: Mailbox;
  source?: MailboxSource;
  label?: string;
  cursor?: string;
}

export interface MailBulkResult {
  action: string;
  affected: number;
  matched: number;
  hasMore: boolean;
  nextCursor: string | null;
}

/** A file attachment for a send. Cloud send does not carry these yet (see send()). */
export interface MailSendAttachment {
  filename: string;
  /** base64-encoded content. */
  content: string;
  content_type: string;
}

export interface MailSendInput {
  from?: string;
  /** Comma-separated recipient list. */
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  /**
   * Explicit HTML body. When set it is used verbatim as the HTML part (e.g. the CLI's
   * `--html`); otherwise `body` is markdown-rendered unless `markdown === false`.
   */
  html?: string;
  markdown?: boolean;
  /** local: outbound provider id. */
  providerId?: string;
  /** cloud: sending mailbox id (else resolved from `from`). */
  mailboxId?: string;
  /** Message id to reply to (threading). */
  replyToId?: string;
  /** Reply-To header address(es), comma-separated. */
  replyTo?: string;
  /** File attachments. Cloud send rejects these until the server send endpoint carries them. */
  attachments?: MailSendAttachment[];
  /** ISO-8601 schedule time. Cloud send rejects this (no server-side scheduling). */
  scheduledAt?: string;
}

export interface MailSendResult {
  id: string;
  messageId: string;
}

/**
 * Scope for a clear (bulk delete). local wipes the inbound store (optionally by
 * provider); cloud drains a bulk delete over the mailbox/folder filter.
 */
export interface MailClearFilter {
  /** local: provider filter; cloud: resolves to a mailbox-id scope. */
  providerId?: string;
  /** cloud: folder scope (defaults to inbox). local: ignored — the store is wiped. */
  mailbox?: Mailbox;
  /** cloud: mailbox/source scope. */
  source?: MailboxSource;
}

export interface MailClearResult {
  cleared: number;
}

export interface MailDataSource {
  readonly mode: MailDataSourceMode;

  /**
   * Resolve a possibly-partial id (the short id printed by `inbox list`) to a full id
   * usable on every read/write. local: SQLite partial-id resolution. cloud: matches a
   * unique id prefix over a bounded recent scan (a full id is used verbatim).
   */
  resolveId(id: string): Promise<string>;

  // reads
  listMailbox(mailbox: Mailbox, opts?: MailboxListOptions): Promise<TuiMessage[]>;
  mailboxCounts(opts?: { source?: MailboxSource }): Promise<MailboxCounts>;
  listMailboxStatus(opts?: MailboxStatusOptions): Promise<MailboxStatusSummary>;
  listMailboxSources(opts?: ListMailboxSourcesOptions): Promise<MailboxSourceSummary[]>;
  getMessage(id: string): Promise<TuiMessage | null>;
  getMessageBody(msg: TuiMessage): Promise<MessageBody | null>;
  getConversation(msg: TuiMessage): Promise<TuiThreadMessage[]>;
  getConversationBodies(msg: TuiMessage, opts?: ConversationBodyOptions): Promise<TuiThreadBody[]>;
  getAttachmentPaths(id: string): Promise<AttachmentPath[]>;
  listLabelSummaries(opts?: ListLabelSummaryOptions): Promise<LabelSummary[]>;
  verificationCandidates(address: string, opts?: VerificationCodeCandidateOptions): Promise<VerificationCodeEmail[]>;
  findLatest(address: string, opts?: VerificationCodeCandidateOptions & { from?: string; subject?: string }): Promise<VerificationCodeMatch<VerificationCodeEmail> | null>;
  changesSince(opts?: MailChangesQuery): Promise<MailChanges>;

  // writes (all bypass + invalidate the read cache in cloud mode)
  setRead(id: string, read: boolean): Promise<void>;
  setArchived(id: string, archived: boolean): Promise<void>;
  setStarred(id: string, starred: boolean): Promise<void>;
  addLabel(id: string, label: string): Promise<string[]>;
  removeLabel(id: string, label: string): Promise<string[]>;
  deleteMessage(id: string): Promise<void>;
  bulk(input: MailBulkInput): Promise<MailBulkResult>;
  send(input: MailSendInput): Promise<MailSendResult>;
  clear(filter?: MailClearFilter): Promise<MailClearResult>;
}

// ── local mode ───────────────────────────────────────────────────────────────

function summaryToTuiMessage(summary: InboundEmailSummary): TuiMessage {
  const labels = summary.label_ids ?? [];
  return {
    kind: summary.is_sent ? "sent" : "inbound",
    id: summary.id,
    from: summary.from_address,
    to: (summary.to_addresses ?? []).join(", "),
    subject: summary.subject || "(no subject)",
    date: summary.received_at,
    is_read: summary.is_sent ? true : Boolean(summary.is_read),
    is_starred: Boolean(summary.is_starred),
    labels,
    snippet: "",
    thread_id: summary.thread_id ?? null,
    provider_thread_id: summary.provider_thread_id ?? null,
    attachments: summary.attachments?.length ?? 0,
    sentByMe: summary.is_sent || labels.some((label) => label.trim().toLowerCase() === "sent"),
  };
}

// Bounded id count for local bulk (mirrors the server's per-call cap semantics).
const LOCAL_BULK_MAX = 1000;

type LocalFlagSetter = (id: string) => void;
const LOCAL_BULK_FLAG_ACTIONS: Record<string, LocalFlagSetter> = {
  markRead: (id) => { setInboundReadFlag(id, true); },
  markUnread: (id) => { setInboundReadFlag(id, false); },
  star: (id) => { setInboundStarredFlag(id, true); },
  unstar: (id) => { setInboundStarredFlag(id, false); },
  archive: (id) => { setInboundArchivedFlag(id, true); },
  unarchive: (id) => { setInboundArchivedFlag(id, false); },
  delete: (id) => { deleteInboundEmail(id); },
};

export class SqliteMailDataSource implements MailDataSource {
  readonly mode = "local" as const;

  async resolveId(id: string): Promise<string> {
    // Partial-id resolution is a local SQLite concern (prefix match over inbound_emails).
    return resolvePartialIdOrThrow(getDatabase(), "inbound_emails", id);
  }

  async listMailbox(mailbox: Mailbox, opts?: MailboxListOptions): Promise<TuiMessage[]> {
    return localListMailbox(mailbox, opts);
  }

  async mailboxCounts(opts?: { source?: MailboxSource }): Promise<MailboxCounts> {
    return localMailboxCounts({ source: opts?.source });
  }

  async listMailboxStatus(opts?: MailboxStatusOptions): Promise<MailboxStatusSummary> {
    return localListMailboxStatus(opts);
  }

  async listMailboxSources(opts?: ListMailboxSourcesOptions): Promise<MailboxSourceSummary[]> {
    return localListMailboxSources(opts);
  }

  async getMessage(id: string): Promise<TuiMessage | null> {
    const summary = getInboundEmailSummary(id);
    return summary ? summaryToTuiMessage(summary) : null;
  }

  async getMessageBody(msg: TuiMessage): Promise<MessageBody | null> {
    return localGetMessageBody(msg);
  }

  async getConversation(msg: TuiMessage): Promise<TuiThreadMessage[]> {
    return localGetConversation(msg);
  }

  async getConversationBodies(msg: TuiMessage, opts?: ConversationBodyOptions): Promise<TuiThreadBody[]> {
    return localGetConversationBodies(msg, undefined, opts);
  }

  async getAttachmentPaths(id: string): Promise<AttachmentPath[]> {
    return getInboundAttachmentPaths(id) ?? [];
  }

  async listLabelSummaries(opts?: ListLabelSummaryOptions): Promise<LabelSummary[]> {
    return localListLabelSummaries(opts);
  }

  async verificationCandidates(address: string, opts?: VerificationCodeCandidateOptions): Promise<VerificationCodeEmail[]> {
    return listVerificationCodeCandidates(address, opts);
  }

  async findLatest(address: string, opts?: VerificationCodeCandidateOptions & { from?: string; subject?: string }): Promise<VerificationCodeMatch<VerificationCodeEmail> | null> {
    const candidates = await this.verificationCandidates(address, opts);
    return findVerificationCode(candidates, { from: opts?.from, subject: opts?.subject });
  }

  async changesSince(opts?: MailChangesQuery): Promise<MailChanges> {
    const summaries = listInboundEmailSummaries({ since: opts?.since, limit: opts?.limit ?? 200 });
    const messages = summaries.map(summaryToTuiMessage);
    const watermark = messages.reduce<string | null>((max, msg) => (max === null || msg.date > max ? msg.date : max), opts?.since ?? null);
    return { messages, deletedIds: [], cursor: null, watermark };
  }

  async setRead(id: string, read: boolean): Promise<void> {
    setInboundReadFlag(id, read);
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    setInboundArchivedFlag(id, archived);
  }

  async setStarred(id: string, starred: boolean): Promise<void> {
    setInboundStarredFlag(id, starred);
  }

  async addLabel(id: string, label: string): Promise<string[]> {
    return addInboundLabelSummary(id, label).label_ids;
  }

  async removeLabel(id: string, label: string): Promise<string[]> {
    return removeInboundLabelSummary(id, label).label_ids;
  }

  async deleteMessage(id: string): Promise<void> {
    deleteInboundEmail(id);
  }

  async bulk(input: MailBulkInput): Promise<MailBulkResult> {
    const setter = LOCAL_BULK_FLAG_ACTIONS[input.action];
    if (!setter) throw new Error(`unsupported local bulk action '${input.action}'`);
    let ids: string[];
    if (input.ids && input.ids.length > 0) {
      ids = input.ids.slice(0, LOCAL_BULK_MAX);
    } else {
      const rows = await this.listMailbox(input.mailbox ?? "inbox", { source: input.source, limit: LOCAL_BULK_MAX });
      ids = rows.map((row) => row.id);
    }
    let affected = 0;
    for (const id of ids) {
      try {
        setter(id);
        affected += 1;
      } catch {
        // A row that vanished between listing and mutating is not fatal for a bulk op.
      }
    }
    return { action: input.action, affected, matched: ids.length, hasMore: false, nextCursor: null };
  }

  async send(input: MailSendInput): Promise<MailSendResult> {
    let replyTo: TuiMessage | undefined;
    if (input.replyToId) replyTo = (await this.getMessage(input.replyToId)) ?? undefined;
    const compose: ComposeInput = {
      from: input.from ?? "",
      to: input.to,
      subject: input.subject,
      body: input.body,
      providerId: input.providerId,
      markdown: input.markdown,
      replyTo,
    };
    return localSendComposed(compose);
  }

  async clear(filter?: MailClearFilter): Promise<MailClearResult> {
    // Local wipe — unchanged behavior: delete the inbound store (optionally scoped to a
    // provider). The mailbox/source scope is a cloud-only refinement and is a no-op here.
    return { cleared: clearInboundEmails(filter?.providerId) };
  }
}

// ── cloud mode ───────────────────────────────────────────────────────────────

function firstDefined(...values: Array<string | null | undefined>): string {
  for (const value of values) if (typeof value === "string" && value.length > 0) return value;
  return "";
}

function labelNamesOf(item: MaileryCloudMessage): string[] {
  if (Array.isArray(item.label_names)) return item.label_names.filter((name): name is string => typeof name === "string");
  const labels = item.labels;
  if (Array.isArray(labels)) {
    return labels
      .map((label) => (typeof label === "string" ? label : label.name ?? label.label ?? ""))
      .filter((name): name is string => Boolean(name));
  }
  return [];
}

// The labels endpoint emits the per-label live count under snake + camel aliases.
function labelCount(label: MaileryCloudLabelSummary): number {
  return label.count ?? label.message_count ?? label.messageCount ?? 0;
}

function isTombstoneItem(item: MaileryCloudMessageListItem): boolean {
  const record = item as { tombstone?: boolean; deleted?: boolean; isDeleted?: boolean };
  return record.tombstone === true || record.deleted === true || record.isDeleted === true;
}

function cloudMessageDate(item: MaileryCloudMessage): string {
  return firstDefined(item.receivedAt, item.sentAt, item.sortAt, item.sort_at, item.createdAt);
}

// Extract the bare email from a possibly-decorated address ("Name <a@b.com>" -> "a@b.com").
function bareEmail(value: string): string {
  const angled = value.match(/<([^>]+)>/);
  return (angled ? angled[1]! : value).trim().toLowerCase();
}

// Drop a redundant system `unread` label from a read message's label set. The server may
// still carry it, but showing it produces a contradictory "read, unread" flag line; local
// has no such label and renders just "read", so suppress it for parity.
function visibleLabels(labels: string[], isRead: boolean): string[] {
  return isRead ? labels.filter((name) => name.trim().toLowerCase() !== "unread") : labels;
}

function cloudItemToTuiMessage(item: MaileryCloudMessage): TuiMessage {
  const direction = item.direction;
  const hasAttachments = item.hasAttachments ?? item.has_attachments ?? false;
  const isRead = item.isRead ?? true;
  return {
    kind: direction === "outbound" ? "sent" : "inbound",
    id: item.id,
    from: item.fromAddress ?? "",
    to: (item.toAddresses ?? []).join(", "),
    subject: item.subject || "(no subject)",
    date: cloudMessageDate(item),
    is_read: isRead,
    is_starred: item.isStarred ?? item.is_starred ?? false,
    labels: visibleLabels(labelNamesOf(item), isRead),
    snippet: item.snippet ?? "",
    thread_id: item.threadId ?? item.thread_id ?? null,
    provider_thread_id: null,
    attachments: hasAttachments ? 1 : 0,
    sentByMe: direction === "outbound",
  };
}

function cloudMessageToTuiMessage(msg: MaileryCloudMessageWithAttachments): TuiMessage {
  return {
    ...cloudItemToTuiMessage(msg),
    attachments: msg.attachments?.length ?? (msg.hasAttachments ? 1 : 0),
  };
}

function cloudMessageToBody(msg: MaileryCloudMessageWithAttachments): MessageBody {
  const flags = [...new Set([
    ...visibleLabels(labelNamesOf(msg), msg.isRead ?? true),
    msg.isStarred ? "starred" : "",
    msg.isRead ? "" : "unread",
    msg.isImportant ? "important" : "",
  ].filter(Boolean))];
  return {
    from: msg.fromAddress ?? "",
    to: (msg.toAddresses ?? []).join(", "),
    cc: (msg.ccAddresses ?? []).join(", "),
    subject: msg.subject || "(no subject)",
    date: cloudMessageDate(msg),
    text: msg.textBody ?? null,
    html: msg.htmlBody ?? null,
    summary: msg.summary ?? "",
    flags,
    attachments: (msg.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      content_type: attachment.contentType,
      size: attachment.sizeBytes,
      location: attachment.download_url ?? attachment.downloadUrl,
    })),
  };
}

function cloudItemToThreadMessage(item: MaileryCloudMessage): TuiThreadMessage {
  return {
    kind: item.direction === "outbound" ? "sent" : "received",
    storage: "inbound",
    id: item.id,
    from: item.fromAddress ?? "",
    subject: item.subject || "(no subject)",
    at: cloudMessageDate(item),
  };
}

function emptyCounts(): MailboxCounts {
  return { inbox: 0, unread: 0, starred: 0, sent: 0, archived: 0, spam: 0, trash: 0 };
}

function cloudGroupsToCounts(groups: MaileryCloudGroupCounts): MailboxCounts {
  return {
    inbox: groups.inbox ?? 0,
    unread: groups.unread ?? 0,
    starred: groups["starred"] ?? 0,
    sent: groups["sent"] ?? 0,
    archived: groups.archived ?? groups["archive"] ?? 0,
    spam: groups.spam ?? 0,
    trash: groups.trash ?? 0,
  };
}

// Folder → server `group`/`folder`. `archived` is the server's `archive` alias.
function folderToGroup(mailbox: Mailbox): string {
  return mailbox === "archived" ? "archive" : mailbox;
}

// True when a source actually narrows the view (so an unresolvable one must yield
// nothing rather than silently widening to the whole tenant).
function hasCloudSourceScope(source?: MailboxSource): boolean {
  return Boolean(source && (source.sourceId || source.providerId || source.address || source.domain || source.s3Bucket));
}

// Safety cap on delta-feed pages drained in a single changesSince call. If the feed
// has more, the watermark is NOT advanced and a resume cursor is returned so the next
// call continues from exactly where this one stopped (no gap, no lost newest rows).
const CLOUD_MAX_CHANGE_PAGES = 25;

// Safety cap on keyset-cursor pages walked to satisfy one listMailbox call. The server
// pages by cursor (no offset), so --offset is translated into cursor hops; this bounds
// how deep an offset can page before the client asks the user to narrow the query.
const CLOUD_MAX_LIST_PAGES = 50;

// Safety cap on pages scanned to resolve a short id prefix (as printed by `inbox list`)
// to a full cloud id. Deep enough to cover a large working set without an unbounded scan.
const CLOUD_MAX_RESOLVE_PAGES = 10;

// A complete server message id (uuidv7). Used verbatim; anything shorter is a prefix
// that resolveId matches over a bounded recent scan.
const CLOUD_FULL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Safety guard on bulk-delete pages drained by a single clear() so a server that always
// reports `hasMore` cannot spin forever. Large enough to clear a real mailbox.
const CLOUD_MAX_CLEAR_PAGES = 1000;

// The changes projection omits updated_at, so the watermark is a client-clock instant.
// Advancing it slightly in the past guards against modest forward clock skew: the
// next call re-reads a small overlap (deduped by id) instead of risking a gap.
const CLOUD_WATERMARK_OVERLAP_MS = 5_000;

interface CachedCloudPage {
  data: MaileryCloudMessage[];
  nextCursor: string | null;
}

export interface ApiMailDataSourceOptions {
  client: MaileryCloudClient;
  cache?: MailCache;
  now?: () => number;
  /** Default list page size. */
  listLimit?: number;
}

export class ApiMailDataSource implements MailDataSource {
  readonly mode = "cloud" as const;
  private readonly client: MaileryCloudClient;
  private readonly cache: MailCache;
  private readonly now: () => number;
  private readonly listLimit: number;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(options: ApiMailDataSourceOptions) {
    this.client = options.client;
    this.cache = options.cache ?? new MailCache({ now: options.now });
    this.now = options.now ?? Date.now;
    this.listLimit = options.listLimit ?? 200;
  }

  /** Await all in-flight stale-while-revalidate background refreshes (test hook). */
  async settle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private track(promise: Promise<unknown>): void {
    const wrapped = promise.catch(() => {}).finally(() => this.pending.delete(wrapped));
    this.pending.add(wrapped);
  }

  private async cloudMailboxes(): Promise<MaileryCloudMailbox[]> {
    const cached = this.cache.getMailboxes<MaileryCloudMailbox[]>();
    if (cached) return cached;
    const list = await this.client.listMailboxes();
    this.cache.setMailboxes(list);
    return list;
  }

  // Resolve a MailboxSource to a cloud mailbox id. A cloud source summary carries the
  // mailbox id as `providerId` and `sourceId` = "provider:<id>" (see listMailboxSources),
  // so those resolve directly; an `address` resolves by matching the mailbox email.
  private async resolveCloudMailboxId(source?: MailboxSource): Promise<string | undefined> {
    if (!source) return undefined;
    const fromSourceId = source.sourceId?.startsWith("provider:") ? source.sourceId.slice("provider:".length) : undefined;
    const direct = source.providerId ?? fromSourceId;
    const address = source.address?.trim().toLowerCase();
    if (!direct && !address) return undefined;
    const mailboxes = await this.cloudMailboxes();
    if (direct && mailboxes.some((mailbox) => mailbox.id === direct)) return direct;
    if (address) return mailboxes.find((mailbox) => mailbox.email.toLowerCase() === address)?.id;
    return undefined;
  }

  private async fetchPageInto(key: string, query: { group?: string; q?: string; mailboxId?: string; cursor?: string; limit?: number }): Promise<CachedCloudPage> {
    // Capture the invalidation epoch BEFORE the request so a write/delta that lands
    // while this fetch is in flight can veto caching pre-write data (coherence guard).
    const epoch = this.cache.epoch;
    const page = await this.client.listMessagesPage({
      group: query.group,
      q: query.q,
      mailboxId: query.mailboxId,
      cursor: query.cursor,
      limit: query.limit ?? this.listLimit,
    });
    const data = page.data.filter((item): item is MaileryCloudMessage => !isTombstoneItem(item));
    const stored: CachedCloudPage = { data, nextCursor: page.nextCursor };
    if (this.cache.epoch === epoch) this.cache.setPage(key, stored);
    return stored;
  }

  // Read-through with stale-while-revalidate: a fresh hit is served from cache; a
  // stale hit is served immediately while a background refresh runs; a miss fetches.
  private async readPage(key: string, query: { group?: string; q?: string; mailboxId?: string; cursor?: string; limit?: number }): Promise<CachedCloudPage> {
    const peeked = this.cache.peekPage<CachedCloudPage>(key);
    if (peeked?.fresh) return peeked.value;
    if (peeked) {
      this.track(this.fetchPageInto(key, query));
      return peeked.value;
    }
    return this.fetchPageInto(key, query);
  }

  private async fetchFullMessage(id: string): Promise<MaileryCloudMessageWithAttachments> {
    const cached = this.cache.getBody<MaileryCloudMessageWithAttachments>(id);
    if (cached) return cached;
    const full = await this.client.getMessage(id);
    this.cache.setBody(id, full);
    return full;
  }

  async resolveId(id: string): Promise<string> {
    const trimmed = id.trim();
    // A full uuidv7 is a complete id — use it verbatim (the common `read`-a-known-id path).
    if (CLOUD_FULL_ID_RE.test(trimmed)) return trimmed;
    // Resolve a short prefix (as printed by `inbox list`) to a full id by matching a UNIQUE
    // id prefix over a bounded recent scan (never an unbounded walk of a huge mailbox).
    const matches = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < CLOUD_MAX_RESOLVE_PAGES; page += 1) {
      const result = await this.client.listMessagesPage({ cursor, limit: this.listLimit });
      for (const item of result.data) {
        if (isTombstoneItem(item)) continue;
        const fullId = (item as MaileryCloudMessage).id;
        if (fullId === trimmed) return fullId; // exact hit (e.g. a non-uuid id) — done
        if (fullId.startsWith(trimmed)) matches.add(fullId);
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    if (matches.size === 1) return [...matches][0]!;
    if (matches.size > 1) {
      throw new Error(`Ambiguous email id prefix '${trimmed}' — it matches ${matches.size} messages. Use a longer id.`);
    }
    // No match in the scanned window: hand the original back so the server returns a clear
    // 404 for the id the user typed (rather than a confusing client-side error).
    return trimmed;
  }

  async listMailbox(mailbox: Mailbox, opts?: MailboxListOptions): Promise<TuiMessage[]> {
    const group = folderToGroup(mailbox);
    const mailboxId = await this.resolveCloudMailboxId(opts?.source);
    // A specified-but-unresolvable source narrows to nothing (never widens to tenant).
    if (!mailboxId && hasCloudSourceScope(opts?.source)) return [];
    // The server pages by KEYSET cursor (no offset), so honor `limit` by requesting pages
    // of that size and translate `offset` into bounded cursor hops. Each page is cached
    // under its own cursor+limit key, so successive `--offset` pages hit different rows.
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : this.listLimit;
    const offset = opts?.offset && opts.offset > 0 ? opts.offset : 0;
    let skip = offset;
    const collected: MaileryCloudMessage[] = [];
    let cursor: string | undefined;
    let more = true;
    let pages = 0;
    while (collected.length < limit && more && pages < CLOUD_MAX_LIST_PAGES) {
      const key = messagePageCacheKey({ group, q: opts?.search, cursor: cursor ?? "", mailbox: mailboxId, limit });
      const result = await this.readPage(key, { group, q: opts?.search, mailboxId, cursor, limit });
      for (const item of result.data) {
        if (skip > 0) { skip -= 1; continue; }
        if (collected.length >= limit) break;
        collected.push(item);
      }
      cursor = result.nextCursor ?? undefined;
      more = Boolean(cursor);
      pages += 1;
    }
    // Budget exhausted (still more rows on the server) before the requested offset window
    // could be satisfied: refuse with a clear message rather than SILENTLY truncating —
    // returning an empty OR a short (< limit) page here would read as "end of mailbox".
    // A drained feed (more === false) is the legitimate tail: return whatever was collected.
    if (more && collected.length < limit && pages >= CLOUD_MAX_LIST_PAGES && offset > 0) {
      throw new Error(`Cloud offset ${offset} is too deep to page within ${CLOUD_MAX_LIST_PAGES} pages of ${limit}. Narrow with --search/--folder, or use a smaller --offset.`);
    }
    return collected.map(cloudItemToTuiMessage);
  }

  async mailboxCounts(opts?: { source?: MailboxSource }): Promise<MailboxCounts> {
    const mailboxId = await this.resolveCloudMailboxId(opts?.source);
    if (!mailboxId && hasCloudSourceScope(opts?.source)) return emptyCounts();
    const key = countsCacheKey({ mailbox: mailboxId });
    const peeked = this.cache.peekCounts<MailboxCounts>(key);
    if (peeked?.fresh) return peeked.value;
    if (peeked) {
      this.track(this.refreshCounts(key, mailboxId));
      return peeked.value;
    }
    return this.refreshCounts(key, mailboxId);
  }

  private async refreshCounts(key: string, mailboxId?: string): Promise<MailboxCounts> {
    const epoch = this.cache.epoch;
    const groups = await this.client.messageGroups({ mailboxId });
    const counts = cloudGroupsToCounts(groups);
    if (this.cache.epoch === epoch) this.cache.setCounts(key, counts);
    return counts;
  }

  async listMailboxStatus(opts?: MailboxStatusOptions): Promise<MailboxStatusSummary> {
    const counts = await this.mailboxCounts({ source: opts?.source });
    return {
      counts,
      folders: MAILBOXES.map((folder) => ({ id: folder, folder, label: mailboxLabel(folder), count: counts[folder] })),
    };
  }

  async listMailboxSources(opts?: ListMailboxSourcesOptions): Promise<MailboxSourceSummary[]> {
    const includeLatest = opts?.includeLatest ?? true;
    const mailboxes = await this.cloudMailboxes();
    return Promise.all(mailboxes.map(async (mailbox) => {
      // Per-mailbox counts come from messageGroups (the same O(1) counter path
      // mailboxCounts uses); the latest-received timestamp from a single-row page read.
      // The latest probe is a SECOND round-trip per source — skipped when the
      // caller does not need it (the status path) to avoid the cloud N+1 timeout.
      const [groups, latestPage] = await Promise.all([
        this.client.messageGroups({ mailboxId: mailbox.id }),
        includeLatest
          ? this.client.listMessagesPage({ mailboxId: mailbox.id, limit: 1 })
          : Promise.resolve({ data: [] as MaileryCloudMessageListItem[], nextCursor: null }),
      ]);
      const counts = cloudGroupsToCounts(groups);
      const latest = latestPage.data.find((item): item is MaileryCloudMessage => !isTombstoneItem(item));
      return {
        id: `provider:${mailbox.id}`,
        label: mailbox.name ?? mailbox.email,
        kind: "provider" as const,
        providerId: mailbox.id,
        providerName: mailbox.name ?? undefined,
        providerType: mailbox.provider,
        badges: [],
        counts,
        total: groups.total ?? 0,
        unread: counts.unread,
        latestReceivedAt: latest ? cloudMessageDate(latest) : null,
      };
    }));
  }

  async getMessage(id: string): Promise<TuiMessage | null> {
    const full = await this.fetchFullMessage(id);
    return cloudMessageToTuiMessage(full);
  }

  async getMessageBody(msg: TuiMessage): Promise<MessageBody | null> {
    const full = await this.fetchFullMessage(msg.id);
    return cloudMessageToBody(full);
  }

  async getConversation(msg: TuiMessage): Promise<TuiThreadMessage[]> {
    return this.cloudThreadItems(msg);
  }

  // Thread items oldest-first (listThread is newest-first) to match the local
  // getConversation ordering the reader renders top-to-bottom.
  private async cloudThreadItems(msg: TuiMessage): Promise<TuiThreadMessage[]> {
    if (!msg.thread_id) return [];
    const page = await this.client.listThread(msg.thread_id, { limit: this.listLimit });
    return page.data
      .filter((item): item is MaileryCloudMessage => !isTombstoneItem(item))
      .map(cloudItemToThreadMessage)
      .reverse();
  }

  async getConversationBodies(msg: TuiMessage, opts?: ConversationBodyOptions): Promise<TuiThreadBody[]> {
    const thread = await this.cloudThreadItems(msg);
    // Fall back to the selected message alone (mirrors SqliteMailDataSource) so the
    // reader always has at least the open message's body, even with no thread.
    const items: TuiThreadMessage[] = thread.length > 0
      ? thread
      : [{
        kind: msg.sentByMe ? "sent" : "received",
        storage: "inbound",
        id: msg.id,
        from: msg.from,
        subject: msg.subject,
        at: msg.date,
      }];
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : undefined;
    const scoped = limit && items.length > limit ? items.slice(-limit) : items;
    return Promise.all(scoped.map(async (item) => {
      const full = await this.fetchFullMessage(item.id);
      return { item, body: cloudMessageToBody(full) };
    }));
  }

  async getAttachmentPaths(id: string): Promise<AttachmentPath[]> {
    const full = await this.fetchFullMessage(id);
    return (full.attachments ?? []).map((attachment) => {
      const url = attachment.download_url ?? attachment.downloadUrl;
      // Surface the server download URL so cloud `get_attachment` / `inbox attachment`
      // return a fetchable location instead of bare metadata.
      return {
        filename: attachment.filename,
        content_type: attachment.contentType,
        size: attachment.sizeBytes,
        ...(url ? { s3_url: url } : {}),
      };
    });
  }

  async listLabelSummaries(opts?: ListLabelSummaryOptions): Promise<LabelSummary[]> {
    // Authoritative: GET /api/v1/labels returns the tenant's full label set with real
    // per-label counts, so the client no longer derives labels from a sampled page. The
    // full set is cached; the caller's search/limit are applied per call over it.
    const summaries = this.cache.getLabels<LabelSummary[]>() ?? await this.loadCloudLabels();
    const q = opts?.search?.trim().toLowerCase();
    const filtered = q ? summaries.filter((label) => label.name.toLowerCase().includes(q)) : summaries;
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 50;
    return filtered.slice(0, limit);
  }

  private async loadCloudLabels(): Promise<LabelSummary[]> {
    const labels = await this.client.listLabels();
    const summaries: LabelSummary[] = labels
      .map((label) => {
        const count = labelCount(label);
        return { name: label.name, count, popular: count > 0 };
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    this.cache.setLabels(summaries);
    return summaries;
  }

  async verificationCandidates(address: string, opts?: VerificationCodeCandidateOptions): Promise<VerificationCodeEmail[]> {
    // The server's search UNION now matches recipients_text (to/cc) as well as
    // subject/from/snippet, so a by-recipient lookup resolves SERVER-SIDE and complete
    // via `q` — not by scanning a bounded recent window. The exact-recipient guard below
    // still narrows the fuzzy trigram match to messages addressed TO the target.
    const limit = opts?.limit ?? 20;
    const target = address.trim().toLowerCase();
    const from = opts?.from?.trim().toLowerCase();
    const subject = opts?.subject?.trim().toLowerCase();
    const page = await this.client.listMessagesPage({ q: target, limit: Math.max(limit, 50) });
    const candidates: VerificationCodeEmail[] = [];
    for (const item of page.data) {
      if (isTombstoneItem(item)) continue;
      const message = item as MaileryCloudMessage;
      const recipients = (message.toAddresses ?? []).map(bareEmail);
      if (!recipients.includes(target)) continue;
      if (opts?.since && cloudMessageDate(message) < opts.since) continue;
      if (from && !(message.fromAddress ?? "").toLowerCase().includes(from)) continue;
      if (subject && !(message.subject ?? "").toLowerCase().includes(subject)) continue;
      const full = await this.fetchFullMessage(message.id);
      candidates.push({
        id: full.id,
        from_address: full.fromAddress ?? "",
        subject: full.subject || "",
        text_body: full.textBody ?? null,
        html_body: full.htmlBody ?? null,
        received_at: cloudMessageDate(full),
      });
      if (candidates.length >= limit) break;
    }
    return candidates;
  }

  async findLatest(address: string, opts?: VerificationCodeCandidateOptions & { from?: string; subject?: string }): Promise<VerificationCodeMatch<VerificationCodeEmail> | null> {
    const candidates = await this.verificationCandidates(address, opts);
    return findVerificationCode(candidates, { from: opts?.from, subject: opts?.subject });
  }

  async changesSince(opts?: MailChangesQuery): Promise<MailChanges> {
    // Capture the client clock BEFORE reading. The changes projection omits updated_at
    // (see the returned FLAG), so a precise per-row watermark isn't derivable from the
    // response; the watermark is a wall-clock instant instead, nudged slightly into the
    // past to absorb modest forward clock skew (server gte is inclusive; the feed is
    // at-least-once and deduped by id).
    const startedAt = new Date(this.now() - CLOUD_WATERMARK_OVERLAP_MS).toISOString();
    const since = opts?.since ?? this.cache.watermark ?? null;
    const resume = opts?.cursor;

    // Cold start (no watermark, no explicit since, no resume cursor): establish the
    // baseline instead of pulling the entire mailbox. The thin client is not a mirror;
    // lists are fetched on demand via the SWR read cache.
    if (since === null && !resume) {
      this.cache.advanceWatermark(startedAt);
      return { messages: [], deletedIds: [], cursor: null, watermark: this.cache.watermark };
    }

    const mailboxId = await this.resolveCloudMailboxId(opts?.source);
    const seen = new Map<string, TuiMessage>();
    let cursor: string | undefined = resume;
    let drained = true;
    for (let page = 0; ; page += 1) {
      const result = await this.client.listMessageChanges({ updatedSince: since ?? undefined, mailboxId, cursor, limit: this.listLimit });
      for (const item of result.data) {
        if (isTombstoneItem(item)) continue;
        seen.set(item.id, cloudItemToTuiMessage(item as MaileryCloudMessage));
      }
      cursor = result.nextCursor ?? undefined;
      if (!cursor) break;
      // Feed longer than the per-call safety cap: stop, do NOT advance the watermark,
      // and hand back the cursor so the caller resumes with the SAME `since`.
      if (page + 1 >= CLOUD_MAX_CHANGE_PAGES) { drained = false; break; }
    }

    const tombstones = await this.client.listMessageTombstones({ since: since ?? undefined, mailboxId });
    const deletedIds = [...new Set(
      tombstones
        .map((tombstone) => tombstone.message_id ?? tombstone.id)
        .filter((id): id is string => Boolean(id)),
    )];

    const messages = [...seen.values()];
    this.cache.applyDelta({ changed: messages.map((message) => message.id), deleted: deletedIds });
    // Only advance the watermark once the feed is fully drained — otherwise the newest
    // (highest updated_at) rows are still unread and a watermark jump would lose them.
    if (drained) this.cache.advanceWatermark(startedAt);
    return { messages, deletedIds, cursor: drained ? null : (cursor ?? null), watermark: this.cache.watermark };
  }

  async setRead(id: string, read: boolean): Promise<void> {
    await this.client.patchMessage(id, { isRead: read });
    this.cache.invalidateWrite([id]);
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    await this.client.patchMessage(id, { isArchived: archived });
    this.cache.invalidateWrite([id]);
  }

  async setStarred(id: string, starred: boolean): Promise<void> {
    await this.client.setMessageStarred(id, starred);
    this.cache.invalidateWrite([id]);
  }

  async addLabel(id: string, label: string): Promise<string[]> {
    const result = await this.client.addMessageLabel(id, label);
    this.cache.invalidateWrite([id]);
    return result.label_names;
  }

  async removeLabel(id: string, label: string): Promise<string[]> {
    const result = await this.client.removeMessageLabel(id, label);
    this.cache.invalidateWrite([id]);
    return result.label_names;
  }

  async deleteMessage(id: string): Promise<void> {
    await this.client.deleteMessage(id);
    this.cache.invalidateWrite([id]);
  }

  async bulk(input: MailBulkInput): Promise<MailBulkResult> {
    const mailboxId = await this.resolveCloudMailboxId(input.source);
    const result = await this.client.bulkMessageAction({
      action: input.action,
      ids: input.ids,
      mailboxId,
      folder: input.mailbox ? folderToGroup(input.mailbox) : undefined,
      label: input.label,
      cursor: input.cursor,
    });
    this.cache.invalidateWrite(input.ids ?? []);
    return {
      action: result.action,
      affected: result.affected,
      matched: result.matched,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
    };
  }

  async send(input: MailSendInput): Promise<MailSendResult> {
    // The server /messages/send endpoint carries neither attachments nor a schedule, so
    // fail closed with a clear message rather than silently dropping them.
    if (input.attachments && input.attachments.length > 0) {
      throw new Error("Cloud send does not support attachments yet. Send without --attachment, or use local mode.");
    }
    if (input.scheduledAt) {
      throw new Error("Scheduling is not available in cloud mode. Send without --schedule, or use local mode.");
    }
    const mailboxId = input.mailboxId ?? await this.resolveCloudMailboxId({ address: input.from });
    if (!mailboxId) throw new Error("cloud send requires a mailboxId (or a `from` matching a cloud mailbox)");
    const toList = input.to.split(",").map((value) => value.trim()).filter(Boolean);
    const ccList = input.cc?.split(",").map((value) => value.trim()).filter(Boolean);
    const bccList = input.bcc?.split(",").map((value) => value.trim()).filter(Boolean);
    const replyToList = input.replyTo?.split(",").map((value) => value.trim()).filter(Boolean);
    // Match the local compose path: an explicit HTML body wins; otherwise treat the body
    // as markdown by default and send an HTML part alongside the raw text (opt out with
    // markdown: false).
    const useMarkdown = input.markdown !== false && input.body.trim().length > 0;
    const html = input.html ?? (useMarkdown ? renderMarkdown(input.body) : undefined);
    const result = await this.client.sendMessage({
      mailboxId,
      to: toList,
      cc: ccList && ccList.length > 0 ? ccList : undefined,
      bcc: bccList && bccList.length > 0 ? bccList : undefined,
      replyTo: replyToList && replyToList.length > 0 ? replyToList : undefined,
      subject: input.subject,
      text: input.body,
      html,
    });
    this.cache.invalidateWrite();
    return { id: result.id, messageId: firstDefined(result.provider_message_id, result.providerMessageId, result.id) };
  }

  async clear(filter?: MailClearFilter): Promise<MailClearResult> {
    // Cloud has no local store to wipe: drain a server-side bulk delete over the
    // requested mailbox/folder filter (default: the inbox folder), following the resume
    // cursor until the server reports no more. Scoped — never an unbounded tenant wipe.
    const source = filter?.source ?? (filter?.providerId ? { providerId: filter.providerId } : undefined);
    // A requested-but-unresolvable scope must REFUSE rather than silently widen to a
    // folder-only (tenant-wide) delete — mirrors the read guard (listMailbox returns
    // nothing for an unresolvable source instead of the whole tenant).
    if (hasCloudSourceScope(source) && !(await this.resolveCloudMailboxId(source))) {
      throw new Error("Cannot clear: the requested provider/source does not match a cloud mailbox. Omit the filter to clear the inbox folder, or pass a valid mailbox.");
    }
    const mailbox: Mailbox = filter?.mailbox ?? "inbox";
    let cleared = 0;
    let cursor: string | undefined;
    for (let page = 0; page < CLOUD_MAX_CLEAR_PAGES; page += 1) {
      const result = await this.bulk({ action: "delete", mailbox, source, cursor });
      cleared += result.affected;
      if (!result.hasMore || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return { cleared };
  }
}

// ── resolver (memoized per process) ──────────────────────────────────────────

function stringConfig(key: string): string | undefined {
  const value = getConfigValue(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Build a MaileryCloudClient from config/env. Base URL is fully configurable — a
// self-hosted server is just `cloud_api_url` (or MAILERY_CLOUD_API_URL/MAILERY_API_URL)
// pointed at the private host; no platform hostname is hardcoded here.
export function buildDefaultCloudClient(): MaileryCloudClient {
  const apiUrl = stringConfig("cloud_api_url")
    ?? process.env["MAILERY_CLOUD_API_URL"]
    ?? process.env["MAILERY_API_URL"]
    ?? undefined;
  const token = process.env["MAILERY_API_KEY"]
    ?? process.env["MAILERY_CLOUD_TOKEN"]
    ?? stringConfig("cloud_session_token")
    ?? stringConfig("cloud_api_key");
  return new MaileryCloudClient({ apiUrl, token });
}

function toDataSourceMode(mode: MaileryMode): MailDataSourceMode {
  // Target architecture: two modes. "self_hosted" is cloud pointed at a private URL.
  return mode === "local" ? "local" : "cloud";
}

export interface ResolveMailDataSourceOptions {
  mode?: MailDataSourceMode;
  client?: MaileryCloudClient;
  cache?: MailCache;
}

let memoized: { mode: MailDataSourceMode; source: MailDataSource } | null = null;

/**
 * Resolve the process-wide MailDataSource for the active mode, memoized. An explicit
 * `mode`/`client`/`cache` (tests, or an override) bypasses and does not poison the memo.
 */
export function resolveMailDataSource(opts: ResolveMailDataSourceOptions = {}): MailDataSource {
  const override = Boolean(opts.mode || opts.client || opts.cache);

  // Fleet self-hosted flip: HASNA_MAILERY_API_URL + HASNA_MAILERY_API_KEY present
  // (cred-based — the SAME gate the domains resource uses) routes the inbox seam
  // to the app's OWN /v1 resource API on mailery.hasna.xyz, NOT the mailery.co
  // SaaS `/api/v1` shape. This takes precedence over the mode var because the
  // flip sets creds only (no *_MODE), and getMaileryMode() defaults to `local`.
  if (!override) {
    const selfHosted = resolveSelfHostedMailDataSource();
    if (selfHosted) {
      if (memoized && memoized.source instanceof SelfHostedMailDataSource) return memoized.source;
      memoized = { mode: "cloud", source: selfHosted };
      return selfHosted;
    }
  }

  const mode = opts.mode ?? toDataSourceMode(getMaileryMode());
  if (!override && memoized && memoized.mode === mode && !(memoized.source instanceof SelfHostedMailDataSource)) {
    return memoized.source;
  }

  const source: MailDataSource = mode === "cloud"
    ? new ApiMailDataSource({ client: opts.client ?? buildDefaultCloudClient(), cache: opts.cache })
    : new SqliteMailDataSource();

  if (!override) memoized = { mode, source };
  return source;
}

/** Clear the memoized data source (tests / after a mode change). */
export function resetMailDataSource(): void {
  memoized = null;
}
