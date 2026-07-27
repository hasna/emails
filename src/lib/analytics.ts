// Email analytics — ONE implementation, over the store seam.
//
// This family used to be three files: a facade that picked an implementation from the
// process-wide deployment read, a local arm that computed four SQL aggregates against
// SQLite, and a second arm that threw for `getAnalytics` and carried a BYTE-FOR-BYTE
// COPY of the 70-line report formatter. The two arms did not disagree about what
// "analytics for this period" MEANS; they disagreed about who was running. That is the
// switch the mode-removal program deletes, so the arms are gone and this is the only
// implementation.
//
// WHERE THE FACTS COME FROM. Every stored fact is read through `EmailStore`
// (src/store/), resolved from storage configuration by `createConfiguredEmailStore()`
// (src/store-resolution.ts). There is deliberately NO second resolution path: a report
// that read send volume from one source and delivery events from another would describe
// two installations in one dashboard.
//
// ── THE CENTRAL PROBLEM: THE SEAM HAS NO AGGREGATE ───────────────────────────
//
// The old local arm was four `COUNT(*) … GROUP BY` statements. The seam publishes list
// operations and not one aggregate — no count, no group-by, no server-supplied total —
// and both implementations clamp a list page to 500 rows (`MAX_PAGE` in
// src/store-sqlite/resources.ts and src/store-http/registry.ts, and the service clamps
// again). So every number in this report is now produced by a CLIENT-SIDE BOUNDED
// ENUMERATION, and that changes what the numbers are allowed to claim:
//
//   * A count from a read that reached the end of the rows is a TOTAL.
//   * A count from a read that ran out of budget, or that saw the window move under it,
//     is a LOWER BOUND and is rendered `≥N` — the convention `emails status` and
//     `daemon status` already use.
//   * A count from a read that was REFUSED or that FAULTED is ABSENT. Not zero, not an
//     empty array. The four aggregate fields are therefore nullable, because this repo
//     has already shipped the other thing: a list helper that windowed locally after
//     asking for a fixed row count returned 0 rows with exit 0 for `--offset 500`,
//     indistinguishable from "nothing is there".
//   * A RATE is published only when BOTH reads behind it are exact. Two lower bounds
//     divided by each other are not a bound in either direction, so a delivery rate over
//     truncated reads is not a smaller truth — it is a fabricated one.
//
// ── THREE THINGS THE SEAM CANNOT SERVE ───────────────────────────────────────
// Reported here rather than fixed by widening `src/store/`, which is a shared contract
// two audits are waiting on:
//
//   1. PROVIDER SCOPE ON MESSAGES, and it is the reason a provider filter is now
//      rejected outright. `MessageListRecord` carries no provider column and
//      `ListMessagesOptions` has no provider filter, so three of this report's four
//      sections cannot be scoped to a provider at all. The delivery-event side CAN be
//      (the events resource declares a provider filter), and that asymmetry is exactly
//      the trap: a report titled "provider X" whose volume, recipients and hours covered
//      EVERY provider would be a plausible wrong answer, which is worse than no answer.
//      So a provider-scoped request throws and names the missing field. Serving it needs
//      a provider column on the message list record plus a provider filter on the list
//      options.
//   2. A TIME WINDOW ON DELIVERY EVENTS. The events resource declares equality filters
//      only (by message, by provider, by type, by recipient) — no range. So the period
//      window is applied HERE, after reading, which means a long-lived installation can
//      exhaust the page budget on events outside the window and report lower bounds for
//      a period that would have fitted comfortably. Serving it needs an occurred-at
//      range filter on that resource.
//   3. AN EXACT SEND TIMESTAMP. The seam's message record has no dedicated send column.
//      What it has is `received_at`, which for the legacy outbound ledger IS the send
//      instant (src/store-sqlite/messages-sql.ts maps the send column onto it) and for
//      unified-table rows is the arrival instant, with `created_at` behind it. The bucket
//      key below is `received_at ?? created_at`, which is the SAME expression the store's
//      own ordering key is built from for both arms, so the client-side buckets and the
//      server-side window agree instead of drifting by a row.
//
// TWO KINDS OF FAILURE, KEPT APART. A request this seam cannot express THROWS: it is
// wrong input and the caller must see it, not receive a dashboard. A read the store
// refused, faulted on, or could not finish is reported IN the payload, because it is a
// live data condition a caller may want to render. Collapsing either into the other is
// how a refusal becomes a zero.
//
// ONE ANSWER GETS BIGGER, and it is a fix rather than a side effect. The replaced local
// arm read `FROM emails` — SQLite's LEGACY provider-scoped sent ledger — and nothing else.
// The seam's outbound direction is the UNIFIED message stream, which also holds the
// outbound rows of the newer table (src/store-sqlite/messages-sql.ts records that reading
// only one of the two under-reports the Sent folder). So an installation whose sends went
// to the newer table had them missing from every section of this report and now has them.
// A count that goes UP on the same data is the direction worth stating out loud.

import { ansi } from "./ansi.js";
import type { EmailStore } from "../store/email-store.js";
import type { MessageListRecord, ResourceRow } from "../store/records.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import { enumerateStoreRows, STORE_LIST_PAGE_MAX } from "./status-facts-enumeration.js";

/**
 * What one enumeration behind this report managed to do.
 *
 * `answered` and `exact` are separate booleans because they answer separate questions:
 * "did I read anything at all" and "is what I read all of it". A single flag forces
 * "refused" and "truncated" to share a rendering, and they mean opposite things to an
 * operator.
 */
export interface AnalyticsRead {
  /**
   * false => NOTHING was read (the store refused, or the read threw), so every number
   * derived from this enumeration is null rather than 0.
   */
  answered: boolean;
  /**
   * false => every count derived from this enumeration is a LOWER BOUND. Always false
   * when `answered` is false.
   */
  exact: boolean;
  /** Why not answered, or why not exact. Null only when both are true. */
  reason: string | null;
  /** Rows actually read and used. */
  rows: number;
  /** Pages actually fetched. */
  pages: number;
}

export interface AnalyticsDailyVolume {
  date: string;
  count: number;
}

export interface AnalyticsTopRecipient {
  email: string;
  count: number;
}

export interface AnalyticsBusiestHour {
  hour: number;
  count: number;
}

/**
 * One day of the trend.
 *
 * TWO APPROXIMATIONS ARE INHERITED FROM THE SQL THIS REPLACES, stated because a reader
 * who assumes otherwise will over-read the rate:
 *
 *   * `delivered` and `bounced` are counted on the day the EVENT OCCURRED, while `sent`
 *     is counted on the day the message was SENT. A delivery confirmed after midnight
 *     lands on the following day, so the two columns of one row are not a cohort and
 *     `delivered` can exceed `sent`. The replaced query grouped the same two ways.
 *   * The EARLIEST day in the window is a partial day at both ends: the period bound is
 *     an instant, not a midnight, so that day holds only the sends and deliveries after
 *     it. Again as before.
 *
 * ONE DIFFERENCE IS NEW, and it is a widening rather than a narrowing: the replaced query
 * joined events to the sent ledger (`events … JOIN emails ON email_id`), which silently
 * dropped every event whose message row had been deleted — the schema nulls `email_id` on
 * delete. The seam has no such join to make, so those events are now counted. A delivery
 * that happened is a delivery that happened, and dropping it made the trend under-report
 * exactly on the installations that prune old mail.
 */
export interface AnalyticsDeliveryTrendDay {
  date: string;
  sent: number;
  /** Null when the delivery-event read was refused or faulted — never 0 for that. */
  delivered: number | null;
  /** Null when the delivery-event read was refused or faulted — never 0 for that. */
  bounced: number | null;
  /**
   * Delivered as a percentage of sent, or null.
   *
   * Null whenever EITHER read behind it is inexact, and that is the point of the field
   * rather than a caveat on it: `delivered` and `sent` are independently truncated lower
   * bounds, so their ratio can be arbitrarily far from the real rate in either
   * direction. A rate is the number an operator acts on, so it is the last one that may
   * be guessed.
   *
   * Not clamped to 100. Per the note above the two columns are not a cohort, so a value
   * over 100 is a real thing this data can say; clamping it would hide the day-boundary
   * effect rather than report it.
   */
  delivered_rate_pct: number | null;
}

export interface AnalyticsData {
  /**
   * Sends per day, or NULL when the outbound read was refused or faulted. Counts are
   * lower bounds when `sent_read.exact` is false.
   */
  dailyVolume: AnalyticsDailyVolume[] | null;
  /**
   * The ten most-addressed recipients, or null on a refused or faulted read.
   *
   * When `sent_read.exact` is false this is the top ten OF THE ROWS READ, which is not
   * the top ten: a recipient outside the window can outrank every one of these. The
   * formatter says so rather than printing a ranking that looks authoritative.
   */
  topRecipients: AnalyticsTopRecipient[] | null;
  /** Sends per hour of day, or null on a refused or faulted read. */
  busiestHours: AnalyticsBusiestHour[] | null;
  /** Per-day sent/delivered/bounced, or null when the outbound read produced nothing. */
  deliveryTrend: AnalyticsDeliveryTrendDay[] | null;
  /** The period as asked for. */
  period: string;
  /** The window's inclusive lower bound, as sent to the store. */
  since: string;
  /**
   * Which store answered, from `StoreDescriptor.detail` — safe to print by contract.
   * Recorded so a report is attributable to an installation instead of being read as a
   * statement about whichever store the reader happens to be configured for.
   */
  store: string;
  /** The outbound-message enumeration behind volume, recipients, hours and `sent`. */
  sent_read: AnalyticsRead;
  /** The delivery-event enumeration behind `delivered` and `bounced`. */
  events_read: AnalyticsRead;
}

export interface AnalyticsOptions {
  /**
   * The store to read. Defaults to the one this process's storage configuration names.
   * Injected by tests, and by a caller that already holds a store.
   */
  store?: EmailStore;
}

/**
 * Message pages this report will read before it calls its counts lower bounds.
 * 40 * 500 = 20_000 outbound messages, matching the budget
 * src/lib/status-facts-enumeration.ts sets for the same reason.
 */
const MESSAGE_SCAN_MAX_PAGES = 40;

/** How many recipients the ranking carries, unchanged from the SQL it replaces. */
const TOP_RECIPIENTS = 10;

/** The two event types the delivery trend is built from. */
const TREND_EVENT_TYPES = ["delivered", "bounced"] as const;

type TrendEventType = (typeof TREND_EVENT_TYPES)[number];

function parsePeriodDays(period: string): number {
  const days = Number.parseInt(period.replace("d", ""), 10);
  return Number.isFinite(days) && days > 0 ? days : 30;
}

/**
 * The date bucket of a stored timestamp, or null when it has neither shape this
 * database writes.
 *
 * Timestamps here arrive in two forms — an ISO string from application code and
 * `YYYY-MM-DD HH:MM:SS` from a column default — and both carry the UTC date in the same
 * first ten characters, which is what SQLite's `date()` returned for the query this
 * replaces. Anything else yields null and is COUNTED rather than dropped: a row that
 * cannot be bucketed is a row missing from a per-day count, and a count missing rows is a
 * lower bound whether or not anyone noticed.
 */
function dateBucket(value: string | null): string | null {
  if (value === null) return null;
  return /^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(value) ? value.slice(0, 10) : null;
}

/** The hour bucket of a stored timestamp, mirroring SQLite's hour extraction. */
function hourBucket(value: string | null): number | null {
  if (value === null) return null;
  const match = /^\d{4}-\d{2}-\d{2}[T ](\d{2}):/.exec(value);
  if (match === null) return null;
  const hour = Number.parseInt(match[1] as string, 10);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

/**
 * The instant a message belongs to.
 *
 * `received_at` first and `created_at` behind it, because that is the expression the
 * store's own ordering key is built from for BOTH physical tables
 * (src/store-sqlite/messages-sql.ts), and the window this report asks for is applied to
 * that key. Choosing a different field here would put rows in buckets the server's
 * window never selected for.
 */
function messageInstant(message: MessageListRecord): string | null {
  return message.received_at ?? message.created_at ?? null;
}

/** A read that produced nothing, with the reason it produced nothing. */
function unread(reason: string): AnalyticsRead {
  return { answered: false, exact: false, reason, rows: 0, pages: 0 };
}

function textField(row: ResourceRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

// ── the two reads ────────────────────────────────────────────────────────────

interface MessageScan {
  messages: MessageListRecord[];
  read: AnalyticsRead;
}

/**
 * Read the outbound messages in the window.
 *
 * CURSOR PAGING, NOT LIMIT/OFFSET, and the choice is load-bearing. `listMessages` is
 * gated on the `keysetPagination` capability whose entire content is that the list order
 * is TOTAL, so a cursor walk cannot repeat or skip a row the way an offset walk over a
 * tied order can — which is the failure src/lib/status-facts-enumeration.ts exists to
 * account for on the uniform families, where only limit/offset is on offer. The page's
 * next-cursor field is null exactly when the page is the last, by contract, so the end of
 * the stream is a SIGNAL here rather than an inference from a short page.
 *
 * Duplicates are still counted. Under a total order there can be none, so finding one
 * disproves the capability's claim for this store, and that is worth reporting rather
 * than de-duplicating in silence.
 */
async function scanOutbound(store: EmailStore, since: string): Promise<MessageScan> {
  const messages: MessageListRecord[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let duplicates = 0;
  let reachedEnd = false;

  while (pages < MESSAGE_SCAN_MAX_PAGES) {
    let outcome;
    try {
      outcome = await store.messages.listMessages({
        direction: "outbound",
        since,
        limit: STORE_LIST_PAGE_MAX,
        ...(cursor === undefined ? {} : { cursor }),
      });
    } catch (error) {
      return {
        messages: [],
        read: unread(
          "the outbound message read faulted, so no volume is reported: " +
            (error instanceof Error ? error.message : String(error)),
        ),
      };
    }
    pages += 1;
    if (!outcome.ok) {
      return {
        messages: [],
        read: unread(
          `the configured store refused to list outbound messages (${outcome.code}), so no volume is ` +
            `reported: ${outcome.message}`,
        ),
      };
    }
    for (const message of outcome.value.items) {
      if (seen.has(message.id)) {
        duplicates += 1;
        continue;
      }
      seen.add(message.id);
      messages.push(message);
    }
    const next = outcome.value.next_cursor;
    if (next === null) {
      reachedEnd = true;
      break;
    }
    cursor = next;
  }

  const reasons: string[] = [];
  if (!reachedEnd) {
    reasons.push(
      `the outbound scan stopped at its ${MESSAGE_SCAN_MAX_PAGES}-page bound ` +
        `(${MESSAGE_SCAN_MAX_PAGES * STORE_LIST_PAGE_MAX} messages) without reaching the end of the ` +
        "window, so every count below is a lower bound",
    );
  }
  if (duplicates > 0) {
    reasons.push(
      `${duplicates} message(s) came back on more than one page, which disproves this store's ` +
        "total-order claim for message lists; at least that many messages were never seen, so every " +
        "count below is a lower bound",
    );
  }
  return {
    messages,
    read: {
      answered: true,
      exact: reasons.length === 0,
      reason: reasons.length === 0 ? null : reasons.join("; "),
      rows: messages.length,
      pages,
    },
  };
}

interface EventScan {
  /** Date bucket -> per-type counts. Empty when `read.answered` is false. */
  byDate: Map<string, Record<TrendEventType, number>>;
  read: AnalyticsRead;
}

/**
 * Read the delivery and bounce events in the window.
 *
 * The type filter is pushed SERVER-side and re-checked HERE, and the redundancy is a
 * finding rather than belt-and-braces: the `/v1` test stub's generic list handler applies
 * the limit and offset clamps but IGNORES equality filters, serving every row and merely
 * recording the query string for a test to inspect. A client that trusted the filter
 * would therefore count bounces as deliveries in CI and nowhere else. Pushing the filter
 * down keeps the read narrow against the real service; re-checking keeps the arithmetic
 * right against anything that does not honour it.
 *
 * The WINDOW is applied here too, because that resource declares equality filters only
 * and has no range filter to push. That is the second reason this read can run out of
 * budget on an installation whose window would have fitted.
 */
async function scanTrendEvents(store: EmailStore, since: string): Promise<EventScan> {
  const byDate = new Map<string, Record<TrendEventType, number>>();
  let pages = 0;
  let rows = 0;
  const reasons: string[] = [];

  for (const type of TREND_EVENT_TYPES) {
    const enumeration = await enumerateStoreRows<ResourceRow>(
      (opts) => store.events.list({ ...opts, filters: { type } }),
      { idOf: (row) => textField(row, "id") },
    );
    pages += enumeration.pages;

    if (enumeration.refusal !== null) {
      return {
        byDate: new Map(),
        read: unread(
          `the configured store refused to list ${type} events (${enumeration.refusal.code}), so no ` +
            `delivery trend is reported: ${enumeration.refusal.message}`,
        ),
      };
    }
    if (enumeration.fault !== null) {
      return {
        byDate: new Map(),
        read: unread(`the ${type} event read faulted, so no delivery trend is reported: ${enumeration.fault}`),
      };
    }
    if (!enumeration.complete) {
      reasons.push(
        enumeration.stable
          ? `the ${type} event scan stopped after ${enumeration.pages} page(s) without reaching the end ` +
            "of the table, so its counts are lower bounds"
          : `the ${type} event scan saw ${enumeration.duplicates} duplicate row(s)` +
            `${enumeration.shifted ? " and a shifted window" : ""} across ${enumeration.pages} page(s), so ` +
            "at least that many rows were skipped and its counts are lower bounds",
      );
    }

    for (const row of enumeration.rows) {
      // The stub does not filter, so a row of the wrong type can arrive here. Counting it
      // under `type` would move a bounce into the delivered column.
      if (textField(row, "type") !== type) continue;
      const occurred = textField(row, "occurred_at");
      if (occurred === null) continue;
      const date = dateBucket(occurred);
      // The window is applied on the DATE BUCKET, not on the raw string: this database
      // writes timestamps in two formats and a lexical compare between them is not
      // chronological, so comparing the normalised dates is the only correct test that
      // does not need the store's own parser.
      if (date === null || date < since.slice(0, 10)) continue;
      rows += 1;
      const bucket = byDate.get(date) ?? { delivered: 0, bounced: 0 };
      bucket[type] += 1;
      byDate.set(date, bucket);
    }
  }

  return {
    byDate,
    read: {
      answered: true,
      exact: reasons.length === 0,
      reason: reasons.length === 0 ? null : reasons.join("; "),
      rows,
      pages,
    },
  };
}

// ── the report ───────────────────────────────────────────────────────────────

/**
 * Analytics for a period, read through the configured store.
 *
 * THROWS when a provider filter is supplied. The seam cannot scope messages to a
 * provider, so three of this report's four sections would silently cover every provider;
 * see the header. A caller that wants the unscoped report must ask for it.
 */
export async function getAnalytics(
  providerId?: string,
  period = "30d",
  options?: AnalyticsOptions,
): Promise<AnalyticsData> {
  if (providerId !== undefined && providerId !== null && String(providerId).trim() !== "") {
    throw new Error(
      "provider-scoped analytics cannot be produced from the store seam: the message list record " +
        "carries no provider column and the message list options have no provider filter, so daily " +
        "volume, top recipients and busiest hours would cover every provider while only the delivery " +
        "trend was scoped — a report that looks provider-specific and is not. Re-run without a " +
        "provider filter, or add a provider column and filter to the message list contract.",
    );
  }

  const store = options?.store ?? (await createConfiguredEmailStore());
  const days = parsePeriodDays(period);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const outbound = await scanOutbound(store, since);
  const events: EventScan = outbound.read.answered
    ? await scanTrendEvents(store, since)
    : // The trend is per-day-of-send, so with no send volume there is nothing to attach
      // delivery counts to. Reading the events anyway would spend the budget on numbers
      // that cannot be published.
      {
        byDate: new Map<string, Record<TrendEventType, number>>(),
        read: unread("the delivery trend was not read because the outbound message read produced nothing"),
      };

  const base = {
    period,
    since,
    store: store.descriptor.detail,
    sent_read: outbound.read,
    events_read: events.read,
  };

  if (!outbound.read.answered) {
    // NULL, NOT EMPTY. An empty array beside a false flag still renders as "no data" in
    // every consumer that forgets to read the flag.
    return { ...base, dailyVolume: null, topRecipients: null, busiestHours: null, deliveryTrend: null };
  }

  const volume = new Map<string, number>();
  const hours = new Map<number, number>();
  const recipients = new Map<string, number>();
  let unbucketable = 0;

  for (const message of outbound.messages) {
    const instant = messageInstant(message);
    const date = dateBucket(instant);
    if (date === null) unbucketable += 1;
    else volume.set(date, (volume.get(date) ?? 0) + 1);
    const hour = hourBucket(instant);
    if (hour !== null) hours.set(hour, (hours.get(hour) ?? 0) + 1);
    // One count per message/recipient pair, which is what expanding the recipient array
    // produced in the SQL this replaces.
    for (const recipient of message.to_addrs) {
      if (typeof recipient !== "string" || recipient.trim() === "") continue;
      recipients.set(recipient, (recipients.get(recipient) ?? 0) + 1);
    }
  }

  const sentRead: AnalyticsRead = unbucketable === 0
    ? outbound.read
    : {
        ...outbound.read,
        exact: false,
        reason: [
          outbound.read.reason,
          `${unbucketable} message(s) carry no timestamp this database's two formats can be read from, ` +
            "so they are absent from the per-day and per-hour counts, which are therefore lower bounds",
        ]
          .filter((part): part is string => part !== null)
          .join("; "),
      };

  const dailyVolume: AnalyticsDailyVolume[] = [...volume.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));

  const busiestHours: AnalyticsBusiestHour[] = [...hours.entries()]
    .map(([hour, count]) => ({ hour, count }))
    .sort((left, right) => left.hour - right.hour);

  const topRecipients: AnalyticsTopRecipient[] = [...recipients.entries()]
    .map(([email, count]) => ({ email, count }))
    // Count descending, address ascending — the ordering of the query this replaces, so
    // ties come back in the same order they used to.
    .sort(
      (left, right) =>
        right.count - left.count || (left.email < right.email ? -1 : left.email > right.email ? 1 : 0),
    )
    .slice(0, TOP_RECIPIENTS);

  const trendExact = sentRead.exact && events.read.exact;
  const deliveryTrend: AnalyticsDeliveryTrendDay[] = dailyVolume.map((day) => {
    const counts = events.read.answered ? (events.byDate.get(day.date) ?? { delivered: 0, bounced: 0 }) : null;
    const delivered = counts === null ? null : counts.delivered;
    return {
      date: day.date,
      sent: day.count,
      delivered,
      bounced: counts === null ? null : counts.bounced,
      delivered_rate_pct:
        trendExact && delivered !== null && day.count > 0 ? Math.round((delivered / day.count) * 1000) / 10 : null,
    };
  });

  return { ...base, sent_read: sentRead, dailyVolume, topRecipients, busiestHours, deliveryTrend };
}

// ── rendering ────────────────────────────────────────────────────────────────

/** `≥N` for a lower bound, plain `N` for a total. The convention `emails status` uses. */
function countText(count: number, exact: boolean): string {
  return exact ? String(count) : `≥${count}`;
}

function unavailableBlock(read: AnalyticsRead): string {
  return `  ${ansi.red("not available")} ${ansi.gray(`— ${read.reason ?? "no reason recorded"}`)}\n`;
}

function boundNote(read: AnalyticsRead): string {
  if (read.exact) return "";
  return `  ${ansi.yellow("lower bounds only")} ${ansi.gray(`— ${read.reason ?? "no reason recorded"}`)}\n`;
}

/**
 * What to print for a section that came back with no rows.
 *
 * THE DISTINCTION IS THE WHOLE POINT, and getting it wrong here undoes every nullable
 * field above. "No data" is a CLAIM — it says the store was read to the end and held
 * nothing. It may only be printed when the read was exact. An empty section from a read
 * that did not finish is not evidence of an empty table; it is evidence of nothing, and
 * an adversarial pass over this renderer found it printing the empty-table sentence for
 * exactly that case.
 */
function emptyNote(read: AnalyticsRead): string {
  if (read.exact) return "  No data\n";
  return (
    `  ${ansi.yellow("nothing in the rows read")} ` +
    `${ansi.gray(`— not proof there is none: ${read.reason ?? "no reason recorded"}`)}\n`
  );
}

export function formatAnalytics(data: AnalyticsData): string {
  let output = "";
  const exact = data.sent_read.exact;

  // Daily volume - ASCII bar chart
  output += ansi.bold("\n  Daily Send Volume\n");
  if (data.dailyVolume === null) {
    output += unavailableBlock(data.sent_read);
  } else if (data.dailyVolume.length === 0) {
    output += emptyNote(data.sent_read);
  } else {
    output += boundNote(data.sent_read);
    const maxCount = Math.max(...data.dailyVolume.map((d) => d.count), 1);
    for (const day of data.dailyVolume.slice(-14)) {
      const barLen = Math.round((day.count / maxCount) * 40);
      const bar = ansi.blue("█".repeat(barLen));
      output += `  ${day.date}  ${bar} ${countText(day.count, exact)}\n`;
    }
  }

  // Top recipients
  output += ansi.bold("\n  Top Recipients\n");
  if (data.topRecipients === null) {
    output += unavailableBlock(data.sent_read);
  } else if (data.topRecipients.length === 0) {
    output += emptyNote(data.sent_read);
  } else {
    // A RANKING over a truncated read is not a ranking, and saying only "lower bounds"
    // would understate it: a recipient in none of the rows read can outrank every row
    // that was.
    if (!exact) {
      output += `  ${ansi.yellow("partial ranking")} ${ansi.gray(
        "— computed over the messages read, so an unread recipient may outrank these",
      )}\n`;
    }
    for (const r of data.topRecipients.slice(0, TOP_RECIPIENTS)) {
      output += `  ${r.email}  ${ansi.gray(`(${countText(r.count, exact)} emails)`)}\n`;
    }
  }

  // Busiest hours
  output += ansi.bold("\n  Busiest Hours\n");
  if (data.busiestHours === null) {
    output += unavailableBlock(data.sent_read);
  } else if (data.busiestHours.length === 0) {
    output += emptyNote(data.sent_read);
  } else {
    output += boundNote(data.sent_read);
    const maxHour = Math.max(...data.busiestHours.map((h) => h.count), 1);
    for (const h of data.busiestHours) {
      const barLen = Math.round((h.count / maxHour) * 30);
      const bar = ansi.cyan("█".repeat(barLen));
      output += `  ${String(h.hour).padStart(2, "0")}:00  ${bar} ${countText(h.count, exact)}\n`;
    }
  }

  // Delivery trend
  output += ansi.bold("\n  Delivery Trend (last 7 days)\n");
  if (data.deliveryTrend === null) {
    output += unavailableBlock(data.sent_read);
  } else if (data.deliveryTrend.length === 0) {
    // The trend has one row per day WITH SENDS, so an empty trend is the send read's
    // emptiness rather than the event read's — and it inherits the send read's certainty.
    output += emptyNote(data.sent_read);
  } else {
    if (!data.events_read.answered) output += unavailableBlock(data.events_read);
    else if (!data.events_read.exact) output += boundNote(data.events_read);
    else if (!exact) output += boundNote(data.sent_read);
    for (const d of data.deliveryTrend.slice(-7)) {
      const delivered = d.delivered === null ? "unknown" : countText(d.delivered, data.events_read.exact);
      const bounced = d.bounced === null ? "unknown" : countText(d.bounced, data.events_read.exact);
      // NO PERCENTAGE FROM TWO LOWER BOUNDS. The old formatter divided by `sent || 1` and
      // printed a colour-coded rate unconditionally, which over truncated reads produces a
      // green "100.0%" from a delivered count that had simply outrun its send count.
      const rate = d.delivered_rate_pct === null
        ? ansi.gray("rate:unknown")
        : (d.delivered_rate_pct > 95 ? ansi.green : d.delivered_rate_pct > 80 ? ansi.yellow : ansi.red)(
            `${d.delivered_rate_pct.toFixed(1)}%`,
          );
      output += `  ${d.date}  sent:${countText(d.sent, exact)} delivered:${delivered} bounced:${bounced}  ${rate}\n`;
    }
  }

  return output;
}
