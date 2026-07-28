// Captured outbound mail for the SANDBOX provider, as ONE implementation over the store
// seam. Nothing here asks who is running it.
//
// A sandbox provider does not send: `SandboxAdapter.sendEmail` (src/providers/sandbox.ts)
// writes the message it was asked to send into the `sandbox_emails` table and returns its
// id. These six exports are how that capture is written, read back, counted and cleared.
//
// ─── WHAT THIS FILE USED TO BE ────────────────────────────────────────────────────────
//
// A 28-line facade whose dispatch helper read the process-wide deployment word and handed
// each of six exports to one of two sibling modules: a 210-line SQLite arm and a 118-line
// arm that talked to `/v1/sandbox-emails` through the shared generic-resource bridge.
// Unlike `src/lib/forwarding` and `src/lib/webhook`, whose second arms were bare refusals,
// BOTH arms here were real implementations of all six operations — so this collapse is a
// resolution of genuine disagreements rather than the preservation of a refusal, and the
// disagreements are the substance of the change. Each is listed below with the arm it was
// resolved toward and why.
//
// Every export now reaches the `sandbox_emails` table through `EmailStore` (`src/store/`),
// is ASYNCHRONOUS because every operation on the seam is, and takes an injectable store
// defaulting to the configured one. `src/store/` itself is byte-identical to main.
//
// EVERY OPERATION BUT ONE HAS A STORE EQUIVALENT. `src/store/repositories.ts` publishes
// `SandboxRepository` over the `sandbox_emails` table, `/v1/sandbox-emails` serves it
// (`src/server/self-hosted/resources.ts`) and the self-hosted Postgres schema has the table
// (`src/server/self-hosted/migrations.ts`). The exception is the COUNT — see note 8.
//
// ─── THE EIGHT DIVERGENCES, MEASURED RATHER THAN ASSUMED ──────────────────────────────
//
//  1. FOUR OPERATIONS READ ONE CLAMPED PAGE AND CALLED IT THE TABLE. The deleted HTTP arm
//     answered `listSandboxEmails`, `listSandboxEmailSummaries`, `clearSandboxEmails` AND
//     `getSandboxCount` out of a single `list({ limit: 1000 })`. Both stores clamp a page
//     to 500 (`src/store-sqlite/resources.ts` MAX_PAGE, `src/store-http/registry.ts`, and
//     the service clamps again), so above 500 captured emails that arm listed a window cut
//     out of the wrong 500 rows, DELETED at most 500 while reporting that number as the
//     total cleared, and reported a count of exactly 500 for a table of any larger size.
//     The SQLite arm pushed `LIMIT`/`OFFSET` into SQL, deleted with one `DELETE` statement
//     and counted with `COUNT(*)`; it is the stronger arm on all four, and every read below
//     enumerates to an EMPTY page and REFUSES if it could not finish.
//  2. ORDER. `ResourceRepository.list` promises no order and `ListOptions` admits none, and
//     the two stores order this family differently: the SQLite resource path derives
//     `created_at DESC, id DESC` from the table's own shape (`describeTable`; this table has
//     no `updated_at` locally) and the service's spec says `created_at DESC` with no
//     tiebreaker. Both arms published newest-first. So NOTHING pushes a `limit`/`offset`
//     down — the first N rows of a store's order, re-sorted here, is a plausible and
//     silently wrong page against one of the two stores. The filtered set is enumerated in
//     full, sorted here, and only then windowed.
//  3. THE TIEBREAKER, which neither arm had. `created_at` alone is not a total order and
//     this table's stamps collide readily — a send loop captures many rows inside one
//     millisecond — so `--offset` could repeat or drop a row under either arm. Ordering is
//     now `created_at DESC, id DESC`, which is also the SQLite store's own.
//  4. THE TWO ARMS SORTED WITH DIFFERENT COLLATIONS. The SQLite arm sorted in SQL under that
//     engine's BINARY collation; the HTTP arm sorted in JavaScript with `localeCompare`,
//     which is LOCALE-DEPENDENT — so that arm's page boundaries moved with the process
//     locale, which is not a property a paged list may have. The comparison below is UTF-16
//     code-unit order: deterministic everywhere, and identical to BINARY for every value
//     either schema can hold in a timestamp or a uuid.
//  5. A CLIENT-MINTED ID THAT THE REAL API STORE REFUSES. The deleted HTTP arm generated a
//     uuid and sent it as `id`. `/v1/sandbox-emails` declares TWELVE writable columns and
//     `id` is not among them, and the request schema is `additionalProperties: false`
//     (`src/server/self-hosted/openapi.ts` builds it from the spec's column list), so the
//     real `HttpEmailStore` REFUSES that write; the deleted bridge did not validate it and
//     the service silently ignored the field, minting its own id and handing it back. So the
//     client id was already dead on that arm — it merely could not be seen. Nothing below
//     sends `id`; both stores mint it and the created row is read out of the store's answer.
//  6. `created_at` IS SENT, and this family is unusual in being able to. It IS a declared
//     writable column on this resource (the spec lists it, unlike `aliases` or `scheduled`),
//     and it is the family's ONLY ordering key, so one ISO instant from one clock is written
//     rather than left to two stores' defaults. THE FORMAT CHANGES FOR LOCAL WRITES and
//     saying so is the point: the deleted SQLite arm omitted the column and took the table
//     default `datetime('now')`, which is `YYYY-MM-DD HH:MM:SS`, while this writes
//     `YYYY-MM-DDTHH:MM:SS.sssZ`. The change is UNAVOIDABLE through the seam — the SQLite
//     store stamps `now()` for an absent `created_at` on any table that has the column — so
//     the choice is only whether both stores get the same instant, and they now do. The
//     consequence is real and is not hidden: a row written by an older version sorts as if
//     it were older than every new row, because `' '` precedes `'T'` in code-unit order.
//     Sandbox captures are ephemeral (this module publishes the operation that deletes them
//     all), so no migration is proposed; a mixed table is named here so a reader who sees
//     the ordering does not have to rediscover why.
//  7. THE TWO MALFORMED-JSON COERCIONS DISAGREED, AND BOTH FABRICATED. `to_addresses` is
//     `TEXT` holding a JSON array in SQLite and `JSONB` in Postgres, so a reader must accept
//     both shapes. On content it cannot parse, the SQLite arm's helper answered `[]` (every
//     recipient silently dropped) and the HTTP arm's answered `[<the raw text>]` (a recipient
//     invented that was never addressed). There is no stronger arm to resolve toward — both
//     are the fabricated-value failure, in opposite directions — so an unreadable recipient
//     list, attachment list or header map is a FAULT naming the row. The row stays visible to
//     `clearSandboxEmails`, which deliberately does not map (see that function), so a corrupt
//     row can still be deleted.
//  8. THE COUNT HAS NO STORE EQUIVALENT AT ALL. The seam publishes no aggregate — no count
//     operation, no total on a list envelope, no cursor on the uniform families — so
//     `COUNT(*)` becomes a bounded client-side enumeration, and a bounded enumeration cannot
//     always produce a total. `getSandboxCount` therefore answers `number | null`: the exact
//     count when the whole filtered set was read, and `null` — never `0`, never the rows it
//     managed to see — when it was not. A refusal or a fault THROWS instead, because those
//     mean nothing was read at all and a `null` would blur the two. The widening is recorded
//     at the export site in `src/index.ts`. What is NOT done is publish a lower bound as a
//     bare `number`: the sole consumer's field (`Stats.sent`, `src/types/index.ts`) is a
//     plain number with nowhere to carry a `>=` marker, so a bound written there would be
//     read as a total — the exact fabrication this seam exists to remove. The seam widening
//     that would remove the guesswork is DESCRIBED AND NOT MADE: `ResourceRepository` gains
//     `count(opts?: { filters?: Record<string, string> }): Promise<Outcome<number>>`, both
//     stores implement it over a single aggregate query, and the service grows a
//     `/v1/<resource>/count` route. `src/store/` is untouched here.
//
// TWO THINGS BOTH ARMS AGREED ON AND THAT ARE THEREFORE PRESERVED VERBATIM, even though
// neither is what a reader would design today:
//
//  * A FALSY PROVIDER FILTER MEANS "EVERY PROVIDER". Both arms wrote `if (providerId)`, so
//    `listSandboxEmails("")` and `clearSandboxEmails("")` mean the whole table rather than
//    an empty result. `clearSandboxEmails("")` therefore DELETES EVERY CAPTURED EMAIL, which
//    is worth reading twice; it is preserved because both arms did it and because the
//    alternative — an empty string quietly scoping a delete to nothing — is not obviously
//    safer for a caller who believes it filtered. `src/db/aliases.ts` note 9 records the
//    same shape being got wrong in the other direction.
//  * `safeLimit` / `safeOffset` PARITY. A non-finite limit falls back to 50, a limit below 1
//    becomes 1, a negative offset becomes 0. Both arms shared these helpers and so does this.
//
// ─── WHAT IS LOST, NAMED HERE RATHER THAN LEFT TO BE DISCOVERED ───────────────────────
//
//  * THE ATOMIC CLEAR. `clearSandboxEmails` was ONE `DELETE` statement whose `changes` count
//    WAS the answer. The seam publishes `remove(id)` and no bulk delete, so it is now an
//    enumeration followed by one removal per row: N round trips, no atomicity, and a caller
//    that dies half way leaves half the rows. The whole set is read BEFORE anything is
//    deleted and the read must be complete, so a truncated enumeration refuses without
//    having deleted anything; a removal that refuses part way through throws naming how many
//    rows were already gone, rather than reporting a plausible number.
//  * THE NARROW SUMMARY READ. The SQLite arm's `listSandboxEmailSummaries` issued a SELECT
//    that omitted `html`, `text_body` and `headers_json` — the three big columns — so a
//    summary listing never paid for the bodies. The seam has no projection, so summaries are
//    now built by reading the full row and dropping those three keys, exactly as the HTTP arm
//    already did. The cost is bytes over the wire and in memory, not correctness.
//  * SYNCHRONOUS CALLS. All six are now `async`. Both arms were synchronous (one on SQLite,
//    one on a blocking transport). Every consumer is listed in the PR body and awaited.
//  * A CALLER-SUPPLIED DATABASE HANDLE. The trailing `db?: Database` slot is now a trailing
//    `store?: EmailStore`, and `listSandboxEmails`/`listSandboxEmailSummaries` lose the
//    `Database | number` third parameter the facade needed to reconcile two incompatible arm
//    signatures; their third parameter is now the offset both arms already accepted there.
//    The one production caller that passed a handle — the local dashboard's `/api/sandbox`
//    routes — passes the process-wide connection, and now passes a SQLite store bound to
//    that same connection, so it reads exactly the rows it read before.
//
// A REFUSAL IS NEVER AN ANSWER. Every store refusal below is turned into a thrown error
// naming the operation and carrying the store's own code, status and message. Nothing here
// answers `[]`, `0`, `null` or "deleted 0" for a read or a write that did not happen.

import { safeLimit, safeOffset } from "./pagination.js";
import { now } from "./runtime.js";
import { enumerateStoreRows } from "../lib/status-facts-enumeration.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Refusal } from "../store/outcome.js";
import type { ResourceRow } from "../store/records.js";
import type { Attachment } from "../types/index.js";

export interface SandboxEmail {
  id: string;
  provider_id: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  reply_to: string | null;
  subject: string;
  html: string | null;
  text_body: string | null;
  attachments: Attachment[];
  headers: Record<string, string>;
  created_at: string;
}

export type SandboxEmailSummary = Omit<SandboxEmail, "html" | "text_body" | "headers">;

export interface StoreSandboxEmailInput {
  provider_id: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  reply_to: string | null;
  subject: string;
  html: string | null;
  text_body: string | null;
  attachments: Attachment[];
  headers: Record<string, string>;
}

/**
 * Pages one sandbox enumeration may fetch, at 500 rows a page — about 99,800 captured
 * emails (every page after the first re-requests the row it ended on, so it carries 499
 * fresh rows rather than 500).
 *
 * Deliberately far above the shared 40-page default, because every operation here needs the
 * WHOLE filtered set: a list has to sort before it windows, a clear has to know every row it
 * is about to delete before it deletes any of them, and a count is the size of the set.
 * Running out is reported — as a throw for the reads and the clear, as `null` for the count
 * — and never as a smaller answer.
 */
const MAX_SANDBOX_ROW_PAGES = 200;

/**
 * The refusal, thrown.
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

function rowId(row: ResourceRow): string | null {
  const value = row["id"];
  return typeof value === "string" && value !== "" ? value : null;
}

function rowLabel(row: ResourceRow): string {
  return rowId(row) ?? "(no id)";
}

/**
 * A column that must be PRESENT and NON-EMPTY.
 *
 * Used for `id` and `created_at`. Both are `NOT NULL` in both schemas and projected by both
 * read paths, so an absent one means the store answered with a row that is not a captured
 * email. Emptiness is rejected as well, which `NOT NULL` does not cover and which is
 * therefore deliberate: a row with no id cannot be fetched or deleted, and a row with no
 * `created_at` cannot be placed in the only order this family has — and `''` sorts before
 * every real instant, so it would land at the END of a newest-first listing and read as the
 * oldest capture rather than as an unreadable one.
 */
function requiredText(row: ResourceRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value === "") {
    throw new Error(
      `Sandbox email ${rowLabel(row)} has no readable ${column}; refusing to report it as a captured email`,
    );
  }
  return value;
}

/**
 * A column that must be PRESENT and may be EMPTY.
 *
 * `provider_id`, `from_address` and `subject` are `NOT NULL` in both schemas, and `subject`
 * carries a `DEFAULT ''` in the Postgres one — so emptiness is a VALUE here and absence is
 * not. A missing KEY means the store stopped projecting the column, and the deleted mappers
 * turned that into the same empty string, which would report every capture as having been
 * sent by nobody with no subject.
 */
function presentText(row: ResourceRow, column: string): string {
  if (!Object.hasOwn(row, column)) {
    throw new Error(
      `Sandbox email ${rowLabel(row)} has no ${column} column at all; refusing to report it as a captured email`,
    );
  }
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(
      `Sandbox email ${rowLabel(row)} has a non-text ${column} (${typeof value}); `
        + "refusing to report it as a captured email",
    );
  }
  return value;
}

/**
 * A nullable column that must still be PRESENT.
 *
 * `reply_to`, `html` and `text_body` are the three columns both schemas allow to be NULL.
 * Null is a value and survives; a missing key is a store that stopped projecting the column,
 * which would report every captured email as having no body at all.
 */
function nullableText(row: ResourceRow, column: string): string | null {
  if (!Object.hasOwn(row, column)) {
    throw new Error(
      `Sandbox email ${rowLabel(row)} has no ${column} column at all; `
        + "refusing to report it as a captured email with none",
    );
  }
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(
      `Sandbox email ${rowLabel(row)} has a non-text ${column} (${typeof value}); `
        + "refusing to report it as a captured email",
    );
  }
  return value;
}

/**
 * A column holding a JSON array, in whichever of the two shapes a store hands it back — and
 * a FAULT for anything else.
 *
 * Divergence 7. `to_addresses` / `cc_addresses` / `bcc_addresses` are `TEXT` holding a JSON
 * array in SQLite and `JSONB` in Postgres, so both an array and a JSON-encoded string are
 * legitimate. What is NOT legitimate is answering for content that parses to neither: the two
 * deleted helpers answered `[]` and `[<the raw text>]` respectively, dropping every recipient
 * or inventing one.
 */
function jsonArray(row: ResourceRow, column: string): unknown[] {
  if (!Object.hasOwn(row, column)) {
    throw new Error(
      `Sandbox email ${rowLabel(row)} has no ${column} column at all; refusing to report it as empty`,
    );
  }
  const value = row[column];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(
        `Sandbox email ${rowLabel(row)} has an unreadable ${column} (not JSON); `
          + "refusing to report it as empty or as one entry",
      );
    }
    if (Array.isArray(parsed)) return parsed;
  }
  throw new Error(
    `Sandbox email ${rowLabel(row)} has a ${column} that is not a list; refusing to report it as empty`,
  );
}

/** The three address columns, whose entries must every one be text. */
function addressList(row: ResourceRow, column: string): string[] {
  const entries = jsonArray(row, column);
  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw new Error(
        `Sandbox email ${rowLabel(row)} has a non-text entry in ${column} (${typeof entry}); `
          + "refusing to report it as a recipient",
      );
    }
  }
  return entries as string[];
}

/**
 * The header map, in whichever of the two shapes a store hands it back.
 *
 * `headers_json` is `TEXT` in BOTH schemas — the Postgres spec says so in writing, because
 * the client sends it pre-serialized and declaring it a JSON column would double-encode it
 * into a string scalar. An object is still accepted, because a drifted operator table could
 * hold one, and because accepting the shape the value already has costs nothing.
 */
function headerMap(row: ResourceRow): Record<string, string> {
  const column = "headers_json";
  if (!Object.hasOwn(row, column)) {
    throw new Error(`Sandbox email ${rowLabel(row)} has no ${column} column at all; refusing to report no headers`);
  }
  const value = row[column];
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(
        `Sandbox email ${rowLabel(row)} has an unreadable ${column} (not JSON); refusing to report no headers`,
      );
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Sandbox email ${rowLabel(row)} has a ${column} that is not a map; refusing to report no headers`);
  }
  return parsed as Record<string, string>;
}

/**
 * A stored row, mapped to `SandboxEmail`.
 *
 * `attachments` keeps the unchecked cast both arms used. Every OTHER field is validated, so
 * this one is a deliberate exception rather than an oversight: `Attachment` is a structural
 * shape with optional members that neither store validates on the way in either, and turning
 * a capture with an odd attachment record into an unreadable row would lose the message body
 * as well. The list itself must parse (`jsonArray`); its entries are taken as given.
 */
function toSandboxEmail(row: ResourceRow): SandboxEmail {
  return {
    id: requiredText(row, "id"),
    provider_id: presentText(row, "provider_id"),
    from_address: presentText(row, "from_address"),
    to_addresses: addressList(row, "to_addresses"),
    cc_addresses: addressList(row, "cc_addresses"),
    bcc_addresses: addressList(row, "bcc_addresses"),
    reply_to: nullableText(row, "reply_to"),
    subject: presentText(row, "subject"),
    html: nullableText(row, "html"),
    text_body: nullableText(row, "text_body"),
    attachments: jsonArray(row, "attachments_json") as Attachment[],
    headers: headerMap(row),
    created_at: requiredText(row, "created_at"),
  };
}

/** The summary shape: the full row minus the two bodies and the header map. */
function toSummary(email: SandboxEmail): SandboxEmailSummary {
  const { html: _html, text_body: _text, headers: _headers, ...summary } = email;
  return summary;
}

/**
 * Code-unit order, not `localeCompare`.
 *
 * Divergence 4: the SQLite arm sorted under that engine's BINARY collation and the HTTP arm
 * under the process locale, and only one of those gives the same page boundaries on every
 * machine. BINARY is `memcmp` over UTF-8 and this is UTF-16 code units; the two disagree only
 * where a supplementary-plane character meets a BMP character in `U+E000`-`U+FFFF`, and
 * neither an ISO timestamp nor a uuid can contain either.
 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Newest first, with the identity as the tiebreaker (divergences 2 and 3). */
function byNewest(a: SandboxEmail, b: SandboxEmail): number {
  return compareText(b.created_at, a.created_at) || compareText(b.id, a.id);
}

/**
 * The store this call should use: the injected one, or the configured one.
 *
 * Built per call rather than at module load, because a contradictory storage configuration is
 * a boot error raised by the resolution and it belongs to the call that needed a store, not to
 * whoever imported this module first.
 */
function storeFor(store: EmailStore | undefined): EmailStore {
  return store ?? createConfiguredEmailStore();
}

/**
 * The provider filter, pushed down.
 *
 * `provider_id` is a declared filter on BOTH stores — it is a column of the SQLite table, and
 * `/v1/sandbox-emails` publishes it as a query parameter — so the API store accepts it rather
 * than refusing (it refuses a filter the route does not declare instead of answering with the
 * unfiltered list). Pushing it down is what keeps a per-provider read inside the page budget.
 *
 * A FALSY provider id means no filter, which is what both deleted arms did. See the header.
 */
function providerFilter(providerId: string | undefined): Record<string, string> | undefined {
  return providerId ? { provider_id: providerId } : undefined;
}

/** What one enumeration of the filtered set established. */
interface SandboxScan {
  rows: ResourceRow[];
  /** true => an empty page was reached AND the window never moved, so `rows` is the whole set. */
  complete: boolean;
  /** Why it is not complete, in a form a person can act on. Empty when it is. */
  incompleteBecause: string;
}

/**
 * Read every stored row matching the provider filter, or explain why not.
 *
 * PAGED TO AN EMPTY PAGE, never to a short one: every list route CLAMPS `limit`, so a clamped
 * page is byte-for-byte indistinguishable from the last page of a small table. A refusal or a
 * fault THROWS here — those mean nothing was read, and no caller can do anything useful with
 * that. An incomplete read is returned as a fact for the caller to decide about, because the
 * three callers want different things from it: the reads and the clear refuse, and the count
 * answers `null`.
 *
 * THE FILTER IS RE-ASSERTED ON WHAT COMES BACK. A store or fixture that accepts an equality
 * filter and then does not apply it answers with the unfiltered list — a superset presented as
 * a filtered result, which is a wrong answer rather than a value. No type can rule that out,
 * and here it would be actively dangerous: `clearSandboxEmails` deletes what this returns.
 */
async function scanSandbox(store: EmailStore, what: string, providerId: string | undefined): Promise<SandboxScan> {
  const filters = providerFilter(providerId);
  const enumeration = await enumerateStoreRows<ResourceRow>(
    (opts) => store.sandbox.list({ ...opts, ...(filters ? { filters } : {}) }),
    { pageBudget: MAX_SANDBOX_ROW_PAGES, idOf: rowId },
  );

  if (enumeration.refusal !== null) throw storeRefusal(what, enumeration.refusal);
  if (enumeration.fault !== null) {
    throw new Error(`This installation's store faulted while it tried to ${what}: ${enumeration.fault}`);
  }

  for (const row of enumeration.rows) {
    if (providerId && row["provider_id"] !== providerId) {
      throw new Error(
        "This installation's store answered a filtered sandbox read with rows for another provider "
          + `(asked for ${providerId}, got ${String(row["provider_id"])}); refusing to treat them as the `
          + "requested captures",
      );
    }
  }

  // Name whichever evidence fired. A row deleted above the cursor slides every unread row down
  // one offset and is never seen again WITHOUT producing a duplicate, so `duplicates` alone is
  // not the whole story.
  const incompleteBecause = enumeration.complete
    ? ""
    : enumeration.exhausted
      ? `the ${enumeration.pages}-page enumeration budget ran out before the end of the table`
      : enumeration.duplicates > 0
        ? `${enumeration.duplicates} row(s) came back twice across ${enumeration.pages} page(s), so at least `
          + "that many rows were never seen"
        : `a page did not begin on the row the previous page ended on across ${enumeration.pages} page(s), `
          + "so rows were skipped";

  return { rows: enumeration.rows, complete: enumeration.complete, incompleteBecause };
}

/** The requested window of an already-ordered list, with both arms' clamping. */
function windowOf<T>(rows: T[], limit: number, offset: number): T[] {
  const normalizedLimit = safeLimit(limit);
  const start = safeOffset(offset);
  return rows.slice(start, start + normalizedLimit);
}

/** Every captured email the filter admits, newest first — or a throw naming why not. */
async function readSandbox(
  store: EmailStore,
  what: string,
  providerId: string | undefined,
): Promise<SandboxEmail[]> {
  const scan = await scanSandbox(store, what, providerId);
  if (!scan.complete) {
    throw new Error(
      `Refusing to ${what}: ${scan.incompleteBecause}, so the ${scan.rows.length} row(s) read are a LOWER `
        + "BOUND rather than the captured emails. Rows past the boundary could sort anywhere within the "
        + "listing, so a window cannot be cut from a partial read. Narrow it with a provider filter.",
    );
  }
  return scan.rows.map(toSandboxEmail).sort(byNewest);
}

function echoedWrong(id: string, column: string): Error {
  return new Error(
    `This installation's store captured sandbox email ${id} but answered with a different ${column}; `
      + "refusing to report the capture as written",
  );
}

/**
 * Capture one outbound email.
 *
 * `id` is NOT sent (divergence 5) and `created_at` IS (divergence 6). The three address
 * columns are sent as arrays and the two `_json` columns pre-serialized, which is what BOTH
 * schemas expect: the Postgres spec marks the address columns as JSON and leaves
 * `attachments_json` / `headers_json` as TEXT precisely so the client's JSON string round
 * trips verbatim, and the SQLite store JSON-encodes any non-scalar it is handed.
 */
export async function storeSandboxEmail(
  input: StoreSandboxEmailInput,
  store?: EmailStore,
): Promise<SandboxEmail> {
  const created = await storeFor(store).sandbox.create({
    provider_id: input.provider_id,
    from_address: input.from_address,
    to_addresses: input.to_addresses,
    cc_addresses: input.cc_addresses,
    bcc_addresses: input.bcc_addresses,
    reply_to: input.reply_to,
    subject: input.subject,
    html: input.html,
    text_body: input.text_body,
    attachments_json: JSON.stringify(input.attachments),
    headers_json: JSON.stringify(input.headers),
    created_at: now(),
  });
  if (!created.ok) throw storeRefusal("capture a sandbox email", created);
  const email = toSandboxEmail(created.value);
  // THE WRITE IS COMPARED WITH WHAT CAME BACK, field by field, and the redundancy is the
  // point: the generic write path is the one place in this system where a field can be
  // ACCEPTED AND DROPPED (the service's generic route ignores a body key it has no column
  // for), and a capture that lost its recipients would look exactly like a capture that had
  // none. Each field is checked separately rather than as one condition, because a single
  // fixture that differs in several fields kills the whole condition while leaving every
  // individual term deletable.
  if (email.provider_id !== input.provider_id) throw echoedWrong(email.id, "provider_id");
  if (email.from_address !== input.from_address) throw echoedWrong(email.id, "from_address");
  if (email.subject !== input.subject) throw echoedWrong(email.id, "subject");
  if (email.to_addresses.join("\n") !== input.to_addresses.join("\n")) {
    throw echoedWrong(email.id, "to_addresses");
  }
  return email;
}

/**
 * Captured emails, newest first, windowed.
 *
 * The whole filtered set is read before the window is cut — see divergence 2 for why a
 * pushed-down `limit`/`offset` would be silently wrong against one of the two stores.
 */
export async function listSandboxEmails(
  providerId?: string,
  limit = 50,
  offset = 0,
  store?: EmailStore,
): Promise<SandboxEmail[]> {
  const rows = await readSandbox(storeFor(store), "list captured sandbox emails", providerId);
  return windowOf(rows, limit, offset);
}

/** The same listing without the two bodies and the header map. */
export async function listSandboxEmailSummaries(
  providerId?: string,
  limit = 50,
  offset = 0,
  store?: EmailStore,
): Promise<SandboxEmailSummary[]> {
  const rows = await readSandbox(storeFor(store), "list captured sandbox emails", providerId);
  return windowOf(rows, limit, offset).map(toSummary);
}

/**
 * One captured email, or null.
 *
 * A BLANK ID IS ABSENCE AND IS ANSWERED WITHOUT TOUCHING THE STORE. The SQLite arm answered
 * null (no row has an empty id); the HTTP path would build `GET /v1/sandbox-emails/`, whose
 * trailing slash the service strips before dispatching — which lands on the LIST route and
 * hands back an envelope this mapper would fault on. Null is the stronger arm's answer and is
 * the one kept. The CLI's own id resolution rejects a blank id upstream, so this is defence
 * for a direct caller of the library.
 */
export async function getSandboxEmail(id: string, store?: EmailStore): Promise<SandboxEmail | null> {
  if (!id) return null;
  const found = await storeFor(store).sandbox.get(id);
  if (!found.ok) throw storeRefusal("read a captured sandbox email", found);
  return found.value === null ? null : toSandboxEmail(found.value);
}

/**
 * Delete captured emails — every one, or every one of a provider's.
 *
 * READ IN FULL FIRST, THEN DELETE. The seam has no bulk delete, so this is one `remove` per
 * row; reading the whole set before deleting anything means a truncated enumeration refuses
 * with NOTHING deleted, rather than clearing an arbitrary prefix and reporting it as the
 * total. A removal that refuses or faults part way through throws naming how many rows are
 * already gone — a partial delete reported as a clean number is worse than an error.
 *
 * THE PROVIDER IS CHECKED AGAIN ON EVERY ROW, immediately before its removal, and it is
 * UNREACHABLE BY CONSTRUCTION TODAY: the scan has already re-asserted the same filter over the
 * same array and thrown, so no store can get a foreign row this far. It survives mutation for
 * that reason, which is measured rather than assumed, and it is named here so nobody mistakes
 * it for a branch some test covers. It stays because this is the one operation in the family
 * that destroys data, the filter is the only thing scoping it, the check costs one comparison
 * per row, and the invariant it depends on lives in a different function that a later edit
 * could weaken without touching this one.
 *
 * The count is the number of rows the store said it actually removed. A row that vanished
 * between the read and the delete answers `false` and is NOT counted, which is what the
 * SQLite arm's `changes` did too.
 */
export async function clearSandboxEmails(providerId?: string, store?: EmailStore): Promise<number> {
  const handle = storeFor(store);
  const what = "clear captured sandbox emails";
  const scan = await scanSandbox(handle, what, providerId);
  if (!scan.complete) {
    throw new Error(
      `Refusing to ${what}: ${scan.incompleteBecause}, so the ${scan.rows.length} row(s) read are a LOWER `
        + "BOUND rather than the captured emails. NOTHING HAS BEEN DELETED; deleting part of a set and "
        + "reporting the number as the total is the failure this refuses to commit.",
    );
  }

  let deleted = 0;
  for (const row of scan.rows) {
    if (providerId && row["provider_id"] !== providerId) {
      throw new Error(
        `Refusing to delete sandbox email ${rowLabel(row)}: it belongs to provider `
          + `${String(row["provider_id"])} and this call is scoped to ${providerId}. `
          + `${deleted} row(s) were already deleted.`,
      );
    }
    // Deliberately NOT mapped: a corrupt row must stay deletable. Reading it as a captured
    // email here would make an unreadable recipient list (divergence 7) permanently
    // un-clearable — the trap `src/db/aliases.ts` fell into for a row its own writer had
    // committed and its own reader then refused.
    const id = requiredText(row, "id");
    const removed = await handle.sandbox.remove(id);
    if (!removed.ok) {
      throw new Error(
        `${storeRefusal(what, removed).message} — ${deleted} row(s) were already deleted before this one`,
      );
    }
    if (removed.value) deleted += 1;
  }
  return deleted;
}

/**
 * How many captured emails there are — or `null` when that cannot be established.
 *
 * Divergence 8. `null` means "the enumeration did not reach the end of the table, so any
 * number here would be a lower bound rather than a count". It is never `0` and never the
 * rows that were seen. A store REFUSAL or a FAULT throws instead: those mean nothing was
 * read, and returning `null` for them would blur "I could not finish counting" into "I never
 * started", which are different things for a caller to report.
 *
 * The rows are NOT mapped. `COUNT(*)` counted corrupt rows too, and turning a count into an
 * error because one capture has an unreadable header map would be a new failure mode.
 */
export async function getSandboxCount(providerId?: string, store?: EmailStore): Promise<number | null> {
  const scan = await scanSandbox(storeFor(store), "count captured sandbox emails", providerId);
  return scan.complete ? scan.rows.length : null;
}
