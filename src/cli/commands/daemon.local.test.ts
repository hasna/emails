import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { registerDaemonCommands } from "./daemon.local.js";

async function runDaemonCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerDaemonCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("daemon commands", () => {
  it("reports queue status without requiring a process manager", async () => {
    const result = await runDaemonCommand(["daemon", "status"]);
    expect(result.out).toContain("Daemon status");
    expect(result.data).toMatchObject({ queue: { due_domains: 0, due_addresses: 0 } });
  });

  it("restart returns managed-process guidance", async () => {
    const result = await runDaemonCommand(["daemon", "restart"]);
    expect(result.out).toContain("No managed email daemon process");
    expect(result.data).toMatchObject({ managed_process: false });
  });
});
