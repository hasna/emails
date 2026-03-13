import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "./database.js";
import { createProvider } from "./providers.js";
import {
  createEmail,
  getEmail,
  listEmails,
  searchEmails,
  updateEmailStatus,
  deleteEmail,
} from "./emails.js";
import { EmailNotFoundError } from "../types/index.js";

let providerId: string;

const baseOpts = {
  from: "sender@example.com",
  to: ["recipient@example.com"],
  subject: "Test Subject",
  text: "Hello world",
};

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const p = createProvider({ name: "Test", type: "resend" });
  providerId = p.id;
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("createEmail", () => {
  it("creates an email with status=sent", () => {
    const e = createEmail(providerId, baseOpts);
    expect(e.id).toHaveLength(36);
    expect(e.from_address).toBe("sender@example.com");
    expect(e.to_addresses).toEqual(["recipient@example.com"]);
    expect(e.subject).toBe("Test Subject");
    expect(e.status).toBe("sent");
    expect(e.has_attachments).toBe(false);
    expect(e.attachment_count).toBe(0);
  });

  it("stores multiple recipients", () => {
    const e = createEmail(providerId, { ...baseOpts, to: ["a@x.com", "b@x.com"] });
    expect(e.to_addresses).toEqual(["a@x.com", "b@x.com"]);
  });

  it("stores cc and bcc", () => {
    const e = createEmail(providerId, { ...baseOpts, cc: ["cc@x.com"], bcc: ["bcc@x.com"] });
    expect(e.cc_addresses).toEqual(["cc@x.com"]);
    expect(e.bcc_addresses).toEqual(["bcc@x.com"]);
  });

  it("stores attachment info", () => {
    const e = createEmail(providerId, {
      ...baseOpts,
      attachments: [{ filename: "test.pdf", content: "abc", content_type: "application/pdf" }],
    });
    expect(e.has_attachments).toBe(true);
    expect(e.attachment_count).toBe(1);
  });

  it("stores provider_message_id", () => {
    const e = createEmail(providerId, baseOpts, "msg-123");
    expect(e.provider_message_id).toBe("msg-123");
  });

  it("stores tags", () => {
    const e = createEmail(providerId, { ...baseOpts, tags: { campaign: "welcome" } });
    expect(e.tags).toEqual({ campaign: "welcome" });
  });
});

describe("getEmail", () => {
  it("retrieves email by id", () => {
    const e = createEmail(providerId, baseOpts);
    const found = getEmail(e.id);
    expect(found?.id).toBe(e.id);
  });

  it("returns null for unknown id", () => {
    expect(getEmail("nonexistent")).toBeNull();
  });
});

describe("listEmails", () => {
  it("lists all emails", () => {
    createEmail(providerId, baseOpts);
    createEmail(providerId, { ...baseOpts, subject: "Second" });
    expect(listEmails().length).toBe(2);
  });

  it("filters by provider_id", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    createEmail(providerId, baseOpts);
    createEmail(p2.id, baseOpts);
    expect(listEmails({ provider_id: providerId }).length).toBe(1);
  });

  it("filters by status", () => {
    const e = createEmail(providerId, baseOpts);
    updateEmailStatus(e.id, "delivered");
    createEmail(providerId, { ...baseOpts, subject: "Second" });
    const delivered = listEmails({ status: "delivered" });
    const sent = listEmails({ status: "sent" });
    expect(delivered.length).toBe(1);
    expect(sent.length).toBe(1);
  });

  it("filters by multiple statuses", () => {
    const e1 = createEmail(providerId, baseOpts);
    updateEmailStatus(e1.id, "delivered");
    const e2 = createEmail(providerId, { ...baseOpts, subject: "B" });
    updateEmailStatus(e2.id, "bounced");
    createEmail(providerId, { ...baseOpts, subject: "C" });
    const list = listEmails({ status: ["delivered", "bounced"] });
    expect(list.length).toBe(2);
  });

  it("supports limit and offset", () => {
    for (let i = 0; i < 5; i++) createEmail(providerId, { ...baseOpts, subject: `Email ${i}` });
    expect(listEmails({ limit: 3 }).length).toBe(3);
    expect(listEmails({ limit: 3, offset: 3 }).length).toBe(2);
  });
});

describe("updateEmailStatus", () => {
  it("updates status", () => {
    const e = createEmail(providerId, baseOpts);
    const updated = updateEmailStatus(e.id, "delivered");
    expect(updated.status).toBe("delivered");
  });

  it("throws EmailNotFoundError for unknown id", () => {
    expect(() => updateEmailStatus("nonexistent", "delivered")).toThrow(EmailNotFoundError);
  });
});

describe("deleteEmail", () => {
  it("deletes an email", () => {
    const e = createEmail(providerId, baseOpts);
    expect(deleteEmail(e.id)).toBe(true);
    expect(getEmail(e.id)).toBeNull();
  });

  it("returns false for unknown id", () => {
    expect(deleteEmail("nonexistent")).toBe(false);
  });
});

describe("searchEmails", () => {
  it("searches by subject", () => {
    createEmail(providerId, { ...baseOpts, subject: "Welcome aboard" });
    createEmail(providerId, { ...baseOpts, subject: "Password reset" });
    const results = searchEmails("Welcome");
    expect(results.length).toBe(1);
    expect(results[0]!.subject).toBe("Welcome aboard");
  });

  it("searches by from_address", () => {
    createEmail(providerId, { ...baseOpts, from: "alice@example.com" });
    createEmail(providerId, { ...baseOpts, from: "bob@example.com" });
    const results = searchEmails("alice");
    expect(results.length).toBe(1);
    expect(results[0]!.from_address).toBe("alice@example.com");
  });

  it("searches by to_addresses", () => {
    createEmail(providerId, { ...baseOpts, to: ["charlie@example.com"] });
    createEmail(providerId, { ...baseOpts, to: ["dave@example.com"] });
    const results = searchEmails("charlie");
    expect(results.length).toBe(1);
    expect(results[0]!.to_addresses).toEqual(["charlie@example.com"]);
  });

  it("respects limit option", () => {
    for (let i = 0; i < 5; i++) {
      createEmail(providerId, { ...baseOpts, subject: `Match ${i}` });
    }
    const results = searchEmails("Match", { limit: 3 });
    expect(results.length).toBe(3);
  });

  it("returns empty array for no matches", () => {
    createEmail(providerId, baseOpts);
    const results = searchEmails("nonexistent-term-xyz");
    expect(results.length).toBe(0);
  });

  it("is case-insensitive via LIKE", () => {
    createEmail(providerId, { ...baseOpts, subject: "IMPORTANT Notice" });
    const results = searchEmails("important");
    expect(results.length).toBe(1);
  });
});
