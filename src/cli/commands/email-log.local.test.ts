import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createEmail } from "../../db/emails.local.js";
import { storeSentEmailContent } from "../../lib/sent-ledger.local.js";
import { storeInboundEmail } from "../../db/inbound.local.js";
import { createProvider } from "../../db/providers.local.js";
import { createAddress, markVerified } from "../../db/addresses.local.js";
import { setConfigValue } from "../../lib/config.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  DATABASE_PATH_SETTINGS,
} from "../../store-resolution.js";
import { registerEmailLogCommands } from "./email-log.local.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}
function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

function setupDb() {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  const provider = createProvider({ name: "sandbox", type: "sandbox" }, db);
  const sent = createEmail(provider.id, {
    from: "agent@example.com",
    to: "person@example.com",
    subject: "Original subject",
    text: "Original body",
  }, "provider-message-id", db);
  return { db, provider, sent };
}

function seedReply(emailId: string, index: number) {
  return storeInboundEmail({
    provider_id: null,
    message_id: `<reply-${index}@example.com>`,
    in_reply_to_email_id: emailId,
    from_address: `reply${index}@example.com`,
    to_addresses: ["agent@example.com"],
    cc_addresses: [],
    subject: `Reply ${index}`,
    text_body: `Large reply body ${index} `.repeat(200),
    html_body: `<p>${"Large HTML ".repeat(100)}</p>`,
    attachments: [],
    attachment_paths: [],
    headers: { "x-test": `reply-${index}` },
    raw_size: 1024 + index,
    received_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }, getDatabase());
}

async function runEmailLogCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  let formatted = "";
  const consoleLines: string[] = [];
  const originalLog = console.log;
  registerEmailLogCommands(program, (payload, text) => {
    data = payload;
    formatted = text;
  });
  console.log = (...values: unknown[]) => {
    consoleLines.push(values.map(String).join(" "));
  };
  try {
    await program.parseAsync(["node", "emails", ...args]);
  } finally {
    console.log = originalLog;
  }
  return { data, formatted, consoleOutput: consoleLines.join("\n") };
}

beforeEach(() => {
  captureInheritedProcessEnv();
  setupDb();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  restoreInheritedProcessEnv();
});

describe("email log list and search commands", () => {
  it("paginates sent-email lists with offset and omits idempotency keys", async () => {
    const db = getDatabase();
    const provider = db.query("SELECT id FROM providers LIMIT 1").get() as { id: string };
    db.run("UPDATE emails SET sent_at = ?, created_at = ?, updated_at = ?", [
      new Date(Date.UTC(2025, 0, 1)).toISOString(),
      new Date(Date.UTC(2025, 0, 1)).toISOString(),
      new Date(Date.UTC(2025, 0, 1)).toISOString(),
    ]);
    for (let i = 0; i < 3; i++) {
      const email = createEmail(provider.id, {
        from: "agent@example.com",
        to: `person${i}@example.com`,
        subject: `Paged sent ${i}`,
        text: "body",
        idempotency_key: `list-secret-${i}`,
      }, undefined, db);
      db.run("UPDATE emails SET sent_at = ?, created_at = ?, updated_at = ? WHERE id = ?", [
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        email.id,
      ]);
    }

    const { data } = await runEmailLogCommand(["email", "list", "--limit", "2", "--offset", "1"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.subject)).toEqual(["Paged sent 1", "Paged sent 0"]);
    expect(rows[0]).not.toHaveProperty("idempotency_key");
    expect(JSON.stringify(rows)).not.toContain("list-secret");
  });

  it("paginates sent-email search after filtering and omits idempotency keys", async () => {
    const db = getDatabase();
    const provider = db.query("SELECT id FROM providers LIMIT 1").get() as { id: string };
    for (let i = 0; i < 4; i++) {
      const email = createEmail(provider.id, {
        from: "agent@example.com",
        to: `search${i}@example.com`,
        subject: `Searchable sent ${i}`,
        text: "body",
        idempotency_key: `search-secret-${i}`,
      }, undefined, db);
      db.run("UPDATE emails SET sent_at = ?, created_at = ?, updated_at = ? WHERE id = ?", [
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        email.id,
      ]);
    }

    const { data } = await runEmailLogCommand(["search", "Searchable", "--limit", "2", "--offset", "1"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.subject)).toEqual(["Searchable sent 2", "Searchable sent 1"]);
    expect(rows[0]).not.toHaveProperty("idempotency_key");
    expect(JSON.stringify(rows)).not.toContain("search-secret");
  });
});

describe("email show command", () => {
  it("renders stored HTML as readable text", async () => {
    const db = getDatabase();
    const sent = db.query("SELECT id FROM emails LIMIT 1").get() as { id: string };
    // SEEDED THROUGH THE SURVIVING WRITER. `storeEmailContent` on the email-content family is
    // now a typed refusal — the seam has no write that sets a body on an existing message — and
    // the local ledger write lives in `src/lib/sent-ledger.local.ts`, which is what the two
    // production senders call.
    await storeSentEmailContent(sent.id, { html: "<p>Hello <strong>there</strong> &amp; welcome</p>" }, db);

    const { consoleOutput } = await runEmailLogCommand(["show", sent.id]);

    expect(consoleOutput).toContain("Hello there & welcome");
    expect(consoleOutput).not.toContain("<strong>");
  });
});

describe("email log reply commands", () => {
  it("returns bounded summary replies without body or header payloads", async () => {
    const sent = getDatabase().query("SELECT id FROM emails LIMIT 1").get() as { id: string };
    seedReply(sent.id, 0);
    seedReply(sent.id, 1);
    seedReply(sent.id, 2);

    const { data, formatted } = await runEmailLogCommand(["email", "replies", sent.id, "--limit", "1", "--offset", "1"]);
    const result = data as {
      replies: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      offset: number;
      has_more: boolean;
    };

    expect(result.total).toBe(3);
    expect(result.limit).toBe(1);
    expect(result.offset).toBe(1);
    expect(result.has_more).toBe(true);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.subject).toBe("Reply 1");
    expect(result.replies[0]).not.toHaveProperty("text_body");
    expect(result.replies[0]).not.toHaveProperty("html_body");
    expect(result.replies[0]).not.toHaveProperty("headers");
    expect(formatted).toContain("1 of 3 replies");
    expect(formatted).toContain("more available");
  });

  it("keeps conversation body rendering paginated", async () => {
    const sent = getDatabase().query("SELECT id FROM emails LIMIT 1").get() as { id: string };
    seedReply(sent.id, 0);
    seedReply(sent.id, 1);

    const { data } = await runEmailLogCommand(["conversation", sent.id, "--limit", "1"]);
    const result = data as {
      replies: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      offset: number;
      has_more: boolean;
    };

    expect(result.total).toBe(2);
    expect(result.limit).toBe(1);
    expect(result.offset).toBe(0);
    expect(result.has_more).toBe(true);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.text_body).toContain("Large reply body 0");
  });

  it("shows sent-email thread fallback when no thread metadata exists", async () => {
    const sent = getDatabase().query("SELECT id FROM emails LIMIT 1").get() as { id: string };
    seedReply(sent.id, 0);

    const { data, consoleOutput } = await runEmailLogCommand(["email", "thread", sent.id]);
    const result = data as {
      email: Record<string, unknown>;
      replies: Array<Record<string, unknown>>;
      total: number;
    };

    expect(result.email.id).toBe(sent.id);
    expect(result.total).toBe(1);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.subject).toBe("Reply 0");
    expect(consoleOutput).toContain("Thread (2 messages)");
  });
});

describe("email test command", () => {
  it("reports ambiguous configured default provider prefixes", async () => {
    const db = getDatabase();
    const originalHome = process.env["HOME"];
    const tmpHome = mkdtempSync(join(tmpdir(), "emails-log-config-"));
    const originalError = console.error;
    const originalExit = process.exit;
    const errors: string[] = [];
    const errorSpy = mock((msg: unknown) => {
      errors.push(String(msg));
    });
    const exitSpy = mock((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    process.env["HOME"] = tmpHome;
    db.run(
      "INSERT INTO providers (id, name, type, active, created_at, updated_at) VALUES (?, ?, 'sandbox', 1, datetime('now'), datetime('now'))",
      ["abc11111-1111-1111-1111-111111111111", "ambiguous-1"],
    );
    db.run(
      "INSERT INTO providers (id, name, type, active, created_at, updated_at) VALUES (?, ?, 'sandbox', 1, datetime('now'), datetime('now'))",
      ["abc22222-2222-2222-2222-222222222222", "ambiguous-2"],
    );
    setConfigValue("default_provider", "abc");
    (console as unknown as { error: typeof errorSpy }).error = errorSpy;
    (process as unknown as { exit: typeof exitSpy }).exit = exitSpy;

    try {
      await expect(runEmailLogCommand(["test"])).rejects.toThrow("exit:1");
      expect(errors.join("\n")).toContain("Ambiguous ID 'abc' in table 'providers'");
    } finally {
      (console as unknown as { error: typeof originalError }).error = originalError;
      (process as unknown as { exit: typeof originalExit }).exit = originalExit;
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("chooses a default provider address without loading every address twice", async () => {
    const db = getDatabase();
    const provider = db.query("SELECT id FROM providers LIMIT 1").get() as { id: string };
    for (let i = 0; i < 120; i++) {
      createAddress({ provider_id: provider.id, email: `filler-${String(i).padStart(3, "0")}@example.com` }, db);
    }
    const preferred = createAddress({ provider_id: provider.id, email: "preferred@example.com" }, db);
    markVerified(preferred.id, db);

    const originalQuery = db.query;
    const queries: string[] = [];
    db.query = ((sql: string) => {
      queries.push(sql);
      return originalQuery.call(db, sql);
    }) as typeof db.query;

    try {
      const result = await runEmailLogCommand(["test", provider.id]);

      expect(result.consoleOutput).toContain("Test email sent to preferred@example.com");
      expect(result.consoleOutput).toContain("From: preferred@example.com");
    } finally {
      db.query = originalQuery;
    }

    expect(queries.some((sql) => sql.includes("ORDER BY verified DESC, created_at DESC"))).toBe(true);
    expect(queries.some((sql) => sql.includes("FROM addresses WHERE provider_id = ? ORDER BY created_at DESC"))).toBe(false);
  });
});

describe("webhook listen command", () => {
  // THE REFUSAL HAS TO REACH THE OPERATOR, not just the function. `emails webhook listen` is the
  // path an operator actually takes, and this command's own arm imported the DELETED
  // `src/lib/webhook.local.ts` directly — bypassing the facade — so the consumer swap is exercised
  // here rather than assumed. Asserted through the CLI's own error channel.
  //
  // NO CASE STARTS A LISTENER THAT IS NEVER STOPPED. The command discards the server it creates, so
  // a successful start would hold the port and the event loop for the rest of the file. The passing
  // side of the gate is proved by occupying the port first: reaching an "address in use" failure
  // proves the gate was passed, because that error is raised by the bind the gate precedes.

  async function runExpectingError(args: string[]): Promise<string> {
    const program = new Command();
    program.exitOverride();
    const errors: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    const originalExit = process.exit;
    console.error = ((...a: unknown[]) => { errors.push(a.map(String).join(" ")); }) as typeof console.error;
    console.log = (() => {}) as typeof console.log;
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as typeof process.exit;
    registerEmailLogCommands(program, () => {});
    try {
      await program.parseAsync(["node", "emails", ...args]);
    } catch {
      // handleError exits through the stubbed process.exit (or commander throws).
    } finally {
      console.error = originalError;
      console.log = originalLog;
      process.exit = originalExit;
    }
    return errors.join("\n");
  }

  it("REFUSES at the command level when the mail lives behind the API, naming the setting", async () => {
    // SETTINGS NAMED FROM THE RESOLVER'S CONSTANTS, not as literals, and ITERATED rather than
    // spelled one at a time. `DATABASE_PATH_SETTINGS` has TWO entries and an earlier version of
    // this case deleted only the second by name — it passed solely because the hermetic runner
    // happens to unset the first, which is a dependency on the runner rather than on this file.
    for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
    process.env[API_BASE_URL_SETTING] = "https://mail.example.test";
    process.env[API_CREDENTIAL_SETTINGS[1]] = "not-a-real-credential";
    const errors = await runExpectingError(["webhook", "listen", "--port", "0"]);
    expect(errors).toContain("durable provider webhook receiver runs where the mail is stored");
    expect(errors).toContain(API_BASE_URL_SETTING);
  });

  it("gets PAST the gate on a local database, failing on the port instead of on storage", async () => {
    const occupied = Bun.serve({ port: 0, fetch: () => new Response("busy") });
    try {
      const errors = await runExpectingError(["webhook", "listen", "--port", String(occupied.port)]);
      // The gate passed: the failure is about the address, not about where the mail is.
      expect(errors).not.toContain("durable provider webhook receiver runs where the mail is stored");
      expect(errors.length, "the command neither refused nor failed to bind").toBeGreaterThan(0);
      expect(errors).toMatch(/in use|EADDRINUSE|Failed to start/i);
    } finally {
      occupied.stop(true);
    }
  });
});
