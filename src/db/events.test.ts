import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "./database.js";
import { createProvider } from "./providers.js";
import { createEmail } from "./emails.js";
import {
  createEvent,
  listEvents,
  getEventsByEmail,
  upsertEvent,
} from "./events.js";

let providerId: string;
let emailId: string;

const baseOpts = {
  from: "sender@example.com",
  to: ["recipient@example.com"],
  subject: "Test",
};

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const p = createProvider({ name: "Test", type: "resend" });
  providerId = p.id;
  const e = createEmail(providerId, baseOpts);
  emailId = e.id;
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
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
  });
});

describe("listEvents", () => {
  it("lists all events", () => {
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    createEvent({ provider_id: providerId, type: "bounced", occurred_at: new Date().toISOString() });
    expect(listEvents().length).toBe(2);
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
    const p2 = createProvider({ name: "Other", type: "ses" });
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    createEvent({ provider_id: p2.id, type: "delivered", occurred_at: new Date().toISOString() });
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

  it("creates separate events when no provider_event_id", () => {
    upsertEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    upsertEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    expect(listEvents().length).toBe(2);
  });
});
