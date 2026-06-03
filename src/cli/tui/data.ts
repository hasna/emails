/**
 * Data layer for the interactive mail TUI (`emails interactive`).
 *
 * Presents a Gmail-like unified view over the local store: inbound mail
 * (SES-S3 / SMTP / Gmail, with read-state/star/archive/labels) and sent mail,
 * grouped into mailboxes. Pure-ish and DB-backed so it can be unit-tested
 * without a terminal.
 */
import type { Database } from "../../db/database.js";
import { getDatabase } from "../../db/database.js";
import {
  listInboundEmails, getInboundEmail, getUnreadCount,
  setInboundRead, setInboundArchived, setInboundStarred,
} from "../../db/inbound.js";
import { listEmails, getEmail, createEmail } from "../../db/emails.js";
import { getEmailContent, storeEmailContent } from "../../db/email-content.js";
import { getThreadMessages } from "../../db/threads.js";
import { listProviders } from "../../db/providers.js";
import { sendWithFailover } from "../../lib/send.js";

export type Mailbox = "inbox" | "unread" | "starred" | "sent" | "archived";

export const MAILBOXES: Mailbox[] = ["inbox", "unread", "starred", "sent", "archived"];

export function mailboxLabel(m: Mailbox): string {
  return { inbox: "Inbox", unread: "Unread", starred: "Starred", sent: "Sent", archived: "Archived" }[m];
}

export interface TuiMessage {
  kind: "inbound" | "sent";
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  is_read: boolean;
  is_starred: boolean;
  labels: string[];
  snippet: string;
  thread_id: string | null;
}

function snippetOf(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, 100);
}

function inboundToMessage(e: ReturnType<typeof getInboundEmail> & object): TuiMessage {
  return {
    kind: "inbound",
    id: e.id,
    from: e.from_address,
    to: e.to_addresses.join(", "),
    subject: e.subject || "(no subject)",
    date: e.received_at,
    is_read: e.is_read,
    is_starred: e.is_starred,
    labels: e.label_ids,
    snippet: snippetOf(e.text_body),
    thread_id: e.thread_id,
  };
}

/** List the messages in a mailbox, newest first. */
export function listMailbox(mailbox: Mailbox, opts?: { limit?: number; search?: string }, db?: Database): TuiMessage[] {
  const d = db || getDatabase();
  const limit = opts?.limit ?? 200;
  let messages: TuiMessage[];

  if (mailbox === "sent") {
    messages = listEmails({ limit }, d).map((e) => ({
      kind: "sent" as const,
      id: e.id,
      from: e.from_address,
      to: e.to_addresses.join(", "),
      subject: e.subject || "(no subject)",
      date: e.sent_at,
      is_read: true,
      is_starred: false,
      labels: [],
      snippet: snippetOf(getEmailContent(e.id, d)?.text_body),
      thread_id: (e as { thread_id?: string | null }).thread_id ?? null,
    }));
  } else {
    const filter: Parameters<typeof listInboundEmails>[0] = { limit };
    if (mailbox === "unread") filter.unread = true;
    else if (mailbox === "starred") filter.starred = true;
    else if (mailbox === "archived") filter.archived = true;
    messages = listInboundEmails(filter, d).map(inboundToMessage);
  }

  if (opts?.search) {
    const q = opts.search.toLowerCase();
    messages = messages.filter((m) =>
      m.subject.toLowerCase().includes(q) || m.from.toLowerCase().includes(q) || m.snippet.toLowerCase().includes(q));
  }
  return messages;
}

export interface MailboxCounts { inbox: number; unread: number; starred: number; sent: number; archived: number }

export function mailboxCounts(db?: Database): MailboxCounts {
  const d = db || getDatabase();
  return {
    inbox: listInboundEmails({ limit: 10_000 }, d).length,
    unread: getUnreadCount(undefined, d),
    starred: listInboundEmails({ starred: true, limit: 10_000 }, d).length,
    sent: listEmails({ limit: 10_000 }, d).length,
    archived: listInboundEmails({ archived: true, limit: 10_000 }, d).length,
  };
}

export interface MessageBody {
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  text: string | null;
  html: string | null;
  flags: string[];
}

export function getMessageBody(msg: TuiMessage, db?: Database): MessageBody | null {
  const d = db || getDatabase();
  if (msg.kind === "inbound") {
    const e = getInboundEmail(msg.id, d);
    if (!e) return null;
    return {
      from: e.from_address, to: e.to_addresses.join(", "), cc: e.cc_addresses.join(", "),
      subject: e.subject || "(no subject)", date: e.received_at,
      text: e.text_body, html: e.html_body,
      flags: [e.is_read ? "read" : "unread", e.is_starred && "starred", e.is_archived && "archived", ...e.label_ids].filter(Boolean) as string[],
    };
  }
  const e = getEmail(msg.id, d);
  if (!e) return null;
  const content = getEmailContent(e.id, d);
  return {
    from: e.from_address, to: e.to_addresses.join(", "), cc: e.cc_addresses.join(", "),
    subject: e.subject || "(no subject)", date: e.sent_at,
    text: content?.text_body ?? null, html: content?.html ?? null,
    flags: ["sent", e.status].filter(Boolean) as string[],
  };
}

/** The full conversation (sent + received) for a message's thread, oldest first. */
export function getConversation(msg: TuiMessage, db?: Database): Array<{ kind: "sent" | "received"; from: string; subject: string; at: string }> {
  if (!msg.thread_id) return [];
  return getThreadMessages(msg.thread_id, db);
}

// ── mutations (inbound only; sent messages are immutable) ──────────────────────

export function toggleStar(msg: TuiMessage, db?: Database): boolean {
  if (msg.kind !== "inbound") return msg.is_starred;
  return setInboundStarred(msg.id, !msg.is_starred, db).is_starred;
}
export function toggleRead(msg: TuiMessage, db?: Database): boolean {
  if (msg.kind !== "inbound") return msg.is_read;
  return setInboundRead(msg.id, !msg.is_read, db).is_read;
}
export function markRead(msg: TuiMessage, db?: Database): void {
  if (msg.kind === "inbound" && !msg.is_read) setInboundRead(msg.id, true, db);
}
export function archiveMessage(msg: TuiMessage, archived = true, db?: Database): void {
  if (msg.kind === "inbound") setInboundArchived(msg.id, archived, db);
}

// ── compose / reply ────────────────────────────────────────────────────────────

export function activeProviderId(db?: Database): string | null {
  const d = db || getDatabase();
  const active = listProviders(d).filter((p) => p.active);
  return active[0]?.id ?? null;
}

/** Pre-fill values for replying to a message. */
export function replyDefaults(msg: TuiMessage): { from: string; to: string; subject: string } {
  const subject = /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`;
  // Reply goes back to the sender for inbound, to the recipient for sent.
  const to = msg.kind === "inbound" ? msg.from : msg.to;
  const from = msg.kind === "inbound" ? (msg.to.split(",")[0]?.trim() ?? "") : msg.from;
  return { from, to, subject };
}

export interface ComposeInput { from: string; to: string; subject: string; body: string; providerId?: string }

/** Send a composed/replied message via the configured provider. Returns the sent id. */
export async function sendComposed(input: ComposeInput, db?: Database): Promise<{ id: string; messageId: string }> {
  const d = db || getDatabase();
  const providerId = input.providerId ?? activeProviderId(d);
  if (!providerId) throw new Error("No active provider. Add one with 'emails provider add'.");
  const to = input.to.split(",").map((s) => s.trim()).filter(Boolean);
  if (to.length === 0) throw new Error("At least one recipient is required.");
  if (!input.from) throw new Error("A From address is required.");
  const sendOpts = { provider_id: providerId, from: input.from, to, subject: input.subject, text: input.body };
  const { messageId, providerId: actual } = await sendWithFailover(providerId, sendOpts, d);
  const email = createEmail(actual, sendOpts, messageId, d);
  storeEmailContent(email.id, { text: input.body }, d);
  return { id: email.id, messageId };
}
