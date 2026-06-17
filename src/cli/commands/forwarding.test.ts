import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { listForwardingRules } from "../../db/forwarding.js";
import { registerForwardingCommands } from "./forwarding.js";

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

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("forwarding command", () => {
  it("creates and lists app-level forwarding rules", async () => {
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
  });
});
