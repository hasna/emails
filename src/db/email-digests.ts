// Persisted inbox-digest ROWS. One implementation, reaching storage through the store
// seam.
//
// WHAT THIS FILE USED TO BE. A 28-line facade whose dispatch helper read the
// process-wide deployment word and handed each of SIX exports to one of two sibling
// modules — `email-digests.local.ts` (202 lines, SQLite) and `email-digests.remote.ts`
// (186 lines, the curl bridge). Neither arm decided anything about what a digest row
// MEANS; they decided who ran the SQL.
//
// TWO OF THE SIX ROUTED EXPORTS WERE PURE. `normalizeEmailDigestPeriod` and
// `emailDigestPeriodLabel` touch no storage and were byte-for-byte identical in both
// arms, so the deployment word decided nothing about them except that a period parser
// and a four-entry label table existed twice and were free to drift. They are one copy
// again, and they stay SYNCHRONOUS — `src/cli/tui-solid/component/dialogs.tsx` calls the
// label inside a render and `src/lib/email-digest.ts` calls the parser inline.
//
// THE OTHER FOUR ARE ASYNCHRONOUS NOW, and that is forced rather than chosen. Every
// operation on the seam returns `Promise<Outcome<T>>` (docs/PLAN-MODE-REMOVAL.md §4.2),
// because the only reason the deleted HTTP arm could be synchronous at all was that it
// shelled out to `curl` through `spawnSync` to fake a blocking network call. That bridge
// dies with the axis. `src/server/routes/inbound-sequences.ts` — the one production
// caller of any of the four — already `await`s inside the handler that reads them.
//
// WHY THE ARMS DID NOT AGREE, in the three places it mattered:
//
//   1. `getLatestEmailDigest` — SQLite: `ORDER BY completed_at DESC LIMIT 1`, exact.
//      The HTTP arm: one `list({ limit: 1000 })` call, then filter and sort in memory.
//      The service CLAMPS a page to 500, so on an installation with more than 500 digest
//      rows that arm served the newest of an arbitrary 500 as "the newest", with nothing
//      in the answer to say so.
//   2. `listEmailDigests` — the same clamp, with the same silence, applied to a paged
//      list whose contract is "newest first".
//   3. The four JSON columns — the HTTP arm handed the service PRE-SERIALIZED JSON
//      strings. The service's generic writer JSON-encodes a `json: true` column itself
//      and binds it with a `::jsonb` cast (`src/server/self-hosted/store.ts`,
//      `encodeColumn` and `createResource`), so those four columns landed in Postgres as
//      jsonb STRING SCALARS rather than as an array and an object. They round-tripped
//      back through that arm's own parser by luck; nothing else could read them as JSON.
//      This implementation passes the raw array and the raw object, which is what both
//      stores want.
//
// WHAT REPLACES THE ARM CHOICE is the store's own answer. Nothing here asks which store
// it holds — no branch on the store kind, on the descriptor, or on the resolution plan.
// `src/store/` is untouched by this change.
//
// TWO THINGS THE SEAM DOES NOT OFFER, and what is done about each:
//
//   * NO ORDERING CONTRACT. `ResourceRepository.list` promises no order, and the two
//     implementations genuinely disagree: the SQLite resource path orders these rows by
//     `created_at DESC, id DESC` (`src/store-sqlite/resources.ts`, `describeTable` —
//     SQLite's `email_digests` has no `updated_at`) and the service orders them by
//     `completed_at DESC` (`src/server/self-hosted/resources.ts`, the `email-digests`
//     spec — its table DOES have `updated_at`). So "newest" and "newest first" are
//     decided HERE, on `completed_at`, with `id` as the tiebreaker. That is what the
//     deleted arms' `ORDER BY completed_at DESC` meant, plus a tiebreaker they did not
//     have: `completed_at` is not unique, and two rows sharing one made the deleted
//     SQL's page boundary arbitrary.
//   * NO AGGREGATE AND NO SERVER-SIDE ORDER means a "newest first, limit/offset" read
//     cannot be pushed down. The filtered set is enumerated to an EMPTY page, sorted
//     here, and then sliced. A SHORT page is never read as the end of the table
//     (`src/lib/status-facts-enumeration.ts` states why at length), and an enumeration
//     that could not be finished THROWS rather than serving a slice of what it managed
//     to read — a slice of a partial set is not "the newest N", it is a wrong answer
//     wearing the right shape.
//
// A REFUSAL IS NEVER AN ANSWER. Every operation below turns a typed store refusal into a
// thrown error naming the operation and carrying the store's own code, status and
// message. None of them answers `[]`, `0` or `null` for a read that did not happen: for
// `getLatestEmailDigest` in particular, `null` means "no digest has been generated for
// this period", and `src/lib/email-digest.ts` acts on that by GENERATING one — so
// answering `null` because the store could not be read would silently replace a digest
// nobody was able to see.
//
// THE ENUM VALUES ARE VALIDATED ON THE WAY IN, which is new and is a divergence being
// CLOSED rather than one being introduced. SQLite's `email_digests` carries
// `CHECK` constraints on `period`, `provider` and `status` (`src/db/database.ts`); the
// self-hosted Postgres migration DROPS all three
// (`src/server/self-hosted/migrations.ts`). So an out-of-enum value was refused by one
// store and accepted by the other — and both deleted arms' read mappers then threw on
// the row they had just successfully written, leaving a table row no reader could
// return. Validating here makes both stores answer the same way, and makes the answer
// the one that does not corrupt the table.

import { now } from "./runtime.js";
import { cappedLimit, safeOffset } from "./pagination.js";
import { parseJsonArray, parseJsonObject } from "./json.js";
import { enumerateStoreRows } from "../lib/status-facts-enumeration.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Refusal } from "../store/outcome.js";
import type { ResourceRow } from "../store/records.js";

export type EmailDigestPeriod = "today" | "yesterday" | "last7" | "month";
export type EmailDigestStatus = "ok" | "error";
export type EmailDigestProvider = "local" | "external";

export interface EmailDigest {
  id: string;
  period: EmailDigestPeriod;
  since: string;
  until: string;
  provider: EmailDigestProvider;
  model: string;
  status: EmailDigestStatus;
  message_count: number;
  summary: string | null;
  highlights: string[];
  action_items: string[];
  important_email_ids: string[];
  label_counts: Record<string, number>;
  error: string | null;
  started_at: string;
  completed_at: string;
  created_at: string;
}

export interface SaveEmailDigestInput {
  period: EmailDigestPeriod;
  since: string;
  until: string;
  provider: EmailDigestProvider;
  model: string;
  status: EmailDigestStatus;
  message_count: number;
  summary?: string | null;
  highlights?: string[];
  action_items?: string[];
  important_email_ids?: string[];
  label_counts?: Record<string, number>;
  error?: string | null;
  started_at?: string;
  completed_at?: string;
}

export interface ListEmailDigestsOptions {
  period?: EmailDigestPeriod;
  status?: EmailDigestStatus;
  limit?: number;
  offset?: number;
}

const MAX_DIGEST_LIST_LIMIT = 200;
const PERIODS = new Set<EmailDigestPeriod>(["today", "yesterday", "last7", "month"]);
const STATUSES = new Set<EmailDigestStatus>(["ok", "error"]);
const PROVIDERS = new Set<EmailDigestProvider>(["local", "external"]);

/**
 * Pages one digest enumeration may fetch, at 500 rows a page — 100_000 rows.
 *
 * Deliberately far above the shared default (40 pages) because BOTH of the reads below
 * need the whole filtered set to answer correctly, and running out is an exception rather
 * than a smaller answer. The table gains one row per digest generation: four periods
 * generated daily is ~1_460 rows a year, so this bound is decades of history before it
 * binds, and when it does bind the error names the page count instead of quietly serving
 * a prefix.
 */
const MAX_DIGEST_ROW_PAGES = 200;

export function normalizeEmailDigestPeriod(value: string | undefined): EmailDigestPeriod {
  const normalized = (value ?? "today").trim().toLowerCase().replace(/[_\s-]+/g, "");
  const aliases: Record<string, EmailDigestPeriod> = {
    today: "today",
    yesterday: "yesterday",
    last7: "last7",
    lastseven: "last7",
    last7days: "last7",
    week: "last7",
    month: "month",
    thismonth: "month",
  };
  const period = aliases[normalized];
  if (!period || !PERIODS.has(period)) {
    throw new Error("Digest period must be today, yesterday, last7, or month.");
  }
  return period;
}

export function emailDigestPeriodLabel(period: EmailDigestPeriod): string {
  return {
    today: "Today",
    yesterday: "Yesterday",
    last7: "Last 7 Days",
    month: "This Month",
  }[period];
}

function normalizeStringArray(values: string[] | undefined, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of values ?? []) {
    const value = String(item ?? "").replace(/\s+/g, " ").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value.slice(0, 500));
    if (out.length >= max) break;
  }
  return out;
}

function normalizeLabelCounts(value: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    const label = key.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 64);
    const count = Number(raw);
    if (!label || !Number.isFinite(count) || count <= 0) continue;
    out[label] = Math.trunc(count);
  }
  return out;
}

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

function rowText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function rowTextOrNull(value: unknown): string | null {
  const text = rowText(value);
  return text ? text : null;
}

/**
 * A JSON array column, in whichever of the two shapes a store hands it back.
 *
 * SQLite holds these columns as TEXT and returns the JSON string verbatim; the service
 * holds them as jsonb and returns a native array. Both are accepted rather than one being
 * assumed — and accepting both is also what lets a row written by the DELETED HTTP arm,
 * which stored a jsonb string scalar, still be read.
 */
function rowArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  return parseJsonArray<unknown>(typeof value === "string" ? value : null).map((item) => String(item));
}

/** A JSON object column, in whichever of the two shapes a store hands it back. */
function rowCounts(value: unknown): Record<string, number> {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : parseJsonObject<Record<string, unknown>>(typeof value === "string" ? value : null);
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(source)) {
    const count = Number(raw);
    if (Number.isFinite(count)) out[key] = count;
  }
  return out;
}

/**
 * A stored row, mapped to `EmailDigest`.
 *
 * ALL THREE ENUM COLUMNS ARE VALIDATED AND NOT CAST. Both deleted arms validated `period`
 * and `status` this way — a digest whose period cannot be read is corrupt stored data, a
 * fault rather than a value, and returning it under a lying type pushes the corruption into
 * every caller. `provider` is now validated with them, which is a tightening, and the reason
 * is the same asymmetry the writer guards against: only ONE of the two stores constrains that
 * column, so the value really can be something the type does not admit — and both deleted
 * mappers answered such a row with a `provider` the row does not hold. That value is not
 * internal; `src/cli/tui-solid/component/dialogs.tsx` prints it next to the digest. A
 * plausible wrong answer on a user-visible field is worse than a fault.
 *
 * `message_count` IS REQUIRED TO BE A NUMBER rather than defaulted. It is `NOT NULL` in both
 * schemas and projected by both read paths, so an absent or unreadable value means the store
 * answered with something that is not a digest row — and "0 messages" is the single most
 * misleading thing this mapper could say about a digest whose count it could not read.
 */
function toEmailDigest(row: ResourceRow): EmailDigest {
  const period = rowText(row["period"]) as EmailDigestPeriod;
  if (!PERIODS.has(period)) throw new Error(`Invalid digest period in database: ${rowText(row["period"])}`);
  const status = rowText(row["status"]) as EmailDigestStatus;
  if (!STATUSES.has(status)) throw new Error(`Invalid digest status in database: ${rowText(row["status"])}`);
  const provider = rowText(row["provider"]) as EmailDigestProvider;
  if (!PROVIDERS.has(provider)) throw new Error(`Invalid digest provider in database: ${rowText(row["provider"])}`);
  const count = Number(row["message_count"]);
  if (row["message_count"] === null || row["message_count"] === undefined || !Number.isFinite(count)) {
    throw new Error(
      `Digest row ${rowText(row["id"]) || "(no id)"} has no readable message_count; `
        + "refusing to report it as a digest of zero messages",
    );
  }
  return {
    id: rowText(row["id"]),
    period,
    since: rowText(row["since"]),
    until: rowText(row["until"]),
    provider,
    model: rowText(row["model"]),
    status,
    message_count: count,
    summary: rowTextOrNull(row["summary"]),
    highlights: rowArray(row["highlights"] ?? row["highlights_json"]),
    action_items: rowArray(row["action_items"] ?? row["action_items_json"]),
    important_email_ids: rowArray(row["important_email_ids"] ?? row["important_email_ids_json"]),
    label_counts: rowCounts(row["label_counts"] ?? row["label_counts_json"]),
    error: rowTextOrNull(row["error"]),
    started_at: rowText(row["started_at"]),
    completed_at: rowText(row["completed_at"]),
    created_at: rowText(row["created_at"]),
  };
}

/**
 * Newest first, on `completed_at`, with `id` as the tiebreaker.
 *
 * The tiebreaker is not decoration. `completed_at` is a plain timestamp string with no
 * uniqueness constraint on either store, and two digests generated inside the same
 * millisecond share one — at which point the deleted SQL's `LIMIT`/`OFFSET` page boundary
 * was arbitrary and could repeat or drop a row between two pages of the same list.
 */
function newestFirst(a: EmailDigest, b: EmailDigest): number {
  const byCompleted = b.completed_at.localeCompare(a.completed_at);
  return byCompleted !== 0 ? byCompleted : b.id.localeCompare(a.id);
}

/**
 * Read every stored digest row matching `filters`, or explain why not.
 *
 * PAGED TO AN EMPTY PAGE, never to a short one, and a scan that did not finish throws.
 * Both callers need the WHOLE filtered set — one to pick a maximum, one to sort and
 * slice — so a partial read cannot answer either question. See
 * `src/lib/status-facts-enumeration.ts` for why "shorter than I asked for" proves
 * nothing about the end of a table.
 *
 * THE FILTER IS RE-ASSERTED ON WHAT COMES BACK. The service's generic list route IGNORES
 * a query parameter it does not declare and answers with the unfiltered list — a superset
 * presented as a filtered result. That is a wrong result, not a value, so it is treated
 * as a fault. (The HTTP store already refuses an undeclared filter up front by reading
 * the published contract; this catches a store that accepts the filter and then does not
 * apply it, which no type can rule out.)
 */
async function readDigestRows(
  store: EmailStore,
  what: string,
  filters: Record<string, string>,
  matches: (digest: EmailDigest) => boolean,
): Promise<EmailDigest[]> {
  const enumeration = await enumerateStoreRows<ResourceRow>(
    (opts) => store.emailDigests.list({
      ...opts,
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
    }),
    {
      pageBudget: MAX_DIGEST_ROW_PAGES,
      idOf: (row) => (typeof row["id"] === "string" ? row["id"] : null),
    },
  );
  if (enumeration.refusal) throw storeRefusal(what, enumeration.refusal);
  if (enumeration.fault !== null) {
    throw new Error(`This installation's store faulted while it ${what}: ${enumeration.fault}`);
  }
  if (!enumeration.complete) {
    throw new Error(
      `This installation's stored digests could not be read to the end (pages: ${enumeration.pages}, `
        + `duplicates: ${enumeration.duplicates}, shifted: ${enumeration.shifted}), so the newest of them `
        + "cannot be established; refusing to answer from part of the table",
    );
  }
  const digests = enumeration.rows.map(toEmailDigest);
  for (const digest of digests) {
    if (!matches(digest)) {
      throw new Error(
        "This installation's store answered a filtered digest read with rows outside the filter; "
          + "refusing to treat them as the requested digests",
      );
    }
  }
  return digests.sort(newestFirst);
}

/**
 * Store one digest row and hand back the STORE'S OWN copy of it.
 *
 * NEITHER `id` NOR `created_at` IS SENT, and both of those are deliberate:
 *
 *   * `id` is minted by the store. The service mints its own for this resource and does
 *     not accept one in the body (`createResource`, `spec.idColumn === undefined`), so the
 *     deleted HTTP arm's client-side uuid was already being discarded and its returned row
 *     already carried the server's. `/v1`'s published request schema is
 *     `additionalProperties: false` over the fifteen declared columns
 *     (`src/server/self-hosted/openapi.ts`), so naming `id` here would make the HTTP store
 *     REFUSE the write outright rather than have it accepted and dropped.
 *   * `created_at` is likewise not a declared column, so the store stamps it with its own
 *     clock. Both deleted arms set it equal to `completed_at`. The two now differ when a
 *     caller supplies a BACKDATED `completed_at`: `created_at` becomes the moment the row
 *     was written, which is what the name says. Nothing orders on it here — this module
 *     orders on `completed_at` — but a caller that read `created_at` as a synonym for
 *     `completed_at` will now see the difference.
 *
 * THE FOUR JSON COLUMNS ARE SENT RAW, as an array and an object, not pre-serialized. See
 * the header: pre-serializing them is what put jsonb string scalars in the service's
 * table.
 *
 * THE RETURNED ROW IS CHECKED against what was written. The service's generic route
 * ACCEPTS a body key the resource has no column for and drops it silently; both stores
 * refuse an unknown column today, and this check is what notices if one ever stops.
 */
async function writeDigestRow(store: EmailStore, input: SaveEmailDigestInput): Promise<EmailDigest> {
  const startedAt = input.started_at ?? now();
  const completedAt = input.completed_at ?? now();
  const messageCount = Math.max(0, Math.trunc(input.message_count));
  const created = await store.emailDigests.create({
    period: input.period,
    since: input.since,
    until: input.until,
    provider: input.provider,
    model: input.model,
    status: input.status,
    message_count: messageCount,
    summary: input.summary ?? null,
    highlights_json: normalizeStringArray(input.highlights, 12),
    action_items_json: normalizeStringArray(input.action_items, 12),
    important_email_ids_json: normalizeStringArray(input.important_email_ids, 30),
    label_counts_json: normalizeLabelCounts(input.label_counts),
    error: input.error ?? null,
    started_at: startedAt,
    completed_at: completedAt,
  });
  if (!created.ok) throw storeRefusal("store a digest row", created);
  const digest = toEmailDigest(created.value);
  if (
    !digest.id
    || digest.period !== input.period
    || digest.status !== input.status
    || digest.since !== input.since
    || digest.until !== input.until
    || digest.message_count !== messageCount
  ) {
    throw new Error(
      "This installation's store accepted a digest write and answered with a different row; "
        + "refusing to report the digest as saved",
    );
  }
  return digest;
}

/**
 * Reject an out-of-enum `period`, `provider` or `status` before anything is written.
 *
 * See the header: only ONE of the two stores constrains these columns, so without this
 * the same input is a refusal on SQLite and an accepted row on the service — and the
 * accepted row is then unreadable, because every mapper in this family validates the enum
 * on the way out. Refusing the write is the only answer that leaves the table readable.
 */
function assertWritableDigest(input: SaveEmailDigestInput): void {
  if (!PERIODS.has(input.period)) {
    throw new Error("Digest period must be today, yesterday, last7, or month.");
  }
  if (!PROVIDERS.has(input.provider)) {
    throw new Error("Digest provider must be local or external.");
  }
  if (!STATUSES.has(input.status)) {
    throw new Error("Digest status must be ok or error.");
  }
  // A NON-NUMERIC COUNT IS REFUSED HERE RATHER THAN CLAMPED. Both deleted arms wrote
  // `Math.max(0, Math.trunc(count))` straight through, and `Math.trunc(NaN)` is `NaN` — so a
  // caller handing in a non-number stored a row whose count no reader can return. The
  // negative-to-zero clamp is kept exactly; only the unreadable case is refused, and it is
  // refused BEFORE the write so the table is not left holding the row.
  if (!Number.isFinite(input.message_count)) {
    throw new Error("Digest message_count must be a finite number.");
  }
}

/**
 * Save a digest row.
 *
 * The second parameter is a TEST SEAM defaulting to the configured store, and it replaces
 * the `db?: Database` the deleted facade used to route on. The seam is asynchronous and
 * admits no SQLite handle in any signature, so a `Database` is no longer expressible here;
 * no production caller passed one.
 *
 * The store is built per call rather than at module load, because a contradictory storage
 * configuration is a boot error raised by the resolution and it belongs to the call that
 * needed a store, not to whoever imported this module first.
 */
export async function saveEmailDigest(input: SaveEmailDigestInput, store?: EmailStore): Promise<EmailDigest> {
  assertWritableDigest(input);
  return writeDigestRow(store ?? createConfiguredEmailStore(), input);
}

/**
 * One digest row by id, or `null` when no such row exists in scope.
 *
 * `null` here means the store looked and found nothing — a refusal throws instead, so
 * "there is no such digest" is never confused with "I could not look".
 */
export async function getEmailDigest(id: string, store?: EmailStore): Promise<EmailDigest | null> {
  const read = await (store ?? createConfiguredEmailStore()).emailDigests.get(id);
  if (!read.ok) throw storeRefusal("read a stored digest row", read);
  if (read.value === null) return null;
  const digest = toEmailDigest(read.value);
  // The id is re-asserted because a by-id read that answers with ANOTHER row is a wrong
  // result rather than a value, and a caller has no way to notice: it asked for one row
  // and got one row. Both stores match the key exactly today; this is what catches a
  // store that starts resolving an id PREFIX, which the message family's seam
  // deliberately does and which would be a silent identity change here.
  if (digest.id !== id) {
    throw new Error(
      "This installation's store answered a digest read by id with a different row; "
        + "refusing to report it as the requested digest",
    );
  }
  return digest;
}

/**
 * The newest stored `ok` digest for a period, or `null` when there genuinely is none.
 *
 * `null` IS ACTED ON: `loadEmailDigest` (`src/lib/email-digest.ts`) reads it as "no digest
 * has been generated for this period" and generates one. So a read that could not be
 * completed must throw rather than answer `null`, or a store hiccup silently overwrites a
 * digest nobody could see.
 *
 * The whole filtered set is read rather than the first row, because neither store's list
 * order can answer "newest" — see the header.
 */
export async function getLatestEmailDigest(
  period: EmailDigestPeriod,
  store?: EmailStore,
): Promise<EmailDigest | null> {
  const digests = await readDigestRows(
    store ?? createConfiguredEmailStore(),
    "read this installation's stored digests",
    { period, status: "ok" },
    (digest) => digest.period === period && digest.status === "ok",
  );
  return digests[0] ?? null;
}

/**
 * Stored digest rows, newest first, with the deleted arms' exact limit and offset clamps.
 *
 * `limit` defaults to 20 and is capped at 200; `offset` is clamped at zero. Both come from
 * the same helpers both arms used, so a caller's paging is unchanged.
 *
 * THE PAGE IS SLICED FROM A COMPLETE READ. There is no push-down available — the seam
 * publishes no ordering — so the filtered set is enumerated to the end, sorted here and
 * then sliced. `readDigestRows` throws when it cannot finish, and it must: a slice taken
 * from part of the table is not "the newest twenty", it is twenty rows presented as the
 * newest twenty, which is the failure this whole seam exists to stop.
 */
export async function listEmailDigests(
  opts: ListEmailDigestsOptions = {},
  store?: EmailStore,
): Promise<EmailDigest[]> {
  const filters: Record<string, string> = {};
  if (opts.period) filters["period"] = opts.period;
  if (opts.status) filters["status"] = opts.status;
  const digests = await readDigestRows(
    store ?? createConfiguredEmailStore(),
    "list this installation's stored digests",
    filters,
    (digest) => (
      (opts.period === undefined || digest.period === opts.period)
      && (opts.status === undefined || digest.status === opts.status)
    ),
  );
  const offset = safeOffset(opts.offset);
  return digests.slice(offset, offset + cappedLimit(opts.limit, 20, MAX_DIGEST_LIST_LIMIT));
}
