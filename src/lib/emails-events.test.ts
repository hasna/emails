import { describe, expect, it } from "bun:test";
import {
  EMAILS_EVENT_SCHEMA_VERSION,
  EMAILS_EVENT_SOURCE,
  LEGACY_MAILERY_EVENT_SCHEMA_VERSION,
  LEGACY_MAILERY_EVENT_SOURCE,
  isEmailsEventSource,
  normalizeEmailsEventType,
} from "./emails-events.js";

describe("Emails event rename compatibility", () => {
  it("writes canonical Emails identity while recognizing released Mailery rows", () => {
    expect([EMAILS_EVENT_SOURCE, EMAILS_EVENT_SCHEMA_VERSION]).toEqual(["emails", "emails.v1"]);
    expect([LEGACY_MAILERY_EVENT_SOURCE, LEGACY_MAILERY_EVENT_SCHEMA_VERSION]).toEqual(["mailery", "mailery.v1"]);
    expect(isEmailsEventSource("emails")).toBe(true);
    expect(isEmailsEventSource("mailery")).toBe(true);
    expect(isEmailsEventSource("other")).toBe(false);
  });

  it("normalizes historical event types without mutating unrelated types", () => {
    expect(normalizeEmailsEventType("mailery.inbound.received")).toBe("emails.inbound.received");
    expect(normalizeEmailsEventType("emails.inbound.received")).toBe("emails.inbound.received");
    expect(normalizeEmailsEventType("other.event")).toBe("other.event");
  });
});
