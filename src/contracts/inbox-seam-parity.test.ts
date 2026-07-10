import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { storeInboundEmail } from "../db/inbound.js";
import { resetMailDataSource } from "../lib/mail-data-source.js";

// CLI and MCP inbox parity in local mode. Self-hosted transport is covered by self-hosted-mail-data-source.test.ts.

const { runInboxTool } = await import("../mcp/tools/inbox-impl.js");

const cleanups: Array<() => void> = [];

afterEach(() => {
  closeDatabase();
  resetMailDataSource();
  for (const fn of cleanups.splice(0)) fn();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["EMAILS_MODE"];
  delete process.env["EMAILS_SELF_HOSTED_URL"];
  delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
});
function baseLocalEnv(dbPath: string, homePath: string): NodeJS.ProcessEnv {
  mkdirSync(homePath, { recursive: true });
  const { EMAILS_MODE: _m, HASNA_EMAILS_MODE: _h, EMAILS_SELF_HOSTED_URL: _u, EMAILS_SELF_HOSTED_API_KEY: _k, ...rest } = process.env;
  return { ...rest, EMAILS_DB_PATH: dbPath, HOME: homePath, NO_COLOR: "1", EMAILS_MODE: "local" };
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
  const prev = { db: process.env["EMAILS_DB_PATH"], home: process.env["HOME"], mode: process.env["EMAILS_MODE"], url: process.env["EMAILS_SELF_HOSTED_URL"], key: process.env["EMAILS_SELF_HOSTED_API_KEY"] };
  if (env.EMAILS_DB_PATH) process.env["EMAILS_DB_PATH"] = env.EMAILS_DB_PATH; else delete process.env["EMAILS_DB_PATH"];
  if (env.HOME) process.env["HOME"] = env.HOME;
  if (env.EMAILS_MODE) process.env["EMAILS_MODE"] = env.EMAILS_MODE;
  if (env.EMAILS_SELF_HOSTED_URL) process.env["EMAILS_SELF_HOSTED_URL"] = env.EMAILS_SELF_HOSTED_URL; else delete process.env["EMAILS_SELF_HOSTED_URL"];
  if (env.EMAILS_SELF_HOSTED_API_KEY) process.env["EMAILS_SELF_HOSTED_API_KEY"] = env.EMAILS_SELF_HOSTED_API_KEY; else delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
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
    if (prev.mode === undefined) delete process.env["EMAILS_MODE"]; else process.env["EMAILS_MODE"] = prev.mode;
    if (prev.url === undefined) delete process.env["EMAILS_SELF_HOSTED_URL"]; else process.env["EMAILS_SELF_HOSTED_URL"] = prev.url;
    if (prev.key === undefined) delete process.env["EMAILS_SELF_HOSTED_API_KEY"]; else process.env["EMAILS_SELF_HOSTED_API_KEY"] = prev.key;
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
