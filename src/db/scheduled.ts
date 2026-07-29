// The email schedule, as ONE implementation over the store seam.
//
// WHAT WAS HERE. A facade that read the process-wide deployment word (the predicate at
// src/db/self-hosted-store.ts, imported here until this commit) and handed each of eight
// operations to one of two sibling modules. Neither sibling disagreed about what
// "schedule this email", "cancel it" or "which rows are due" MEANS — they differed only
// in who ran the query — so both are deleted and this module is the only implementation,
// reading and writing through `EmailStore` (src/store/).
//
// THE ARMS DID NOT AGREE, and the disagreements are the interesting part of the
// collapse. Each is resolved toward the answer that cannot be silently wrong:
//
//  1. ORDER. Both arms promised `scheduled_at ASC`. Neither store on the seam does. The
//     SQLite store's generic resource list orders by the table's time column
//     (`created_at DESC, id DESC`, src/store-sqlite/resources.ts describeTable) and the
//     API's generic list orders `scheduled_at ASC`
//     (src/server/self-hosted/resources.ts) — the SAME family, ordered two different
//     ways, and `ListOptions` (src/store/records.ts) admits no ordering. So a read that
//     asked the store for `limit + offset` rows and sorted them locally would return the
//     first N rows of the STORE'S order re-sorted into ours: a plausible, silently WRONG
//     page against one of the two stores. Every list here therefore enumerates the whole
//     filtered set, sorts it, and windows locally — and REFUSES rather than return a
//     window it could not assemble. See `readSchedule`.
//  2. ORDER, again: the list arms ordered on `scheduled_at` ALONE, which is not a total
//     order — rows sharing a due instant could land in either sequence, so `--offset`
//     could repeat or skip one. `getDueEmails` already broke the tie on `id`. Both now
//     use `scheduled_at ASC, id ASC`, so a windowed read is reproducible.
//  3. AN UNKNOWN ID. `markSent`/`markFailed` were a bare `UPDATE ... WHERE id = ?` in one
//     arm — zero rows changed, no error, caller told nothing — and a PATCH that threw on
//     404 in the other. The loud arm wins: a caller told "marked sent" when no row was
//     marked has been lied to. A row deleted between the due-read and the mark is now an
//     error instead of a silent no-op.
//  4. WHO MINTS THE ID. One arm generated the uuid and `created_at` client-side; the
//     other sent both to the service. Neither is possible through the seam, and that is
//     correct: `id` and `created_at` are not writable columns on the generic resource
//     contract (src/server/self-hosted/openapi.ts builds the request schema from the
//     column list alone, with `additionalProperties: false`), so the API store would
//     REFUSE a create that named them. Both stores mint their own, and the created row
//     is read back out of the store's own answer.
//
// WHAT IS LOST, named here rather than left to be discovered:
//
//  * ATOMICITY OF CANCEL. `cancelScheduledEmail` was one conditional statement
//    (`UPDATE ... WHERE id = ? AND status = 'pending'`) whose `changes` count WAS the
//    answer, so two concurrent cancels could not both succeed. The seam publishes `get`
//    and `update` and no compare-and-set, so this is now a read-modify-write: two racing
//    cancels can both observe `pending` and both report success, and a cancel racing a
//    send can overwrite `sent` with `cancelled`. It is the same exposure the second arm
//    already had. Closing it needs a conditional update on the seam — described here,
//    NOT added: `src/store/` is byte-identical to main.
//  * A CALLER-SUPPLIED DATABASE HANDLE. The trailing `db?: Database` parameter is now a
//    trailing `store?: EmailStore`. Every caller in this repository passed
//    `getDatabase()` — the process-wide connection the configured SQLite store already
//    binds to — so no call site changes which rows it reads.
//  * SYNCHRONOUS CALLS. Every operation on the seam is async, so all eight are now
//    `async`. Both arms were synchronous (one on SQLite, one on a blocking transport).
//
// WHAT IS BOUNDED. `readSchedule` walks pages to an EMPTY page — never merely a short
// one, because every list route clamps `limit` and a clamped page is indistinguishable
// from the last page of a small table — using the enumeration in
// src/lib/status-facts-enumeration.ts, whose budget is 40 pages of 500 rows. A schedule
// larger than that, after the pushed-down status filter, cannot be ordered by due time
// from limit/offset reads alone, and gets a refusal naming the bound instead of its first
// 20 000 rows presented as the whole of it.
//
// A COMPARISON THAT STAYS LEXICAL. `scheduled_at <= now` was a string compare in both
// arms (SQLite `TEXT` comparison; a JavaScript `<=` in the other) and stays one here. It
// is exact for the ISO-8601 UTC instants `now()` produces and that every caller in this
// repository writes, and it is NOT chronological against a row stored in some other
// format — the same weakness src/lib/analytics.ts records for its own window. Parity is
// preserved deliberately: changing it belongs to whoever fixes the stored format, not to
// a collapse.

import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { now } from "./runtime.js";
// Value coercion only. These are pure functions that turn one store's JSON-typed column
// into the other's TEXT-encoded one; the module they live in is named for the axis being
// deleted, and relocating them belongs to that deletion rather than to this collapse.
import { carray, ciso, cobj, cstr, cstrArray, cstrOrNull } from "./self-hosted-resource.js";
import { enumerateStoreRows } from "../lib/status-facts-enumeration.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { ResourceInput, ResourceRow } from "../store/records.js";

export const SCHEDULED_STATUSES = ["pending", "sent", "cancelled", "failed"] as const;
export type ScheduledStatus = (typeof SCHEDULED_STATUSES)[number];

export interface ScheduledEmail {
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
  attachments_json: unknown[];
  template_name: string | null;
  template_vars: Record<string, string> | null;
  scheduled_at: string;
  status: ScheduledStatus;
  error: string | null;
  created_at: string;
}

export type ScheduledEmailSummary = Omit<ScheduledEmail, "html" | "text_body" | "attachments_json" | "template_vars">;

export interface ListScheduledEmailOptions {
  status?: ScheduledStatus;
  limit?: number;
  offset?: number;
}

export interface ListDueEmailOptions {
  limit?: number;
}

/**
 * A stored row, narrowed to the schedule's shape.
 *
 * The array and object columns are coerced rather than cast because the two stores hold
 * them differently — SQLite has no array or object storage class and keeps them as JSON
 * TEXT, the API serves real JSON — and a caller must not have to know which one answered.
 */
function rowToScheduledEmail(row: ResourceRow): ScheduledEmail {
  return {
    id: cstr(row["id"]),
    provider_id: cstr(row["provider_id"]),
    from_address: cstr(row["from_address"]),
    to_addresses: cstrArray(row["to_addresses"]),
    cc_addresses: cstrArray(row["cc_addresses"]),
    bcc_addresses: cstrArray(row["bcc_addresses"]),
    reply_to: cstrOrNull(row["reply_to"]),
    subject: cstr(row["subject"]),
    html: cstrOrNull(row["html"]),
    text_body: cstrOrNull(row["text_body"]),
    attachments_json: carray(row["attachments_json"]),
    template_name: cstrOrNull(row["template_name"]),
    template_vars: row["template_vars"] == null ? null : (cobj(row["template_vars"]) as Record<string, string>),
    scheduled_at: cstr(row["scheduled_at"]),
    status: (cstr(row["status"]) || "pending") as ScheduledStatus,
    error: cstrOrNull(row["error"]),
    created_at: ciso(row["created_at"]),
  };
}

function scheduledToSummary(s: ScheduledEmail): ScheduledEmailSummary {
  const { html: _h, text_body: _t, attachments_json: _a, template_vars: _v, ...summary } = s;
  return summary;
}

/**
 * Due order, and a TOTAL one.
 *
 * `scheduled_at` alone leaves rows sharing a due instant in an order neither store
 * promises, which is enough for `--offset` to repeat or skip one of them. `id` breaks the
 * tie so a windowed read is reproducible.
 */
function byDueTime(a: ScheduledEmail, b: ScheduledEmail): number {
  return (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "") || a.id.localeCompare(b.id);
}

function textField(row: ResourceRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

/**
 * Production builds its own store; a test may hand one in.
 *
 * Built per call rather than at module load: a contradictory storage configuration is a
 * boot error raised by the resolution, and it belongs to the call that needed a store
 * rather than to whoever imported this module first. This is a TEST seam and not a
 * routing seam — there is exactly one production path, and nothing here asks WHICH store
 * it holds.
 */
function storeFor(store: EmailStore | undefined): EmailStore {
  return store ?? createConfiguredEmailStore();
}

/**
 * Every scheduled row the filter admits, in due order — or a throw naming why not.
 *
 * WHY THE WHOLE SET. The two stores order this family differently (see the header), so
 * the first `limit + offset` rows of a store's order are not the first `limit + offset`
 * rows of due order. Nothing on the seam narrows that: `ListOptions` has no ordering and
 * the uniform families have no cursor. Reading everything the filter admits and sorting
 * it here is the only way both stores answer the same question.
 *
 * WHY A THROW. `rows` coming back short has three unrelated causes — the store refused,
 * the read faulted, or the enumeration ran out of budget — and none of them is "the
 * schedule is that small". Returning the rows anyway publishes a truncated read as a
 * page, which is the defect this family already shipped once: an `--offset 500` that
 * answered zero rows with exit 0, indistinguishable from an empty schedule. These
 * functions return arrays rather than outcomes, so raising is the only way to keep the
 * three apart from an honestly empty schedule.
 */
async function readSchedule(
  store: EmailStore,
  status: ScheduledStatus | undefined,
  what: string,
): Promise<ScheduledEmail[]> {
  // `status` is the one declared filter on this family for BOTH stores — the column
  // exists in SQLite, and `/v1/scheduled` publishes it, so the API store accepts it
  // rather than refusing (it refuses a filter the route does not accept instead of
  // answering with the unfiltered list). Pushing it down is what keeps a large schedule
  // inside the page budget.
  const filters = status ? { status } : undefined;
  const enumeration = await enumerateStoreRows<ResourceRow>(
    (opts) => store.scheduled.list({ ...opts, ...(filters ? { filters } : {}) }),
    { idOf: (row) => textField(row, "id") },
  );

  if (enumeration.refusal !== null) {
    throw new Error(
      `Refusing to answer ${what}: the configured store refused to list the schedule ` +
        `(${enumeration.refusal.code}): ${enumeration.refusal.message}`,
    );
  }
  if (enumeration.fault !== null) {
    throw new Error(`Refusing to answer ${what}: the schedule read faulted: ${enumeration.fault}`);
  }
  if (!enumeration.complete) {
    // Name whichever evidence fired. A row deleted above the cursor slides every unread
    // row down one offset and is never seen again without producing a duplicate, so
    // `duplicates` alone is not the whole story.
    const cause = enumeration.exhausted
      ? `the ${enumeration.pages}-page enumeration budget ran out before the end of the table`
      : enumeration.duplicates > 0
        ? `${enumeration.duplicates} row(s) came back twice across ${enumeration.pages} page(s), so at least ` +
          "that many rows were never seen"
        : `a page did not begin on the row the previous page ended on across ${enumeration.pages} page(s), ` +
          "so rows were skipped";
    throw new Error(
      `Refusing to answer ${what}: ${cause}, so the ${enumeration.rows.length} row(s) read are a LOWER BOUND ` +
        "rather than the schedule. Due order cannot be derived from a partial read — the rows past the boundary " +
        "could sort anywhere within it. Narrow the read with a status filter.",
    );
  }

  const rows: ScheduledEmail[] = [];
  for (const row of enumeration.rows) {
    const scheduled = rowToScheduledEmail(row);
    // The pushed-down filter is re-checked, and the redundancy is a finding rather than
    // belt-and-braces: a store or fixture that ignores an equality filter answers with
    // the unfiltered list, and a client that trusted the filter would then report sent
    // rows as pending. Pushing it down keeps the read narrow; re-checking keeps the
    // answer right against anything that does not honour it.
    if (status && scheduled.status !== status) continue;
    // A ROW WITH NO DUE TIME CANNOT BE ORDERED, AND MUST NOT BE GUESSED AT. The coercion
    // above cannot tell an ABSENT column from an empty one — both arrive as "" — and ""
    // sorts before every real instant AND satisfies `"" <= now`, so such a row would sort
    // to the front of the schedule and read as due RIGHT NOW. That is a fabricated answer
    // of exactly the shape this program keeps finding: absent read as a value.
    //
    // It is not reachable through either store today (`scheduled_at` is `TEXT NOT NULL` in
    // SQLite and required by the API's published item schema), which is why neither deleted
    // arm noticed — the SQL one compared in the database and the other never looked. A
    // corrupt or hand-edited row is the only way in, and a fault names it rather than
    // silently mailing it.
    if (scheduled.scheduled_at === "") {
      throw new Error(
        `Refusing to answer ${what}: scheduled email ${scheduled.id || "(no id)"} has no scheduled_at, so it ` +
          "cannot be placed in due order — and treating a missing due time as the earliest one would report " +
          "it as due now.",
      );
    }
    rows.push(scheduled);
  }
  return rows.sort(byDueTime);
}

/** The requested window of an already-ordered list. */
function windowOf<T>(rows: T[], opts: { limit?: number; offset?: number } | undefined): T[] {
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  // No limit means "every row", and it ignores `offset` — the behaviour both arms had.
  return limit === null ? rows : rows.slice(offset, offset + limit);
}

export async function createScheduledEmail(
  input: {
    provider_id: string;
    from_address: string;
    to_addresses: string[];
    cc_addresses?: string[];
    bcc_addresses?: string[];
    reply_to?: string;
    subject: string;
    html?: string;
    text_body?: string;
    attachments_json?: unknown[];
    template_name?: string;
    template_vars?: Record<string, string>;
    scheduled_at: string;
  },
  store?: EmailStore,
): Promise<ScheduledEmail> {
  // Absent optional fields are written as explicit NULLs and the arrays as empty arrays,
  // exactly as both arms did, so a row created here has the same shape whichever store
  // holds it. `id` and `created_at` are deliberately absent — see header note 4.
  const values: ResourceInput = {
    provider_id: input.provider_id,
    from_address: input.from_address,
    to_addresses: input.to_addresses,
    cc_addresses: input.cc_addresses || [],
    bcc_addresses: input.bcc_addresses || [],
    reply_to: input.reply_to || null,
    subject: input.subject,
    html: input.html || null,
    text_body: input.text_body || null,
    attachments_json: input.attachments_json || [],
    template_name: input.template_name || null,
    template_vars: input.template_vars ?? null,
    scheduled_at: input.scheduled_at,
    status: "pending",
  };
  const created = await storeFor(store).scheduled.create(values);
  if (!created.ok) {
    throw new Error(
      `Failed to schedule the email: the configured store refused the write (${created.code}): ${created.message}`,
    );
  }
  return rowToScheduledEmail(created.value);
}

export async function getScheduledEmail(id: string, store?: EmailStore): Promise<ScheduledEmail | null> {
  const answer = await storeFor(store).scheduled.get(id);
  if (!answer.ok) {
    throw new Error(
      `Failed to read scheduled email ${id}: the configured store refused (${answer.code}): ${answer.message}`,
    );
  }
  // Absence is a VALUE here, and only here: `null` means the store looked and there is no
  // such row. A store that could not look raises above instead.
  return answer.value === null ? null : rowToScheduledEmail(answer.value);
}

export async function listScheduledEmails(
  opts?: ListScheduledEmailOptions,
  store?: EmailStore,
): Promise<ScheduledEmail[]> {
  const rows = await readSchedule(storeFor(store), opts?.status, "the scheduled email list");
  return windowOf(rows, opts);
}

export async function listScheduledEmailSummaries(
  opts?: ListScheduledEmailOptions,
  store?: EmailStore,
): Promise<ScheduledEmailSummary[]> {
  const rows = await readSchedule(storeFor(store), opts?.status, "the scheduled email list");
  return windowOf(rows, opts).map(scheduledToSummary);
}

/**
 * Cancel a pending scheduled email; false when there was nothing cancellable.
 *
 * NOT ATOMIC, and the header says why at length: the seam has no conditional update, so
 * the `pending` check and the write are two calls. `false` still means "this row is not
 * cancellable" and never "the store could not be asked" — that raises.
 */
export async function cancelScheduledEmail(id: string, store?: EmailStore): Promise<boolean> {
  const scheduled = storeFor(store).scheduled;
  const current = await scheduled.get(id);
  if (!current.ok) {
    throw new Error(
      `Failed to cancel scheduled email ${id}: the configured store refused the read ` +
        `(${current.code}): ${current.message}`,
    );
  }
  if (current.value === null || cstr(current.value["status"]) !== "pending") return false;
  const updated = await scheduled.update(id, { status: "cancelled" });
  if (!updated.ok) {
    throw new Error(
      `Failed to cancel scheduled email ${id}: the configured store refused the write ` +
        `(${updated.code}): ${updated.message}`,
    );
  }
  // The row was there a moment ago. Gone now means it was deleted underneath this call,
  // which is not the same answer as "not cancellable" and is not reported as one.
  if (updated.value === null) {
    throw new Error(`Scheduled email ${id} disappeared between the status check and the cancellation`);
  }
  return true;
}

/**
 * Every pending email whose due instant has passed, earliest first.
 *
 * A SCHEDULER TICK MUST NOT MISS ROWS PAST A PAGE BOUNDARY, which is the bug this family
 * shipped: a single clamped list call saw at most 500 rows, and a schedule larger than
 * that silently never sent the rest — the rows past the boundary were not delayed, they
 * were never looked at. The read pages to an empty page and refuses if it could not
 * finish, so the rows a tick does not see are the rows it was told about.
 *
 * `status = 'pending'` is pushed down; `scheduled_at <= now` is not a filter either store
 * publishes, so it is applied here.
 */
export async function getDueEmails(opts?: ListDueEmailOptions, store?: EmailStore): Promise<ScheduledEmail[]> {
  const currentTime = now();
  const pending = await readSchedule(storeFor(store), "pending", "the due scheduled emails");
  const due = pending.filter((scheduled) => scheduled.scheduled_at <= currentTime);
  const limit = safeOptionalLimit(opts?.limit);
  // `due` is already in due order, so a limited batch is the EARLIEST rows rather than an
  // arbitrary subset: two consecutive ticks over an oversized schedule make progress.
  return limit === null ? due : due.slice(0, limit);
}

/** Record a successful send. Raises when there is no such row — see header note 3. */
export async function markSent(id: string, store?: EmailStore): Promise<void> {
  await markStatus(storeFor(store), id, { status: "sent" }, "sent");
}

/** Record a failed send with its reason. Raises when there is no such row. */
export async function markFailed(id: string, error: string, store?: EmailStore): Promise<void> {
  await markStatus(storeFor(store), id, { status: "failed", error }, "failed");
}

async function markStatus(store: EmailStore, id: string, patch: ResourceInput, what: string): Promise<void> {
  const updated = await store.scheduled.update(id, patch);
  if (!updated.ok) {
    throw new Error(
      `Failed to mark scheduled email ${id} ${what}: the configured store refused ` +
        `(${updated.code}): ${updated.message}`,
    );
  }
  if (updated.value === null) {
    throw new Error(
      `Cannot mark scheduled email ${id} ${what}: no such row. Reporting success for a write that changed ` +
        "nothing would record a send that was never recorded.",
    );
  }
}
