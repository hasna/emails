import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { getInboundEmail, storeInboundEmail } from "../../db/inbound.local.js";
import { resetMailDataSource } from "../../lib/mail-data-source.js";
import { EMAILS_CLIENT_ENV_SECRET_ENV } from "../../lib/client-env.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  DATABASE_PATH_SETTINGS,
} from "../../store-resolution.js";
import { registerInboxCommands } from "./inbox.local.js";

// Any inherited store selector — a deployment-word variable, the client-env
// vault pointer, or a configured API endpoint/credential — would route the
// inbox commands at something other than the local SQLite store this suite
// exercises. They are cleared by shape rather than named, so this file adds no
// fresh spelling of the deployment-word variable the axis ratchet is retiring.
const DEPLOYMENT_WORD_ENV = /^(?:HASNA_)?EMAILS_[A-Z_]*MODE$/;
function pinLocalStore(): void {
  for (const key of Object.keys(process.env)) {
    if (DEPLOYMENT_WORD_ENV.test(key)) delete process.env[key];
  }
  delete process.env[EMAILS_CLIENT_ENV_SECRET_ENV];
  delete process.env[API_BASE_URL_SETTING];
  for (const key of API_CREDENTIAL_SETTINGS) delete process.env[key];
  for (const key of DATABASE_PATH_SETTINGS) delete process.env[key];
  process.env.EMAILS_DB_PATH = ":memory:";
}

let originalEnv: NodeJS.ProcessEnv;
let sequence = 0;

type StoreInput = Parameters<typeof storeInboundEmail>[0];

beforeEach(() => {
  originalEnv = { ...process.env };
  pinLocalStore();
  resetMailDataSource();
  resetDatabase();
  getDatabase();
  sequence = 0;
});

afterEach(() => {
  resetMailDataSource();
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  process.exitCode = 0;
});

function seed(overrides: Partial<StoreInput> = {}) {
  sequence += 1;
  return storeInboundEmail({
    provider_id: null,
    message_id: `<local-${sequence}@example.com>`,
    in_reply_to_email_id: null,
    from_address: `sender-${sequence}@example.com`,
    to_addresses: ["me@example.com"],
    cc_addresses: [],
    subject: `Local subject ${sequence}`,
    text_body: `Local body ${sequence}`,
    html_body: null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: 100,
    received_at: `2026-07-${String(sequence).padStart(2, "0")}T00:00:00.000Z`,
    ...overrides,
  }, getDatabase());
}

async function runInbox(args: string[]): Promise<{ data: unknown; formatted: string }> {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const rendered: string[] = [];
  registerInboxCommands(program, (value, formatted) => {
    data = value;
    rendered.push(formatted);
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, formatted: rendered.join("\n") };
}

async function runInboxExpectingExit(args: string[]): Promise<{ error: string; stderr: string }> {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  process.exit = ((code?: number) => { throw new Error(`process.exit:${code ?? 0}`); }) as typeof process.exit;
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  try {
    await runInbox(args);
    throw new Error("Expected command to exit");
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

describe("local inbox commands", () => {
  it("returns an observable empty list without fabricating rows", async () => {
    const result = await runInbox(["inbox", "list"]);

    expect(result.data).toEqual([]);
    expect(result.formatted).toContain("No mail found");
  });

  it("lists, filters, searches, and bounds local mailbox rows", async () => {
    seed({ subject: "Older unrelated", received_at: "2026-07-01T00:00:00.000Z" });
    const target = seed({
      from_address: "alerts@example.com",
      to_addresses: ["Me <me@example.com>"],
      subject: "Needle alert",
      text_body: "verification payload",
      received_at: "2026-07-03T00:00:00.000Z",
    });
    seed({ subject: "Newest unrelated", to_addresses: ["other@example.com"], received_at: "2026-07-04T00:00:00.000Z" });

    const listed = await runInbox(["inbox", "list", "--to", "me@example.com", "--since", "2026-07-02", "--limit", "1"]);
    expect((listed.data as Array<{ id: string }>).map((row) => row.id)).toEqual([target.id]);
    const searched = await runInbox(["inbox", "search", "verification", "--limit", "5"]);
    expect((searched.data as Array<{ id: string }>).map((row) => row.id)).toEqual([target.id]);
    expect((await runInbox(["inbox", "search", "absent"])).data).toEqual([]);
  });

  it("reads by the displayed short id and honors the keep-unread boundary", async () => {
    const email = seed({ text_body: "Read me" });

    const kept = await runInbox(["inbox", "read", email.id.slice(0, 8), "--keep-unread"]);
    expect(kept.data).toMatchObject({ id: email.id, is_read: false, text_body: "Read me" });
    expect(getInboundEmail(email.id, getDatabase())?.is_read).toBe(false);

    const read = await runInbox(["inbox", "read", email.id.slice(0, 8)]);
    expect(read.data).toMatchObject({ id: email.id, is_read: true });
    expect(getInboundEmail(email.id, getDatabase())?.is_read).toBe(true);
  });

  it("mutates read, starred, archived, and label state through the local data source", async () => {
    const email = seed();

    expect((await runInbox(["inbox", "mark-read", email.id])).data).toMatchObject({ is_read: true });
    expect((await runInbox(["inbox", "star", email.id])).data).toMatchObject({ is_starred: true });
    expect((await runInbox(["inbox", "label", email.id, "urgent"])).data).toMatchObject({ label_ids: ["urgent"] });
    await runInbox(["inbox", "archive", email.id]);
    expect(getInboundEmail(email.id, getDatabase())).toMatchObject({
      is_read: true,
      is_starred: true,
      is_archived: true,
      label_ids: ["urgent"],
    });

    await runInbox(["inbox", "mark-read", email.id, "--unread"]);
    await runInbox(["inbox", "star", email.id, "--undo"]);
    await runInbox(["inbox", "archive", email.id, "--undo"]);
    await runInbox(["inbox", "label", email.id, "urgent", "--remove"]);
    expect(getInboundEmail(email.id, getDatabase())).toMatchObject({
      is_read: false,
      is_starred: false,
      is_archived: false,
      label_ids: [],
    });
  });

  it("reports total and per-recipient unread counts", async () => {
    seed({ to_addresses: ["first@example.com", "second@example.com"] });
    seed({ to_addresses: ["first@example.com"] });

    expect((await runInbox(["inbox", "unread-count"])).data).toEqual({ unread: 2 });
    expect((await runInbox(["inbox", "unread-count", "--by-address"])).data).toEqual([
      { address: "first@example.com", unread: 2 },
      { address: "second@example.com", unread: 1 },
    ]);
  });

  it("refuses invalid folders and missing messages with a nonzero exit", async () => {
    const folder = await runInboxExpectingExit(["inbox", "list", "--folder", "starrred"]);
    expect(folder.error).toBe("process.exit:1");
    expect(folder.stderr).toContain("Unknown folder");

    const missing = await runInboxExpectingExit(["inbox", "read", "missing"]);
    expect(missing.error).toBe("process.exit:1");
    expect(missing.stderr).toMatch(/could not resolve id|not found/i);
  });

  it("deletes and clears persisted local rows with explicit confirmation", async () => {
    const first = seed();
    seed();

    const deleted = await runInbox(["inbox", "delete", first.id, "--yes"]);
    expect(getInboundEmail(first.id, getDatabase())).toBeNull();
    expect(deleted.formatted).toContain("Deleted email");

    const cleared = await runInbox(["inbox", "clear", "--yes"]);
    expect(cleared.formatted).toContain("Cleared 1 email");
    expect((await runInbox(["inbox", "list"])).data).toEqual([]);
  });
});
