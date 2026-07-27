// `emails send --to-group <name>` must expand the group, in BOTH configurations.
//
// THE DEFECT. The flag was advertised in `--help` ("Send to all members of a
// recipient group") and its action was an unconditional throw:
//
//   --to-group is not available in the self-hosted client without a self-hosted
//   group-members send API. Pass explicit --to recipients.
//
// Wrong twice. It fired in LOCAL mode, where nothing about a "self-hosted
// client" applies; and no send API is needed at all — group fan-out is a
// CLIENT-side recipient lookup that ends in the same `to:` field an explicit
// `--to` fills. `src/db/groups.ts` is a routed facade whose reads resolve to
// local SQLite or `/v1/groups` + `/v1/group-members`, and the sibling command
// `emails group members <name>` has been printing exactly this list in both
// configurations the whole time.
//
// Both arms are covered because the refusal named self-hosted while breaking
// local: a test in one mode alone would leave the other half unproven.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { resetSelfHostedConfigCache } from "../../db/self-hosted-store.js";
import { addMember, createGroup } from "../../db/groups.js";
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

// ---- local -------------------------------------------------------------------

describe("emails send --to-group (local)", () => {
  let providerId: string;

  beforeEach(() => {
    captureInheritedProcessEnv();
    // Local is the DEFAULT resolution (src/lib/mode.ts), and the hermetic runner
    // selects it explicitly, so this arm only has to make sure no self-hosted
    // selector is left over from a sibling suite. Naming the mode variable here
    // would add to a tree-wide count that the mode-axis ratchet holds at a
    // ceiling, and this file has no business raising it.
    for (const key of [
      "EMAILS_SELF_HOSTED_URL",
      "EMAILS_SELF_HOSTED_API_KEY",
      "EMAILS_SESSION_TOKEN",
      "EMAILS_CLIENT_ENV_SECRET",
    ]) delete process.env[key];
    resetSelfHostedConfigCache();
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
    resetMailDataSource();
    providerId = createProvider({ name: "sandbox", type: "sandbox", active: true }).id;
    const group = createGroup("team");
    addMember(group.id, "one@ext.com", "One");
    addMember(group.id, "two@ext.com", "Two");
  });

  afterEach(() => {
    closeDatabase();
    resetMailDataSource();
    resetSelfHostedConfigCache();
    delete process.env["EMAILS_DB_PATH"];
    restoreInheritedProcessEnv();
  });

  it("sends to every member instead of refusing", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to-group", "team", "--subject", "Hi", "--body", "x",
      "--provider", providerId,
    ]);

    expect(result.exited).toBe(false);
    expect(result.consoleOutput).toContain("Email sent to one@ext.com, two@ext.com");
    // The refusal that shipped, in the mode it was most obviously wrong about.
    expect(result.errorOutput).not.toContain("not available in the self-hosted client");
    const sent = listSandboxEmails(providerId, 10);
    expect(sent).toHaveLength(1);
    // One message carrying BOTH members, which is what `--to a@x b@y` produces
    // — no invented per-recipient fan-out.
    expect(sent[0]?.to_addresses.join(", ")).toBe("one@ext.com, two@ext.com");
  });

  it("names the group and its size in a dry run, and sends nothing", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to-group", "team", "--subject", "Hi", "--body", "x",
      "--provider", providerId, "--dry-run",
    ]);

    expect(result.exited).toBe(false);
    expect(result.consoleOutput).toContain("Would send (local)");
    expect(result.consoleOutput).toContain("Group:   team — 2 member(s), all in one To: header");
    expect(listSandboxEmails(providerId, 10)).toHaveLength(0);
  });

  it("collapses a member listed twice under different casing", async () => {
    const group = createGroup("dupes");
    addMember(group.id, "Same@ext.com");
    addMember(group.id, "same@ext.com");

    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to-group", "dupes", "--subject", "Hi", "--body", "x",
      "--provider", providerId,
    ]);

    expect(result.exited).toBe(false);
    // One recipient, not two — otherwise the delivered To: header repeats it.
    expect(result.consoleOutput).toMatch(/Email sent to [Ss]ame@ext\.com$/m);
  });

  it("refuses an unknown group by naming the group, never a mode", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to-group", "nope", "--subject", "Hi", "--body", "x",
      "--provider", providerId,
    ]);

    expect(result.exited).toBe(true);
    expect(result.errorOutput).toContain("Group not found: nope");
    expect(result.errorOutput).toContain("emails group list");
    expect(result.errorOutput).not.toContain("self-hosted");
    expect(listSandboxEmails(providerId, 10)).toHaveLength(0);
  });

  it("refuses an empty group and names the command that fills it", async () => {
    createGroup("empty");
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to-group", "empty", "--subject", "Hi", "--body", "x",
      "--provider", providerId,
    ]);

    expect(result.exited).toBe(true);
    expect(result.errorOutput).toContain("Group 'empty' has no members");
    expect(result.errorOutput).toContain("emails group add empty");
    expect(listSandboxEmails(providerId, 10)).toHaveLength(0);
  });

  it("refuses --to and --to-group together rather than dropping --to", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to", "explicit@ext.com", "--to-group", "team",
      "--subject", "Hi", "--body", "x", "--provider", providerId,
    ]);

    expect(result.exited).toBe(true);
    expect(result.errorOutput).toContain("Pass --to or --to-group, not both");
    expect(listSandboxEmails(providerId, 10)).toHaveLength(0);
  });
});

// ---- self-hosted -------------------------------------------------------------

describe("emails send --to-group (self-hosted)", () => {
  let stub: V1Stub;

  beforeAll(async () => { stub = await startV1Stub(); });
  afterAll(() => stub.stop());

  beforeEach(async () => {
    captureInheritedProcessEnv();
    await stub.reset();
    stub.applyEnv();
    resetMailDataSource();
    // Written through the SAME routed facade the command reads, so the test
    // proves the /v1 round trip rather than a hand-shaped stub payload.
    const group = createGroup("team");
    addMember(group.id, "one@ext.com", "One");
    addMember(group.id, "two@ext.com", "Two");
  });

  afterEach(() => {
    stub.clearEnv();
    resetMailDataSource();
    restoreInheritedProcessEnv();
  });

  it("expands the group over /v1 — the API the refusal said did not exist", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to-group", "team", "--subject", "Hi", "--body", "x",
    ]);

    expect(result.exited).toBe(false);
    expect(result.consoleOutput).toContain("Email sent to one@ext.com, two@ext.com");
    const messages = await stub.list("messages");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      direction: "outbound",
      from_addr: "agent@acme.com",
      to_addrs: ["one@ext.com", "two@ext.com"],
      status: "sent",
    });
  });

  it("still refuses an unknown group, without naming a mode", async () => {
    const result = await runSend([
      "send", "--from", "agent@acme.com", "--to-group", "nope", "--subject", "Hi", "--body", "x",
    ]);

    expect(result.exited).toBe(true);
    expect(result.errorOutput).toContain("Group not found: nope");
    expect(result.errorOutput).not.toContain("self-hosted");
    expect(await stub.list("messages")).toHaveLength(0);
  });
});
