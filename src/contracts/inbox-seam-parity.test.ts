import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { storeInboundEmail } from "../db/inbound.js";
import { resetMailDataSource } from "../lib/mail-data-source.js";

// CLI<->MCP inbox parity + cloud-mode proof. Both surfaces route mail-data verbs
// through resolveMailDataSource(); this proves they return equivalent data in local
// mode (SqliteMailDataSource) and API data in cloud mode (ApiMailDataSource), so
// cloud mode is no longer reading an empty local DB.

const { runInboxTool } = await import("../mcp/tools/inbox-impl.js");

const cleanups: Array<() => void> = [];

afterEach(() => {
  closeDatabase();
  resetMailDataSource();
  for (const fn of cleanups.splice(0)) fn();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["MAILERY_MODE"];
  delete process.env["MAILERY_API_URL"];
  delete process.env["MAILERY_API_KEY"];
});

function baseLocalEnv(dbPath: string, homePath: string): NodeJS.ProcessEnv {
  mkdirSync(homePath, { recursive: true });
  const { MAILERY_MODE: _m, HASNA_EMAILS_MODE: _h, MAILERY_API_URL: _u, MAILERY_API_KEY: _k, ...rest } = process.env;
  return { ...rest, EMAILS_DB_PATH: dbPath, HOME: homePath, NO_COLOR: "1", MAILERY_MODE: "local" };
}

// Async spawn (never spawnSync): an in-process fake server must keep serving while the
// CLI subprocess runs, so the event loop cannot be blocked.
async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn({ cmd: ["bun", "src/cli/index.tsx", "--json", ...args], cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, out: out.trim(), err: err.trim() };
}

function seedLocalDb(dbPath: string, homePath: string): string {
  const prevDb = process.env["EMAILS_DB_PATH"];
  const prevHome = process.env["HOME"];
  closeDatabase();
  process.env["EMAILS_DB_PATH"] = dbPath;
  process.env["HOME"] = homePath;
  resetDatabase();
  try {
    const provider = createProvider({ name: "ses", type: "ses" });
    const email = storeInboundEmail({
      provider_id: provider.id, message_id: "<parity@example.com>", in_reply_to_email_id: null,
      from_address: "sender@example.com", to_addresses: ["ops@example.com"], cc_addresses: [],
      subject: "Parity contract", text_body: "parity body content", html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 100,
      received_at: "2026-06-18T08:00:00.000Z",
    });
    return email.id;
  } finally {
    closeDatabase();
    if (prevDb === undefined) delete process.env["EMAILS_DB_PATH"]; else process.env["EMAILS_DB_PATH"] = prevDb;
    if (prevHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = prevHome;
  }
}

async function mcpList(env: NodeJS.ProcessEnv): Promise<Array<{ id: string; subject: string }>> {
  const prev = { db: process.env["EMAILS_DB_PATH"], home: process.env["HOME"], mode: process.env["MAILERY_MODE"], url: process.env["MAILERY_API_URL"], key: process.env["MAILERY_API_KEY"] };
  if (env.EMAILS_DB_PATH) process.env["EMAILS_DB_PATH"] = env.EMAILS_DB_PATH; else delete process.env["EMAILS_DB_PATH"];
  if (env.HOME) process.env["HOME"] = env.HOME;
  if (env.MAILERY_MODE) process.env["MAILERY_MODE"] = env.MAILERY_MODE;
  if (env.MAILERY_API_URL) process.env["MAILERY_API_URL"] = env.MAILERY_API_URL; else delete process.env["MAILERY_API_URL"];
  if (env.MAILERY_API_KEY) process.env["MAILERY_API_KEY"] = env.MAILERY_API_KEY; else delete process.env["MAILERY_API_KEY"];
  closeDatabase();
  resetMailDataSource();
  try {
    const result = await runInboxTool("list_inbound_emails", { limit: 25 });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content[0]!.text) as { items: Array<{ id: string; subject: string }> };
    return parsed.items;
  } finally {
    closeDatabase();
    resetMailDataSource();
    if (prev.db === undefined) delete process.env["EMAILS_DB_PATH"]; else process.env["EMAILS_DB_PATH"] = prev.db;
    if (prev.home !== undefined) process.env["HOME"] = prev.home;
    if (prev.mode === undefined) delete process.env["MAILERY_MODE"]; else process.env["MAILERY_MODE"] = prev.mode;
    if (prev.url === undefined) delete process.env["MAILERY_API_URL"]; else process.env["MAILERY_API_URL"] = prev.url;
    if (prev.key === undefined) delete process.env["MAILERY_API_KEY"]; else process.env["MAILERY_API_KEY"] = prev.key;
  }
}

describe("inbox CLI<->MCP parity — local mode", () => {
  it("CLI inbox list and MCP list_inbound_emails return equivalent local data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-parity-local-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "emails.db");
    const homePath = join(dir, "home");
    const env = baseLocalEnv(dbPath, homePath);
    const emailId = seedLocalDb(dbPath, homePath);

    const cli = await runCli(["inbox", "list", "--limit", "25"], env);
    expect(cli.code).toBe(0);
    const cliRows = JSON.parse(cli.out) as Array<{ id: string; subject: string }>;

    const mcpRows = await mcpList(env);

    expect(cliRows.map((r) => r.subject)).toEqual(["Parity contract"]);
    expect(mcpRows.map((r) => r.subject)).toEqual(["Parity contract"]);
    expect(cliRows.map((r) => r.id)).toEqual([emailId]);
    expect(mcpRows.map((r) => r.id)).toEqual([emailId]);
  }, 20_000);

  it("CLI inbox read returns local body content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-parity-read-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "emails.db");
    const homePath = join(dir, "home");
    const env = baseLocalEnv(dbPath, homePath);
    const emailId = seedLocalDb(dbPath, homePath);

    const read = await runCli(["inbox", "read", emailId, "--keep-unread"], env);
    expect(read.code).toBe(0);
    const detail = JSON.parse(read.out) as { id: string; subject: string; text_body: string };
    expect(detail).toMatchObject({ id: emailId, subject: "Parity contract" });
    expect(detail.text_body).toContain("parity body content");
  }, 20_000);
});

// ─── cloud harness: one real fake Mailery Cloud API for both surfaces ───────────

function cloudMsg(p: { id: string; subject: string; fromAddress: string; textBody?: string | null }): Record<string, unknown> {
  return {
    id: p.id, tenantId: "t", mailboxId: "m", direction: "inbound", status: "received",
    subject: p.subject, fromAddress: p.fromAddress, toAddresses: [], ccAddresses: [],
    textBody: p.textBody ?? null, htmlBody: null, cleanMarkdown: null, summary: null, parserModel: null,
    classification: {}, importanceScore: 0, isRead: false, isImportant: false, isSpam: false,
    isTrash: false, isArchived: false, isStarred: false, attachments: [], label_names: [],
    threadId: null, hasAttachments: false,
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", receivedAt: "2026-07-01T00:00:00.000Z",
  };
}

function startFakeCloud(messages: Array<Record<string, unknown>>) {
  const byId = new Map(messages.map((m) => [String(m.id), m]));
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      const all = [...byId.values()];
      if (path === "/api/v1/messages" && req.method === "GET") {
        const q = url.searchParams.get("q")?.toLowerCase();
        const data = q ? all.filter((m) => String(m.subject).toLowerCase().includes(q)) : all;
        return j({ data, next_cursor: null });
      }
      if (path === "/api/v1/messages/groups") return j({ inbox: all.length, unread: all.length });
      const idMatch = path.match(/^\/api\/v1\/messages\/([^/]+)$/);
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1]!);
        if (req.method === "GET") return byId.has(id) ? j(byId.get(id)) : j({ error: { message: "not found" } }, 404);
      }
      return j({ data: [] });
    },
  });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

describe("inbox CLI<->MCP parity — cloud mode (mocked cloud API)", () => {
  it("CLI and MCP both return API data (not empty local) and agree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-parity-cloud-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const homePath = join(dir, "home");
    mkdirSync(homePath, { recursive: true });

    const { server, base } = startFakeCloud([
      cloudMsg({ id: "c1", subject: "CLOUD Alpha", fromAddress: "alpha@api.com", textBody: "alpha body" }),
      cloudMsg({ id: "c2", subject: "CLOUD Beta needle", fromAddress: "beta@api.com", textBody: "beta body" }),
    ]);
    cleanups.push(() => server.stop(true));

    const cloudEnv: NodeJS.ProcessEnv = {
      ...baseLocalEnv(join(dir, "emails.db"), homePath),
      MAILERY_MODE: "cloud",
      MAILERY_API_URL: base,
      MAILERY_API_KEY: "test-token",
    };

    // CLI (subprocess) against the fake cloud.
    const cliList = await runCli(["inbox", "list", "--limit", "25"], cloudEnv);
    expect(cliList.code).toBe(0);
    const cliSubjects = (JSON.parse(cliList.out) as Array<{ subject: string }>).map((r) => r.subject).sort();
    expect(cliSubjects).toEqual(["CLOUD Alpha", "CLOUD Beta needle"]);

    const cliRead = await runCli(["inbox", "read", "c1", "--keep-unread"], cloudEnv);
    expect(cliRead.code).toBe(0);
    const cliDetail = JSON.parse(cliRead.out) as { id: string; subject: string; text_body: string };
    expect(cliDetail).toMatchObject({ id: "c1", subject: "CLOUD Alpha" });
    expect(cliDetail.text_body).toBe("alpha body");

    const cliSearch = await runCli(["inbox", "search", "needle"], cloudEnv);
    expect(cliSearch.code).toBe(0);
    expect((JSON.parse(cliSearch.out) as Array<{ subject: string }>).map((r) => r.subject)).toEqual(["CLOUD Beta needle"]);

    // MCP (in-process) against the SAME fake cloud — must agree with the CLI.
    const mcpRows = await mcpList(cloudEnv);
    expect(mcpRows.map((r) => r.subject).sort()).toEqual(cliSubjects);
  }, 30_000);
});
