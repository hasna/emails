// Self-hosted-ONLY: the local SMTP listener and the local inbound_emails store
// have no /v1 equivalent — inbound ingestion runs on the self-hosted server and
// the API-backed mail view is exposed through `emails inbox ...` — so every
// `inbound` command now fails loud with the server-only message (see inbound.ts).
// No local SQLite exists anymore, so there is no DB setup here.
import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { registerInboundCommands } from "./inbound.js";

async function runInboundCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  const program = new Command();
  program.exitOverride();
  registerInboundCommands(program, () => {});
  try {
    await program.parseAsync(["node", "emails", ...args]);
    throw new Error("Expected command to exit");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

describe("server-only inbound commands", () => {
  const SERVER_ONLY = [
    { name: "inbound listen", args: ["inbound", "listen"] },
    { name: "inbound list", args: ["inbound", "list"] },
    { name: "inbound show", args: ["inbound", "show", "abc123"] },
    { name: "inbound open", args: ["inbound", "open", "abc123"] },
    { name: "inbound clear", args: ["inbound", "clear"] },
    { name: "inbound count", args: ["inbound", "count"] },
  ] as const;

  for (const { name, args } of SERVER_ONLY) {
    it(`blocks emails ${name} and points at the API-backed mail view`, async () => {
      const result = await runInboundCommandExpectingExit(args as unknown as string[]);
      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain(`emails ${name}`);
      expect(result.stderr).toContain("is not available in the self-hosted client");
      expect(result.stderr).toContain("it runs on the self-hosted server");
      expect(result.stderr).toContain("for the API-backed mail view");
    });
  }
});
