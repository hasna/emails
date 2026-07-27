// Per-domain ALIASES and catch-all routing. One implementation; nothing here asks who is
// running it.
//
// An alias maps a recipient local-part on a domain to a target (owned) address; a catch-all
// maps every otherwise-unmatched recipient on a domain. There is also a single GLOBAL
// catch-all (domain `*`) that catches mail for every domain — it is `protected` and cannot be
// deleted through `removeAlias`, so no inbound is silently dropped.
//
// Resolution order, unchanged: specific alias → domain catch-all → global catch-all.
//
// WHAT THIS FILE USED TO BE. A 37-line facade whose dispatch helper read the process-wide
// deployment word and handed each of TEN exports to one of two sibling modules — a 155-line
// SQLite arm and a 170-line `curl`-bridge arm. It also carried a compatibility shim, because
// the two arms did not agree on the SHAPE of `listAliases`: the SQLite one took
// `(domain, db, opts)` and the HTTP one took `(domain, opts)`, so the facade re-ordered
// arguments on the way through and published the INTERSECTION of two incompatible signatures
// as this family's type. Every export now reaches the `aliases` table through the store seam
// (`src/store/`), is ASYNCHRONOUS because every operation on the seam is, and takes an
// injectable store defaulting to the configured one.
//
// EVERY OPERATION HAS A STORE EQUIVALENT. Unlike `src/db/forwarding.ts`, nothing in this
// family is local-only: `src/store/repositories.ts` publishes `AliasesRepository` over the
// `aliases` table, `/v1/aliases` serves it (`src/server/self-hosted/resources.ts`), and the
// self-hosted Postgres schema has the table (`src/server/self-hosted/migrations.ts`). So no
// export here requires a `Database`, and none of them needs a seam widening.
//
// ─── WHY THE TWO ARMS DID NOT AGREE, MEASURED RATHER THAN ASSUMED ────────────────────────
//
// The SQLite arm was the STRONGER one on every divergence below, and every divergence is
// resolved toward it.
//
//  1. SIX OPERATIONS READ ONE CLAMPED PAGE AND CALLED IT THE TABLE. The deleted HTTP arm
//     answered `resolveAlias`, `getGlobalCatchAll`, `listAliases`, `listAliasesByTargets` and
//     BOTH upsert dedup reads (`createAlias`/`createCatchAll`/`setGlobalCatchAll` and
//     `ensureDefaultCatchAll`) out of a single `list({ limit: 1000 })` — which the service
//     CLAMPS to 500 (`src/server/self-hosted/service.ts`) and which the SQLite resource path
//     clamps to 500 as well (`src/store-sqlite/resources.ts`, `MAX_PAGE`). Above 500 aliases
//     that arm reported "this recipient has no alias" and "there is no global catch-all" for
//     rows that exist, and turned an upsert into an INSERT that both schemas' uniqueness
//     rejects. A resolution that answers "no alias" when it means "I did not look at the whole
//     table" is the fabricated value this seam exists to remove. Every read below enumerates
//     to an EMPTY page and FAULTS if it could not finish.
//  2. ORDER. `ResourceRepository.list` promises no order and `ListOptions` admits none, and
//     the two stores genuinely disagree: the SQLite resource path orders these rows
//     `updated_at DESC, id DESC` (`describeTable` — the table has `updated_at`) and the service
//     orders them `domain ASC, local_part ASC` (the `aliases` spec). Both deleted arms
//     published "global catch-all first, then domain, then local-part". So a bounded
//     `limit`/`offset` push-down would return the first N of the STORE's order, re-sorted —
//     plausible and wrong against SQLite. The filtered set is enumerated in full, sorted here,
//     and only then windowed.
//  3. THE TWO ARMS SORTED WITH DIFFERENT COLLATIONS. The SQLite arm sorted in SQL under
//     SQLite's BINARY collation; the HTTP arm sorted in JavaScript with `localeCompare`. Those
//     disagree on case and on accents — and `localeCompare` is LOCALE-DEPENDENT, so that arm's
//     page boundaries moved with the process locale, which is not a property a paged list may
//     have. The comparison below is code-unit order: the SQLite arm's behaviour, and
//     deterministic everywhere.
//  4. UNDECLARED WRITE COLUMNS. The deleted HTTP arm sent `id`, `created_at` and `updated_at`
//     on create and `updated_at` on update. `/v1/aliases` declares FOUR writable columns —
//     `domain`, `local_part`, `target_address`, `protected` — and its request schema is
//     `additionalProperties: false` (`src/server/self-hosted/openapi.ts`), so the real
//     `HttpEmailStore` REFUSES all four of those writes; the deleted `curl` bridge did not
//     validate them. Nothing below sends a column the resource does not have. The id and both
//     timestamps come from whichever store performed the write, and both stores stamp
//     `updated_at` on an update themselves.
//  5. `protected` COMES BACK IN TWO SHAPES. SQLite has no boolean storage class and returns
//     the integer; the service's column is `bool: true` over a Postgres `BOOLEAN` and returns
//     `true`/`false`. Both are accepted — and a value that is NEITHER is a fault rather than a
//     default, because the deleted arms' coercions disagreed with each other and with the
//     truth: a bare double-negation answers `true` for the string `"no"`, and the HTTP arm's
//     boolean coercion answers `false` for `"TRUE"`. This flag is the only thing standing
//     between the global catch-all and a delete that drops every unmatched recipient's mail;
//     guessing it is not acceptable.
//  6. ABSENT IS NOT `now()`. The deleted HTTP arm read both timestamps through the shared
//     ISO coercion in `src/db/self-hosted-resource.ts`, which returns
//     `new Date().toISOString()` when the value is MISSING — so a row whose `created_at` could
//     not be read was reported as having been created at the moment it was read. Both columns
//     are `NOT NULL` in both schemas and projected by both read paths, so an absent one means
//     the store answered with something that is not an alias. That is a fault here.
//  7. `target_address` IS ALLOWED TO BE EMPTY AND NOT ALLOWED TO BE ABSENT, and the two are
//     not the same fact. The global catch-all's target is `''` by design — "keep everything, no
//     rewrite" — and the self-hosted migration sets that same text default. So an empty value
//     is a VALUE. A missing KEY is not: a store that stopped projecting the column would make
//     every alias resolve as "no forward", silently, and both deleted mappers (a string
//     coercion of `undefined` remotely, a bare property read locally) turned it into exactly
//     that empty string. Presence is required; emptiness is preserved.
//  8. THE STORES DISAGREE ABOUT WHETHER A GLOBAL CATCH-ALL EXISTS AT ALL, and that is a STORE
//     fact this module deliberately does not paper over. The SQLite migration SEEDS a protected
//     global catch-all (`INSERT OR IGNORE ... 'global-catch-all', '*', '*', ''`); the
//     self-hosted schema seeds nothing. So `getGlobalCatchAll()` answers non-null on a freshly
//     migrated local installation and null on a fresh API-backed one. Manufacturing the row
//     here to make the two look alike would be this module inventing storage state, and hiding
//     it would be worse: `ensureDefaultCatchAll` is exactly the operation a caller uses to stop
//     depending on the difference.
//
// A REFUSAL IS NEVER AN ANSWER. Every store operation below turns a typed refusal into a
// thrown error naming the operation and carrying the store's own code, status and message.
// Nothing answers `[]`, `false` or `null` for a read or a write that did not happen — and in
// particular `resolveAlias` answers `null` ONLY for a recipient the store looked for — across the
// whole of each filtered set it asked about, read to the end — and did not find.
//
// ─── ONE INHERITED DEFECT, NAMED RATHER THAN LEFT SILENT OR QUIETLY FIXED ────────────────
//
// `setGlobalCatchAll` DOES NOT PROTECT AN ALREADY-UNPROTECTED GLOBAL CATCH-ALL. Its doc
// comment says "Protected", and it is — on the INSERT path. On the UPDATE path both deleted
// arms wrote the target and nothing else, so a global catch-all row that some other writer left
// with `protected = 0` stays deletable through `removeAlias` after this function has reported it
// as the protected global catch-all. Reaching that state needs a writer other than this module
// (the SQLite migration seeds the row protected, and this module's own INSERT sets the flag),
// which is why it has never been observed.
//
// IT IS PRESERVED, NOT FIXED, and the reason is scope rather than doubt: BOTH arms behaved
// identically, so there is no divergence to resolve toward a stronger arm, and changing what a
// published write does to a column the caller did not name is a product decision rather than a
// mode-axis refactor — the line `src/db/address-lifecycle.ts` drew. The fix is one field on the
// update patch (`protected: true`, a writable column on both stores) and belongs to whoever
// owns that decision. `src/db/aliases.test.ts` pins the current behaviour under a name that
// says it is a defect, so nobody can change it silently in either direction.
//
// WHAT REPLACES THE ARM CHOICE is the store's own answer. No branch on the store kind, on the
// descriptor, or on the resolution plan. `src/store/` is untouched by this change.
//
// TWO GUARDS BELOW ARE UNREACHABLE BY CONSTRUCTION, named here so a reviewer does not have to
// re-derive it and so nobody writes a test that only appears to cover them. Mutation testing
// reverted every change in this file one at a time — 65 mutants over two rounds, the second round
// covering the guards adversarial review added — and 63 were killed. These are the two survivors:
//
//   1. `byRoute`'s `id` tiebreaker. `(domain, local_part)` is UNIQUE on SQLite and
//      `(tenant_id, domain, local_part)` on Postgres, so no two readable aliases in one scope can
//      tie on domain and local-part, and no input can reach the comparison. It stays because a
//      page boundary over a non-total order can repeat or drop a row, and because the constraint
//      is a schema fact that a migration can drop rather than a property of any type here.
//   2. `upsertAlias`'s `!localPart` half of the write guard. No export can reach it: `createAlias`
//      gets its local-part from `splitAddress`, which cannot return an empty one, and the two
//      catch-all writers pass the sentinel. The `!domain` half IS reachable — `createCatchAll("")`
//      is what the guard was added for — and is covered. This half is defence for the next writer,
//      and it costs one operator.
//
// TWO OTHER GUARDS ARE UNREACHABLE THROUGH EITHER REAL STORE AND ARE STILL TESTED, which is a
// different thing and worth distinguishing. `readOneAlias`'s "more than one row" fault sits
// behind the same uniqueness constraint, and `upsertAlias`'s post-write comparison sits behind
// both stores echoing what they persisted; each is exercised against a store whose one relevant
// method is replaced, so the branch is covered even though no production input reaches it. The
// post-write comparison is checked ONE FIELD AT A TIME for a reason the mutation run supplied: a
// single fixture that differed in all three fields killed the whole condition while leaving each
// individual term deletable, because the other two still caught that row.

import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { enumerateStoreRows } from "../lib/status-facts-enumeration.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Refusal } from "../store/outcome.js";
import type { ResourceRow } from "../store/records.js";

/** Sentinel local-part used to represent a catch-all. */
export const CATCH_ALL = "*";
/** Sentinel domain used to represent "all domains". */
export const ALL_DOMAINS = "*";

export interface Alias {
  id: string;
  domain: string;
  local_part: string;
  target_address: string;
  protected: boolean;
  created_at: string;
  updated_at: string;
}

export interface ListAliasOptions {
  limit?: number;
  offset?: number;
}

/**
 * Pages one alias enumeration may fetch, at 500 rows a page — about 99,800 aliases (every page
 * after the first re-requests the row it ended on, so it carries 499 fresh rows rather than 500).
 *
 * Deliberately far above the shared default (40 pages) because the reads below need the whole
 * filtered set to answer correctly: the list has to sort before it windows, the target lookup
 * has to compare every stored target, and an upsert has to be sure the row it is about to
 * insert does not already exist. Running out is reported as an exception, never as a smaller
 * answer — which is header note 1's whole point.
 */
const MAX_ALIAS_ROW_PAGES = 200;

/**
 * The refusal, thrown.
 *
 * Names the OPERATION and carries the store's own code, status and message. It names no setting
 * and no command: a refusal that tells the caller which variable to flip is a refusal
 * documenting its own bypass.
 */
function storeRefusal(what: string, refusal: Refusal): Error {
  return new Error(
    `This installation's store cannot ${what} (${refusal.code}, ${refusal.status}): ${refusal.message}`,
  );
}

/**
 * `local@domain`, split and lower-cased, or a throw.
 *
 * Verbatim from both deleted arms, including the two rejections: an address with no local part
 * and an address with nothing after the `@`. `src/mcp/contracts.test.ts` pins the exact message
 * because the MCP error classifier keyword-matches over it.
 */
function splitAddress(address: string): { local_part: string; domain: string } {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) {
    throw new Error(`Invalid email address (expected local@domain): ${address}`);
  }
  return { local_part: address.slice(0, at).toLowerCase(), domain: address.slice(at + 1).toLowerCase() };
}

function rowText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * A required text column, or a fault.
 *
 * Used for the identity, the domain, the local-part and both timestamps: all five are
 * `NOT NULL` in both schemas and projected by both read paths, so an absent one means the store
 * answered with a row that is not an alias. Header note 6 records what the deleted arm did with
 * an absent timestamp instead. `target_address` is NOT read through this — see
 * `requiredTarget`.
 */
function requiredText(row: ResourceRow, column: string): string {
  const text = rowText(row[column]);
  if (!text) {
    throw new Error(
      `Alias row ${rowText(row["id"]) || "(no id)"} has no readable ${column}; `
        + "refusing to report it as an alias",
    );
  }
  return text;
}

/**
 * The target address: PRESENT, possibly EMPTY.
 *
 * Header note 7. `''` is the global catch-all's documented target and means "keep, no rewrite",
 * so emptiness is a value and must survive. A missing KEY is a different fact and is a fault:
 * the deleted mappers turned it into the same empty string, which would report every alias in
 * the table as forwarding nowhere.
 */
function requiredTarget(row: ResourceRow): string {
  if (!Object.hasOwn(row, "target_address")) {
    throw new Error(
      `Alias row ${rowText(row["id"]) || "(no id)"} has no target_address column at all; `
        + "refusing to report it as an alias that forwards nowhere",
    );
  }
  const value = row["target_address"];
  if (value === null || value === undefined) {
    throw new Error(
      `Alias row ${rowText(row["id"]) || "(no id)"} has a null target_address, which neither `
        + "schema admits; refusing to report it as an alias that forwards nowhere",
    );
  }
  return String(value);
}

/**
 * `protected`, in whichever of the two shapes a store hands it back — and a FAULT for anything
 * else.
 *
 * Header note 5. SQLite returns `0`/`1`, the service returns `true`/`false`, and both are
 * accepted. What is not accepted is a value that is neither, because this flag decides whether
 * the catch-all that keeps unmatched mail from being dropped can be deleted, and the two
 * deleted coercions answered confidently and differently about strings.
 */
function requiredProtected(row: ResourceRow): boolean {
  const value = row["protected"];
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  throw new Error(
    `Alias row ${rowText(row["id"]) || "(no id)"} has no readable protected flag `
      + `(${JSON.stringify(value) ?? String(value)}); refusing to guess whether it can be deleted`,
  );
}

/** A stored row, mapped to `Alias`. */
function toAlias(row: ResourceRow): Alias {
  return {
    id: requiredText(row, "id"),
    domain: requiredText(row, "domain"),
    local_part: requiredText(row, "local_part"),
    target_address: requiredTarget(row),
    protected: requiredProtected(row),
    created_at: requiredText(row, "created_at"),
    updated_at: requiredText(row, "updated_at"),
  };
}

/**
 * Code-unit order, not `localeCompare`.
 *
 * Header note 3: the SQLite arm sorted under that engine's BINARY collation and the HTTP arm
 * under the process locale, and only one of those gives the same page boundaries on every
 * machine.
 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The global catch-all first, then by domain, then by local-part, then by id.
 *
 * The first three are what both deleted arms published. The `id` tiebreaker is unreachable by
 * construction (see the header) and is there because a page boundary over a non-total order can
 * repeat or drop a row, and because uniqueness here is a schema constraint rather than a type.
 */
function byRoute(a: Alias, b: Alias): number {
  return (
    Number(b.domain === ALL_DOMAINS) - Number(a.domain === ALL_DOMAINS)
    || compareText(a.domain, b.domain)
    || compareText(a.local_part, b.local_part)
    || compareText(a.id, b.id)
  );
}

/**
 * The store this call should use: the injected one, or the configured one.
 *
 * Built per call rather than at module load, because a contradictory storage configuration is a
 * boot error raised by the resolution and it belongs to the call that needed a store, not to
 * whoever imported this module first.
 */
function storeFor(store: EmailStore | undefined): EmailStore {
  return store ?? createConfiguredEmailStore();
}

/**
 * Read every stored alias matching `filters`, or explain why not.
 *
 * PAGED TO AN EMPTY PAGE, never to a short one, and a scan that did not finish throws. Every
 * caller needs the WHOLE filtered set — to sort and window it, to compare every target, or to
 * be sure an upsert's row does not already exist — so a partial read cannot answer any of their
 * questions. See `src/lib/status-facts-enumeration.ts` for why "shorter than I asked for"
 * proves nothing about the end of a table.
 *
 * THE FILTER IS RE-ASSERTED ON WHAT COMES BACK. The service's generic list route IGNORES a
 * query parameter it does not declare and answers with the unfiltered list — a superset
 * presented as a filtered result. That is a wrong result rather than a value, so it is treated
 * as a fault. (The HTTP store already refuses an undeclared filter up front by reading the
 * published contract; this catches a store that accepts the filter and then does not apply it,
 * which no type can rule out.)
 */
async function readAliases(
  store: EmailStore,
  what: string,
  filters: Record<string, string>,
  matches: (alias: Alias) => boolean,
): Promise<Alias[]> {
  const enumeration = await enumerateStoreRows<ResourceRow>(
    (opts) => store.aliases.list({
      ...opts,
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
    }),
    {
      pageBudget: MAX_ALIAS_ROW_PAGES,
      idOf: (row) => (typeof row["id"] === "string" ? row["id"] : null),
    },
  );
  if (enumeration.refusal) throw storeRefusal(what, enumeration.refusal);
  if (enumeration.fault !== null) {
    throw new Error(`This installation's store faulted while it ${what}: ${enumeration.fault}`);
  }
  if (!enumeration.complete) {
    throw new Error(
      `This installation's aliases could not be read to the end (pages: ${enumeration.pages}, `
        + `duplicates: ${enumeration.duplicates}, shifted: ${enumeration.shifted}), so they cannot be `
        + "ordered or searched; refusing to answer from part of the table",
    );
  }
  const aliases = enumeration.rows.map(toAlias);
  for (const alias of aliases) {
    if (!matches(alias)) {
      throw new Error(
        "This installation's store answered a filtered alias read with rows outside the filter; "
          + "refusing to treat them as the requested aliases",
      );
    }
  }
  return aliases.sort(byRoute);
}

/**
 * The one alias at `(domain, local_part)`, or null.
 *
 * Both columns are declared filters on both stores, so this is a PUSH-DOWN and not a scan — and
 * it is still ENUMERATED, because a page holding the row it was asked for looks exactly like a
 * page that was clamped. That is the difference between this and the deleted HTTP arm, which
 * answered the same question out of one bounded page (header note 1).
 *
 * TWO ROWS IS A FAULT, not a pick. `(domain, local_part)` is UNIQUE on SQLite and
 * `(tenant_id, domain, local_part)` on Postgres, so this is unreachable through either store
 * today; if it ever fires, two rows claim to route the same recipient and choosing between them
 * would silently send someone's mail to one of two places.
 *
 * THE COST, STATED RATHER THAN LEFT TO BE DISCOVERED: enumerating to an empty page is TWO store
 * round trips per lookup even on a unique key, so `resolveAlias` costs up to six and
 * `emails alias list` about ten against an API store where the deleted arm cost three or four.
 * `src/lib/delivery-doctor.ts` performs the SAME three-step resolution with `limit: 1` and both
 * filters pushed down — one request per step — and the difference is deliberate rather than an
 * oversight: that module reports DIAGNOSTIC facts and may bound a read, while this one decides
 * where a recipient's mail goes and may not confuse "the page I asked for was clamped" with "no
 * such alias".
 */
async function readOneAlias(
  store: EmailStore,
  what: string,
  domain: string,
  localPart: string,
): Promise<Alias | null> {
  const found = await readAliases(
    store,
    what,
    { domain, local_part: localPart },
    (alias) => alias.domain === domain && alias.local_part === localPart,
  );
  if (found.length > 1) {
    throw new Error(
      `This installation's store holds ${found.length} aliases for ${localPart}@${domain}, which `
        + "neither schema admits; refusing to choose which one routes the mail",
    );
  }
  return found[0] ?? null;
}

/**
 * Create the alias at `(domain, local_part)`, or update the one already there.
 *
 * The upsert key is `(domain, local_part)` — both schemas' uniqueness — and both columns are
 * pushed down as filters because both stores declare them. The enumeration still runs to the
 * end: the filters narrow the read, they do not bound it, which is the difference between this
 * and the deleted arm's single clamped page (header note 1).
 *
 * NEITHER `id` NOR EITHER TIMESTAMP IS SENT. `/v1/aliases` has no such writable column and its
 * request schema is closed, so naming them would make the HTTP store refuse the write outright
 * (header note 4); each store mints the id and stamps its own clock.
 *
 * `protected` IS SENT ON THE INSERT AND NOT ON THE UPDATE, which is both deleted arms'
 * behaviour and the inherited defect the header names. Do not "tidy" it without reading that
 * paragraph.
 */
async function upsertAlias(
  store: EmailStore,
  domain: string,
  localPart: string,
  target: string,
  isProtected: boolean,
): Promise<Alias> {
  // THE ROW IS VALIDATED BEFORE IT IS SENT, TO THE SAME STANDARD THE READ PATH APPLIES.
  //
  // This is the one place the collapse was ASYMMETRIC and it was a real regression, found by
  // adversarial review. `requiredText` faults on an empty `domain` or `local_part` on the way
  // OUT, so a write that stored one committed a row this module then refused to read — and
  // because `getAlias` maps the row, `removeAlias` could not delete it either. `createAlias`
  // cannot produce it (`splitAddress` guarantees both halves) and `setGlobalCatchAll` cannot
  // (both are the sentinel), but `createCatchAll("")` reached the store, and so did MCP
  // `add_catch_all` with an empty domain. The deleted SQLite arm wrote the same row and
  // TOLERATED it on read — its mapper was a spread with no validation — so the poison was
  // invisible rather than absent.
  //
  // Validating the write is the fix rather than relaxing the read: a stored alias with no domain
  // or no local-part routes nothing and can never match a recipient, so accepting it would be
  // accepting a row that cannot mean anything. `removeAlias` is separately able to delete a row
  // it refuses to REPORT, so a row an older version already wrote stays recoverable.
  if (!domain || !localPart) {
    throw new Error(
      `An alias needs a domain and a local part; received ${JSON.stringify(localPart)}@${JSON.stringify(domain)}.`,
    );
  }
  const existing = await readOneAlias(store, "read this installation's aliases", domain, localPart);
  const written = existing
    ? await store.aliases.update(existing.id, { target_address: target })
    : await store.aliases.create({
      domain,
      local_part: localPart,
      target_address: target,
      protected: isProtected,
    });
  if (!written.ok) throw storeRefusal(existing ? "update an alias" : "store an alias", written);
  if (written.value === null) {
    // `update` answers `null` for a row that is not there. The read above just saw it, so this
    // is a row deleted underneath us rather than a missing one — reported instead of being
    // retried as an insert, which would race the same deletion again.
    throw new Error(`Alias not found: ${existing?.id ?? "(unknown)"}`);
  }

  // THE RETURNED ROW IS CHECKED AGAINST WHAT WAS WRITTEN. The service's generic route ACCEPTS a
  // body key the resource has no column for and drops it silently; both stores refuse an
  // unknown column today, and this is what notices if one ever stops.
  const alias = toAlias(written.value);
  if (alias.domain !== domain || alias.local_part !== localPart || alias.target_address !== target) {
    throw new Error(
      "This installation's store accepted an alias write and answered with a different row; "
        + "refusing to report the alias as saved",
    );
  }
  return alias;
}

/** Create (or update) a specific alias: `alias@domain` → `target`. */
export async function createAlias(aliasAddress: string, target: string, store?: EmailStore): Promise<Alias> {
  const { local_part, domain } = splitAddress(aliasAddress);
  return upsertAlias(storeFor(store), domain, local_part, target.toLowerCase(), false);
}

/** Create (or update) a catch-all for `domain` → `target`. */
export async function createCatchAll(domain: string, target: string, store?: EmailStore): Promise<Alias> {
  return upsertAlias(storeFor(store), domain.toLowerCase(), CATCH_ALL, target.toLowerCase(), false);
}

/**
 * Create (or update) the GLOBAL catch-all (all domains) → `target`. Protected.
 *
 * "Protected" holds on the INSERT only. See the inherited defect in the header before changing
 * that: an existing row left unprotected by another writer stays unprotected here.
 */
export async function setGlobalCatchAll(target: string, store?: EmailStore): Promise<Alias> {
  return upsertAlias(storeFor(store), ALL_DOMAINS, CATCH_ALL, target.toLowerCase(), true);
}

/**
 * Ensure the protected global catch-all exists (target defaults to empty = keep everything, no
 * rewrite). Idempotent — safe to call on every startup.
 *
 * IT ENSURES EXISTENCE AND NOTHING ELSE, which is both deleted arms' behaviour: an existing
 * global catch-all is returned exactly as stored, with whatever target and whatever `protected`
 * flag it carries. It does not reset the target to empty and does not protect an unprotected
 * row.
 *
 * Header note 8 is the reason this operation exists: a freshly migrated SQLite installation
 * already has the row and a fresh API-backed one does not, and calling this is how a caller
 * stops depending on which.
 */
export async function ensureDefaultCatchAll(store?: EmailStore): Promise<Alias> {
  const target = storeFor(store);
  const existing = await readOneAlias(
    target,
    "read this installation's global catch-all",
    ALL_DOMAINS,
    CATCH_ALL,
  );
  if (existing) return existing;
  return upsertAlias(target, ALL_DOMAINS, CATCH_ALL, "", true);
}

/**
 * The global catch-all, or `null` when this installation has none.
 *
 * `null` here means the store read the whole of the filtered set to the end and found nothing.
 * The deleted HTTP arm
 * answered the same `null` after looking at one clamped page, so on an installation with more
 * than 500 aliases it reported no global catch-all while the row sat in the table (header
 * note 1).
 */
export async function getGlobalCatchAll(store?: EmailStore): Promise<Alias | null> {
  return readOneAlias(
    storeFor(store),
    "read this installation's global catch-all",
    ALL_DOMAINS,
    CATCH_ALL,
  );
}

/**
 * One alias by id, or `null` when no such alias exists in scope.
 *
 * `null` means the store looked and found nothing — a refusal throws instead, so "there is no
 * such alias" is never confused with "I could not look".
 */
export async function getAlias(id: string, store?: EmailStore): Promise<Alias | null> {
  const read = await storeFor(store).aliases.get(id);
  if (!read.ok) throw storeRefusal("read an alias", read);
  if (read.value === null) return null;
  const alias = toAlias(read.value);
  // The id is re-asserted because a by-id read that answers with ANOTHER row is a wrong result
  // rather than a value, and the caller has no way to notice: it asked for one row and got one
  // row. Both stores match the key exactly today; this is what catches a store that starts
  // resolving an id PREFIX, which the message family's seam deliberately does and which would
  // be a silent identity change here.
  if (alias.id !== id) {
    throw new Error(
      "This installation's store answered an alias read by id with a different row; "
        + "refusing to report it as the requested alias",
    );
  }
  return alias;
}

/**
 * Aliases — the global catch-all first, then by domain, then by local-part — with the deleted
 * arms' exact paging.
 *
 * `limit` is optional and `undefined` means EVERY matching alias; `offset` is honoured only
 * when a limit was given, which is what both deleted arms did (the SQLite one appended
 * `LIMIT ? OFFSET ?` only when a limit was present, and the HTTP one returned the unsliced
 * array). That is preserved rather than tidied: an offset that started working on its own would
 * silently change what an existing caller sees.
 *
 * THE PAGE IS SLICED FROM A COMPLETE READ, because there is no push-down available — the seam
 * publishes no ordering and the two stores order this table differently (header note 2). The
 * `domain` filter IS pushed down, because both stores declare it.
 */
export async function listAliases(
  domain?: string,
  opts?: ListAliasOptions,
  store?: EmailStore,
): Promise<Alias[]> {
  // AN EMPTY DOMAIN MEANS "NO FILTER", which is what BOTH deleted arms did — each tested the
  // argument for truthiness (`domain ? filtered : unfiltered`), not for `undefined`. Testing for
  // `undefined` instead made `listAliases("")` filter on an empty domain and answer `[]`,
  // reachable through `emails alias list --domain ""` and the MCP tool. The two arms AGREED here,
  // so there is no stronger arm to resolve toward and changing it would have been a product
  // decision smuggled into a mode-axis refactor. Found by adversarial review.
  const wanted = domain ? domain.toLowerCase() : undefined;
  const aliases = await readAliases(
    storeFor(store),
    "list this installation's aliases",
    wanted === undefined ? {} : { domain: wanted },
    (alias) => wanted === undefined || alias.domain === wanted,
  );
  const limit = safeOptionalLimit(opts?.limit);
  if (limit === null) return aliases;
  const offset = safeOffset(opts?.offset);
  return aliases.slice(offset, offset + limit);
}

/**
 * Aliases that route to any of the given target addresses.
 *
 * AN EMPTY TARGET SET ANSWERS `[]` WITHOUT TOUCHING THE STORE, and that is a value rather than
 * a fabrication: no targets were asked about, so no alias can match. Both arms did this.
 *
 * NO PRODUCTION CALLER TODAY. The only caller in the tree is this family's own suite; the export
 * is kept because a collapse may not change this family's published surface, so the cost note
 * below is a property of the contract rather than a bill anyone is currently paying.
 *
 * `target_address` IS A DECLARED FILTER ON BOTH STORES AND IS DELIBERATELY NOT PUSHED DOWN.
 * Both deleted arms matched the STORED target case-INSENSITIVELY — the SQLite one with
 * `LOWER(target_address) IN (...)`, the HTTP one by lower-casing each row — while the seam's
 * filter is exact equality. So a push-down of the lower-cased target would silently miss a row
 * some other writer stored as `Ops@Example.com`, which is a narrower answer wearing the same
 * shape as the right one. The whole table is read and compared here instead.
 */
export async function listAliasesByTargets(
  targets: Iterable<string>,
  store?: EmailStore,
): Promise<Alias[]> {
  const normalized = new Set([...targets].map((target) => target.trim().toLowerCase()).filter(Boolean));
  if (normalized.size === 0) return [];
  const aliases = await readAliases(
    storeFor(store),
    "list this installation's aliases by target",
    {},
    () => true,
  );
  return aliases.filter((alias) => normalized.has(alias.target_address.toLowerCase()));
}

/**
 * Remove an alias. Refuses to delete a protected one (the global catch-all).
 *
 * `false` means there was no such alias to delete; a store that could not perform the delete
 * throws, because `false` would otherwise read as "already gone".
 */
export async function removeAlias(id: string, store?: EmailStore): Promise<boolean> {
  const target = storeFor(store);
  // THE ROW IS READ WITHOUT BEING FULLY MAPPED, and that is deliberate rather than a shortcut.
  //
  // The only property this operation has to establish is whether the row is PROTECTED. Going
  // through `getAlias` would additionally require every other column to be readable, which makes
  // a corrupt row — one an older version of this module could write, see `upsertAlias` —
  // impossible to delete through any published surface. `requiredProtected` still faults on a
  // flag it cannot read, because deleting something that might be the global catch-all is the one
  // mistake this function exists to prevent.
  const read = await target.aliases.get(id);
  if (!read.ok) throw storeRefusal("read an alias", read);
  if (read.value === null) return false;
  // The id is re-asserted for the reason `getAlias` gives: a by-id read answered with another row
  // is a wrong result the caller cannot notice, and here it would delete the wrong alias.
  if (rowText(read.value["id"]) !== id) {
    throw new Error(
      "This installation's store answered an alias read by id with a different row; "
        + "refusing to delete it as the requested alias",
    );
  }
  if (requiredProtected(read.value)) throw new Error("This catch-all is protected and cannot be deleted.");
  const removed = await target.aliases.remove(id);
  if (!removed.ok) throw storeRefusal("remove an alias", removed);
  return removed.value;
}

/**
 * Resolve a recipient address to its target via aliases:
 *   specific alias → domain catch-all → global catch-all.
 *
 * `null` MEANS THE STORE LOOKED AND FOUND NOTHING, and that is the whole point of this rewrite.
 * The deleted HTTP arm answered `null` from one clamped page, so above 500 aliases it reported
 * "no alias" for a recipient whose alias existed — mail delivered as-is instead of being routed
 * (header note 1). Every lookup below is a filtered enumeration, and anything the store could
 * not answer is a throw.
 *
 * A RECIPIENT WITH NO LOCAL PART OR NO DOMAIN ALSO ANSWERS `null`, verbatim from both arms, and
 * it is a real answer rather than a swallowed error: every stored alias has a domain and a
 * local-part, so an address that has neither cannot match one. `createAlias` still THROWS on the
 * same input, which is the difference between "route this" and "store this".
 *
 * AN EMPTY TARGET FALLS THROUGH TO THE NEXT STEP, also verbatim: the global catch-all's `''`
 * means "keep, no rewrite", and both arms chained their three lookups with `||`, so a matched
 * alias with an empty target does not stop the search.
 */
export async function resolveAlias(recipient: string, store?: EmailStore): Promise<string | null> {
  let local_part: string;
  let domain: string;
  try {
    ({ local_part, domain } = splitAddress(recipient));
  } catch {
    return null;
  }
  const target = storeFor(store);
  // The three steps can name the SAME row — a recipient of `*@acme.com` makes steps one and two
  // identical, and `x@*` makes steps two and three identical — so a read is remembered rather
  // than repeated. Both deleted arms issued the duplicate lookup; the answer is the same either
  // way, and one fewer round trip on the routing path is worth the map.
  const seen = new Map<string, Alias | null>();
  for (const [aliasDomain, aliasLocalPart] of [
    [domain, local_part],
    [domain, CATCH_ALL],
    [ALL_DOMAINS, CATCH_ALL],
  ] as const) {
    const key = `${aliasDomain} ${aliasLocalPart}`;
    if (!seen.has(key)) {
      seen.set(
        key,
        await readOneAlias(target, "resolve a recipient's alias", aliasDomain, aliasLocalPart),
      );
    }
    const found = seen.get(key) ?? null;
    if (found && found.target_address) return found.target_address;
  }
  return null;
}
