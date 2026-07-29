// The templates family — the message templates a send renders from — as ONE
// implementation over the store seam. Nothing here asks where this installation is
// deployed; the store is resolved from STORAGE configuration (src/store-resolution.ts)
// or handed in by the caller.
//
// WHAT THIS FILE USED TO BE. A facade that read the process-wide deployment word and
// handed SEVEN exports to one of two sibling modules: a 255-line SQLite arm and a
// 108-line arm speaking to `/v1` through the legacy blocking bridge. Both are gone.
// Every read and write below goes through the seam's own `templates` repository,
// which both shipped stores serve through their generic resource path.
//
// THE DELETED SQLITE ARM WAS ALREADY HALF AN HTTP ARM. Four of its five store
// operations began by asking the legacy resource bridge whether to route to `/v1`
// after all — but `getTemplateByName` never asked. So one configuration could create
// a template through an API and then have the batch send's name resolution read a
// LOCAL SQLite island holding no such template: the provenance split this programme
// exists to remove, measured here rather than assumed.
//
// ─── WHAT THE TWO ARMS DID DIFFERENTLY, MEASURED RATHER THAN ASSUMED ─────────────────
//
//  1. EVERY NAME LOOKUP AGAINST AN API ANSWERED OUT OF ONE CLAMPED PAGE. The deleted
//     second arm's `getTemplate` fell back to `list({ limit: 1000 })` and its
//     `getTemplateByName` scanned the same single request; the service clamps a list
//     to 500 rows. So with 501+ templates, a template past the clamp was UNFINDABLE
//     by name: `template show` and `template remove` answered "not found" for a real
//     template, and every send-flow resolution that names a template — `send
//     --template`, the scheduler's step templates, the MCP send tool — failed the
//     same way. Every name lookup below enumerates the WHOLE table and REFUSES if it
//     could not finish; the service declares no name filter for this resource, so
//     there is nothing to push down and the enumeration is the honest read.
//  2. THE TWO STORES ORDER THIS TABLE DIFFERENTLY, AND `ListOptions` ADMITS NO
//     ORDERING. Both deleted arms promised newest-CREATED first; the SQLite store's
//     generic list orders by `updated_at DESC` and the service by `created_at DESC`
//     (src/server/self-hosted/resources.ts). A windowed read taken from either
//     store's own order is a plausible, silently wrong page against the other. Every
//     list here sorts the enumerated set itself and windows locally, so both stores
//     answer the same question.
//  3. NEITHER ARM'S ORDER WAS TOTAL IN THE SAME WAY. The deleted second arm sorted
//     with `localeCompare`, so the order it presented moved with the machine's
//     locale — and rows created in one batch share a `created_at` instant, so ties
//     had no deterministic resolution at all. Comparators below use UTF-16 code-unit
//     order with the row's identity as the tiebreaker, which makes every window the
//     same window on every machine against both stores.
//  4. ABSENT IS NOT `now()`. The old API mapper read `updated_at` through a coercion
//     that answers the current instant for a missing value, and dated a missing
//     `created_at` to whatever `updated_at` held — a row aged to the moment it was
//     read. Both stores declare these columns NOT NULL, so absence is a projection
//     fault and is reported as one, naming the row. `metadata`, by contrast, keeps
//     its deliberate tolerance: both arms mapped a malformed payload to `{}`, the
//     suite pins that, and faulting a whole template listing over one row's metadata
//     would lose the templates the read was for.
//  5. WHAT BOTH ARMS AGREED ON, PRESERVED: `createTemplate` stores an empty html or
//     text body as null; `getTemplate` resolves an ID first and falls back to the
//     name, so an id always wins over a template NAMED like another's id;
//     `deleteTemplate` resolves the same way and answers false for a row that is not
//     there; name uniqueness is the STORE's constraint (both shipped schemas declare
//     UNIQUE(name)), so a duplicate create is the store's own typed refusal,
//     surfaced as a throw. Among several rows sharing a name — reachable only
//     through a caller-supplied store without that constraint — the NEWEST wins,
//     deterministically.
//  6. `renderTemplate` IS A PURE TEXT TRANSFORM and touches no store: it stays
//     synchronous, and a placeholder with no value stays raw (`{{name}}`) rather
//     than being replaced with an invented sample — pinned as contract by the
//     family's suite and by the preview command's own wording.
//
// ─── WHAT IS LOST, NAMED RATHER THAN LEFT TO BE DISCOVERED ───────────────────────────
//
//  * SQL POINT LOOKUPS BY NAME. The deleted SQLite arm resolved a name with one
//    indexed query; the seam's generic path has no name filter for this resource, so
//    a name lookup now walks the whole filtered family — one in-process query per
//    page locally, one HTTP request per page against an API, at up to 500 rows a
//    page. Bounded rather than open-ended: past the shared page budget these reads
//    THROW instead of degrading, because the alternative is a send rendered from
//    "template not found" while the template exists.
//  * SYNCHRONOUS CALLS. Every operation on the seam is async, so all six
//    store-backed exports are now async and every consumer awaits them.
//    (`renderTemplate` stays synchronous — divergence 6.)
//
// The shared 40-page enumeration budget (20,000 rows) is kept rather than raised:
// templates are operator-authored, not bulk-imported, and a library past that bound
// must be a refusal naming the budget, never a shorter answer.

import type { Database } from "./database.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
// Value coercion only. These are pure functions that turn one store's JSON-typed
// column into the other's TEXT-encoded one; the module they live in is named for the
// axis being deleted, and relocating them belongs to that deletion rather than to
// this collapse.
import { cobj, cstr, cstrOrNull } from "./self-hosted-resource.js";
import { enumerateStoreRows, type StoreEnumeration } from "../lib/status-facts-enumeration.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { ListOptions, ResourceRow } from "../store/records.js";
import type { Outcome } from "../store/outcome.js";

export interface Template {
  id: string;
  name: string;
  subject_template: string;
  html_template: string | null;
  text_template: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type TemplateSummary = Omit<Template, "html_template" | "text_template"> & {
  has_html_template: boolean;
  has_text_template: boolean;
};

export interface ListTemplateOptions {
  limit?: number;
  offset?: number;
}

/**
 * What every export accepts as its optional store argument.
 *
 * A UNION RATHER THAN A REPLACEMENT, because `Database` has been the published shape
 * of this parameter for the package's whole 1.x life — these exports are on the
 * public entrypoint (src/index.ts), and narrowing a 1.x surface is a breaking
 * change. See `storeFor` for what each arm means.
 */
export type TemplateStore = EmailStore | Database;

// ─── The store handle ───────────────────────────────────────────────────────

/**
 * THE INJECTABLE ACCEPTS BOTH SHAPES, and that is a published-surface obligation
 * rather than a convenience: every export here has always taken an optional
 * `Database` meaning "scope this to the database I own", and the local scheduler
 * still passes exactly that (src/cli/commands/misc.local.ts). A `Database` becomes a
 * SQLite store BOUND TO THAT HANDLE — which is stronger than what the deleted facade
 * did with it (the handle's PRESENCE picked an arm) — and an `EmailStore` is used as
 * handed in.
 *
 * THE DISCRIMINATION IS STRUCTURAL, not a label: `EmailStore` exposes repositories
 * and a `bun:sqlite` `Database` exposes `query`. `descriptor` is deliberately NOT
 * read — branching on it is forbidden (src/store/descriptor.ts), and this asks which
 * of two ARGUMENT shapes was passed, never which store answered. Anything that is
 * neither is a fault naming both, because silently treating it as absent would
 * resolve the configured store and read the wrong installation's templates.
 *
 * Built per call rather than at module load, because a contradictory storage
 * configuration is a boot error raised by the resolution and it belongs to the call
 * that needed a store, not to whoever imported this module first.
 */
function storeFor(handle: TemplateStore | undefined): EmailStore {
  if (handle === undefined) return createConfiguredEmailStore();
  const candidate = handle as Partial<EmailStore> & Partial<Database>;
  if (typeof candidate.templates === "object" && candidate.templates !== null) return handle as EmailStore;
  if (typeof candidate.query === "function") {
    return createSqliteEmailStore({ database: handle as Database, detail: "caller-supplied database" });
  }
  throw new Error(
    "The templates family's optional store argument must be an EmailStore or a bun:sqlite Database; "
      + `received ${handle === null ? "null" : typeof handle}. Passing neither would silently read the `
      + "store this installation is configured with, which is not the one the caller named.",
  );
}

/**
 * True when the caller's argument is a store rather than options.
 *
 * Needed because the published surface admits TWO parameter orders for the two
 * listing exports: the deleted SQLite arm took its optional handle BEFORE the
 * options, the deleted facade's compat shim exposed options-first, and the facade's
 * intersection type made both compile for the package's whole 1.x life. Narrowing to
 * one order would break released consumers, so both stay and the argument's SHAPE
 * decides — the same structural question `storeFor` asks, never a label.
 */
function isStoreArgument(value: unknown): value is TemplateStore {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<EmailStore> & Partial<Database>;
  return typeof candidate.query === "function"
    || (typeof candidate.templates === "object" && candidate.templates !== null);
}

/** Split one of the dual-order listing argument pairs into (opts, store). */
function listingArguments(
  first: ListTemplateOptions | TemplateStore | undefined,
  second: TemplateStore | ListTemplateOptions | undefined,
): { opts: ListTemplateOptions | undefined; store: TemplateStore | undefined } {
  if (isStoreArgument(first)) return { opts: second as ListTemplateOptions | undefined, store: first };
  return { opts: first, store: second as TemplateStore | undefined };
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

/**
 * Every template row, or a throw naming why not.
 *
 * WHY A THROW: `rows` coming back short has three unrelated causes — the store
 * refused, the read faulted, or the enumeration ran out of budget — and none of them
 * is "the library is that small". These functions return arrays and nullables rather
 * than outcomes, so raising is the only way to keep the three apart from an honestly
 * empty answer.
 */
async function readAll(store: EmailStore, what: string): Promise<ResourceRow[]> {
  const enumeration: StoreEnumeration<ResourceRow> = await enumerateStoreRows<ResourceRow>(
    (opts: ListOptions) => store.templates.list(opts),
    { idOf: (row) => (typeof row["id"] === "string" ? row["id"] : null) },
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
        + "rather than the whole set — and a window, a name lookup or a send-flow template resolution "
        + "taken from a partial read is silently wrong. Narrow the read or retry.",
    );
  }
  return enumeration.rows;
}

/** Code-unit order, not `localeCompare` (divergence 3). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Newest CREATED first — the order both arms promised, made total (divergences 2, 3). */
function byNewestCreatedRaw(a: ResourceRow, b: ResourceRow): number {
  return (
    compareText(cstr(b["created_at"]), cstr(a["created_at"]))
    || compareText(cstr(b["id"]), cstr(a["id"]))
  );
}

/**
 * The caller's window, applied AFTER the whole set is sorted. No limit means every
 * row — including an ignored `offset`, which is what the deleted SQLite arm's
 * LIMIT-gated clause did and what every prior collapse preserved for its listings.
 */
function windowed<T>(rows: T[], opts: ListTemplateOptions | undefined): T[] {
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  return limit === null ? rows : rows.slice(offset, offset + limit);
}

// ─── Mapping store rows, AFTER filtering and windowing ──────────────────────

/** A timestamp both schemas declare NOT NULL; absence is a projection fault, not "now". */
function requiredTimestamp(row: ResourceRow, key: string): string {
  const value = cstrOrNull(row[key]);
  if (value === null || value === "") {
    throw new Error(
      `This installation's store returned template ${cstr(row["id"]) || cstr(row["name"]) || "(no id)"} `
        + `with no ${key}; refusing to report the current time in its place`,
    );
  }
  return value;
}

/**
 * `metadata` keeps its deliberate tolerance (divergence 4): both deleted arms mapped
 * a malformed payload to `{}` and the suite pins that, because metadata is a payload
 * the template row carries, not the row's own identity.
 */
function toTemplate(row: ResourceRow): Template {
  return {
    id: cstr(row["id"]),
    name: cstr(row["name"]),
    subject_template: cstr(row["subject_template"]),
    html_template: cstrOrNull(row["html_template"]),
    text_template: cstrOrNull(row["text_template"]),
    metadata: cobj(row["metadata"]),
    created_at: requiredTimestamp(row, "created_at"),
    updated_at: requiredTimestamp(row, "updated_at"),
  };
}

/** The listing shape without the bodies: present-or-not flags, never the text. */
function toTemplateSummary(row: ResourceRow): TemplateSummary {
  const html = cstrOrNull(row["html_template"]);
  const text = cstrOrNull(row["text_template"]);
  return {
    id: cstr(row["id"]),
    name: cstr(row["name"]),
    subject_template: cstr(row["subject_template"]),
    metadata: cobj(row["metadata"]),
    has_html_template: html !== null && html !== "",
    has_text_template: text !== null && text !== "",
    created_at: requiredTimestamp(row, "created_at"),
    updated_at: requiredTimestamp(row, "updated_at"),
  };
}

/**
 * The template rows sharing one exact name, raw and newest first. This enumerates:
 * the service declares no name filter for this resource, so there is nothing to push
 * down — and the deleted second arm's one-page scan answered "not found" for a real
 * template past the clamp (divergence 1). Among several rows sharing a name
 * (reachable only through a caller-supplied store without the UNIQUE(name)
 * constraint both shipped stores carry) the NEWEST wins, deterministically
 * (divergence 5).
 */
async function findByNameRaw(store: EmailStore, name: string, what: string): Promise<ResourceRow | undefined> {
  const rows = await readAll(store, what);
  return rows.filter((row) => cstr(row["name"]) === name).sort(byNewestCreatedRaw)[0];
}

/**
 * The row `nameOrId` addresses: the id's own row when the store has one, else the
 * newest row carrying it as an exact name — id over name, which is what BOTH deleted
 * arms promised (divergence 5). A blank reference addresses no row: the ID half of
 * that answer now belongs to the SEAM (both stores' `get` answer null for a blank id,
 * before any request is built), and what remains here is only the NAME half — a blank
 * reference must not fall through to the name scan and resolve a template that
 * happens to carry an empty name.
 */
async function findByRefRaw(store: EmailStore, nameOrId: string, what: string): Promise<ResourceRow | null> {
  const direct = required(what, await store.templates.get(nameOrId));
  if (direct !== null) return direct;
  if (nameOrId.trim() === "") return null;
  return (await findByNameRaw(store, nameOrId, what)) ?? null;
}

// ─── TEMPLATES ──────────────────────────────────────────────────────────────

/**
 * Create a template. An empty html or text body is stored as null (divergence 5),
 * and `metadata` is sent as the empty OBJECT both deleted arms wrote: the SQLite
 * store's generic path encodes it to the TEXT `'{}'` the local schema declares as
 * its default, and the service's column is JSON-typed. A duplicate name is the
 * store's own typed refusal, surfaced as a throw (divergence 5).
 */
export async function createTemplate(
  input: {
    name: string;
    subject_template: string;
    html_template?: string;
    text_template?: string;
  },
  store?: TemplateStore,
): Promise<Template> {
  const created = required(
    "create a template",
    await storeFor(store).templates.create({
      name: input.name,
      subject_template: input.subject_template,
      html_template: input.html_template || null,
      text_template: input.text_template || null,
      metadata: {},
    }),
  );
  return toTemplate(created);
}

/** One template by id or exact name — id first (divergence 5) — or null. */
export async function getTemplate(nameOrId: string, store?: TemplateStore): Promise<Template | null> {
  const row = await findByRefRaw(storeFor(store), nameOrId, `resolve the template ${nameOrId}`);
  return row === null ? null : toTemplate(row);
}

/** One template by exact name only — never by id — or null. */
export async function getTemplateByName(name: string, store?: TemplateStore): Promise<Template | null> {
  const row = await findByNameRaw(storeFor(store), name, `resolve the template name ${name}`);
  return row === undefined ? null : toTemplate(row);
}

export async function listTemplates(opts?: ListTemplateOptions, store?: TemplateStore): Promise<Template[]>;
export async function listTemplates(store: TemplateStore, opts?: ListTemplateOptions): Promise<Template[]>;
export async function listTemplates(
  first?: ListTemplateOptions | TemplateStore,
  second?: TemplateStore | ListTemplateOptions,
): Promise<Template[]> {
  const { opts, store } = listingArguments(first, second);
  const rows = await readAll(storeFor(store), "list templates");
  return windowed(rows.sort(byNewestCreatedRaw), opts).map(toTemplate);
}

/**
 * The template list without the bodies — the shape every listing surface prints.
 * The body keys are ABSENT from the summary, not present-and-empty: a template's
 * html can dwarf the template, and serialising it into every listing is how it
 * leaks into logs.
 */
export async function listTemplateSummaries(
  opts?: ListTemplateOptions,
  store?: TemplateStore,
): Promise<TemplateSummary[]>;
export async function listTemplateSummaries(
  store: TemplateStore,
  opts?: ListTemplateOptions,
): Promise<TemplateSummary[]>;
export async function listTemplateSummaries(
  first?: ListTemplateOptions | TemplateStore,
  second?: TemplateStore | ListTemplateOptions,
): Promise<TemplateSummary[]> {
  const { opts, store } = listingArguments(first, second);
  const rows = await readAll(storeFor(store), "list template summaries");
  return windowed(rows.sort(byNewestCreatedRaw), opts).map(toTemplateSummary);
}

/**
 * Delete a template by id or exact name — resolved the same way `getTemplate`
 * resolves (divergence 5), because the seam deletes by id only; false when there is
 * no such row (both arms agreed).
 */
export async function deleteTemplate(nameOrId: string, store?: TemplateStore): Promise<boolean> {
  const resolved = storeFor(store);
  const existing = await findByRefRaw(resolved, nameOrId, `resolve the template ${nameOrId} for removal`);
  if (existing === null) return false;
  return required("delete a template", await resolved.templates.remove(cstr(existing["id"])));
}

/**
 * Render `{{var}}` placeholders from `vars`. Pure text transform — no store, still
 * synchronous. A placeholder with no value stays raw (`{{key}}`) rather than being
 * replaced with an invented sample; that passthrough is pinned contract (divergence
 * 6), because it shows the operator exactly which variables the template still
 * needs, where a fabricated sample would hide them.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return vars[key] ?? `{{${key}}}`;
  });
}
