// `emails send` must not mail a suppressed recipient.
//
// The suppression check printed "Warning: Suppressed recipients: …" followed by
// "Use --force to send anyway." and then FELL THROUGH — no `return`, no
// filtering, no exit. So the recipient was mailed whether or not `--force` was
// passed, and in local mode nothing further down the chain stops it. `--force`
// was inverted: the flag that was supposed to be required to send anyway made no
// difference at all.
//
// Self-hosted is covered against the out-of-process /v1 stub; local is covered
// against an in-memory SQLite DB with a sandbox provider, because local mode is
// where there is no second gate.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { suppressContact } from "../../db/contacts.local.js";
import { createProvider } from "../../db/providers.local.js";
import { listSandboxEmails } from "../../db/sandbox.local.js";
import { resetMailDataSource } from "../../lib/mail-data-source.js";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerSendCommands } from "./send.js";

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

interface RunResult {
  consoleOutput: string;
  errorOutput: string;
  exited: boolean;
}

/** Drive the real command in-process, capturing stdout, stderr and process.exit. */
async function runSend(args: string[]): Promise<RunResult> {
  const program = new Command();
  program.exitOverride();
  registerSendCommands(program, () => {});

  const consoleLines: string[] = [];
  const errorLines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  console.log = (...values: unknown[]) => { consoleLines.push(values.map(String).join(" ")); };
  (console as unknown as { error: (...v: unknown[]) => void }).error = (...values: unknown[]) => {
    errorLines.push(values.map(String).join(" "));
  };
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as never;

  let exited = false;
  try {
    await program.parseAsync(["node", "emails", ...args]);
  } catch (error) {
    if (!(error instanceof Error) || !/process\.exit/.test(error.message)) throw error;
    exited = true;
  } finally {
    console.log = originalLog;
    (console as unknown as { error: typeof originalError }).error = originalError;
    (process as unknown as { exit: typeof originalExit }).exit = originalExit;
  }

  return { consoleOutput: consoleLines.join("\n"), errorOutput: errorLines.join("\n"), exited };
}

// ---- self-hosted -------------------------------------------------------------

describe("emails send — suppressed recipients (self-hosted)", () => {
  let stub: V1Stub;

  beforeAll(async () => { stub = await startV1Stub(); });
  afterAll(() => stub.stop());

  beforeEach(async () => {
    captureInheritedProcessEnv();
    await stub.seed({ contacts: [{ id: "c1", email: "blocked@ext.com", name: null, suppressed: true, send_count: 0 }] });
    stub.applyEnv();
    resetMailDataSource();
  });

  afterEach(() => {
    stub.clearEnv();
    resetMailDataSource();
    restoreInheritedProcessEnv();
  });

  it("refuses the send instead of mailing a suppressed recipient", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to", "blocked@ext.com", "--subject", "Hi", "--body", "x",
    ]);

    expect(result.exited).toBe(true);
    expect(result.errorOutput).toContain("Refusing to send to suppressed recipient(s): blocked@ext.com");
    expect(result.errorOutput).toContain("emails contact unsuppress");
    // The defect was the mail going out regardless. Nothing may be recorded.
    expect(await stub.list("messages")).toHaveLength(0);
  });

  it("refuses a suppressed recipient hidden in --cc or --bcc", async () => {
    for (const flag of ["--cc", "--bcc"]) {
      const result = await runSend([
        "send", "--from", "agent@acme.com", "--to", "ok@ext.com", flag, "blocked@ext.com",
        "--subject", "Hi", "--body", "x",
      ]);

      expect(result.exited).toBe(true);
      expect(result.errorOutput).toContain("blocked@ext.com");
      expect(await stub.list("messages")).toHaveLength(0);
    }
  });

  it("tells the operator that --force cannot override the server, and sends nothing", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to", "blocked@ext.com", "--subject", "Hi", "--body", "x", "--force",
    ]);

    expect(result.exited).toBe(true);
    expect(result.errorOutput).toContain("--force cannot override suppression in self-hosted mode");
    expect(result.errorOutput).toContain("409 recipient_suppressed");
    expect(await stub.list("messages")).toHaveLength(0);
  });

  it("reports but does not refuse during a dry run", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to", "blocked@ext.com", "--subject", "Hi", "--body", "x", "--dry-run",
    ]);

    expect(result.exited).toBe(false);
    expect(result.consoleOutput).toContain("Suppressed recipients: blocked@ext.com");
    expect(result.consoleOutput).toContain("A real send would be refused");
    expect(result.consoleOutput).toContain("[NOT SENT]");
    expect(await stub.list("messages")).toHaveLength(0);
  });

  it("still sends to a recipient that is not suppressed", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to", "fine@ext.com", "--subject", "Hi", "--body", "x",
    ]);

    expect(result.exited).toBe(false);
    expect(result.consoleOutput).toContain("Email sent to fine@ext.com");
    expect(await stub.list("messages")).toHaveLength(1);
  });
});

// ---- local -------------------------------------------------------------------

describe("emails send — suppressed recipients (local)", () => {
  let providerId: string;

  beforeEach(() => {
    captureInheritedProcessEnv();
    process.env["EMAILS_MODE"] = "local";
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
    resetMailDataSource();
    providerId = createProvider({ name: "sandbox", type: "sandbox", active: true }).id;
    suppressContact("blocked@ext.com");
  });

  afterEach(() => {
    closeDatabase();
    resetMailDataSource();
    delete process.env["EMAILS_MODE"];
    delete process.env["EMAILS_DB_PATH"];
    restoreInheritedProcessEnv();
  });

  it("refuses the send instead of mailing a suppressed recipient", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to", "blocked@ext.com", "--subject", "Hi", "--body", "x",
      "--provider", providerId,
    ]);

    expect(result.exited).toBe(true);
    expect(result.errorOutput).toContain("Refusing to send to suppressed recipient(s): blocked@ext.com");
    // Local mode has no second gate, so this assertion is the whole finding.
    expect(listSandboxEmails(providerId, 10)).toHaveLength(0);
  });

  it("honours --force, which is what the flag always claimed to do", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to", "blocked@ext.com", "--subject", "Hi", "--body", "x",
      "--provider", providerId, "--force",
    ]);

    expect(result.exited).toBe(false);
    expect(result.consoleOutput).toContain("--force: sending to the suppressed recipient(s) anyway.");
    expect(listSandboxEmails(providerId, 10)).toHaveLength(1);
  });

  it("still sends to a recipient that is not suppressed, without --force", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to", "fine@ext.com", "--subject", "Hi", "--body", "x",
      "--provider", providerId,
    ]);

    expect(result.exited).toBe(false);
    expect(listSandboxEmails(providerId, 10)).toHaveLength(1);
  });
});

// ---- the recipient string must not be a way around the gate ----------------

describe("suppression matches the recipient canonically, not by exact string", () => {
  let providerId: string;

  beforeEach(() => {
    captureInheritedProcessEnv();
    process.env["EMAILS_MODE"] = "local";
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
    resetMailDataSource();
    providerId = createProvider({ name: "sandbox", type: "sandbox", active: true }).id;
  });

  afterEach(() => {
    closeDatabase();
    resetMailDataSource();
    delete process.env["EMAILS_MODE"];
    delete process.env["EMAILS_DB_PATH"];
    restoreInheritedProcessEnv();
  });

  // `contacts.email` has no COLLATE NOCASE and nothing canonicalized either
  // side, so an exact string comparison let a differently-spelled recipient
  // through — while the self-hosted server, which canonicalizes both sides,
  // refused the same send. Local enforcement must not be the weaker one.
  const spellings = [
    "Blocked@ext.com",
    "BLOCKED@EXT.COM",
    "  blocked@ext.com  ",
    "Blocked Person <blocked@ext.com>",
    "<blocked@ext.com>",
  ];

  it("refuses every spelling of a suppressed recipient", async () => {
    suppressContact("blocked@ext.com");

    for (const spelling of spellings) {
      const result = await runSend([
        "send", "--from", "agent@acme.com", "--to", spelling, "--subject", "Hi", "--body", "x",
        "--provider", providerId,
      ]);

      expect(result.exited).toBe(true);
      expect(result.errorOutput).toContain("Refusing to send to suppressed recipient(s)");
      expect(listSandboxEmails(providerId, 10)).toHaveLength(0);
    }
  });

  it("refuses when the stored contact is the differently-spelled one", async () => {
    // The operator suppressed a mixed-case address; a lowercase send must still
    // be refused, or `emails contact suppress` silently did nothing.
    suppressContact("Blocked@Ext.com");

    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to", "blocked@ext.com", "--subject", "Hi", "--body", "x",
      "--provider", providerId,
    ]);

    expect(result.exited).toBe(true);
    expect(listSandboxEmails(providerId, 10)).toHaveLength(0);
  });

  it("does not over-match a different address that merely looks similar", async () => {
    suppressContact("blocked@ext.com");

    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to", "notblocked@ext.com", "--subject", "Hi", "--body", "x",
      "--provider", providerId,
    ]);

    expect(result.exited).toBe(false);
    expect(listSandboxEmails(providerId, 10)).toHaveLength(1);
  });
});

// ---- the other local send surfaces that reach ds.send ----------------------

describe("reply, forward, and the MCP send tool refuse suppressed recipients too", () => {
  let providerId: string;

  beforeEach(() => {
    captureInheritedProcessEnv();
    process.env["EMAILS_MODE"] = "local";
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
    resetMailDataSource();
    providerId = createProvider({ name: "sandbox", type: "sandbox", active: true }).id;
    suppressContact("blocked@ext.com");
  });

  afterEach(() => {
    closeDatabase();
    resetMailDataSource();
    delete process.env["EMAILS_MODE"];
    delete process.env["EMAILS_DB_PATH"];
    restoreInheritedProcessEnv();
  });

  async function seedInbound(): Promise<string> {
    const { storeInboundEmail } = await import("../../db/inbound.local.js");
    const stored = storeInboundEmail({
      provider_id: null,
      message_id: "<parent@ext.com>",
      in_reply_to_email_id: null,
      from_address: "blocked@ext.com",
      to_addresses: ["agent@acme.com"],
      cc_addresses: [],
      subject: "Original",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: new Date().toISOString(),
    });
    return stored.id;
  }

  async function runReplyCommand(args: string[]): Promise<RunResult> {
    const { registerReplyCommand } = await import("./reply.js");
    const program = new Command();
    program.exitOverride();
    registerReplyCommand(program, () => {});
    const consoleLines: string[] = [];
    const errorLines: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalExit = process.exit;
    console.log = (...v: unknown[]) => { consoleLines.push(v.map(String).join(" ")); };
    (console as unknown as { error: (...v: unknown[]) => void }).error = (...v: unknown[]) => { errorLines.push(v.map(String).join(" ")); };
    (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never;
    let exited = false;
    try {
      await program.parseAsync(["node", "emails", ...args]);
    } catch (error) {
      if (!(error instanceof Error) || !/process\.exit/.test(error.message)) throw error;
      exited = true;
    } finally {
      console.log = originalLog;
      (console as unknown as { error: typeof originalError }).error = originalError;
      (process as unknown as { exit: typeof originalExit }).exit = originalExit;
    }
    return { consoleOutput: consoleLines.join("\n"), errorOutput: errorLines.join("\n"), exited };
  }

  it("emails forward refuses a suppressed recipient", async () => {
    const id = await seedInbound();

    const result = await runReplyCommand(["forward", id, "--to", "Blocked@ext.com", "--from", "agent@acme.com"]);

    expect(result.exited).toBe(true);
    expect(result.errorOutput).toContain("Refusing to forward to suppressed recipient(s)");
    expect(listSandboxEmails(providerId, 10)).toHaveLength(0);
  });

  it("emails reply refuses a suppressed recipient it derived itself", async () => {
    const id = await seedInbound();

    // The operator never types the address: reply derives it from the parent.
    const result = await runReplyCommand(["reply", id, "--body", "hi", "--from", "agent@acme.com"]);

    expect(result.exited).toBe(true);
    expect(result.errorOutput).toContain("Refusing to reply to suppressed recipient(s)");
    expect(listSandboxEmails(providerId, 10)).toHaveLength(0);
  });

  it("the MCP send_email tool refuses a suppressed recipient, with no force escape", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    // The facade, not an arm module: the family collapsed to one implementation,
    // and this suppression gate is now the same gate in every configuration.
    const { registerEmailOpsTools } = await import("../../mcp/tools/email-ops.js");
    const server = new McpServer({ name: "t", version: "1.0.0" });
    registerEmailOpsTools(server);
    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>; inputSchema?: unknown }> })
      ._registeredTools["send_email"]!;

    const result = await tool.handler({
      from: "agent@acme.com",
      to: "Blocked Person <blocked@ext.com>",
      subject: "Hi",
      text: "x",
      provider_id: providerId,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("suppressed recipient(s)");
    expect(listSandboxEmails(providerId, 10)).toHaveLength(0);
    // No `force` parameter exists on this tool — an agent cannot opt out.
    expect(JSON.stringify(tool.inputSchema ?? {})).not.toContain("force");
  });
});

// ---- the shape this is copied from ------------------------------------------

describe("emails batch keeps its (already correct) skip-unless-force shape", () => {
  it("skips a suppressed row and counts it, rather than mailing it", async () => {
    process.env["EMAILS_MODE"] = "local";
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
    try {
      const { batchSend } = await import("../../lib/batch.js");
      const { createTemplate } = await import("../../db/templates.local.js");
      const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });
      createTemplate({ name: "tpl", subject_template: "S {{email}}", text_template: "B" });
      suppressContact("blocked@ext.com");

      const sent: string[] = [];
      const result = await batchSend({
        csvPath: "unused.csv",
        templateName: "tpl",
        from: "agent@acme.com",
        provider,
        _csvContent: "email\nblocked@ext.com\nfine@ext.com\n",
        _adapter: { sendEmail: async (opts) => { sent.push((opts as { to: string }).to); return "id"; } },
      });

      expect(result.suppressed).toBe(1);
      expect(sent).toEqual(["fine@ext.com"]);
    } finally {
      closeDatabase();
      delete process.env["EMAILS_MODE"];
      delete process.env["EMAILS_DB_PATH"];
    }
  });
});
