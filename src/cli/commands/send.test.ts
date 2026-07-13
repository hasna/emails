// Self-hosted-ONLY: `emails send` routes through the mail-data-source seam to the
// server send API (POST /v1/messages/send). There is no local provider path or
// local sent ledger anymore. These tests drive the REAL command in-process
// against an out-of-process /v1 stub (see src/test-support/v1-stub.ts): a real
// send records an outbound message, a dry-run records nothing, and the
// self-hosted-unsupported paths (--to-group, scheduling) fail loud.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerSendCommands } from "./send.js";

let stub: V1Stub;

async function runSendCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  const consoleLines: string[] = [];
  const originalLog = console.log;
  registerSendCommands(program, () => {});
  console.log = (...values: unknown[]) => {
    consoleLines.push(values.map(String).join(" "));
  };
  try {
    await program.parseAsync(["node", "emails", ...args]);
  } finally {
    console.log = originalLog;
  }
  return { consoleOutput: consoleLines.join("\n") };
}

async function runSendCommandExpectingExit(args: string[]): Promise<string> {
  const errors: string[] = [];
  const originalError = console.error;
  const originalExit = process.exit;
  (console as unknown as { error: (...v: unknown[]) => void }).error = (...values: unknown[]) => {
    errors.push(values.map(String).join(" "));
  };
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as never;
  try {
    await expect(runSendCommand(args)).rejects.toThrow(/process\.exit/);
  } finally {
    (console as unknown as { error: typeof originalError }).error = originalError;
    (process as unknown as { exit: typeof originalExit }).exit = originalExit;
  }
  return errors.join("\n");
}

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});
afterEach(() => stub.clearEnv());

describe("emails send — routes through the server send API", () => {
  it("records an outbound message and reports success", async () => {
    const result = await runSendCommand([
      "send", "--from", "agent@acme.com", "--to", "dest@ext.com", "--subject", "Hi", "--body", "Body text",
    ]);

    expect(result.consoleOutput).toContain("Email sent to dest@ext.com");

    const messages = await stub.list("messages");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      direction: "outbound",
      from: "agent@acme.com",
      subject: "Hi",
      text: "Body text",
    });
    expect(messages[0]!["to"]).toEqual(["dest@ext.com"]);
  });

  it("sends to multiple recipients", async () => {
    const result = await runSendCommand([
      "send", "--from", "agent@acme.com", "--to", "a@ext.com", "b@ext.com", "--subject", "Hi", "--body", "x",
    ]);

    expect(result.consoleOutput).toContain("Email sent to a@ext.com, b@ext.com");
    const messages = await stub.list("messages");
    expect(messages).toHaveLength(1);
    expect(messages[0]!["to"]).toEqual(["a@ext.com", "b@ext.com"]);
  });
});

describe("emails send — dry-run previews without sending", () => {
  it("prints the preview and [NOT SENT] without recording a message", async () => {
    const result = await runSendCommand([
      "send", "--from", "agent@acme.com", "--to", "dest@ext.com", "--subject", "Hi", "--body", "Body text", "--dry-run",
    ]);

    expect(result.consoleOutput).toContain("[DRY RUN]");
    expect(result.consoleOutput).toContain("[NOT SENT]");
    expect(await stub.list("messages")).toHaveLength(0);
  });

  it("warns that scheduling is unavailable during a dry-run", async () => {
    const result = await runSendCommand([
      "send", "--from", "agent@acme.com", "--to", "dest@ext.com", "--subject", "Hi", "--body", "x",
      "--schedule", "2030-01-01T00:00:00Z", "--dry-run",
    ]);

    expect(result.consoleOutput).toContain("scheduling is not available in the self-hosted client");
    expect(await stub.list("messages")).toHaveLength(0);
  });
});

describe("emails send — self-hosted-unsupported paths fail loud", () => {
  it("rejects --to-group (no server-side group fan-out)", async () => {
    const errors = await runSendCommandExpectingExit([
      "send", "--from", "agent@acme.com", "--to-group", "team", "--subject", "Hi", "--body", "x",
    ]);

    expect(errors).toContain("--to-group is not available in the self-hosted client");
    expect(await stub.list("messages")).toHaveLength(0);
  });

  it("requires explicit recipients", async () => {
    const errors = await runSendCommandExpectingExit([
      "send", "--from", "agent@acme.com", "--subject", "Hi", "--body", "x",
    ]);

    expect(errors).toContain("No recipients specified");
  });

  it("rejects a real scheduled send (no server-side scheduling)", async () => {
    const errors = await runSendCommandExpectingExit([
      "send", "--from", "agent@acme.com", "--to", "dest@ext.com", "--subject", "Hi", "--body", "x",
      "--schedule", "2030-01-01T00:00:00Z",
    ]);

    expect(errors).toContain("Scheduled send is not supported");
    expect(await stub.list("messages")).toHaveLength(0);
  });
});
