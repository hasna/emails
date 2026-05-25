import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resetDatabase, closeDatabase, getDatabase, uuid } from "../db/database.js";
import { getGmailSyncState, setGmailSyncState } from "../db/gmail-sync-state.js";

// ─── Mock @hasna/connectors ───────────────────────────────────────────────────

const mockRun = mock(async (_args: {
  connector: string;
  operation: string;
  input?: Record<string, unknown> & { args?: Array<string | number | boolean> };
}) => ({
  connector: "gmail",
  operation: _args.operation,
  success: true,
  stdout: "[]",
  stderr: "",
  exitCode: 0,
  data: [],
}));

mock.module("@hasna/connectors", () => ({ runConnectorOperation: mockRun }));

const { syncGmailInbox, syncGmailInboxAll, syncGmailInboxHistory } = await import("./gmail-sync.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DATE = "Fri, 20 Mar 2026 10:00:00 +0000";

function makeListOutput(msgs: { id: string; from?: string; subject?: string }[]): string {
  return JSON.stringify(msgs.map((m) => ({ id: m.id, from: m.from ?? "a@b.com", subject: m.subject ?? "S", date: DATE })));
}

function makeReadOutput(m: { id: string; from?: string; to?: string; subject?: string; body?: string; htmlBody?: string }): string {
  return JSON.stringify({
    id: m.id,
    threadId: `thread-${m.id}`,
    labelIds: ["INBOX", "Label_1"],
    historyId: `history-${m.id}`,
    internalDate: "1774000800000",
    from: m.from ?? "a@b.com",
    to: m.to ?? "me@b.com",
    subject: m.subject ?? "S",
    date: DATE,
    body: m.body ?? "text body",
    htmlBody: m.htmlBody ?? "<p>html body</p>",
    size: 200,
  });
}

function setupDb() {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const db = getDatabase();
  const providerId = uuid();
  db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Gmail', 'gmail', 1)`, [providerId]);
  return { db, providerId };
}

function setMock(
  msgs: { id: string; from?: string; subject?: string; body?: string; htmlBody?: string }[],
  readOutputs?: string[],
) {
  let readIdx = 0;
  mockRun.mockImplementation(async (operationArgs: {
    operation: string;
    input?: Record<string, unknown> & { args?: Array<string | number | boolean> };
  }) => {
    const { operation, input } = operationArgs;
    if (operation === "messages.read" || operation === "messages.get") {
      const isHtml = input?.html === true;
      const id = String(input?.args?.[0] ?? "x");
      const msg = msgs.find((m) => m.id === id);
      if (readOutputs && !isHtml) {
        const data = JSON.parse(readOutputs[readIdx++] ?? makeReadOutput({ id }));
        return { connector: "gmail", operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      if (isHtml && msg?.htmlBody) {
        // Return HTML body for --html calls
        const data = { id, from: msg.from ?? "a@b.com", subject: msg.subject ?? "S", date: DATE, body: msg.htmlBody, size: 200 };
        return { connector: "gmail", operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      // Return text body
      const data = JSON.parse(makeReadOutput({ id, from: msg?.from, subject: msg?.subject, body: msg?.body }));
      return { connector: "gmail", operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
    }
    if (operation === "messages.list") {
      const data = JSON.parse(makeListOutput(msgs));
      return { connector: "gmail", operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
    }
    // attachments list/download — return empty
    return { connector: "gmail", operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
  });
}

beforeEach(() => mockRun.mockReset());
afterEach(() => { closeDatabase(); delete process.env["EMAILS_DB_PATH"]; });

// ─── syncGmailInbox ───────────────────────────────────────────────────────────

describe("syncGmailInbox", () => {
  it("syncs two messages", async () => {
    const { db, providerId } = setupDb();
    setMock([{ id: "msg1", from: "alice@example.com", subject: "Hello" }, { id: "msg2", from: "bob@example.com", subject: "World" }]);
    const result = await syncGmailInbox({ providerId, db });
    expect(result.synced).toBe(2);
    expect(result.errors).toHaveLength(0);
    const rows = db.query("SELECT message_id FROM inbound_emails WHERE provider_id = ?").all(providerId) as { message_id: string }[];
    expect(rows.map((r) => r.message_id).sort()).toEqual(["msg1", "msg2"]);
  });

  it("deduplicates on re-run", async () => {
    const { db, providerId } = setupDb();
    setMock([{ id: "msg1" }]);
    await syncGmailInbox({ providerId, db });
    setMock([{ id: "msg1" }]);
    const r2 = await syncGmailInbox({ providerId, db });
    expect(r2.synced).toBe(0);
    expect(r2.skipped).toBe(1);
  });

  it("stores text and html body separately", async () => {
    const { db, providerId } = setupDb();
    // Provide both text body and HTML body — mock returns them for separate calls
    setMock([{ id: "msg1", body: "plain text", htmlBody: "<b>html</b>" }]);
    await syncGmailInbox({ providerId, db });
    const row = db.query("SELECT text_body, html_body FROM inbound_emails WHERE message_id = 'msg1'").get() as { text_body: string; html_body: string } | null;
    expect(row!.text_body).toBe("plain text");
    expect(row!.html_body).toBe("<b>html</b>");
  });

  it("stores Gmail archive metadata from connector detail", async () => {
    const { db, providerId } = setupDb();
    setMock([{ id: "msg1", body: "plain text" }]);
    await syncGmailInbox({ providerId, db });
    const row = db
      .query("SELECT provider_thread_id, provider_history_id, provider_internal_date, label_ids_json FROM inbound_emails WHERE message_id = 'msg1'")
      .get() as {
        provider_thread_id: string;
        provider_history_id: string;
        provider_internal_date: string;
        label_ids_json: string;
      } | null;
    expect(row!.provider_thread_id).toBe("thread-msg1");
    expect(row!.provider_history_id).toBe("history-msg1");
    expect(row!.provider_internal_date).toBe("1774000800000");
    expect(JSON.parse(row!.label_ids_json)).toEqual(["INBOX", "Label_1"]);
  });

  it("returns error when list fails", async () => {
    const { db, providerId } = setupDb();
    mockRun.mockImplementation(async (operationArgs: { operation: string }) => ({
      connector: "gmail",
      operation: operationArgs.operation,
      success: false,
      stdout: "",
      stderr: "auth error",
      exitCode: 1,
    }));
    const r = await syncGmailInbox({ providerId, db });
    expect(r.synced).toBe(0);
    expect(r.errors[0]).toContain("Failed to list messages");
  });

  it("isolates per-message errors", async () => {
    const { db, providerId } = setupDb();
    let readCount = 0;
    mockRun.mockImplementation(async (operationArgs: { operation: string }) => {
      if (operationArgs.operation === "messages.read" || operationArgs.operation === "messages.get") {
        readCount++;
        if (readCount === 1) {
          return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: "", stderr: "", exitCode: 0 };
        }
        const data = JSON.parse(makeReadOutput({ id: "msg2" }));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      if (operationArgs.operation === "messages.list") {
        const data = JSON.parse(makeListOutput([{ id: "msg1" }, { id: "msg2" }]));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
    });
    const r = await syncGmailInbox({ providerId, db });
    expect(r.synced).toBeGreaterThanOrEqual(1);
  });

  it("handles empty list", async () => {
    const { db, providerId } = setupDb();
    setMock([]);
    const r = await syncGmailInbox({ providerId, db });
    expect(r.synced).toBe(0);
    expect(r.errors).toHaveLength(0);
  });

  it("passes batchSize to list command", async () => {
    const { db, providerId } = setupDb();
    setMock([]);
    await syncGmailInbox({ providerId, batchSize: 5, db });
    const listCall = mockRun.mock.calls.find((c) => c[0]?.operation === "messages.list");
    expect(listCall?.[0]?.input?.max).toBe(5);
  });

  it("passes query to list command", async () => {
    const { db, providerId } = setupDb();
    setMock([]);
    await syncGmailInbox({ providerId, query: "is:unread", db });
    const listCall = mockRun.mock.calls.find((c) => c[0]?.operation === "messages.list");
    expect(listCall?.[0]?.input?.query).toBe("is:unread");
  });
});

// ─── syncGmailInboxAll ────────────────────────────────────────────────────────

describe("syncGmailInboxAll", () => {
  it("syncs single page", async () => {
    const { db, providerId } = setupDb();
    setMock([{ id: "m1" }, { id: "m2" }]);
    const r = await syncGmailInboxAll({ providerId, db });
    expect(r.synced).toBe(2);
    expect(r.done).toBe(true);
  });
});

describe("syncGmailInboxHistory", () => {
  it("syncs changed Gmail messages from stored history cursor and advances it", async () => {
    const { db, providerId } = setupDb();
    setGmailSyncState(providerId, { history_id: "100" }, db);
    const ops: string[] = [];
    mockRun.mockImplementation(async (operationArgs: {
      operation: string;
      input?: Record<string, unknown> & { args?: Array<string | number | boolean> };
    }) => {
      ops.push(operationArgs.operation);
      if (operationArgs.operation === "history.list") {
        const data = {
          historyId: "200",
          history: [
            { id: "150", messagesAdded: [{ message: { id: "hist-msg-1", threadId: "thread-1" } }] },
            { id: "199", labelsAdded: [{ message: { id: "hist-msg-1", threadId: "thread-1" }, labelIds: ["INBOX"] }] },
          ],
        };
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      if (operationArgs.operation === "messages.read") {
        const id = String(operationArgs.input?.args?.[0] ?? "x");
        const isHtml = operationArgs.input?.html === true;
        const data = isHtml
          ? { id, body: "<p>history html</p>" }
          : JSON.parse(makeReadOutput({ id, body: "history text", subject: "History" }));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
    });

    const result = await syncGmailInboxHistory({ providerId, db });
    expect(result.synced).toBe(1);
    expect(ops).toContain("history.list");
    expect(ops).not.toContain("messages.list");
    expect(getGmailSyncState(providerId, db)?.history_id).toBe("200");
    const stored = db.query("SELECT message_id, subject FROM inbound_emails").get() as { message_id: string; subject: string };
    expect(stored).toEqual({ message_id: "hist-msg-1", subject: "History" });
  });

  it("falls back to normal sync when no history cursor exists", async () => {
    const { db, providerId } = setupDb();
    setMock([{ id: "msg1" }]);
    const result = await syncGmailInboxHistory({ providerId, db });
    expect(result.synced).toBe(1);
    expect(getGmailSyncState(providerId, db)?.history_id).toBe("history-msg1");
  });
});
