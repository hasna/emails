// Scoped send keys, as ONE implementation over the store seam. Nothing here asks who is
// running it.
//
// A send key is a CREDENTIAL bound to one owner (an agent or a human). It authorizes
// sending only from addresses that owner OWNS or ADMINISTERS, so an agent issued a key
// cannot send as an address belonging to another principal. The plaintext token is
// readable exactly once, at mint; only its SHA-256 hash is ever stored, and the hash is
// never readable by a client at all.
//
// ─── WHAT THIS FILE USED TO BE ────────────────────────────────────────────────────────
//
// A 34-line facade whose dispatch helper read the process-wide deployment word and handed
// each of ten exports to one of two sibling modules: a 250-line SQLite arm and a 160-line
// arm that talked to `/v1/send-keys` (plus the two bespoke `/mint` and `/verify` routes)
// through the shared generic-resource bridge. BOTH arms implemented all ten operations, so
// this collapse resolves genuine disagreements rather than preserving a refusal. Worse,
// the SQLite arm ALSO carried a deployment branch of its own inside three of its
// operations — it asked whether it was really the local arm and answered from the HTTP
// bridge when it decided it was not — so one call could take either path depending on which
// of the two modules the caller reached first. Every divergence is listed below with the
// arm it was resolved toward and why.
//
// Every export now reaches the `send_keys` table through `EmailStore` (`src/store/`), is
// ASYNCHRONOUS because every operation on the seam is, and takes an injectable store
// defaulting to the configured one. `src/store/` itself is byte-identical to main.
//
// FIVE OF THE TEN OPERATIONS HAVE A DIRECT STORE EQUIVALENT. `src/store/repositories.ts`
// publishes `SendKeysRepository` with `mintSendKey`, `getSendKey`, `verifySendKey`,
// `revokeSendKey` and `listSendKeys`; `/v1/send-keys` plus the two bespoke routes serve them
// (`src/server/self-hosted/resources.ts`, `src/server/self-hosted/service.ts`) and the
// self-hosted Postgres schema has the table. The exceptions are the two owner-filtered
// listings and the two by-owner-set listings, which the seam cannot filter (note 4) — and
// the authorization question, whose seam operation EXISTS and cannot be used (note 1).
//
// ─── THE NINE DIVERGENCES, MEASURED RATHER THAN ASSUMED ───────────────────────────────
//
//  1. THE AUTHORIZATION OPERATION ON THE SEAM REFUSES ON BOTH STORES, so it is not used.
//     `SendKeysRepository.isOwnerAuthorizedFrom` is gated on the `outboundPolicy`
//     capability, which BOTH shipped stores declare FALSE (`src/store-sqlite/index.ts`,
//     `src/store-http/index.ts`). Delegating `canOwnerSendFrom` to it would have shipped a
//     send-scope gate that refuses on every configuration this package can be run in — a
//     100% failure rate that a fixture with a permissive fake store would not have caught.
//     This is the same trap `src/db/address-lifecycle.ts` records for
//     `getAddressSendability`, and it is resolved the same way: the answer is COMPOSED from
//     the facts the seam does project — the address rows and their two ownership columns —
//     and it is exactly the check both deleted arms performed and no more. It is NOT a
//     policy evaluation: sender readiness, recipient suppression, warming limits and quota
//     are what `outboundPolicy` covers and neither store has them.
//  2. FOUR LISTINGS READ ONE CLAMPED PAGE AND CALLED IT THE TABLE. `listSendKeysByOwners`
//     and `listSendKeySummariesByOwners` asked the deleted HTTP arm for `list({ limit:
//     1000 })` and filtered the answer client-side; the two owner-filtered listings asked
//     for `max(1000, limit + offset)` and did the same. Whichever store answers, a page of
//     this family is capped at 500: `MAX_PAGE` in `src/store-sqlite/send-keys.ts` when
//     SQLite answers, `clampLimit` in `src/server/self-hosted/store.ts` when the service
//     does. Above 500 keys those four listings silently omitted an owner's keys — an owner
//     whose keys happened to sort past the clamp got an EMPTY list, indistinguishable from
//     "this owner has no keys", which for a revocation review is the most dangerous empty
//     list in this module. Every read below enumerates to an EMPTY page and REFUSES if it
//     could not finish.
//  3. ORDER. `SendKeysRepository.listSendKeys` takes `ListOptions` — `{ limit, offset }`
//     and nothing else — so it admits no ordering, and the two stores order this family
//     differently in the TIEBREAK DIRECTION. `src/store-sqlite/send-keys.ts` selects
//     `ORDER BY created_at DESC, id DESC`. The service's spec field reads `created_at
//     DESC`, but `resourceListOrderBy` (`src/server/self-hosted/resources.ts`) APPENDS the
//     primary key when the clause does not already name it, so what it emits is `created_at
//     DESC, id ASC` — total, like SQLite's, and opposite on a tie. So NOTHING pushes a
//     `limit`/`offset` down: the first N rows of a store's order, re-sorted here, is a
//     plausible and silently wrong page against one of the two. The set is enumerated in
//     full, sorted here, and only then windowed. Ordering is `created_at DESC, id DESC`,
//     which matches the SQLite store's own; either choice is arbitrary, having one is not.
//  4. THE OWNER FILTER EXISTS ON THE ROUTE AND NOT ON THE SEAM. `/v1/send-keys` declares
//     `filters: ["owner_id"]`, and the deleted HTTP arm passed it — then re-filtered
//     client-side anyway, because it could not trust the route to apply it. The seam's
//     `listSendKeys` takes `ListOptions` with no `filters` member, unlike the uniform
//     families' `ResourceRepository.list`, so the filter is UNREACHABLE from here and every
//     owner-scoped read below is a full enumeration matched client-side. The cost is real
//     and is named rather than hidden: one owner's keys cost a scan of every key. The seam
//     widening that would remove it is DESCRIBED AND NOT MADE — `listSendKeys(opts?:
//     ListOptions & { filters?: { owner_id?: string } })`, implemented by both stores over
//     the filter the route already declares. `src/store/` is untouched here.
//  5. THE SECRET HASH IS GONE FROM THE PUBLISHED SHAPE, AND THAT IS THE POINT. The deleted
//     SQLite arm's `SendKey` carried `key_hash` holding the REAL SHA-256, and the deleted
//     HTTP arm carried the same field holding `""` — a fabricated credential value, in a
//     field a caller could reasonably compare a hash against. The seam's `SendKeyRecord`
//     has no such field, `src/store/conformance.ts` asserts its absence, and the service
//     redacts the column, so the honest projection has no hash at all. `SendKey` is now the
//     seam's record: the field is ABSENT rather than empty, so reading it is a `tsc` error
//     instead of a comparison that silently never matches. That also collapses the
//     full/summary distinction, which existed only to subtract this one field —
//     `SendKeySummary` is kept as an alias and the two summary listings are kept as
//     exports, because both are published entry points.
//  6. `revokeSendKey` HAD TWO DIFFERENT WRITES BEHIND ONE BOOLEAN, AND THE SEAM HAS A
//     THIRD. The SQLite arm ran `UPDATE … WHERE id = ? AND revoked_at IS NULL` and reported
//     `changes > 0`, so an unknown id and an already-revoked key both answered false in ONE
//     atomic statement. The HTTP arm read the row, answered false for a missing or
//     already-revoked one, and otherwise PATCHed — two round trips and a race. The seam's
//     `revokeSendKey` returns the ROW, and its HTTP implementation PATCHes `revoked_at`
//     UNCONDITIONALLY, which would RE-STAMP an already-revoked key and move a recorded
//     revocation instant. This module reads first and does not call the write at all unless
//     the key exists and is live, which preserves both arms' boolean AND keeps the re-stamp
//     unreachable. The read-then-write race the HTTP arm had is preserved with it and is
//     named here: two concurrent revocations can both answer true. Closing it needs a
//     conditional write on the seam (`revokeSendKey` refusing with `conflict` when the key
//     is already revoked); that is a seam change and is not made here.
//  7. MINTING NO LONGER REFUSES ON ONE CONFIGURATION. The deleted SQLite arm FAILED LOUD
//     when its own deployment branch said it was not really the local arm — the reasoning
//     being that a hash minted into the local file could never be verified by a remote
//     server. That reasoning was right about the DATA and wrong about the OPERATION: the
//     mint is a store operation, both stores implement it, and each mints into the store
//     that will verify it. So the refusal is deleted rather than preserved. What IS
//     preserved is the property it was protecting — the hash and the token are produced by
//     whichever store holds them, and neither ever crosses to the other.
//  8. THE OWNER LOOKUP MOVED ONTO THE SEAM, WHICH IS A PROVENANCE FIX.
//     `assertSendAuthorized` needs the owner behind a verified key. Both deleted arms asked
//     their own sibling owners arm, so the answer followed whichever module was imported
//     rather than the configured store. It is read through `EmailStore.owners` here, so the
//     key and its owner come from ONE dataset. The remaining split is NOT this family's and
//     is stated rather than hidden: `src/cli/commands/sendkey.ts` still resolves an owner
//     NAME through `src/db/owners.ts`, which routes on the deployment word, so with an API
//     configured and no deployment word set that name comes from a different dataset than
//     the keys. It closes when `src/db/owners` collapses.
//  9. THE ERROR TEXTS DIVERGED AND THE RICHER ONE IS KEPT. On an out-of-scope From the
//     SQLite arm raised "Send key for '<owner name>' is not authorized to send from <addr>"
//     and the HTTP arm raised the same sentence without the owner. The named form is kept.
//     The ORDER of the two failures is the SQLite arm's too: the owner is resolved BEFORE
//     the scope check, so a key whose owner was deleted reports that rather than reporting
//     an authorization failure it cannot explain.
//
// ─── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────────────
//
//  1. It never asks WHICH store it holds. `src/store-resolution.ts` is explicit that
//     construction is the only place that answer is visible.
//  2. It does not reach into another family's arm, and it does not log, echo, format or
//     return a token or a hash anywhere except the single `{ token }` a mint returns.
//  3. It does not touch the deployment-axis module, the dispatch layer, the curl bridge, or
//     any deployment-gated branch in another family.

import { canonicalSender } from "../lib/email-address.js";
import { enumerateStoreRows } from "../lib/status-facts-enumeration.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Refusal } from "../store/outcome.js";
import type { AddressRecord, ResourceRow, SendKeyRecord } from "../store/records.js";
import type { Owner, OwnerType } from "./owners.js";

/**
 * One send key, as the seam publishes it.
 *
 * A TYPE ALIAS RATHER THAN A SECOND DECLARATION, so the column list has one source of
 * truth. See divergence 5 for why `key_hash` is not on it.
 */
export type SendKey = SendKeyRecord;

/**
 * Historically the hash-free projection of `SendKey`.
 *
 * There is no hash on `SendKey` any more, so the two shapes are identical and this is an
 * alias. It is kept — and so are `listSendKeySummaries` and `listSendKeySummariesByOwners`
 * — because both the type and the functions are published from `src/index.ts` and a
 * consumer's import must keep resolving.
 */
export type SendKeySummary = SendKey;

export interface ListSendKeyOptions {
  limit?: number;
  offset?: number;
}

/**
 * Pages one send-key enumeration may fetch.
 *
 * Both stores clamp a page at 500, so 40 pages bounds one read at 20,000 keys — far above
 * any real installation, and reported rather than hidden when it is not enough.
 */
const MAX_SEND_KEY_PAGES = 40;

/**
 * Pages one address enumeration may fetch, for the send-scope check.
 *
 * The seam has NO by-email address read (`ListOptions` carries no filter), so finding the
 * rows for a sender means paging the registry and matching client-side — the same
 * composition, and the same budget, that `src/db/address-lifecycle.ts` uses for the same
 * lookup. 20 pages bounds it at 10,000 address rows.
 */
const MAX_ADDRESS_PAGES = 20;

/**
 * The refusal, thrown.
 *
 * The message names the OPERATION and carries the store's own code, status and text. It
 * names no setting and no command: a refusal that tells the caller which variable to set is
 * a refusal documenting its own bypass.
 */
function storeRefusal(what: string, refusal: Refusal): Error {
  return new Error(
    `This installation's store cannot ${what} (${refusal.code}, ${refusal.status}): ${refusal.message}`,
  );
}

/**
 * The store this call runs against.
 *
 * Built per call, so a contradictory storage configuration is a boot error belonging to the
 * call that needed a store rather than to whoever imported this module first.
 */
function storeFor(store: EmailStore | undefined): EmailStore {
  return store ?? createConfiguredEmailStore();
}

/**
 * Code-unit order, not `localeCompare`.
 *
 * The deleted HTTP arm sorted with `localeCompare`, which is LOCALE-DEPENDENT, so that
 * arm's page boundaries moved with the process locale. This is deterministic everywhere and
 * identical to SQLite's BINARY collation for every value a timestamp or a uuid can hold.
 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Newest first, with the identity as the tiebreaker (divergence 3). */
function byNewest(a: SendKeyRecord, b: SendKeyRecord): number {
  return compareText(b.created_at, a.created_at) || compareText(b.id, a.id);
}

/** The row identity the pager de-duplicates and anchors on, or null when it has none. */
function keyId(key: SendKeyRecord): string | null {
  return typeof key.id === "string" && key.id !== "" ? key.id : null;
}

/**
 * Reject a key that cannot be PLACED IN THE ORDER.
 *
 * Validated over the whole enumerated set, and nothing else is: a key that cannot be
 * ordered breaks the ordering of every key around it, while a key whose body is odd breaks
 * only itself. `''` is rejected as well as absent, because an empty timestamp sorts after
 * every real instant under a descending compare and would be published as the OLDEST key
 * rather than as an unreadable one. Reachable from the SQLite store, whose mapper answers
 * `""` for an absent column; the HTTP store faults on the same input earlier.
 */
function assertOrderable(keys: readonly SendKeyRecord[]): void {
  for (const key of keys) {
    if (keyId(key) === null) {
      throw new Error("This installation's store answered with a send key carrying no id; it cannot be ordered");
    }
    if (typeof key.created_at !== "string" || key.created_at === "") {
      throw new Error(
        `This installation's store answered with a send key (${key.id}) carrying no creation instant; `
          + "it cannot be ordered",
      );
    }
  }
}

/** What one enumeration of the key table established. */
interface SendKeyScan {
  keys: SendKeyRecord[];
  /** true => an empty page was reached AND the window never moved, so `keys` is all of them. */
  complete: boolean;
  /** Why it is not complete, in a form a person can act on. Empty when it is. */
  incompleteBecause: string;
}

/**
 * Read every stored send key, or explain why not.
 *
 * PAGED TO AN EMPTY PAGE, never to a short one: both list paths CLAMP `limit`, so a clamped
 * page is byte-for-byte indistinguishable from the last page of a small table. A refusal or
 * a fault THROWS — those mean nothing was read, and no caller can do anything with that. An
 * incomplete read is returned as a fact, because the callers want different things from it.
 */
async function scanSendKeys(store: EmailStore, what: string): Promise<SendKeyScan> {
  const enumeration = await enumerateStoreRows<SendKeyRecord>(
    (opts) => store.sendKeys.listSendKeys(opts),
    { pageBudget: MAX_SEND_KEY_PAGES, idOf: keyId },
  );

  if (enumeration.refusal !== null) throw storeRefusal(what, enumeration.refusal);
  if (enumeration.fault !== null) {
    throw new Error(`This installation's store faulted while it tried to ${what}: ${enumeration.fault}`);
  }
  assertOrderable(enumeration.rows);

  // Name whichever evidence fired. A row deleted above the cursor slides every unread row
  // down one offset and is never seen again WITHOUT producing a duplicate, so `duplicates`
  // alone is not the whole story.
  const incompleteBecause = enumeration.complete
    ? ""
    : enumeration.exhausted
      ? `the ${enumeration.pages}-page enumeration budget ran out before the end of the table`
      : enumeration.duplicates > 0
        ? `${enumeration.duplicates} send key(s) came back twice across ${enumeration.pages} page(s), so at `
          + "least that many were never seen"
        : `a page did not begin on the send key the previous page ended on across ${enumeration.pages} `
          + "page(s), so keys were skipped";

  return { keys: enumeration.rows, complete: enumeration.complete, incompleteBecause };
}

/**
 * The requested window of an already-ordered listing, with both deleted arms' clamping.
 *
 * NO LIMIT MEANS EVERY ROW AND IGNORES THE OFFSET, which is what BOTH deleted arms did and
 * is preserved verbatim: the SQLite arm emitted no `LIMIT`/`OFFSET` clause at all when no
 * limit was given, and the HTTP arm's windowing helper returned the list untouched. It is a
 * surprising contract, and changing it here would silently re-page every caller that passes
 * an offset alone.
 */
function windowOf(keys: SendKeyRecord[], opts: ListSendKeyOptions | undefined): SendKeyRecord[] {
  const limit = safeOptionalLimit(opts?.limit);
  if (limit === null) return keys;
  const start = safeOffset(opts?.offset);
  return keys.slice(start, start + limit);
}

/**
 * The requested window of one owner-scoped listing, newest first — or a throw naming why not.
 *
 * A WINDOW CANNOT BE CUT FROM A PARTIAL READ, whatever the window is. Keys past the boundary
 * could sort anywhere within the listing, so even offset 0 is wrong once the scan is short:
 * the refusal is unconditional rather than applied only to a late page.
 *
 * `ownerId` is matched EXACTLY and client-side (divergence 4). A blank owner id filters
 * nothing, which is what both deleted arms did with a falsy value.
 */
async function readSendKeyWindow(
  store: EmailStore,
  what: string,
  ownerId: string | undefined,
  opts: ListSendKeyOptions | undefined,
): Promise<SendKeyRecord[]> {
  const scan = await scanSendKeys(store, what);
  if (!scan.complete) {
    throw new Error(
      `Refusing to ${what}: ${scan.incompleteBecause}, so the ${scan.keys.length} send key(s) read are a `
        + "LOWER BOUND rather than the stored keys. Keys past the boundary could sort anywhere within the "
        + "listing, so a window cannot be cut from a partial read. If the cause is the page budget, revoke "
        + "and prune dead keys; if it is keys moving under the read, retry when nothing else is writing.",
    );
  }
  const matched = ownerId ? scan.keys.filter((key) => key.owner_id === ownerId) : scan.keys;
  return windowOf([...matched].sort(byNewest), opts);
}

/**
 * The keys held by any of `ownerIds`, newest first.
 *
 * De-duplicated and trimmed the way both deleted arms did it, and an EMPTY set
 * short-circuits to an empty list WITHOUT reading the store — that is a complete answer to
 * "the keys of no owners", not a truncation, so it must not be able to raise.
 */
async function readByOwners(
  store: EmailStore,
  what: string,
  ownerIds: Iterable<string>,
): Promise<SendKeyRecord[]> {
  const ids = new Set([...ownerIds].map((id) => String(id ?? "").trim()).filter(Boolean));
  if (ids.size === 0) return [];
  const scan = await scanSendKeys(store, what);
  if (!scan.complete) {
    throw new Error(
      `Refusing to ${what}: ${scan.incompleteBecause}, so the ${scan.keys.length} send key(s) read are a `
        + "LOWER BOUND rather than the stored keys, and an owner whose keys sort past the boundary would be "
        + "reported as holding none.",
    );
  }
  return scan.keys.filter((key) => key.owner_id !== null && ids.has(key.owner_id)).sort(byNewest);
}

/**
 * The canonical sender address, or `""` for an ambiguous or malformed From.
 *
 * `canonicalSender` returns null for a value carrying more than one addr-spec, which is the
 * double-angle-addr smuggle both deleted arms rejected here.
 */
function bareEmail(from: string): string {
  return canonicalSender(from) ?? "";
}

/**
 * One stored address, canonicalised for comparison.
 *
 * The deleted SQLite arm compared `LOWER(email)`; the deleted HTTP arm compared what its
 * by-email lookup matched. Canonicalising both sides and falling back to trimmed lowercase
 * text keeps a row neither could parse matching the row it used to match.
 */
function canonicalAddress(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return canonicalSender(text) ?? text.trim().toLowerCase();
}

/** What one enumeration of the address registry established. */
interface AddressScan {
  rows: AddressRecord[];
  complete: boolean;
}

/**
 * Every address row, within a budget.
 *
 * TWO RULES, each of them a bug this function would otherwise have: only an EMPTY page ends
 * the scan (a store may serve fewer rows than were asked for), and the offset advances by
 * rows RECEIVED rather than rows requested. A refusal or a fault propagates: a partial
 * enumeration is never presented as the registry.
 */
async function enumerateAddresses(store: EmailStore, what: string): Promise<AddressScan> {
  const enumeration = await enumerateStoreRows<AddressRecord>(
    (opts) => store.addresses.listAddresses(opts),
    { pageBudget: MAX_ADDRESS_PAGES, idOf: (row) => (typeof row.id === "string" && row.id !== "" ? row.id : null) },
  );
  if (enumeration.refusal !== null) throw storeRefusal(what, enumeration.refusal);
  if (enumeration.fault !== null) {
    throw new Error(`This installation's store faulted while it tried to ${what}: ${enumeration.fault}`);
  }
  return { rows: enumeration.rows, complete: enumeration.complete };
}

/** Text, or null for an absent or empty value. */
function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text === "" ? null : text;
}

/**
 * A required text column of a stored owner row, or a fault.
 *
 * NEITHER DELETED ARM GOT THIS RIGHT, and the disagreement is resolved rather than
 * inherited: the SQLite arm cast the raw row straight to `Owner`, so a missing column
 * arrived as `undefined` in a field typed `string`; the HTTP arm's coercion FABRICATED the
 * current instant for an absent `created_at`. A row this module cannot read is a fault,
 * which is the one answer neither of those is.
 */
function requiredOwnerText(row: ResourceRow, column: string, id: string): string {
  const value = row[column];
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error(`This installation's store answered with an owner (${id}) carrying no ${column}`);
}

/**
 * The owner's kind.
 *
 * The deleted HTTP arm's coercion, preserved deliberately: anything that is not exactly
 * `"agent"` reads as `"human"`. It is an INHERITED COERCION rather than a decision — the
 * local table constrains the column to the two values, so only a drifted operator dataset
 * can reach it, and this module makes no decision from the answer. It is pinned by a test so
 * neither direction can change silently.
 */
function ownerType(value: unknown): OwnerType {
  return String(value ?? "") === "agent" ? "agent" : "human";
}

/** A stored owner row, projected onto the shape this module's caller is promised. */
function toOwner(row: ResourceRow): Owner {
  const id = requiredOwnerText(row, "id", String(row["id"] ?? "<unidentified>"));
  return {
    id,
    type: ownerType(row["type"]),
    name: requiredOwnerText(row, "name", id),
    contact_email: textOrNull(row["contact_email"]),
    external_id: textOrNull(row["external_id"]),
    created_at: requiredOwnerText(row, "created_at", id),
    updated_at: requiredOwnerText(row, "updated_at", id),
  };
}

/**
 * Issue a send key for an owner. The plaintext token is returned HERE AND NOWHERE ELSE.
 *
 * The store mints it: it generates the token, stores only its SHA-256 hash, and hands the
 * token back once. Nothing in this package logs, caches or re-reads it. See divergence 7 for
 * why the configuration-dependent refusal this used to carry is gone.
 *
 * @param store injected only by tests. There is exactly one production path, and it is
 *   `createConfiguredEmailStore()`.
 */
export async function createSendKey(
  ownerId: string,
  label?: string,
  store?: EmailStore,
): Promise<{ token: string; key: SendKey }> {
  const minted = await storeFor(store).sendKeys.mintSendKey({ owner_id: ownerId, label: label ?? null });
  if (!minted.ok) throw storeRefusal("issue a send key", minted);
  return { token: minted.value.token, key: minted.value.key };
}

/** One send key by id, or null when this installation's store holds no such key. */
export async function getSendKey(id: string, store?: EmailStore): Promise<SendKey | null> {
  const outcome = await storeFor(store).sendKeys.getSendKey(id);
  if (!outcome.ok) throw storeRefusal("read a send key", outcome);
  return outcome.value;
}

/**
 * Resolve a token to its live key, stamping `last_used_at`, or null.
 *
 * `null` for an unknown, malformed OR revoked token — one answer for all three, which is
 * what both deleted arms did and what the seam documents. It is a complete answer ("this
 * token authorizes nothing"), not a refusal to answer, and distinguishing the three would
 * tell a caller holding a wrong token which kind of wrong it is.
 */
export async function verifySendKey(token: string, store?: EmailStore): Promise<SendKey | null> {
  const outcome = await storeFor(store).sendKeys.verifySendKey(token);
  if (!outcome.ok) throw storeRefusal("verify a send key", outcome);
  return outcome.value;
}

/** Every send key, or one owner's, newest first. */
export async function listSendKeys(
  ownerId?: string,
  opts?: ListSendKeyOptions,
  store?: EmailStore,
): Promise<SendKey[]> {
  return readSendKeyWindow(storeFor(store), "list this installation's send keys", ownerId, opts);
}

/**
 * The same listing.
 *
 * Identical to `listSendKeys` now that no projection carries the hash (divergence 5), and
 * kept because it is a published export.
 */
export async function listSendKeySummaries(
  ownerId?: string,
  opts?: ListSendKeyOptions,
  store?: EmailStore,
): Promise<SendKeySummary[]> {
  return readSendKeyWindow(storeFor(store), "list this installation's send keys", ownerId, opts);
}

/** Every send key held by any of `ownerIds`, newest first. */
export async function listSendKeysByOwners(
  ownerIds: Iterable<string>,
  store?: EmailStore,
): Promise<SendKey[]> {
  return readByOwners(storeFor(store), "list send keys for a set of owners", ownerIds);
}

/** The same listing. See `listSendKeySummaries`. */
export async function listSendKeySummariesByOwners(
  ownerIds: Iterable<string>,
  store?: EmailStore,
): Promise<SendKeySummary[]> {
  return readByOwners(storeFor(store), "list send keys for a set of owners", ownerIds);
}

/**
 * Revoke a send key.
 *
 * `true` only when THIS call is the one that revoked it. An unknown id and an
 * already-revoked key both answer `false`, which is what both deleted arms did. See
 * divergence 6 for why the live check happens here rather than being left to the store, and
 * for the read-then-write race that is preserved with it.
 */
export async function revokeSendKey(id: string, store?: EmailStore): Promise<boolean> {
  const resolved = storeFor(store);
  const existing = await resolved.sendKeys.getSendKey(id);
  if (!existing.ok) throw storeRefusal("read a send key before revoking it", existing);
  if (existing.value === null) return false;
  if (existing.value.revoked_at !== null) return false;

  const revoked = await resolved.sendKeys.revokeSendKey(id);
  if (!revoked.ok) throw storeRefusal("revoke a send key", revoked);
  // Deleted between the read and the write. Not this call's revocation.
  if (revoked.value === null) return false;
  if (revoked.value.revoked_at === null) {
    throw new Error(
      `This installation's store accepted a revocation of send key ${id} and answered with a key that is `
        + "not revoked; refusing to report it as revoked",
    );
  }
  return true;
}

/**
 * Whether `ownerId` may send from `fromEmail` — it owns or administers the address.
 *
 * COMPOSED, NOT DELEGATED (divergence 1), and predicate for predicate against the deleted
 * SQLite arm's `SELECT id FROM addresses WHERE LOWER(email) = ?` followed by an ownership
 * read per row:
 *
 *   * A blank owner id or an unparseable From answers `false` WITHOUT reading anything.
 *     Neither can match: an ownership record with no owner does not authorize (see below),
 *     and `""` never equalled a stored address on either arm. It is a complete answer, so it
 *     must not be able to raise on a truncated read.
 *   * A row authorizes when its `owner_id` is set AND either that or `administrator_id`
 *     equals `ownerId`. THE "IS SET" HALF IS AN INHERITED RULE, not an omission: both arms
 *     went through an ownership read that answered null whenever `owner_id` was falsy, so an
 *     address carrying an administrator and NO owner authorized nobody. Preserved.
 *   * The email match is EXACT after canonicalisation. Nothing filters address rows on the
 *     seam, so the exactness is this function's own job.
 *   * A MATCH SHORT-CIRCUITS A TRUNCATED SCAN. Positive evidence is conclusive; the budget
 *     only bounds how long it takes to fail to find one.
 *   * NO MATCH AND A TRUNCATED SCAN RAISES. "I did not find an authorizing address" and "I
 *     did not finish looking" are different facts, and only one of them may be published as
 *     "this owner may not send" — a fabricated denial is as wrong as a fabricated approval,
 *     and it is the one a reader would act on by widening a key's scope.
 */
export async function canOwnerSendFrom(
  ownerId: string,
  fromEmail: string,
  store?: EmailStore,
): Promise<boolean> {
  const target = bareEmail(fromEmail);
  if (!target || !ownerId) return false;

  const scan = await enumerateAddresses(storeFor(store), "read this installation's sender addresses");
  for (const row of scan.rows) {
    if (canonicalAddress(row.email) !== target) continue;
    const owner = textOrNull(row.owner_id);
    if (owner === null) continue;
    if (owner === ownerId || (textOrNull(row.administrator_id) ?? owner) === ownerId) return true;
  }
  if (!scan.complete) {
    throw new Error(
      `This installation's store still had sender addresses to page through after ${MAX_ADDRESS_PAGES} `
        + "pages, so whether this owner may send from that address could not be determined; refusing to "
        + "report it as unauthorized",
    );
  }
  return false;
}

/**
 * Verify a send key AND confirm it is authorized to send from `fromEmail`.
 *
 * Throws on an invalid or revoked key, on an owner that no longer exists, and on an
 * out-of-scope From. Returns the owner. The three checks run in the deleted SQLite arm's
 * order — see divergence 9.
 *
 * A key whose `owner_id` is null is treated as an owner that no longer exists: the column is
 * nullable on the seam (the local table clears it when an owner is deleted), and a key bound
 * to nobody authorizes nothing.
 */
export async function assertSendAuthorized(
  token: string,
  fromEmail: string,
  store?: EmailStore,
): Promise<Owner> {
  const resolved = storeFor(store);
  const key = await verifySendKey(token, resolved);
  if (!key) throw new Error("Send key is invalid or revoked");

  const ownerId = key.owner_id;
  if (ownerId === null) throw new Error("Send key owner no longer exists");
  const found = await resolved.owners.get(ownerId);
  if (!found.ok) throw storeRefusal("read the owner a send key is bound to", found);
  if (found.value === null) throw new Error("Send key owner no longer exists");
  const owner = toOwner(found.value);

  if (!(await canOwnerSendFrom(owner.id, fromEmail, resolved))) {
    throw new Error(`Send key for '${owner.name}' is not authorized to send from ${bareEmail(fromEmail)}`);
  }
  return owner;
}
