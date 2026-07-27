// Self-hosted-ONLY.
//
// Reading and cancelling the schedule, and running diagnostics, are NOT
// server-only: `GET/PATCH /v1/scheduled` exists and src/db/scheduled.remote.ts
// is a complete client for it (the MCP `list_scheduled` / `cancel_scheduled`
// tools already take exactly that path), and src/lib/doctor.remote.ts probes
// the operator service. Those commands are driven here against an
// out-of-process /v1 stub (see src/test-support/v1-stub.ts).
//
// What stays server-only is the scheduler LOOP and the batch sender (both need
// the local provider send pipeline) and `doctor delivery` (local ingestion
// diagnosis, still a stub in src/lib/delivery-doctor.remote.ts). `completion`
// and `verify-email` remain pure local commands.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { startV1Stub, type V1Stub, type V1StubResources } from "../../test-support/v1-stub.js";
import { registerMiscCommands, runSchedulerTick } from "./misc.remote.js";

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});
afterEach(() => stub.clearEnv());

interface MiscRun {
  data: unknown;
  output: string;
}

async function runMisc(args: string[]): Promise<MiscRun> {
  const program = new Command();
  program.exitOverride();
  const consoleLines: string[] = [];
  let data: unknown;
  const originalLog = console.log;
  registerMiscCommands(program, (payload, formatted) => {
    data = payload;
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
  return { data, output: consoleLines.join("\n") };
}

async function runMiscCommand(args: string[]): Promise<string> {
  return (await runMisc(args)).output;
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

function scheduledRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider_id: "provider-1",
    from_address: "agent@example.com",
    to_addresses: ["dest@example.com"],
    subject: "Scheduled subject",
    scheduled_at: "2026-08-01T09:00:00.000Z",
    status: "pending",
    ...over,
  };
}

async function seedScheduled(rows: Array<Record<string, unknown>>): Promise<void> {
  await stub.seed({ scheduled: rows } as V1StubResources);
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

// ─── schedule / scheduled (previously refused; now routed to /v1/scheduled) ───

describe("schedule list routes to /v1/scheduled", () => {
  for (const namespace of ["schedule", "scheduled"] as const) {
    it(`\`${namespace} list\` returns the rows the API holds`, async () => {
      await seedScheduled([
        scheduledRow({ id: "sched-later", subject: "Later", scheduled_at: "2026-08-02T09:00:00.000Z" }),
        scheduledRow({ id: "sched-sooner", subject: "Sooner", scheduled_at: "2026-08-01T09:00:00.000Z" }),
      ]);

      const { data, output } = await runMisc([namespace, "list"]);
      const rows = data as Array<{ id: string; subject: string; status: string }>;

      expect(rows.map((row) => row.id)).toEqual(["sched-sooner", "sched-later"]);
      expect(rows.map((row) => row.status)).toEqual(["pending", "pending"]);
      expect(output).toContain("Sooner");
      expect(output).toContain("Later");
      // The whole point of the change: no refusal on the success path.
      expect(output).not.toContain("not available in the self-hosted client");
    });

    it(`\`${namespace} list --status\` filters server-side without inventing rows`, async () => {
      await seedScheduled([
        scheduledRow({ id: "sched-pending", subject: "Still pending" }),
        scheduledRow({ id: "sched-cancelled", subject: "Already cancelled", status: "cancelled" }),
      ]);

      const { data } = await runMisc([namespace, "list", "--status", "cancelled"]);
      const rows = data as Array<{ id: string }>;

      expect(rows.map((row) => row.id)).toEqual(["sched-cancelled"]);
    });

    it(`\`${namespace} list\` reports an empty schedule as empty`, async () => {
      const { data, output } = await runMisc([namespace, "list"]);
      expect(data).toEqual([]);
      expect(output).toContain("No scheduled emails.");
    });

    it(`\`${namespace} cancel\` PATCHes the row to cancelled`, async () => {
      await seedScheduled([scheduledRow({ id: "0198cafe-0000-7000-8000-00000000dead", subject: "Cancel me" })]);

      const output = await runMiscCommand([namespace, "cancel", "0198cafe-0000-7000-8000-00000000dead"]);
      expect(output).toContain("0198cafe");

      const { data } = await runMisc([namespace, "list"]);
      expect(data as Array<{ status: string }>).toEqual([
        expect.objectContaining({ status: "cancelled" }),
      ]);
    });

    it(`\`${namespace} cancel\` refuses a row that is already cancelled`, async () => {
      await seedScheduled([
        scheduledRow({ id: "0198cafe-0000-7000-8000-0000000000ff", status: "cancelled" }),
      ]);

      const errors = await runMiscCommandExpectingExit([
        namespace, "cancel", "0198cafe-0000-7000-8000-0000000000ff",
      ]);
      expect(errors).toContain("may already be sent or cancelled");
    });
  }
});

// ─── doctor (previously refused; now probes the operator service) ─────────────

describe("doctor runs the self-hosted diagnostics", () => {
  it("reports mode, client configuration and the real /health and /ready probes", async () => {
    const { data, output } = await runMisc(["doctor"]);
    const checks = data as Array<{ name: string; status: string; message: string }>;
    const named = (name: string) => checks.find((check) => check.name === name);

    expect(named("Mode")).toMatchObject({ status: "pass" });
    expect(named("Self-hosted client configuration")).toMatchObject({ status: "warn" });
    // The stub serves /v1 only, so both probes must FAIL rather than be skipped:
    // a diagnostic that cannot reach the service has to say so.
    expect(named("Self-hosted API /health")).toMatchObject({ status: "fail" });
    expect(named("Self-hosted API /ready")).toMatchObject({ status: "fail" });
    expect(output).not.toContain("not available in the self-hosted client");
  });
});

describe("server-only scheduling, batch and diagnostics commands", () => {
  const SERVER_ONLY = [
    { name: "schedule run", args: ["schedule", "run"] },
    { name: "scheduler", args: ["scheduler"] },
    {
      name: "batch",
      args: ["batch", "--csv", "recipients.csv", "--template", "welcome", "--from", "sender@example.com"],
    },
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
