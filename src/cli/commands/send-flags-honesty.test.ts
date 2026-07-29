// `emails send` declared --unsubscribe-url, --track-opens, --track-clicks and
// --tracking-url, parsed all four, and read NONE of them: the mail left without
// RFC 8058 List-Unsubscribe headers and without tracking, then printed a green
// checkmark and exited 0. A parsed-and-ignored option is a false capability.
//
// What honesty requires here:
//   * --unsubscribe-url is a REAL capability of the local provider adapters
//     (they inject List-Unsubscribe / List-Unsubscribe-Post) — so it must be
//     THREADED through the send seam, and REFUSED where the send API cannot
//     carry it (POST /v1/messages/send has no unsubscribe_url field).
//   * the tracking flags have no working send-path implementation in this build,
//     so they must be a typed refusal — never a silent drop with exit 0.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.local.js";
import { listSandboxEmails } from "../../db/sandbox.js";
import { resetMailDataSource } from "../../lib/mail-data-source.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../../store-resolution.js";
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

// ---- local: --unsubscribe-url threads to the provider ------------------------

describe("emails send --unsubscribe-url (local)", () => {
  let providerId: string;

  beforeEach(() => {
    captureInheritedProcessEnv();
    for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
      delete process.env[setting];
    }
    for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
    resetMailDataSource();
    providerId = createProvider({ name: "sandbox", type: "sandbox", active: true }).id;
  });

  afterEach(() => {
    closeDatabase();
    resetMailDataSource();
    restoreInheritedProcessEnv();
  });

  it("delivers the RFC 8058 one-click headers with the message", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to", "dest@ext.com", "--subject", "Hi", "--body", "x",
      "--provider", providerId, "--unsubscribe-url", "https://acme.com/unsub",
    ]);

    expect(result.exited).toBe(false);
    expect(result.consoleOutput).toContain("Email sent to dest@ext.com");

    const captured = await listSandboxEmails(providerId, 10, 0);
    expect(captured).toHaveLength(1);
    // The sandbox provider captures the effective wire headers. Silent dropping
    // of the flag left this map EMPTY while the operator relied on one-click
    // unsubscribe for bulk-mail compliance.
    expect(captured[0]!.headers["List-Unsubscribe"]).toBe("<https://acme.com/unsub>");
    expect(captured[0]!.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("sends without the headers when the flag is not passed", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to", "dest@ext.com", "--subject", "Hi", "--body", "x",
      "--provider", providerId,
    ]);

    expect(result.exited).toBe(false);
    const captured = await listSandboxEmails(providerId, 10, 0);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.headers["List-Unsubscribe"]).toBeUndefined();
  });
});

// ---- against the serve API: --unsubscribe-url is refused, not dropped --------

describe("emails send --unsubscribe-url (serve API)", () => {
  let stub: V1Stub;

  beforeAll(async () => { stub = await startV1Stub(); });
  afterAll(() => stub.stop());

  beforeEach(async () => {
    captureInheritedProcessEnv();
    await stub.reset();
    stub.applyEnv();
    resetMailDataSource();
  });

  afterEach(() => {
    stub.clearEnv();
    resetMailDataSource();
    restoreInheritedProcessEnv();
  });

  it("refuses the send instead of silently mailing without the headers", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to", "dest@ext.com", "--subject", "Hi", "--body", "x",
      "--unsubscribe-url", "https://acme.com/unsub",
    ]);

    expect(result.exited).toBe(true);
    expect(result.errorOutput).toContain("--unsubscribe-url");
    expect(result.errorOutput).toContain("not supported");
    // Nothing left: a refusal that mails anyway is worse than the silent drop.
    expect(await stub.list("messages")).toHaveLength(0);
  });
});

// ---- tracking flags: a typed refusal, never a silent drop --------------------

describe("emails send tracking flags refuse rather than silently dropping", () => {
  let providerId: string;

  beforeEach(() => {
    captureInheritedProcessEnv();
    for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
      delete process.env[setting];
    }
    for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
    resetMailDataSource();
    providerId = createProvider({ name: "sandbox", type: "sandbox", active: true }).id;
  });

  afterEach(() => {
    closeDatabase();
    resetMailDataSource();
    restoreInheritedProcessEnv();
  });

  const cases: Array<{ flag: string; args: string[] }> = [
    { flag: "--track-opens", args: ["--track-opens"] },
    { flag: "--track-clicks", args: ["--track-clicks"] },
    { flag: "--tracking-url", args: ["--tracking-url", "https://track.acme.com"] },
  ];

  for (const { flag, args } of cases) {
    it(`refuses ${flag} and sends nothing`, async () => {
      const result = await runSend([
        "send", "--from", "agent@acme.com", "--to", "dest@ext.com", "--subject", "Hi", "--body", "x",
        "--provider", providerId, ...args,
      ]);

      expect(result.exited).toBe(true);
      expect(result.errorOutput).toContain(flag);
      expect(result.errorOutput).toContain("not supported in this build");
      // The refusal must precede the send: no message may leave.
      expect(await listSandboxEmails(providerId, 10, 0)).toHaveLength(0);
    });
  }
});
