/**
 * GAP-B: `inbox clear` / MCP `clear_inbound_emails` route through the seam.
 *   • cloud mode → server bulk delete (POST /messages/bulk, action=delete) over the folder
 *   • local mode → unchanged local-store wipe
 * Plus: `inbox unread-count --by-address` is local-only and must fail cleanly in cloud mode
 * (a clear message + non-zero exit), never an empty/misleading result or a crash.
 *
 * CLI surfaces run as subprocesses against an in-process fake Mailery Cloud API (Bun.serve)
 * that records requests; the MCP surface runs in-process via runInboxTool.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { storeInboundEmail } from "../../db/inbound.js";
import { resetMailDataSource } from "../../lib/mail-data-source.js";

const { runInboxTool } = await import("../../mcp/tools/inbox-impl.js");

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
  return { ...rest, EMAILS_DB_PATH: dbPath, HOME: homePath, NO_COLOR: "1", MAILERY_MODE: "local", HASNA_EMAILS_MODE: "local" };
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn({ cmd: ["bun", "src/cli/index.tsx", ...args], cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, out: out.trim(), err: err.trim() };
}

function seedLocalInbound(dbPath: string, homePath: string, subjects: string[]): void {
  const prevDb = process.env["EMAILS_DB_PATH"];
  const prevHome = process.env["HOME"];
  closeDatabase();
  process.env["EMAILS_DB_PATH"] = dbPath;
  process.env["HOME"] = homePath;
  resetDatabase();
  try {
    for (const [i, subject] of subjects.entries()) {
      storeInboundEmail({
        provider_id: null, message_id: `<${subject}@x>`, in_reply_to_email_id: null,
        from_address: "sender@example.com", to_addresses: ["ops@example.com"], cc_addresses: [],
        subject, text_body: "body", html_body: null, attachments: [], attachment_paths: [],
        headers: {}, raw_size: 100, received_at: `2026-06-1${i}T08:00:00.000Z`,
      });
    }
  } finally {
    closeDatabase();
    if (prevDb === undefined) delete process.env["EMAILS_DB_PATH"]; else process.env["EMAILS_DB_PATH"] = prevDb;
    if (prevHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = prevHome;
  }
}

function startFakeCloud() {
  const bulk: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (path === "/api/v1/mailboxes" && req.method === "GET") return j({ data: [] });
      if (path === "/api/v1/messages/groups" && req.method === "GET") return j({ inbox: 0, unread: 0 });
      if (path === "/api/v1/messages/bulk" && req.method === "POST") {
        return req.json().then((body) => {
          bulk.push(body as Record<string, unknown>);
          return j({ ok: true, action: "delete", affected: 3, matched: 3, has_more: false, next_cursor: null });
        });
      }
      return j({ data: [], next_cursor: null });
    },
  });
  return { server, base: `http://127.0.0.1:${server.port}`, bulk };
}

// A fake cloud that serves a fixed message set: a keyset-paged GET /messages (cursor =
// numeric index, honoring limit + a substring q), GET /messages/:id (400 for an unknown
// or short id, like the real server), and a PATCH that flips flags. Enough to drive the
// real CLI `inbox list` / `inbox read` end-to-end in cloud mode.
function startFakeCloudWithMessages(seed: Array<Record<string, unknown>>) {
  const messages = seed.map((m) => ({ ccAddresses: [], htmlBody: null, summary: null, direction: "inbound", isStarred: false, isImportant: false, attachments: [], createdAt: "2026-07-01T00:00:00.000Z", receivedAt: "2026-07-01T00:00:00.000Z", ...m }));
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (path === "/api/v1/mailboxes" && req.method === "GET") return j({ data: [] });
      if (path === "/api/v1/messages/groups" && req.method === "GET") return j({ inbox: messages.length, unread: messages.filter((m) => !m["isRead"]).length });
      if (path === "/api/v1/messages" && req.method === "GET") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const start = Number(url.searchParams.get("cursor") ?? "0");
        const filtered = q
          ? messages.filter((m) => `${m["subject"]} ${m["fromAddress"]} ${(m["toAddresses"] as string[]).join(" ")}`.toLowerCase().includes(q))
          : messages;
        const slice = filtered.slice(start, start + limit);
        const next = start + limit;
        return j({ data: slice, next_cursor: next < filtered.length ? String(next) : null });
      }
      const byId = path.match(/^\/api\/v1\/messages\/([^/]+)$/);
      if (byId) {
        const id = decodeURIComponent(byId[1]!);
        const found = messages.find((m) => m["id"] === id);
        if (!found) return j({ error: { code: "bad_request", message: "invalid id or value" } }, 400);
        if (req.method === "GET") return j(found);
        if (req.method === "PATCH") return req.json().then((patch) => { Object.assign(found, patch as object); return j(found); });
      }
      return j({ data: [], next_cursor: null });
    },
  });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

describe("inbox read — cloud mode (FIX-3 short id, FIX-4 read flags)", () => {
  const fullId = "0190aaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  function cloudEnv(dir: string, base: string): NodeJS.ProcessEnv {
    const homePath = join(dir, "home");
    mkdirSync(homePath, { recursive: true });
    return { ...baseLocalEnv(join(dir, "emails.db"), homePath), MAILERY_MODE: "cloud", MAILERY_API_URL: base, MAILERY_API_KEY: "test-token" };
  }

  it("FIX-3: the short id printed by `inbox list` reads verbatim in cloud mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "read-shortid-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { server, base } = startFakeCloudWithMessages([
      { id: fullId, subject: "Target", fromAddress: "a@x.com", toAddresses: ["me@x.com"], isRead: true, label_names: [], textBody: "hi" },
      { id: "0190ffff-1111-2222-3333-444444444444", subject: "Other", fromAddress: "b@x.com", toAddresses: ["me@x.com"], isRead: true, label_names: [], textBody: "nope" },
    ]);
    cleanups.push(() => server.stop(true));
    const env = cloudEnv(dir, base);

    const shortId = fullId.slice(0, 8); // exactly what `inbox list` prints
    const list = await runCli(["inbox", "list", "--limit", "10"], env);
    expect(list.code).toBe(0);
    expect(list.out).toContain(shortId); // list prints the short id

    const read = await runCli(["inbox", "read", shortId], env);
    expect(read.code).toBe(0); // the printed short id works verbatim
    expect(read.out).toContain("Target");
  }, 30_000);

  it("FIX-4: reading an unread cloud message shows 'read', never a contradictory 'unread'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "read-flags-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { server, base } = startFakeCloudWithMessages([
      { id: fullId, subject: "Hello", fromAddress: "a@x.com", toAddresses: ["me@x.com"], isRead: false, label_names: ["unread", "Billing"], textBody: "hi" },
    ]);
    cleanups.push(() => server.stop(true));
    const env = cloudEnv(dir, base);

    // Opening an unread message marks it read; the Flags line must read "read" (+ Billing)
    // with no leftover system "unread" label.
    const read = await runCli(["inbox", "read", fullId], env);
    expect(read.code).toBe(0);
    const flagsLine = read.out.split("\n").find((line) => line.includes("Flags:")) ?? "";
    expect(flagsLine).toContain("read");
    expect(flagsLine).toContain("Billing");
    expect(flagsLine).not.toContain("unread");
  }, 30_000);
});

describe("inbox clear — cloud mode routes through the server bulk delete", () => {
  it("CLI clear issues POST /messages/bulk (action=delete) over the inbox folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clear-cloud-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const homePath = join(dir, "home");
    mkdirSync(homePath, { recursive: true });
    const { server, base, bulk } = startFakeCloud();
    cleanups.push(() => server.stop(true));

    const env: NodeJS.ProcessEnv = {
      ...baseLocalEnv(join(dir, "emails.db"), homePath),
      MAILERY_MODE: "cloud", MAILERY_API_URL: base, MAILERY_API_KEY: "test-token",
    };

    const res = await runCli(["inbox", "clear", "--yes"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Cleared 3 email(s)");
    expect(bulk).toHaveLength(1);
    expect(bulk[0]).toMatchObject({ action: "delete", folder: "inbox" });
  }, 30_000);

  it("MCP clear_inbound_emails issues a server bulk delete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clear-mcp-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { server, base, bulk } = startFakeCloud();
    cleanups.push(() => server.stop(true));

    process.env["EMAILS_DB_PATH"] = join(dir, "emails.db");
    process.env["MAILERY_MODE"] = "cloud";
    process.env["MAILERY_API_URL"] = base;
    process.env["MAILERY_API_KEY"] = "test-token";
    closeDatabase();
    resetMailDataSource();

    const result = await runInboxTool("clear_inbound_emails", {});
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain("Cleared 3 inbound email(s)");
    expect(bulk).toHaveLength(1);
    expect(bulk[0]).toMatchObject({ action: "delete", folder: "inbox" });
  }, 30_000);
});

describe("inbox clear — local mode is unchanged (local-store wipe)", () => {
  it("CLI clear wipes the local inbound store and reports the count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clear-local-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "emails.db");
    const homePath = join(dir, "home");
    const env = baseLocalEnv(dbPath, homePath);
    seedLocalInbound(dbPath, homePath, ["one", "two"]);

    const res = await runCli(["inbox", "clear", "--yes"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Cleared 2 email(s)");

    const list = await runCli(["--json", "inbox", "list", "--limit", "25"], env);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.out)).toEqual([]);
  }, 30_000);
});

describe("inbox unread-count --by-address — local-only, clean error in cloud mode", () => {
  it("fails cleanly in cloud mode (clear message, non-zero exit, not empty)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unread-cloud-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const homePath = join(dir, "home");
    mkdirSync(homePath, { recursive: true });
    const { server, base } = startFakeCloud();
    cleanups.push(() => server.stop(true));

    const env: NodeJS.ProcessEnv = {
      ...baseLocalEnv(join(dir, "emails.db"), homePath),
      MAILERY_MODE: "cloud", MAILERY_API_URL: base, MAILERY_API_KEY: "test-token",
    };

    const res = await runCli(["inbox", "unread-count", "--by-address"], env);
    expect(res.code).toBe(1);
    expect(`${res.err}${res.out}`.toLowerCase()).toContain("not available in cloud mode");
  }, 30_000);

  it("still returns the total unread count in cloud mode (no --by-address)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unread-total-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const homePath = join(dir, "home");
    mkdirSync(homePath, { recursive: true });
    const { server, base } = startFakeCloud();
    cleanups.push(() => server.stop(true));

    const env: NodeJS.ProcessEnv = {
      ...baseLocalEnv(join(dir, "emails.db"), homePath),
      MAILERY_MODE: "cloud", MAILERY_API_URL: base, MAILERY_API_KEY: "test-token",
    };

    const res = await runCli(["inbox", "unread-count"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain("0");
  }, 30_000);
});
