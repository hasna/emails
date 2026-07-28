// The outbound sent ledger. ONE implementation; nothing here asks where this
// installation is deployed.
//
// WHAT THIS FILE USED TO BE. A 29-line facade that built a dispatch helper, read the
// process-wide deployment word, and handed SEVEN exports to one of two sibling modules:
// a 282-line SQLite arm (`emails.local.ts`) and a 188-line `curl`-bridge arm
// (`emails.remote.ts`). Both are gone. Every READ below reaches the store seam
// (`src/store/`) through `MessagesRepository`, the repository the seam guard already maps
// this family onto (`src/store-seam.test.ts`). The injectable is a store, not a database
// handle, and every export is ASYNCHRONOUS because every operation on the seam is.
//
// `src/store/` is BYTE-IDENTICAL after this change. Two widenings are described below and
// deliberately not made.
//
// ─── THE ONE THING A READER MUST KNOW: THE WRITE IS GONE FROM HERE ───────────────────
//
// `createEmail` no longer writes anything. It is a named refusal, and the local ledger
// INSERT it used to run moved to `src/lib/sent-ledger.local.ts`, beside the
// `email_content` INSERT that is the other half of the same logical write. The reason is
// not stylistic; it is four columns and a foreign key:
//
//   1. `MessageInput` (src/store/records.ts) HAS NO `provider_id`, NO `bcc_addrs`, NO
//      `reply_to` AND NO `tags`. The `emails` table has all four, three of them
//      `NOT NULL`, and `provider_id` carries `REFERENCES providers(id)`. A write through
//      `createMessage` drops all four silently — which is the precise failure this seam
//      exists to remove.
//   2. THE SQLITE STORE WRITES MESSAGES TO A DIFFERENT TABLE. `createMessage` inserts into
//      `inbound_emails`, never into `emails`, and says why: `emails.provider_id` is
//      `NOT NULL` with a foreign key and the seam carries no provider
//      (src/store-sqlite/messages.ts). So a ledger row written through the seam would not
//      be in the `emails` table at all — and `email_content.email_id` and `events.email_id`
//      both declare `REFERENCES emails(id)` (src/db/database.ts). Recording the body of
//      such a send, or an event against it, would fail the foreign key. The sent ledger is
//      not a subset of the message stream on the write side; it is a different table with
//      two dependents.
//   3. BOTH STORES REFUSE AN `idempotency_key` ON `createMessage`
//      (src/store-sqlite/messages.ts `ledgerFieldRefusal`, src/store-http/messages.ts), and
//      `src/lib/forwarding.ts` sets one on every forwarded copy.
//   4. THE DELETED HTTP ARM'S WRITE COULD NEVER HAVE WORKED AGAINST THE REAL SERVICE. It
//      POSTed to `/v1/messages` with `direction: "outbound"` plus `provider_id`,
//      `bcc_addresses`, `reply_to` and `tags`; that route declares
//      `direction: { enum: ["inbound"] }` (src/server/self-hosted/openapi.ts) and the
//      outbound-accepting route is a DIFFERENT one, `POST /v1/messages/record`, which
//      rejects the four send-ledger fields with 400. The arm passed its suite because that
//      suite pointed at `src/test-support/v1-stub.ts`, whose write handler persists any key
//      it is handed and echoes it back. This is the same shape as the defect
//      `src/db/email-content.ts` records: a write that reported success and was discarded.
//
// So the honest split is the one `src/lib/sent-ledger.local.ts` predicted in its own header
// before this collapse existed: the two halves of one ledger write live together, in the
// module that is only reachable on an installation whose store IS that database, and THIS
// family's exported write — the published SDK surface, and the path an API-configured
// installation would reach — refuses by name instead of writing somewhere else.
//
// ─── WHAT THE TWO ARMS ACTUALLY DID DIFFERENTLY, MEASURED RATHER THAN ASSUMED ─────────
//
// TWELVE divergences. The SQLite arm was stronger on FOUR (1, 2, 5, 8), the HTTP arm on
// ONE (3), the two AGREED on two and the agreed behaviour is preserved (7, 12), THREE are
// cases where neither arm was right and both are corrected (4, 5 is shared with the SQLite
// column, 6), and TWO are resolved AWAY from both arms with the reason stated (10, 11).
// The per-divergence verdict is on each entry; the tally above is a summary of them and
// the entries are what to read.
//
//  1. EVERY HTTP-ARM READ EXCEPT ONE ANSWERED OUT OF A CLAMPED PAGE. `searchEmails` and
//     `resolveEmailId` both asked for one page and windowed it locally; both stores and the
//     service clamp a list to 500 rows. `src/lib/export.ts` supplies a DEFAULT limit of
//     1000, so a 600-row ledger exported 500 rows and called it the export, and a prefix
//     belonging to row 600 resolved to "Email not found". (`listEmails` was already fixed
//     on that arm and its header records the measurement; the two beside it were not.) The
//     SQLite arm used SQL with no bound and is the stronger arm. Every read below
//     enumerates the whole filtered stream and REFUSES if it could not finish.
//  2. `tags` CAME BACK EMPTY FROM ONE ARM AND POPULATED FROM THE OTHER — the SQLite arm
//     parsed the column, the HTTP arm's mapper hard-coded `{}` in one file and read
//     `e["tags"]` in the other. Neither is available through the seam now (see the shape
//     note below), so the field is `null` and cannot be mistaken for "no tags".
//  3. A MALFORMED `tags` OR RECIPIENT COLUMN READ AS EMPTY LOCALLY. The SQLite arm used
//     `parseJsonArray` / `parseJsonObject`, which answer `[]` / `{}` for unparseable
//     content. The HTTP arm's coercions rejected a non-array. The stores now do this
//     mapping, and `MessageRecord` declares `to_addrs: string[]`, so the guard moved down
//     rather than away — recorded here because it moved, not because it is fixed.
//  4. THE TWO ARMS SORTED WITH DIFFERENT COLLATIONS AND NEITHER HAD A TIEBREAKER. The
//     SQLite arm's `ORDER BY sent_at DESC` ran under that engine's BINARY collation; the
//     HTTP arm sorted in JavaScript with `localeCompare`, so the order it PRESENTED moved
//     with the process locale. Rows written in a tight loop share a timestamp, so the tie
//     was reachable in both. Everything below compares in UTF-16 code-unit order and
//     carries an `id` tiebreaker, which is a TOTAL order on every machine.
//  5. THE HTTP ARM COERCED AN UNKNOWN `status` TO `sent`; the SQLite arm cast the column
//     raw and published a value its own type could not hold. Neither is right: `sent` is a
//     claim about a message that was not delivered, and a raw cast puts `received` behind a
//     type that says it cannot be. `inbound_emails.status` has NO CHECK constraint
//     (src/db/database.ts migration 18), so the value is reachable. It is a FAULT below,
//     naming the row and the value.
//  6. ABSENT IS NOT `now()`. The HTTP arm read every timestamp through a coercion that
//     answers `new Date().toISOString()` for a MISSING value, so a row whose `created_at`
//     could not be read was reported as having been sent at the moment it was read. Both
//     columns are `NOT NULL` in both schemas. That is a fault here.
//  7. `idempotency_key` IS NEVER SURFACED ON A MAPPED `Email`, which both arms agreed on
//     (the SQLite arm projected an explicit column list that omitted it; the HTTP arm's
//     mapper never read it). Preserved: the seam's record carries the column and nothing
//     below copies it out.
//  8. `getEmail` ANSWERED ABOUT DIFFERENT ROWS IN THE TWO ARMS. The SQLite arm read the
//     `emails` table, which is outbound by construction; the HTTP arm read
//     `/v1/messages/<id>`, which serves BOTH directions — and then ran the received row
//     through the status coercion in divergence 5, so `emails log show <inbound-id>`
//     printed an inbound message as a sent one. Every read below is OUTBOUND-SCOPED, which
//     is the SQLite arm's dataset and the only one the words "sent ledger" describe.
//  9. `resolveEmailId` HAD NO AMBIGUITY SIGNAL IN EITHER ARM: both answered `null` for "no
//     such id" and for "your prefix matched several", and both callers print
//     `Email not found`. The seam distinguishes them (404 vs 409). An ambiguous prefix now
//     THROWS, naming the matches, exactly as `resolvePartialIdOrThrow` already does for
//     every other table in this repo (src/db/database.ts).
// 10. `from_address` FILTERING IS AN EQUALITY, AND THE SEAM'S IS A SUBSTRING. Both arms
//     compared canonical senders for equality — SQL on one side, `canonicalSender` on the
//     other. `ListMessagesOptions.from` is `lower(from_addr) LIKE %x%` on the SQLite store
//     and its own match on the server, so pushing the filter down would silently widen
//     `--from a@b.com` to every address containing it. It is applied in this module, over
//     the enumerated stream, so one definition of "from this sender" serves both stores.
// 11. `searchEmails` MATCHED SUBJECT, FROM AND TO IN BOTH ARMS, and the seam's `search`
//     matches MORE than that and matches a different MORE on each store (the SQLite store
//     also matches `body_text` and attachment filenames; the server matches its own set).
//     Pushing it down would make the result set depend on which store answered. The
//     three-field predicate both arms published is applied here instead.
// 12. `deleteEmail` ANSWERS A BOOLEAN AND BOTH ARMS AGREED that a delete of a row that is
//     not there is `false` rather than an error. Preserved.
//
// ─── FOUR FIELDS THE SEAM DOES NOT PUBLISH, AND WHY THEY ARE `null` RATHER THAN EMPTY ──
//
// `MessageRecord` and `MessageListRecord` carry NO `provider_id`, NO `bcc_addrs`, NO
// `reply_to` and NO `tags`. This is UNIFORM: it is not one store that cannot answer, it is
// the seam that does not model a provider-scoped sent ledger, and the SQLite store's own
// unified projection does not select those columns even though the table beneath it has
// them (src/store-sqlite/messages-sql.ts).
//
// The deleted HTTP arm filled them with `"self_hosted"`, `[]`, `null` and `{}` — four
// comfortable values indistinguishable from four real ones. `Email` is widened instead, so
// `null` means "this store does not publish it" and an empty array keeps meaning "there
// were no bcc recipients". `reply_to` was ALREADY `string | null` and is the one field
// where the two meanings still collide; separating them needs a second field on a published
// type, which is a larger change than this collapse, and it is named here rather than left
// to be discovered.
//
// THE `provider_id` FILTER THEREFORE CANNOT BE APPLIED, and `listEmails` REFUSES it rather
// than ignoring it. Ignoring a filter returns rows the caller did not ask for; answering
// `[]` invents an empty ledger. `emails log list --provider`, `emails sync`,
// `GET /api/emails?provider_id=` and `emails export emails --provider` all reach it, and
// all of them now get an error that says exactly what is missing.
//
// A SEAM WIDENING, DESCRIBED AND NOT MADE. Adding `provider_id` to `MessageRecord`,
// `MessageListRecord`, `MessageInput` and `ListMessagesOptions` — the column exists on both
// physical tables and in the service's own schema — restores the filter, the field, and
// half the write. A SECOND widening would restore the rest of the write: `bcc_addrs`,
// `reply_to` and `tags` on `MessageInput` and `MessageRecord`. Neither is made here: two
// audits are waiting on `src/store/` and this change leaves it byte-identical.
//
// ─── `attachment_count` MEANS SOMETHING ELSE NOW, AND THAT IS THE STORE'S DECISION ─────
//
// The deleted SQLite arm read `emails.attachment_count`, the column recording how many
// attachments a send HAD. The seam's projection derives the number from the attachments
// ARRAY and hard-codes it to 0 for legacy ledger rows, deliberately: that table stores no
// metadata and no bytes for them, and surfacing the column made three operations disagree
// about one row (src/store-sqlite/messages-sql.ts records the finding). So through this
// family a ledger row now reports the attachments the store can SERVE, which for a legacy
// row is none. The legacy column is untouched and its own readers still see it. This is a
// real reduction in what `emails export emails` reports and it is stated rather than left
// to be found.
//
// ─── WHAT IS SLOWER, STATED RATHER THAN LEFT TO BE DISCOVERED ─────────────────────────
//
// `direction: "outbound"` is the ONE filter pushed down (both stores implement it as a
// predicate over the same unified stream). Every other filter — provider, status, sender,
// since, until, and the search needle — is applied in this module over the enumerated
// stream, for the reasons in divergences 10 and 11. So a read that is not addressed by a
// single id walks the whole outbound stream: one in-process query per page against the
// local SQLite store, one HTTP request per page against an API store, at 500 rows a page.
// The deleted SQLite arm did each of these in one indexed query. That is a real cost this
// change accepts in exchange for not answering out of one page and not letting the answer
// depend on which store replied.
//
// AND WHAT IS NOT MERELY SLOWER. The enumeration is BOUNDED at 200 pages (about 100,000
// rows). Past that these reads do not degrade, they THROW — on the local store too, where
// the deleted arm had no bound at all. The alternative is a truncated ledger published as
// the whole one, which is the defect this collapse exists to remove.

import type { Email, EmailFilter, EmailStatus, SendEmailOptions } from "../types/index.js";
import { EmailNotFoundError } from "../types/index.js";
import { canonicalSender } from "../lib/email-address.js";
import { enumerateStorePages, type StoreCursorEnumeration } from "../lib/status-facts-enumeration.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome, Refusal } from "../store/outcome.js";
import type { MessageListRecord, MessageRecord } from "../store/records.js";

/**
 * Pages one ledger enumeration may fetch, at 500 rows a page — about 100,000 rows.
 *
 * Far above the shared default of 40 pages because these reads must see the WHOLE outbound
 * stream to be correct: a `--since` window whose matches all lie past the first page is not
 * an empty window, and an export that stops early is a file that looks complete. Running
 * out is reported, never returned as a smaller answer.
 */
const MAX_LEDGER_PAGES = 200;

/** The five states `Email.status` can hold. Divergence 5 turns anything else into a fault. */
const EMAIL_STATUSES: ReadonlySet<string> = new Set<EmailStatus>([
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
]);

// ─── Refusals, faults and the store handle ──────────────────────────────────

/**
 * A store refusal, thrown.
 *
 * Names the OPERATION and carries the store's own code, status and message. It names no
 * setting and no command: a refusal that tells the caller which variable to flip is a
 * refusal documenting its own bypass.
 */
function storeRefusal(what: string, refusal: Refusal): Error {
  return new Error(
    `This installation's store cannot ${what} (${refusal.code}, ${refusal.status}): ${refusal.message}`,
  );
}

/**
 * The store this call should use: the injected one, or the configured one.
 *
 * Built per call rather than at module load, because a contradictory storage configuration
 * is a boot error raised by the resolution and it belongs to the call that needed a store,
 * not to whoever imported this module first.
 */
function storeFor(store: EmailStore | undefined): EmailStore {
  return store ?? createConfiguredEmailStore();
}

/** Unwrap an `Outcome`, or throw the refusal naming the operation. */
function required<TValue>(what: string, outcome: Outcome<TValue>): TValue {
  if (!outcome.ok) throw storeRefusal(what, outcome);
  return outcome.value;
}

/** Code-unit order, not `localeCompare`. Divergence 4. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A ledger read that did not reach the end of the stream is not a shorter ledger.
 *
 * `Email[]` has nowhere to record "this is a lower bound", and every consumer of these
 * reads treats the array as the whole answer: `src/lib/export.ts` writes it to a file,
 * `src/lib/warming.ts` counts it against a daily cap, `emails log list` prints it. So a
 * truncated, unstable or refused enumeration throws, naming which of the three it was.
 */
function assertWholeStream(what: string, enumeration: StoreCursorEnumeration<unknown>): void {
  if (enumeration.refusal !== null) throw storeRefusal(what, enumeration.refusal);
  if (enumeration.fault !== null) {
    throw new Error(
      `This installation's store failed while reading the sent ledger to ${what}: ${enumeration.fault}`,
    );
  }
  if (enumeration.complete) return;
  const why = enumeration.duplicates > 0
    ? `the store returned ${enumeration.duplicates} row(s) twice across ${enumeration.pages} page(s), `
      + "which proves its page order is not total and that other rows were skipped"
    : enumeration.stalled
      ? `the store handed back a page cursor it could not advance past after ${enumeration.pages} page(s)`
      : `the read reached its ${MAX_LEDGER_PAGES}-page budget holding ${enumeration.rows.length} row(s) `
        + "and the store had not reported the last page";
  throw new Error(
    `Refusing to ${what} from an incomplete read of the sent ledger: ${why}. `
      + "Narrow the read with --from, --since or --until rather than treating this as the whole ledger.",
  );
}

// ─── Mapping a store record onto an Email ───────────────────────────────────

function requiredTimestamp(value: string | null | undefined, id: string, column: string): string {
  // Divergence 6. Both columns are NOT NULL in both schemas, so absence is a store that did
  // not project them — reporting `now()` would date the message to the moment it was read.
  if (value === null || value === undefined || value === "") {
    throw new Error(
      `This installation's store returned message ${id || "(no id)"} with no ${column}; `
        + "refusing to report the current time as the moment it was sent",
    );
  }
  return value;
}

function emailStatusOf(value: string, id: string): EmailStatus {
  // Divergence 5.
  if (!EMAIL_STATUSES.has(value)) {
    throw new Error(
      `This installation's store returned message ${id || "(no id)"} with status ${JSON.stringify(value)}, `
        + "which is not one of sent, delivered, bounced, complained or failed; refusing to report it as sent",
    );
  }
  return value as EmailStatus;
}

/**
 * One shape for both projections.
 *
 * `MessageRecord` and `MessageListRecord` differ in exactly what this mapping needs to know:
 * the list projection publishes `attachment_count` as a scalar and the single-message read
 * publishes the `attachments` array itself. Everything else the ledger needs is on both, so
 * the count is resolved by the two callers and the rest is mapped ONCE — rather than two
 * mappers that can drift, which is what the deleted arms were.
 */
function toEmail(
  row: Pick<
    MessageRecord,
    | "id"
    | "from_addr"
    | "to_addrs"
    | "cc_addrs"
    | "subject"
    | "status"
    | "provider_message_id"
    | "received_at"
    | "created_at"
    | "updated_at"
  >,
  attachmentCount: number,
): Email {
  const createdAt = requiredTimestamp(row.created_at, row.id, "created_at");
  return {
    id: row.id,
    // The four fields the seam does not publish. `null` is "this store does not record it",
    // never "there is none of it" — see the shape note in the module header.
    provider_id: null,
    provider_message_id: row.provider_message_id,
    from_address: row.from_addr,
    to_addresses: [...row.to_addrs],
    cc_addresses: [...row.cc_addrs],
    bcc_addresses: null,
    reply_to: null,
    // The ledger column is NOT NULL; `inbound_emails.subject` defaults to the empty string.
    // A null is the latter, and both arms published "" for it.
    subject: row.subject ?? "",
    status: emailStatusOf(row.status, row.id),
    has_attachments: attachmentCount > 0,
    attachment_count: attachmentCount,
    tags: null,
    // The unified projection maps the ledger's `sent_at` onto `received_at`
    // (src/store-sqlite/messages-sql.ts), and a row written through the seam has no separate
    // sent column. `created_at` is the fallback both arms already used.
    sent_at: row.received_at ?? createdAt,
    created_at: createdAt,
    updated_at: requiredTimestamp(row.updated_at, row.id, "updated_at"),
  };
}

function listRecordToEmail(row: MessageListRecord): Email {
  return toEmail(row, row.attachment_count);
}

function recordToEmail(row: MessageRecord): Email {
  return toEmail(row, row.attachments.length);
}

/** Divergence 8: only outbound rows are sent-ledger entries. */
function isOutbound(direction: string): boolean {
  return direction.trim().toLowerCase() === "outbound";
}

// ─── The enumerated stream ──────────────────────────────────────────────────
//
// MAPPING HAPPENS AFTER WINDOWING, AND THAT IS A CORRECTNESS RULE RATHER THAN AN
// OPTIMISATION. `toEmail` FAULTS on a row it cannot honestly present — an unrecognised
// status (divergence 5), a missing `created_at` (divergence 6). If the whole enumerated set
// were mapped before the caller's window was taken, ONE such row anywhere in the ledger
// would take down every listing, including listings that would never have shown it. The
// sibling `db/sandbox` collapse found exactly that shape and it is not repeated here:
// filtering and ordering run over the RAW store record, the window is taken, and only the
// rows the caller will actually receive are mapped. A row that cannot be presented then
// faults when it is presented, which is the row and not the page.
//
// THE ONE PLACE A RAW ROW STILL HAS TO BE JUDGED IS A DATE WINDOW. `--since` / `--until`
// need a timestamp, and a row carrying neither `received_at` nor `created_at` can be neither
// included nor excluded honestly — silently dropping it is the fabricated-empty this whole
// programme removes. That row faults, and the fault names it.

/** The raw ordering key: the ledger's send time, or the row's creation time. */
function rawSentAt(row: MessageListRecord): string | null {
  const value = row.received_at ?? row.created_at;
  return value === null || value === undefined || value === "" ? null : value;
}

/**
 * A raw row's sortable key. `""` sorts last under a DESC comparator, which is where a row
 * with no usable timestamp belongs; it still faults if the window reaches it.
 */
function rawSortKey(row: MessageListRecord): string {
  return rawSentAt(row) ?? "";
}

/** Newest first, with an `id` tiebreaker so the order is TOTAL. Divergence 4. */
function byNewestFirstRaw(a: MessageListRecord, b: MessageListRecord): number {
  return compareText(rawSortKey(b), rawSortKey(a)) || compareText(b.id, a.id);
}

/** The caller's window, applied AFTER the whole filtered set has been sorted. */
function windowed<TRow>(rows: TRow[], limit: number | null, offset: number): TRow[] {
  return limit === null ? rows : rows.slice(offset, offset + limit);
}

/** The timestamp a date window is decided on, or a fault naming the row. */
function datedFor(row: MessageListRecord, what: string): string {
  const value = rawSentAt(row);
  if (value !== null) return value;
  throw new Error(
    `This installation's store returned message ${row.id || "(no id)"} with neither a received_at `
      + `nor a created_at, so it cannot be placed in the requested date window while trying to ${what}; `
      + "refusing to drop it silently",
  );
}

/**
 * Every outbound row, in ONE walk, with the caller's predicate applied to the RAW record.
 *
 * `direction` is the only filter pushed down (divergences 10 and 11 say why the others are
 * not), and the direction of each row is re-checked here as well: the push-down is the
 * store's predicate and this is the same question asked of the row that came back, so a
 * store that widens it cannot leak a received message into the sent ledger.
 */
async function enumerateOutbound(
  store: EmailStore,
  keep: (row: MessageListRecord) => boolean,
): Promise<StoreCursorEnumeration<MessageListRecord>> {
  const enumeration = await enumerateStorePages<MessageListRecord>(
    (opts) => store.messages.listMessages({ direction: "outbound", ...opts }),
    { idOf: (row) => row.id, pageBudget: MAX_LEDGER_PAGES },
  );
  return { ...enumeration, rows: enumeration.rows.filter((row) => isOutbound(row.direction) && keep(row)) };
}

/**
 * Every sent-ledger filter except the provider, applied to the RAW record.
 *
 * `status` is compared as TEXT rather than through `emailStatusOf`, deliberately: a row whose
 * status this family cannot present is still a row that does or does not carry the value the
 * caller asked for, and faulting during a FILTER would take down a listing over a row the
 * filter was about to exclude anyway.
 */
function matchesFilter(row: MessageListRecord, filter: EmailFilter, what: string): boolean {
  if (filter.status) {
    const wanted: readonly string[] = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!wanted.includes(row.status)) return false;
  }
  if (filter.from_address) {
    const want = canonicalSender(filter.from_address) ?? filter.from_address.trim().toLowerCase();
    const have = canonicalSender(row.from_addr) ?? row.from_addr.trim().toLowerCase();
    if (have !== want) return false;
  }
  if (filter.since !== undefined || filter.until !== undefined) {
    const dated = datedFor(row, what);
    if (filter.since && dated < filter.since) return false;
    if (filter.until && dated > filter.until) return false;
  }
  return true;
}

/**
 * The filter this family cannot apply, refused by name.
 *
 * See the shape note in the module header: no message projection on the seam carries a
 * provider, so `provider_id` can be neither pushed down nor re-checked. Ignoring it returns
 * rows the caller did not ask for; answering `[]` invents an empty ledger.
 *
 * ONLY A NON-BLANK PROVIDER REFUSES. Every caller in this repo passes
 * `opts.provider ? resolveId(...) : undefined`, so `undefined` is the overwhelmingly common
 * case and it must reach the ledger untouched — an unconditional throw here would take the
 * whole sent-ledger list path down rather than one filter, which is exactly what happened
 * once during this collapse and is why the empty-and-undefined cases are pinned.
 */
function assertProviderFilterAvailable(providerId: string | undefined, what: string): void {
  if (providerId === undefined || providerId.trim() === "") return;
  throw new Error(
    `Refusing to ${what} filtered by provider: this installation's store does not record which `
      + "provider sent a message (no message projection on the store seam carries provider_id), so the "
      + "filter can be neither applied nor checked, and answering with every provider's mail or with "
      + "nothing would both be wrong. Drop the provider filter to read the whole sent ledger.",
  );
}

// ─── The family ─────────────────────────────────────────────────────────────

/**
 * THE SENT-LEDGER WRITE, WHICH THIS FAMILY NO LONGER PERFORMS.
 *
 * Kept as an export, and kept refusing, because it is on the published SDK surface
 * (`src/index.ts`) and because the path it used to take on an API-configured installation
 * wrote to a route that rejects the direction it sent. The module header lists the four
 * reasons — four missing columns, a different physical table with two foreign-key
 * dependents, an idempotency key both stores refuse, and a `/v1` route that only accepts
 * inbound — and names the widenings that would bring it back.
 *
 * WHAT STILL WRITES THE LEDGER. `src/lib/sent-ledger.local.ts`, on a local installation, in
 * the same module and on the same paths as the `email_content` INSERT that records the
 * body. On an API-configured installation the SERVICE records a sent message when its send
 * route reserves the send intent, which is the only place that has ever worked.
 *
 * The refusal THROWS rather than returning a flag: the return type is `Email`, there is no
 * honest `Email` to return, and the last version of this operation reported a discarded
 * write as done.
 */
export async function createEmail(
  provider_id: string,
  opts: SendEmailOptions,
  provider_message_id?: string,
): Promise<Email> {
  void provider_id;
  void opts;
  void provider_message_id;
  throw new Error(
    "The sent-ledger write is not available through the store seam: MessageInput carries no "
      + "provider_id, bcc_addrs, reply_to or tags, both stores refuse an idempotency_key on "
      + "createMessage, and the SQLite store writes messages to inbound_emails rather than to the "
      + "emails table that email_content and events hold foreign keys into. A local installation "
      + "records a sent message through createSentEmailLedger (src/lib/sent-ledger.local.ts); an "
      + "installation reading through an Emails API records it in the service's own send route.",
  );
}

/**
 * One sent email by full id, or null.
 *
 * OUTBOUND-SCOPED (divergence 8): an id that names a received message answers `null`,
 * because it is not an entry in the sent ledger and reporting it as one requires calling a
 * received message `sent`.
 */
export async function getEmail(id: string, store?: EmailStore): Promise<Email | null> {
  const record = required("read a sent email", await storeFor(store).messages.getMessage(id));
  if (record === null) return null;
  return isOutbound(record.direction) ? recordToEmail(record) : null;
}

/**
 * Resolve a full or partial id to a canonical sent-ledger id.
 *
 * A FULL id is ONE read: `getMessage`, checked for direction. That is deliberately the same
 * read `getEmail` performs, over the same dataset — resolving through a second, differently
 * scoped operation is how a resolved id and the row it names come from two different
 * datasets.
 *
 * A PREFIX enumerates the outbound stream and matches here. `resolveMessageId` on the seam
 * is not used for it: that operation resolves over BOTH directions, so a prefix matching one
 * outbound and one received row would come back `ambiguous_id` when the sent ledger holds
 * exactly one match, and a prefix matching only a received row would resolve to an id
 * `getEmail` then answers `null` for. The enumeration REFUSES if it could not finish, which
 * the deleted HTTP arm's single clamped page did not (divergence 1).
 *
 * @throws when the prefix matches more than one sent email (divergence 9).
 */
export async function resolveEmailId(id: string, store?: EmailStore): Promise<string | null> {
  const trimmed = id.trim();
  if (!trimmed) return null;
  const resolved = storeFor(store);
  if (trimmed.length >= 36) {
    const record = required("resolve a sent email id", await resolved.messages.getMessage(trimmed));
    return record !== null && isOutbound(record.direction) ? record.id : null;
  }
  const enumeration = await enumerateOutbound(resolved, (row) => row.id.startsWith(trimmed));
  assertWholeStream(`resolve the sent email id ${trimmed}`, enumeration);
  const matches = enumeration.rows.map((row) => row.id).sort(compareText);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] as string;
  const preview = matches.slice(0, 5).join(", ");
  const extra = matches.length > 5 ? " (showing first 5)" : "";
  throw new Error(
    `Ambiguous sent email id '${trimmed}' (${matches.length} matches${extra}): ${preview}. `
      + "Use a longer prefix or the full id.",
  );
}

/** The sent ledger, filtered, ordered newest-first and windowed — or a refusal. */
export async function listEmails(filter: EmailFilter = {}, store?: EmailStore): Promise<Email[]> {
  const what = "list the sent ledger";
  assertProviderFilterAvailable(filter.provider_id, what);
  const enumeration = await enumerateOutbound(storeFor(store), (row) => matchesFilter(row, filter, what));
  assertWholeStream(what, enumeration);
  const rows = enumeration.rows.sort(byNewestFirstRaw);
  return windowed(rows, safeOptionalLimit(filter.limit), safeOffset(filter.offset)).map(listRecordToEmail);
}

/**
 * The sent ledger, narrowed by a case-insensitive needle over subject, sender and
 * recipients — the three-field predicate both arms published (divergence 11).
 */
export async function searchEmails(
  query: string,
  opts?: { since?: string; limit?: number; offset?: number },
  store?: EmailStore,
): Promise<Email[]> {
  const what = "search the sent ledger";
  const needle = query.toLowerCase();
  const enumeration = await enumerateOutbound(storeFor(store), (row) => {
    if (opts?.since !== undefined && datedFor(row, what) < opts.since) return false;
    return (
      (row.subject ?? "").toLowerCase().includes(needle)
      || row.from_addr.toLowerCase().includes(needle)
      || row.to_addrs.some((to) => to.toLowerCase().includes(needle))
    );
  });
  assertWholeStream(what, enumeration);
  const rows = enumeration.rows.sort(byNewestFirstRaw);
  return windowed(rows, safeOptionalLimit(opts?.limit), safeOffset(opts?.offset)).map(listRecordToEmail);
}

/**
 * Move a sent email to a new delivery state.
 *
 * The row is READ FIRST, so an id naming a received message is `EmailNotFoundError` rather
 * than a status write onto that message — the same outbound scope every other read in this
 * family applies. The store's own post-write record is what comes back; a store that
 * persisted something else is not taken at the caller's word.
 */
export async function updateEmailStatus(
  id: string,
  status: EmailStatus,
  store?: EmailStore,
): Promise<Email> {
  // THE WRITE MAY NOT ACCEPT WHAT THE READ REFUSES. `EmailStatus` constrains a TypeScript
  // caller and nothing else — this module is published as JavaScript, `src/server/routes` casts
  // a query parameter straight into the type, and `emailStatusOf` faults on anything outside
  // the five. Writing a sixth value would make the row this call just wrote unreadable by the
  // read beside it. That accept-on-write / refuse-on-read split is a real defect shape found in
  // a sibling family, so the write is held to the read's vocabulary.
  if (!EMAIL_STATUSES.has(status)) {
    throw new Error(
      `Refusing to set sent email ${id} to status ${JSON.stringify(status)}: it is not one of sent, `
        + "delivered, bounced, complained or failed, and this family could not read the row back afterwards",
    );
  }
  const resolved = storeFor(store);
  const existing = await getEmail(id, resolved);
  if (existing === null) throw new EmailNotFoundError(id);
  const updated = required(
    "update a sent email's status",
    await resolved.messages.updateMessageStatus(id, { status }),
  );
  if (updated === null) throw new EmailNotFoundError(id);
  return recordToEmail(updated);
}

/**
 * Delete a sent email. `false` when there was no such row, which both arms agreed on
 * (divergence 12).
 *
 * OUTBOUND-SCOPED like every other operation here: `deleteMessage` on the seam would delete
 * a received message just as happily, and `emails log delete` must not be a way to destroy
 * received mail.
 */
export async function deleteEmail(id: string, store?: EmailStore): Promise<boolean> {
  const resolved = storeFor(store);
  const existing = await getEmail(id, resolved);
  if (existing === null) return false;
  return required("delete a sent email", await resolved.messages.deleteMessage(id));
}
