// The contacts family — the suppression ledger and per-recipient counters — as ONE
// implementation over the store seam. Nothing here asks where this installation is
// deployed; the store is resolved from STORAGE configuration (src/store-resolution.ts)
// or handed in by the caller.
//
// WHAT THIS FILE USED TO BE. A facade that read the process-wide deployment word and
// handed FOURTEEN exports to one of two sibling modules: a 371-line SQLite arm and a
// 161-line arm speaking to `/v1` through the legacy blocking bridge. Both are gone. The
// SQLite arm was already half an HTTP arm — every one of its operations except the two
// point reads began by asking the legacy resource bridge whether to route to `/v1`
// after all, so one configuration could suppress an address on a server while
// `getContact` read the local SQLite island that had never heard of it.
//
// ─── WHAT THE TWO ARMS DID DIFFERENTLY, MEASURED RATHER THAN ASSUMED ─────────────────
//
//  1. EVERY LOOKUP IN THE DELETED SECOND ARM ANSWERED OUT OF ONE CLAMPED PAGE. Its
//     find-by-email asked for `{ email, limit: 500 }` once and filtered locally; the
//     service clamps a list to 500 rows. Against a server that honours the `email`
//     filter the page holds only exact-spelling matches, so a contact stored as
//     `Blocked@ext.com` was UNFINDABLE by `blocked@ext.com` — for a SUPPRESSION lookup
//     that means silently permitting the send. Against a server that ignores the filter
//     the canonical scan saw only the first 500 rows, so a contact past the clamp was
//     null: `isContactSuppressed` answered false for a suppressed address, and
//     suppress-then-find missed the existing row and CREATED A DUPLICATE — the same
//     defect #149 measured for enrollments. Every lookup below that cannot answer from
//     an exact-spelling match enumerates the WHOLE table and REFUSES if it could not
//     finish; the exact-spelling probe is pushed down as an `email` filter and
//     re-checked client-side, so a store that ignores it stays correct.
//  2. THE BOOLEAN `suppressed` FILTER HAS NO STORE-PORTABLE WIRE ENCODING, so it is
//     never pushed down. The service coerces a filter value with JavaScript `Boolean`,
//     and every non-empty query-param string — including "false" and "0" — is truthy:
//     a pushed-down `suppressed=false` answers the SUPPRESSED rows, and the client-side
//     re-check then filters all of them out and presents an empty listing as the
//     installation's active contacts. The SQLite store compares SQL equality against an
//     INTEGER column, where "true" matches nothing. No single spelling is right on both
//     sides, so `listContacts` enumerates everything and filters here, where the
//     comparison is exact.
//  3. WHO ENFORCES CANONICAL MATCHING. The local arm compared `lower(email)` on both
//     sides in SQL; the second arm canonicalized in the client but only over the rows
//     its one clamped page happened to hold. The seam's generic path has no
//     case-folding filter, so every canonical comparison now happens HERE, over the
//     whole enumerated set, with `canonicalSender` on both sides — one comparison for
//     both stores instead of two half-strength ones.
//  4. THE COUNTER WRITES DISAGREED, AND ONE SIDE'S REASON WAS FALSE. The local arm
//     mutated send/bounce/complaint counters and auto-suppressed at three bounces; the
//     second arm made them deliberate no-ops "because the service derives contact
//     counters from message activity". The service does no such thing — its own webhook
//     sink records the delivery event and states that incrementing
//     `contacts.bounce_count` / `complaint_count` and setting `contacts.suppressed` is
//     "a separate, still-open defect and is deliberately NOT done here"
//     (src/server/self-hosted/webhooks.ts). So an API-configured client's counters
//     silently froze at zero and three bounces never suppressed anybody. The counters
//     below are ONE read-modify-write implementation through the seam for both stores,
//     auto-suppression included. If the service ever closes its own defect, the
//     double-write that creates belongs to that change, not this one.
//  5. ABSENT IS NOT `now()`. The old mappers read `created_at`/`updated_at` through a
//     coercion that answers the current instant for a missing value, dating a contact
//     to the moment it was read. Both stores declare these columns NOT NULL, so absence
//     is a projection fault and is reported as one, naming the row.
//  6. WHAT BOTH ARMS AGREED ON, PRESERVED — AND PINNED AS CONTRACT: `upsertContact` is
//     find-or-create and never resets an existing row; `suppressContact` and
//     `unsuppressContact` of an address with NO contact row CREATE the row in the named
//     state. That create-on-suppress is deliberate, not an accident being carried
//     along: a suppression ledger that can only suppress addresses it has already
//     mailed cannot hold an unsubscribe from an import, a complaint forwarded from
//     another system, or an operator's pre-emptive block. Create-on-unsuppress is kept
//     with it, deliberately, because both deleted arms shared it for the package's
//     whole 1.x life and the row it leaves — an active contact with zero counters — is
//     exactly what `upsertContact` of the same address would have left. Both are pinned
//     by the family's suite rather than left to be rediscovered.
//  7. LISTING ORDER IS NOW TOTAL. Both arms ordered by `updated_at DESC` with no
//     tiebreaker (the second arm sorted with `localeCompare`, so the order it presented
//     moved with the process locale); rows written in one batch share an instant, and a
//     window over a non-total order is a different window on every read. Every
//     comparator below carries an id tiebreaker in UTF-16 code-unit order.
//
// ─── WHAT IS LOST, NAMED RATHER THAN LEFT TO BE DISCOVERED ───────────────────────────
//
//  * ATOMIC COUNTER ARITHMETIC. The local arm's batch increment was one UPDATE whose
//    CASE arithmetic ran inside SQLite; it is now a read-modify-write per contact, so
//    two racing increments can lose one. The deleted second arm lost the WHOLE write,
//    every time, by design — this is strictly less wrong, and closing it needs a
//    conditional-increment operation on the seam, which is described here and not
//    added.
//  * SYNCHRONOUS CALLS. Every operation on the seam is async, so all fourteen exports
//    are now async and every consumer awaits them.
//
// WHAT IS SLOWER: a read that cannot answer from an exact-email probe walks the whole
// contacts table — one in-process query per page locally, one HTTP request per page
// against an API, at up to 500 rows a page. Bounded rather than open-ended: past the
// page budget these reads THROW instead of degrading, because the alternative is a
// suppression check that silently permits the send it existed to refuse.

import type { Database } from "./database.js";
import { canonicalSender } from "../lib/email-address.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
// Value coercion only. These are pure functions that turn one store's JSON-typed column
// into the other's TEXT-encoded one; the module they live in is named for the axis being
// deleted, and relocating them belongs to that deletion rather than to this collapse.
import { cbool, cnum, cstr, cstrOrNull } from "./self-hosted-resource.js";
import { enumerateStoreRows, type StoreEnumeration } from "../lib/status-facts-enumeration.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { ListOptions, ResourceRow } from "../store/records.js";
import type { Outcome } from "../store/outcome.js";

export interface Contact {
  id: string;
  email: string;
  name: string | null;
  send_count: number;
  bounce_count: number;
  complaint_count: number;
  last_sent_at: string | null;
  suppressed: boolean;
  created_at: string;
  updated_at: string;
}

export interface ListContactOptions {
  suppressed?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * What every export accepts as its optional store argument.
 *
 * A UNION RATHER THAN A REPLACEMENT, because `Database` has been the published shape of
 * this parameter for the package's whole 1.x life — these exports are on the public
 * entrypoint (src/index.ts), and narrowing a 1.x surface is a breaking change. See
 * `storeFor` for what each arm means.
 */
export type ContactStore = EmailStore | Database;

/**
 * Bounces at which a contact is suppressed automatically. Both deleted arms' history
 * and the alerting thresholds treat three hard bounces as the line past which
 * continuing to mail an address damages sender reputation.
 */
const AUTO_SUPPRESS_BOUNCE_COUNT = 3;

/**
 * Pages one enumeration may fetch, at up to 500 rows a page — about 100,000 rows.
 *
 * Far above the shared 40-page default because contacts are the one family here that an
 * operator grows in bulk (`emails batch-send` walks a CSV), and a suppression check
 * that runs out of budget must be a refusal naming the bound, never a shorter answer
 * that permits the send.
 */
const MAX_CONTACT_PAGES = 200;

// ─── The store handle ───────────────────────────────────────────────────────

/**
 * THE INJECTABLE ACCEPTS BOTH SHAPES, and that is a published-surface obligation rather
 * than a convenience: every export here has always taken an optional `Database` meaning
 * "scope this to the database I own", and the event sync still passes exactly that
 * (src/lib/sync.ts). A `Database` becomes a SQLite store BOUND TO THAT HANDLE — which
 * is stronger than what the deleted facade did with it (the handle's PRESENCE picked an
 * arm) — and an `EmailStore` is used as handed in.
 *
 * THE DISCRIMINATION IS STRUCTURAL, not a label: `EmailStore` exposes repositories and a
 * `bun:sqlite` `Database` exposes `query`. `descriptor` is deliberately NOT read —
 * branching on it is forbidden (src/store/descriptor.ts), and this asks which of two
 * ARGUMENT shapes was passed, never which store answered. Anything that is neither is a
 * fault naming both, because silently treating it as absent would resolve the configured
 * store and read the wrong installation's suppression ledger.
 *
 * Built per call rather than at module load, because a contradictory storage
 * configuration is a boot error raised by the resolution and it belongs to the call that
 * needed a store, not to whoever imported this module first.
 */
function storeFor(handle: ContactStore | undefined): EmailStore {
  if (handle === undefined) return createConfiguredEmailStore();
  const candidate = handle as Partial<EmailStore> & Partial<Database>;
  if (typeof candidate.contacts === "object" && candidate.contacts !== null) return handle as EmailStore;
  if (typeof candidate.query === "function") {
    return createSqliteEmailStore({ database: handle as Database, detail: "caller-supplied database" });
  }
  throw new Error(
    "The contacts family's optional store argument must be an EmailStore or a bun:sqlite Database; "
      + `received ${handle === null ? "null" : typeof handle}. Passing neither would silently read the `
      + "store this installation is configured with, which is not the one the caller named.",
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

/**
 * Every row the filter admits, or a throw naming why not.
 *
 * WHY A THROW: `rows` coming back short has three unrelated causes — the store refused,
 * the read faulted, or the enumeration ran out of budget — and none of them is "the
 * ledger is that small". These functions return arrays, scalars and sets rather than
 * outcomes, so raising is the only way to keep the three apart from an honestly empty
 * answer.
 */
async function readAll(
  store: EmailStore,
  filters: Record<string, string> | undefined,
  what: string,
): Promise<ResourceRow[]> {
  const enumeration: StoreEnumeration<ResourceRow> = await enumerateStoreRows<ResourceRow>(
    (opts: ListOptions) => store.contacts.list({ ...opts, ...(filters ? { filters } : {}) }),
    { idOf: (row) => (typeof row["id"] === "string" ? row["id"] : null), pageBudget: MAX_CONTACT_PAGES },
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
        + "rather than the whole set — and a suppression decision, a window or a lookup taken from a "
        + "partial read is silently wrong. Narrow the read or retry.",
    );
  }
  return enumeration.rows;
}

/** Code-unit order, not `localeCompare` (divergence 7). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Most recently touched first — the order both arms promised, made total (divergence 7). */
function byNewestUpdateRaw(a: ResourceRow, b: ResourceRow): number {
  return (
    compareText(cstr(b["updated_at"]), cstr(a["updated_at"]))
    || compareText(cstr(b["id"]), cstr(a["id"]))
  );
}

/** The caller's window, applied AFTER the whole set is sorted. No limit means every row. */
function windowed<T>(rows: T[], opts: { limit?: number; offset?: number } | undefined): T[] {
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  return limit === null ? rows.slice(offset) : rows.slice(offset, offset + limit);
}

// ─── Mapping store rows, AFTER filtering and windowing ──────────────────────

/** A timestamp both schemas declare NOT NULL; absence is a projection fault, not "now". */
function requiredTimestamp(row: ResourceRow, key: string): string {
  const value = cstrOrNull(row[key]);
  if (value === null || value === "") {
    throw new Error(
      `This installation's store returned contact ${cstr(row["id"]) || "(no id)"} with no ${key}; `
        + "refusing to report the current time in its place",
    );
  }
  return value;
}

function toContact(row: ResourceRow): Contact {
  return {
    id: cstr(row["id"]),
    email: cstr(row["email"]),
    name: cstrOrNull(row["name"]),
    send_count: cnum(row["send_count"]),
    bounce_count: cnum(row["bounce_count"]),
    complaint_count: cnum(row["complaint_count"]),
    last_sent_at: cstrOrNull(row["last_sent_at"]),
    suppressed: cbool(row["suppressed"]),
    created_at: requiredTimestamp(row, "created_at"),
    updated_at: requiredTimestamp(row, "updated_at"),
  };
}

// ─── Canonical lookup ───────────────────────────────────────────────────────

/** The form suppression compares: lowercased addr-spec, display names stripped. */
function canonicalOf(value: string): string {
  return canonicalSender(value) ?? value.trim().toLowerCase();
}

/**
 * One contact by email, matched exactly first and then CANONICALLY, over the whole
 * table (divergences 1 and 3).
 *
 * The exact probe pushes the `email` filter down (both shipped stores accept it) and
 * re-checks the raw rows, so a store or fixture that ignores an equality filter cannot
 * hand back the whole table as "matches". A miss falls through to a full enumeration,
 * because a contact stored under another spelling of the same address — `Blocked@ext.com`
 * for `blocked@ext.com` — is findable no other way: neither store's generic path folds
 * case. Among several rows sharing a canonical form (reachable through an API store; the
 * local schema's UNIQUE(email) does not fold case either) the most recently updated wins,
 * deterministically, exact spelling first.
 */
async function findContactRaw(store: EmailStore, email: string, what: string): Promise<ResourceRow | null> {
  const spelled = email.trim();
  if (spelled === "") return null;
  const probed = await readAll(store, { email: spelled }, what);
  const exact = probed.filter((row) => cstr(row["email"]) === spelled).sort(byNewestUpdateRaw)[0];
  if (exact !== undefined) return exact;

  const wanted = canonicalOf(spelled);
  const rows = await readAll(store, undefined, what);
  const candidates = rows.filter((row) => canonicalOf(cstr(row["email"])) === wanted).sort(byNewestUpdateRaw);
  return candidates[0] ?? null;
}

// ─── CONTACTS ───────────────────────────────────────────────────────────────

/**
 * Find-or-create. Never resets an existing row (divergence 6), and the find is the
 * whole-table canonical lookup — the deleted second arm's one-page probe missed an
 * existing contact past the clamp and created a duplicate row for the same address.
 */
export async function upsertContact(email: string, store?: ContactStore): Promise<Contact> {
  const resolved = storeFor(store);
  const existing = await findContactRaw(resolved, email, `resolve the contact ${email}`);
  if (existing !== null) return toContact(existing);
  const created = required(
    "create a contact",
    await resolved.contacts.create({
      email,
      name: null,
      send_count: 0,
      bounce_count: 0,
      complaint_count: 0,
      last_sent_at: null,
      suppressed: false,
    }),
  );
  return toContact(created);
}

export async function getContact(email: string, store?: ContactStore): Promise<Contact | null> {
  const row = await findContactRaw(storeFor(store), email, `resolve the contact ${email}`);
  return row === null ? null : toContact(row);
}

export async function listContacts(opts?: ListContactOptions, store?: ContactStore): Promise<Contact[]> {
  // The whole table, filtered HERE (divergence 2: the boolean filter cannot ride the
  // wire), sorted with the total comparator, then windowed.
  const rows = await readAll(storeFor(store), undefined, "list contacts");
  const kept = opts?.suppressed === undefined
    ? rows
    : rows.filter((row) => cbool(row["suppressed"]) === opts.suppressed);
  return windowed(kept.sort(byNewestUpdateRaw), opts).map(toContact);
}

/**
 * Set the suppression state, creating the contact if the address has none — the
 * PINNED create-on-suppress / create-on-unsuppress contract (divergence 6).
 */
async function setSuppressed(store: EmailStore, email: string, suppressed: boolean): Promise<void> {
  const what = suppressed ? `suppress ${email}` : `unsuppress ${email}`;
  const existing = await findContactRaw(store, email, what);
  if (existing === null) {
    required(
      "create a contact",
      await store.contacts.create({
        email,
        name: null,
        send_count: 0,
        bounce_count: 0,
        complaint_count: 0,
        last_sent_at: null,
        suppressed,
      }),
    );
    return;
  }
  const updated = required(
    `record the suppression state for ${email}`,
    await store.contacts.update(cstr(existing["id"]), { suppressed }),
  );
  if (updated === null) {
    throw new Error(`The contact for ${email} disappeared between the lookup and the write; retry.`);
  }
}

export async function suppressContact(email: string, store?: ContactStore): Promise<void> {
  await setSuppressed(storeFor(store), email, true);
}

export async function unsuppressContact(email: string, store?: ContactStore): Promise<void> {
  await setSuppressed(storeFor(store), email, false);
}

// ─── Counters ───────────────────────────────────────────────────────────────

type ContactCountColumn = "send_count" | "bounce_count" | "complaint_count";

/**
 * ONE counter implementation for both stores (divergence 4). Read-modify-write per
 * distinct address: find canonically, create at zero when absent, add the batch's
 * count, stamp `last_sent_at` for sends, and auto-suppress at the bounce threshold.
 * The atomicity the local arm's single UPDATE had is named as lost in the header.
 */
async function incrementCounts(
  emails: Iterable<string>,
  column: ContactCountColumn,
  opts: { updateLastSentAt?: boolean; autoSuppressBounces?: boolean },
  store: ContactStore | undefined,
): Promise<void> {
  const counts = new Map<string, number>();
  for (const email of emails) {
    counts.set(email, (counts.get(email) ?? 0) + 1);
  }
  if (counts.size === 0) return;

  const resolved = storeFor(store);
  const timestamp = new Date().toISOString();
  for (const [email, count] of counts) {
    const existing = await findContactRaw(resolved, email, `count activity for ${email}`);
    const base = existing === null ? 0 : cnum(existing[column]);
    const next = base + count;
    const patch: Record<string, unknown> = { [column]: next };
    if (opts.updateLastSentAt) patch["last_sent_at"] = timestamp;
    if (opts.autoSuppressBounces && next >= AUTO_SUPPRESS_BOUNCE_COUNT) patch["suppressed"] = true;
    if (existing === null) {
      required(
        "create a contact",
        await resolved.contacts.create({
          email,
          name: null,
          send_count: 0,
          bounce_count: 0,
          complaint_count: 0,
          last_sent_at: null,
          suppressed: false,
          ...patch,
        }),
      );
      continue;
    }
    const updated = required(
      `count activity for ${email}`,
      await resolved.contacts.update(cstr(existing["id"]), patch),
    );
    if (updated === null) {
      throw new Error(`The contact for ${email} disappeared between the lookup and the write; retry.`);
    }
  }
}

export async function incrementSendCount(email: string, store?: ContactStore): Promise<void> {
  await incrementSendCounts([email], store);
}

export async function incrementSendCounts(emails: Iterable<string>, store?: ContactStore): Promise<void> {
  await incrementCounts(emails, "send_count", { updateLastSentAt: true }, store);
}

export async function incrementBounceCount(email: string, store?: ContactStore): Promise<void> {
  await incrementBounceCounts([email], store);
}

export async function incrementBounceCounts(emails: Iterable<string>, store?: ContactStore): Promise<void> {
  await incrementCounts(emails, "bounce_count", { autoSuppressBounces: true }, store);
}

export async function incrementComplaintCount(email: string, store?: ContactStore): Promise<void> {
  await incrementComplaintCounts([email], store);
}

export async function incrementComplaintCounts(emails: Iterable<string>, store?: ContactStore): Promise<void> {
  await incrementCounts(emails, "complaint_count", {}, store);
}

// ─── Suppression reads ──────────────────────────────────────────────────────

export async function isContactSuppressed(email: string, store?: ContactStore): Promise<boolean> {
  const row = await findContactRaw(storeFor(store), email, `check suppression for ${email}`);
  return row !== null && cbool(row["suppressed"]);
}

/**
 * Suppressed addresses among `emails`, matched CANONICALLY (divergence 3).
 *
 * A recipient may be written `Display Name <a@b.com>` or in a different case than the
 * stored contact, and neither store's `email` column folds case. An exact comparison
 * therefore lets either form slip straight past a suppression — while the server-side
 * outbound policy, which canonicalizes both sides, refuses the same send. Client
 * enforcement must not be the weaker one.
 *
 * ONE whole-table enumeration answers the entire batch — the deleted second arm ran a
 * clamped lookup per address, and the local arm's SQL scan is not expressible on the
 * seam. The returned set contains both the stored spelling and its canonical form, so a
 * caller may test either; `suppressedRecipientsAmong` does the canonical test for them.
 */
export async function getSuppressedEmailSet(emails: Iterable<string>, store?: ContactStore): Promise<Set<string>> {
  const suppressed = new Set<string>();
  const wanted = new Set<string>();
  for (const raw of emails) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    wanted.add(canonicalOf(trimmed));
  }
  if (wanted.size === 0) return suppressed;

  const rows = await readAll(storeFor(store), undefined, "read the suppression ledger");
  for (const row of rows) {
    if (!cbool(row["suppressed"])) continue;
    const spelled = cstr(row["email"]);
    const canonical = canonicalOf(spelled);
    if (!wanted.has(canonical)) continue;
    suppressed.add(spelled);
    suppressed.add(canonical);
  }
  return suppressed;
}

/**
 * The subset of `recipients` that is suppressed, compared canonically and returned in
 * the caller's original spelling (so a warning names what the operator typed). One
 * helper so every send surface asks the same question.
 */
export async function suppressedRecipientsAmong(recipients: Iterable<string>, store?: ContactStore): Promise<string[]> {
  const list = [...recipients];
  const suppressed = await getSuppressedEmailSet(list, store);
  if (suppressed.size === 0) return [];
  return list.filter((recipient) => {
    if (suppressed.has(recipient) || suppressed.has(recipient.trim())) return true;
    const canonical = canonicalSender(recipient);
    return canonical !== null && suppressed.has(canonical);
  });
}
