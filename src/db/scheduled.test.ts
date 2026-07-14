// Self-hosted-ONLY: the scheduled-email repo routes every read/write to the
// /v1/scheduled API. Exercises the REAL curl transport against an out-of-process
// /v1 stub — see src/test-support/v1-stub.ts. Migrated from the deleted
// local-SQLite pattern (getDatabase/resetDatabase/:memory:/EMAILS_DB_PATH).
//
// The former "lean projection" summary test inspected the local SQL string
// (recordingDb Proxy, `SELECT *`, column names) and passed a `db` handle that no
// longer exists; the meaningful part — bodies/attachments/template_vars omitted
// from the summary shape — is retained functionally below.

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  createScheduledEmail,
  getScheduledEmail,
  listScheduledEmails,
  listScheduledEmailSummaries,
  cancelScheduledEmail,
  getDueEmails,
  markSent,
  markFailed,
} from "./scheduled.js";

let stub: V1Stub;

const testProviderId = "prov-1";

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

  it("coerces malformed recipient, attachment, and template JSON", async () => {
    // A /v1 row with non-array/non-object JSON strings must map to []/[]/{}.
    await stub.seed({
      scheduled: [
        {
          id: "sched-bad",
          provider_id: testProviderId,
          from_address: "sender@example.com",
          to_addresses: "{}",
          cc_addresses: "{}",
          bcc_addresses: "{}",
          attachments_json: "not-json",
          template_vars: "not-json",
          subject: "Bad JSON",
          status: "pending",
          scheduled_at: "2030-01-01T00:00:00.000Z",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const found = getScheduledEmail("sched-bad");
    expect(found?.to_addresses).toEqual([]);
    expect(found?.cc_addresses).toEqual([]);
    expect(found?.bcc_addresses).toEqual([]);
    expect(found?.attachments_json).toEqual([]);
    expect(found?.template_vars).toEqual({});
  });

  it("returns null for unknown id", () => {
    expect(getScheduledEmail("nonexistent")).toBeNull();
  });
});

describe("listScheduledEmails", () => {
  it("returns empty array when none exist", () => {
    expect(listScheduledEmails()).toEqual([]);
  });

  it("lists all scheduled emails ordered by scheduled_at ASC", () => {
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

  it("paginates scheduled emails after applying status filters", () => {
    for (let i = 0; i < 5; i++) {
      createScheduledEmail({
        provider_id: testProviderId,
        from_address: "sender@example.com",
        to_addresses: [`pending-${i}@example.com`],
        subject: `Pending ${i}`,
        scheduled_at: `2030-01-0${i + 1}T00:00:00.000Z`,
      });
    }
    const sent = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["sent@example.com"],
      subject: "Sent",
      scheduled_at: "2030-01-01T12:00:00.000Z",
    });
    markSent(sent.id);

    const page = listScheduledEmails({ status: "pending", limit: 2, offset: 1 });

    expect(page).toHaveLength(2);
    expect(page.every((email) => email.status === "pending")).toBe(true);
    expect(page.map((email) => email.subject)).not.toContain("Sent");
  });
});

describe("listScheduledEmailSummaries", () => {
  it("omits bodies, attachments, and template vars from the summary shape", () => {
    createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["alice@example.com"],
      subject: "Large scheduled payload",
      html: `<p>${"large html ".repeat(200)}</p>`,
      text_body: "large text ".repeat(200),
      attachments_json: [{ filename: "large.txt", content: "secret attachment".repeat(100) }],
      template_name: "welcome",
      template_vars: { secret: "large template vars".repeat(100) },
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    const [summary] = listScheduledEmailSummaries({ limit: 1 });

    expect(summary).toBeDefined();
    expect(summary?.subject).toBe("Large scheduled payload");
    expect(summary?.template_name).toBe("welcome");
    expect("html" in summary!).toBe(false);
    expect("text_body" in summary!).toBe(false);
    expect("attachments_json" in summary!).toBe(false);
    expect("template_vars" in summary!).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("secret attachment");
    expect(JSON.stringify(summary)).not.toContain("large template vars");
  });

  it("filters and paginates summary rows", () => {
    for (let i = 0; i < 5; i++) {
      createScheduledEmail({
        provider_id: testProviderId,
        from_address: "sender@example.com",
        to_addresses: [`pending-${i}@example.com`],
        subject: `Summary pending ${i}`,
        scheduled_at: `2030-01-0${i + 1}T00:00:00.000Z`,
      });
    }
    const sent = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["sent@example.com"],
      subject: "Summary sent",
      scheduled_at: "2030-01-01T12:00:00.000Z",
    });
    markSent(sent.id);

    const page = listScheduledEmailSummaries({ status: "pending", limit: 2, offset: 1 });

    expect(page).toHaveLength(2);
    expect(page.every((email) => email.status === "pending")).toBe(true);
    expect(page.map((email) => email.subject)).toEqual(["Summary pending 1", "Summary pending 2"]);
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
    createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Past",
      scheduled_at: "2000-01-01T00:00:00.000Z",
    });
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

  it("limits due emails after ordering by scheduled time", () => {
    for (let i = 0; i < 5; i++) {
      createScheduledEmail({
        provider_id: testProviderId,
        from_address: "sender@example.com",
        to_addresses: [`due-${i}@example.com`],
        subject: `Due ${i}`,
        scheduled_at: `2000-01-0${i + 1}T00:00:00.000Z`,
      });
    }

    const due = getDueEmails({ limit: 2 });

    expect(due.map((email) => email.subject)).toEqual(["Due 0", "Due 1"]);
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
