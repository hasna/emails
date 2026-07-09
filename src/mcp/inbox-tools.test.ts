import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase, closeDatabase, uuid } from "../db/database.js";
import { storeInboundEmail, listInboundEmails } from "../db/inbound.js";
import { resetMailDataSource } from "../lib/mail-data-source.js";
const { runInboxTool } = await import("./tools/inbox-impl.js");

// ─── Local harness (SqliteMailDataSource behind the seam) ──────────────────────

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
      received_at: new Date(2026, 5, 1, 12, 0, i).toISOString(),
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
  process.env["MAILERY_MODE"] = "local";
  resetMailDataSource();
});

afterEach(() => {
  closeDatabase();
  resetMailDataSource();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["MAILERY_MODE"];
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = null;
});

// ─── search_inbound DB filter primitives (unchanged local read logic) ──────────

describe("inbound search primitives", () => {
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
});

// ─── local mode: tools route through SqliteMailDataSource ──────────────────────

describe("MCP inbox tools — local via seam", () => {
  it("list_inbound_emails returns local inbox items (body-free) with truncation", async () => {
    const { pid } = setupDb();
    seed(pid, 3);
    const result = await toolJson("list_inbound_emails", { provider_id: pid, limit: 1 });
    const items = result.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(items[0]).not.toHaveProperty("text_body");
    expect(String(items[0]!.subject)).toContain("MCP Subject");
  });

  it("search_inbound matches subject locally", async () => {
    const { pid } = setupDb();
    seed(pid, 5);
    const result = await toolJson("search_inbound", { provider_id: pid, query: "Subject 2", limit: 10 });
    const items = result.items as Array<{ subject: string }>;
    expect(items.map((item) => item.subject)).toEqual(["MCP Subject 2"]);
  });

  it("get_inbound_email returns the full detail with body", async () => {
    const { pid } = setupDb();
    const email = seedOne(pid, { subject: "Detail subject", text_body: "detail body here" });
    const detail = await toolJson("get_inbound_email", { id: email.id });
    expect(detail.id).toBe(email.id);
    expect(detail.subject).toBe("Detail subject");
    expect(detail.text_body).toBe("detail body here");
  });

  it("mark_email_read flips local read state and returns a body-free summary", async () => {
    const { pid } = setupDb();
    const email = seedOne(pid);
    const result = await toolJson("mark_email_read", { email_id: email.id });
    expect(result.id).toBe(email.id);
    expect(result.is_read).toBe(true);
    expect(result).not.toHaveProperty("text_body");
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
      subject: "mcp legacy needle", text_body: "body", html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 1,
      received_at: "2026-01-03T10:00:00.000Z",
    }, db);

    const sources = await toolJson("list_mailbox_sources", {});
    const sourceItems = sources.sources as Array<{ id: string; badges: string[]; total: number }>;
    expect(sourceItems.find((source) => source.id === `provider:${pid}`)).toMatchObject({ total: 1 });
    expect(sourceItems.find((source) => source.id === "legacy")?.badges).toContain("legacy");

    const legacyStatus = await toolJson("list_mailboxes", { source_id: "legacy" });
    expect((legacyStatus.counts as { inbox: number }).inbox).toBe(1);
    expect(legacyStatus.cli_equivalent).toBe("emails inbox mailboxes --source legacy --json");

    const search = await toolJson("search_mailbox", { query: "needle", source_id: `provider:${pid}` });
    expect((search.items as Array<{ subject: string }>).map((item) => item.subject)).toEqual(["mcp provider needle"]);
    expect(search.cli_equivalent).toBe(`emails inbox search needle --folder inbox --source provider:${pid} --json`);
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

// ─── cloud mode: tools route through ApiMailDataSource (mocked client) ──────────

interface CloudMsg { id: string; subject: string; fromAddress: string; textBody?: string | null; isRead?: boolean }

function fullCloudMessage(partial: CloudMsg): Record<string, unknown> {
  return {
    tenantId: "ten_1", mailboxId: "mbx_1", direction: "inbound", status: "received",
    subject: "(no subject)", fromAddress: "", toAddresses: [], ccAddresses: [],
    textBody: null, htmlBody: null, cleanMarkdown: null, summary: null, parserModel: null,
    classification: {}, importanceScore: 0, isRead: false, isImportant: false, isSpam: false,
    isTrash: false, isArchived: false, isStarred: false, attachments: [], label_names: [],
    threadId: null, hasAttachments: false,
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    receivedAt: "2026-07-01T00:00:00.000Z",
    ...partial,
  };
}

/**
 * A minimal, stateful Mailery Cloud API served over a monkeypatched global fetch, so
 * ApiMailDataSource (built by resolveMailDataSource in cloud mode) reads real "API"
 * data. This is the mocked MaileryCloudClient the cloud-mode assertions run against.
 */
function installCloudFetch(messages: Record<string, ReturnType<typeof fullCloudMessage>>) {
  const original = globalThis.fetch;
  const store = { ...messages };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const j = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const list = Object.values(store);
    if (path === "/api/v1/messages" && method === "GET") {
      const q = url.searchParams.get("q")?.toLowerCase();
      const data = q ? list.filter((m) => String(m.subject).toLowerCase().includes(q)) : list;
      return j({ data, next_cursor: null });
    }
    if (path === "/api/v1/messages/groups") return j({ inbox: list.length, unread: list.filter((m) => !m.isRead).length });
    const idMatch = path.match(/^\/api\/v1\/messages\/([^/]+)$/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]!);
      if (method === "GET") return store[id] ? j(store[id]) : j({ error: { message: "not found" } }, 404);
      if (method === "PATCH") {
        const patch = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        store[id] = { ...store[id]!, ...patch };
        return j(store[id]);
      }
    }
    return j({ data: [] });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

describe("MCP inbox tools — cloud via mocked MaileryCloudClient", () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    process.env["MAILERY_MODE"] = "cloud";
    process.env["MAILERY_API_KEY"] = "test-token";
    process.env["MAILERY_API_URL"] = "https://cloud.test";
    restoreFetch = installCloudFetch({
      c1: fullCloudMessage({ id: "c1", subject: "CLOUD Alpha", fromAddress: "alpha@api.com", textBody: "alpha body" }),
      c2: fullCloudMessage({ id: "c2", subject: "CLOUD Beta needle", fromAddress: "beta@api.com", textBody: "beta body" }),
    });
    resetMailDataSource();
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    delete process.env["MAILERY_API_KEY"];
    delete process.env["MAILERY_API_URL"];
    resetMailDataSource();
  });

  it("list_inbound_emails returns API data, not empty local", async () => {
    const result = await toolJson("list_inbound_emails", { limit: 10 });
    const items = result.items as Array<{ id: string; subject: string }>;
    expect(items.map((item) => item.subject).sort()).toEqual(["CLOUD Alpha", "CLOUD Beta needle"]);
  });

  it("search_inbound returns API-matched data", async () => {
    const result = await toolJson("search_inbound", { query: "needle", limit: 10 });
    const items = result.items as Array<{ subject: string }>;
    expect(items.map((item) => item.subject)).toEqual(["CLOUD Beta needle"]);
  });

  it("get_inbound_email returns the API message body", async () => {
    const detail = await toolJson("get_inbound_email", { id: "c1" });
    expect(detail.id).toBe("c1");
    expect(detail.subject).toBe("CLOUD Alpha");
    expect(detail.text_body).toBe("alpha body");
    expect(detail.from_address).toBe("alpha@api.com");
  });

  it("mark_email_read PATCHes the API and reflects the new state", async () => {
    const result = await toolJson("mark_email_read", { email_id: "c1" });
    expect(result.id).toBe("c1");
    expect(result.is_read).toBe(true);
    // A second read of the message must observe the persisted API state.
    const detail = await toolJson("get_inbound_email", { id: "c1" });
    expect(detail.is_read).toBe(true);
  });

  it("list_mailboxes reports cloud group counts", async () => {
    const result = await toolJson("list_mailboxes", {});
    expect((result.counts as { inbox: number }).inbox).toBe(2);
  });
});
