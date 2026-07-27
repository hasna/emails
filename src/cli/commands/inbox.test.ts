// Self-hosted-ONLY: every `emails inbox` read/write routes to the operator
// `/v1/messages` API, so these tests drive the REAL commands against an
// out-of-process /v1 stub (see src/test-support/v1-stub.ts). There is no local
// SQLite island anymore; a handful of ingestion/diagnostic subcommands are
// server-only and fail closed with a clear message.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import {
  storeInboundEmail,
  listInboundEmails,
  getInboundEmail,
  type InboundEmail,
} from "../../db/inbound.js";
import { resetSelfHostedConfigCache } from "../../db/self-hosted-store.js";
import { saveConfig } from "../../lib/config.js";
import { mergeAttachmentDetails } from "../../lib/attachment-actions.js";
import { resetMailDataSource } from "../../lib/mail-data-source.js";
import { filterAttachmentDetails } from "./inbox.remote.js";
import { registerInboxCommands } from "./inbox.js";

let stub: V1Stub;
let attachmentInventoryServer: ReturnType<typeof Bun.serve>;
let attachmentInventoryPages = new Map<string, {
  items: Array<Record<string, unknown>>;
  next_cursor: string | null;
}>();
let attachmentInventoryRequests: URL[] = [];
let seq = 0;

function restoreProcessEnv(inherited: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(inherited, key)) delete process.env[key];
  }
  Object.assign(process.env, inherited);
}

type SeedOverrides = Partial<Parameters<typeof storeInboundEmail>[0]>;

// Seed through the REAL inbound repo (POST /v1/messages). Call AFTER applyEnv().
function seedEmail(overrides: SeedOverrides = {}): InboundEmail {
  seq += 1;
  return storeInboundEmail({
    provider_id: null,
    message_id: `msg-${seq}`,
    in_reply_to_email_id: null,
    from_address: `sender${seq}@example.com`,
    to_addresses: ["me@example.com"],
    cc_addresses: [],
    subject: `Subject ${seq}`,
    text_body: `Body content ${seq}`,
    html_body: null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: 100,
    received_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    ...overrides,
  });
}

// A raw /v1 message row for stub.seed({ messages }) when a test needs precise
// flags (is_read/is_starred/labels/direction) the repo write cannot express.
function msgRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  return {
    id: crypto.randomUUID(),
    direction: "inbound",
    from_addr: `sender${seq}@example.com`,
    to_addrs: ["me@example.com"],
    cc_addrs: [],
    subject: `Subject ${seq}`,
    body_text: `Body ${seq}`,
    body_html: null,
    provider_message_id: null,
    message_id: `mid-${seq}`,
    in_reply_to: null,
    received_at: at,
    created_at: at,
    updated_at: at,
    is_read: false,
    is_starred: false,
    labels: [],
    headers: {},
    attachments: [],
    source_id: null,
    send_state: "none",
    send_started_at: null,
    status: "received",
    ...overrides,
  };
}

async function runInboxCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.option("--json");
  let data: unknown;
  const out: string[] = [];
  registerInboxCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

// For BLOCK tests: override process.exit to throw and capture console.error so we
// can assert the exit code and the exact server-only message.
async function runInboxCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await runInboxCommand(args);
    throw new Error("Expected command to exit");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

// Attachment download failures exercise process.exit(1). Run these new
// security-boundary assertions in an isolated CLI process so one test can
// never replace or restore another test file's global process.exit hook.
async function runInboxSubprocessExpectingExit(args: string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, "run", "src/cli/index.tsx", ...args],
    cwd: process.cwd(),
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

beforeAll(async () => {
  stub = await startV1Stub();
  attachmentInventoryServer = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      attachmentInventoryRequests.push(url);
      if (url.pathname !== "/v1/attachments") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const cursor = url.searchParams.get("cursor") ?? "";
      const page = attachmentInventoryPages.get(cursor);
      if (!page) return Response.json({ error: "unexpected cursor" }, { status: 400 });
      return Response.json(page);
    },
  });
});
afterAll(() => {
  stub.stop();
  attachmentInventoryServer.stop(true);
});
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
  attachmentInventoryPages = new Map();
  attachmentInventoryRequests = [];
});
afterEach(() => {
  stub.clearEnv();
  process.exitCode = 0;
});

function useAttachmentInventoryPages(
  pages: Array<[cursor: string, page: { items: Array<Record<string, unknown>>; next_cursor: string | null }]>,
): void {
  attachmentInventoryPages = new Map(pages);
  process.env.EMAILS_MODE = "self_hosted";
  process.env.EMAILS_SELF_HOSTED_URL = `http://127.0.0.1:${attachmentInventoryServer.port}`;
  process.env.EMAILS_SELF_HOSTED_API_KEY = "attachment-inventory-test-key";
  resetSelfHostedConfigCache();
}

// ─── inbound repo round-trip (POST/GET /v1/messages) ─────────────────────────

describe("inbound repo over /v1", () => {
  it("returns seeded received emails newest-first", () => {
    seedEmail({ subject: "oldest", received_at: "2026-03-18T10:00:00.000Z" });
    seedEmail({ subject: "middle", received_at: "2026-03-19T10:00:00.000Z" });
    seedEmail({ subject: "newest", received_at: "2026-03-20T10:00:00.000Z" });

    const emails = listInboundEmails();
    expect(emails.map((e) => e.subject)).toEqual(["newest", "middle", "oldest"]);
  });

  it("respects the limit option", () => {
    for (let i = 0; i < 10; i++) seedEmail({ received_at: `2026-03-${String(10 + i).padStart(2, "0")}T10:00:00.000Z` });
    expect(listInboundEmails({ limit: 3 })).toHaveLength(3);
  });

  it("filters by recipient address and by recipient domain", () => {
    seedEmail({ subject: "to-primary", to_addresses: ["el@example.com"] });
    seedEmail({ subject: "to-secondary", to_addresses: ["ap@example.net"] });
    seedEmail({ subject: "to-display", to_addresses: ['"Display Name" <display@example.com>'] });

    expect(listInboundEmails({ recipients: ["el@example.com"] }).map((e) => e.subject)).toEqual(["to-primary"]);
    expect(listInboundEmails({ recipients: ["display@example.com"] }).map((e) => e.subject)).toEqual(["to-display"]);
    expect(listInboundEmails({ recipientDomains: ["EXAMPLE.COM"] }).map((e) => e.subject).sort()).toEqual(["to-display", "to-primary"]);
    expect(listInboundEmails({ recipientDomains: ["example.net"] }).map((e) => e.subject)).toEqual(["to-secondary"]);
  });

  it("filters by since date", () => {
    seedEmail({ subject: "before", received_at: "2026-03-17T10:00:00.000Z" });
    seedEmail({ subject: "on", received_at: "2026-03-19T10:00:00.000Z" });
    seedEmail({ subject: "after", received_at: "2026-03-20T10:00:00.000Z" });

    const cutoff = "2026-03-19T00:00:00.000Z";
    const emails = listInboundEmails({ since: cutoff });
    expect(emails.map((e) => e.subject)).toEqual(["after", "on"]);
    for (const e of emails) expect(new Date(e.received_at) >= new Date(cutoff)).toBe(true);
  });

  it("returns an empty array when there is no mail", () => {
    expect(listInboundEmails()).toHaveLength(0);
  });

  it("round-trips a single email by id", () => {
    const email = seedEmail({ subject: "round trip", text_body: "hello body" });
    const fetched = getInboundEmail(email.id);
    expect(fetched?.subject).toBe("round trip");
    expect(fetched?.text_body).toBe("hello body");
  });
});

// ─── inbox list ──────────────────────────────────────────────────────────────

describe("inbox list", () => {
  it("lists inbox mail newest-first", async () => {
    seedEmail({ subject: "A", received_at: "2026-01-01T00:00:00.000Z" });
    seedEmail({ subject: "B", received_at: "2026-01-02T00:00:00.000Z" });
    seedEmail({ subject: "C", received_at: "2026-01-03T00:00:00.000Z" });

    const { data, out } = await runInboxCommand(["inbox", "list"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["C", "B", "A"]);
    expect(out).toContain("Mailbox inbox");
  });

  it("respects --limit", async () => {
    for (let i = 1; i <= 5; i++) seedEmail({ subject: `L${i}`, received_at: `2026-01-0${i}T00:00:00.000Z` });
    const { data } = await runInboxCommand(["inbox", "list", "--limit", "2"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["L5", "L4"]);
  });

  it("filters by --to address and by --to domain", async () => {
    seedEmail({ subject: "el", to_addresses: ["el@elyratelier.com"] });
    seedEmail({ subject: "ap", to_addresses: ["ap@example.net"] });

    const byAddress = await runInboxCommand(["inbox", "list", "--to", "el@elyratelier.com"]);
    expect((byAddress.data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["el"]);

    const byDomain = await runInboxCommand(["inbox", "list", "--to", "elyratelier.com"]);
    expect((byDomain.data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["el"]);
  });

  it("filters --since by timestamp instant across offset timezones", async () => {
    seedEmail({ subject: "before cutoff", received_at: "2026-07-11T23:59:59+00:00" });
    seedEmail({ subject: "offset after cutoff", received_at: "2026-07-11T23:30:00-02:00" });

    const { data } = await runInboxCommand(["inbox", "list", "--since", "2026-07-12T00:00:00.000Z"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["offset after cutoff"]);
  });

  it("shows only starred mail with --starred", async () => {
    await stub.seed({ messages: [
      msgRow({ subject: "plain", is_starred: false }),
      msgRow({ subject: "flagged", is_starred: true }),
    ] });

    const { data } = await runInboxCommand(["inbox", "list", "--starred"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["flagged"]);
  });

  it("shows only unread mail with --unread", async () => {
    await stub.seed({ messages: [
      msgRow({ subject: "read", is_read: true }),
      msgRow({ subject: "unread", is_read: false }),
    ] });

    const { data } = await runInboxCommand(["inbox", "list", "--unread"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["unread"]);
  });

  it("hides archived mail by default and shows it under --folder archived", async () => {
    await stub.seed({ messages: [
      msgRow({ subject: "normal" }),
      msgRow({ subject: "filed", labels: ["archived"] }),
    ] });

    const inbox = await runInboxCommand(["inbox", "list"]);
    expect((inbox.data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["normal"]);

    const archived = await runInboxCommand(["inbox", "list", "--folder", "archived"]);
    expect((archived.data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["filed"]);
  });

  it("lists outbound mail under --folder sent", async () => {
    await stub.seed({ messages: [
      msgRow({ subject: "received" }),
      msgRow({ subject: "outbound", direction: "outbound", labels: ["sent"] }),
    ] });

    const { data } = await runInboxCommand(["inbox", "list", "--folder", "sent"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["outbound"]);
  });

  it("filters by --label", async () => {
    await stub.seed({ messages: [
      msgRow({ subject: "tagged", labels: ["work"] }),
      msgRow({ subject: "untagged", labels: [] }),
    ] });

    const { data } = await runInboxCommand(["inbox", "list", "--label", "work"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["tagged"]);
  });

  it("reports no mail when the mailbox is empty", async () => {
    const { data, out } = await runInboxCommand(["inbox", "list"]);
    expect(data).toEqual([]);
    expect(out).toContain("No mail found");
  });
});

// ─── inbox search ────────────────────────────────────────────────────────────

describe("inbox search", () => {
  it("matches subject/body substrings", async () => {
    seedEmail({ subject: "Alpha needle", text_body: "body" });
    seedEmail({ subject: "Beta plain", text_body: "unrelated" });

    const { data } = await runInboxCommand(["inbox", "search", "needle"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["Alpha needle"]);
  });

  it("filters before applying the result limit", async () => {
    seedEmail({ subject: "Recent plain", received_at: "2026-06-04T11:30:09.000Z" });
    seedEmail({ subject: "Older match", received_at: "2026-06-04T11:29:09.000Z" });

    const { data } = await runInboxCommand(["inbox", "search", "match", "--limit", "1"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["Older match"]);
  });

  it("paginates results newest-first with offset", async () => {
    for (let i = 1; i <= 4; i++) {
      seedEmail({ subject: `needle ${i}`, received_at: `2026-06-04T11:0${i}:00.000Z` });
    }
    seedEmail({ subject: "Newest plain", received_at: "2026-06-04T11:09:00.000Z" });

    const { data } = await runInboxCommand(["inbox", "search", "needle", "--limit", "2", "--offset", "1"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["needle 3", "needle 2"]);
  });
});

// ─── inbox read ──────────────────────────────────────────────────────────────

describe("inbox read", () => {
  it("renders markdown-ish bodies as readable text", async () => {
    const email = seedEmail({
      subject: "Rendered body",
      text_body: "# Heading\n\n- **hello**\n- [docs](https://example.com/start)",
    });

    const { out } = await runInboxCommand(["inbox", "read", email.id, "--keep-unread"]);
    expect(out).toContain("Heading");
    expect(out).toContain("- hello");
    expect(out).toContain("docs (https://example.com/start)");
    expect(out).not.toContain("**hello**");
  });

  it("resolves a partial (8-char) id", async () => {
    const email = seedEmail({ subject: "By prefix" });
    const { data } = await runInboxCommand(["inbox", "read", email.id.slice(0, 8), "--keep-unread"]);
    expect((data as { subject: string }).subject).toBe("By prefix");
  });

  it("marks the email read by default", async () => {
    const email = seedEmail({ subject: "Mark on open" });
    const { data } = await runInboxCommand(["inbox", "read", email.id]);
    expect((data as { is_read: boolean }).is_read).toBe(true);
    expect(getInboundEmail(email.id)?.is_read).toBe(true);
  });

  it("keeps the email unread with --keep-unread", async () => {
    const email = seedEmail({ subject: "Stay unread" });
    await runInboxCommand(["inbox", "read", email.id, "--keep-unread"]);
    expect(getInboundEmail(email.id)?.is_read).toBe(false);
  });

  // Self-hosted attachments have no local path (the bytes live in the API, not on
  // this machine) but they ARE downloadable through
  // `inbox attachment <id> --index <n> --download`. The detail view must not tell
  // the operator the opposite: that wording is what makes real, present
  // attachments (tax filings, invoices) look unreachable.
  it("tells the operator how to fetch self-hosted attachments instead of calling them undownloadable", async () => {
    const id = crypto.randomUUID();
    await stub.seed({ messages: [msgRow({
      id,
      subject: "With attachment",
      attachments: [
        { filename: "cover.png", content_type: "image/png", size: 3, content_base64: "b25l" },
        { filename: "invoice.pdf", content_type: "application/pdf", size: 3, content_base64: "dHdv" },
      ],
    })] });

    const { out } = await runInboxCommand(["inbox", "read", id, "--keep-unread"]);
    expect(out).not.toContain("no local download in self_hosted mode");
    expect(out).not.toContain("emails inbox sync to download");
    // Every metadata entry is addressable by its authenticated download index.
    expect(out).toContain("--index 0");
    expect(out).toContain("--index 1");
    // ...and the full, copy-pasteable command is spelled out once.
    expect(out).toContain(`emails inbox attachment ${id} --index <n> --download --output-dir <dir>`);
  });

  // #36: the flip side of the test above. A historical record can expose
  // attachment metadata for bytes the store never received; the fetch it
  // advertises then always fails with "no stored content". Telling an operator
  // (or an agent cataloging mail) to run a command that cannot work is the same
  // class of lie as calling present bytes undownloadable — just inverted.
  it("does not advertise a download for a historical attachment whose payload was never stored", async () => {
    const id = crypto.randomUUID();
    await stub.seed({ messages: [msgRow({
      id,
      subject: "Historical import",
      // No content_base64: exactly how the legacy import landed — metadata only.
      attachments: [
        { filename: "D300.pdf", content_type: "application/pdf", size: 2048 },
        { filename: "D394.pdf", content_type: "application/pdf", size: 4096 },
      ],
    })] });

    const { out } = await runInboxCommand(["inbox", "read", id, "--keep-unread"]);
    expect(out).toContain("D300.pdf");
    expect(out).toContain("D394.pdf");
    expect(out).toContain("metadata only; payload not stored");
    expect(out).not.toContain("--index 0");
    expect(out).not.toContain("--index 1");
    expect(out).not.toContain("--download --output-dir");
  });

  it("keeps advertising the fetchable attachments of a partially recovered message", async () => {
    const id = crypto.randomUUID();
    await stub.seed({ messages: [msgRow({
      id,
      subject: "Partially recovered",
      attachments: [
        { filename: "D300.pdf", content_type: "application/pdf", size: 2048 },
        { filename: "D394.pdf", content_type: "application/pdf", size: 3, content_base64: "dHdv" },
      ],
    })] });

    const { out } = await runInboxCommand(["inbox", "read", id, "--keep-unread"]);
    const line = (needle: string) => out.split("\n").find((l) => l.includes(needle)) ?? "";
    expect(line("D300.pdf")).toContain("metadata only; payload not stored");
    expect(line("D300.pdf")).not.toContain("--index");
    expect(line("D394.pdf")).toContain("--index 1");
    // One fetchable entry is enough to keep the copy-pasteable command useful.
    expect(out).toContain(`emails inbox attachment ${id} --index <n> --download --output-dir <dir>`);
  });

  // The advertised index MUST be the position in the authenticated metadata
  // array, not the position in the rendered list. A nameless entry is dropped
  // from the display, so a renderer that counts its own rows would advertise
  // `--index 0` for an attachment whose real index is 1 — and download a
  // different file. On a tax filing that is worse than showing nothing.
  it("advertises the authenticated download index, not the display position", async () => {
    const id = crypto.randomUUID();
    await stub.seed({ messages: [msgRow({
      id,
      subject: "Skewed indexes",
      attachments: [
        { filename: "", content_type: "image/png", size: 3, content_base64: "b25l" },
        { filename: "D394.pdf", content_type: "application/pdf", size: 3, content_base64: "dHdv" },
      ],
    })] });

    const { out } = await runInboxCommand(["inbox", "read", id, "--keep-unread"]);
    // The nameless part stays addressable under a placeholder name, so it keeps
    // index 0 and D394.pdf keeps the index that actually downloads it.
    const line = (needle: string) => out.split("\n").find((l) => l.includes(needle)) ?? "";
    expect(line("attachment-1")).toContain("--index 0");
    expect(line("D394.pdf")).toContain("--index 1");
  });

  it("keeps a null attachment gap visible without advertising it or shifting later indexes", async () => {
    const id = crypto.randomUUID();
    await stub.seed({ messages: [msgRow({
      id,
      subject: "Null attachment element",
      attachments: [
        {
          filename: "cover.png",
          content_type: "image/png",
          size: 3,
          content_base64: "b25l",
        },
        null,
        {
          filename: "D394.pdf",
          content_type: "application/pdf",
          size: 3,
          content_base64: "dHdv",
        },
      ],
    })] });

    const { data, out } = await runInboxCommand(["inbox", "read", id, "--keep-unread"]);
    expect((data as { attachments: Array<{ filename: string; content_available?: boolean }> })
      .attachments.map((attachment) => [attachment.filename, attachment.content_available]))
      .toEqual([
        ["cover.png", true],
        ["attachment-2", false],
        ["D394.pdf", true],
      ]);
    const line = (needle: string) => out.split("\n").find((value) => value.includes(needle)) ?? "";
    expect(line("cover.png")).toContain("--index 0");
    expect(line("attachment-2")).toContain("metadata only; payload not stored");
    expect(line("attachment-2")).not.toContain("--index 1");
    expect(line("D394.pdf")).toContain("--index 2");
    expect(out).toContain(`emails inbox attachment ${id} --index <n> --download --output-dir <dir>`);
  });

  it("fails closed on primitive or malformed-object attachment members without leaking them", async () => {
    const cases = [
      {
        id: crypto.randomUUID(),
        malformed: "must-not-leak-primitive",
        path: "attachments[1]",
      },
      {
        id: crypto.randomUUID(),
        malformed: { filename: { diagnostic: "must-not-leak-object" } },
        path: "attachments[1].filename",
      },
    ];
    await stub.seed({
      messages: cases.map(({ id, malformed }) => msgRow({
        id,
        subject: "Malformed attachment element",
        attachments: [
          { filename: "cover.png", content_type: "image/png", size: 3 },
          malformed,
          { filename: "D394.pdf", content_type: "application/pdf", size: 3 },
        ],
      })),
    });

    for (const testCase of cases) {
      const result = await runInboxCommandExpectingExit([
        "inbox",
        "read",
        testCase.id,
        "--keep-unread",
      ]);
      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain("invalid successful response");
      expect(result.stderr).toContain(testCase.path);
      expect(result.stderr).not.toContain("must-not-leak");
    }
  });
});

// ─── inbox mark-read / star / archive / label ────────────────────────────────

describe("inbox mark-read", () => {
  it("marks read and returns a summary without body/header payloads", async () => {
    const email = seedEmail({
      subject: "Mark read summary",
      text_body: "large body ".repeat(1000),
      html_body: `<p>${"large html ".repeat(1000)}</p>`,
      headers: { "x-large": "header" },
    });

    const { data, out } = await runInboxCommand(["inbox", "mark-read", email.id]);
    const row = data as Record<string, unknown>;
    expect(out).toContain("Marked read");
    expect(row.id).toBe(email.id);
    expect(row.is_read).toBe(true);
    expect(row).not.toHaveProperty("text_body");
    expect(row).not.toHaveProperty("html_body");
    expect(row).not.toHaveProperty("headers");
    expect(getInboundEmail(email.id)?.is_read).toBe(true);
  });

  it("marks unread with --unread", async () => {
    await stub.seed({ messages: [msgRow({ id: "11111111-1111-4111-8111-111111111111", subject: "Was read", is_read: true })] });
    await runInboxCommand(["inbox", "mark-read", "11111111-1111-4111-8111-111111111111", "--unread"]);
    expect(getInboundEmail("11111111-1111-4111-8111-111111111111")?.is_read).toBe(false);
  });
});

describe("inbox star", () => {
  it("stars and unstars an email (round-trips through --starred)", async () => {
    const email = seedEmail({ subject: "Star me" });

    const starred = await runInboxCommand(["inbox", "star", email.id]);
    expect(starred.out).toContain("Starred");
    const listed = await runInboxCommand(["inbox", "list", "--starred"]);
    expect((listed.data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["Star me"]);

    const unstarred = await runInboxCommand(["inbox", "star", email.id, "--undo"]);
    expect(unstarred.out).toContain("Unstarred");
    expect(getInboundEmail(email.id)?.is_starred).toBe(false);
  });
});

describe("inbox archive", () => {
  it("archives an email through the /v1 API", async () => {
    const email = seedEmail({ subject: "Archive me" });

    const { out } = await runInboxCommand(["inbox", "archive", email.id]);
    expect(out).toContain("Archived");
    expect(out).toContain("Archive me");

    const row = (await stub.list("messages")).find((m) => m["id"] === email.id);
    expect(row?.["archived"]).toBe(true);
  });
});

describe("inbox label", () => {
  it("PATCHes an add-label request through the /v1 API", async () => {
    const email = seedEmail({ subject: "Label me" });

    const { out } = await runInboxCommand(["inbox", "label", email.id, "urgent"]);
    expect(out).toContain("label");

    const row = (await stub.list("messages")).find((m) => m["id"] === email.id);
    // The server (and now the stub) rebuild the labels column from add_label —
    // a raw add_label field is not persisted, the label lands in `labels`.
    expect(row?.["labels"]).toContain("urgent");
  });
});

// ─── inbox counts / status ───────────────────────────────────────────────────

describe("inbox unread-count", () => {
  it("returns the total unread count from /v1 counts", async () => {
    await stub.seed({ messages: [
      msgRow({ is_read: false }),
      msgRow({ is_read: false }),
      msgRow({ is_read: false }),
      msgRow({ is_read: true }),
      msgRow({ direction: "outbound", labels: ["sent"] }),
    ] });

    const { data, out } = await runInboxCommand(["inbox", "unread-count"]);
    expect(data).toEqual({ unread: 3 });
    expect(out).toBe("3");
  });
});

describe("inbox mailboxes", () => {
  it("reports folder counts from /v1 counts", async () => {
    await stub.seed({ messages: [
      msgRow({}),
      msgRow({}),
      msgRow({ labels: ["archived"] }),
      msgRow({ direction: "outbound", labels: ["sent"] }),
    ] });

    const { data } = await runInboxCommand(["inbox", "mailboxes"]);
    const counts = (data as { counts: { inbox: number; sent: number; archived: number } }).counts;
    expect(counts.inbox).toBe(2);
    expect(counts.sent).toBe(1);
    expect(counts.archived).toBe(1);
  });
});

describe("inbox sources", () => {
  it("exposes the single self-hosted source with its counts", async () => {
    await stub.seed({ messages: [msgRow({ is_read: false }), msgRow({ is_read: true })] });

    const { data } = await runInboxCommand(["inbox", "sources"]);
    const sources = data as Array<{ id: string; unread: number; counts: { inbox: number } }>;
    expect(sources.map((s) => s.id)).toEqual(["self_hosted"]);
    expect(sources[0]?.counts.inbox).toBe(2);
    expect(sources[0]?.unread).toBe(1);
  });

  it("honors --search instead of returning the unfiltered list", async () => {
    await stub.seed({ messages: [msgRow({})] });

    const matching = await runInboxCommand(["inbox", "sources", "--search", "self-hosted"]);
    expect((matching.data as Array<{ id: string }>).map((s) => s.id)).toEqual(["self_hosted"]);

    const missing = await runInboxCommand(["inbox", "sources", "--search", "s3-bucket-that-is-not-here"]);
    expect(missing.data as unknown[]).toEqual([]);
  });
});

// The self-inflicted trap: `inbox sources` prints id "self_hosted" and
// `--source <id>` documents itself as taking that id back — but feeding it in
// used to return an empty mailbox and all-zero folder counts, which reads
// exactly like an empty store.
describe("inbox source scoping", () => {
  it("lists mail for the source id `inbox sources` prints", async () => {
    await stub.seed({ messages: [msgRow({ subject: "scoped-a" }), msgRow({ subject: "scoped-b" })] });

    const { data } = await runInboxCommand(["inbox", "list", "--source", "self_hosted"]);
    expect((data as Array<{ subject: string }>).map((row) => row.subject).sort()).toEqual(["scoped-a", "scoped-b"]);
  });

  it("reports real folder counts for that source id", async () => {
    await stub.seed({ messages: [msgRow({}), msgRow({}), msgRow({ direction: "outbound" })] });

    const { data } = await runInboxCommand(["inbox", "mailboxes", "--source", "self_hosted"]);
    const counts = (data as { counts: { inbox: number; sent: number } }).counts;
    expect(counts.inbox).toBe(2);
    expect(counts.sent).toBe(1);
  });

  it("refuses a provider scope with an actionable message instead of printing `No mail found`", async () => {
    await stub.seed({ messages: [msgRow({})] });

    const { stderr } = await runInboxCommandExpectingExit(["inbox", "list", "--provider", "cred-1"]);
    expect(stderr).toContain("no ingestion-source or provider provenance");
    expect(stderr).toContain("--address <email> or --domain <domain>");
    expect(stderr).not.toContain("No mail found");
  });

  it("refuses an unknown ingestion source id rather than reporting an empty mailbox", async () => {
    await stub.seed({ messages: [msgRow({})] });

    const { stderr } = await runInboxCommandExpectingExit(["inbox", "mailboxes", "--source", "s3:mail-bucket"]);
    expect(stderr).toContain("cannot be applied");
  });

  it("only suggests commands that exist when the mailbox really is empty", async () => {
    const { out } = await runInboxCommand(["inbox", "list", "--address", "nobody@example.com"]);
    expect(out).toContain("No mail found");
    expect(out).toContain("emails inbox sources");
    // `emails refresh` is not a registered command in any mode.
    expect(out).not.toContain("emails refresh");
  });
});

describe("inbox list --read", () => {
  it("fills the page with read mail instead of filtering an already-paged result", async () => {
    // More unread rows than one server page, all NEWER than the read ones, so a
    // post-filter over page one yields nothing while read mail exists.
    const unread = Array.from({ length: 60 }, (_, index) => msgRow({
      subject: `unread-${index}`,
      is_read: false,
      received_at: new Date(Date.UTC(2026, 5, 2, 0, index)).toISOString(),
    }));
    const read = [
      msgRow({ subject: "read-new", is_read: true, received_at: "2026-06-01T10:00:00.000Z" }),
      msgRow({ subject: "read-old", is_read: true, received_at: "2026-06-01T09:00:00.000Z" }),
    ];
    await stub.seed({ messages: [...unread, ...read] });

    const { data } = await runInboxCommand(["inbox", "list", "--read", "--limit", "2"]);
    expect((data as Array<{ subject: string }>).map((row) => row.subject)).toEqual(["read-new", "read-old"]);
  });
});

describe("inbox status / sync-status", () => {
  it("derives inbox status from the /v1 counts endpoint", async () => {
    await stub.seed({ messages: [
      msgRow({ subject: "in-unread", received_at: "2026-07-01T00:00:00.000Z", is_read: false }),
      msgRow({ subject: "in-read", received_at: "2026-07-02T00:00:00.000Z", is_read: true }),
      msgRow({ subject: "arch", received_at: "2026-07-03T00:00:00.000Z", labels: ["archived"] }),
      msgRow({ subject: "sent", received_at: "2026-07-04T00:00:00.000Z", direction: "outbound", labels: ["sent"] }),
    ] });

    const { data, out } = await runInboxCommand(["inbox", "status"]);
    expect(data).toMatchObject({
      total: 3,
      unread: 1,
      latest_received_at: "2026-07-03T00:00:00.000Z",
    });
    expect(out).toContain("Inbox sync status");
  });

  it("reports source-aware sync status from the /v1 counts endpoint", async () => {
    await stub.seed({ messages: [
      msgRow({ received_at: "2026-07-01T00:00:00.000Z", is_read: false }),
      msgRow({ received_at: "2026-07-02T00:00:00.000Z", is_read: true }),
      msgRow({ received_at: "2026-07-03T00:00:00.000Z", labels: ["archived"] }),
      msgRow({ received_at: "2026-07-04T00:00:00.000Z", direction: "outbound", labels: ["sent"] }),
    ] });

    const { data, out } = await runInboxCommand(["inbox", "sync-status"]);
    expect(data).toMatchObject({
      inbox: { total: 3, unread: 1 },
      mailboxes: { counts: { inbox: 2, sent: 1, archived: 1 } },
      // NOTHING in this block is a zero. The mail view for a shared store publishes
      // exactly one row, `kind: "all"` — an aggregate over the whole store, not an
      // ingestion source — and it carries no active/legacy/orphaned badge. So the
      // classification cannot be measured, and neither can the number of ingestion
      // sources: counting the aggregate would report one source on an installation
      // that has configured none, and excluding it would report a flat zero for a
      // view that enumerates none. Each is null with its own reason.
      sources: { total: null, legacy: null, orphaned: null },
    });
    const payload = data as { sources: { legacy: number | null }; gaps: Record<string, { reason: string }> };
    expect(payload.gaps["sources.legacy"]?.reason).toMatch(/^not_modelled_on_store:source_classification/);
    expect(payload.gaps["sources.total"]?.reason).toMatch(/^not_modelled_on_store:aggregate_only_mailbox_view/);
    // The one row IS still published, with its real mail totals, so the view is
    // informative rather than empty.
    const listed = data as { sources: { items: Array<{ total: number }> } };
    expect(listed.sources.items).toHaveLength(1);
    // The terminal must not paint a yellow "0" for buckets it never inspected.
    expect(out).toContain("S3 buckets:  unavailable");
    expect(out).toContain("Data gaps");
  });
});

// ─── inbox code / wait-code / latest / wait ──────────────────────────────────

describe("inbox code", () => {
  it("prints the newest matching verification code, ignoring sent mail", async () => {
    seedEmail({
      from_address: '"ChatGPT" <noreply@tm.openai.com>',
      subject: "Your temporary ChatGPT verification code",
      text_body: "Enter this temporary verification code to continue:\n\n492255",
      received_at: "2026-06-04T11:29:09.000Z",
    });
    seedEmail({
      from_address: '"ChatGPT" <noreply@tm.openai.com>',
      subject: "Your temporary ChatGPT verification code",
      text_body: "Enter this temporary verification code to continue:\n\n999999",
      received_at: "2026-06-04T11:30:09.000Z",
      label_ids: ["SENT"],
    });

    const { out, data } = await runInboxCommand(["inbox", "code", "me@example.com", "--no-refresh", "--from", "openai"]);
    expect(out).toBe("492255");
    expect(data).toMatchObject({ code: "492255", confidence: "high" });
  });

  it("wait-code returns immediately when a match already exists", async () => {
    seedEmail({
      from_address: "security@example.com",
      subject: "Verification code",
      text_body: "Your code is 123456",
      received_at: "2026-06-04T11:29:09.000Z",
    });

    const { out, data } = await runInboxCommand(["inbox", "wait-code", "me@example.com", "--no-refresh", "--timeout", "1"]);
    expect(out).toBe("123456");
    expect(data).toMatchObject({ code: "123456", confidence: "high" });
  });

  it("supports the top-level `code` alias", async () => {
    seedEmail({
      from_address: "security@example.com",
      subject: "Login code",
      text_body: "Your code is 654321",
      received_at: "2026-06-04T11:29:09.000Z",
    });

    const { out } = await runInboxCommand(["code", "me@example.com", "--no-refresh"]);
    expect(out).toBe("654321");
  });
});

describe("inbox latest / wait", () => {
  it("latest returns the newest matching email", async () => {
    seedEmail({ subject: "Older", received_at: "2026-06-04T11:00:00.000Z" });
    seedEmail({ subject: "Latest local mail", received_at: "2026-06-04T11:29:09.000Z" });

    const { out, data } = await runInboxCommand(["inbox", "latest", "me@example.com"]);
    expect(out).toContain("Latest local mail");
    expect(data).toMatchObject({ subject: "Latest local mail" });
  });

  it("latest applies from and subject filters", async () => {
    seedEmail({
      from_address: "updates@example.com",
      subject: "Recent noise",
      received_at: "2026-06-04T11:30:09.000Z",
    });
    seedEmail({
      from_address: "security@example.com",
      subject: "Target login alert",
      received_at: "2026-06-04T11:29:09.000Z",
    });

    const { data } = await runInboxCommand([
      "inbox", "latest", "me@example.com", "--from", "security", "--subject", "target", "--limit", "1",
    ]);
    expect(data).toMatchObject({ subject: "Target login alert", from_address: "security@example.com" });
  });

  it("wait returns the latest email when one is already present", async () => {
    seedEmail({ subject: "Awaited", received_at: "2026-06-04T11:29:09.000Z" });

    const { data } = await runInboxCommand(["inbox", "wait", "me@example.com", "--no-refresh", "--timeout", "1"]);
    expect(data).toMatchObject({ subject: "Awaited" });
  });
});

// ─── inbox links ─────────────────────────────────────────────────────────────

describe("inbox links", () => {
  it("extracts links via the subcommand and the top-level alias", async () => {
    const email = seedEmail({
      subject: "Links please",
      text_body: "Plain link https://plain.example/path.",
      html_body: `<p>Open <a href="https://Example.com/docs?x=1&amp;y=2">Docs</a></p>`,
    });

    const viaInbox = await runInboxCommand(["inbox", "links", email.id.slice(0, 8)]);
    expect(viaInbox.out).toContain("Links for");
    expect(viaInbox.out).toContain("https://Example.com/docs?x=1&y=2");
    expect(viaInbox.out).toContain("https://plain.example/path");
    expect((viaInbox.data as { links: unknown[] }).links).toHaveLength(2);

    const viaAlias = await runInboxCommand(["links", email.id]);
    expect((viaAlias.data as { links: Array<{ normalized_url: string }> }).links.map((l) => l.normalized_url)).toEqual([
      "https://example.com/docs?x=1&y=2",
      "https://plain.example/path",
    ]);
  });

  it("keeps mailto links out unless --all is passed", async () => {
    const email = seedEmail({
      subject: "Mailto",
      text_body: "mailto:ops@example.com and https://example.com",
    });

    const normal = await runInboxCommand(["inbox", "links", email.id]);
    expect((normal.data as { links: Array<{ normalized_url: string }> }).links.map((l) => l.normalized_url)).toEqual([
      "https://example.com/",
    ]);

    const all = await runInboxCommand(["inbox", "links", email.id, "--all"]);
    expect((all.data as { links: Array<{ normalized_url: string }> }).links.map((l) => l.normalized_url)).toEqual([
      "mailto:ops@example.com",
      "https://example.com/",
    ]);
  });
});

// ─── inbox attachments inventory ─────────────────────────────────────────────

describe("inbox attachments", () => {
  it("honors config-file-only self_hosted mode without opening usable SQLite", async () => {
    attachmentInventoryPages = new Map([["", { items: [], next_cursor: null }]]);
    const configHome = mkdtempSync(join(tmpdir(), "emails-config-only-inventory-"));
    const poisonDbDir = mkdtempSync(join(tmpdir(), "emails-config-only-poison-db-"));
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.EMAILS_DB_PATH;
    const previousClientEnvSecret = process.env.EMAILS_CLIENT_ENV_SECRET;
    const previousSessionToken = process.env.EMAILS_SESSION_TOKEN;
    try {
      process.env.HOME = configHome;
      saveConfig({ emails_mode: "self_hosted" });
      for (const key of ["MAILERY_MODE", "HASNA_MAILERY_MODE", "EMAILS_MODE", "HASNA_EMAILS_MODE"]) {
        delete process.env[key];
      }
      delete process.env.EMAILS_CLIENT_ENV_SECRET;
      delete process.env.EMAILS_SESSION_TOKEN;
      process.env.EMAILS_SELF_HOSTED_URL = `http://127.0.0.1:${attachmentInventoryServer.port}`;
      process.env.EMAILS_SELF_HOSTED_API_KEY = "attachment-inventory-test-key";
      process.env.EMAILS_DB_PATH = poisonDbDir;
      resetSelfHostedConfigCache();

      const result = await runInboxCommand(["--json", "inbox", "attachments"]);

      expect(result.data).toEqual({ items: [], next_cursor: null });
      expect(attachmentInventoryRequests).toHaveLength(1);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.EMAILS_DB_PATH;
      else process.env.EMAILS_DB_PATH = previousDbPath;
      if (previousClientEnvSecret === undefined) delete process.env.EMAILS_CLIENT_ENV_SECRET;
      else process.env.EMAILS_CLIENT_ENV_SECRET = previousClientEnvSecret;
      if (previousSessionToken === undefined) delete process.env.EMAILS_SESSION_TOKEN;
      else process.env.EMAILS_SESSION_TOKEN = previousSessionToken;
      rmSync(configHome, { recursive: true, force: true });
      rmSync(poisonDbDir, { recursive: true, force: true });
      resetSelfHostedConfigCache();
    }
  });

  it("returns one exact strict page envelope from the self-hosted inventory API", async () => {
    useAttachmentInventoryPages([["", {
      items: [{
        message_id: "message-1",
        attachment_index: 0,
        filename: "invoice.pdf",
        content_type: "application/pdf",
        size_bytes: 2048,
        sha256: "a".repeat(64),
        content_available: true,
        direction: "inbound",
        received_at: "2026-07-24T08:00:00.000Z",
      }],
      next_cursor: "opaque/+==",
    }]]);
    const poisonDbDir = mkdtempSync(join(tmpdir(), "emails-no-local-inventory-"));
    const previousDbPath = process.env.EMAILS_DB_PATH;
    process.env.EMAILS_DB_PATH = poisonDbDir;
    try {
      const { data } = await runInboxCommand([
        "--json",
        "inbox",
        "attachments",
        "--limit",
        "1",
        "--direction",
        "inbound",
        "--since",
        "2026-07-24T10:00:00+02:00",
      ]);
      expect(data).toEqual({
        items: [{
          message_id: "message-1",
          attachment_index: 0,
          filename: "invoice.pdf",
          content_type: "application/pdf",
          size_bytes: 2048,
          sha256: "a".repeat(64),
          content_available: true,
          direction: "inbound",
          received_at: "2026-07-24T08:00:00.000Z",
        }],
        next_cursor: "opaque/+==",
      });
      expect(Object.keys(data as Record<string, unknown>).sort()).toEqual(["items", "next_cursor"]);
      expect(JSON.stringify(data)).not.toContain("content_base64");
      expect(attachmentInventoryRequests).toHaveLength(1);
      expect(attachmentInventoryRequests[0]?.searchParams.get("limit")).toBe("1");
      expect(attachmentInventoryRequests[0]?.searchParams.get("direction")).toBe("inbound");
      expect(attachmentInventoryRequests[0]?.searchParams.get("since")).toBe("2026-07-24T08:00:00.000Z");
    } finally {
      if (previousDbPath === undefined) delete process.env.EMAILS_DB_PATH;
      else process.env.EMAILS_DB_PATH = previousDbPath;
      rmSync(poisonDbDir, { recursive: true, force: true });
    }
  });

  it("fails closed on unsupported inventory object fields without leaking them", async () => {
    useAttachmentInventoryPages([["", {
      items: [{
        message_id: "message-1",
        attachment_index: 0,
        filename: "invoice.pdf",
        content_type: "application/pdf",
        size_bytes: 2048,
        sha256: "a".repeat(64),
        content_available: true,
        direction: "inbound",
        received_at: "2026-07-24T08:00:00.000Z",
        content_base64: "must-not-leak",
      }],
      next_cursor: null,
    }]]);

    const result = await runInboxCommandExpectingExit(["--json", "inbox", "attachments"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("invalid successful response");
    expect(result.stderr).toContain("unsupported fields");
    expect(result.stderr).not.toContain("must-not-leak");
  });

  it("passes the opaque next cursor unchanged and terminates with null", async () => {
    useAttachmentInventoryPages([
      ["", { items: [], next_cursor: "opaque/+==" }],
      ["opaque/+==", { items: [], next_cursor: null }],
    ]);

    const first = await runInboxCommand(["inbox", "attachments", "--limit", "2"]);
    expect(first.data).toEqual({ items: [], next_cursor: "opaque/+==" });

    const second = await runInboxCommand([
      "inbox",
      "attachments",
      "--limit",
      "2",
      "--cursor",
      "opaque/+==",
    ]);
    expect(second.data).toEqual({ items: [], next_cursor: null });
    expect(attachmentInventoryRequests.map((url) => url.searchParams.get("cursor"))).toEqual([null, "opaque/+=="]);
  });

  it("renders a null attachment size as an explicit unknown size", async () => {
    useAttachmentInventoryPages([["", {
      items: [{
        message_id: "msg-null-size",
        attachment_index: 0,
        filename: "mystery.pdf",
        content_type: "application/pdf",
        size_bytes: null,
        sha256: null,
        content_available: false,
        direction: "inbound",
        received_at: "2026-07-24T08:00:00.000Z",
      }],
      next_cursor: null,
    }]]);

    const { out } = await runInboxCommand(["inbox", "attachments"]);
    expect(out).toBe([
      "",
      "Attachment inventory (1):",
      "  msg-null [0] mystery.pdf unknown size · application/pdf unavailable",
      "  next_cursor: null",
      "",
    ].join("\n"));
  });

  it("rejects invalid limit, direction, and since values before calling the API", async () => {
    useAttachmentInventoryPages([["", { items: [], next_cursor: null }]]);
    const cases = [
      { args: ["--limit", "0"], message: "limit" },
      { args: ["--limit", "501"], message: "limit" },
      { args: ["--limit", "1.5"], message: "limit" },
      { args: ["--direction", "sideways"], message: "direction" },
      { args: ["--since", "not-a-date"], message: "since" },
    ];

    for (const testCase of cases) {
      attachmentInventoryRequests = [];
      const result = await runInboxCommandExpectingExit(["inbox", "attachments", ...testCase.args]);
      expect(result.error).toBe("process.exit:1");
      expect(result.stderr.toLowerCase()).toContain(testCase.message);
      expect(attachmentInventoryRequests).toHaveLength(0);
    }
  });

  it("accepts integer sizes and rejects non-integer attachment sizes", async () => {
    useAttachmentInventoryPages([["", {
      items: [{
        message_id: "message-integer-size",
        attachment_index: 0,
        filename: "invoice.pdf",
        content_type: "application/pdf",
        size_bytes: 2048,
        sha256: null,
        content_available: true,
        direction: "inbound",
        received_at: "2026-07-24T08:00:00.000Z",
      }],
      next_cursor: null,
    }]]);

    expect((await runInboxCommand(["--json", "inbox", "attachments"])).data).toMatchObject({
      items: [{ size_bytes: 2048 }],
    });

    for (const invalidSize of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2048", "-1", "01", "1.0", " 1", "1 "]) {
      useAttachmentInventoryPages([["", {
        items: [{
          message_id: "message-invalid-size",
          attachment_index: 0,
          filename: "invoice.pdf",
          content_type: "application/pdf",
          size_bytes: invalidSize,
          sha256: null,
          content_available: true,
          direction: "inbound",
          received_at: "2026-07-24T08:00:00.000Z",
        }],
        next_cursor: null,
      }]]);

      const result = await runInboxCommandExpectingExit(["--json", "inbox", "attachments"]);
      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain("size_bytes");
    }
  });
});

// ─── inbox attachment ────────────────────────────────────────────────────────

describe("inbox attachment", () => {
  it("lists attachment metadata (no local paths in self-hosted mode)", async () => {
    const email = seedEmail({
      subject: "Has attachments",
      attachments: [
        { filename: "invoice.pdf", content_type: "application/pdf", size: 2048 },
        { filename: "notes.txt", content_type: "text/plain", size: 12 },
      ],
    });

    const { data, out } = await runInboxCommand(["inbox", "attachment", email.id.slice(0, 8), "--filename", "invoice.pdf"]);
    // `index` is the authenticated download index, so a JSON consumer can go
    // straight from this listing to `--index <n> --download` — and
    // `content_available` says whether that download can succeed at all. These
    // seeded rows carry metadata only (no stored bytes), like a legacy import.
    expect(data).toEqual([
      {
        filename: "invoice.pdf",
        content_type: "application/pdf",
        size: 2048,
        openable: false,
        index: 0,
        content_available: false,
      },
    ]);
    expect(out).toContain("2 KB");
    expect(out).toContain("metadata only; payload not stored");
    expect(out).not.toContain("(not downloaded)");
  });

  // #36: the same listing for a message whose bytes ARE stored must stay
  // downloadable-looking, and the deliberate download of a metadata-only index
  // must fail with the provenance-specific state — never a bare "not found",
  // and never a partial file on disk.
  it("separates fetchable attachments from metadata-only ones and fails the metadata-only download cleanly", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-attachment-"));
    try {
      await stub.seed({ messages: [msgRow({
        id,
        attachments: [
          { filename: "legacy.pdf", content_type: "application/pdf", size: 2048 },
          { filename: "current.txt", content_type: "text/plain", size: 5, content_base64: "aGVsbG8=" },
        ],
      })] });

      const { data, out } = await runInboxCommand(["inbox", "attachment", id]);
      expect((data as Array<{ filename: string; content_available?: boolean }>)
        .map((item) => [item.filename, item.content_available]))
        .toEqual([["legacy.pdf", false], ["current.txt", true]]);
      const line = (needle: string) => out.split("\n").find((l) => l.includes(needle)) ?? "";
      expect(line("legacy.pdf")).toContain("metadata only; payload not stored");
      expect(line("current.txt")).toContain("(not downloaded)");

      const failed = await runInboxSubprocessExpectingExit([
        "inbox", "attachment", id, "--download", "--index", "0", "--output-dir", dir,
      ]);
      expect(failed.exitCode).toBe(1);
      expect(failed.stderr).toContain("metadata but no stored content");
      expect(failed.stderr).not.toContain("not found");
      expect(readdirSync(dir)).toEqual([]);

      // The fetchable sibling still downloads: the guard is per attachment, not
      // per message.
      const { data: saved } = await runInboxCommand([
        "inbox", "attachment", id, "--download", "--index", "1", "--output-dir", dir,
      ]);
      expect((saved as Array<{ bytes: number }>)[0]!.bytes).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters non-download attachments by authenticated metadata index across display gaps", async () => {
    const id = crypto.randomUUID();
    const mergedDisplay = mergeAttachmentDetails([
      { filename: "", content_type: "application/octet-stream", size: 0 },
      { filename: "target.pdf", content_type: "application/pdf", size: 2048 },
      { filename: "other.txt", content_type: "text/plain", size: 12 },
    ]);
    expect(mergedDisplay.map(({ filename, index }) => [filename, index])).toEqual([
      ["target.pdf", 1],
      ["other.txt", 2],
    ]);
    expect(filterAttachmentDetails(mergedDisplay, { index: 1 }).map(({ filename, index }) => [filename, index]))
      .toEqual([["target.pdf", 1]]);

    await stub.seed({ messages: [msgRow({
      id,
      attachments: [
        { filename: "", content_type: "application/octet-stream", size: 0 },
        { filename: "target.pdf", content_type: "application/pdf", size: 2048 },
        { filename: "other.txt", content_type: "text/plain", size: 12 },
      ],
    })] });

    // The unnamed metadata entry is omitted from the merged display array, so
    // the merged detail's authenticated index must win over its display position.
    const { data } = await runInboxCommand(["inbox", "attachment", id, "--index", "1"]);
    expect((data as Array<{ filename: string; index?: number }>)).toEqual([
      expect.objectContaining({ filename: "target.pdf", index: 1 }),
    ]);
  });

  it("does not fetch a null attachment gap and still downloads the later authenticated index", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-attachment-gap-"));
    try {
      await stub.seed({ messages: [msgRow({
        id,
        attachments: [
          { filename: "first.txt", content_type: "text/plain", size: 3, content_base64: "b25l" },
          null,
          { filename: "later.txt", content_type: "text/plain", size: 3, content_base64: "dHdv" },
        ],
      })] });

      const listed = await runInboxCommand(["inbox", "attachment", id]);
      expect((listed.data as Array<{ filename: string; index?: number; content_available?: boolean }>)
        .map((item) => [item.filename, item.index, item.content_available]))
        .toEqual([
          ["first.txt", 0, true],
          ["attachment-2", 1, false],
          ["later.txt", 2, true],
        ]);

      const rejected = await runInboxCommandExpectingExit([
        "inbox", "attachment", id, "--download", "--index", "1", "--output-dir", dir,
      ]);
      expect(rejected.error).toBe("process.exit:1");
      expect(rejected.stderr).toContain("not available for download");
      expect(rejected.stderr).not.toContain("not found");
      expect(readdirSync(dir)).toEqual([]);

      const { data: saved } = await runInboxCommand([
        "inbox", "attachment", id, "--download", "--index", "2", "--output-dir", dir,
      ]);
      expect((saved as Array<{ index: number; filename: string; bytes: number }>)[0]).toMatchObject({
        index: 2,
        filename: "later.txt",
        bytes: 3,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows a legacy unknown attachment probe while an explicit null gap stays blocked", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-legacy-attachment-"));
    const row = msgRow({
      id,
      attachments: [
        { filename: "first.txt", content_type: "text/plain", size: 3, content_available: true },
        null,
        { filename: "legacy.txt", content_type: "text/plain", size: 3 },
      ],
    });
    const attachmentRequests: string[] = [];
    const legacyServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === `/v1/messages/${id}`) {
          return Response.json({ message: row });
        }
        if (request.method === "GET" && url.pathname.startsWith(`/v1/messages/${id}/attachments/`)) {
          attachmentRequests.push(url.pathname);
          if (url.pathname === `/v1/messages/${id}/attachments/2`) {
            return Response.json({
              attachment: {
                filename: "legacy.txt",
                content_type: "text/plain",
                size: 3,
                content_base64: "dHdv",
              },
            });
          }
          return Response.json({ code: "attachment_not_found" }, { status: 404 });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    const inheritedProcessEnv = { ...process.env };

    try {
      process.env.EMAILS_MODE = "self_hosted";
      process.env.EMAILS_SELF_HOSTED_URL = `http://127.0.0.1:${legacyServer.port}`;
      process.env.EMAILS_SELF_HOSTED_API_KEY = "legacy-attachment-test-key";
      resetSelfHostedConfigCache();
      resetMailDataSource();

      const listed = await runInboxCommand(["inbox", "attachment", id]);
      expect((listed.data as Array<{ filename: string; index?: number; content_available?: boolean }>)
        .map((item) => [item.filename, item.index, item.content_available]))
        .toEqual([
          ["first.txt", 0, true],
          ["attachment-2", 1, false],
          ["legacy.txt", 2, undefined],
        ]);
      const read = await runInboxCommand(["inbox", "read", id, "--keep-unread"]);
      const line = (needle: string) => read.out.split("\n").find((value) => value.includes(needle)) ?? "";
      expect(line("attachment-2")).toContain("metadata only; payload not stored");
      expect(line("attachment-2")).not.toContain("--index 1");
      expect(line("legacy.txt")).toContain("fetch with --index 2");

      const rejected = await runInboxSubprocessExpectingExit([
        "inbox", "attachment", id, "--download", "--index", "1", "--output-dir", dir,
      ]);
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr).toContain("not available for download");
      expect(attachmentRequests).not.toContain(`/v1/messages/${id}/attachments/1`);
      expect(readdirSync(dir)).toEqual([]);

      const downloaded = await runInboxSubprocessExpectingExit([
        "inbox", "attachment", id, "--download", "--index", "2", "--output-dir", dir,
      ]);
      expect(downloaded.exitCode).toBe(0);
      expect(downloaded.stderr).toBe("");
      expect(attachmentRequests).toContain(`/v1/messages/${id}/attachments/2`);
      const files = readdirSync(dir);
      expect(files).toEqual(["legacy.txt"]);
      expect(readFileSync(join(dir, files[0]!), "utf8")).toBe("two");
    } finally {
      legacyServer.stop(true);
      restoreProcessEnv(inheritedProcessEnv);
      resetSelfHostedConfigCache();
      resetMailDataSource();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("downloads a validated attachment to a collision-proof mode-0600 file", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-attachment-"));
    try {
      await stub.seed({ messages: [msgRow({
        id,
        attachments: [{
          filename: "../invoice.txt",
          content_type: "text/plain",
          size: 5,
          content_base64: "aGVsbG8=",
        }],
      })] });
      const { data } = await runInboxCommand([
        "inbox", "attachment", id, "--download", "--index", "0", "--output-dir", dir, "--max-bytes", "16",
      ]);
      const [saved] = data as Array<{ path: string; sha256: string; bytes: number }>;
      expect(saved).toMatchObject({
        bytes: 5,
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      });
      expect(saved.path.startsWith(`${dir}/`)).toBe(true);
      expect(readFileSync(saved.path, "utf8")).toBe("hello");
      expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a legacy null-size 409 typed as unavailable without leaking its payload", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-attachment-"));
    try {
      await stub.seed({ messages: [msgRow({
        id,
        attachments: [{
          filename: "legacy.pdf",
          content_type: "application/pdf",
          size: null,
        }],
      })] });
      const result = await runInboxSubprocessExpectingExit([
        "inbox", "attachment", id, "--download", "--index", "0", "--output-dir", dir,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("metadata but no stored content");
      expect(result.stderr).not.toContain("non-negative integer");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires an explicit single index before creating any download file", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-attachment-"));
    try {
      await stub.seed({ messages: [msgRow({
        id,
        attachments: [
          { filename: "one.txt", content_type: "text/plain", size: 3, content_base64: "b25l" },
          { filename: "two.txt", content_type: "text/plain", size: 3, content_base64: "dHdv" },
        ],
      })] });
      const result = await runInboxSubprocessExpectingExit([
        "inbox", "attachment", id, "--download", "--output-dir", dir,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--index");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires the exact full message id for an attachment download", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-attachment-"));
    try {
      await stub.seed({ messages: [msgRow({
        id,
        attachments: [
          { filename: "one.txt", content_type: "text/plain", size: 3, content_base64: "b25l" },
        ],
      })] });
      const result = await runInboxSubprocessExpectingExit([
        "inbox", "attachment", id.slice(0, 8), "--download", "--index", "0", "--output-dir", dir,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("exact full message id");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a missing explicit index selection without creating any file", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-attachment-"));
    try {
      await stub.seed({ messages: [msgRow({
        id,
        attachments: [
          { filename: "one.txt", content_type: "text/plain", size: 3, content_base64: "b25l" },
        ],
      })] });
      const result = await runInboxSubprocessExpectingExit([
        "inbox", "attachment", id, "--download", "--index", "7", "--output-dir", dir,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No stored attachment metadata");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("downloads the explicitly selected duplicate filename index only", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-attachment-"));
    try {
      await stub.seed({ messages: [msgRow({
        id,
        attachments: [
          { filename: "same.txt", content_type: "text/plain", size: 3, content_base64: "b25l" },
          { filename: "same.txt", content_type: "text/plain", size: 3, content_base64: "dHdv" },
        ],
      })] });
      const { data } = await runInboxCommand([
        "inbox", "attachment", id, "--download", "--index", "1", "--filename", "same.txt", "--output-dir", dir,
      ]);
      const saved = data as Array<{ index: number; path: string }>;
      expect(saved.map((item) => item.index)).toEqual([1]);
      expect(saved.map((item) => readFileSync(item.path, "utf8"))).toEqual(["two"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── inbox delete / clear ────────────────────────────────────────────────────

describe("inbox delete / clear", () => {
  it("deletes a single email through the /v1 API", async () => {
    const email = seedEmail({ subject: "Delete me" });
    await runInboxCommand(["inbox", "delete", email.id, "--yes"]);
    expect(getInboundEmail(email.id)).toBeNull();
  });

  it("clears the inbox through the /v1 API", async () => {
    seedEmail({ subject: "one" });
    seedEmail({ subject: "two" });
    seedEmail({ subject: "three" });

    await runInboxCommand(["inbox", "clear", "--yes"]);
    expect(listInboundEmails()).toHaveLength(0);
  });
});

// ─── server-only subcommands (fail closed) ───────────────────────────────────

describe("inbox open blocks in the self-hosted client", () => {
  it("fails closed pointing at `inbox read`", async () => {
    const result = await runInboxCommandExpectingExit(["inbox", "open", "abc123"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("emails inbox open is not available in the self-hosted client");
    expect(result.stderr).toContain("emails inbox read <id>");
  });
});

describe("inbox unread-count --by-address blocks in the self-hosted client", () => {
  it("fails closed pointing at the total unread count", async () => {
    const result = await runInboxCommandExpectingExit(["inbox", "unread-count", "--by-address"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("inbox unread-count --by-address");
    expect(result.stderr).toContain("not available in the self-hosted client");
    expect(result.stderr).toContain("emails inbox unread-count");
  });
});

describe("server-only ingestion/diagnostic subcommands", () => {
  const cases: Array<{ label: string; args: string[]; command: string }> = [
    { label: "explain", args: ["inbox", "explain", "31f40200"], command: "emails inbox explain" },
    { label: "sync-s3", args: ["inbox", "sync-s3", "--bucket", "mail-bucket", "--limit", "1"], command: "emails inbox sync-s3" },
    { label: "setup-realtime", args: ["inbox", "setup-realtime", "example.com"], command: "emails inbox setup-realtime" },
    { label: "realtime-status", args: ["inbox", "realtime-status"], command: "emails inbox realtime-status" },
    { label: "watch", args: ["inbox", "watch", "--once"], command: "emails inbox watch" },
    { label: "listen", args: ["inbox", "listen", "--port", "2526"], command: "emails inbox listen" },
  ];

  for (const { label, args, command } of cases) {
    it(`${label} fails closed with a server-only message`, async () => {
      const result = await runInboxCommandExpectingExit(args);
      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain(command);
      expect(result.stderr).toContain("is not available in the self-hosted client");
      expect(result.stderr).toContain("it runs on the self-hosted server");
    });
  }
});

// ─── inbox source lifecycle (previously refused; client-side registry) ────────
//
// `inbox source list/add-s3/retire` used to refuse in this mode while
// `inbox sources` — one word apart — worked, an intra-file contradiction. The
// registry is client config: src/lib/s3-sync.remote.ts implements all three
// functions, and src/cli/tui/data.remote.ts already READS the same registry to
// resolve a `--source` ref. Only the INGESTION half (`sync-s3`) is server-owned,
// and it still refuses (asserted above).
//
// Every test here runs under a temporary HOME so the registry writes land in a
// throwaway config file, never the operator's.
describe("inbox source lifecycle is a client-side registry", () => {
  let sourceHome: string;
  let priorSourceHome: string | undefined;

  beforeEach(() => {
    sourceHome = mkdtempSync(join(tmpdir(), "emails-inbox-source-home-"));
    priorSourceHome = process.env.HOME;
    process.env.HOME = sourceHome;
  });
  afterEach(() => {
    if (priorSourceHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorSourceHome;
    rmSync(sourceHome, { recursive: true, force: true });
  });

  it("reports an empty registry as empty instead of refusing", async () => {
    const { data, out } = await runInboxCommand(["inbox", "source", "list"]);

    expect(data).toEqual([]);
    expect(out).toContain("No sources configured.");
    expect(out).not.toContain("not available in the self-hosted client");
  });

  it("registers an S3 source with add-s3 and reads it back with list", async () => {
    const added = await runInboxCommand([
      "inbox", "source", "add-s3",
      "--bucket", "inbound-mail",
      "--prefix", "raw/",
      "--region", "eu-west-1",
      "--name", "Primary inbound",
    ]);
    expect(added.data).toMatchObject({
      id: "s3-inbound-mail-raw-",
      type: "s3",
      bucket: "inbound-mail",
      prefix: "raw/",
      region: "eu-west-1",
      status: "live",
      live_sync_enabled: true,
    });
    // No capability claim: this client performs no ingestion, so the message says
    // what it actually did (recorded provenance) and where ingestion is configured.
    expect(added.out).toContain("Recorded S3 source s3-inbound-mail-raw-");
    expect(added.out).not.toContain("live sync enabled");
    expect(added.out).toContain("performs no S3 ingestion");

    const listed = await runInboxCommand(["inbox", "source", "list"]);
    expect(listed.data as Array<{ id: string; bucket: string }>).toEqual([
      expect.objectContaining({ id: "s3-inbound-mail-raw-", bucket: "inbound-mail" }),
    ]);
    expect(listed.out).toContain("s3://inbound-mail/raw/ eu-west-1");
  });

  it("records provider provenance through the /v1 provider id resolver", async () => {
    await stub.seed({ providers: [{ id: "0198d00d-0000-7000-8000-0000000000a1", name: "ses-inbound", type: "ses" }] });

    const added = await runInboxCommand([
      "inbox", "source", "add-s3",
      "--bucket", "provenance-bucket",
      "--provider", "0198d00d",
    ]);

    expect(added.data).toMatchObject({ provider_id: "0198d00d-0000-7000-8000-0000000000a1" });
  });

  it("honours --no-live-sync instead of silently enabling ingestion", async () => {
    const added = await runInboxCommand([
      "inbox", "source", "add-s3", "--bucket", "cold-bucket", "--no-live-sync",
    ]);

    // The column is recorded faithfully; the message makes no claim either way,
    // because nothing in this client acts on it.
    expect(added.data).toMatchObject({ live_sync_enabled: false });
    expect(added.out).not.toContain("live sync enabled");
  });

  it("rejects an unknown --status", async () => {
    const result = await runInboxCommandExpectingExit([
      "inbox", "source", "add-s3", "--bucket", "bad-status", "--status", "archived",
    ]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("Source status must be one of: live, import, legacy, retired");
  });

  it("retires a registered source and keeps it listed as retired", async () => {
    await runInboxCommand(["inbox", "source", "add-s3", "--bucket", "retire-me"]);

    const retired = await runInboxCommand(["inbox", "source", "retire", "s3-retire-me"]);
    expect(retired.data).toMatchObject({ id: "s3-retire-me", status: "retired", live_sync_enabled: false });
    expect(retired.out).toContain("Retired S3 source s3-retire-me");

    const listed = await runInboxCommand(["inbox", "source", "list"]);
    expect(listed.data as Array<{ status: string }>).toEqual([
      expect.objectContaining({ status: "retired" }),
    ]);
    expect(listed.out).toContain("retired");
  });

  it("fails retire for an unknown source rather than reporting success", async () => {
    const result = await runInboxCommandExpectingExit(["inbox", "source", "retire", "s3-not-registered"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("S3 source not found: s3-not-registered");
  });
});
