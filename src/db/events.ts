import type { EmailEvent, EventFilter, EventSummary, EventType } from "../types/index.js";
import { now, uuid } from "./runtime.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { selfHostedResource, cobj, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const EVENT_RESOURCE = "events";

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
  let rows = selfHostedResource(EVENT_RESOURCE).list({ limit: 1000 }).map(apiToEvent);

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
