// Delivery statistics, measured on THE ONE STORE this installation configured.
//
// WHAT THIS FILE USED TO BE, and why it is not that any more. Until this change it was
// a three-module family: this facade plus two sibling implementations picked at runtime
// by a deployment word. The two differed by WHO RAN THE READ, not by what a statistic
// means — one issued `COUNT(*)` / `SUM(CASE …)` against a local database, the other threw
// — so `emails stats` was either an exact aggregate or a hard refusal depending on a
// variable, with nothing in between and no way for a caller to tell a real zero from an
// unasked question. That axis is what `docs/PLAN-MODE-REMOVAL.md` deletes. Both sibling
// modules are gone; this is the whole implementation, and it reads through the store seam
// (`src/store/`), whose implementation the operator's STORAGE configuration selects
// (`src/store-resolution.ts`).
//
// THE ONE RULE THIS MODULE IS HELD TO, and it is the entire difficulty of a statistics
// family: THE SEAM PUBLISHES NO PERIOD-SCOPED AGGREGATE. `src/store/repositories.ts`
// offers list operations plus two whole-table counts (`messageCounts`, `getUnreadCount`),
// neither of which admits a time window or a provider. So every number below that the
// deleted local sibling got from one exact SQL aggregate is now a CLIENT-SIDE BOUNDED
// ENUMERATION, over either store, and therefore carries the completeness of the
// enumeration that produced it:
//
//   * a number that was fully enumerated is a TOTAL.
//   * a number whose enumeration ran out of budget, or whose paging window moved, is a
//     LOWER BOUND. It is published with `*_availability.complete === false`, and
//     `formatStatsTable` renders it `≥N` — the same convention `emails status` and
//     `daemon status` already use for exactly this reason.
//   * a number that was never read — the store refused, or the read threw, or no store
//     could be resolved — is `null` with a machine-readable reason in `gaps`. NEVER a
//     zero: a zero is type-valid and reads as an authoritative count, which is how "I
//     did not look" gets published as "nothing happened".
//
// A RATE IS HELD TO A STRICTER RULE THAN A COUNT, and this is the one place a plausible
// wrong answer is easiest to ship. A ratio of two independently-bounded counts is not a
// rate at all — it is the quotient of two arbitrary prefixes of two tables, and it can
// land anywhere including above 100%. There is no `≥` form for it either: bounding a
// numerator and bounding a denominator move a ratio in OPPOSITE directions. So every rate
// here is `null` unless every count it divides is a total.
//
// WHAT COLLAPSING THE TWO SIBLINGS CHANGED. Stated here rather than left for a reader to
// discover by diffing them; one is a loss recorded as a named gap, two are corrections:
//
//   1. THE PROVIDER FILTER NO LONGER SCOPES `sent`, and it is refused rather than
//      ignored. The deleted local sibling counted
//      `emails WHERE sent_at >= ? AND provider_id = ?`. The seam's outbound message
//      stream carries NO provider: `ListMessagesOptions` has no such filter and
//      `MessageListRecord` has no such field (src/store/records.ts), deliberately —
//      src/store-sqlite/messages-sql.ts records that `emails.provider_id` is exactly the
//      column this refactor declines to lift. Answering with the UNFILTERED count would
//      be a superset presented as a filtered result, which is the defect
//      src/store-http/resources.ts already refuses for list filters. So with a provider
//      named, `sent` is null and the two rates that divide by it are null. `open_rate`
//      survives, because it divides two event counts and event rows DO carry
//      `provider_id` in both schemas.
//   2. `sent` NOW COUNTS ALL OUTBOUND MAIL, not only the legacy provider-scoped ledger,
//      and this is a correction rather than a loss. The deleted sibling counted one table;
//      the seam's `direction: "outbound"` reads the unified stream, which unions that
//      ledger with the outbound rows of the inbound table
//      (src/store-sqlite/messages-sql.ts: `is_sent = 1`). Mail sent through the newer path
//      was simply missing from the old number.
//   3. A ZERO DENOMINATOR IS NO LONGER A ZERO RATE. The deleted sibling returned
//      `delivery_rate: 0` when nothing was sent, i.e. it published "0% of your mail was
//      delivered" for an installation that has sent nothing. 0/0 has no value; the field
//      is null with a `not_applicable` reason.
//
// WHY THE PERIOD WINDOW IS APPLIED IN THIS PROCESS. No list operation on the seam filters
// events by time — `ResourceRepository.list` takes EQUALITY filters only
// (src/store-sqlite/resources.ts, src/store-http/resources.ts) — so the window is a
// predicate over enumerated rows. Two consequences are load-bearing. The enumeration
// walks the store's own list order (`created_at DESC` locally, `occurred_at DESC` over the
// API), which locally is NOT the window's column, so an exhausted budget can miss a row
// that is inside the window; that is why exhaustion bounds the counts instead of being
// ignored. And a row whose timestamp cannot be parsed cannot be placed inside or outside
// the window, so those rows bound the counts too rather than being silently dropped.
//
// WHY NO SERVER-SIDE FILTER IS PUSHED for the provider, even though both stores could
// take one: the API store validates a filter against the service's PUBLISHED contract and
// faults when it cannot read `/v1/openapi.json` (src/store-http/resources.ts). The window
// predicate would still have to run here regardless, so a pushed filter would reduce row
// volume without changing a single published number's completeness — and would buy that
// with a second failure mode on the read that reports failures.

import {
  enumerateStorePages,
  enumerateStoreRows,
} from "./status-facts-enumeration.js";
import {
  StatusGaps,
  renderStatusCount,
  statusAvailable,
  statusReasonCode,
  statusUnavailable,
  type StatusAvailability,
} from "./status-availability.js";
import { StoreConfigurationError, createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Refusal } from "../store/outcome.js";
import type { MessageListRecord, ResourceRow } from "../store/records.js";

/**
 * The event types a delivery statistic is made of.
 *
 * `unsubscribed` is a valid row in both schemas and is deliberately NOT here: the deleted
 * local sibling's aggregate did not count it and the report has no field for it, so adding
 * one would be a new statistic smuggled in under a refactor.
 */
const EVENT_TYPES = ["delivered", "bounced", "complained", "opened", "clicked"] as const;

export type StatsEventType = (typeof EVENT_TYPES)[number];

/**
 * Delivery statistics for one period, plus what may be said about them.
 *
 * DECLARED HERE AND NOT IN `src/types/index.ts`, which leaves `Stats` (there) unchanged.
 * That type is also the return type of `ProviderAdapter.getStats`
 * (src/providers/interface.ts) — a PROVIDER's own reported figures, which arrive from a
 * provider API as authoritative totals with no enumeration behind them. Widening it would
 * have forced completeness metadata onto four adapters that cannot produce any, and the
 * honest split is that "what a provider told us" and "what we could measure on the
 * configured store" are two different facts about two different sources.
 *
 * Every count and every rate is nullable, and a null ALWAYS has a reason in `gaps`.
 */
export interface StatsReport {
  /** The provider the figures are scoped to, or `"all"`. */
  provider_id: string;
  period: string;
  /** Outbound messages in the period. Null when not measurable; see `gaps`. */
  sent: number | null;
  delivered: number | null;
  bounced: number | null;
  complained: number | null;
  opened: number | null;
  clicked: number | null;
  /** delivered / sent, as a percentage. Null unless BOTH counts are totals. */
  delivery_rate: number | null;
  /** bounced / sent, as a percentage. Null unless BOTH counts are totals. */
  bounce_rate: number | null;
  /** opened / delivered, as a percentage. Null unless the event enumeration is a total. */
  open_rate: number | null;
  /** Provenance and completeness of `sent`. */
  sent_availability: StatusAvailability;
  /** Provenance and completeness of the five event counts. */
  events_availability: StatusAvailability;
  /** Field name -> why that field is null. */
  gaps: Record<string, StatusAvailability>;
}

/** Parity with the deleted local sibling: anything unparseable or non-positive is 30 days. */
function parsePeriodDays(period: string): number {
  const days = Number.parseInt(period.replace("d", ""), 10);
  return Number.isFinite(days) && days > 0 ? days : 30;
}

/** Parity with the deleted local sibling: one decimal place. */
function roundRate(value: number): number {
  return Math.round(value * 10) / 10;
}

function faultMessage(error: unknown): string {
  const settings = error instanceof StoreConfigurationError ? ` (${error.settings.join(", ")})` : "";
  return `${error instanceof Error ? error.message : String(error)}${settings}`;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

// ── the outbound-message count ──────────────────────────────────────────────────

/** What one enumeration of the outbound stream established. */
interface OutboundEnumeration {
  /** Distinct message ids seen inside the period. */
  count: number;
  /** The store's typed refusal, or null. Non-null => nothing was read. */
  refusal: Refusal | null;
  /** A thrown fault's message, or null. Same warning as `refusal`. */
  fault: string | null;
  /** true => `count` IS the total. false => a lower bound, or nothing was read. */
  complete: boolean;
  pages: number;
  /** Rows returned twice. Each one proves the page order is not total. */
  duplicates: number;
}

/**
 * Count outbound messages in the period by paging the message list to its end.
 *
 * THE PAGER FOLLOWS THE CURSOR, which is a stronger end-of-table proof than the one
 * `enumerateStoreRows` has to use for the uniform families. `Page.next_cursor` is
 * documented on the seam as "null exactly when this page is the last"
 * (src/store/records.ts), and both implementations answer it from their OWN row count
 * against their OWN clamped limit. So the STORE states the end rather than this client
 * inferring it from a short page.
 *
 * THE LOOP ITSELF NOW LIVES IN `enumerateStorePages`
 * (src/lib/status-facts-enumeration.ts), beside the offset pager it shares its honesty
 * rules with. It moved there when `src/db/emails` collapsed onto the seam and needed the
 * same walk over the same stream: two copies of "an empty page is not the end, a
 * duplicate proves rows were skipped, a stalled cursor is not completeness" is two
 * copies that can drift, and the offset pager's own header says why each of those rules
 * exists. Only the SHAPE differs here — this caller wants a count of distinct ids and
 * throws the rows away — so the fields are re-projected rather than re-derived.
 */
async function countOutboundSince(store: EmailStore, since: string): Promise<OutboundEnumeration> {
  const enumeration = await enumerateStorePages<MessageListRecord>(
    (opts) => store.messages.listMessages({ direction: "outbound", since, ...opts }),
    { idOf: (row) => row.id },
  );
  return {
    count: enumeration.rows.length,
    refusal: enumeration.refusal,
    fault: enumeration.fault,
    complete: enumeration.complete,
    pages: enumeration.pages,
    duplicates: enumeration.duplicates,
  };
}

// ── the delivery-event counts ───────────────────────────────────────────────────

/** The five counts, plus what the window predicate could not decide. */
interface EventTally {
  counts: Record<StatsEventType, number>;
  /** Rows whose `occurred_at` could not be parsed, so the window cannot place them. */
  unparseable: number;
}

function tallyEvents(rows: ResourceRow[], sinceMs: number, providerId: string | undefined): EventTally {
  const counts = Object.fromEntries(EVENT_TYPES.map((type) => [type, 0])) as Record<StatsEventType, number>;
  let unparseable = 0;
  for (const row of rows) {
    // Provider scoping is a real column on both event schemas (src/db/database.ts,
    // src/server/self-hosted/migrations.ts), so here it is a measurement rather than a
    // gap. A row with no provider never matches a named provider, which is correct: the
    // server's column is nullable and such a row is not attributable to anyone.
    if (providerId !== undefined && str(row["provider_id"]) !== providerId) continue;
    const occurredAt = Date.parse(str(row["occurred_at"]));
    if (!Number.isFinite(occurredAt)) {
      unparseable += 1;
      continue;
    }
    if (occurredAt < sinceMs) continue;
    const type = str(row["type"]);
    if ((EVENT_TYPES as readonly string[]).includes(type)) {
      counts[type as StatsEventType] += 1;
    }
  }
  return { counts, unparseable };
}

// ── availability plumbing ──────────────────────────────────────────────────────

/** The part of an enumeration that decides what may be said about its numbers. */
interface ReadState {
  refusal: Refusal | null;
  fault: string | null;
  complete: boolean;
}

/**
 * Turn one enumeration's outcome into a publishable availability record.
 *
 * Four DIFFERENT answers, none of which is a zero: a declared-false capability is
 * structural, any other refusal and any thrown fault are live failures, and an exhausted
 * budget or a non-total order is a lower bound. `boundReason` is a thunk so the bound
 * prose is only built in the case that publishes it.
 */
function availabilityFor(
  source: string,
  inventory: string,
  state: ReadState,
  boundReason: () => string,
): StatusAvailability {
  if (state.refusal !== null) {
    const refusal = state.refusal;
    const prose = `the configured store refused to list ${inventory}: ${refusal.message}`;
    // A declared-false capability is permanent for this store and clears nothing an
    // operator can act on, so it is structural. Every other refusal code names something
    // that went wrong on this call.
    return refusal.code === "capability_unavailable"
      ? statusUnavailable("not_modelled_on_store", `store_refusal:${refusal.code}`, source, prose)
      : statusUnavailable("source_unreachable", `store_refusal:${refusal.code}`, source, prose);
  }
  if (state.fault !== null) {
    return statusUnavailable(
      "source_unreachable",
      state.fault,
      source,
      `the ${inventory} inventory could not be read, so no count is reported`,
    );
  }
  if (!state.complete) {
    // Honest lower bound: the rows are real but not final.
    return { ...statusAvailable(source, "client_enumeration", false), reason: boundReason() };
  }
  return statusAvailable(source, "client_enumeration");
}

/**
 * The field-level gap a DERIVED value carries when the inventory it aggregates ANSWERED
 * but not in full. The block stays available; the derived field does not, and copying the
 * record keeps the original reason attached to the field it actually nulled.
 */
function derivedGap(availability: StatusAvailability): StatusAvailability {
  return { ...availability, available: false, basis: null, complete: null };
}

/** Nothing was read, because no store could be opened. */
function unresolvedAvailability(inventory: string, message: string): StatusAvailability {
  return statusUnavailable(
    "source_unreachable",
    "store_unresolved",
    "storage_configuration",
    `no store could be opened from this installation's storage configuration, so the ${inventory} `
      + `inventory was never read: ${message}`,
  );
}

/** Why the event counts are only a lower bound. Three distinct causes, never merged. */
function eventBoundReason(
  enumeration: { pages: number; duplicates: number; shifted: boolean; exhausted: boolean },
  unparseable: number,
): string {
  const parts: string[] = [];
  if (enumeration.exhausted) {
    parts.push(`enumeration_cap_exceeded:${enumeration.pages} pages`);
  }
  if (enumeration.duplicates > 0 || enumeration.shifted) {
    parts.push(
      `enumeration_unstable:${enumeration.duplicates} duplicate row(s)`
        + `${enumeration.shifted ? " and a shifted window" : ""} across ${enumeration.pages} pages`,
    );
  }
  if (unparseable > 0) {
    parts.push(`enumeration_unstable:${unparseable} event row(s) with an unreadable occurred_at`);
  }
  // The FIRST code is the one a machine reads (`statusReasonCode` splits on the first
  // colon), so the codes are ordered cap-then-instability and the prose carries the rest.
  return `${parts.join("; ")} — the delivery-event counts are lower bounds, not totals`;
}

/** Why `sent` is only a lower bound. */
function outboundBoundReason(outbound: OutboundEnumeration): string {
  if (outbound.duplicates > 0) {
    return `enumeration_unstable:${outbound.duplicates} duplicate row(s) across ${outbound.pages} pages — `
      + "the store's keyset page order is not total, so at least that many outbound messages were "
      + "skipped; the count is a lower bound, not a total";
  }
  return `enumeration_cap_exceeded:${outbound.pages} pages — the outbound message enumeration did not `
    + "reach the end of the stream, so the count is a lower bound, not a total";
}

// ── the statistics ─────────────────────────────────────────────────────────────

/**
 * Measure delivery statistics for one period.
 *
 * `store` is an INJECTION POINT, for tests and for the one shipped caller that already
 * holds a store for a specific database connection (src/lib/sync.ts). A caller that
 * passes nothing gets the store this installation's configuration means, which is what
 * every other shipped call site wants.
 *
 * THE NAME IS KEPT for API compatibility — it is a published export (src/index.ts) — even
 * though nothing about it is local any more: it reads whichever of the two stores the
 * operator configured. Renaming it belongs to a release that can change the public
 * surface, not to this collapse.
 */
export async function getLocalStats(
  providerId?: string,
  period = "30d",
  store?: EmailStore,
): Promise<StatsReport> {
  const gaps = new StatusGaps();
  const days = parsePeriodDays(period);
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs).toISOString();

  let resolved: EmailStore | null = store ?? null;
  let storeError: string | null = null;
  if (resolved === null) {
    try {
      resolved = createConfiguredEmailStore();
    } catch (error) {
      // A contradictory storage configuration must not make the statistics command itself
      // throw: the honest answer is a report in which every number is null and says why.
      storeError = faultMessage(error);
    }
  }
  const kind = resolved === null ? "unresolved_store" : resolved.descriptor.kind;
  const unresolvedMessage = storeError ?? "the storage configuration does not name one store";

  // ── the delivery-event read ──────────────────────────────────────────────────

  let eventsAvailability: StatusAvailability;
  let tally: EventTally | null = null;
  if (resolved === null) {
    eventsAvailability = unresolvedAvailability("delivery events", unresolvedMessage);
  } else {
    const open = resolved;
    const enumeration = await enumerateStoreRows<ResourceRow>(
      (opts) => open.events.list(opts),
      { idOf: (row) => (row["id"] == null ? null : String(row["id"])) },
    );
    const answered = enumeration.refusal === null && enumeration.fault === null;
    tally = answered ? tallyEvents(enumeration.rows, sinceMs, providerId) : null;
    // An unparseable timestamp is a THIRD reason the counts are only a lower bound, kept
    // apart from the other two: those rows WERE read, they may belong inside the window,
    // and nothing about them can decide it.
    const unparseable = tally?.unparseable ?? 0;
    eventsAvailability = availabilityFor(
      `${kind}:events`,
      "delivery events",
      {
        refusal: enumeration.refusal,
        fault: enumeration.fault,
        complete: enumeration.complete && unparseable === 0,
      },
      () => eventBoundReason(enumeration, unparseable),
    );
  }

  // ── the outbound-message read ────────────────────────────────────────────────

  let sentAvailability: StatusAvailability;
  let sent: number | null = null;
  if (providerId !== undefined) {
    // The read is not ATTEMPTED with a provider named, because there is no filter to
    // attempt it with. An unfiltered count answered to a filtered question is worse than a
    // refusal: nothing downstream can tell it apart from a real one.
    sentAvailability = statusUnavailable(
      "not_modelled_on_store",
      "no_provider_on_message_stream",
      `${kind}:messages`,
      "the store's outbound message stream carries no provider — ListMessagesOptions has no provider "
        + "filter and MessageListRecord has no provider field (src/store/records.ts) — so a "
        + "provider-scoped count of sent mail cannot be measured. The unfiltered count is NOT reported "
        + "in its place, because that would be a superset presented as a filtered result",
    );
  } else if (resolved === null) {
    sentAvailability = unresolvedAvailability("outbound messages", unresolvedMessage);
  } else {
    const outbound = await countOutboundSince(resolved, since);
    sentAvailability = availabilityFor(
      `${kind}:messages`,
      "outbound messages",
      outbound,
      () => outboundBoundReason(outbound),
    );
    if (sentAvailability.available) sent = outbound.count;
  }
  if (sent === null) gaps.mark("sent", sentAvailability);

  // ── the counts ───────────────────────────────────────────────────────────────

  const eventCount = (type: StatsEventType): number | null =>
    tally === null ? gaps.mark(type, eventsAvailability) : tally.counts[type];
  const delivered = eventCount("delivered");
  const bounced = eventCount("bounced");
  const complained = eventCount("complained");
  const opened = eventCount("opened");
  const clicked = eventCount("clicked");

  // ── the rates ────────────────────────────────────────────────────────────────

  const eventsExact = eventsAvailability.available && eventsAvailability.complete === true;
  const sentExact = sentAvailability.available && sentAvailability.complete === true;

  /**
   * A rate, or the reason there is none.
   *
   * Both operands must be TOTALS. A quotient of two bounded counts is not a bounded
   * quotient, so there is no `≥` form of this field and no honest number to publish.
   */
  const rate = (
    field: string,
    emptyDenominatorMeans: string,
    numerator: number | null,
    numeratorExact: boolean,
    numeratorAvailability: StatusAvailability,
    denominator: number | null,
    denominatorExact: boolean,
    denominatorAvailability: StatusAvailability,
  ): number | null => {
    if (numerator === null) return gaps.mark(field, numeratorAvailability);
    if (denominator === null) return gaps.mark(field, denominatorAvailability);
    if (!numeratorExact) return gaps.mark(field, derivedGap(numeratorAvailability));
    if (!denominatorExact) return gaps.mark(field, derivedGap(denominatorAvailability));
    if (denominator === 0) {
      return gaps.mark(field, statusUnavailable(
        "not_applicable",
        "no_denominator",
        denominatorAvailability.source,
        `nothing was ${emptyDenominatorMeans} in this period, so this rate has no value; a 0 here `
          + "would read as a measured failure rate rather than as an absent one",
      ));
    }
    return roundRate((numerator / denominator) * 100);
  };

  return {
    provider_id: providerId ?? "all",
    period,
    sent,
    delivered,
    bounced,
    complained,
    opened,
    clicked,
    delivery_rate: rate(
      "delivery_rate", "sent",
      delivered, eventsExact, eventsAvailability,
      sent, sentExact, sentAvailability,
    ),
    bounce_rate: rate(
      "bounce_rate", "sent",
      bounced, eventsExact, eventsAvailability,
      sent, sentExact, sentAvailability,
    ),
    // Both operands come from ONE enumeration, so they share one completeness flag. That
    // does not make the ratio safe when the enumeration was bounded: a prefix of the
    // events table is not a uniform sample of it — it is ordered by time — so the ratio of
    // two counts taken from a prefix is not the population's ratio.
    open_rate: rate(
      "open_rate", "delivered",
      opened, eventsExact, eventsAvailability,
      delivered, eventsExact, eventsAvailability,
    ),
    sent_availability: sentAvailability,
    events_availability: eventsAvailability,
    gaps: gaps.toRecord(),
  };
}

/**
 * Render a report as a table.
 *
 * A LOWER BOUND PRINTS AS `≥N` and an unmeasured field prints its reason. Both go through
 * the `gaps` map and `renderStatusCount`, which is the convention `emails status` and
 * `daemon status` already use — a renderer that printed a bound as a bare number would
 * republish it as a total, which is the whole failure this module is written against.
 *
 * AND THE REASONS ARE PRINTED, not only the markers. A `≥` on its own says a number is not
 * a total but not WHY, and an operator cannot act on a marker — so the footer names every
 * bounded inventory and every unmeasured field with the reason attached. Two sibling
 * collapses in this phase shipped formatters that dropped exactly this text on the floor
 * (one discarded a row's error, one printed "No data" for a section a TRUNCATED read had
 * left empty), which is why the footer has its own assertions rather than being assumed.
 */
export function formatStatsTable(stats: StatsReport): string {
  // A FIELD LINE CARRIES THE CODE, THE FOOTER CARRIES THE PROSE. The first cut printed the
  // whole reason inline, which is how the real command looked when it was run: nine fields
  // sharing one cause repeated the same paragraph nine times and the table stopped being
  // readable at all. A reason nobody can read is not better than a reason nobody is given,
  // so the line names the machine-readable code and the footer says the rest, once.
  const count = (field: string, value: number | null, availability: StatusAvailability): string => {
    if (value !== null) return renderStatusCount(value, availability);
    const code = statusReasonCode(stats.gaps[field]?.reason ?? availability.reason);
    return code === null ? "unavailable" : `unavailable (${code})`;
  };
  const rate = (field: string, value: number | null): string => {
    if (value !== null) return `(${value.toFixed(1)}%)`;
    const code = statusReasonCode(stats.gaps[field]?.reason);
    return code === null ? "(rate unavailable)" : `(rate unavailable: ${code})`;
  };
  const events = stats.events_availability;

  const lines = [
    `Provider: ${stats.provider_id}   Period: ${stats.period}`,
    ``,
    `  Sent:         ${count("sent", stats.sent, stats.sent_availability)}`,
    `  Delivered:    ${count("delivered", stats.delivered, events)}  ${rate("delivery_rate", stats.delivery_rate)}`,
    `  Bounced:      ${count("bounced", stats.bounced, events)}  ${rate("bounce_rate", stats.bounce_rate)}`,
    `  Complained:   ${count("complained", stats.complained, events)}`,
    `  Opened:       ${count("opened", stats.opened, events)}  ${rate("open_rate", stats.open_rate)}`,
    `  Clicked:      ${count("clicked", stats.clicked, events)}`,
  ];

  const bounded: Array<[string, StatusAvailability]> = ([
    ["outbound messages", stats.sent_availability],
    ["delivery events", events],
  ] as Array<[string, StatusAvailability]>).filter(
    ([, availability]) => availability.available && availability.complete === false,
  );
  if (bounded.length > 0) {
    lines.push(``, `  Lower bounds — counts shown with ≥ are not totals:`);
    for (const [inventory, availability] of bounded) {
      lines.push(`    ${inventory}: ${availability.reason ?? "the enumeration did not reach the end"}`);
    }
  }

  const unmeasured = Object.keys(stats.gaps);
  if (unmeasured.length > 0) {
    lines.push(``, `  Not measured (${unmeasured.length}):`);
    for (const field of unmeasured) {
      lines.push(`    ${field}: ${stats.gaps[field]?.reason ?? "unavailable"}`);
    }
  }

  return lines.join("\n") + "\n";
}
