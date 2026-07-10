// MailDataSource — the read/write seam the TUI/CLI/MCP will sit behind.
//
// There are exactly two backends:
//   • SqliteMailDataSource — `local` mode. A thin async wrapper over the EXISTING
//     local read/write logic (src/db/inbound.ts + src/cli/tui/data.ts). It does not
//     duplicate that logic; it calls it. SQLite stays the local source of truth.
//   • SelfHostedMailDataSource — `self_hosted` mode pointed at an operator-owned
//     server via a configurable HTTPS base URL. It holds no DB credentials and
//     reads/writes only through the authenticated versioned HTTP API.
//
// The seam speaks the client's existing domain language (TuiMessage / Folder /
// MailboxCounts / MessageBody / …) so the eventual rewire of the callers is minimal:
// SqliteMailDataSource returns those types verbatim, and SelfHostedMailDataSource translates
// self_hosted DTOs into them.
//
// Callers resolve this seam once and stay independent of the selected backend.

import { getDatabase, resolvePartialIdOrThrow } from "../db/database.js";
import { getEmailsMode, type EmailsMode } from "./mode.js";
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

export type MailDataSourceMode = EmailsMode;

export interface MailChangesQuery {
  /** Watermark: only messages created-or-changed at/after this ISO timestamp. */
  since?: string;
  /** Folder scope (self_hosted maps to a group; local narrows the recent-message read). */
  mailbox?: Mailbox;
  /** Source/mailbox scope. */
  source?: MailboxSource;
  limit?: number;
  /**
   * Continuation cursor from a prior MailChanges.cursor. When the delta feed had
   * more than one call could drain, pass this back (with the SAME `since`) to resume
   * with no gap. Self-hosted only.
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

/** A base64 inline attachment for local/provider or bounded self-hosted send. */
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
  /** self_hosted: sending mailbox id (else resolved from `from`). */
  mailboxId?: string;
  /** Message id to reply to (threading). */
  replyToId?: string;
  /** Reply-To header address(es), comma-separated. */
  replyTo?: string;
  /** File attachments. Self-hosted JSON send enforces its smaller documented caps. */
  attachments?: MailSendAttachment[];
  /** ISO-8601 schedule time. Self-hosted send rejects this (no server-side scheduling). */
  scheduledAt?: string;
  /** Stable caller-provided key used to make self-hosted sends retry-safe. */
  idempotencyKey?: string;
}

export interface MailSendResult {
  id: string;
  messageId: string;
}

/**
 * Scope for a clear (bulk delete). local wipes the inbound store (optionally by
 * provider); self_hosted drains a bulk delete over the mailbox/folder filter.
 */
export interface MailClearFilter {
  /** local: provider filter; self_hosted: resolves to a mailbox-id scope. */
  providerId?: string;
  /** self_hosted: folder scope (defaults to inbox). local: ignored — the store is wiped. */
  mailbox?: Mailbox;
  /** self_hosted: mailbox/source scope. */
  source?: MailboxSource;
}

export interface MailClearResult {
  cleared: number;
}

export interface MailDataSource {
  readonly mode: MailDataSourceMode;

  /**
   * Resolve a possibly-partial id (the short id printed by `inbox list`) to a full id
   * usable on every read/write. local: SQLite partial-id resolution. self_hosted: matches a
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

  // writes (all bypass + invalidate the read cache in self_hosted mode)
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
    // provider). The mailbox/source scope is a self_hosted-only refinement and is a no-op here.
    return { cleared: clearInboundEmails(filter?.providerId) };
  }
}

// ── resolver (memoized per process) ───────────────────────────────────────────────────────────────────────────────────

export interface ResolveMailDataSourceOptions {
  mode?: MailDataSourceMode;
  selfHosted?: SelfHostedMailDataSource;
}

let memoized: { mode: MailDataSourceMode; source: MailDataSource } | null = null;

/**
 * Resolve the process-wide MailDataSource for the active mode. Self-hosted mode
 * always uses the operator-configured Emails API; it never falls through to SQLite.
 */
export function resolveMailDataSource(opts: ResolveMailDataSourceOptions = {}): MailDataSource {
  const override = Boolean(opts.mode || opts.selfHosted);
  const mode = opts.mode ?? getEmailsMode();
  if (!override && memoized?.mode === mode) {
    return memoized.source;
  }
  let source: MailDataSource;
  if (mode === "self_hosted") {
    const selfHosted = opts.selfHosted ?? resolveSelfHostedMailDataSource();
    if (!selfHosted) {
      throw new Error(
        "Emails self_hosted mode requires EMAILS_SELF_HOSTED_URL and EMAILS_SELF_HOSTED_API_KEY. " +
          "No hosted endpoint is inferred.",
      );
    }
    source = selfHosted;
  } else {
    source = new SqliteMailDataSource();
  }

  if (!override) memoized = { mode, source };
  return source;
}

/** Clear the memoized data source (tests / after a mode change). */
export function resetMailDataSource(): void {
  memoized = null;
}
