// Self-hosted-ONLY: the local scheduler/automation store, batch sender and local
// diagnostics have no /v1 equivalent, so `schedule`/`scheduled`/`scheduler`,
// `batch` and `doctor` now fail loud with the server-only message (see misc.ts).
// `completion` stays a pure local command and is the meaningful positive path.
// No local SQLite exists anymore, so there is no DB/temp-HOME setup here.
import { describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { registerMiscCommands, runSchedulerTick } from "./misc.remote.js";

async function runMiscCommand(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  const consoleLines: string[] = [];
  const originalLog = console.log;
  registerMiscCommands(program, (_data, formatted) => {
    if (formatted) consoleLines.push(String(formatted));
  });
  console.log = (...values: unknown[]) => {
    consoleLines.push(values.map(String).join(" "));
  };
  try {
    await program.parseAsync(["node", "emails", ...args]);
  } finally {
    console.log = originalLog;
  }
  return consoleLines.join("\n");
}

async function runMiscCommandExpectingExit(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  const errors: string[] = [];
  const originalError = console.error;
  const originalExit = process.exit;
  const errorSpy = mock((msg: unknown) => {
    errors.push(String(msg));
  });
  const exitSpy = mock((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  });
  registerMiscCommands(program, () => {});
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

describe("shell completion command", () => {
  it("prints a bash completion script", async () => {
    const output = await runMiscCommand(["completion", "bash"]);
    expect(output).toContain("bash completion for emails");
    expect(output).toContain("_emails_completion");
  });

  it("prints a zsh completion script", async () => {
    const output = await runMiscCommand(["completion", "zsh"]);
    expect(output).toContain("#compdef emails");
  });

  it("prints a fish completion script", async () => {
    const output = await runMiscCommand(["completion", "fish"]);
    expect(output).toContain("fish completion for emails");
  });

  it("rejects an unsupported shell", async () => {
    const errors = await runMiscCommandExpectingExit(["completion", "powershell"]);
    expect(errors).toContain("Unsupported shell");
  });
});

describe("verify-email command", () => {
  it("reports an invalid format without any network lookup", async () => {
    const output = await runMiscCommand(["verify-email", "not-an-email"]);
    expect(output).toContain("Invalid email format");
  });
});

describe("server-only scheduling, batch and diagnostics commands", () => {
  const SERVER_ONLY = [
    { name: "schedule list", args: ["schedule", "list"] },
    { name: "schedule cancel", args: ["schedule", "cancel", "sched-1"] },
    { name: "scheduled list", args: ["scheduled", "list"] },
    { name: "scheduler", args: ["scheduler"] },
    {
      name: "batch",
      args: ["batch", "--csv", "recipients.csv", "--template", "welcome", "--from", "sender@example.com"],
    },
    { name: "doctor", args: ["doctor"] },
    { name: "doctor delivery", args: ["doctor", "delivery", "ops@example.com"] },
  ] as const;

  for (const { name, args } of SERVER_ONLY) {
    it(`blocks emails ${name} in the self-hosted client`, async () => {
      const errors = await runMiscCommandExpectingExit(args as unknown as string[]);
      expect(errors).toContain(`emails ${name}`);
      expect(errors).toContain("is not available in the self-hosted client");
      expect(errors).toContain("it runs on the self-hosted server");
    });
  }
});

describe("runSchedulerTick", () => {
  it("is server-only in the self-hosted client", async () => {
    await expect(runSchedulerTick()).rejects.toThrow(
      "emails schedule run is not available in the self-hosted client; it runs on the self-hosted server.",
    );
  });
});
