import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase, closeDatabase, uuid } from "../db/database.js";
import { storeInboundEmail, listInboundEmails } from "../db/inbound.js";
import { getGmailSyncState, updateLastSynced } from "../db/gmail-sync-state.js";

// ─── Mock @hasna/connectors ───────────────────────────────────────────────────

const mockRun = mock(async (operationArgs: { operation: string }) => ({
  connector: "gmail",
  operation: operationArgs.operation,
  success: true,
  stdout: "[]",
  stderr: "",
  exitCode: 0,
  data: [],
}));

mock.module("@hasna/connectors", () => ({ runConnectorOperation: mockRun }));

const { registerGmailSource, retireGmailSource, syncGmailInbox, syncGmailInboxAll } = await import("../lib/gmail-sync.js");
const { runInboxTool } = await import("./tools/inbox-impl.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DATE = "Fri, 20 Mar 2026 10:00:00 +0000";
const ORIGINAL_HOME = process.env["HOME"];
let tmpHome: string | null = null;

function setupDb() {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  const pid = uuid();
  db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Gmail', 'gmail', 1)`, [pid]);
  registerGmailSource({ providerId: pid, profile: "default", email: "me@example.com", name: "MCP Test Gmail" });
  return { db, pid };
}

function seed(providerId: string, n: number) {
  const db = getDatabase();
  for (let i = 0; i < n; i++) {
    storeInboundEmail({
      provider_id: providerId, message_id: `mcp-msg-${i}`, in_reply_to_email_id: null,
      from_address: `from${i}@example.com`, to_addresses: ["me@example.com"], cc_addresses: [],
      subject: `MCP Subject ${i}`, text_body: `MCP body text number ${i}`, html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 80,
      received_at: new Date().toISOString(),
    }, db);
  }
}

function seedOne(providerId: string | null, overrides: Partial<Parameters<typeof storeInboundEmail>[0]> = {}) {
  const db = getDatabase();
  return storeInboundEmail({
    provider_id: providerId,
    message_id: "mcp-action-msg",
    in_reply_to_email_id: null,
    from_address: "from@example.com",
    to_addresses: ["me@example.com"],
    cc_addresses: [],
    subject: "MCP Action Subject",
    text_body: "MCP action body",
    html_body: null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: 80,
    received_at: new Date().toISOString(),
    ...overrides,
  }, db);
}

function setMock(listOutput: string, readOutput?: string) {
  mockRun.mockImplementation(async (operationArgs: { operation: string }) => {
    if (operationArgs.operation === "messages.read" || operationArgs.operation === "messages.get") {
      const data = JSON.parse(readOutput ?? JSON.stringify({ id: "t1", from: "a@x.com", to: "me@x.com", subject: "S1", date: DATE, body: "Hello MCP", size: 100 }));
      return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
    }
    if (operationArgs.operation === "messages.list") {
      const data = JSON.parse(listOutput);
      return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
    }
    return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
  });
}

async function toolJson(name: Parameters<typeof runInboxTool>[0], input: Record<string, unknown>) {
  const result = await runInboxTool(name, input);
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  mockRun.mockReset();
  tmpHome = mkdtempSync(join(tmpdir(), "mailery-mcp-inbox-"));
  process.env["HOME"] = tmpHome;
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = null;
});

// ─── sync_inbox tool logic ────────────────────────────────────────────────────

describe("sync_inbox tool logic", () => {
  it("returns synced/skipped/errors/done shape", async () => {
    const { db, pid } = setupDb();
    setMock('[{"id":"t1","from":"a@x.com","subject":"S1","date":"' + DATE + '"}]');
    const r = await syncGmailInbox({ providerId: pid, db });
    expect(typeof r.synced).toBe("number");
    expect(typeof r.skipped).toBe("number");
    expect(Array.isArray(r.errors)).toBe(true);
    expect(typeof r.done).toBe("boolean");
    expect(typeof r.attachments_saved).toBe("number");
  });

  it("synced=1 after one message", async () => {
    const { db, pid } = setupDb();
    setMock('[{"id":"t1","from":"a@x.com","subject":"S1","date":"' + DATE + '"}]');
    const r = await syncGmailInbox({ providerId: pid, db });
    expect(r.synced).toBe(1);
    expect(r.errors).toHaveLength(0);
  });

  it("errors when list fails", async () => {
    const { db, pid } = setupDb();
    mockRun.mockImplementation(async (operationArgs: { operation: string }) => ({
      connector: "gmail",
      operation: operationArgs.operation,
      success: false,
      stdout: "",
      stderr: "auth fail",
      exitCode: 1,
    }));
    const r = await syncGmailInbox({ providerId: pid, db });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toContain("Failed to list messages");
  });

  it("updateLastSynced sets last_synced_at", async () => {
    const { db, pid } = setupDb();
    setMock('[{"id":"t1","from":"a@x.com","subject":"S1","date":"' + DATE + '"}]');
    await syncGmailInbox({ providerId: pid, db });
    updateLastSynced(pid, undefined, db);
    const state = getGmailSyncState(pid, db);
    expect(state?.last_synced_at).toBeTruthy();
  });

  it("syncGmailInboxAll returns done=true", async () => {
    const { db, pid } = setupDb();
    setMock('[{"id":"t1","from":"a@x.com","subject":"S1","date":"' + DATE + '"}]');
    const r = await syncGmailInboxAll({ providerId: pid, db });
    expect(r.done).toBe(true);
    expect(r.synced).toBe(1);
  });

  it("does not mark Gmail sync state as synced when live-source resolution fails", async () => {
    resetDatabase();
    process.env["EMAILS_DB_PATH"] = ":memory:";
    const db = getDatabase();
    const pid = uuid();
    db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Gmail without source', 'gmail', 1)`, [pid]);

    const result = await toolJson("sync_inbox", { provider_id: pid, limit: 1 });

    expect((result.errors as string[])[0]).toContain("live Gmail access is blocked");
    expect(getGmailSyncState(pid, db)?.last_synced_at ?? null).toBeNull();
    expect(mockRun).not.toHaveBeenCalled();
  });
});

// ─── search_inbound tool logic ────────────────────────────────────────────────

describe("search_inbound tool logic", () => {
  it("matches subject", () => {
    const { pid } = setupDb();
    seed(pid, 5);
    const db = getDatabase();
    const results = listInboundEmails({ provider_id: pid, limit: 100, search: "subject 2" }, db);
    expect(results).toHaveLength(1);
  });

  it("returns empty for no match", () => {
    const { pid } = setupDb();
    seed(pid, 5);
    const db = getDatabase();
    const results = listInboundEmails({ provider_id: pid, limit: 100, search: "zzz-no-match" }, db);
    expect(results).toHaveLength(0);
  });

  it("searches before applying the result limit", () => {
    const { db, pid } = setupDb();
    storeInboundEmail({
      provider_id: pid, message_id: "recent", in_reply_to_email_id: null,
      from_address: "recent@example.com", to_addresses: ["me@example.com"], cc_addresses: [],
      subject: "recent unrelated", text_body: "body", html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 80,
      received_at: "2026-06-04T11:30:09.000Z",
    }, db);
    storeInboundEmail({
      provider_id: pid, message_id: "older", in_reply_to_email_id: null,
      from_address: "older@example.com", to_addresses: ["target@example.com"], cc_addresses: [],
      subject: "older match", text_body: "needle body", html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 80,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

    const results = listInboundEmails({ provider_id: pid, limit: 1, search: "needle" }, db);

    expect(results.map((email) => email.subject)).toEqual(["older match"]);
  });

  it("filters sender and subject before applying the result limit", () => {
    const { db, pid } = setupDb();
    storeInboundEmail({
      provider_id: pid, message_id: "recent-noise", in_reply_to_email_id: null,
      from_address: "updates@example.com", to_addresses: ["me@example.com"], cc_addresses: [],
      subject: "recent unrelated", text_body: "body", html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 80,
      received_at: "2026-06-04T11:30:09.000Z",
    }, db);
    storeInboundEmail({
      provider_id: pid, message_id: "older-target", in_reply_to_email_id: null,
      from_address: "security@example.com", to_addresses: ["me@example.com"], cc_addresses: [],
      subject: "target login alert", text_body: "body", html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 80,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

    const results = listInboundEmails({
      provider_id: pid,
      recipients: ["me@example.com"],
      from: "security",
      subject: "target",
      limit: 1,
    }, db);

    expect(results.map((email) => email.subject)).toEqual(["target login alert"]);
  });
});

describe("mailbox source tools", () => {
  it("lists sources, folder status, and source-filtered search without hiding legacy mail", async () => {
    const { db, pid } = setupDb();
    storeInboundEmail({
      provider_id: pid, message_id: "mcp-provider-source", in_reply_to_email_id: null,
      from_address: "sender@example.com", to_addresses: ["ops@example.com"], cc_addresses: [],
      subject: "mcp provider needle", text_body: "body", html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 1,
      received_at: "2026-01-02T10:00:00.000Z",
    }, db);
    storeInboundEmail({
      provider_id: null, message_id: "mcp-legacy-source", in_reply_to_email_id: null,
      from_address: "legacy@example.com", to_addresses: ["ops@example.com"], cc_addresses: [],
      subject: "mcp legacy visible", text_body: "needle", html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 1,
      received_at: "2026-01-03T10:00:00.000Z",
    }, db);

    const sources = await toolJson("list_mailbox_sources", {});
    const sourceItems = sources.sources as Array<{ id: string; badges: string[]; total: number }>;
    expect(sourceItems.find((source) => source.id === `provider:${pid}`)).toMatchObject({ total: 1 });
    expect(sourceItems.find((source) => source.id === "legacy")?.badges).toContain("legacy");

    const legacyStatus = await toolJson("list_mailboxes", { source_id: "legacy" });
    expect((legacyStatus.counts as { inbox: number }).inbox).toBe(1);
    expect(legacyStatus.cli_equivalent).toBe("mailery inbox mailboxes --source legacy --json");

    const search = await toolJson("search_mailbox", { query: "needle", source_id: `provider:${pid}` });
    expect((search.items as Array<{ subject: string }>).map((item) => item.subject)).toEqual(["mcp provider needle"]);
    expect(search.cli_equivalent).toBe(`mailery inbox search needle --folder inbox --source provider:${pid} --json`);
  });
});

describe("Gmail lifecycle gates for MCP mutations", () => {
  it("keeps local state mutations but skips Gmail mirror for retired sources", async () => {
    const { pid } = setupDb();
    const email = seedOne(pid);
    retireGmailSource(pid);

    const result = await toolJson("mark_email_read", { email_id: email.id });

    expect(result.is_read).toBe(true);
    expect(result.gmail_synced).toBe(false);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("blocks Gmail replies for retired sources before any connector call", async () => {
    const { pid } = setupDb();
    const email = seedOne(pid);
    retireGmailSource(pid);

    const result = await runInboxTool("reply_to_email", { email_id: email.id, body: "Reply body" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("live Gmail access is blocked");
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("blocks Gmail replies for non-Gmail inbound rows before any connector call", async () => {
    resetDatabase();
    process.env["EMAILS_DB_PATH"] = ":memory:";
    const db = getDatabase();
    const providerId = uuid();
    db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'SES', 'ses', 1)`, [providerId]);
    const email = seedOne(providerId, { message_id: "s3/object/key" });

    const result = await runInboxTool("reply_to_email", { email_id: email.id, body: "Reply body" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not from a Gmail source");
    expect(mockRun).not.toHaveBeenCalled();
  });
});

// ─── get_inbox_sync_status tool logic ────────────────────────────────────────

describe("get_inbox_sync_status tool logic", () => {
  it("null before any sync", () => {
    const { pid } = setupDb();
    const db = getDatabase();
    expect(getGmailSyncState(pid, db)?.last_synced_at ?? null).toBeNull();
  });

  it("reflects updateLastSynced", () => {
    const { db, pid } = setupDb();
    updateLastSynced(pid, "last-id", db);
    const state = getGmailSyncState(pid, db);
    expect(state!.last_synced_at).toBeTruthy();
    expect(state!.last_message_id).toBe("last-id");
  });
});
