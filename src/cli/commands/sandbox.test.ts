import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { storeSandboxEmail } from "../../db/sandbox.js";
import { registerSandboxCommands } from "./sandbox.js";

async function runSandboxCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const formatted: string[] = [];
  const logs: string[] = [];
  const originalLog = console.log;
  registerSandboxCommands(program, (payload, text) => {
    data = payload;
    if (text) formatted.push(String(text));
  });
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(" "));
  };
  try {
    await program.parseAsync(["node", "mailery", ...args]);
  } finally {
    console.log = originalLog;
  }
  return { data, formatted: formatted.join("\n"), consoleOutput: logs.join("\n") };
}

function seedSandboxEmail() {
  const provider = createProvider({ name: "sandbox", type: "sandbox" });
  const email = storeSandboxEmail({
    provider_id: provider.id,
    from_address: "sender@example.com",
    to_addresses: ["ops@example.com"],
    cc_addresses: [],
    bcc_addresses: [],
    reply_to: null,
    subject: "Sandbox HTML",
    html: '<p>Hello <strong>there</strong> &amp; welcome</p><p><a href="https://example.com/docs">docs</a></p>',
    text_body: null,
    attachments: [],
    headers: {},
  });
  return { provider, email };
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("sandbox CLI commands", () => {
  it("lists and counts sandbox emails without body payloads", async () => {
    seedSandboxEmail();

    const list = await runSandboxCommand(["sandbox", "list", "--limit", "1"]);
    const rows = list.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject).toBe("Sandbox HTML");
    expect(rows[0]).not.toHaveProperty("html");
    expect(rows[0]).not.toHaveProperty("text_body");

    const count = await runSandboxCommand(["sandbox", "count"]);
    expect(count.data).toEqual({ count: 1 });
  });

  it("renders sandbox HTML through the shared readable formatter", async () => {
    const { email } = seedSandboxEmail();

    const shown = await runSandboxCommand(["sandbox", "show", email.id]);

    expect(shown.consoleOutput).toContain("Hello there & welcome");
    expect(shown.consoleOutput).toContain("docs (https://example.com/docs)");
    expect(shown.consoleOutput).not.toContain("<strong>");
    expect(shown.consoleOutput).not.toContain("&amp;");
  });
});
