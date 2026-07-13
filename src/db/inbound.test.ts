// Self-hosted-ONLY: the inbound repo routes every read/write to the /v1
// `messages` resource (inbound + imported-sent mail unified as one message row).
// Exercises the REAL synchronous curl transport against an out-of-process /v1
// stub (see src/test-support/v1-stub.ts).
//
// Migrated from the deleted local-SQLite pattern. Dropped tests covered deleted
// local behavior:
//   - "returns newly stored inbound email without selecting the row back" and
//     "reads attachment paths with a narrow projection": SQL-string / projection
//     inspection of local SQLite (recordingDb). The attachment path shape is
//     retained functionally (self-hosted derives paths from server-side
//     attachment metadata — no local_path column).
//   - provider_id scoping ("filters by provider_id", "count filtered by
//     provider_id", "clears by provider_id"): a /v1 message carries no provider
//     dimension, so the filter is ignored and a provider-scoped clear is a
//     deliberate no-op. These local-only behaviors are gone.
//   - "recovers from malformed label JSON": recovered a local label_ids_json
//     column; the /v1 `labels` field is a real array.
//   - the whole "reply tracking (in_reply_to_email_id)" block: reply linkage was
//     auto-detected via the local `emails` table + a FK. Replies are now matched
//     by In-Reply-To header vs the target's Message-ID (see listReplies below);
//     apiToInboundEmail always reports in_reply_to_email_id as null.

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  storeInboundEmail,
  getInboundEmail,
  getInboundEmailSummary,
  getInboundAttachmentPaths,
  listInboundSubjectsForRecipient,
  listInboundEmails,
  listInboundEmailSummaries,
  listReplies,
  listReplySummaries,
  listReplyPromptParts,
  getReplyCount,
  deleteInboundEmail,
  clearInboundEmails,
  getInboundCount,
  getReceivedInboundCount,
  getLatestInboundReceivedAt,
  getLatestReceivedInboundAt,
  addInboundLabel,
  removeInboundLabel,
} from "./inbound.js";

let stub: V1Stub;

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

type StoreInput = Parameters<typeof storeInboundEmail>[0];

function store(overrides: Partial<StoreInput> = {}): ReturnType<typeof storeInboundEmail> {
  return storeInboundEmail({
    provider_id: null,
    message_id: "<test123@example.com>",
    from_address: "sender@example.com",
    to_addresses: ["receiver@example.com"],
    cc_addresses: [],
    subject: "Test subject",
    text_body: "Hello, world!",
    html_body: "<p>Hello, world!</p>",
    attachments: [],
    headers: { "content-type": "text/plain" },
    raw_size: 200,
    received_at: new Date().toISOString(),
    ...overrides,
  } as StoreInput);
}

describe("storeInboundEmail", () => {
  it("stores and returns an inbound email", () => {
    const email = store();
    expect(email.id).toBeTruthy();
    expect(email.from_address).toBe("sender@example.com");
    expect(email.subject).toBe("Test subject");
    expect(email.to_addresses).toEqual(["receiver@example.com"]);
    expect(email.html_body).toBe("<p>Hello, world!</p>");
    expect(email.created_at).toBeTruthy();
  });

  it("stores email with null provider_id", () => {
    const email = store({ provider_id: null });
    expect(email.provider_id).toBeNull();
  });
});

describe("getInboundEmail", () => {
  it("retrieves a stored email by id", () => {
    const stored = store();
    const retrieved = getInboundEmail(stored.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(stored.id);
    expect(retrieved!.subject).toBe("Test subject");
  });

  it("returns null for unknown id", () => {
    expect(getInboundEmail("nonexistent-id")).toBeNull();
  });

  it("tolerates malformed attachment JSON stored on /v1", async () => {
    await stub.seed({
      messages: [
        {
          id: "m-bad",
          direction: "inbound",
          from_addr: "sender@example.com",
          to_addrs: ["receiver@example.com"],
          subject: "Bad attachments",
          received_at: "2026-01-01T00:00:00.000Z",
          created_at: "2026-01-01T00:00:00.000Z",
          attachments: "not-json",
        },
      ],
    });

    expect(getInboundEmail("m-bad")?.attachment_paths).toEqual([]);
    expect(listInboundEmails({})[0]?.attachment_paths).toEqual([]);
    expect(getInboundAttachmentPaths("m-bad")).toEqual([]);
  });

  it("reads attachment metadata as attachment paths (no local_path server-side)", () => {
    const stored = store({
      attachments: [{ filename: "report.pdf", content_type: "application/pdf", size: 2048 }],
    });

    expect(getInboundAttachmentPaths(stored.id)).toEqual([
      { filename: "report.pdf", content_type: "application/pdf", size: 2048 },
    ]);
  });

  it("returns null attachment paths for an unknown inbound id", () => {
    expect(getInboundAttachmentPaths("missing")).toBeNull();
  });

  it("lists recent received subjects for one recipient, newest first", async () => {
    await stub.seed({
      messages: [
        { id: "old", direction: "inbound", from_addr: "s@x.com", to_addrs: ["Receiver@Example.com"], subject: "old target", received_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" },
        { id: "arch", direction: "inbound", from_addr: "s@x.com", to_addrs: ["receiver@example.com"], subject: "archived target", labels: ["archived"], received_at: "2026-01-03T00:00:00.000Z", created_at: "2026-01-03T00:00:00.000Z" },
        { id: "sent", direction: "outbound", from_addr: "me@x.com", to_addrs: ["receiver@example.com"], subject: "synced sent target", labels: ["SENT"], received_at: "2026-01-04T00:00:00.000Z", created_at: "2026-01-04T00:00:00.000Z" },
        { id: "other", direction: "inbound", from_addr: "s@x.com", to_addrs: ["other@example.com"], subject: "other recipient", received_at: "2026-01-05T00:00:00.000Z", created_at: "2026-01-05T00:00:00.000Z" },
        { id: "new", direction: "inbound", from_addr: "s@x.com", to_addrs: ["receiver@example.com"], subject: "new target", received_at: "2026-01-02T00:00:00.000Z", created_at: "2026-01-02T00:00:00.000Z" },
        { id: "offset", direction: "inbound", from_addr: "s@x.com", to_addrs: ["receiver@example.com"], subject: "offset target", received_at: "2026-01-01T23:30:00-02:00", created_at: "2026-01-01T23:30:00-02:00" },
      ],
    });

    const subjects = listInboundSubjectsForRecipient(
      "receiver@example.com",
      { since: "2026-01-02T00:00:00.000Z", limit: 10 },
    );

    expect(subjects.map((row) => row.subject)).toEqual(["new target", "offset target"]);
  });
});

describe("listInboundEmails", () => {
  it("lists all inbound emails", () => {
    store();
    store({ subject: "Second email" });
    expect(listInboundEmails({}).length).toBe(2);
  });

  it("respects limit option", () => {
    for (let i = 0; i < 5; i++) store({ subject: `Email ${i}` });
    expect(listInboundEmails({ limit: 3 }).length).toBe(3);
  });

  it("respects offset option", () => {
    for (let i = 0; i < 5; i++) store({ subject: `Offset Email ${i}`, received_at: `2026-01-0${i + 1}T00:00:00.000Z` });
    const page1 = listInboundEmails({ limit: 2, offset: 0 }).map((e) => e.id);
    const page2 = listInboundEmails({ limit: 2, offset: 2 }).map((e) => e.id);

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page2).not.toEqual(page1);
    expect(page2.some((id) => page1.includes(id))).toBe(false);
  });

  it("filters by since using timestamp instants instead of lexical text", () => {
    store({ subject: "before cutoff", received_at: "2026-07-11T23:59:59+00:00" });
    store({ subject: "offset after cutoff", received_at: "2026-07-11T23:30:00-02:00" });

    expect(listInboundEmails({ since: "2026-07-12T00:00:00.000Z" }).map((email) => email.subject)).toEqual(["offset after cutoff"]);
  });

  it("clamps negative pagination values", () => {
    for (let i = 0; i < 3; i++) store({ subject: `Clamp ${i}` });
    expect(listInboundEmails({ limit: -5, offset: -10 }).length).toBe(1);
  });

  it("returns empty array when none exist", () => {
    expect(listInboundEmails({})).toEqual([]);
  });

  it("filters recipient addresses and domains through display-name recipients", () => {
    store({ subject: "display recipient", to_addresses: ['"Target User" <target@example.com>'] });

    expect(listInboundEmails({ recipients: ["target@example.com"] }).map((email) => email.subject)).toEqual(["display recipient"]);
    expect(listInboundEmails({ recipientDomains: ["example.com"] }).map((email) => email.subject)).toEqual(["display recipient"]);
    expect(listInboundEmails({ recipients: ["not-an-email"] })).toEqual([]);
  });

  it("applies the search filter before the result limit", () => {
    store({ subject: "recent unrelated", to_addresses: ["recent@example.com"], text_body: "nothing to see", received_at: "2026-01-03T10:00:00.000Z" });
    store({ subject: "older matching", to_addresses: ["target@example.com"], text_body: "needle body", received_at: "2026-01-01T10:00:00.000Z" });

    expect(listInboundEmails({ search: "needle", limit: 1 }).map((email) => email.subject)).toEqual(["older matching"]);
    expect(listInboundEmails({ search: "target@example.com", limit: 1 }).map((email) => email.subject)).toEqual(["older matching"]);
  });

  it("lists summary rows without bodies or headers", () => {
    store({
      subject: "summary",
      text_body: "large text body ".repeat(1000),
      html_body: `<p>${"large html body ".repeat(1000)}</p>`,
      headers: { "x-large": "header" },
    });

    const [summary] = listInboundEmailSummaries({ limit: 1 });

    expect(summary?.subject).toBe("summary");
    expect("text_body" in summary!).toBe(false);
    expect("html_body" in summary!).toBe(false);
    expect("headers" in summary!).toBe(false);
  });

  it("reads one summary by id without bodies or headers", () => {
    const email = store({
      subject: "one summary",
      text_body: "large text body ".repeat(1000),
      html_body: `<p>${"large html body ".repeat(1000)}</p>`,
      headers: { "x-large": "header" },
    });

    const summary = getInboundEmailSummary(email.id);

    expect(summary?.subject).toBe("one summary");
    expect("text_body" in summary!).toBe(false);
    expect("html_body" in summary!).toBe(false);
    expect("headers" in summary!).toBe(false);
    expect(getInboundEmailSummary("missing")).toBeNull();
  });

  it("excludes imported SENT rows from received-mail lists by default", () => {
    store({ subject: "received" });
    const sent = store({ subject: "synced sent", from_address: "me@example.com", to_addresses: ["recipient@example.com"], label_ids: ["SENT"] });
    const lowerSent = store({ subject: "synced lower sent", message_id: "<lower-sent@example.com>", from_address: "me@example.com", to_addresses: ["recipient@example.com"], label_ids: ["sent"] });

    expect(sent.is_sent).toBe(true);
    expect(lowerSent.is_sent).toBe(true);
    expect(listInboundEmails({}).map((email) => email.subject)).toEqual(["received"]);
    expect(listInboundEmailSummaries({}).map((email) => email.subject)).toEqual(["received"]);
    expect(listInboundEmails({ sent: true }).map((email) => email.subject).sort()).toEqual(["synced lower sent", "synced sent"]);
    expect(listInboundEmails({ includeSent: true }).map((email) => email.subject).sort()).toEqual(["received", "synced lower sent", "synced sent"]);
  });
});

describe("deleteInboundEmail", () => {
  it("deletes an email by id", () => {
    const email = store();
    expect(deleteInboundEmail(email.id)).toBe(true);
    expect(getInboundEmail(email.id)).toBeNull();
  });

  it("returns false for unknown id", () => {
    expect(deleteInboundEmail("nonexistent")).toBe(false);
  });
});

describe("clearInboundEmails", () => {
  it("clears all inbound emails and returns count", () => {
    store();
    store();
    expect(clearInboundEmails()).toBe(2);
    expect(listInboundEmails({})).toEqual([]);
  });

  it("returns 0 when nothing to clear", () => {
    expect(clearInboundEmails()).toBe(0);
  });
});

describe("getInboundCount", () => {
  it("returns count of all inbound emails", () => {
    store();
    store();
    expect(getInboundCount()).toBe(2);
  });

  it("keeps received-only counts separate from synced sent rows", () => {
    store({ subject: "received" });
    store({ subject: "synced sent", from_address: "me@example.com", to_addresses: ["client@example.com"], label_ids: ["SENT"] });

    expect(getInboundCount()).toBe(2);
    expect(getReceivedInboundCount()).toBe(1);
  });
});

describe("getLatestInboundReceivedAt", () => {
  it("returns the newest inbound timestamp across archived and active mail", async () => {
    await stub.seed({
      messages: [
        { id: "older", direction: "inbound", from_addr: "s@x.com", to_addrs: ["me@x.com"], subject: "older", labels: ["archived"], received_at: "2026-01-01T10:00:00.000Z", created_at: "2026-01-01T10:00:00.000Z" },
        { id: "newer", direction: "inbound", from_addr: "s@x.com", to_addrs: ["me@x.com"], subject: "newer", received_at: "2026-01-02T10:00:00.000Z", created_at: "2026-01-02T10:00:00.000Z" },
      ],
    });

    expect(getLatestInboundReceivedAt()).toBe("2026-01-02T10:00:00.000Z");
  });

  it("returns null when there is no inbound mail", () => {
    expect(getLatestInboundReceivedAt()).toBeNull();
  });

  it("keeps the received-only newest timestamp separate from synced sent rows", () => {
    store({ subject: "received", received_at: "2026-01-01T10:00:00.000Z" });
    store({ subject: "newer sent", from_address: "me@example.com", to_addresses: ["client@example.com"], label_ids: ["SENT"], received_at: "2026-01-02T10:00:00.000Z" });

    expect(getLatestInboundReceivedAt()).toBe("2026-01-02T10:00:00.000Z");
    expect(getLatestReceivedInboundAt()).toBe("2026-01-01T10:00:00.000Z");
  });

  it("returns null when there is no received mail", () => {
    store({ subject: "sent only", from_address: "me@example.com", to_addresses: ["client@example.com"], label_ids: ["SENT"], received_at: "2026-01-02T10:00:00.000Z" });

    expect(getLatestReceivedInboundAt()).toBeNull();
  });
});

describe("label mutations", () => {
  it("matches labels case-insensitively for filters and mutations", () => {
    const stored = store({ label_ids: ["Urgent"] });

    expect(listInboundEmails({ label: "urgent" }).map((email) => email.id)).toEqual([stored.id]);
    expect(addInboundLabel(stored.id, "urgent").label_ids).toEqual(["Urgent"]);
    expect(removeInboundLabel(stored.id, "urgent").label_ids).toEqual([]);
  });

  it("normalizes whitespace and length consistently for label filters", () => {
    const longLabel = `Long ${"Label ".repeat(20)}`;
    const stored = store({ label_ids: ["Needs  Review", "Tab\tLabel", longLabel] });

    expect(listInboundEmails({ label: "Needs Review" }).map((email) => email.id)).toEqual([stored.id]);
    expect(listInboundEmails({ label: "tab label" }).map((email) => email.id)).toEqual([stored.id]);
    expect(listInboundEmails({ label: longLabel }).map((email) => email.id)).toEqual([stored.id]);
  });
});

// Replies are matched by In-Reply-To (on the reply row) against the target's
// Message-ID — no local emails-table join, no FK.
describe("listReplies", () => {
  it("lists inbound emails that reply to a target message", async () => {
    await stub.seed({
      messages: [
        { id: "t1", direction: "inbound", message_id: "<orig@x.com>", from_addr: "a@x.com", to_addrs: ["me@x.com"], subject: "orig", received_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" },
        { id: "r1", direction: "inbound", in_reply_to: "<orig@x.com>", from_addr: "b@x.com", to_addrs: ["me@x.com"], subject: "re a", received_at: "2026-01-02T00:00:00.000Z", created_at: "2026-01-02T00:00:00.000Z" },
        { id: "r2", direction: "inbound", in_reply_to: "orig@x.com", from_addr: "c@x.com", to_addrs: ["me@x.com"], subject: "re b", received_at: "2026-01-03T00:00:00.000Z", created_at: "2026-01-03T00:00:00.000Z" },
      ],
    });

    expect(listReplies("t1").length).toBe(2);
  });

  it("paginates replies in received order when requested", async () => {
    await stub.seed({
      messages: [
        { id: "t1", direction: "inbound", message_id: "<orig@x.com>", from_addr: "a@x.com", to_addrs: ["me@x.com"], subject: "orig", received_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" },
        { id: "old", direction: "inbound", in_reply_to: "<orig@x.com>", from_addr: "b@x.com", to_addrs: ["me@x.com"], subject: "Old reply", received_at: "2026-01-02T00:00:00.000Z", created_at: "2026-01-02T00:00:00.000Z" },
        { id: "mid", direction: "inbound", in_reply_to: "<orig@x.com>", from_addr: "b@x.com", to_addrs: ["me@x.com"], subject: "Middle reply", received_at: "2026-01-03T00:00:00.000Z", created_at: "2026-01-03T00:00:00.000Z" },
        { id: "new", direction: "inbound", in_reply_to: "<orig@x.com>", from_addr: "b@x.com", to_addrs: ["me@x.com"], subject: "New reply", received_at: "2026-01-04T00:00:00.000Z", created_at: "2026-01-04T00:00:00.000Z" },
      ],
    });

    const page = listReplies("t1", { limit: 1, offset: 1 });
    expect(page.map((reply) => reply.subject)).toEqual(["Middle reply"]);
  });

  it("returns empty array when no replies", () => {
    expect(listReplies("nonexistent-email-id")).toEqual([]);
  });

  it("lists reply summaries without bodies or headers", async () => {
    await stub.seed({
      messages: [
        { id: "t1", direction: "inbound", message_id: "<orig@x.com>", from_addr: "a@x.com", to_addrs: ["me@x.com"], subject: "orig", received_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" },
        { id: "r1", direction: "inbound", in_reply_to: "<orig@x.com>", from_addr: "b@x.com", to_addrs: ["me@x.com"], subject: "Summary reply", body_text: "large reply body ".repeat(1000), body_html: `<p>${"large reply html ".repeat(1000)}</p>`, headers: { "x-large": "header" }, received_at: "2026-01-02T00:00:00.000Z", created_at: "2026-01-02T00:00:00.000Z" },
      ],
    });

    const [summary] = listReplySummaries("t1", { limit: 1 });

    expect(summary?.subject).toBe("Summary reply");
    expect("text_body" in summary!).toBe(false);
    expect("html_body" in summary!).toBe(false);
    expect("headers" in summary!).toBe(false);
  });

  it("lists reply prompt parts as from/subject/text only", async () => {
    await stub.seed({
      messages: [
        { id: "t1", direction: "inbound", message_id: "<orig@x.com>", from_addr: "a@x.com", to_addrs: ["me@x.com"], subject: "orig", received_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" },
        { id: "r1", direction: "inbound", in_reply_to: "<orig@x.com>", from_addr: "sender@example.com", to_addrs: ["me@x.com"], subject: "Prompt reply", body_text: "short prompt body", body_html: `<p>${"large reply html ".repeat(1000)}</p>`, received_at: "2026-01-02T00:00:00.000Z", created_at: "2026-01-02T00:00:00.000Z" },
      ],
    });

    const [part] = listReplyPromptParts("t1", { limit: 1 });

    expect(part).toEqual({
      from_address: "sender@example.com",
      subject: "Prompt reply",
      text_body: "short prompt body",
    });
  });
});

describe("getReplyCount", () => {
  it("counts replies for a target message", async () => {
    await stub.seed({
      messages: [
        { id: "t1", direction: "inbound", message_id: "<orig@x.com>", from_addr: "a@x.com", to_addrs: ["me@x.com"], subject: "orig", received_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" },
        { id: "r1", direction: "inbound", in_reply_to: "<orig@x.com>", from_addr: "b@x.com", to_addrs: ["me@x.com"], subject: "re", received_at: "2026-01-02T00:00:00.000Z", created_at: "2026-01-02T00:00:00.000Z" },
      ],
    });

    expect(getReplyCount("t1")).toBe(1);
  });

  it("returns 0 for a message with no replies", () => {
    expect(getReplyCount("nonexistent")).toBe(0);
  });
});
