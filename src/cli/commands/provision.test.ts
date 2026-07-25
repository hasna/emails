// Automated provisioning (SES identity/MAIL FROM, Cloudflare DNS, S3 inbound
// receipt rules, the reconciler daemon and round-trip acceptance tests) ships in
// NO mode of this package: the local orchestrator was unreachable dead code and
// has been deleted, and the self-hosted server exposes no /v1 provisioning route
// and runs no reconciler. Every `provision` command therefore fails loud — and
// must say so TRUTHFULLY. The previous text ("not available in the self-hosted
// client; it runs on the self-hosted server") was false in both modes: it sent
// operators looking for a server-side service that does not exist.
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

describe("unimplemented provisioning commands", () => {
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
    it(`fails emails ${name} with a truthful, actionable message`, async () => {
      const result = await runProvisionCommandExpectingExit(args as unknown as string[]);
      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain(`emails ${name}`);
      expect(result.stderr).toContain("is not implemented in this build");
      // Names the two commands that DO work instead of a phantom server.
      expect(result.stderr).toContain("emails domain adopt");
      expect(result.stderr).toContain("emails aws setup-inbound");
      // The old claims were false in both local and self_hosted mode.
      expect(result.stderr).not.toContain("not available in the self-hosted client");
      expect(result.stderr).not.toContain("runs on the self-hosted server");
    });
  }

  it("does not advertise provisioning as a working feature in --help", () => {
    const program = new Command();
    registerProvisionCommands(program, () => {});
    const provision = program.commands.find((command) => command.name() === "provision");
    expect(provision?.description()).toContain("NOT IMPLEMENTED");
    expect(provision?.description()).toContain("emails domain adopt");
  });
});
