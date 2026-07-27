// ONE email-content reader. There is no arm to pick, and nothing here asks where this
// installation keeps its mail.
//
// WHAT THIS FILE USED TO BE. `email-content.ts` was a 24-line facade that built a dispatch
// helper, read the process-wide deployment word, and handed each of two exports to one of
// two sibling modules:
//
//   * `email-content.local.ts` (68 lines) — `INSERT OR REPLACE INTO email_content` for the
//     write, and a read that FIRST consulted the operator dataset through a sibling
//     family's routing helper and fell back to `SELECT * FROM email_content`;
//   * `email-content.remote.ts` (42 lines) — both operations against the operator's
//     `/v1/messages/<id>` record, the write as a `PATCH` of `body_html` / `body_text` /
//     `headers`.
//
// Both arms are gone. The data comes through the store seam (`src/store/`), the injectable
// is a store and not a database handle, and the one thing this family can no longer do is
// named in a thrown refusal rather than approximated by a comfortable default.
//
// ─── THE ONE THING A READER MUST KNOW ABOUT THIS FAMILY ──────────────────────────────
//
// THE DELETED `PATCH` WRITE WAS A SILENT NO-OP THAT REPORTED SUCCESS, and on an
// API-configured installation it was THE ONLY REACHABLE WRITE. The operator's by-id handler
// (src/server/self-hosted/service.ts, the `PATCH`/`PUT` arm of the `/v1/messages/<id>`
// route) builds its patch from EXACTLY SEVEN keys — status, provider_message_id, is_read,
// is_starred, archived, add_label, remove_label — and then answers 200 with the message.
// `body_html`, `body_text` and `headers` are not among them and are not rejected either:
// unlike the attachment-repair routes, that handler runs no unknown-field check, and the
// published contract declares the seven properties without closing the object. So the fields
// are DROPPED, and `storeEmailContent` told its caller the write was done.
//
// It passed its suite because the suite pointed at `src/test-support/v1-stub.ts`, whose patch
// handler is a blind merge: it persists any key it is handed and echoes it straight back.
// The fixture whose route contract is pinned to the service's own OpenAPI document
// (`src/test-support/v1-store-api.ts`) drops the same three fields, because that is what the
// service does. That is the whole reason the suite beside this file is parameterised over
// two REAL stores instead of a dictionary.
//
// ─── WHY THE WRITE IS NOW A REFUSAL, AND WHY THAT IS NOT A CAPABILITY GATE ────────────
//
// The seam has NO OPERATION THAT SETS A BODY OR A HEADER SET ON AN EXISTING MESSAGE. This
// is an ABSENCE, not a false capability, and the distinction matters because a gated
// operation at least refuses loudly while an absent one invites exactly the silent success
// described above. The evidence, so a reviewer can check it rather than trust it:
//
//   1. `src/store/repositories.ts` contains no occurrence of `body_text`, `body_html` or
//      `headers` in any signature.
//   2. The message status patch type (src/store/records.ts) carries status,
//      provider_message_id, is_read, is_starred, archived, add_label and remove_label —
//      and nothing else.
//   3. `createMessage` and `upsertMessage` DO carry a body, on `MessageInput`, but they
//      MINT A ROW: both require `from_addr` and `to_addrs`, which this family's signature
//      does not have, and the upsert fences on `source_id`, which the SQLite store hard-
//      codes to NULL for legacy ledger rows (src/store-sqlite/messages-sql.ts). Neither can
//      decorate a row that already exists.
//   4. `EmailContentRepository` — the repository the seam guard maps this very family onto
//      — holds only ATTACHMENT operations, and no writes at all. Bodies live on the messages
//      repository.
//   5. THE STRONGEST ARM HAS NEVER HAD THE OPERATION EITHER. The service's own tenant-scoped
//      store takes the same seven-field patch and its `UPDATE messages SET …` touches only
//      status, provider_message_id, is_read, is_starred, labels and updated_at. So this is
//      not a seam that was declared too narrowly — it is a product that has never been able
//      to set a body on a row that already exists.
//   6. THERE IS NO CAPABILITY TO GATE A NEW OPERATION ON. None of the seven capability keys
//      covers it, so an operation added today would land ungated — which is the same hole
//      the record route had to be introduced to close.
//
// Branching on which store is held would be the only other way out, and it is forbidden
// (src/store/descriptor.ts). So the write refuses, by name, and the refusal is a THROWN,
// TYPED error rather than a returned flag: a returned flag is ignorable, and the last
// version of this operation was ignored for as long as it existed.
//
// WHAT STILL RECORDS A BODY, so this refusal is not read as a lost feature. On an
// API-configured installation the SERVICE records it, at send time, when its send route
// reserves the send intent — this family's write was never needed there and never worked
// there. On a local installation `src/lib/sent-ledger.local.ts` records it, in the same
// module and on the same paths as the `INSERT INTO emails` it accompanies; that statement
// moved there out of the deleted arm, and the comment above it explains why keeping the two
// halves of one ledger write together is the honest split. What refuses is THIS family's
// exported write — the published SDK surface and the path an API-configured installation
// would reach — because that is the path that has been reporting a discarded write as done.
//
// WHAT SHOULD HAPPEN INSTEAD, reported and deliberately not done here, and it is NOT a
// body-patch operation. The two-step "create the ledger row, then decorate it with a body" is
// itself the bug: `MessageInput` already carries `body_text`, `body_html` and `headers`, so
// ledger creation and body recording are ONE `createMessage` call. That collapse belongs to
// the `emails.*` family, and it additionally needs the send-intent ledger, because
// `createMessage` refuses an `idempotency_key` on both stores and the forwarding path sets
// one. A seam body-patch plus a widened service route is the FALLBACK, wanted only if the
// published `storeEmailContent` export must keep working for external callers — and it would
// have to come with the unknown-field rejection that route is missing, so that the current
// silent drop stops being contractually permitted.
//
// ─── WHAT THIS FILE CAN NO LONGER DETERMINE, STATED RATHER THAN DERIVED ──────────────
//
//  1. Whether a body was recorded. See above: it cannot record one, and it says so.
//  1a. Which of the two readable tables a row came from. The seam's single-message read scans
//     the whole unified stream, so an id that belongs to the inbound table is now ANSWERED
//     where the deleted local arm returned null for it (its `SELECT` named `email_content`
//     alone). That is a widening rather than a change of meaning — the question was always
//     "give me this message's body" — and it is asserted.
//  2. Whether a message HAS content, as distinct from EXISTING. The deleted local arm
//     returned null when the `email_content` ROW was missing even though the message was
//     right there, and the deleted remote arm returned null only when the MESSAGE was
//     missing — so one configuration answered 404 for a real message with an empty body
//     and the other answered it with nulls. The stronger arm's meaning is kept: NULL MEANS
//     NO SUCH MESSAGE. A message that exists and carries no body is a record whose `html`
//     and `text_body` are null, which is the honest spelling of "there is nothing here"
//     and is distinguishable from "there is no such thing".
//  2a. WHICH message a prefix meant, when it matched several. The two stores disagreed about
//     prefixes entirely (see `readMessage`); resolved toward the stronger arm, and an
//     ambiguous prefix now RAISES rather than answering null or picking the first match.
//  3. Header VALUE types. `MessageRecord.headers` is `Record<string, unknown>` and this
//     family used to declare `Record<string, string>` while casting rather than converting
//     — so a numeric header value flowed through both arms under a type that said it could
//     not. The declaration is widened to match the seam. Narrowing would have meant
//     dropping entries (a silent loss) or stringifying them (a fabrication: a nested object
//     becomes the text `[object Object]`).
//
// ─── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────────────
//
//  1. It never asks WHICH store it holds, and it never reads a deployment word.
//  2. IT NEVER PUTS CONTENT IN A MESSAGE. Not in the refusal, not in an error, not in a
//     diagnostic. A body, a header set and an attachment payload are the most sensitive
//     values this package handles, and an error string is the single most likely place for
//     one to be logged, shipped to a crash reporter, or pasted into an issue. Every message
//     constructed below names an OPERATION and, at most, a message id.
//  3. It does not return an empty record, an empty string or an empty header map in place
//     of a read it could not perform. A store that refuses raises; only a store that
//     answered "no such message" produces null.
//  4. It does not touch the deployment-mode axis module, the dispatch layer, the curl
//     bridge, or any mode-gated branch in another family. Those are phase 9's, and only
//     once the ratchet in src/mode-axis-ratchet.test.ts reads zero.

import { createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Refusal } from "../store/outcome.js";
import type { MessageRecord } from "../store/records.js";

/**
 * A sent or received message's body and header set.
 *
 * `headers` is `Record<string, unknown>` and that is a widening — see note 3 in the header.
 * Both deleted arms declared `Record<string, string>` and neither converted anything, so
 * the values were already whatever the store held.
 */
export interface EmailContent {
  email_id: string;
  html: string | null;
  text_body: string | null;
  headers: Record<string, unknown>;
}

/** What a caller may ask this family to record. Unchanged from both deleted arms. */
export interface EmailContentInput {
  html?: string;
  text?: string;
  headers?: Record<string, string>;
}

/**
 * The refusal for a write this installation cannot perform.
 *
 * A named class, not a bare `Error`, so the ledger writer can catch THIS and nothing else.
 * Catching by message text would swallow a genuine store fault as though it were the
 * expected refusal, which is how a real failure becomes a shrug.
 */
export class EmailContentWriteUnsupportedError extends Error {
  override readonly name = "EmailContentWriteUnsupportedError";
  /** The message this write was asked to decorate. Carried for the caller, never content. */
  readonly emailId: string;

  constructor(emailId: string) {
    // A FIXED SENTENCE, with no interpolation of anything the caller passed. This text can
    // reach a CLI stream, an HTTP error body and — through the forwarding family — a database
    // column, so it is built from a constant and a message id and nothing else. It names no
    // environment variable and no configuration change: a refusal that tells the reader how
    // to switch it off is a refusal documenting its own bypass.
    super(
      "Recording a message body is not an operation any store behind this package has. The store " +
        "seam has no write that sets a body or a header set on an existing message, and the " +
        "operator API's by-id message patch silently discards those fields rather than rejecting " +
        "them. A body is recorded when the message is created, by the send path.",
    );
    this.emailId = emailId;
  }
}

/**
 * The refusal, thrown.
 *
 * Names the OPERATION and carries the store's own code, status and text. It names no
 * setting and no command — a refusal that tells the caller which variable to set is a
 * refusal documenting its own bypass — and it carries no content.
 */
function storeRefusal(what: string, refusal: Refusal): Error {
  return new Error(
    `This installation's store cannot ${what} (${refusal.code}, ${refusal.status}): ${refusal.message}`,
  );
}

/**
 * The store this call runs against.
 *
 * Built per call, so a configuration error belongs to the call that needed a store rather
 * than to whoever imported this module first.
 */
function storeFor(store: EmailStore | undefined): EmailStore {
  return store ?? createConfiguredEmailStore();
}

/**
 * Record a message's rendered body and headers.
 *
 * ALWAYS REFUSES, and the return type says so. `never` rather than `Promise<void>` is
 * deliberate twice over: it makes every caller's dead tail visible to `tsc`, and it throws
 * SYNCHRONOUSLY, so a caller that forgot to await gets a thrown error rather than an
 * unhandled rejection the event loop swallows. The previous version of this operation was
 * ignorable and was ignored for as long as it existed.
 *
 * The signature keeps both of the deleted arms' parameters so the exported surface is
 * unchanged; neither value is read, and `content` in particular is never named in the
 * error — see note 2 in the header.
 */
export function storeEmailContent(
  emailId: string,
  _content: EmailContentInput,
  _store?: EmailStore,
): never {
  throw new EmailContentWriteUnsupportedError(emailId);
}

/**
 * A message's body and headers, or null when there is no such message.
 *
 * ONE SEAM READ, and it is UNGATED on both stores — which is worth stating because the
 * neighbouring content operations are not: attachment payloads sit behind
 * `attachmentContent` and reconstructed MIME behind `rawMessage`, and the SQLite store
 * declares both false. Bodies and headers are on the message record itself, so this
 * operation is answerable everywhere, and a pass-through here is not the 100%-refusing
 * implementation it would have been for either of those two.
 *
 * WHERE THE ROWS COME FROM, so the migration case is checkable: the SQLite store's message
 * stream unions the legacy ledger — `emails LEFT JOIN email_content`, mapping `ec.html` and
 * `ec.text_body` onto the record's `body_html` and `body_text`
 * (src/store-sqlite/messages-sql.ts) — with the unified table. So content the deleted local
 * arm wrote is still read, by the same join, through the seam.
 *
 * A REFUSAL RAISES. `null` is reserved for "no such message" and must never also mean "the
 * store would not answer": the one consumer that turns this value into an HTTP status
 * answers 404 on null, and a store that refused is not a 404.
 *
 * @param store injected only by tests. There is exactly one production path, and it is
 *   `createConfiguredEmailStore()`.
 */
export async function getEmailContent(
  emailId: string,
  store?: EmailStore,
): Promise<EmailContent | null> {
  const resolved = storeFor(store);
  const record = await readMessage(resolved, emailId);
  if (record === null) return null;
  return {
    // The STORE'S id, and never the argument. Both deleted arms echoed the caller's string
    // straight back, so an abbreviated id came out of `email_id` as though it were the id.
    email_id: record.id,
    html: record.body_html,
    text_body: record.body_text,
    headers: record.headers,
  };
}

/**
 * One message, by a full id or by a unique prefix, with an ARM DIVERGENCE RESOLVED RATHER
 * THAN INHERITED.
 *
 * THE TWO STORES DISAGREE ABOUT PREFIXES, and this is a finding rather than a preference.
 * The SQLite store's single-message read matches `m.id = ?` exactly
 * (src/store-sqlite/messages.ts), while the HTTP store's read goes to the service's by-id
 * route, which resolves an abbreviation INSIDE the route. The deleted arms inherited exactly
 * that split — the local arm's `SELECT … WHERE email_id = ?` took no prefix and the remote
 * arm's record read took one — so `emails show <shortid>` found a body on one configuration
 * and not on the other. It is resolved TOWARD THE STRONGER ARM: a prefix works everywhere.
 *
 * THE FULL-ID PATH STILL COSTS ONE READ. The direct read is attempted first and answers
 * immediately for a full id, which is what every production caller passes (each resolves the
 * id itself before calling). The resolution round trip is paid only when the direct read
 * finds nothing, so nothing in the normal path got slower.
 *
 * AN AMBIGUOUS PREFIX RAISES; IT DOES NOT RETURN NULL AND IT DOES NOT PICK ONE. "No such
 * message" and "your prefix matched several" are different facts with different statuses, and
 * that is the stated reason the seam's resolve operation returns an `Outcome` instead of a
 * nullable id. Answering null here would report a message the caller can see as missing;
 * answering the first match would show them somebody else's mail.
 */
async function readMessage(store: EmailStore, idOrPrefix: string): Promise<MessageRecord | null> {
  const direct = await store.messages.getMessage(idOrPrefix);
  if (!direct.ok) throw storeRefusal("read a message's body", direct);
  if (direct.value !== null) return direct.value;

  const resolved = await store.messages.resolveMessageId(idOrPrefix);
  if (!resolved.ok) {
    // `not_found` is the one refusal that IS an answer here: the caller asked for a message
    // and there is none. Every other refusal — an ambiguous prefix, a scope violation, a
    // malformed argument — is a fact the caller must not read as absence.
    if (resolved.code === "not_found") return null;
    throw storeRefusal("resolve a message id", resolved);
  }

  const second = await store.messages.getMessage(resolved.value.id);
  if (!second.ok) throw storeRefusal("read a message's body", second);
  // A row that resolved and then vanished is a concurrent delete, which is a genuine absence.
  return second.value;
}
