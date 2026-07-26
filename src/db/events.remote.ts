import type { EmailEvent, EventFilter, EventSummary, EventType } from "../types/index.js";
import { now, uuid } from "./runtime.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { selfHostedResource, cobj, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";
import { enumerateSelfHostedRows, type SelfHostedEnumeration } from "./self-hosted-page.js";

const EVENT_RESOURCE = "events";

/**
 * The `/v1/events` filters the SERVER applies (src/server/self-hosted/resources.ts
 * -> the `events` spec `filters`). `since`/`until` are NOT among them, so a
 * time-ranged read still has to enumerate.
 */
function serverSideEventFilters(filter: EventFilter): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  if (filter.email_id) query["email_id"] = filter.email_id;
  if (filter.provider_id) query["provider_id"] = filter.provider_id;
  // The server compares `type` for equality, so only a single type narrows there;
  // a list of types stays a client-side filter.
  if (typeof filter.type === "string") query["type"] = filter.type;
  return query;
}

/**
 * A read must be honest about the question it was asked, and there are two
 * different questions.
 *
 * `events` is the fastest-growing table in the system (one row per delivery, open
 * and click), so it is the first to cross the pager's 20_000-row budget — and it
 * is read by `export events` (MCP) and `GET /api/events`, which hand the caller a
 * JSON/CSV file.
 *
 * UNBOUNDED ("give me everything"): only a complete enumeration can answer it.
 * Silently windowing a lower bound produces an export that LOOKS complete and is
 * not — the same defect as publishing a de-duplicated page count as a total, with
 * a bigger number. That refusal is preserved exactly.
 *
 * BOUNDED ("give me the first N"): a full window IS the complete answer, because
 * the question never asked about the rest of the table. Refusing it was the
 * regression: the dashboard events tab asks for `?limit=100` and got a 500 once
 * the table outgrew the enumeration budget. A bounded read is therefore answered
 * when its window is FULL, or when the table ended first (then the short result is
 * genuinely the whole tail, not a truncation). It is still refused when the read
 * could neither fill the window nor reach the end, because a short page passed off
 * as the requested window silently skips rows.
 */
function assertHonestEventRead(enumeration: SelfHostedEnumeration<EmailEvent>, bound: number | null): void {
  if (bound === null ? enumeration.complete : (enumeration.filled || enumeration.complete) && enumeration.stable) {
    return;
  }
  const cause = enumeration.exhausted
    ? `the ${enumeration.pages}-page enumeration budget ran out`
    : `the server's paging window shifted (${enumeration.duplicates} duplicate row(s) means rows were skipped)`;
  if (bound === null) {
    throw new Error(
      `Refusing to return a partial event list: ${cause}, so the ${enumeration.rows.length} row(s) read ` +
        `are a LOWER BOUND, not the whole set — an export built from them would look complete and would not be. ` +
        `Ask for a bounded page instead (a limit is windowed server-side by GET /v1/events), narrow the read with ` +
        `an email_id, provider_id or single type filter (GET /v1/events applies those server-side), or read one ` +
        `message's events with 'emails show <id>'.`,
    );
  }
  throw new Error(
    `Refusing to return a partial event list: ${cause} with ${enumeration.rows.length} of the ${bound} row(s) ` +
      `the requested window needs, so this result is SHORT, not the end of the table — a caller that treated it ` +
      `as the window it asked for would silently skip rows. Retry, or narrow the read with an email_id, ` +
      `provider_id or single type filter (GET /v1/events applies those server-side).`,
  );
}

function apiToEvent(e: Record<string, unknown>): EmailEvent {
  return {
    id: cstr(e["id"]),
    email_id: cstrOrNull(e["email_id"]),
    provider_id: cstr(e["provider_id"]),
    provider_event_id: cstrOrNull(e["provider_event_id"]),
    type: cstr(e["type"]) as EventType,
    recipient: cstrOrNull(e["recipient"]),
    metadata: cobj(e["metadata"]),
    occurred_at: cstr(e["occurred_at"]),
    created_at: ciso(e["created_at"]),
  };
}

function toEventSummary(e: EmailEvent): EventSummary {
  const { metadata: _metadata, ...summary } = e;
  return summary;
}

export interface CreateEventInput {
  email_id?: string | null;
  provider_id: string;
  provider_event_id?: string | null;
  type: EventType;
  recipient?: string | null;
  metadata?: Record<string, unknown>;
  occurred_at: string;
}

function eventFromInput(id: string, timestamp: string, input: CreateEventInput): EmailEvent {
  return {
    id,
    email_id: input.email_id || null,
    provider_id: input.provider_id,
    provider_event_id: input.provider_event_id || null,
    type: input.type,
    recipient: input.recipient || null,
    metadata: input.metadata || {},
    occurred_at: input.occurred_at,
    created_at: timestamp,
  };
}

export function createEvent(input: CreateEventInput): EmailEvent {
  const id = uuid();
  const timestamp = now();
  const event = eventFromInput(id, timestamp, input);
  selfHostedResource(EVENT_RESOURCE).create({
    id,
    email_id: event.email_id,
    provider_id: event.provider_id,
    provider_event_id: event.provider_event_id,
    type: event.type,
    recipient: event.recipient,
    metadata: JSON.stringify(event.metadata),
    occurred_at: event.occurred_at,
    created_at: timestamp,
  });
  return event;
}

/**
 * Every filter re-checked in the CLIENT.
 *
 * The declared `/v1/events` filters are sent to the server too, but as a BOUND on
 * how much is read, never as the answer: re-checking here keeps the result
 * identical against a server (or a stub) that ignores unknown query params, the
 * convention in src/db/contacts.remote.ts. `since`/`until` and a multi-value `type`
 * are not server filters at all, so for those this is the only check there is.
 */
function eventMatchesFilter(event: EmailEvent, filter: EventFilter): boolean {
  if (filter.email_id && event.email_id !== filter.email_id) return false;
  if (filter.provider_id && event.provider_id !== filter.provider_id) return false;
  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(event.type)) return false;
  }
  if (filter.since && event.occurred_at < filter.since) return false;
  if (filter.until && event.occurred_at > filter.until) return false;
  return true;
}

function listFilteredEvents(filter: EventFilter = {}): EmailEvent[] {
  const limit = safeOptionalLimit(filter.limit);
  const offset = safeOffset(filter.offset);
  // A BOUNDED read is served by a bounded server-side scan. `GET /v1/events`
  // already windows on limit/offset (store.ts listResource) and orders by
  // `occurred_at DESC, id ASC` (resourceListOrderBy) — a TOTAL order — so the rows
  // the pager collects up to the window's far edge ARE the caller's window, and it
  // stops there instead of walking the whole table to find them.
  //
  // The far edge is `offset + limit` because the window is sliced locally after the
  // client-side filters run. `need` is not a page size: the pager still caps every
  // request at the server's 500-row page maximum and pages to reach the edge, so a
  // window past row 500 comes back FULL. Sending `limit = offset + limit` in one
  // shot — the older convention in selfHostedListQuery — would be clamped to 500
  // and quietly under-fill, which is the same silent shortfall as a truncated
  // export, just harder to notice.
  //
  // An UNBOUNDED read passes no `need` and so still has to enumerate the table and
  // prove completeness before it may answer.
  //
  // NOTE the dependency this creates: a bounded read trusts the SERVER's ordering,
  // because the top of a window cannot be re-derived locally from a partial read.
  // That is inherent to server-side paging, not a shortcut — and it is asserted, not
  // assumed: src/db/events.remote.test.ts seeds rows in an order that disagrees with
  // the declared one and still requires the 100 most recent back.
  const need = limit === null ? null : limit + offset;
  const enumeration = enumerateSelfHostedRows<EmailEvent>(EVENT_RESOURCE, {
    query: serverSideEventFilters(filter),
    ...(need === null ? {} : { need }),
    // Map and filter in ONE pass so a dropped row does not count toward the
    // window: filtering after the fact would stop at N rows READ, leaving the
    // window short of the N rows the caller asked to KEEP.
    select: (row) => {
      const event = apiToEvent(row);
      return eventMatchesFilter(event, filter) ? event : null;
    },
  });
  assertHonestEventRead(enumeration, need);

  const rows = enumeration.rows;
  // Order the rows this read actually holds. Against `/v1/events` this is a no-op
  // (the server already returns `occurred_at DESC`); it is what makes the ORDER of a
  // complete, unbounded read independent of the server. It cannot rescue a bounded
  // read from a server that does not order — the wrong rows would already be in hand.
  rows.sort((a, b) => (b.occurred_at ?? "").localeCompare(a.occurred_at ?? ""));

  return limit === null ? rows : rows.slice(offset, offset + limit);
}

export function listEvents(filter: EventFilter = {}): EmailEvent[] {
  return listFilteredEvents(filter);
}

export function listEventSummaries(filter: EventFilter = {}): EventSummary[] {
  return listFilteredEvents(filter).map(toEventSummary);
}

export function getEvent(id: string): EmailEvent | null {
  const record = selfHostedResource(EVENT_RESOURCE).get(id);
  return record ? apiToEvent(record) : null;
}

export function getEventsByEmail(email_id: string): EmailEvent[] {
  return listEvents({ email_id });
}

export function upsertEvent(input: CreateEventInput): EmailEvent {
  return upsertEventWithResult(input).event;
}

export function upsertEventWithResult(input: CreateEventInput): { event: EmailEvent; created: boolean } {
  if (input.provider_event_id) {
    const existing = selfHostedResource(EVENT_RESOURCE)
      .list({ limit: 1000 })
      .map(apiToEvent)
      .find((e) => e.provider_id === input.provider_id && e.provider_event_id === input.provider_event_id);
    if (existing) return { event: existing, created: false };
  }
  return { event: createEvent(input), created: true };
}
