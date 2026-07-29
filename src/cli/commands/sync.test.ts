// Self-hosted-ONLY: provider event ingestion, sent-log stats/analytics and the
// live monitor are owned by the self-hosted server. This client keeps the
// commands for discoverability but fails loud — there is no local island to
// sync/aggregate and no /v1 equivalent to route them through.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { registerSyncCommands } from "./sync.js";
import { registerSyncCommands as registerLocalSyncCommands } from "./sync.local.js";
import { registerSyncCommands as registerRemoteSyncCommands } from "./sync.remote.js";

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

function allRegisteredCommands(program: Command): Command[] {
  return program.commands.flatMap((command) => [command, ...allRegisteredCommands(command)]);
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

describe("sync JSON output", () => {
  it("prints one parseable stats document when -j follows the command", async () => {
    const env = {
      ...process.env,
      [MODE_ENV_KEYS[0]]: "local",
      EMAILS_DB_PATH: ":memory:",
      NO_COLOR: "1",
    };
    delete env[MODE_ENV_KEYS[1]];
    delete env[MODE_ENV_KEYS[2]];
    delete env.EMAILS_SELF_HOSTED_API_KEY;

    const child = Bun.spawn({
      cmd: [process.execPath, "run", "src/cli/index.tsx", "stats", "-j"],
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ provider_id: "all", period: "30d", sent: 0 });
  });

  it("prints parseable JSON errors with a non-zero exit", async () => {
    enableSelfHostedMode();
    const child = Bun.spawn({
      cmd: [process.execPath, "run", "src/cli/index.tsx", "pull", "--json"],
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      error: { message: expect.stringContaining("emails pull is not available") },
    });
  });
});

describe("sync JSON option registration", () => {
  for (const [mode, register] of [
    ["local", registerLocalSyncCommands],
    ["self_hosted", registerRemoteSyncCommands],
  ] as const) {
    it(`registers the exact JSON option on every ${mode} command`, () => {
      const program = new Command();
      program.command("provider");
      register(program, () => {});

      const commands = allRegisteredCommands(program).filter((command) => command.name() !== "provider");
      for (const command of commands) {
        const option = command.options.find((candidate) => candidate.long === "--json");
        expect(option?.flags, command.name()).toBe("-j, --json");
        expect(option?.description, command.name()).toBe("Print JSON output");
        expect(option?.defaultValue, command.name()).toBe(false);
      }
    });
  }
});
