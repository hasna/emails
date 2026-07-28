// Drip sequences — sequences, their steps, and their enrollments — as ONE
// implementation over the store seam. Nothing here asks where this installation is
// deployed; the store is resolved from STORAGE configuration (src/store-resolution.ts)
// or handed in by the caller.
//
// WHAT THIS FILE USED TO BE. A facade that read the process-wide deployment word and
// handed FIFTEEN exports to one of two sibling modules: a 407-line SQLite arm and a
// 290-line arm speaking to `/v1` through the legacy blocking bridge. Both are gone. The
// sequences table is read and written through the seam's own `sequences` repository; the
// two sub-ledger tables go through the SAME generic resource path on both stores via the
// sub-ledger extension (src/store-sequence-subledger.ts), because `EmailStore` does not
// declare them yet and `src/store/` is byte-identical in this change. The described-and-
// not-made seam widening lives in that module's header.
//
// THE DELETED SQLITE ARM WAS ALREADY HALF AN HTTP ARM. Its five sequence-table
// operations each began by asking the legacy resource bridge whether to route to `/v1`
// after all — while its ten step/enrollment operations never asked. So one configuration
// could create a sequence through an API and then enroll a contact into a LOCAL SQLite
// island holding no such sequence: the provenance split this programme exists to remove,
// measured here rather than assumed.
//
// ─── WHAT THE TWO ARMS DID DIFFERENTLY, MEASURED RATHER THAN ASSUMED ─────────────────
//
//  1. EVERY READ IN THE DELETED SECOND ARM ANSWERED OUT OF ONE CLAMPED PAGE. It asked
//     for `{ limit: 1000 }` once and filtered locally; the service clamps a list to 500
//     rows. So with 501+ steps across an installation's sequences, `listSteps` silently
//     dropped steps — and `current_step` is a POSITION in that list, so a dropped or
//     re-ordered step re-points every enrollment at the wrong template. `enroll`'s
//     idempotency check missed existing enrollments past the clamp and created
//     duplicates; `unenroll` reported "not enrolled" for them; `countEnrollmentsByStatus`
//     undercounted; `getDueEnrollments` missed due sends; `getSequence("<name>")`
//     answered null for a real sequence past the clamp. Every read below enumerates the
//     WHOLE filtered set (pushing down the filters both stores accept, re-checked
//     client-side) and REFUSES if it could not finish — a truncated campaign presented
//     as the whole one is the defect this collapse exists to remove.
//  2. THE TWO STORES ORDER ALL THREE TABLES DIFFERENTLY, AND `ListOptions` ADMITS NO
//     ORDERING. The SQLite store's generic list orders by the table's time column
//     (`created_at DESC, id DESC`) or bare id; the service orders `sequences` by
//     `created_at DESC`, `sequence-steps` by `step_number ASC` and
//     `sequence-enrollments` by `enrolled_at DESC` (src/server/self-hosted/resources.ts).
//     So a windowed read taken from either store's own order is a plausible, silently
//     wrong page against the other. Every list here sorts the enumerated set itself and
//     windows locally, so both stores answer the same question.
//  3. NEITHER ARM'S ORDER WAS TOTAL, and steps are the family where that corrupts data:
//     the local schema enforces UNIQUE(sequence_id, step_number) but the service does
//     not (its migrations even default `step_number` to 0), so two steps sharing a
//     number are REACHABLE through an API store — and `current_step` indexes into the
//     sorted array. Every comparator below carries tiebreakers down to `id`, in UTF-16
//     code-unit order rather than the process locale's (the second arm sorted with
//     `localeCompare`, so the order it presented moved with the machine), which makes
//     step position a TOTAL order on every machine against both stores.
//  4. WHO MINTS IDS AND TIMESTAMPS. The deleted second arm minted a step id and sent it
//     to a route whose contract does not include `id` — the service DROPPED it and
//     minted its own, so the arm only worked because it read the answer back. Nothing
//     below sends an id. Timestamps that ORDER rows (`sequence_steps.created_at`,
//     `sequence_enrollments.enrolled_at`) ARE sent explicitly as ISO instants, because
//     both resources declare them writable and the SQLite column DEFAULT writes a
//     different text format whose interleaving would not sort against ISO rows the
//     deleted arms wrote.
//  5. A STATUS OUTSIDE THE DECLARED SET WAS PUBLISHED BEHIND A TYPE THAT SAYS IT CANNOT
//     BE. The local schema CHECK-constrains sequence and enrollment statuses; the
//     service does not (its migrations drop the enrollment status CHECK). One arm cast
//     the raw column, the other coerced only empty-to-active, so `status: "bogus"` came
//     through typed as `SequenceStatus`. Mapping below FAULTS on it, naming the row and
//     the value — and mapping happens AFTER windowing and AFTER filtering (filters
//     compare raw text), so one bad row faults the read that would actually present it,
//     not every listing that pages past it.
//  6. ABSENT IS NOT `now()`. The old mappers read timestamps through a coercion that
//     answers the current instant for a missing value, dating a row to the moment it
//     was read. Both stores declare these columns NOT NULL, so absence is a projection
//     fault and is reported as one, naming the row.
//  7. WHAT BOTH ARMS AGREED ON, PRESERVED: `getSequence` resolves an id first and then a
//     name; `enroll` is idempotent for a (sequence, contact) pair in ANY status and
//     computes `next_send_at` from the first step's delay; `unenroll` cancels only an
//     ACTIVE enrollment and answers false otherwise; `removeStep` / `deleteSequence`
//     answer false for a row that is not there; `advanceEnrollment` answers null for an
//     unknown enrollment, marks an enrollment past its last step completed, and treats
//     `current_step` as a 0-based index into the sorted steps; due-ness is the lexical
//     comparison `next_send_at <= now` over ISO instants (exact for everything this
//     repository writes, and NOT chronological against a row stored in another format —
//     preserved deliberately, as src/db/scheduled.ts records for its own window).
//
// ─── WHAT IS LOST, NAMED RATHER THAN LEFT TO BE DISCOVERED ───────────────────────────
//
//  * ATOMIC CONDITIONAL WRITES. `unenroll` was one conditional UPDATE whose change count
//    WAS the answer; it is now a read-modify-write, so two racing unenrolls can both
//    report true, and `advanceEnrollment` racing itself can double-advance. The second
//    arm already had exactly this exposure; closing it needs a conditional update on the
//    seam, which is described here and not added.
//  * CLIENT-SIDE CASCADE VISIBILITY. `deleteSequence` on a local store still cascades to
//    steps and enrollments through the schema's own foreign keys; through an API the
//    service decides, as it always has for the second arm.
//  * SYNCHRONOUS CALLS. Every operation on the seam is async, so all fifteen exports are
//    now async and every consumer awaits them.
//
// WHAT IS SLOWER: a read that is not addressed by id walks its whole filtered family —
// one in-process query per page locally, one HTTP request per page against an API, at up
// to 500 rows a page — where the SQLite arm did one indexed query. Bounded rather than
// open-ended: past the page budget these reads THROW instead of degrading, because the
// alternative is a truncated campaign published as the whole one.

import type { Database } from "./database.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { now } from "./runtime.js";
// Value coercion only. These are pure functions that turn one store's JSON-typed column
// into the other's TEXT-encoded one; the module they live in is named for the axis being
// deleted, and relocating them belongs to that deletion rather than to this collapse.
import { cnum, cstr, cstrOrNull } from "./self-hosted-resource.js";
import { enumerateStoreRows, type StoreEnumeration } from "../lib/status-facts-enumeration.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import { sequenceSubledgerOf, type SequenceSubledger } from "../store-sequence-subledger.js";
import type { EmailStore } from "../store/email-store.js";
import type { ListOptions, ResourceInput, ResourceRow } from "../store/records.js";
import type { Outcome } from "../store/outcome.js";
import type { ResourceRepository } from "../store/repositories.js";

export type SequenceStatus = "active" | "paused" | "archived";
export type EnrollmentStatus = "active" | "completed" | "cancelled";

export interface Sequence {
  id: string;
  name: string;
  description: string | null;
  status: SequenceStatus;
  created_at: string;
  updated_at: string;
}

export interface SequenceStep {
  id: string;
  sequence_id: string;
  step_number: number;
  delay_hours: number;
  template_name: string;
  from_address: string | null;
  subject_override: string | null;
  created_at: string;
}

export interface SequenceEnrollment {
  id: string;
  sequence_id: string;
  contact_email: string;
  provider_id: string | null;
  current_step: number;
  status: EnrollmentStatus;
  enrolled_at: string;
  next_send_at: string | null;
  completed_at: string | null;
}

export interface ListSequenceOptions {
  limit?: number;
  offset?: number;
}

export interface ListEnrollmentOptions {
  sequence_id?: string;
  status?: EnrollmentStatus;
  limit?: number;
  offset?: number;
}

export interface ListDueEnrollmentOptions {
  limit?: number;
}

export interface EnrollmentStatusCounts {
  active: number;
  completed: number;
  cancelled: number;
  total: number;
}

/**
 * What every export accepts as its optional store argument.
 *
 * A UNION RATHER THAN A REPLACEMENT, because `Database` has been the published shape of
 * this parameter for the package's whole 1.x life — these exports are on the public
 * entrypoint (src/index.ts), and narrowing a 1.x surface is a breaking change. See
 * `storeFor` for what each arm means.
 */
export type SequenceStore = EmailStore | Database;

const SEQUENCE_STATUSES: ReadonlySet<string> = new Set<SequenceStatus>(["active", "paused", "archived"]);
const ENROLLMENT_STATUSES: ReadonlySet<string> = new Set<EnrollmentStatus>([
  "active",
  "completed",
  "cancelled",
]);

/**
 * Pages one enumeration may fetch, at up to 500 rows a page — about 100,000 rows.
 *
 * Far above the shared 40-page default because enrollments are the one family here that
 * an operator grows in bulk (`sequence enroll-bulk` walks a CSV), and a `--offset` past
 * the budget must be a refusal naming the bound, never a shorter answer. Steps and
 * sequences share it for uniformity; both are small in practice.
 */
const MAX_SEQUENCE_PAGES = 200;

// ─── The store handle ───────────────────────────────────────────────────────

/**
 * THE INJECTABLE ACCEPTS BOTH SHAPES, and that is a published-surface obligation rather
 * than a convenience: every export here has always taken an optional `Database` meaning
 * "scope this to the database I own", and the local scheduler still passes exactly that
 * (src/cli/commands/misc.local.ts). A `Database` becomes a SQLite store BOUND TO THAT
 * HANDLE — which is stronger than what the deleted facade did with it (the handle's
 * PRESENCE picked an arm) — and an `EmailStore` is used as handed in.
 *
 * THE DISCRIMINATION IS STRUCTURAL, not a label: `EmailStore` exposes repositories and a
 * `bun:sqlite` `Database` exposes `query`. `descriptor` is deliberately NOT read —
 * branching on it is forbidden (src/store/descriptor.ts), and this asks which of two
 * ARGUMENT shapes was passed, never which store answered. Anything that is neither is a
 * fault naming both, because silently treating it as absent would resolve the configured
 * store and read the wrong installation's campaigns.
 *
 * Built per call rather than at module load, because a contradictory storage
 * configuration is a boot error raised by the resolution and it belongs to the call that
 * needed a store, not to whoever imported this module first.
 */
function storeFor(handle: SequenceStore | undefined): EmailStore {
  if (handle === undefined) return createConfiguredEmailStore();
  const candidate = handle as Partial<EmailStore> & Partial<Database>;
  if (typeof candidate.messages === "object" && candidate.messages !== null) return handle as EmailStore;
  if (typeof candidate.query === "function") {
    return createSqliteEmailStore({ database: handle as Database, detail: "caller-supplied database" });
  }
  throw new Error(
    "The sequences family's optional store argument must be an EmailStore or a bun:sqlite Database; "
      + `received ${handle === null ? "null" : typeof handle}. Passing neither would silently read the `
      + "store this installation is configured with, which is not the one the caller named.",
  );
}

/** True when the caller's first positional argument is a store rather than options. */
function isStoreArgument(value: unknown): value is SequenceStore {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<EmailStore> & Partial<Database>;
  return typeof candidate.query === "function"
    || (typeof candidate.messages === "object" && candidate.messages !== null);
}

/**
 * The sub-ledger, or a refusal naming what is missing.
 *
 * Both shipped stores carry it (they serve the two tables through the same generic
 * resource path as `sequences` itself), so this refusal is only reachable with a
 * caller-supplied store that implements the seam and nothing else — and for that caller
 * "this store holds no steps or enrollments" is the true answer, where an empty list
 * would be a fabricated one.
 */
function subledgerFor(store: EmailStore, what: string): SequenceSubledger {
  const subledger = sequenceSubledgerOf(store);
  if (subledger !== null) return subledger;
  throw new Error(
    `This store cannot ${what}: it carries no sequence sub-ledger (no sequenceSteps / `
      + "sequenceEnrollments repositories beside its sequences repository). Both shipped stores "
      + "carry them; a caller-supplied store must too.",
  );
}

/** Unwrap an `Outcome`, or throw the store's own refusal naming the operation. */
function required<TValue>(what: string, outcome: Outcome<TValue>): TValue {
  if (!outcome.ok) {
    throw new Error(
      `This installation's store cannot ${what} (${outcome.code}, ${outcome.status}): ${outcome.message}`,
    );
  }
  return outcome.value;
}

// ─── The enumerated stream ──────────────────────────────────────────────────

function textField(row: ResourceRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

/**
 * Every row the filter admits, or a throw naming why not.
 *
 * WHY A THROW: `rows` coming back short has three unrelated causes — the store refused,
 * the read faulted, or the enumeration ran out of budget — and none of them is "the
 * campaign is that small". These functions return arrays and scalars rather than
 * outcomes, so raising is the only way to keep the three apart from an honestly empty
 * answer.
 */
async function readAll(
  family: ResourceRepository<ResourceRow>,
  filters: Record<string, string> | undefined,
  what: string,
): Promise<ResourceRow[]> {
  const enumeration: StoreEnumeration<ResourceRow> = await enumerateStoreRows<ResourceRow>(
    (opts: ListOptions) => family.list({ ...opts, ...(filters ? { filters } : {}) }),
    { idOf: (row) => textField(row, "id"), pageBudget: MAX_SEQUENCE_PAGES },
  );
  if (enumeration.refusal !== null) {
    throw new Error(
      `Refusing to ${what}: the configured store refused the read `
        + `(${enumeration.refusal.code}): ${enumeration.refusal.message}`,
    );
  }
  if (enumeration.fault !== null) {
    throw new Error(`Refusing to ${what}: the read faulted: ${enumeration.fault}`);
  }
  if (!enumeration.complete) {
    const cause = enumeration.exhausted
      ? `the ${enumeration.pages}-page enumeration budget ran out before the end of the table`
      : enumeration.duplicates > 0
        ? `${enumeration.duplicates} row(s) came back twice across ${enumeration.pages} page(s), so at least `
          + "that many rows were never seen"
        : `a page did not begin on the row the previous page ended on across ${enumeration.pages} page(s), `
          + "so rows were skipped";
    throw new Error(
      `Refusing to ${what}: ${cause}, so the ${enumeration.rows.length} row(s) read are a LOWER BOUND `
        + "rather than the whole set — and a window, a count, a step position or a due decision taken "
        + "from a partial read is silently wrong. Narrow the read or retry.",
    );
  }
  return enumeration.rows;
}

/** Code-unit order, not `localeCompare` (divergence 3). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The caller's window, applied AFTER the whole set is sorted. No limit means every row. */
function windowed<T>(rows: T[], opts: { limit?: number; offset?: number } | undefined): T[] {
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  return limit === null ? rows : rows.slice(offset, offset + limit);
}

// ─── Mapping store rows, AFTER filtering and windowing (divergence 5) ───────

/** A timestamp both schemas declare NOT NULL; absence is a projection fault, not "now". */
function requiredTimestamp(row: ResourceRow, key: string, noun: string): string {
  const value = cstrOrNull(row[key]);
  if (value === null || value === "") {
    throw new Error(
      `This installation's store returned ${noun} ${cstr(row["id"]) || "(no id)"} with no ${key}; `
        + "refusing to report the current time in its place",
    );
  }
  return value;
}

function sequenceStatusOf(value: string, id: string): SequenceStatus {
  if (!SEQUENCE_STATUSES.has(value)) {
    throw new Error(
      `This installation's store returned sequence ${id || "(no id)"} with status ${JSON.stringify(value)}, `
        + `which is not one of ${[...SEQUENCE_STATUSES].join(", ")}; refusing to present it as one`,
    );
  }
  return value as SequenceStatus;
}

function enrollmentStatusOf(value: string, id: string): EnrollmentStatus {
  if (!ENROLLMENT_STATUSES.has(value)) {
    throw new Error(
      `This installation's store returned enrollment ${id || "(no id)"} with status ${JSON.stringify(value)}, `
        + `which is not one of ${[...ENROLLMENT_STATUSES].join(", ")}; refusing to present it as one`,
    );
  }
  return value as EnrollmentStatus;
}

function toSequence(row: ResourceRow): Sequence {
  const id = cstr(row["id"]);
  return {
    id,
    name: cstr(row["name"]),
    description: cstrOrNull(row["description"]),
    status: sequenceStatusOf(cstr(row["status"]), id),
    created_at: requiredTimestamp(row, "created_at", "sequence"),
    updated_at: requiredTimestamp(row, "updated_at", "sequence"),
  };
}

function toStep(row: ResourceRow): SequenceStep {
  return {
    id: cstr(row["id"]),
    sequence_id: cstr(row["sequence_id"]),
    step_number: cnum(row["step_number"]),
    delay_hours: cnum(row["delay_hours"]),
    template_name: cstr(row["template_name"]),
    from_address: cstrOrNull(row["from_address"]),
    subject_override: cstrOrNull(row["subject_override"]),
    created_at: requiredTimestamp(row, "created_at", "sequence step"),
  };
}

function toEnrollment(row: ResourceRow): SequenceEnrollment {
  const id = cstr(row["id"]);
  return {
    id,
    sequence_id: cstr(row["sequence_id"]),
    contact_email: cstr(row["contact_email"]),
    provider_id: cstrOrNull(row["provider_id"]),
    current_step: cnum(row["current_step"]),
    status: enrollmentStatusOf(cstr(row["status"]), id),
    enrolled_at: requiredTimestamp(row, "enrolled_at", "sequence enrollment"),
    next_send_at: cstrOrNull(row["next_send_at"]),
    completed_at: cstrOrNull(row["completed_at"]),
  };
}

// ─── Raw comparators — total orders over the RAW row (divergences 2 and 3) ──

/** Newest sequence first. */
function byNewestSequenceRaw(a: ResourceRow, b: ResourceRow): number {
  return (
    compareText(cstr(b["created_at"]), cstr(a["created_at"]))
    || compareText(cstr(b["id"]), cstr(a["id"]))
  );
}

/**
 * Step position. `step_number` first because it is the order both arms promised and the
 * order `current_step` indexes into; the tiebreakers make it TOTAL against an API store,
 * where duplicate step numbers are reachable (divergence 3).
 */
function byStepPositionRaw(a: ResourceRow, b: ResourceRow): number {
  return (
    cnum(a["step_number"]) - cnum(b["step_number"])
    || compareText(cstr(a["created_at"]), cstr(b["created_at"]))
    || compareText(cstr(a["id"]), cstr(b["id"]))
  );
}

/** Newest enrollment first. */
function byNewestEnrollmentRaw(a: ResourceRow, b: ResourceRow): number {
  return (
    compareText(cstr(b["enrolled_at"]), cstr(a["enrolled_at"]))
    || compareText(cstr(b["id"]), cstr(a["id"]))
  );
}

/** Earliest due first — the order both arms already agreed on, id tiebreaker included. */
function byDueTimeRaw(a: ResourceRow, b: ResourceRow): number {
  return (
    compareText(cstr(a["next_send_at"]), cstr(b["next_send_at"]))
    || compareText(cstr(a["id"]), cstr(b["id"]))
  );
}

/**
 * Every step of one sequence, in position order — the array `current_step` indexes.
 *
 * The `sequence_id` filter is pushed down (the column exists locally and `/v1/sequence-
 * steps` declares the filter) and RE-CHECKED on the raw row: a store or fixture that
 * ignores an equality filter answers with the unfiltered list, and trusting it would
 * splice another sequence's steps into this one's positions.
 */
async function readStepsRaw(subledger: SequenceSubledger, sequence_id: string, what: string): Promise<ResourceRow[]> {
  const rows = await readAll(subledger.sequenceSteps, { sequence_id }, what);
  return rows.filter((row) => cstr(row["sequence_id"]) === sequence_id).sort(byStepPositionRaw);
}

// ─── SEQUENCES ──────────────────────────────────────────────────────────────

export async function createSequence(
  input: { name: string; description?: string },
  store?: SequenceStore,
): Promise<Sequence> {
  const created = required(
    "create a sequence",
    await storeFor(store).sequences.create({
      name: input.name,
      description: input.description || null,
      status: "active",
    }),
  );
  return toSequence(created);
}

/**
 * One sequence by id, else by exact name, else null — the resolution order both arms
 * had. A name lookup enumerates: neither store's sequences list accepts a name filter,
 * and the deleted second arm's one-page scan answered null for a real sequence past the
 * clamp (divergence 1). Among several sequences sharing a name (reachable through an API
 * store; the local schema forbids it) the NEWEST wins, deterministically.
 */
export async function getSequence(nameOrId: string, store?: SequenceStore): Promise<Sequence | null> {
  const resolved = storeFor(store);
  if (nameOrId.trim() !== "") {
    const direct = required("read a sequence", await resolved.sequences.get(nameOrId));
    if (direct !== null) return toSequence(direct);
  }
  const rows = await readAll(resolved.sequences, undefined, `resolve the sequence name ${nameOrId}`);
  const match = rows.filter((row) => cstr(row["name"]) === nameOrId).sort(byNewestSequenceRaw)[0];
  return match === undefined ? null : toSequence(match);
}

export async function listSequences(opts?: ListSequenceOptions, store?: SequenceStore): Promise<Sequence[]> {
  const rows = await readAll(storeFor(store).sequences, undefined, "list sequences");
  return windowed(rows.sort(byNewestSequenceRaw), opts).map(toSequence);
}

export async function updateSequence(
  id: string,
  updates: Partial<Pick<Sequence, "name" | "description" | "status">>,
  store?: SequenceStore,
): Promise<Sequence> {
  const patch: ResourceInput = {};
  if (updates.name !== undefined) patch["name"] = updates.name;
  if (updates.description !== undefined) patch["description"] = updates.description;
  if (updates.status !== undefined) patch["status"] = updates.status;
  const updated = required("update a sequence", await storeFor(store).sequences.update(id, patch));
  if (updated === null) throw new Error(`Sequence not found: ${id}`);
  return toSequence(updated);
}

/**
 * Delete a sequence; false when there was no such row (both arms agreed). On a local
 * store the schema's own foreign keys cascade to steps and enrollments; through an API
 * the service decides, as it always has.
 */
export async function deleteSequence(id: string, store?: SequenceStore): Promise<boolean> {
  return required("delete a sequence", await storeFor(store).sequences.remove(id));
}

// ─── STEPS ──────────────────────────────────────────────────────────────────

export async function addStep(
  input: {
    sequence_id: string;
    step_number: number;
    delay_hours: number;
    template_name: string;
    from_address?: string;
    subject_override?: string;
  },
  store?: SequenceStore,
): Promise<SequenceStep> {
  const subledger = subledgerFor(storeFor(store), "add a sequence step");
  // No id (divergence 4); an explicit ISO `created_at` because it is a tiebreaking
  // ORDER column and the local column's DEFAULT writes a different text format.
  const created = required(
    "add a sequence step",
    await subledger.sequenceSteps.create({
      sequence_id: input.sequence_id,
      step_number: input.step_number,
      delay_hours: input.delay_hours,
      template_name: input.template_name,
      from_address: input.from_address || null,
      subject_override: input.subject_override || null,
      created_at: now(),
    }),
  );
  return toStep(created);
}

export async function listSteps(sequence_id: string, store?: SequenceStore): Promise<SequenceStep[]> {
  const subledger = subledgerFor(storeFor(store), "list sequence steps");
  const rows = await readStepsRaw(subledger, sequence_id, `list the steps of sequence ${sequence_id}`);
  return rows.map(toStep);
}

/** The step at a 0-based position in the sorted steps, or null past the end. */
export async function getStepAtIndex(
  sequence_id: string,
  index: number,
  store?: SequenceStore,
): Promise<SequenceStep | null> {
  const subledger = subledgerFor(storeFor(store), "read a sequence step by position");
  const rows = await readStepsRaw(subledger, sequence_id, `read step ${index} of sequence ${sequence_id}`);
  const row = rows[safeOffset(index)];
  return row === undefined ? null : toStep(row);
}

/**
 * Remove a step by its FULL id; false when there is no such row (both arms agreed).
 *
 * A KNOWN CONSUMER DEFECT, PRESERVED AND NAMED RATHER THAN FIXED HERE: the CLI prints
 * step ids truncated to eight characters everywhere it shows them and offers no way to
 * read a full one, so `emails sequence step remove <shown-id>` has never matched a row
 * on EITHER store. That is the command's id handling, not this family's delete — the
 * fix belongs at the surface that truncates (src/cli/commands/sequences.ts), beside the
 * prefix resolution every other CLI noun already has.
 */
export async function removeStep(id: string, store?: SequenceStore): Promise<boolean> {
  const subledger = subledgerFor(storeFor(store), "remove a sequence step");
  return required("remove a sequence step", await subledger.sequenceSteps.remove(id));
}

// ─── ENROLLMENTS ────────────────────────────────────────────────────────────

/** Enrollment rows for one sequence, raw, with the pushed-down filter re-checked. */
async function readEnrollmentsOfSequence(
  subledger: SequenceSubledger,
  sequence_id: string,
  what: string,
): Promise<ResourceRow[]> {
  const rows = await readAll(subledger.sequenceEnrollments, { sequence_id }, what);
  return rows.filter((row) => cstr(row["sequence_id"]) === sequence_id);
}

/**
 * Enroll a contact. Idempotent for a (sequence, contact) pair in ANY status — the rule
 * both arms shared — and the existing-enrollment check enumerates rather than reading
 * one clamped page (divergence 1), because a missed match here CREATES A DUPLICATE
 * ENROLLMENT and the contact is then mailed twice per step.
 */
export async function enroll(
  input: { sequence_id: string; contact_email: string; provider_id?: string },
  store?: SequenceStore,
): Promise<SequenceEnrollment> {
  const resolved = storeFor(store);
  const subledger = subledgerFor(resolved, "enroll a contact");
  const existing = (
    await readEnrollmentsOfSequence(subledger, input.sequence_id, "check for an existing enrollment")
  ).find((row) => cstr(row["contact_email"]) === input.contact_email);
  if (existing !== undefined) return toEnrollment(existing);

  // next_send_at comes from the FIRST step's delay, as both arms computed it.
  const firstStep = (
    await readStepsRaw(subledger, input.sequence_id, `read the first step of sequence ${input.sequence_id}`)
  )[0];
  const nextSendAt = firstStep === undefined
    ? null
    : new Date(Date.now() + cnum(firstStep["delay_hours"]) * 3600 * 1000).toISOString();

  const created = required(
    "enroll a contact",
    await subledger.sequenceEnrollments.create({
      sequence_id: input.sequence_id,
      contact_email: input.contact_email,
      provider_id: input.provider_id || null,
      current_step: 0,
      status: "active",
      // Explicit ISO instant: an ORDER column whose local DEFAULT writes another format.
      enrolled_at: now(),
      next_send_at: nextSendAt,
      completed_at: null,
    }),
  );
  return toEnrollment(created);
}

/**
 * Cancel an ACTIVE enrollment; false when there is none. A read-modify-write now — the
 * atomicity note in the module header names what that gives up.
 */
export async function unenroll(
  sequence_id: string,
  contact_email: string,
  store?: SequenceStore,
): Promise<boolean> {
  const subledger = subledgerFor(storeFor(store), "unenroll a contact");
  const active = (
    await readEnrollmentsOfSequence(subledger, sequence_id, "find the enrollment to cancel")
  ).find((row) => cstr(row["contact_email"]) === contact_email && cstr(row["status"]) === "active");
  if (active === undefined) return false;
  const updated = required(
    "unenroll a contact",
    await subledger.sequenceEnrollments.update(cstr(active["id"]), { status: "cancelled" }),
  );
  // The row vanished between the read and the write: there is no active enrollment now,
  // which is exactly what false has always meant here.
  return updated !== null;
}

export async function listEnrollments(
  opts?: ListEnrollmentOptions,
  store?: SequenceStore,
): Promise<SequenceEnrollment[]> {
  const subledger = subledgerFor(storeFor(store), "list enrollments");
  // Both filters are declared by `/v1/sequence-enrollments` and are columns locally, so
  // both push down; both are re-checked on the raw row. `status` is compared as TEXT —
  // a row whose status this family cannot present is still a row the filter excludes,
  // and faulting during a filter would take down a listing over a row it was about to
  // drop anyway.
  const filters: Record<string, string> = {};
  if (opts?.sequence_id) filters["sequence_id"] = opts.sequence_id;
  if (opts?.status) filters["status"] = opts.status;
  const rows = (
    await readAll(subledger.sequenceEnrollments, Object.keys(filters).length > 0 ? filters : undefined, "list enrollments")
  ).filter(
    (row) =>
      (!opts?.sequence_id || cstr(row["sequence_id"]) === opts.sequence_id)
      && (!opts?.status || cstr(row["status"]) === opts.status),
  );
  return windowed(rows.sort(byNewestEnrollmentRaw), opts).map(toEnrollment);
}

/**
 * Exact per-status counts for one sequence — exact because the enumeration behind them
 * REFUSES rather than stopping early; there is no aggregate on the seam to push this to
 * (divergence 1: the deleted arm counted one clamped page).
 *
 * `total` counts every row of the sequence, INCLUDING one whose status is outside the
 * three named buckets (reachable through an API store, divergence 5): such a row is real,
 * it is simply not presentable as one of the three, and dropping it from `total` would
 * report a campaign smaller than it is.
 */
export async function countEnrollmentsByStatus(
  sequenceId: string,
  store?: SequenceStore,
): Promise<EnrollmentStatusCounts> {
  const subledger = subledgerFor(storeFor(store), "count enrollments");
  const rows = await readEnrollmentsOfSequence(subledger, sequenceId, "count enrollments by status");
  const counts: EnrollmentStatusCounts = { active: 0, completed: 0, cancelled: 0, total: rows.length };
  for (const row of rows) {
    const status = cstr(row["status"]);
    if (status === "active") counts.active += 1;
    else if (status === "completed") counts.completed += 1;
    else if (status === "cancelled") counts.cancelled += 1;
  }
  return counts;
}

/**
 * Active enrollments whose `next_send_at` is at or before now, earliest first, oldest
 * `limit` of them. The whole active set is enumerated FIRST: a limit pushed into a
 * partial read would return the first due rows of the STORE'S order, not the earliest
 * due — and the rows it missed are exactly the longest-overdue ones.
 */
export async function getDueEnrollments(store?: SequenceStore): Promise<SequenceEnrollment[]>;
export async function getDueEnrollments(
  opts?: ListDueEnrollmentOptions,
  store?: SequenceStore,
): Promise<SequenceEnrollment[]>;
export async function getDueEnrollments(
  optsOrStore?: ListDueEnrollmentOptions | SequenceStore,
  maybeStore?: SequenceStore,
): Promise<SequenceEnrollment[]> {
  const storeArg = isStoreArgument(optsOrStore) ? optsOrStore : maybeStore;
  const opts = isStoreArgument(optsOrStore) ? undefined : optsOrStore;
  const subledger = subledgerFor(storeFor(storeArg), "read due enrollments");
  const currentTime = now();
  const rows = (await readAll(subledger.sequenceEnrollments, { status: "active" }, "read due enrollments"))
    .filter((row) => {
      const nextSendAt = cstrOrNull(row["next_send_at"]);
      return cstr(row["status"]) === "active" && nextSendAt !== null && nextSendAt !== "" && nextSendAt <= currentTime;
    })
    .sort(byDueTimeRaw);
  const limit = safeOptionalLimit(opts?.limit);
  return (limit === null ? rows : rows.slice(0, limit)).map(toEnrollment);
}

/**
 * Advance an enrollment past the step it just received: to the next step's delay, or to
 * completed when none remains. `current_step` is a 0-based position in the sorted steps,
 * which is why the sort under `readStepsRaw` must be total (divergence 3). Null for an
 * unknown enrollment; the answer is the store's own post-write row.
 */
export async function advanceEnrollment(
  enrollment_id: string,
  store?: SequenceStore,
): Promise<SequenceEnrollment | null> {
  const subledger = subledgerFor(storeFor(store), "advance an enrollment");
  const current = required(
    "advance an enrollment",
    await subledger.sequenceEnrollments.get(enrollment_id),
  );
  if (current === null) return null;

  const nextIndex = cnum(current["current_step"]) + 1;
  const steps = await readStepsRaw(
    subledger,
    cstr(current["sequence_id"]),
    `advance enrollment ${enrollment_id}`,
  );
  const nextStep = steps[safeOffset(nextIndex)];

  const patch: ResourceInput = nextStep === undefined
    ? { status: "completed", completed_at: now(), next_send_at: null, current_step: nextIndex }
    : {
        current_step: nextIndex,
        next_send_at: new Date(Date.now() + cnum(nextStep["delay_hours"]) * 3600 * 1000).toISOString(),
      };
  const updated = required(
    "advance an enrollment",
    await subledger.sequenceEnrollments.update(enrollment_id, patch),
  );
  return updated === null ? null : toEnrollment(updated);
}
