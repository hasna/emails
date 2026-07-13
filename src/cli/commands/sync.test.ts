// Self-hosted-ONLY: provider event ingestion, sent-log stats/analytics and the
// live monitor are owned by the self-hosted server. This client keeps the
// commands for discoverability but fails loud — there is no local island to
// sync/aggregate and no /v1 equivalent to route them through.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { registerSyncCommands } from "./sync.js";

const MODE_ENV_KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
] as const;

let originalModeEnv: Partial<Record<typeof MODE_ENV_KEYS[number], string>> = {};

function enableSelfHostedMode() {
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example.test";
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-api-key";
}

async function runSyncCommandExpectingExit(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  program.command("provider").description("provider namespace");
  const errors: string[] = [];
  const originalError = console.error;
  const originalExit = process.exit;
  const errorSpy = mock((msg: unknown) => {
    errors.push(String(msg));
  });
  const exitSpy = mock((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  });
  registerSyncCommands(program, () => {});
  (console as unknown as { error: typeof errorSpy }).error = errorSpy;
  (process as unknown as { exit: typeof exitSpy }).exit = exitSpy;
  try {
    await expect(program.parseAsync(["node", "emails", ...args])).rejects.toThrow("exit:1");
  } finally {
    (console as unknown as { error: typeof originalError }).error = originalError;
    (process as unknown as { exit: typeof originalExit }).exit = originalExit;
  }
  return errors.join("\n");
}

beforeEach(() => {
  originalModeEnv = {};
  for (const key of MODE_ENV_KEYS) {
    originalModeEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MODE_ENV_KEYS) {
    const value = originalModeEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("sync CLI commands (server-only in the self-hosted client)", () => {
  const cases: Array<{ args: string[]; command: string }> = [
    { args: ["provider", "sync"], command: "emails provider sync" },
    { args: ["pull"], command: "emails pull" },
    { args: ["stats"], command: "emails stats" },
    { args: ["stats", "--inbox"], command: "emails stats" },
    { args: ["monitor"], command: "emails monitor" },
    { args: ["analytics"], command: "emails analytics" },
  ];

  for (const { args, command } of cases) {
    it(`fails loud for emails ${args.join(" ")}`, async () => {
      enableSelfHostedMode();

      const error = await runSyncCommandExpectingExit(args);

      expect(error).toContain(`${command} is not available in the self-hosted client; it runs on the self-hosted server.`);
    });
  }
});
