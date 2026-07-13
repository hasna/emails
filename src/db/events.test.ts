// Self-hosted-ONLY: the events repo routes every read/write to the /v1/events
// API. Exercises the REAL curl transport against an out-of-process /v1 stub —
// see src/test-support/v1-stub.ts. Migrated from the deleted local-SQLite
// pattern (getDatabase/resetDatabase/:memory:/EMAILS_DB_PATH).
//
// Dropped from the local-SQLite version (all inspected local SQL and passed a
// `db` handle that no longer exists):
//   - "returns newly created events without selecting the row back" (recordingDb
//     Proxy, run/query counting).
//   - "inserts new provider events without preselecting or reselecting rows"
//     ("INSERT OR IGNORE INTO events" SQL-string inspection).
//   The lean-projection assertion for summaries is retained functionally
//   (metadata omitted from the EventSummary shape).

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  createEvent,
  getEvent,
  listEvents,
  listEventSummaries,
  getEventsByEmail,
  upsertEvent,
  upsertEventWithResult,
} from "./events.js";

let stub: V1Stub;

const providerId = "prov-1";
const emailId = "email-1";

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

describe("createEvent", () => {
  it("creates an event", () => {
    const ev = createEvent({
      email_id: emailId,
      provider_id: providerId,
      provider_event_id: "evt-001",
      type: "delivered",
      recipient: "recipient@example.com",
      occurred_at: new Date().toISOString(),
    });
    expect(ev.id).toHaveLength(36);
    expect(ev.type).toBe("delivered");
    expect(ev.email_id).toBe(emailId);
    expect(ev.provider_id).toBe(providerId);
    expect(ev.provider_event_id).toBe("evt-001");
    expect(ev.recipient).toBe("recipient@example.com");
    // Round-trips through the /v1 store.
    expect(getEvent(ev.id)!.provider_event_id).toBe("evt-001");
  });

  it("creates event without email_id (null)", () => {
    const ev = createEvent({
      provider_id: providerId,
      type: "bounced",
      occurred_at: new Date().toISOString(),
    });
    expect(ev.email_id).toBeNull();
  });

  it("stores metadata", () => {
    const ev = createEvent({
      provider_id: providerId,
      type: "clicked",
      occurred_at: new Date().toISOString(),
      metadata: { url: "https://example.com" },
    });
    expect(ev.metadata).toEqual({ url: "https://example.com" });
    // Metadata round-trips back through /v1 (stored as a JSON string, coerced back).
    expect(getEvent(ev.id)!.metadata).toEqual({ url: "https://example.com" });
  });
});

describe("listEvents", () => {
  it("lists all events", () => {
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    createEvent({ provider_id: providerId, type: "bounced", occurred_at: new Date().toISOString() });
    expect(listEvents().length).toBe(2);
  });

  it("coerces malformed metadata JSON to an empty object", async () => {
    await stub.seed({
      events: [
        {
          id: "evt-bad",
          email_id: null,
          provider_id: providerId,
          provider_event_id: null,
          type: "delivered",
          recipient: null,
          metadata: "not-json",
          occurred_at: "2026-01-01T00:00:00.000Z",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const [found] = listEvents();
    expect(found?.metadata).toEqual({});
  });

  it("filters by type", () => {
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    createEvent({ provider_id: providerId, type: "bounced", occurred_at: new Date().toISOString() });
    expect(listEvents({ type: "delivered" }).length).toBe(1);
  });

  it("filters by multiple types", () => {
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    createEvent({ provider_id: providerId, type: "bounced", occurred_at: new Date().toISOString() });
    createEvent({ provider_id: providerId, type: "opened", occurred_at: new Date().toISOString() });
    expect(listEvents({ type: ["delivered", "bounced"] }).length).toBe(2);
  });

  it("filters by email_id", () => {
    createEvent({ email_id: emailId, provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    createEvent({ provider_id: providerId, type: "bounced", occurred_at: new Date().toISOString() });
    expect(listEvents({ email_id: emailId }).length).toBe(1);
  });

  it("filters by provider_id", () => {
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    createEvent({ provider_id: "prov-2", type: "delivered", occurred_at: new Date().toISOString() });
    expect(listEvents({ provider_id: providerId }).length).toBe(1);
  });

  it("filters by since", () => {
    const past = new Date(Date.now() - 10000).toISOString();
    const recent = new Date().toISOString();
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: past });
    createEvent({ provider_id: providerId, type: "bounced", occurred_at: recent });
    const mid = new Date(Date.now() - 5000).toISOString();
    expect(listEvents({ since: mid }).length).toBe(1);
  });

  it("supports limit", () => {
    for (let i = 0; i < 5; i++) {
      createEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    }
    expect(listEvents({ limit: 3 }).length).toBe(3);
  });

  it("clamps bad limit and offset values", () => {
    for (let i = 0; i < 5; i++) {
      createEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    }

    expect(listEvents({ limit: 0 }).length).toBe(1);
    expect(listEvents({ limit: -2 }).length).toBe(1);
    expect(listEvents({ limit: Number.NaN }).length).toBe(5);
    expect(listEvents({ limit: Number.POSITIVE_INFINITY, offset: Number.POSITIVE_INFINITY }).length).toBe(5);
  });
});

describe("listEventSummaries", () => {
  it("omits metadata payloads from the summary shape", () => {
    createEvent({
      provider_id: providerId,
      type: "clicked",
      recipient: "recipient@example.com",
      metadata: { url: "https://example.com/" + "large-metadata-".repeat(200) },
      occurred_at: "2026-01-01T00:00:00.000Z",
    });

    const [summary] = listEventSummaries({ provider_id: providerId });

    expect(summary).toMatchObject({
      provider_id: providerId,
      type: "clicked",
      recipient: "recipient@example.com",
    });
    expect("metadata" in summary!).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("large-metadata");
  });

  it("paginates summaries", () => {
    for (let i = 1; i <= 4; i++) {
      createEvent({
        provider_id: providerId,
        type: "delivered",
        occurred_at: `2026-01-0${i}T00:00:00.000Z`,
      });
    }

    const page = listEventSummaries({ provider_id: providerId, limit: 2, offset: 1 });
    expect(page.map((event) => event.occurred_at)).toEqual([
      "2026-01-03T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ]);
  });
});

describe("getEvent", () => {
  it("returns full event details including metadata", () => {
    const event = createEvent({
      provider_id: providerId,
      type: "clicked",
      metadata: { url: "https://example.com/full" },
      occurred_at: "2026-01-01T00:00:00.000Z",
    });

    expect(getEvent(event.id)).toMatchObject({
      id: event.id,
      metadata: { url: "https://example.com/full" },
    });
    expect(getEvent("missing")).toBeNull();
  });
});

describe("getEventsByEmail", () => {
  it("returns events for a specific email", () => {
    createEvent({ email_id: emailId, provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    createEvent({ email_id: emailId, provider_id: providerId, type: "opened", occurred_at: new Date().toISOString() });
    const events = getEventsByEmail(emailId);
    expect(events.length).toBe(2);
    expect(events.every((e) => e.email_id === emailId)).toBe(true);
  });
});

describe("upsertEvent", () => {
  it("creates new event when provider_event_id is new", () => {
    const ev = upsertEvent({
      provider_id: providerId,
      provider_event_id: "unique-001",
      type: "delivered",
      occurred_at: new Date().toISOString(),
    });
    expect(ev.id).toBeDefined();
  });

  it("returns existing event for duplicate provider_event_id", () => {
    const ev1 = upsertEvent({
      provider_id: providerId,
      provider_event_id: "dup-001",
      type: "delivered",
      occurred_at: new Date().toISOString(),
    });
    const ev2 = upsertEvent({
      provider_id: providerId,
      provider_event_id: "dup-001",
      type: "delivered",
      occurred_at: new Date().toISOString(),
    });
    expect(ev1.id).toBe(ev2.id);
    expect(listEvents().length).toBe(1);
  });

  it("reports whether an upsert created a new event", () => {
    const first = upsertEventWithResult({
      provider_id: providerId,
      provider_event_id: "result-001",
      type: "delivered",
      occurred_at: new Date().toISOString(),
    });
    const second = upsertEventWithResult({
      provider_id: providerId,
      provider_event_id: "result-001",
      type: "delivered",
      occurred_at: new Date().toISOString(),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.event.id).toBe(second.event.id);
  });

  it("creates separate events when no provider_event_id", () => {
    upsertEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    upsertEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    expect(listEvents().length).toBe(2);
  });
});
