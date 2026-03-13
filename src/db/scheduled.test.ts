import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, closeDatabase, resetDatabase } from "./database.js";
import { createProvider } from "./providers.js";
import {
  createScheduledEmail,
  getScheduledEmail,
  listScheduledEmails,
  cancelScheduledEmail,
  getDueEmails,
  markSent,
  markFailed,
} from "./scheduled.js";

let testProviderId: string;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const db = getDatabase();
  // Create a test provider
  const provider = createProvider({ name: "test", type: "resend", api_key: "re_test" }, db);
  testProviderId = provider.id;
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("createScheduledEmail", () => {
  it("creates a scheduled email", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["alice@example.com"],
      subject: "Test Subject",
      html: "<p>Hello</p>",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    expect(scheduled.id).toHaveLength(36);
    expect(scheduled.provider_id).toBe(testProviderId);
    expect(scheduled.from_address).toBe("sender@example.com");
    expect(scheduled.to_addresses).toEqual(["alice@example.com"]);
    expect(scheduled.subject).toBe("Test Subject");
    expect(scheduled.html).toBe("<p>Hello</p>");
    expect(scheduled.status).toBe("pending");
    expect(scheduled.scheduled_at).toBe("2030-01-01T00:00:00.000Z");
    expect(scheduled.error).toBeNull();
  });

  it("creates with cc, bcc, reply_to", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["alice@example.com"],
      cc_addresses: ["bob@example.com"],
      bcc_addresses: ["charlie@example.com"],
      reply_to: "reply@example.com",
      subject: "Test",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    expect(scheduled.cc_addresses).toEqual(["bob@example.com"]);
    expect(scheduled.bcc_addresses).toEqual(["charlie@example.com"]);
    expect(scheduled.reply_to).toBe("reply@example.com");
  });

  it("creates with template info", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["alice@example.com"],
      subject: "Hello {{name}}",
      template_name: "welcome",
      template_vars: { name: "Alice" },
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    expect(scheduled.template_name).toBe("welcome");
    expect(scheduled.template_vars).toEqual({ name: "Alice" });
  });
});

describe("getScheduledEmail", () => {
  it("retrieves by id", () => {
    const created = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["alice@example.com"],
      subject: "Test",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    const found = getScheduledEmail(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  it("returns null for unknown id", () => {
    expect(getScheduledEmail("nonexistent")).toBeNull();
  });
});

describe("listScheduledEmails", () => {
  it("returns empty array when none exist", () => {
    expect(listScheduledEmails()).toEqual([]);
  });

  it("lists all scheduled emails", () => {
    createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Test 1",
      scheduled_at: "2030-01-02T00:00:00.000Z",
    });
    createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["b@example.com"],
      subject: "Test 2",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    const all = listScheduledEmails();
    expect(all.length).toBe(2);
    // Ordered by scheduled_at ASC
    expect(all[0]!.subject).toBe("Test 2");
    expect(all[1]!.subject).toBe("Test 1");
  });

  it("filters by status", () => {
    const s1 = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Test 1",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });
    createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["b@example.com"],
      subject: "Test 2",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    markSent(s1.id);

    const pending = listScheduledEmails({ status: "pending" });
    expect(pending.length).toBe(1);
    expect(pending[0]!.subject).toBe("Test 2");

    const sent = listScheduledEmails({ status: "sent" });
    expect(sent.length).toBe(1);
    expect(sent[0]!.subject).toBe("Test 1");
  });
});

describe("cancelScheduledEmail", () => {
  it("cancels a pending email", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Test",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    const result = cancelScheduledEmail(scheduled.id);
    expect(result).toBe(true);

    const updated = getScheduledEmail(scheduled.id);
    expect(updated!.status).toBe("cancelled");
  });

  it("returns false if already sent", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Test",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    markSent(scheduled.id);
    const result = cancelScheduledEmail(scheduled.id);
    expect(result).toBe(false);
  });

  it("returns false if already cancelled", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Test",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    cancelScheduledEmail(scheduled.id);
    const result = cancelScheduledEmail(scheduled.id);
    expect(result).toBe(false);
  });
});

describe("getDueEmails", () => {
  it("returns emails past their scheduled time", () => {
    // Past time
    createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Past",
      scheduled_at: "2000-01-01T00:00:00.000Z",
    });
    // Future time
    createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["b@example.com"],
      subject: "Future",
      scheduled_at: "2099-01-01T00:00:00.000Z",
    });

    const due = getDueEmails();
    expect(due.length).toBe(1);
    expect(due[0]!.subject).toBe("Past");
  });

  it("does not return sent or cancelled emails", () => {
    const s1 = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Sent",
      scheduled_at: "2000-01-01T00:00:00.000Z",
    });
    const s2 = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["b@example.com"],
      subject: "Cancelled",
      scheduled_at: "2000-01-01T00:00:00.000Z",
    });

    markSent(s1.id);
    cancelScheduledEmail(s2.id);

    const due = getDueEmails();
    expect(due.length).toBe(0);
  });
});

describe("markSent", () => {
  it("marks email as sent", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Test",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    markSent(scheduled.id);
    const updated = getScheduledEmail(scheduled.id);
    expect(updated!.status).toBe("sent");
  });
});

describe("markFailed", () => {
  it("marks email as failed with error message", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Test",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    markFailed(scheduled.id, "Connection timeout");
    const updated = getScheduledEmail(scheduled.id);
    expect(updated!.status).toBe("failed");
    expect(updated!.error).toBe("Connection timeout");
  });
});
