// Self-hosted-ONLY.
//
// Reading and cancelling the schedule, and running diagnostics, are NOT
// server-only: `GET/PATCH /v1/scheduled` exists and src/db/scheduled.remote.ts
// is a complete client for it (the MCP `list_scheduled` / `cancel_scheduled`
// tools already take exactly that path), and src/lib/doctor.ts reads its facts
// through whichever store the configuration names. Those commands are driven
// here against an out-of-process /v1 stub (see src/test-support/v1-stub.ts).
//
// What stays server-only is the scheduler LOOP and the batch sender (both need
// the local provider send pipeline) and `doctor delivery`. That last one is now a
// property of THIS command family alone: src/lib/delivery-doctor.ts has collapsed to a
// single implementation that reads whichever store the storage configuration names, so
// the diagnosis itself no longer refuses. This arm's `serverOnly` refusal stands until
// the misc family is collapsed too, and the MCP `diagnose_inbound_delivery` tool — which
// goes through the module rather than through this arm — already answers. `completion`
// and `verify-email` remain pure local commands.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { startV1Stub, type V1Stub, type V1StubResources } from "../../test-support/v1-stub.js";
import { registerMiscCommands, runSchedulerTick } from "./misc.remote.js";

let stub: V1Stub;

beforeAll(async () => {
  // `openapi: true`: the schedule commands below read through `src/db/scheduled.ts`, which
  // has collapsed onto the store seam and therefore reaches this fixture through
  // `src/store-http/`. That store reads the published contract before a filtered list or a
  // write, and treats its absence as a fault — so without this the `--status` and `cancel`
  // cases would fault on the contract rather than exercise anything. The option is off by
  // default on purpose; see `V1StubOptions.openapi`.
  stub = await startV1Stub({ openapi: true });
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

// ─── doctor (one implementation, reading through the store seam) ──────────────
//
// `emails doctor` has ONE implementation now (src/lib/doctor.ts). It no longer reports
// a mode, and it no longer probes `/health` and `/ready`; it reads the resource facts
// through the store the configuration names, which here is a client of this stub. So the
// assertions moved from "the mode-specific arm ran" to "the API store actually served the
// reads", which is a stronger claim about the service than a health endpoint is.
//
// `EMAILS_DB_PATH` is unset for this block ON PURPOSE, and it is not a workaround for a
// resolver rule. `stub.applyEnv()` adds an API URL while the hermetic harness
// (scripts/run-hermetic-tests.sh) exports `EMAILS_DB_PATH=:memory:`, so the process is
// left naming BOTH a local database and an API — which src/store-resolution.ts correctly
// refuses to resolve rather than picking a winner. This block wants the API store, so it
// says so. (The harness-wide fix is its own change; this is the one command in this file
// that constructs a store.)

describe("doctor runs the diagnostics against the configured store", () => {
  const DATABASE_PATH_KEYS = ["HASNA_EMAILS_DB_PATH", "EMAILS_DB_PATH"] as const;
  let priorDatabasePaths: Record<string, string | undefined> = {};

  beforeEach(() => {
    priorDatabasePaths = {};
    for (const key of DATABASE_PATH_KEYS) {
      priorDatabasePaths[key] = process.env[key];
      delete process.env[key];
    }
  });

  // Restored so the blocks after this one see the environment they were written against.
  afterEach(() => {
    for (const key of DATABASE_PATH_KEYS) {
      const value = priorDatabasePaths[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("reports reads served by the API store, and no check that claims what it did not measure", async () => {
    const { data, output } = await runMisc(["doctor"]);
    const checks = data as Array<{ name: string; status: string; message: string }>;
    const named = (name: string) => checks.find((check) => check.name === name);

    // Reachability comes from a SERVED READ, never from a configuration that parsed.
    expect(named("Store")).toMatchObject({ status: "pass" });
    expect(named("Store")?.message).toContain("A read was served by");
    // The deleted arms' checks are gone, along with the mode word they reported.
    expect(named("Mode")).toBeUndefined();
    expect(named("Self-hosted API /health")).toBeUndefined();
    // What replaced the readiness probe says so instead of vanishing.
    expect(named("Store readiness")).toMatchObject({ status: "unknown" });
    // Real resource reads against the stub, and credential validity reported as unmeasured.
    expect(named("Templates")).toMatchObject({ status: "pass", message: "0 template(s)" });
    expect(named("Provider credentials")).toMatchObject({ status: "unknown" });
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
