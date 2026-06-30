import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase } from "../../db/database.js";
import { storeInboundEmail } from "../../db/inbound.js";
import { getConfigValue } from "../../lib/config.js";
import { registerCloudCommands } from "./cloud.js";

let originalHome: string | undefined;
let originalDbPath: string | undefined;
let tmpHome: string;

function makeProgram(logs: string[], data: { value?: unknown }, deps: Parameters<typeof registerCloudCommands>[2]) {
  const program = new Command();
  program.exitOverride();
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  };
  registerCloudCommands(program, (payload, formatted) => {
    data.value = payload;
    if (formatted) logs.push(String(formatted));
  }, deps);
  return program;
}

async function runCloudCommand(args: string[], deps: Parameters<typeof registerCloudCommands>[2]) {
  const logs: string[] = [];
  const data: { value?: unknown } = {};
  const originalLog = console.log;
  try {
    const program = makeProgram(logs, data, deps);
    await program.parseAsync(["node", "mailery", ...args]);
    return { out: logs.join("\n"), data: data.value };
  } finally {
    console.log = originalLog;
  }
}

beforeEach(() => {
  originalHome = process.env["HOME"];
  originalDbPath = process.env["EMAILS_DB_PATH"];
  tmpHome = mkdtempSync(join(tmpdir(), "mailery-cloud-command-"));
  process.env["HOME"] = tmpHome;
  process.env["EMAILS_DB_PATH"] = join(tmpHome, "mailery.db");
  closeDatabase();
});

afterEach(() => {
  closeDatabase();
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalDbPath === undefined) delete process.env["EMAILS_DB_PATH"];
  else process.env["EMAILS_DB_PATH"] = originalDbPath;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("cloud command", () => {
  it("logs in with an API key without printing it", async () => {
    const result = await runCloudCommand([
      "cloud",
      "--api-url",
      "https://mailery.test",
      "login",
      "--api-key",
      "mly_secret_test",
    ], {
      createClient: (opts) => ({
        me: async () => ({
          user: null,
          tenant: { id: "ten_1", name: "Test Tenant", slug: "test", plan: "starter", stripeCustomerId: null, createdAt: "", updatedAt: "" },
          auth: { via: "api_key", scopes: ["full"] },
        }),
        health: async () => ({ version: "x", service: "mailery-cloud" }),
        signup: async () => ({ token: "" }),
        login: async () => ({ token: "" }),
        logout: async () => ({ ok: true }),
        billingOverview: async () => ({ balance: 0, plans: {}, credit_packs: {}, subscriptions: [], ledger: [] }),
        createCheckout: async () => ({ url: "" }),
        createPortal: async () => ({ url: "" }),
        listMailboxes: async () => [],
        createMailbox: async () => { throw new Error("unused"); },
        messageGroups: async () => ({}),
        listMessages: async () => [],
        createMessage: async () => { throw new Error("unused"); },
        getMessage: async () => { throw new Error("unused"); },
        parseMessage: async () => ({}),
        listDigests: async () => [],
        generateDigest: async () => { throw new Error("unused"); },
        checkDomainAvailability: async () => { throw new Error("unused"); },
        setupDomain: async () => { throw new Error("unused"); },
        getApiUrl: () => opts.apiUrl ?? "",
        setToken: () => {},
        request: async () => ({} as never),
      }),
    });

    expect(result.out).toContain("Test Tenant");
    expect(result.out).not.toContain("mly_secret_test");
    expect(getConfigValue("cloud_api_url")).toBe("https://mailery.test");
    expect(getConfigValue("cloud_api_key")).toBe("mly_secret_test");
  });

  it("does not emit password-login session tokens in command payloads", async () => {
    const result = await runCloudCommand(["cloud", "login", "--email", "agent@example.com", "--password", "pw"], {
      createClient: () => ({
        login: async () => ({ token: "session_secret_value" }),
        me: async () => ({
          user: { id: "usr_1", email: "agent@example.com", name: null, tenantId: "ten_1", role: "owner", isPlatformAdmin: false },
          tenant: { id: "ten_1", name: "Agent Tenant", slug: "agent", plan: "starter", stripeCustomerId: null, createdAt: "", updatedAt: "" },
          auth: { via: "session", scopes: ["full"] },
        }),
      } as never),
    });

    expect(JSON.stringify(result.data)).not.toContain("session_secret_value");
    expect(result.out).not.toContain("session_secret_value");
    expect(getConfigValue("cloud_session_token")).toBe("session_secret_value");
  });

  it("uses configured cloud_api_url when --api-url is omitted", async () => {
    await runCloudCommand(["cloud", "use", "https://staging.mailery.test"], {});
    let seenApiUrl = "";
    const result = await runCloudCommand(["cloud", "status"], {
      createClient: (opts) => {
        seenApiUrl = opts.apiUrl ?? "";
        return {
          health: async () => ({ version: "1", service: "mailery-cloud" }),
        } as never;
      },
    });

    expect(seenApiUrl).toBe("https://staging.mailery.test");
    expect(result.out).toContain("https://staging.mailery.test");
  });

  it("creates a subscription checkout link and can suppress browser opening", async () => {
    const result = await runCloudCommand(["cloud", "billing", "subscribe", "--plan", "starter", "--no-open"], {
      createClient: () => ({
        createCheckout: async (input) => {
          expect(input).toEqual({ kind: "subscription", plan: "starter" });
          return { url: "https://checkout.stripe.test/session" };
        },
      } as never),
    });

    expect(result.out).toContain("https://checkout.stripe.test/session");
    expect(result.out).toContain("Browser open disabled");
  });

  it("uploads local inbox messages to a cloud mailbox", async () => {
    const stored = storeInboundEmail({
      provider_id: null,
      message_id: "local-1",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["agent@example.com"],
      cc_addresses: [],
      subject: "Local message",
      text_body: "hello",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 5,
      received_at: "2026-06-30T10:00:00.000Z",
    });
    const uploads: unknown[] = [];

    const result = await runCloudCommand(["cloud", "messages", "upload-local", "--mailbox-id", "mbx_1", "--limit", "1"], {
      createClient: () => ({
        createMessage: async (input) => {
          uploads.push(input);
          return {
            id: "msg_1",
            tenantId: "ten_1",
            mailboxId: input.mailboxId,
            direction: "inbound",
            status: "synced",
            subject: input.subject ?? "",
            fromAddress: input.fromAddress ?? "",
            toAddresses: input.toAddresses ?? [],
            ccAddresses: [],
            receivedAt: input.receivedAt ?? null,
            sentAt: null,
            textBody: input.textBody ?? null,
            htmlBody: null,
            cleanMarkdown: null,
            summary: null,
            parserModel: null,
            classification: {},
            importanceScore: 0,
            isRead: false,
            isImportant: false,
            isSpam: false,
            isTrash: false,
            isArchived: false,
            createdAt: "2026-06-30T10:00:00.000Z",
            updatedAt: "2026-06-30T10:00:00.000Z",
            attachments: [],
          };
        },
      } as never),
    });

    expect(stored.subject).toBe("Local message");
    expect(uploads).toEqual([expect.objectContaining({
      mailboxId: "mbx_1",
      subject: "Local message",
      fromAddress: "sender@example.com",
      toAddresses: ["agent@example.com"],
      externalId: "local-1",
    })]);
    expect(result.out).toContain("Uploaded 1 local message");
  });

  it("preserves read, archive, spam, trash, and folder state when pulling cloud messages", async () => {
    await runCloudCommand(["cloud", "messages", "pull", "--limit", "1"], {
      createClient: () => ({
        listMessages: async () => [{
          id: "cloud_msg_1",
          tenantId: "ten_1",
          mailboxId: "mbx_cloud",
          direction: "inbound",
          status: "stored",
          subject: "Cloud trash",
          fromAddress: "sender@example.com",
          toAddresses: ["agent@example.com"],
          ccAddresses: [],
          receivedAt: "2026-06-30T10:00:00.000Z",
          sentAt: null,
          textBody: "cloud body",
          htmlBody: null,
          cleanMarkdown: null,
          summary: null,
          parserModel: null,
          classification: {},
          importanceScore: 0,
          isRead: true,
          isImportant: true,
          isSpam: false,
          isTrash: true,
          isArchived: true,
          createdAt: "2026-06-30T10:00:00.000Z",
          updatedAt: "2026-06-30T10:00:00.000Z",
        }],
        getMessage: async () => ({
          id: "cloud_msg_1",
          tenantId: "ten_1",
          mailboxId: "mbx_cloud",
          direction: "inbound",
          status: "stored",
          subject: "Cloud trash",
          fromAddress: "sender@example.com",
          toAddresses: ["agent@example.com"],
          ccAddresses: [],
          receivedAt: "2026-06-30T10:00:00.000Z",
          sentAt: null,
          textBody: "cloud body",
          htmlBody: null,
          cleanMarkdown: null,
          summary: null,
          parserModel: null,
          classification: {},
          importanceScore: 0,
          isRead: true,
          isImportant: true,
          isSpam: false,
          isTrash: true,
          isArchived: true,
          createdAt: "2026-06-30T10:00:00.000Z",
          updatedAt: "2026-06-30T10:00:00.000Z",
          attachments: [],
        }),
      } as never),
    });

    const db = getDatabase();
    const inbound = db.query(
      "SELECT is_read, is_archived, is_starred, is_spam, is_trash FROM inbound_emails WHERE message_id = ?",
    ).get("cloud:cloud_msg_1") as { is_read: number; is_archived: number; is_starred: number; is_spam: number; is_trash: number };
    const state = db.query(
      "SELECT is_read, is_archived, is_starred, is_spam, is_trash, folder_id FROM mailbox_message_state LIMIT 1",
    ).get() as { is_read: number; is_archived: number; is_starred: number; is_spam: number; is_trash: number; folder_id: string };

    expect(inbound).toEqual({ is_read: 1, is_archived: 1, is_starred: 1, is_spam: 0, is_trash: 1 });
    expect(state).toEqual({
      is_read: 1,
      is_archived: 1,
      is_starred: 1,
      is_spam: 0,
      is_trash: 1,
      folder_id: "folder:mbx:agent@example.com:trash",
    });
  });
});
