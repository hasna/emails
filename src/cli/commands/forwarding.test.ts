// Self-hosted-ONLY: the forwarding repo routes every read/write to `/v1/forwarding`,
// so these tests drive the REAL command against an out-of-process /v1 stub (see
// src/test-support/v1-stub.ts). No local SQLite exists anymore. `forwarding run`
// still fails loud because the forwarding pipeline runs on the self-hosted server.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { listForwardingRules } from "../../db/forwarding.js";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerForwardingCommands } from "./forwarding.js";

let stub: V1Stub;

async function runForwardingCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerForwardingCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

async function runForwardingCommandExpectingError(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  const errors: string[] = [];
  const originalError = console.error;
  const originalExit = process.exit;
  console.error = ((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as typeof process.exit;
  registerForwardingCommands(program, () => {});
  try {
    await program.parseAsync(["node", "emails", ...args]);
  } catch {
    // handleError exits via the stubbed process.exit (or commander throws).
  } finally {
    console.error = originalError;
    process.exit = originalExit;
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

describe("forwarding command", () => {
  it("creates and lists app-level forwarding rules through the /v1 API", async () => {
    const add = await runForwardingCommand(["forwarding", "add", "user@example.com", "archive@example.net"]);
    const list = await runForwardingCommand(["forwarding", "list"]);

    expect(add.data).toMatchObject({
      source_address: "user@example.com",
      target_address: "archive@example.net",
      mode: "app-copy",
      enabled: true,
    });
    expect(list.out).toContain("user@example.com -> archive@example.net");
    expect(listForwardingRules()).toHaveLength(1);
    expect((await stub.list("forwarding")).map((r) => r["source_address"])).toContain("user@example.com");
  });

  it("fails forwarding run because the forwarding pipeline runs on the self-hosted server", async () => {
    const errors = await runForwardingCommandExpectingError(["forwarding", "run"]);
    expect(errors).toContain("not available in the self-hosted client");
  });
});
