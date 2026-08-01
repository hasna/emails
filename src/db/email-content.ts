// One email-content implementation over the typed store seam. It never branches on a
// deployment label: SQLite writes the local message/legacy-ledger tables, while the HTTP
// store calls the authenticated `/v1/messages/{id}` route backed by tenant-scoped Postgres.
//
// The 1.3.3 seam collapse intentionally removed this writer because that route silently
// discarded body fields. The 1.3.6 repair adds an explicit `updateMessageContent` operation
// to both store implementations, the service store, and the closed OpenAPI patch contract.
// A fulfilled `storeEmailContent` promise therefore means an existing message record was
// returned with the replacement body/header projection; absence and store refusals raise.
//
// Reads retain the seam-collapse semantics: null means no message, a body-less message is a
// record with null body fields, unique prefixes resolve, and headers preserve unknown values.
// Errors never include body or header contents.

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
 * Retained for source compatibility with 1.3.3-1.3.5 callers that imported it.
 * The restored write does not throw this class.
 *
 * @deprecated `storeEmailContent` is supported again on the 1.3.x line.
 */
export class EmailContentWriteUnsupportedError extends Error {
  override readonly name = "EmailContentWriteUnsupportedError";
  /** The message this write was asked to decorate. Carried for the caller, never content. */
  readonly emailId: string;

  constructor(emailId: string) {
    super("This compatibility error is no longer thrown because message content writes are supported.");
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
 * Replace a message's rendered body and headers.
 *
 * This is asynchronous because the configured store may be the HTTP/API arm. A fulfilled
 * promise means the store returned the updated message record; a missing message rejects
 * instead of reporting a write that did not happen.
 *
 * Omitted fields keep the 1.3.2 replacement semantics: text/html become null and headers
 * become an empty object.
 */
export async function storeEmailContent(
  emailId: string,
  content: EmailContentInput,
  store?: EmailStore,
): Promise<void> {
  const resolved = storeFor(store);
  const patch = {
    body_text: content.text ?? null,
    body_html: content.html ?? null,
    headers: content.headers ?? {},
  };
  const direct = await resolved.messages.updateMessageContent(emailId, patch);
  if (!direct.ok) throw storeRefusal("record a message's body", direct);
  if (direct.value !== null) return;

  const id = await resolved.messages.resolveMessageId(emailId);
  if (!id.ok) {
    if (id.code === "not_found") throw new Error(`No such message exists: ${emailId}`);
    throw storeRefusal("resolve a message id for a body write", id);
  }
  const second = await resolved.messages.updateMessageContent(id.value.id, patch);
  if (!second.ok) throw storeRefusal("record a message's body", second);
  if (second.value === null) throw new Error(`No such message exists: ${id.value.id}`);
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
