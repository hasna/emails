import type { Database } from "../db/database.js";
import { getDatabase, now, uuid } from "../db/database.js";
import type { Email, EmailRow, EmailStatus, SendEmailOptions } from "../types/index.js";
import { parseJsonArray, parseJsonObject } from "../db/json.js";
import { setEmailThreading, type EmailThreading } from "../db/threads.local.js";

/** An `emails` row, decoded. Byte-for-byte the deleted arm's mapping. */
function rowToEmail(row: EmailRow): Email {
  return {
    ...row,
    to_addresses: parseJsonArray<string>(row.to_addresses),
    cc_addresses: parseJsonArray<string>(row.cc_addresses),
    bcc_addresses: parseJsonArray<string>(row.bcc_addresses),
    tags: parseJsonObject<Record<string, string>>(row.tags),
    status: row.status as EmailStatus,
    has_attachments: !!row.has_attachments,
  };
}

/**
 * The ledger row a send-idempotency key already produced, or null.
 *
 * This is the read half of the idempotency fence, and it is exported so that
 * `sendWithFailover` can ask BEFORE the provider is invoked. The fence used to live
 * only inside `createSentEmailLedger` below — which runs AFTER the provider call, so a
 * repeated key deduplicated the ledger ROW while the recipient had already received a
 * second copy, and the second delivery's provider message id was recorded nowhere.
 */
export function findSentEmailByIdempotencyKey(key: string, db?: Database): Email | null {
  const d = db || getDatabase();
  const existing = d.query("SELECT * FROM emails WHERE idempotency_key = ?").get(key) as EmailRow | null;
  return existing ? rowToEmail(existing) : null;
}

/**
 * Record a sent message in the LOCAL sent ledger.
 *
 * ─── THIS SQL MOVED HERE, AND IT IS THE FIRST HALF OF THE WRITE BELOW ─────────────────
 *
 * It used to live in `src/db/emails.local.ts`, one of two arms of a family that branched on
 * the process-wide deployment word. That family is now ONE implementation over the store
 * seam, and the seam CANNOT PERFORM THIS WRITE — `src/db/emails.ts` carries the evidence in
 * full and its exported `createEmail` is now a named refusal. The four load-bearing facts:
 *
 *   1. `MessageInput` has no `provider_id`, no `bcc_addrs`, no `reply_to` and no `tags`,
 *      and the `emails` table has all four.
 *   2. `messages.createMessage` on the SQLite store inserts into `inbound_emails`, NOT into
 *      `emails` — and `email_content.email_id` and `events.email_id` both declare
 *      `REFERENCES emails(id)`, so a ledger row written through the seam could carry
 *      neither a body nor a delivery event.
 *   3. Both stores REFUSE an `idempotency_key` on `createMessage`, and the forwarding
 *      pipeline sets one on every copy.
 *   4. The deleted HTTP arm POSTed `direction: "outbound"` to a `/v1` route whose schema
 *      declares `direction: { enum: ["inbound"] }`, so it could not have worked against the
 *      real service at all.
 *
 * The comment under `storeSentEmailContent` below predicted this move before the collapse
 * happened, and its reasoning is the reason the two halves are together: they record one
 * message, they are reached on exactly the same paths, and splitting them would have put
 * one half on a seam that drops four of its columns while the other stayed here.
 *
 * IT CREATES NO SPLIT-BRAIN, for exactly the reasons the note below gives for its own
 * statement: this module is unreachable on an API-configured installation, both paths into
 * it stop there, and on such an installation the SERVICE records a sent message when its
 * send route reserves the send intent.
 *
 * @param db the ledger this write lands in. Real, and used — unlike the handle the deleted
 *   facade took, which selected an arm.
 */
export async function createSentEmailLedger(
  providerId: string,
  opts: SendEmailOptions,
  providerMessageId?: string,
  db?: Database,
): Promise<Email> {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();
  const toArr = Array.isArray(opts.to) ? opts.to : [opts.to];
  const ccArr = opts.cc ? (Array.isArray(opts.cc) ? opts.cc : [opts.cc]) : [];
  const bccArr = opts.bcc ? (Array.isArray(opts.bcc) ? opts.bcc : [opts.bcc]) : [];
  const attachCount = opts.attachments?.length ?? 0;

  // Idempotency: if a key was supplied and that send is already ledgered, return the
  // existing row. This is the SECOND line of the fence: `sendWithFailover` asks
  // `findSentEmailByIdempotencyKey` above before it invokes a provider, so a repeated
  // key never reaches a provider at all. This check stays because this function is
  // also called directly (batch, forwarding) and a row-level dedupe is still the right
  // answer for a caller that raced past the pre-send read.
  const idempotencyKey = (opts as unknown as Record<string, unknown>)["idempotency_key"] as string | undefined;
  if (idempotencyKey) {
    const existing = findSentEmailByIdempotencyKey(idempotencyKey, d);
    if (existing) return existing;
  }

  d.run(
    `INSERT INTO emails (id, provider_id, provider_message_id, from_address, to_addresses, cc_addresses, bcc_addresses, reply_to, subject, status, has_attachments, attachment_count, tags, idempotency_key, sent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      providerId,
      providerMessageId || null,
      opts.from,
      JSON.stringify(toArr),
      JSON.stringify(ccArr),
      JSON.stringify(bccArr),
      opts.reply_to || null,
      opts.subject,
      attachCount > 0 ? 1 : 0,
      attachCount,
      JSON.stringify(opts.tags || {}),
      idempotencyKey || null,
      timestamp,
      timestamp,
      timestamp,
    ],
  );

  const written = d.query("SELECT * FROM emails WHERE id = ?").get(id) as EmailRow | null;
  // The row is read back rather than assembled from the arguments, so a store that
  // persisted something else is not taken at this module's word — and the column defaults
  // (`created_at`, `updated_at`) come from whatever actually wrote them.
  if (!written) throw new Error(`sent ledger row ${id} disappeared immediately after insert`);
  return rowToEmail(written);
}

/**
 * Persist a sent message's rendered body and headers into the LOCAL ledger.
 *
 * ─── THIS SQL MOVED HERE, AND WHY IT IS NOT AN ARM ────────────────────────────────────
 *
 * It used to live in `src/db/email-content.local.ts`, one of two arms of a family that
 * branched on the process-wide deployment word. That family is now ONE implementation over
 * the store seam, and the seam has NO OPERATION THAT WRITES A BODY ONTO AN EXISTING MESSAGE
 * — not an unavailable capability, an absence, and the strongest arm has never had the
 * operation either. `src/db/email-content.ts` carries the evidence, and its exported
 * `storeEmailContent` is now a named refusal.
 *
 * THIS STATEMENT IS THE SECOND HALF OF ONE LOGICAL LEDGER WRITE, whose first half is the
 * unconditional `INSERT INTO emails` inside `createEmail` (src/db/emails.local.ts) that
 * `createSentEmailLedger` calls eleven lines above. Collapsing one half onto the seam while
 * the other stays raw SQLite in this same module would have been the LESS honest split: the
 * two statements record one message, they are reached on exactly the same paths, and they
 * die together when the `emails` family collapses onto the seam's messages repository.
 *
 * IT CREATES NO SPLIT-BRAIN, and that fact is load-bearing rather than convenient. This
 * module is unreachable on an API-configured installation, and BOTH paths into it stop there
 * — but they now stop for two DIFFERENT reasons, which is worth stating because one of them
 * used to be the same reason:
 *
 *   * `sendComposed` (src/cli/tui/data.ts) still routes to its own remote arm, so the
 *     deployment word keeps that path away from here. That guard dies with that family.
 *   * `processForwardingRules` (src/lib/forwarding.ts) has ONE implementation now and reads no
 *     deployment word. It REFUSES instead, from storage configuration
 *     (src/lib/storage-wiring.ts): an installation that reads its mail through an Emails API
 *     cannot reach this module, because the pipeline throws before its first read rather than
 *     reporting an empty run. The refusal was deliberately preserved for exactly this reason —
 *     a collapse that let the pipeline fall through to a default local handle would have made
 *     this module reachable on an API-configured installation and created the split-brain this
 *     paragraph denies.
 *
 * So the only installation that executes this line is still the one whose store IS this
 * database. On an API-configured installation the body is recorded by the service's own send
 * route, which persists it when it reserves the send intent.
 *
 * WHAT DELETES THIS. The `emails` family's collapse, which must pass the body to
 * `messages.createMessage` at ledger-creation time — `MessageInput` already carries
 * `body_text`, `body_html` and `headers`, so the two-step create-then-decorate shape is the
 * bug and one seam call is the fix. That collapse also needs the send-intent ledger, because
 * `createMessage` refuses an `idempotency_key` on both stores and the forwarding path sets
 * one. A body-patch operation on the seam is the FALLBACK, wanted only if the published SDK
 * export has to keep working; it is not the primary request.
 *
 * @param db the ledger this write lands in. Real, and used — unlike the handle the deleted
 *   facade took, which selected an arm.
 */
export async function storeSentEmailContent(
  emailId: string,
  content: { html?: string; text?: string; headers?: Record<string, string> },
  db?: Database,
): Promise<void> {
  const d = db || getDatabase();
  // Byte-for-byte the deleted arm's statement, including `INSERT OR REPLACE`: re-recording a
  // body replaces it rather than conflicting, which is what a resend of the same ledger row
  // has always done here and what one test in this repo pins.
  d.run(
    `INSERT OR REPLACE INTO email_content (email_id, html, text_body, headers_json)
     VALUES (?, ?, ?, ?)`,
    [
      emailId,
      content.html || null,
      content.text || null,
      JSON.stringify(content.headers || {}),
    ],
  );
}

export async function setSentEmailThreading(
  emailId: string,
  threading: Partial<EmailThreading>,
  db?: Database,
): Promise<void> {
  setEmailThreading(emailId, threading, db);
}
