import type { Database } from "../db/database.js";
import { getDatabase } from "../db/database.js";
import type { Email, SendEmailOptions } from "../types/index.js";
import { createEmail } from "../db/emails.local.js";
import { setEmailThreading, type EmailThreading } from "../db/threads.local.js";

export async function createSentEmailLedger(
  providerId: string,
  opts: SendEmailOptions,
  providerMessageId?: string,
  db?: Database,
): Promise<Email> {
  return createEmail(providerId, opts, providerMessageId, db);
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
 * module is unreachable on an API-configured installation: every path into it is selected by
 * a dispatch helper ONE LEVEL UP (`sendComposed` in src/cli/tui/data.ts and
 * `processForwardingRules` in src/lib/forwarding.ts both route to their own remote arms), so
 * the only installation that executes this line is the one whose store IS this database. On
 * an API-configured installation the body is recorded by the service's own send route, which
 * persists it when it reserves the send intent.
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
