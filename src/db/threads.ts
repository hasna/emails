/**
 * Threading DB layer — self-hosted-ONLY.
 *
 * The `/v1` message model has NO thread_id column: the operator's serve rolls
 * conversations by NORMALIZED SUBJECT. There is therefore no local threading
 * field to write, and no thread_id to look mail up by. Threading WRITES
 * (setEmailThreading / setInboundThreadId) become graceful no-ops; threading
 * READS map what /v1 does expose (message_id / in_reply_to / References header).
 */
import { parseReferences } from "../lib/threading.js";
import { selfHostedResource, cstr, cstrOrNull, cobj } from "./self-hosted-resource.js";

const MESSAGE_RESOURCE = "messages";

// Bounded scan for id/message-id resolution (no thread_id to key on).
const THREAD_SCAN_PAGE = 500;
const THREAD_SCAN_CAP = 10000;

function scanMessages(): Record<string, unknown>[] {
  const store = selfHostedResource(MESSAGE_RESOURCE);
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < THREAD_SCAN_CAP; offset += THREAD_SCAN_PAGE) {
    const page = store.list({ limit: THREAD_SCAN_PAGE, offset });
    rows.push(...page);
    if (page.length < THREAD_SCAN_PAGE) break;
  }
  return rows;
}

function bareId(value: string): string {
  return value.replace(/[<>]/g, "").trim();
}

function referencesOf(row: Record<string, unknown>): string[] {
  const headers = cobj(row["headers"]);
  return parseReferences(cstrOrNull(headers["References"]) ?? cstrOrNull(headers["references"]) ?? undefined);
}

export interface EmailThreading {
  message_id: string | null;
  thread_id: string | null;
  in_reply_to: string | null;
  references: string[];
}

/**
 * No-op: thread membership is derived by the self-hosted serve from the
 * normalized subject, so there is no local threading field to write.
 */
export function setEmailThreading(_emailId: string, _t: Partial<EmailThreading>): void {
  // Intentionally empty — server-derived threading (no /v1 thread_id column).
}

export function getEmailThreading(emailId: string): EmailThreading | null {
  const row = selfHostedResource(MESSAGE_RESOURCE).get(emailId);
  if (!row) return null;
  return {
    message_id: cstrOrNull(row["message_id"]),
    thread_id: null,
    in_reply_to: cstrOrNull(row["in_reply_to"]),
    references: referencesOf(row),
  };
}

/**
 * Find a message by its RFC Message-ID (with or without angle brackets). Also
 * matches the Message-ID's local-part against the stored provider_message_id
 * (SES rewrites Message-ID to `<{provider_message_id}@email.amazonses.com>`).
 * Scans the bounded recent window because /v1 has no message-id index endpoint.
 */
export function getEmailByMessageId(
  messageId: string,
): { id: string; thread_id: string | null; references: string[]; message_id: string | null } | null {
  const bare = bareId(messageId);
  const localPart = bare.split("@")[0] ?? bare;
  const match = scanMessages().find((row) => {
    const mid = bareId(cstr(row["message_id"]));
    const pmid = cstr(row["provider_message_id"]);
    return (mid && (mid === bare || mid === messageId.trim())) || (pmid && (pmid === bare || pmid === localPart));
  });
  if (!match) return null;
  return {
    id: cstr(match["id"]),
    thread_id: null,
    references: referencesOf(match),
    message_id: cstrOrNull(match["message_id"]),
  };
}

/**
 * No-op: there is no thread_id column over /v1 (thread membership is derived
 * server-side by normalized subject). Kept for call-site compatibility.
 */
export function setInboundThreadId(_inboundId: string, _threadId: string): void {
  // Intentionally empty — server-derived threading.
}

/**
 * A thread's messages, ordered by time. The /v1 model has no thread_id to key
 * on, so this cannot be resolved from an opaque local thread id; conversation
 * grouping is derived by subject elsewhere (see cli/tui/data getConversation).
 */
export function getThreadMessages(
  _threadId: string,
): Array<{ kind: "sent" | "received"; id: string; from: string; subject: string; at: string }> {
  return [];
}

/**
 * Resolve the thread/parent for an inbound email from its In-Reply-To /
 * References headers by matching a referenced Message-ID against a known
 * message. thread_id is always the freshly-generated id (no server thread_id is
 * exposed); parent linkage is best-effort over the bounded scan.
 */
export function resolveThreadForInbound(
  headers: Record<string, string> | undefined,
  newThreadId: string,
): { thread_id: string; parent_email_id: string | null } {
  const h = headers ?? {};
  const ownMsgId = h["Message-ID"] ?? h["message-id"] ?? h["Message-Id"] ?? "";
  const inReplyTo = h["In-Reply-To"] ?? h["in-reply-to"] ?? "";
  const refs = parseReferences(h["References"] ?? h["references"]);
  const candidates = [ownMsgId, inReplyTo, ...refs.reverse()].map((s) => s.trim()).filter(Boolean);
  for (const c of candidates) {
    const parent = getEmailByMessageId(c);
    if (parent) {
      return { thread_id: parent.thread_id ?? newThreadId, parent_email_id: parent.id };
    }
  }
  return { thread_id: newThreadId, parent_email_id: null };
}
