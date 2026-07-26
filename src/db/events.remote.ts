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
 * A partial enumeration must never be returned as if it were the whole set.
 *
 * `events` is the fastest-growing table in the system (one row per delivery, open
 * and click), so it is the first to cross the pager's 20_000-row budget — and it
 * is read by `export events` (MCP) and `GET /api/events`, which hand the caller a
 * JSON/CSV file. Silently windowing a lower bound produces an export that LOOKS
 * complete and is not: the same defect as publishing a de-duplicated page count as
 * a total, with a bigger number.
 */
function assertCompleteEventEnumeration(enumeration: SelfHostedEnumeration): void {
  if (enumeration.complete) return;
  const cause = enumeration.exhausted
    ? `the ${enumeration.pages}-page enumeration budget ran out`
    : `the server's paging window shifted (${enumeration.duplicates} duplicate row(s) means rows were skipped)`;
  throw new Error(
    `Refusing to return a partial event list: ${cause}, so the ${enumeration.rows.length} row(s) read ` +
      `are a LOWER BOUND, not the whole set — an export built from them would look complete and would not be. ` +
      `Narrow the read with an email_id, provider_id or single type filter (GET /v1/events applies those ` +
      `server-side), or read one message's events with 'emails show <id>'.`,
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

function listFilteredEvents(filter: EventFilter = {}): EmailEvent[] {
  // Enumerate, do NOT single-call: the client-side filters + windowing below need
  // the full row set, and one `.list({ limit: 1000 })` can only ever see 500 rows
  // (the server clamps every page — see src/db/self-hosted-page.ts). With a single
  // call, an export of >500 events silently returned a short, plausible result.
  // The remaining `.list({ limit: 1000 })` call sites are tracked as follow-up.
  //
  // The declared filters go to the SERVER so a narrow read stays inside the page
  // budget instead of dragging the whole table across the wire. They are applied
  // client-side again below, so the result is identical against a server that
  // ignores unknown query params (the convention in src/db/contacts.remote.ts).
  const enumeration = enumerateSelfHostedRows(EVENT_RESOURCE, { query: serverSideEventFilters(filter) });
  assertCompleteEventEnumeration(enumeration);
  let rows = enumeration.rows.map(apiToEvent);

  if (filter.email_id) rows = rows.filter((e) => e.email_id === filter.email_id);
  if (filter.provider_id) rows = rows.filter((e) => e.provider_id === filter.provider_id);
  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    rows = rows.filter((e) => types.includes(e.type));
  }
  if (filter.since) rows = rows.filter((e) => e.occurred_at >= filter.since!);
  if (filter.until) rows = rows.filter((e) => e.occurred_at <= filter.until!);

  rows.sort((a, b) => (b.occurred_at ?? "").localeCompare(a.occurred_at ?? ""));

  const limit = safeOptionalLimit(filter.limit);
  const offset = safeOffset(filter.offset);
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
