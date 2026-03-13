import { describe, it, expect } from "bun:test";
import { parseResendWebhook, parseSesWebhook } from "./webhook.js";

describe("parseResendWebhook", () => {
  it("parses email.delivered event", () => {
    const body = {
      type: "email.delivered",
      data: {
        email_id: "evt-123",
        to: ["user@example.com"],
        created_at: "2025-01-15T10:00:00Z",
      },
    };
    const event = parseResendWebhook(body);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("delivered");
    expect(event!.recipient).toBe("user@example.com");
    expect(event!.provider_event_id).toBe("evt-123");
    expect(event!.occurred_at).toBe("2025-01-15T10:00:00Z");
  });

  it("parses email.bounced event", () => {
    const body = {
      type: "email.bounced",
      data: {
        email_id: "evt-456",
        to: "bounce@example.com",
        created_at: "2025-01-15T11:00:00Z",
      },
    };
    const event = parseResendWebhook(body);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("bounced");
    expect(event!.recipient).toBe("bounce@example.com");
  });

  it("parses email.complained event", () => {
    const body = {
      type: "email.complained",
      data: {
        email_id: "evt-789",
        to: ["complainer@example.com"],
        created_at: "2025-01-15T12:00:00Z",
      },
    };
    const event = parseResendWebhook(body);
    expect(event!.type).toBe("complained");
  });

  it("parses email.opened event", () => {
    const body = {
      type: "email.opened",
      data: {
        email_id: "evt-open",
        to: ["reader@example.com"],
        created_at: "2025-01-15T13:00:00Z",
      },
    };
    const event = parseResendWebhook(body);
    expect(event!.type).toBe("opened");
  });

  it("parses email.clicked event", () => {
    const body = {
      type: "email.clicked",
      data: {
        email_id: "evt-click",
        to: ["clicker@example.com"],
        created_at: "2025-01-15T14:00:00Z",
      },
    };
    const event = parseResendWebhook(body);
    expect(event!.type).toBe("clicked");
  });

  it("returns null for unknown event type", () => {
    const body = { type: "email.unknown", data: {} };
    expect(parseResendWebhook(body)).toBeNull();
  });

  it("returns null for completely unrecognized payload", () => {
    const body = { something: "else" };
    expect(parseResendWebhook(body)).toBeNull();
  });

  it("handles missing data gracefully", () => {
    const body = { type: "email.delivered" };
    const event = parseResendWebhook(body);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("delivered");
    expect(event!.recipient).toBeUndefined();
  });
});

describe("parseSesWebhook", () => {
  it("parses Delivery notification", () => {
    const body = {
      notificationType: "Delivery",
      mail: {
        messageId: "ses-msg-123",
        destination: ["user@example.com"],
        timestamp: "2025-01-15T10:00:00Z",
      },
    };
    const event = parseSesWebhook(body);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("delivered");
    expect(event!.recipient).toBe("user@example.com");
    expect(event!.provider_message_id).toBe("ses-msg-123");
    expect(event!.occurred_at).toBe("2025-01-15T10:00:00Z");
  });

  it("parses Bounce notification", () => {
    const body = {
      notificationType: "Bounce",
      mail: {
        messageId: "ses-msg-456",
        destination: ["bounce@example.com"],
        timestamp: "2025-01-15T11:00:00Z",
      },
    };
    const event = parseSesWebhook(body);
    expect(event!.type).toBe("bounced");
    expect(event!.recipient).toBe("bounce@example.com");
  });

  it("parses Complaint notification", () => {
    const body = {
      notificationType: "Complaint",
      mail: {
        messageId: "ses-msg-789",
        destination: ["complainer@example.com"],
        timestamp: "2025-01-15T12:00:00Z",
      },
    };
    const event = parseSesWebhook(body);
    expect(event!.type).toBe("complained");
  });

  it("returns null for unknown notification type", () => {
    const body = { notificationType: "Unknown", mail: {} };
    expect(parseSesWebhook(body)).toBeNull();
  });

  it("returns null for missing notificationType", () => {
    const body = { mail: { messageId: "test" } };
    expect(parseSesWebhook(body)).toBeNull();
  });

  it("handles missing mail fields gracefully", () => {
    const body = { notificationType: "Delivery" };
    const event = parseSesWebhook(body);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("delivered");
    expect(event!.recipient).toBeUndefined();
  });
});
