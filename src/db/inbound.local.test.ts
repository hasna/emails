import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "./database.js";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import {
  addInboundLabel,
  addInboundLabelSummary,
  clearInboundEmails,
  deleteInboundEmail,
  getInboundAttachmentPaths,
  getInboundCount,
  getInboundEmail,
  getInboundEmailSummary,
  getLatestInboundReceivedAt,
  getLatestReceivedInboundAt,
  getReceivedInboundCount,
  getReplyCount,
  getUnreadCount,
  inboundEmailBelongsToOwner,
  inboundRecipientMatches,
  listInboundEmailSummaries,
  listInboundEmailSummariesForOwner,
  listInboundEmails,
  listInboundEmailsForOwner,
  listInboundInsertionSummariesPage,
  listInboundSubjectsForRecipient,
  listReplies,
  listReplyPromptParts,
  listReplySummaries,
  normalizeEmailAddress,
  removeInboundLabel,
  removeInboundLabelSummary,
  setInboundArchived,
  setInboundArchivedFlag,
  setInboundArchivedSummary,
  setInboundRead,
  setInboundReadFlag,
  setInboundReadSummary,
  setInboundStarred,
  setInboundStarredFlag,
  setInboundStarredSummary,
  storeInboundEmail,
  updateAttachmentPaths,
} from "./inbound.local.js";

let db: Database;
let originalDbPath: string | undefined;
let sequence = 0;

type StoreInput = Parameters<typeof storeInboundEmail>[0];

beforeEach(() => {
  originalDbPath = process.env.EMAILS_DB_PATH;
  process.env.EMAILS_DB_PATH = ":memory:";
  resetDatabase();
  db = getDatabase();
  sequence = 0;
});

afterEach(() => {
  closeDatabase();
  if (originalDbPath === undefined) delete process.env.EMAILS_DB_PATH;
  else process.env.EMAILS_DB_PATH = originalDbPath;
});

function addProvider(id: string): void {
  db.run(
    "INSERT INTO providers (id, name, type, active) VALUES (?, ?, 'resend', 1)",
    [id, id],
  );
}

function store(overrides: Partial<StoreInput> = {}) {
  sequence += 1;
  return storeInboundEmail({
    provider_id: null,
    message_id: `<inbound-${sequence}@example.com>`,
    in_reply_to_email_id: null,
    from_address: `sender-${sequence}@example.com`,
    to_addresses: ["receiver@example.com"],
    cc_addresses: [],
    subject: `Subject ${sequence}`,
    text_body: `Body ${sequence}`,
    html_body: null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: 100,
    received_at: `2026-01-${String(sequence).padStart(2, "0")}T00:00:00.000Z`,
    ...overrides,
  }, db);
}

function insertSentEmail(id: string, providerMessageId: string): void {
  addProvider("sent-provider");
  db.run(
    `INSERT INTO emails
       (id, provider_id, provider_message_id, from_address, to_addresses, subject, sent_at)
     VALUES (?, 'sent-provider', ?, 'me@example.com', '["contact@example.com"]', 'Original', '2026-01-01T00:00:00.000Z')`,
    [id, providerMessageId],
  );
}

describe("address normalization and recipient matching", () => {
  it("normalizes plain and display-name addresses", () => {
    expect(normalizeEmailAddress("  USER@Example.COM ")).toBe("user@example.com");
    expect(normalizeEmailAddress('Name <USER@Example.COM>')).toBe("user@example.com");
  });

  it("rejects empty or malformed addresses and matches exact addresses or domains", () => {
    expect(normalizeEmailAddress(undefined)).toBeNull();
    expect(normalizeEmailAddress("not-an-email")).toBeNull();
    expect(inboundRecipientMatches("Name <user@example.com>", ["USER@example.com"], [])).toBe(true);
    expect(inboundRecipientMatches("other@example.com", [], [" EXAMPLE.COM "])).toBe(true);
    expect(inboundRecipientMatches("bad", ["bad"], ["example.com"])).toBe(false);
    expect(inboundRecipientMatches("other@example.net", [], ["example.com"])).toBe(false);
  });
});

describe("storage and projections", () => {
  it("stores local metadata, sent state, and a fallback received timestamp", () => {
    const email = store({
      received_at: "",
      label_ids: [" Sent "],
      provider_thread_id: "provider-thread",
      provider_history_id: "history",
      provider_internal_date: "internal-date",
      raw_s3_url: "s3://bucket/raw",
      metadata_s3_url: "s3://bucket/meta",
    });

    expect(email).toMatchObject({
      provider_thread_id: "provider-thread",
      provider_history_id: "history",
      provider_internal_date: "internal-date",
      raw_s3_url: "s3://bucket/raw",
      metadata_s3_url: "s3://bucket/meta",
      is_sent: true,
      is_read: false,
      is_archived: false,
      is_starred: false,
    });
    expect(Date.parse(email.received_at)).not.toBeNaN();
    expect(getInboundEmail(email.id, db)?.id).toBe(email.id);
  });

  it("auto-links replies and cancels active sequence enrollment", () => {
    insertSentEmail("sent-1", "original@example.com");
    db.run("INSERT INTO sequences (id, name) VALUES ('sequence-1', 'Follow up')");
    db.run(
      "INSERT INTO sequence_enrollments (id, sequence_id, contact_email) VALUES ('enrollment-1', 'sequence-1', 'contact@example.com')",
    );

    const reply = store({
      from_address: "contact@example.com",
      headers: { "In-Reply-To": "<original@example.com>" },
    });

    expect(reply.in_reply_to_email_id).toBe("sent-1");
    expect(db.query("SELECT status FROM sequence_enrollments WHERE id = 'enrollment-1'").get()).toEqual({
      status: "cancelled",
    });
  });

  it("updates attachment paths and returns null for missing rows", () => {
    const email = store();
    const paths = [{ index: 0, filename: "report.pdf", content_type: "application/pdf", size: 42, local_path: "/tmp/report.pdf" }];

    updateAttachmentPaths(email.id, paths, db);

    expect(getInboundAttachmentPaths(email.id, db)).toEqual(paths);
    expect(getInboundAttachmentPaths("missing", db)).toBeNull();
    expect(getInboundEmail("missing", db)).toBeNull();
    expect(getInboundEmailSummary("missing", db)).toBeNull();
  });

  it("returns lean summaries and tolerates malformed legacy JSON as empty values", () => {
    const email = store({ text_body: "wide body", html_body: "<p>wide</p>", headers: { secret: "value" } });
    db.run(
      "UPDATE inbound_emails SET label_ids_json = 'not-json', to_addresses = 'bad', attachments_json = 'bad' WHERE id = ?",
      [email.id],
    );

    const summary = getInboundEmailSummary(email.id, db)!;
    expect(summary.label_ids).toEqual([]);
    expect(summary.to_addresses).toEqual([]);
    expect(summary.attachments).toEqual([]);
    expect("text_body" in summary).toBe(false);
    expect("html_body" in summary).toBe(false);
    expect("headers" in summary).toBe(false);
  });
});

describe("reply views", () => {
  it("lists full, summary, and prompt projections in received order with pagination", () => {
    insertSentEmail("sent-1", "sent-message@example.com");
    const first = store({
      in_reply_to_email_id: "sent-1",
      from_address: "first@example.com",
      subject: "First",
      text_body: "first body",
      received_at: "2026-02-01T00:00:00.000Z",
    });
    const second = store({
      in_reply_to_email_id: "sent-1",
      from_address: "second@example.com",
      subject: "Second",
      text_body: "second body",
      received_at: "2026-02-02T00:00:00.000Z",
    });

    expect(listReplies("sent-1", db).map((row) => row.id)).toEqual([first.id, second.id]);
    expect(listReplies("sent-1", db, { limit: 1, offset: 1 }).map((row) => row.id)).toEqual([second.id]);
    const [summary] = listReplySummaries("sent-1", db, { limit: 1 });
    expect(summary?.id).toBe(first.id);
    expect("text_body" in summary!).toBe(false);
    expect(listReplyPromptParts("sent-1", db, { limit: 1, offset: 1 })).toEqual([{
      from_address: "second@example.com",
      subject: "Second",
      text_body: "second body",
    }]);
    expect(getReplyCount("sent-1", db)).toBe(2);
  });

  it("returns empty reply views and a zero count for an unknown target", () => {
    expect(listReplies("missing", db)).toEqual([]);
    expect(listReplySummaries("missing", db)).toEqual([]);
    expect(listReplyPromptParts("missing", db)).toEqual([]);
    expect(getReplyCount("missing", db)).toBe(0);
  });
});

describe("listing and insertion-page boundaries", () => {
  it("filters by provider, timestamps, state, text, labels, and recipients before paging", () => {
    addProvider("provider-1");
    addProvider("provider-2");
    const target = store({
      provider_id: "provider-1",
      from_address: "Alerts@Example.com",
      to_addresses: ['Target User <target@example.com>'],
      subject: "Needle subject",
      text_body: "searchable body",
      label_ids: ["Needs  Review"],
      received_at: "2026-03-02T00:00:00.000Z",
    });
    store({ provider_id: "provider-2", subject: "Other", received_at: "2026-03-01T00:00:00.000Z" });
    const sent = store({ provider_id: "provider-1", subject: "Sent", label_ids: ["SENT"], received_at: "2026-03-03T00:00:00.000Z" });
    setInboundReadFlag(target.id, true, db);
    setInboundStarredFlag(target.id, true, db);

    expect(listInboundEmails({ provider_id: "provider-1", read: true, starred: true }, db).map((row) => row.id)).toEqual([target.id]);
    expect(listInboundEmails({ unread: true }, db).every((row) => !row.is_read)).toBe(true);
    expect(listInboundEmails({ from: "alerts", subject: "needle", search: "searchable" }, db).map((row) => row.id)).toEqual([target.id]);
    expect(listInboundEmails({ label: "needs review" }, db).map((row) => row.id)).toEqual([target.id]);
    expect(listInboundEmails({ recipients: ["TARGET@example.com"] }, db).map((row) => row.id)).toEqual([target.id]);
    expect(listInboundEmails({ recipientDomains: ["example.com"] }, db).map((row) => row.id)).toContain(target.id);
    expect(listInboundEmails({ recipients: ["not-an-email"] }, db)).toEqual([]);
    expect(listInboundEmails({ since: "2026-03-02T00:00:00.000Z" }, db).map((row) => row.id)).toEqual([target.id]);
    expect(listInboundEmails({ sent: true }, db).map((row) => row.id)).toEqual([sent.id]);
    expect(listInboundEmails({ includeSent: true }, db).map((row) => row.id)).toContain(sent.id);
    expect(listInboundEmails({ limit: 1, offset: 1, includeSent: true }, db)).toHaveLength(1);
  });

  it("returns lean list summaries and recipient subjects while excluding archived and sent mail", () => {
    const visible = store({ to_addresses: ["Target <target@example.com>"], subject: "Visible", received_at: "2026-04-02T00:00:00.000Z" });
    const archived = store({ to_addresses: ["target@example.com"], subject: "Archived", received_at: "2026-04-03T00:00:00.000Z" });
    store({ to_addresses: ["target@example.com"], subject: "Sent", label_ids: ["sent"], received_at: "2026-04-04T00:00:00.000Z" });
    setInboundArchivedFlag(archived.id, true, db);

    expect(listInboundSubjectsForRecipient("TARGET@example.com", { since: "2026-04-01", limit: 10 }, db)).toEqual([{ subject: "Visible" }]);
    expect(listInboundSubjectsForRecipient("bad", {}, db)).toEqual([]);
    const [summary] = listInboundEmailSummaries({ limit: 1 }, db);
    expect(summary?.id).toBe(visible.id);
    expect("text_body" in summary!).toBe(false);
  });

  it("keyset-pages deterministically and validates limits, dates, and cursors", () => {
    const newest = store({ subject: "Newest", received_at: "2026-05-03T00:00:00.000Z" });
    const middle = store({ subject: "Middle", received_at: "2026-05-02T00:00:00.000Z" });
    const oldest = store({ subject: "Oldest", received_at: "2026-05-01T00:00:00.000Z" });

    const first = listInboundInsertionSummariesPage({ limit: 2 }, db);
    expect(first.items.map((row) => row.id)).toEqual([newest.id, middle.id]);
    expect(first.cursor).not.toBeNull();
    expect(listInboundInsertionSummariesPage({ limit: 2, cursor: first.cursor! }, db).items.map((row) => row.id)).toEqual([oldest.id]);
    expect(() => listInboundInsertionSummariesPage({ limit: 0 }, db)).toThrow(/between 1 and 500/);
    expect(() => listInboundInsertionSummariesPage({ limit: 501 }, db)).toThrow(/between 1 and 500/);
    expect(() => listInboundInsertionSummariesPage({ receivedSince: " " }, db)).toThrow(/valid date-time/);
    expect(() => listInboundInsertionSummariesPage({ cursor: "not+base64" }, db)).toThrow(/cursor is malformed/);
    expect(() => listInboundInsertionSummariesPage({ cursor: first.cursor!, receivedSince: "2026-05-01" }, db)).toThrow(/does not match/);
  });
});

describe("owner scope", () => {
  it("includes owned/administered addresses and exact/catch-all aliases without leaking other mail", () => {
    addProvider("provider-1");
    db.run("INSERT INTO owners (id, type, name) VALUES ('owner-1', 'human', 'Owner')");
    db.run("INSERT INTO owners (id, type, name) VALUES ('owner-2', 'human', 'Other')");
    db.run("INSERT INTO addresses (id, provider_id, email, owner_id) VALUES ('address-1', 'provider-1', 'owned@example.com', 'owner-1')");
    db.run("INSERT INTO addresses (id, provider_id, email, administrator_id) VALUES ('address-2', 'provider-1', 'administered@example.com', 'owner-1')");
    db.run("INSERT INTO aliases (id, domain, local_part, target_address) VALUES ('alias-1', 'aliases.example', 'sales', 'owned@example.com')");
    db.run("INSERT INTO aliases (id, domain, local_part, target_address) VALUES ('alias-2', 'catch.example', '*', 'administered@example.com')");
    const direct = store({ to_addresses: ["owned@example.com"], subject: "Direct" });
    const exactAlias = store({ to_addresses: ["sales@aliases.example"], subject: "Exact alias" });
    const catchAll = store({ to_addresses: ["anything@catch.example"], subject: "Catch all" });
    store({ to_addresses: ["private@example.net"], subject: "Private" });

    const ids = listInboundEmailsForOwner("owner-1", { limit: 20 }, db).map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([direct.id, exactAlias.id, catchAll.id]));
    expect(ids).toHaveLength(3);
    const summaries = listInboundEmailSummariesForOwner("owner-1", { limit: 20 }, db);
    expect(summaries).toHaveLength(3);
    expect("text_body" in summaries[0]!).toBe(false);
    expect(inboundEmailBelongsToOwner(direct.id, "owner-1", db)).toBe(true);
    expect(inboundEmailBelongsToOwner(direct.id, "owner-2", db)).toBe(false);
    expect(inboundEmailBelongsToOwner("missing", "owner-1", db)).toBe(false);
  });
});

describe("state, labels, counts, and deletion", () => {
  it("round-trips read/archive/star variants and refuses missing ids", () => {
    const email = store();

    expect(setInboundRead(email.id, true, db)).toMatchObject({ is_read: true });
    expect(setInboundReadSummary(email.id, false, db)).toMatchObject({ is_read: false, read_at: null });
    expect(setInboundReadFlag(email.id, true, db)).toBe(true);
    expect(setInboundArchived(email.id, true, db)).toMatchObject({ is_archived: true });
    expect(setInboundArchivedSummary(email.id, false, db)).toMatchObject({ is_archived: false });
    expect(setInboundArchivedFlag(email.id, true, db)).toBe(true);
    expect(setInboundStarred(email.id, true, db)).toMatchObject({ is_starred: true });
    expect(setInboundStarredSummary(email.id, false, db)).toMatchObject({ is_starred: false });
    expect(setInboundStarredFlag(email.id, true, db)).toBe(true);
    expect(() => setInboundReadFlag("missing", true, db)).toThrow("Inbound email not found: missing");
    expect(() => setInboundArchivedFlag("missing", true, db)).toThrow("Inbound email not found: missing");
    expect(() => setInboundStarredFlag("missing", true, db)).toThrow("Inbound email not found: missing");
  });

  it("adds and removes normalized labels idempotently through full and summary variants", () => {
    const email = store();

    expect(addInboundLabel(email.id, "Needs Review", db).label_ids).toEqual(["Needs Review"]);
    expect(addInboundLabelSummary(email.id, " needs   review ", db).label_ids).toEqual(["Needs Review"]);
    expect(removeInboundLabel(email.id, "NEEDS REVIEW", db).label_ids).toEqual([]);
    expect(removeInboundLabelSummary(email.id, "absent", db).label_ids).toEqual([]);
    expect(() => addInboundLabel("missing", "label", db)).toThrow("Inbound email not found: missing");
    expect(() => removeInboundLabel("missing", "label", db)).toThrow("Inbound email not found: missing");
  });

  it("separates provider, received, latest, and unread counts", () => {
    addProvider("provider-1");
    addProvider("provider-2");
    const first = store({ provider_id: "provider-1", received_at: "2026-06-01T00:00:00.000Z" });
    const second = store({ provider_id: "provider-2", received_at: "2026-06-02T00:00:00.000Z" });
    store({ provider_id: "provider-1", label_ids: ["sent"], received_at: "2026-06-03T00:00:00.000Z" });
    setInboundReadFlag(first.id, true, db);
    setInboundArchivedFlag(second.id, true, db);

    expect(getInboundCount(undefined, db)).toBe(3);
    expect(getInboundCount("provider-1", db)).toBe(2);
    expect(getReceivedInboundCount(undefined, db)).toBe(2);
    expect(getReceivedInboundCount("provider-1", db)).toBe(1);
    expect(getLatestInboundReceivedAt(db)).toBe("2026-06-03T00:00:00.000Z");
    expect(getLatestReceivedInboundAt(db)).toBe("2026-06-02T00:00:00.000Z");
    expect(getUnreadCount(undefined, db)).toBe(0);
    expect(getUnreadCount("provider-1", db)).toBe(0);
  });

  it("deletes one row, clears a provider scope, and handles empty stores", () => {
    addProvider("provider-1");
    addProvider("provider-2");
    const first = store({ provider_id: "provider-1" });
    store({ provider_id: "provider-1" });
    store({ provider_id: "provider-2" });

    expect(deleteInboundEmail(first.id, db)).toBe(true);
    expect(deleteInboundEmail(first.id, db)).toBe(false);
    expect(clearInboundEmails("provider-1", db)).toBe(1);
    expect(getInboundCount(undefined, db)).toBe(1);
    expect(clearInboundEmails(undefined, db)).toBe(1);
    expect(clearInboundEmails(undefined, db)).toBe(0);
    expect(getLatestInboundReceivedAt(db)).toBeNull();
    expect(getLatestReceivedInboundAt(db)).toBeNull();
  });
});
