// Self-hosted-ONLY: local daemon/log diagnostics (queue status, worker restart
// guidance, log tailing) have no /v1 equivalent — background workers and their
// logs live on the self-hosted server — so every `daemon`/`logs` command now
// fails loud with the server-only message (see daemon.ts). No local SQLite
// exists anymore, so there is no DB/temp-HOME setup here.
import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { registerDaemonCommands } from "./daemon.remote.js";

async function runDaemonCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  const program = new Command();
  program.exitOverride();
  registerDaemonCommands(program, () => {});
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

describe("server-only daemon and log commands", () => {
  const SERVER_ONLY = [
    { name: "daemon status", args: ["daemon", "status"] },
    { name: "daemon restart", args: ["daemon", "restart"] },
    { name: "logs tail", args: ["logs", "tail", "--component", "scheduler"] },
  ] as const;

  for (const { name, args } of SERVER_ONLY) {
    it(`blocks emails ${name} in the self-hosted client`, async () => {
      const result = await runDaemonCommandExpectingExit(args as unknown as string[]);
      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain(`emails ${name}`);
      expect(result.stderr).toContain("is not available in the self-hosted client");
      expect(result.stderr).toContain("it runs on the self-hosted server");
    });
  }
});
