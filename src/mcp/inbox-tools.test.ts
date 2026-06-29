import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase, closeDatabase, uuid } from "../db/database.js";
import { storeInboundEmail, listInboundEmails } from "../db/inbound.js";
const { runInboxTool } = await import("./tools/inbox-impl.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ORIGINAL_HOME = process.env["HOME"];
let tmpHome: string | null = null;

function setupDb() {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  const pid = uuid();
  db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'SES', 'ses', 1)`, [pid]);
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

async function toolJson(name: Parameters<typeof runInboxTool>[0], input: Record<string, unknown>) {
  const result = await runInboxTool(name, input);
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
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

describe("MCP local state mutations", () => {
  it("keeps local state mutations local", async () => {
    const { pid } = setupDb();
    const email = seedOne(pid);

    const result = await toolJson("mark_email_read", { email_id: email.id });

    expect(result.is_read).toBe(true);
  });
});
