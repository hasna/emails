// App-level inbound FORWARDING. One implementation; nothing here asks who is running it.
//
// WHAT THIS FILE USED TO BE. A 30-line facade whose dispatch helper read the process-wide
// deployment word and handed each of SEVEN exports to one of two sibling modules —
// `forwarding.local.ts` (209 lines, SQLite) and `forwarding.remote.ts` (158 lines, the
// `curl` bridge). It also carried a `localCompat` shim, because the two arms did not even
// agree on the SHAPE of `listPendingForwarding`: local took `(limit, db, opts)` and the
// HTTP arm took `(limit, opts)`, so the facade re-ordered arguments on the way through and
// published the INTERSECTION of two incompatible signatures as this family's type.
//
// FIVE OF THE SEVEN EXPORTS ARE THE FORWARDING-RULE TABLE, and neither arm decided
// anything about what a rule MEANS; they decided who ran the SQL. Those five now reach
// `forwarding_rules` through the store seam (`src/store/`), are ASYNCHRONOUS because every
// operation on the seam is, and take an injectable store defaulting to the configured one.
//
// THE OTHER TWO ARE NOT AN ARM CHOICE AT ALL, and this is the one thing a reader must know
// about this family. `listPendingForwarding` and `recordForwardingDelivery` read and write
// `forwarding_deliveries` and join it against `inbound_recipients` / `inbound_emails`. That
// table and that join exist in LOCAL SQLITE AND NOWHERE ELSE:
//
//   * `src/store/` publishes ONE forwarding repository, over `forwarding_rules`
//     (repositories.ts, `ForwardingRepository`). There is no deliveries repository and no
//     pending-forward projection.
//   * `/v1` has no forwarding-deliveries resource (`src/store-http/routes.ts`,
//     `RESOURCE_PATHS`; the service's registry in `src/server/self-hosted/resources.ts`
//     declares `forwarding` over `forwarding_rules` and nothing else).
//   * the self-hosted Postgres schema HAS NO SUCH TABLE — the migration creates
//     `forwarding_rules` and stops (`src/server/self-hosted/migrations.ts`).
//
// So there never were two implementations of those two operations: there was ONE, in the
// local arm, and a stub in the HTTP arm that threw. Collapsing them means deleting the stub
// and keeping the implementation — and making the storage they operate on IMPOSSIBLE TO
// LEAVE UNSTATED. Both now REQUIRE the `Database` they read, so:
//
//   * a caller that has local storage in hand keeps exactly today's behaviour (the deleted
//     facade already routed any call carrying a `Database` to the local arm regardless of
//     the deployment word — see the deleted `hasDatabaseArgument`), and
//   * a caller that does NOT have local storage gets a `tsc` error rather than an empty
//     pending list. "Nothing to forward" and "I cannot see the ledger" are different
//     answers, and a default `getDatabase()` here would have merged them: on an
//     API-configured installation it would open an empty local file and report the inbox
//     as fully forwarded.
//
// Deleting them outright was the other option and was rejected. `emails forwarding run`
// works today on a local installation, and removing a working feature is a product
// decision rather than a refactor. THE HONEST FIX IS A SEAM WIDENING, described here so
// the next db collapse can cost it: a `listPendingForwarding` / `recordForwardingDelivery`
// pair on `ForwardingRepository` (or a separate deliveries repository), gated on a new
// capability, plus the server-side table and the `/v1` routes behind it.
// `sendIntentLedger` cannot stand in — both stores declare it FALSE
// (`src/store-sqlite/index.ts`, `src/store-http/index.ts`), so delegating to it would ship
// a forwarding pipeline that refuses on every configuration this package can run in, which
// is the trap `src/db/address-lifecycle.ts` records for `getAddressSendability`.
//
// ─── WHY THE TWO STORES DID NOT AGREE ABOUT THE RULE TABLE ───────────────────────────
//
//  1. ORDER. `ResourceRepository.list` promises no order and `ListOptions` admits none, and
//     the two implementations genuinely disagree: the SQLite resource path orders these rows
//     `updated_at DESC, id DESC` (`src/store-sqlite/resources.ts`, `describeTable` — the
//     table has `updated_at`) and the service orders them `source_address ASC,
//     target_address ASC` (`src/server/self-hosted/resources.ts`, the `forwarding` spec).
//     Both deleted arms published "by source then target". So a `LIMIT`/`OFFSET` push-down
//     would have returned the first N of the STORE's order, re-sorted — plausible and wrong
//     against SQLite. The filtered set is enumerated to an EMPTY page, sorted here, and then
//     windowed; an enumeration that could not be finished THROWS rather than serving a slice
//     of what it managed to read.
//  2. `enabled` IS NOT A SERVER FILTER. The service declares `source_address`,
//     `target_address` and `mode` (same spec), so `/v1/forwarding?enabled=` is not a filter
//     the route accepts — the HTTP store refuses it up front by reading the published
//     contract, while SQLite accepts it because it is a real column. It is therefore applied
//     HERE, to rows this module has already read, which is the only way both stores answer
//     the same question.
//  3. THE DEDUP READ WAS BOUNDED AT ONE PAGE. `createForwardingRule` is an upsert on
//     `(source_address, target_address, mode)`. The deleted HTTP arm looked for the existing
//     row inside a single `list({ limit: 1000 })` — which the service CLAMPS to 500 — so on
//     an installation with more than 500 rules it MISSED the row it was supposed to update
//     and attempted an insert that both schemas' `UNIQUE(source_address, target_address,
//     mode)` rejects. This implementation pushes all three key columns down as filters
//     (declared on both stores) and still enumerates to the end.
//  4. UNDECLARED WRITE COLUMNS. The deleted HTTP arm sent `id`, `created_at` and
//     `updated_at` on create and `updated_at` on update. `/v1/forwarding` declares six
//     writable columns and its request schema is `additionalProperties: false`
//     (`src/server/self-hosted/openapi.ts`), so the real `HttpEmailStore` REFUSES all four
//     of those writes — the deleted `curl` bridge did not validate them. Nothing below sends
//     a column the resource does not have; the id and both timestamps come from whichever
//     store performed the write.
//  5. `mode` IS CONSTRAINED BY ONE STORE ONLY. SQLite has `CHECK(mode IN ('app-copy'))`
//     (`src/db/database.ts`); the self-hosted migration DROPS
//     `forwarding_rules_mode_check` (`src/server/self-hosted/migrations.ts`). So an
//     out-of-enum mode was refused by one store and accepted by the other, and both deleted
//     read mappers then CAST whatever came back to `ForwardingMode` — a value the type does
//     not admit, on a field `src/cli/commands/forwarding.ts` prints next to every rule. It
//     is validated on the way in and on the way out here, which makes both stores answer
//     the same way and makes the answer the one that does not corrupt the table.
//  6. `enabled` COMES BACK IN TWO SHAPES. SQLite has no boolean storage class and returns
//     the integer; the service's column is `bool: true` over a Postgres `BOOLEAN` and
//     returns `true`/`false`. Both are accepted — and a value that is NEITHER is a fault
//     rather than a default, because the deleted arms' coercions (`!!row.enabled` locally,
//     `cbool` remotely) both answer `true` for the string `"no"` and `cbool` answers `false`
//     for `"TRUE"`. `enabled` decides whether mail is copied to a third party; guessing it
//     is not acceptable.
//  7. ABSENT IS NOT `now()`. The deleted HTTP arm read both timestamps through `ciso`
//     (`src/db/self-hosted-resource.ts`), which returns `new Date().toISOString()` when the
//     value is MISSING — so a row whose `created_at` could not be read was reported as
//     having been created at the moment it was read. Both columns are `NOT NULL` in both
//     schemas and projected by both read paths, so an absent one means the store answered
//     with something that is not a forwarding rule. That is a fault here.
//
// A REFUSAL IS NEVER AN ANSWER. Every store operation below turns a typed refusal into a
// thrown error naming the operation and carrying the store's own code, status and message.
// Nothing answers `[]`, `false` or `null` for a read or a write that did not happen.
//
// WHAT REPLACES THE ARM CHOICE is the store's own answer. No branch on the store kind, on
// the descriptor, or on the resolution plan. `src/store/` is untouched by this change.
//
// THREE GUARDS BELOW ARE UNREACHABLE BY CONSTRUCTION, and they are named here so a reviewer
// does not have to re-derive it and so nobody writes a test that only appears to cover them.
// Mutation testing reverted each change in this file one at a time; 27 of 30 mutants were
// killed and these three survived, each because no input can reach the branch today:
//
//   1. `byRoute`'s `mode` and `id` tiebreakers. `ForwardingMode` has exactly ONE legal value,
//      `toRule` faults on any other, and `(source_address, target_address, mode)` is UNIQUE
//      on both schemas — so no two readable rules can tie. They exist for the day the enum
//      grows, which is the day the tie becomes reachable.
//   2. `recordForwardingDelivery`'s read-back null check. The row was written on the same
//      connection two statements earlier.
//   3. `listPendingForwarding`'s `requiredText(row, "inbound_email_id")`. It comes from
//      `inbound_emails.id`, a non-null PRIMARY KEY the query JOINs on.
//
// Every other guard in this file is killed by a test.

import type { Database } from "./database.js";
import { uuid } from "./runtime.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { enumerateStoreRows } from "../lib/status-facts-enumeration.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Refusal } from "../store/outcome.js";
import type { ResourceRow } from "../store/records.js";

export type ForwardingMode = "app-copy";
export type ForwardingDeliveryStatus = "sent" | "failed";

export interface ForwardingRule {
  id: string;
  source_address: string;
  target_address: string;
  mode: ForwardingMode;
  provider_id: string | null;
  from_address: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ForwardingDelivery {
  id: string;
  rule_id: string;
  inbound_email_id: string;
  sent_email_id: string | null;
  status: ForwardingDeliveryStatus;
  error: string | null;
  created_at: string;
}

export interface PendingForwarding {
  rule: ForwardingRule;
  inbound_email_id: string;
}

export interface ListForwardingRulesOptions {
  source_address?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateForwardingRuleInput {
  source_address: string;
  target_address: string;
  mode?: ForwardingMode;
  provider_id?: string | null;
  from_address?: string | null;
  enabled?: boolean;
}

export interface RecordForwardingDeliveryInput {
  rule_id: string;
  inbound_email_id: string;
  sent_email_id?: string | null;
  status: ForwardingDeliveryStatus;
  error?: string | null;
}

const MODES = new Set<string>(["app-copy"]);
const DELIVERY_STATUSES = new Set<string>(["sent", "failed"]);

/**
 * Pages one rule enumeration may fetch, at 500 rows a page — 100_000 rules.
 *
 * Deliberately far above the shared default (40 pages) because every read below needs the
 * whole filtered set to answer correctly: the list has to sort before it windows, and the
 * upsert has to be sure the row it is about to insert does not already exist. Running out is
 * reported as an exception, never as a smaller answer.
 */
const MAX_RULE_ROW_PAGES = 200;

/** The largest `limit` the pending-forward scan accepts, unchanged from the deleted arm. */
const MAX_PENDING_LIMIT = 1000;

interface ForwardingDeliveryRow extends Omit<ForwardingDelivery, "status"> {
  status: string;
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

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`Invalid email address: ${value}`);
  }
  return email;
}

/**
 * An out-of-enum `mode`, refused before either store is touched.
 *
 * Only ONE of the two stores constrains this column (header note 5), so without this the
 * same input is a refusal on SQLite and an accepted row on the service — and the accepted
 * row is then unreadable, because `toRule` validates the enum on the way out. Refusing the
 * write is the only answer that leaves the table readable.
 */
function assertWritableMode(mode: string): ForwardingMode {
  if (!MODES.has(mode)) {
    throw new Error(`Forwarding mode must be app-copy; received: ${mode || "(empty)"}`);
  }
  return mode as ForwardingMode;
}

function rowText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function rowTextOrNull(value: unknown): string | null {
  const text = rowText(value);
  return text ? text : null;
}

/**
 * A required text column, or a fault.
 *
 * Used for the identity, the two addresses and the two timestamps: all five are `NOT NULL`
 * in both schemas and projected by both read paths, so an absent one means the store
 * answered with a row that is not a forwarding rule. Header note 7 records what the deleted
 * arm did with an absent timestamp instead.
 */
function requiredText(row: ResourceRow, column: string): string {
  const text = rowText(row[column]);
  if (!text) {
    throw new Error(
      `Forwarding rule row ${rowText(row["id"]) || "(no id)"} has no readable ${column}; `
        + "refusing to report it as a forwarding rule",
    );
  }
  return text;
}

/**
 * `enabled`, in whichever of the two shapes a store hands it back — and a FAULT for
 * anything else.
 *
 * SQLite has no boolean storage class and returns `0`/`1`; the service's column is a
 * Postgres `BOOLEAN` and comes back as `true`/`false` over JSON. Both are accepted. What is
 * NOT accepted is a value that is neither, and that is the strictness the deleted arms
 * lacked: `!!"no"` is `true` and `cbool("TRUE")` is `false`, so both of them would have
 * answered confidently and wrongly about whether a rule that copies mail to a third party
 * is switched on.
 */
function requiredEnabled(row: ResourceRow): boolean {
  const value = row["enabled"];
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  throw new Error(
    `Forwarding rule row ${rowText(row["id"]) || "(no id)"} has no readable enabled flag `
      + `(${JSON.stringify(value) ?? String(value)}); refusing to guess whether it forwards mail`,
  );
}

/**
 * A stored row, mapped to `ForwardingRule`.
 *
 * `mode` IS VALIDATED AND NOT CAST, for the reason header note 5 gives: only one store
 * constrains the column, so the value really can be something the type does not admit — and
 * both deleted mappers cast it straight into a field the CLI prints. A rule whose mode
 * cannot be read is corrupt stored data, which is a fault rather than a value.
 */
function toRule(row: ResourceRow): ForwardingRule {
  const mode = rowText(row["mode"]);
  if (!MODES.has(mode)) {
    throw new Error(`Invalid forwarding mode in database: ${mode || "(empty)"}`);
  }
  return {
    id: requiredText(row, "id"),
    source_address: requiredText(row, "source_address"),
    target_address: requiredText(row, "target_address"),
    mode: mode as ForwardingMode,
    provider_id: rowTextOrNull(row["provider_id"]),
    from_address: rowTextOrNull(row["from_address"]),
    enabled: requiredEnabled(row),
    created_at: requiredText(row, "created_at"),
    updated_at: requiredText(row, "updated_at"),
  };
}

/**
 * By source, then target, then mode, then id.
 *
 * The first two are what both deleted arms published. `mode` and `id` are tiebreakers they
 * did not have, and they are not decoration: `(source_address, target_address, mode)` is the
 * unique key, so two rows CAN share a source and a target — and while SQLite's `CHECK` keeps
 * `mode` single-valued today, the self-hosted migration drops that constraint (header
 * note 5), which is exactly where the tie becomes reachable. Without a total order a page
 * boundary can repeat or drop a row between two pages of the same list.
 */
function byRoute(a: ForwardingRule, b: ForwardingRule): number {
  return a.source_address.localeCompare(b.source_address)
    || a.target_address.localeCompare(b.target_address)
    || a.mode.localeCompare(b.mode)
    || a.id.localeCompare(b.id);
}

/**
 * Read every stored rule matching `filters`, or explain why not.
 *
 * PAGED TO AN EMPTY PAGE, never to a short one, and a scan that did not finish throws. Both
 * callers need the WHOLE filtered set — one to sort and window, one to be sure an upsert's
 * target does not exist — so a partial read cannot answer either question. See
 * `src/lib/status-facts-enumeration.ts` for why "shorter than I asked for" proves nothing
 * about the end of a table.
 *
 * THE FILTER IS RE-ASSERTED ON WHAT COMES BACK. The service's generic list route IGNORES a
 * query parameter it does not declare and answers with the unfiltered list — a superset
 * presented as a filtered result. That is a wrong result rather than a value, so it is
 * treated as a fault. (The HTTP store already refuses an undeclared filter up front by
 * reading the published contract; this catches a store that accepts the filter and then does
 * not apply it, which no type can rule out.)
 */
async function readRules(
  store: EmailStore,
  what: string,
  filters: Record<string, string>,
  matches: (rule: ForwardingRule) => boolean,
): Promise<ForwardingRule[]> {
  const enumeration = await enumerateStoreRows<ResourceRow>(
    (opts) => store.forwarding.list({
      ...opts,
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
    }),
    {
      pageBudget: MAX_RULE_ROW_PAGES,
      idOf: (row) => (typeof row["id"] === "string" ? row["id"] : null),
    },
  );
  if (enumeration.refusal) throw storeRefusal(what, enumeration.refusal);
  if (enumeration.fault !== null) {
    throw new Error(`This installation's store faulted while it ${what}: ${enumeration.fault}`);
  }
  if (!enumeration.complete) {
    throw new Error(
      `This installation's forwarding rules could not be read to the end (pages: ${enumeration.pages}, `
        + `duplicates: ${enumeration.duplicates}, shifted: ${enumeration.shifted}), so they cannot be `
        + "ordered or searched; refusing to answer from part of the table",
    );
  }
  const rules = enumeration.rows.map(toRule);
  for (const rule of rules) {
    if (!matches(rule)) {
      throw new Error(
        "This installation's store answered a filtered forwarding-rule read with rows outside the filter; "
          + "refusing to treat them as the requested rules",
      );
    }
  }
  return rules.sort(byRoute);
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

/**
 * Create a forwarding rule, or update the one that already routes this source to this target
 * in this mode.
 *
 * The upsert key is `(source_address, target_address, mode)` — both schemas' `UNIQUE`
 * constraint — and all three are pushed down as filters because both stores declare all
 * three (header note 2 lists what the service declares). The enumeration still runs to the
 * end: the filters narrow the read, they do not bound it, which is the difference between
 * this and the deleted arm's single clamped page (header note 3).
 *
 * NEITHER `id` NOR EITHER TIMESTAMP IS SENT. `/v1/forwarding` has no such writable columns
 * and its request schema is closed, so naming them would make the HTTP store refuse the
 * write outright (header note 4); each store mints the id and stamps its own clock. The
 * deleted HTTP arm's client-side uuid was already being discarded by the service.
 */
export async function createForwardingRule(
  input: CreateForwardingRuleInput,
  store?: EmailStore,
): Promise<ForwardingRule> {
  const target = storeFor(store);
  const source = normalizeEmail(input.source_address);
  const destination = normalizeEmail(input.target_address);
  const from = input.from_address ? normalizeEmail(input.from_address) : null;
  const mode = assertWritableMode(input.mode ?? "app-copy");
  const enabled = input.enabled !== false;
  const providerId = input.provider_id ?? null;

  const existing = (await readRules(
    target,
    "read this installation's forwarding rules",
    { source_address: source, target_address: destination, mode },
    (rule) => rule.source_address === source && rule.target_address === destination && rule.mode === mode,
  ))[0];

  const written = existing
    ? await target.forwarding.update(existing.id, {
      provider_id: providerId,
      from_address: from,
      enabled,
    })
    : await target.forwarding.create({
      source_address: source,
      target_address: destination,
      mode,
      provider_id: providerId,
      from_address: from,
      enabled,
    });
  if (!written.ok) {
    throw storeRefusal(existing ? "update a forwarding rule" : "store a forwarding rule", written);
  }
  if (written.value === null) {
    // `update` answers `null` for a row that is not there. The read above just saw it, so
    // this is a row deleted underneath us rather than a missing one — reported instead of
    // being retried as an insert, which would race the same deletion again.
    throw new Error(`Forwarding rule not found: ${existing?.id ?? "(unknown)"}`);
  }

  // THE RETURNED ROW IS CHECKED AGAINST WHAT WAS WRITTEN. The service's generic route
  // ACCEPTS a body key the resource has no column for and drops it silently; both stores
  // refuse an unknown column today, and this is what notices if one ever stops.
  const rule = toRule(written.value);
  if (
    rule.source_address !== source
    || rule.target_address !== destination
    || rule.mode !== mode
    || rule.enabled !== enabled
    || rule.provider_id !== providerId
    || rule.from_address !== from
  ) {
    throw new Error(
      "This installation's store accepted a forwarding-rule write and answered with a different row; "
        + "refusing to report the rule as saved",
    );
  }
  return rule;
}

/**
 * One rule by id, or `null` when no such rule exists in scope.
 *
 * `null` here means the store looked and found nothing — a refusal throws instead, so "there
 * is no such rule" is never confused with "I could not look".
 */
export async function getForwardingRule(id: string, store?: EmailStore): Promise<ForwardingRule | null> {
  const read = await storeFor(store).forwarding.get(id);
  if (!read.ok) throw storeRefusal("read a forwarding rule", read);
  if (read.value === null) return null;
  const rule = toRule(read.value);
  // The id is re-asserted because a by-id read that answers with ANOTHER row is a wrong
  // result rather than a value, and the caller has no way to notice: it asked for one row and
  // got one row. Both stores match the key exactly today; this is what catches a store that
  // starts resolving an id PREFIX, which the message family's seam deliberately does and
  // which would be a silent identity change here.
  if (rule.id !== id) {
    throw new Error(
      "This installation's store answered a forwarding-rule read by id with a different row; "
        + "refusing to report it as the requested rule",
    );
  }
  return rule;
}

/**
 * Forwarding rules, by source then target, with the deleted arms' exact paging.
 *
 * `limit` is optional and `undefined` means EVERY matching rule; `offset` is honoured only
 * when a limit was given, which is what both deleted arms did (the local one appended
 * `LIMIT ? OFFSET ?` only when a limit was present, and the HTTP one returned the unsliced
 * array). That is preserved rather than tidied: an offset that started working on its own
 * would silently change what an existing caller sees.
 *
 * THE PAGE IS SLICED FROM A COMPLETE READ, because there is no push-down available — the
 * seam publishes no ordering, and the two stores order this table differently (header
 * note 1). `enabled` is applied here rather than pushed down, because the service does not
 * filter on it (header note 2).
 */
export async function listForwardingRules(
  opts: ListForwardingRulesOptions = {},
  store?: EmailStore,
): Promise<ForwardingRule[]> {
  const source = opts.source_address ? normalizeEmail(opts.source_address) : undefined;
  const rules = (await readRules(
    storeFor(store),
    "list this installation's forwarding rules",
    source === undefined ? {} : { source_address: source },
    (rule) => source === undefined || rule.source_address === source,
  )).filter((rule) => opts.enabled === undefined || rule.enabled === opts.enabled);
  const limit = safeOptionalLimit(opts.limit);
  if (limit === null) return rules;
  const offset = safeOffset(opts.offset);
  return rules.slice(offset, offset + limit);
}

/**
 * Switch a rule on or off.
 *
 * `updated_at` IS NOT SENT: it is not a writable column on `/v1/forwarding`, so naming it
 * would make the HTTP store refuse the write (header note 4). Both stores stamp it themselves
 * on an update.
 *
 * A store that answers `null` means there is no such rule, and that is the deleted arms'
 * error verbatim — the local one issued the UPDATE, read nothing back and threw; the HTTP one
 * checked first and threw. A refusal is reported as a refusal instead, so "no such rule" is
 * not what a caller sees when the store could not be written to.
 */
export async function setForwardingRuleEnabled(
  id: string,
  enabled: boolean,
  store?: EmailStore,
): Promise<ForwardingRule> {
  const written = await storeFor(store).forwarding.update(id, { enabled });
  if (!written.ok) throw storeRefusal("update a forwarding rule", written);
  if (written.value === null) throw new Error(`Forwarding rule not found: ${id}`);
  const rule = toRule(written.value);
  if (rule.id !== id || rule.enabled !== enabled) {
    throw new Error(
      "This installation's store accepted a forwarding-rule update and answered with a different row; "
        + "refusing to report the rule as changed",
    );
  }
  return rule;
}

/**
 * Delete a rule. `false` means there was no such rule to delete; a store that could not
 * perform the delete throws, because `false` would otherwise read as "already gone".
 */
export async function removeForwardingRule(id: string, store?: EmailStore): Promise<boolean> {
  const removed = await storeFor(store).forwarding.remove(id);
  if (!removed.ok) throw storeRefusal("remove a forwarding rule", removed);
  return removed.value;
}

/**
 * A stored delivery row, mapped to `ForwardingDelivery`.
 *
 * The status is VALIDATED rather than cast. SQLite's `CHECK(status IN ('sent','failed'))`
 * makes an out-of-enum value unreachable through the writer below, so this guards a row
 * written before that constraint existed or by another writer — and it is a fault rather
 * than a cast for the same reason `mode` is: a delivery whose outcome cannot be read must
 * not be reported as one that succeeded.
 */
function toDelivery(row: ForwardingDeliveryRow): ForwardingDelivery {
  if (!DELIVERY_STATUSES.has(row.status)) {
    throw new Error(`Invalid forwarding delivery status in database: ${row.status || "(empty)"}`);
  }
  return { ...row, status: row.status as ForwardingDeliveryStatus };
}

/**
 * Inbound mail an enabled rule should copy and has not copied yet.
 *
 * `db` IS REQUIRED, AND THAT IS THE POINT. See the header: the pending-forward join spans
 * `forwarding_rules`, `inbound_recipients`, `inbound_emails` and the `forwarding_deliveries`
 * ledger, and the ledger exists in local SQLite ONLY — not on the seam, not on `/v1`, not in
 * the self-hosted Postgres schema. A default local handle would have let an API-configured
 * installation call this, read an empty local file, and be told its inbox is fully
 * forwarded. Requiring the storage makes that a compile error instead.
 *
 * WITHOUT `backfill`, mail received BEFORE the rule was created is excluded, which is the
 * deleted arm's gate unchanged: the rule's own `created_at` is the cutoff, so enabling an
 * old rule does not retroactively forward a year of mail.
 *
 * A NON-FINITE `limit` IS REFUSED rather than clamped. The deleted arm computed
 * `Math.max(1, Math.min(1000, Math.trunc(limit)))`, and `Math.trunc(NaN)` is `NaN`, which
 * binds as SQL NULL — and `LIMIT NULL` in SQLite means NO LIMIT. So a caller handing in a
 * bad limit silently got the entire table instead of a bounded page. The clamp is otherwise
 * preserved exactly.
 */
export function listPendingForwarding(
  limit: number,
  db: Database,
  opts: { backfill?: boolean } = {},
): PendingForwarding[] {
  if (!Number.isFinite(limit)) {
    throw new Error("Pending-forwarding limit must be a finite number.");
  }
  const receivedAtGate = opts.backfill ? "" : "AND datetime(inbound.received_at) >= datetime(rules.created_at)";
  const rows = db.query(
    `SELECT
       rules.*,
       inbound.id AS inbound_email_id
     FROM forwarding_rules rules
     JOIN inbound_recipients recipient ON recipient.address = rules.source_address
     JOIN inbound_emails inbound ON inbound.id = recipient.inbound_email_id
     LEFT JOIN forwarding_deliveries delivery
       ON delivery.rule_id = rules.id
      AND delivery.inbound_email_id = inbound.id
      AND delivery.status = 'sent'
     WHERE rules.enabled = 1
       AND rules.mode = 'app-copy'
       AND inbound.is_sent = 0
       ${receivedAtGate}
       AND delivery.id IS NULL
     ORDER BY inbound.received_at ASC, rules.source_address ASC
     LIMIT ?`,
  ).all(Math.max(1, Math.min(MAX_PENDING_LIMIT, Math.trunc(limit)))) as ResourceRow[];
  // `toRule` is the SAME mapper the seam reads use, so a locally stored rule whose `mode` or
  // `enabled` cannot be read is a fault on this path too rather than only on the other.
  return rows.map((row) => ({
    rule: toRule(row),
    inbound_email_id: requiredText(row, "inbound_email_id"),
  }));
}

/**
 * Record what happened to one forwarded copy, keyed on `(rule_id, inbound_email_id)`.
 *
 * `db` IS REQUIRED for the same reason as above: `forwarding_deliveries` exists in local
 * SQLite only, and a default handle would let this write the ledger of a store the operator
 * did not configure. A silently misplaced ledger row is worse than a compile error, because
 * the next pending scan reads it as "already forwarded".
 *
 * The upsert is the deleted arm's verbatim: one row per (rule, inbound message), so a failed
 * attempt is replaced by the later success rather than accumulating. The status is checked
 * BEFORE the write — SQLite's `CHECK` would refuse it anyway, but the message a caller gets
 * then names the constraint rather than the value.
 */
export function recordForwardingDelivery(
  input: RecordForwardingDeliveryInput,
  db: Database,
): ForwardingDelivery {
  if (!DELIVERY_STATUSES.has(input.status)) {
    throw new Error(`Forwarding delivery status must be sent or failed; received: ${String(input.status)}`);
  }
  const id = uuid();
  db.run(
    `INSERT OR REPLACE INTO forwarding_deliveries
      (id, rule_id, inbound_email_id, sent_email_id, status, error, created_at)
     VALUES (
       COALESCE((SELECT id FROM forwarding_deliveries WHERE rule_id = ? AND inbound_email_id = ?), ?),
       ?, ?, ?, ?, ?, datetime('now')
     )`,
    [
      input.rule_id,
      input.inbound_email_id,
      id,
      input.rule_id,
      input.inbound_email_id,
      input.sent_email_id ?? null,
      input.status,
      input.error ?? null,
    ],
  );
  const row = db.query(
    "SELECT * FROM forwarding_deliveries WHERE rule_id = ? AND inbound_email_id = ?",
  ).get(input.rule_id, input.inbound_email_id) as ForwardingDeliveryRow | null;
  if (!row) {
    throw new Error(
      "This installation's local store accepted a forwarding-delivery write and then could not read it "
        + "back; refusing to report the delivery as recorded",
    );
  }
  return toDelivery(row);
}
