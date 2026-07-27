// Messages, attachment content, the inbox surface and the rollups, over `/v1`.
//
// FOUR THINGS IN THIS FILE ARE DECISIONS RATHER THAN TRANSCRIPTION, and each one is
// a place where a wrong answer was available:
//
// 1. `createMessage` REFUSES the four send-ledger fields. `POST /v1/messages` reads
//    neither `idempotency_key`, `send_payload_hash`, `send_state` nor
//    `send_started_at` (src/server/self-hosted/service.ts:1432-1451) — it drops them.
//    A caller who sets one and gets a 201 believes the fence was recorded when
//    nothing was, which is worse than being told no. The SQLite store refuses the
//    same four for the same reason (it has no columns for them); here the reason is
//    that the route has no fields for them.
//
// 2. `createMessage` REFUSES A `source_id` BEFORE SENDING ANYTHING. With one, the route
//    UPSERTS — and its upsert overwrites the whole column set, read and star flags and
//    labels included. An earlier version sent the request and returned a conflict on the
//    200 that means "matched an existing row", which was the worst answer available: the
//    collided row had already been clobbered by the time the refusal was built, and the
//    caller was told nothing had been written. The check therefore happens before the
//    request, not after it. `upsertMessage` is the operation that means this.
//
// 3. `upsertMessage` REFUSES a call with no `source_id`. Without one the route does a
//    plain create, so a caller asking for an idempotent write would get a duplicate
//    row per replay and a report that it was inserted. The fence is the operation.
//
// 4. `resolveMessageId` reads the whole message to learn its id, because there is no
//    resolve route. That is a real cost, recorded in the missing-route list, and it
//    is still the honest implementation: the alternative — matching prefixes against
//    a page of `GET /v1/messages` — would answer "not found" for any id past the
//    first page and "unique" for a prefix whose collisions are on the second.

import type {
  EmailContentRepository,
  InboundRepository,
  MessagesRepository,
  ThreadsRepository,
} from "../store/repositories.js";
import type { Outcome } from "../store/outcome.js";
import type {
  AttachmentInventoryItem,
  AttachmentMeta,
  ListAttachmentsOptions,
  ListMessagesOptions,
  ListOptions,
  MailboxRollup,
  MessageCountsRecord,
  MessageInput,
  MessageListRecord,
  MessageRaw,
  MessageRecord,
  MessageStatusPatch,
  Page,
  StoredAttachment,
  StoredAttachmentLookup,
  ThreadRollup,
} from "../store/records.js";
import {
  asArrayOf,
  asRecord,
  attachmentInventoryItem,
  attachmentMeta,
  envelope,
  mailboxRollup,
  messageCounts,
  messageListRecord,
  messageRecord,
  threadRollup,
} from "./mapping.js";
import { EmailsApiFault, apiErrorReason, apiErrorText, conflict, invalidInput, ok, refusalForStatus } from "./outcome.js";
import type { QueryValue, Transport } from "./wire.js";

/** The service's list ceiling, used when this store has to drain a list itself. */
const MAX_PAGE = 500;

/**
 * How many full sweeps of the scoped list `clearInboundEmails` will make.
 *
 * A ceiling rather than a `while (true)`: if the service kept answering with rows this
 * store could not delete, an unbounded loop would spin forever instead of reporting
 * that it could not finish.
 */
const MAX_CLEAR_SWEEPS = 200;

/** The batch ceiling `POST /v1/attachments/batch` enforces (`max_batch_size`). */
const MAX_BATCH = 200;

/**
 * Fields a caller may set that `POST /v1/messages` does not read. Named here so the
 * refusal can say which one, rather than refusing the whole write anonymously.
 */
const DROPPED_ON_THE_WIRE = [
  "idempotency_key",
  "send_payload_hash",
  "send_state",
  "send_started_at",
] as const;

function messageBody(input: MessageInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from_addr: input.from_addr,
    to_addrs: input.to_addrs,
  };
  const optional: Array<[string, unknown]> = [
    ["cc_addrs", input.cc_addrs],
    ["subject", input.subject],
    ["body_text", input.body_text],
    ["body_html", input.body_html],
    ["status", input.status],
    ["provider_message_id", input.provider_message_id],
    ["direction", input.direction],
    ["message_id", input.message_id],
    ["in_reply_to", input.in_reply_to],
    ["received_at", input.received_at],
    ["is_read", input.is_read],
    ["is_starred", input.is_starred],
    ["labels", input.labels],
    ["headers", input.headers],
    ["attachments", input.attachments],
    ["source_id", input.source_id],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) body[key] = value;
  }
  return body;
}

/**
 * The ledger fields this route silently drops, if the caller set any.
 *
 * A field explicitly set to `null` or to the "no ledger" sentinel is NOT a write —
 * there is nothing to lose — so it passes. Anything else would be dropped.
 */
function droppedLedgerField(input: MessageInput): string | null {
  const fields = input as unknown as Record<string, unknown>;
  for (const field of DROPPED_ON_THE_WIRE) {
    const value = fields[field];
    if (value === undefined || value === null) continue;
    if (field === "send_state" && value === "none") continue;
    return field;
  }
  return null;
}

function messagesQuery(opts: ListMessagesOptions | undefined): Record<string, QueryValue> {
  return {
    limit: opts?.limit,
    // `cursor` wins over `offset` at the service too, but sending both would let a
    // reader of this code believe otherwise.
    ...(opts?.cursor === undefined ? { offset: opts?.offset } : {}),
    cursor: opts?.cursor,
    direction: opts?.direction,
    to: opts?.to,
    from: opts?.from,
    subject: opts?.subject,
    search: opts?.search,
    since: opts?.since,
    folder: opts?.folder,
    // Repeated, not comma-joined: the service reads `domain` repeatably.
    domain: opts?.domains,
  };
}

async function readMessagePage(
  transport: Transport,
  query: Record<string, QueryValue>,
  what: string,
): Promise<Outcome<Page<MessageListRecord>>> {
  const answer = await transport.request("GET", "/messages", { query });
  if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, what);
  const body = asRecord(answer.body, what);
  const rows = asArrayOf(envelope(body, "messages", what), what);
  const cursor = body["next_cursor"];
  if (cursor !== null && typeof cursor !== "string") {
    return refusalForStatus(answer.status, answer.body, `${what}: next_cursor is neither a string nor null`);
  }
  return ok({ items: rows.map((row) => messageListRecord(row, what)), next_cursor: cursor });
}

export function createMessagesRepository(transport: Transport): MessagesRepository {
  return {
    async listMessages(opts?: ListMessagesOptions): Promise<Outcome<Page<MessageListRecord>>> {
      return readMessagePage(transport, messagesQuery(opts), "listMessages");
    },

    async getMessage(id: string): Promise<Outcome<MessageRecord | null>> {
      const answer = await transport.request("GET", `/messages/${encodeURIComponent(id)}`);
      if (answer.status === 404) return ok(null);
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "getMessage");
      return ok(messageRecord(envelope(answer.body, "message", "getMessage"), "getMessage"));
    },

    /**
     * NO ROUTE: the service resolves an abbreviated id INSIDE each by-id route rather
     * than exposing the resolution. So this reads the message and reports its id — one
     * request, and the two refusals the seam requires come straight from the service's
     * own 404 and its 409 `reason: "ambiguous_id"`.
     */
    async resolveMessageId(idOrPrefix: string): Promise<Outcome<{ id: string }>> {
      const answer = await transport.request("GET", `/messages/${encodeURIComponent(idOrPrefix)}`);
      if (answer.status !== 200) {
        // Absence is a REFUSAL here, not a value: the seam declares `Outcome<{ id }>`,
        // because "no such message" and "your prefix matched several" carry different
        // statuses and every caller has to tell them apart.
        return refusalForStatus(answer.status, answer.body, "resolveMessageId");
      }
      const record = messageRecord(envelope(answer.body, "message", "resolveMessageId"), "resolveMessageId");
      return ok({ id: record.id });
    },

    async createMessage(input: MessageInput): Promise<Outcome<MessageRecord>> {
      const dropped = droppedLedgerField(input);
      if (dropped !== null) {
        return invalidInput(
          `createMessage: POST /v1/messages does not carry ${dropped}, so the field would be ` +
            "accepted and dropped; reserve a send intent instead of recording one here",
        );
      }
      // REFUSED BEFORE THE REQUEST IS SENT, and the ordering is the entire point.
      //
      // `POST /v1/messages` UPSERTS whenever a `source_id` is present, and its upsert
      // overwrites the whole column set — `is_read`, `is_starred`, `labels`,
      // `received_at`, subject, bodies, headers, attachments
      // (src/server/self-hosted/store.ts, MESSAGE_UPSERT_ASSIGNMENTS). An earlier version
      // of this method sent the request first and returned a conflict on the 200 that
      // means "matched an existing row". That was the worst answer available: by the time
      // the refusal was built the collided row had ALREADY been clobbered with this
      // caller's payload, and the caller was told nothing had been written. Adversarial
      // review caught it, and it is verbatim the defect class found in the SQLite store's
      // upsert — a replay resetting read/star/label state — with a denial on top.
      //
      // A pre-flight existence check would not fix it either: the row can appear between
      // the check and the write, and the write is destructive. So `createMessage` declines
      // the fenced input outright. `upsertMessage` is the operation that means this, and
      // it reports `inserted` honestly.
      if (input.source_id !== undefined && input.source_id !== null && input.source_id !== "") {
        return conflict(
          "createMessage: a source_id makes POST /v1/messages an upsert that overwrites every " +
            "column of any row it matches, including read, star and label state; call " +
            "upsertMessage, which reports whether it inserted",
        );
      }
      const answer = await transport.request("POST", "/messages", { body: messageBody(input) });
      if (answer.status !== 201) return refusalForStatus(answer.status, answer.body, "createMessage");
      return ok(messageRecord(envelope(answer.body, "message", "createMessage"), "createMessage"));
    },

    async upsertMessage(input: MessageInput): Promise<Outcome<{ record: MessageRecord; inserted: boolean }>> {
      if (input.source_id === undefined || input.source_id === null || input.source_id === "") {
        return invalidInput(
          "upsertMessage: a source_id is the idempotency fence for this write, and without one " +
            "the API performs a plain create — every replay would insert another row",
        );
      }
      const dropped = droppedLedgerField(input);
      if (dropped !== null) {
        return invalidInput(
          `upsertMessage: POST /v1/messages does not carry ${dropped}, so the field would be ` +
            "accepted and dropped",
        );
      }
      const answer = await transport.request("POST", "/messages", { body: messageBody(input) });
      // 201 inserted, 200 matched an existing source_id. The distinction IS the
      // operation's second return value, and it is the service's answer rather than a
      // guess made by comparing timestamps.
      if (answer.status !== 201 && answer.status !== 200) {
        return refusalForStatus(answer.status, answer.body, "upsertMessage");
      }
      return ok({
        record: messageRecord(envelope(answer.body, "message", "upsertMessage"), "upsertMessage"),
        inserted: answer.status === 201,
      });
    },

    async updateMessageStatus(id: string, patch: MessageStatusPatch): Promise<Outcome<MessageRecord | null>> {
      const body: Record<string, unknown> = {};
      const fields: Array<[string, unknown]> = [
        ["status", patch.status],
        ["provider_message_id", patch.provider_message_id],
        ["is_read", patch.is_read],
        ["is_starred", patch.is_starred],
        ["archived", patch.archived],
        ["add_label", patch.add_label],
        ["remove_label", patch.remove_label],
      ];
      for (const [key, value] of fields) {
        if (value !== undefined) body[key] = value;
      }
      const answer = await transport.request("PATCH", `/messages/${encodeURIComponent(id)}`, { body });
      if (answer.status === 404) return ok(null);
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "updateMessageStatus");
      return ok(
        messageRecord(envelope(answer.body, "message", "updateMessageStatus"), "updateMessageStatus"),
      );
    },

    async deleteMessage(id: string): Promise<Outcome<boolean>> {
      const answer = await transport.request("DELETE", `/messages/${encodeURIComponent(id)}`);
      if (answer.status === 404) return ok(false);
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "deleteMessage");
      return ok(true);
    },

    async messageCounts(opts?: { domains?: string[] }): Promise<Outcome<MessageCountsRecord>> {
      const answer = await transport.request("GET", "/messages/counts", {
        query: { domain: opts?.domains },
      });
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "messageCounts");
      return ok(messageCounts(envelope(answer.body, "counts", "messageCounts"), "messageCounts"));
    },

    async getMessageRaw(id: string): Promise<Outcome<MessageRaw | null>> {
      const answer = await transport.request("GET", `/messages/${encodeURIComponent(id)}/raw`);
      if (answer.status === 404) return ok(null);
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "getMessageRaw");
      // This route answers UNWRAPPED: `{ raw, message_id }`, not `{ raw: { … } }`.
      const body = asRecord(answer.body, "getMessageRaw");
      const raw = body["raw"];
      if (typeof raw !== "string") {
        return refusalForStatus(200, answer.body, "getMessageRaw: the response carries no raw text");
      }
      const messageId = body["message_id"];
      return ok({ raw, message_id: typeof messageId === "string" ? messageId : null });
    },
  };
}

/** The available/unavailable/invalid answer, built from the service's status and code. */
function attachmentLookup(status: number, body: unknown): Outcome<StoredAttachmentLookup | null> {
  const code = apiErrorReason(body);
  if (status === 200) {
    const attachment = asRecord(envelope(body, "attachment", "getMessageAttachment"), "attachment");
    const filename = attachment["filename"];
    const contentType = attachment["content_type"];
    const size = attachment["size"];
    const contentBase64 = attachment["content_base64"];
    if (
      typeof filename !== "string" ||
      typeof contentType !== "string" ||
      // `Number.isFinite`, matching mapping.ts: without it a NaN size passes as a number.
      typeof size !== "number" ||
      !Number.isFinite(size) ||
      typeof contentBase64 !== "string"
    ) {
      return refusalForStatus(200, body, "getMessageAttachment: the payload is not a stored attachment");
    }
    const stored: StoredAttachment = {
      filename,
      content_type: contentType,
      size,
      content_base64: contentBase64,
    };
    return ok({ state: "available", attachment: stored });
  }
  if (status === 409 && code === "attachment_content_unavailable") {
    // The three-state answer's middle state: metadata exists, the bytes do not.
    // Collapsing this into null is the exact lie records.ts describes.
    //
    // The metadata is REQUIRED here and is not defaulted. An earlier version filled a
    // missing filename with `""` and a missing content type with `""`, which is the
    // mapper rule broken in the one branch where it matters most: this state exists to
    // tell a reader WHAT it cannot download, and an empty filename presented as the
    // answer is a fabricated one. If the service says the content is unavailable but
    // sends no metadata to describe it, that is a fault in the response, not a lookup
    // result — so it throws, exactly as mapping.ts does everywhere else.
    const attachment = asRecord(envelope(body, "attachment", "getMessageAttachment"), "attachment");
    const filename = attachment["filename"];
    const contentType = attachment["content_type"];
    const size = attachment["size"];
    if (typeof filename !== "string" || typeof contentType !== "string") {
      throw new EmailsApiFault(
        status,
        "getMessageAttachment: the API reported unavailable attachment content without the " +
          "filename and content type that state exists to carry",
      );
    }
    if (size !== null && size !== undefined && typeof size !== "number") {
      throw new EmailsApiFault(status, "getMessageAttachment: unavailable attachment content carries a non-numeric size");
    }
    return ok({
      state: "content_unavailable",
      // `size` is legitimately nullable on this arm — the seam declares `number | null`
      // — so an ABSENT size is the documented null, not an invented one.
      attachment: { filename, content_type: contentType, size: size ?? null },
    });
  }
  if (status === 422 && code === "invalid_attachment_payload") {
    // The SERVICE's reason, not a constant. `{ state: "invalid" }` exists to carry WHY the
    // payload could not be produced, and the service sends the stored attachment's own
    // reason in that body; replacing it with a fixed sentence was the one place this file
    // substituted an invented value for real diagnostic text. Adversarial review caught it.
    return ok({ state: "invalid", reason: apiErrorText(status, body) });
  }
  // `message_not_found` and `attachment_not_found`: absence is a VALUE, because the
  // seam declares `StoredAttachmentLookup | null`.
  if (status === 404) return ok(null);
  return refusalForStatus(status, body, "getMessageAttachment");
}

export function createEmailContentRepository(transport: Transport): EmailContentRepository {
  return {
    async getMessageAttachment(id: string, index: number): Promise<Outcome<StoredAttachmentLookup | null>> {
      if (!Number.isInteger(index) || index < 0) {
        return invalidInput(`getMessageAttachment: ${index} is not an attachment index`);
      }
      const answer = await transport.request(
        "GET",
        `/messages/${encodeURIComponent(id)}/attachments/${index}`,
      );
      return attachmentLookup(answer.status, answer.body);
    },

    async listAttachments(opts?: ListAttachmentsOptions): Promise<Outcome<Page<AttachmentInventoryItem>>> {
      const answer = await transport.request("GET", "/attachments", {
        query: {
          limit: opts?.limit,
          cursor: opts?.cursor,
          direction: opts?.direction,
          since: opts?.since,
        },
      });
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "listAttachments");
      const body = asRecord(answer.body, "listAttachments");
      const rows = asArrayOf(envelope(body, "items", "listAttachments"), "listAttachments");
      const cursor = body["next_cursor"];
      if (cursor !== null && typeof cursor !== "string") {
        return refusalForStatus(200, answer.body, "listAttachments: next_cursor is neither a string nor null");
      }
      return ok({
        items: rows.map((row) => attachmentInventoryItem(row, "listAttachments")),
        next_cursor: cursor,
      });
    },

    async listAttachmentsForMessageIds(ids: string[]): Promise<Outcome<Record<string, AttachmentMeta[]>>> {
      // Asking about no messages is answered by the empty map. That is the true answer
      // to the question asked, not a stand-in for one — and the route refuses an empty
      // `message_ids` outright, so there is nothing to ask.
      if (ids.length === 0) return ok({});
      const collected: Record<string, AttachmentMeta[]> = {};
      // The route caps a batch at `max_batch_size` (200). Chunking is the honest
      // response to that cap; truncating the id list would answer a different question.
      for (let start = 0; start < ids.length; start += MAX_BATCH) {
        const chunk = ids.slice(start, start + MAX_BATCH);
        const answer = await transport.request("POST", "/attachments/batch", {
          body: { message_ids: chunk },
        });
        if (answer.status !== 200) {
          return refusalForStatus(answer.status, answer.body, "listAttachmentsForMessageIds");
        }
        const byId = asRecord(
          envelope(answer.body, "by_message_id", "listAttachmentsForMessageIds"),
          "listAttachmentsForMessageIds",
        );
        for (const [messageId, rows] of Object.entries(byId)) {
          collected[messageId] = asArrayOf(rows, "listAttachmentsForMessageIds").map((row) =>
            attachmentMeta(row, "listAttachmentsForMessageIds"),
          );
        }
      }
      return ok(collected);
    },
  };
}

/** Patch a message and report the row, or null when there is no such message. */
async function patchMessage(
  transport: Transport,
  id: string,
  body: Record<string, unknown>,
  what: string,
): Promise<Outcome<MessageRecord | null>> {
  const answer = await transport.request("PATCH", `/messages/${encodeURIComponent(id)}`, { body });
  if (answer.status === 404) return ok(null);
  if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, what);
  return ok(messageRecord(envelope(answer.body, "message", what), what));
}

export function createInboundRepository(transport: Transport): InboundRepository {
  return {
    /**
     * The inbox is a FOLDER-SCOPED message read; there is no `/v1/inbound`. The folder
     * defaults to `inbox` rather than being left unset, because an unset folder returns
     * archived, spam and trash too — a mailbox listing that shows deleted mail.
     */
    async listInbound(opts?: ListMessagesOptions): Promise<Outcome<Page<MessageListRecord>>> {
      const query = messagesQuery(opts);
      query["folder"] = opts?.folder ?? "inbox";
      return readMessagePage(transport, query, "listInbound");
    },

    async getUnreadCount(): Promise<Outcome<number>> {
      const answer = await transport.request("GET", "/messages/counts");
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "getUnreadCount");
      return ok(messageCounts(envelope(answer.body, "counts", "getUnreadCount"), "getUnreadCount").unread);
    },

    async setInboundRead(id: string, read: boolean): Promise<Outcome<MessageRecord | null>> {
      return patchMessage(transport, id, { is_read: read }, "setInboundRead");
    },

    async setInboundStarred(id: string, starred: boolean): Promise<Outcome<MessageRecord | null>> {
      return patchMessage(transport, id, { is_starred: starred }, "setInboundStarred");
    },

    async setInboundArchived(id: string, archived: boolean): Promise<Outcome<MessageRecord | null>> {
      return patchMessage(transport, id, { archived }, "setInboundArchived");
    },

    async addInboundLabel(id: string, label: string): Promise<Outcome<MessageRecord | null>> {
      return patchMessage(transport, id, { add_label: label }, "addInboundLabel");
    },

    async removeInboundLabel(id: string, label: string): Promise<Outcome<MessageRecord | null>> {
      return patchMessage(transport, id, { remove_label: label }, "removeInboundLabel");
    },

    /**
     * NO ROUTE: there is no bulk delete on `/v1`, so this drains the scoped list and
     * deletes each row, reporting how many rows it actually removed.
     *
     * The count is the number of DELETEs the service confirmed — not the number of rows
     * the listing offered. A row another writer removed between the scan and the delete
     * answers 404 and is not counted, because reporting it would overstate the work
     * done, and a caller checking "did my clear take effect" would be told yes.
     *
     * The scan re-reads the FIRST page every time rather than following a cursor: rows
     * are leaving the list as it runs, so a cursor taken before the deletes would point
     * into a range that no longer exists. Bounded by the row count, not by trust.
     */
    async clearInboundEmails(opts?: { domains?: string[] }): Promise<Outcome<number>> {
      let removed = 0;
      for (let sweep = 0; sweep < MAX_CLEAR_SWEEPS; sweep += 1) {
        const page = await readMessagePage(
          transport,
          messagesQuery({ direction: "inbound", domains: opts?.domains, limit: MAX_PAGE }),
          "clearInboundEmails",
        );
        if (!page.ok) return page;
        if (page.value.items.length === 0) return ok(removed);
        for (const item of page.value.items) {
          const answer = await transport.request("DELETE", `/messages/${encodeURIComponent(item.id)}`);
          if (answer.status === 200) {
            removed += 1;
            continue;
          }
          // Already gone: not this call's removal, so not counted.
          if (answer.status === 404) continue;
          return refusalForStatus(answer.status, answer.body, "clearInboundEmails");
        }
      }
      // `conflict`, not `invalid_input`: nothing about the caller's arguments is wrong.
      // The list kept refilling faster than it drained, which is a concurrency condition,
      // and telling a caller to fix its input would point at the wrong remedy.
      return conflict(
        `clearInboundEmails: the scoped inbound list did not drain in ${MAX_CLEAR_SWEEPS} sweeps, ` +
          "so another writer is adding rows as fast as this is removing them; refusing rather " +
          "than reporting a partial count as the whole",
      );
    },
  };
}

export function createThreadsRepository(transport: Transport): ThreadsRepository {
  return {
    async listThreads(opts?: ListOptions): Promise<Outcome<ThreadRollup[]>> {
      const answer = await transport.request("GET", "/messages/threads", {
        query: { limit: opts?.limit, offset: opts?.offset },
      });
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "listThreads");
      const rows = asArrayOf(envelope(answer.body, "threads", "listThreads"), "listThreads");
      return ok(rows.map((row) => threadRollup(row, "listThreads")));
    },

    async listMailboxes(): Promise<
      Outcome<{ mailboxes: MailboxRollup[]; counts: MessageCountsRecord }>
    > {
      const answer = await transport.request("GET", "/mailboxes");
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "listMailboxes");
      const body = asRecord(answer.body, "listMailboxes");
      const rows = asArrayOf(envelope(body, "mailboxes", "listMailboxes"), "listMailboxes");
      return ok({
        mailboxes: rows.map((row) => mailboxRollup(row, "listMailboxes")),
        counts: messageCounts(envelope(body, "counts", "listMailboxes"), "listMailboxes"),
      });
    },
  };
}
