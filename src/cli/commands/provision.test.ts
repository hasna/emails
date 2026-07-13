// Self-hosted-ONLY: automated provisioning (SES identity/MAIL FROM, Cloudflare
// DNS, S3 inbound receipt rules, the reconciler daemon and round-trip acceptance
// tests) is server-side orchestration with no /v1 equivalent, so every
// `provision` command now fails loud with the server-only message (see
// provision.ts). Domain adoption remains available via `emails domain adopt`.
// No local SQLite exists anymore, so there is no DB/temp-HOME setup here.
import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { registerProvisionCommands } from "./provision.js";

async function runProvisionCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  const program = new Command();
  program.exitOverride();
  registerProvisionCommands(program, () => {});
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

describe("server-only provisioning commands", () => {
  // Required options are supplied so the command action runs and hits the
  // server-only guard rather than a commander missing-option error.
  const SERVER_ONLY = [
    { name: "provision status", args: ["provision", "status"] },
    { name: "provision address", args: ["provision", "address", "agent@example.com", "--provider", "ses-provider"] },
    { name: "provision domain", args: ["provision", "domain", "example.com", "--provider", "ses-provider"] },
    { name: "provision up", args: ["provision", "up", "example.com", "--provider", "ses-provider"] },
    { name: "provision roundtrip", args: ["provision", "roundtrip", "--domain", "example.com", "--provider", "ses-provider"] },
    { name: "provision daemon", args: ["provision", "daemon", "--provider", "ses-provider"] },
    { name: "provision retry", args: ["provision", "retry", "example.com"] },
  ] as const;

  for (const { name, args } of SERVER_ONLY) {
    it(`blocks emails ${name} in the self-hosted client`, async () => {
      const result = await runProvisionCommandExpectingExit(args as unknown as string[]);
      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain(`emails ${name}`);
      expect(result.stderr).toContain("is not available in the self-hosted client");
      expect(result.stderr).toContain("it runs on the self-hosted server");
    });
  }
});
