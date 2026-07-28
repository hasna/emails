// Self-hosted-ONLY.
//
// These commands used to refuse outright. They are not server-only:
//   • `daemon status` reads the provisioning queue from the SAME paged status facts
//     `emails status` reports (`/v1/domains` + `/v1/addresses` — NOT
//     `/v1/provisioning`, which holds only the audit trail), so its counts carry an
//     availability record and render as `≥N` when the read could not be completed.
//   • `daemon restart` reports that no supervisor is configured, which is a
//     statement about THIS process, not about the server — so it makes no request.
//   • `logs tail` reads files under this machine's data directory. It opens no
//     database and makes no request, and says so when there is nothing there.
//
// The tests drive the REAL commands against an out-of-process /v1 stub, with a
// temporary HOME so the log tail can never read (or create) anything in the
// operator's real data directory.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startV1Stub, type V1Stub, type V1StubResources } from "../../test-support/v1-stub.js";
import { registerDaemonCommands } from "./daemon.remote.js";

let stub: V1Stub;
let home: string;
let priorHome: string | undefined;

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
  home = mkdtempSync(join(tmpdir(), "emails-daemon-home-"));
  priorHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(() => {
  stub.clearEnv();
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

/** The directory `getDataDir()` resolves to under the temporary HOME. */
function dataDir(): string {
  return join(home, ".hasna", "emails");
}

async function runDaemon(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerDaemonCommands(program, (payload, formatted) => {
    data = payload;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, output: out.join("\n") };
}

describe("daemon status reads the provisioning queue over /v1", () => {
  it("counts due and failed provisioning work instead of refusing", async () => {
    // The queue is derived from the provisioning lifecycle columns the domain and
    // address resources carry (the deleted HTTP arm's `dueRows`), so seed
    // those rows rather than a synthetic queue table.
    await stub.seed({
      domains: [
        { id: "dom-due", domain: "due.example.com", provisioning_status: "pending", next_check_at: "2020-01-01T00:00:00.000Z" },
        { id: "dom-failed", domain: "failed.example.com", provisioning_status: "failed" },
        { id: "dom-done", domain: "done.example.com", provisioning_status: "ready", next_check_at: "2020-01-01T00:00:00.000Z" },
      ],
      addresses: [
        { id: "addr-failed", email: "broken@failed.example.com", provisioning_status: "failed" },
      ],
    } as V1StubResources);

    const { data, output } = await runDaemon(["daemon", "status"]);
    const status = data as {
      queue: {
        availability: { available: boolean; complete: boolean | null };
        domains_pending: number | null;
        domains_failed: number | null;
        addresses_failed: number | null;
        due_derivable: boolean;
        drainable: boolean;
      };
    };

    expect(status.queue.domains_pending).toBe(1);
    expect(status.queue.domains_failed).toBe(1);
    expect(status.queue.addresses_failed).toBe(1);
    expect(status.queue.drainable).toBe(false);
    // The counts come from the PAGED status-facts read, so they arrive with an
    // availability record. Without it a caller cannot tell a total from a floor.
    expect(status.queue.availability.available).toBe(true);
    expect(status.queue.availability.complete).toBe(true);
    expect(output).not.toContain("not available in the self-hosted client");
  });

  // The reason this command stopped calling getProvisioningWorkSummary(): that read
  // is a single `list({ limit: 1000 })`, clamped to 500 server-side, and it published
  // the result as an exact count. `emails status` reports the same data as a lower
  // bound when it cannot walk the table; the daemon view has to agree.
  it("never labels a count 'due' when only 'pending' was measured", async () => {
    const { data, output } = await runDaemon(["daemon", "status"]);
    const status = data as { queue: Record<string, unknown> };

    expect(status.queue).not.toHaveProperty("due_domains");
    expect(status.queue).not.toHaveProperty("due_addresses");
    expect(status.queue["due_derivable"]).toBe(false);
    expect(output).toContain("No schedule-aware 'due now' count is derivable over /v1");
  });

  it("reports the realtime queue as unavailable rather than as 'not configured'", async () => {
    // `/v1` publishes no realtime queue state. Printing "not configured" would be
    // a fabricated negative claim, which is the defect the status facts already
    // guard against — the daemon view has to carry the same gap through.
    const { data, output } = await runDaemon(["daemon", "status"]);
    const status = data as { realtime: { queue_configured: boolean | null } };

    expect(status.realtime.queue_configured).toBeNull();
    expect(output).toContain("unavailable");
    expect(output).not.toContain("not configured");
  });

  it("proposes no start command that would itself refuse", async () => {
    const { data } = await runDaemon(["daemon", "status"]);
    const status = data as { start_commands: Record<string, string> };
    // `emails inbox watch` refuses in this mode; naming it here would be a
    // remedy that throws.
    expect(Object.values(status.start_commands)).toEqual([]);
  });
});

describe("daemon restart reports this process, not the server", () => {
  it("states that no supervisor is configured", async () => {
    const { data, output } = await runDaemon(["daemon", "restart"]);
    const result = data as { managed_process: boolean; cli_equivalent: string };

    expect(result.managed_process).toBe(false);
    expect(result.cli_equivalent).toBe("emails daemon status --json");
    expect(output).not.toContain("not available in the self-hosted client");
  });
});

describe("logs tail reads this machine's log files", () => {
  it("tails an existing component log", async () => {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(join(dataDir(), "scheduler.log"), ["first", "second", "third"].join("\n"), "utf-8");

    const { data, output } = await runDaemon(["logs", "tail", "--component", "scheduler", "--lines", "2"]);
    const result = data as { component: string; files: Array<{ exists: boolean; text: string }> };

    expect(result.component).toBe("scheduler");
    expect(result.files[0]?.exists).toBe(true);
    expect(result.files[0]?.text).toBe("second\nthird");
    expect(output).toContain("second");
    expect(output).not.toContain("not available in the self-hosted client");
  });

  it("says the log is absent instead of refusing", async () => {
    const { data, output } = await runDaemon(["logs", "tail", "--component", "inbound"]);
    const result = data as { files: Array<{ exists: boolean }> };

    expect(result.files.every((file) => !file.exists)).toBe(true);
    expect(output).toContain("No inbound log files found");
    // An empty tail must not read as "the deployment produced no logs": nothing in
    // this package writes these files, and the server's logs are not on /v1.
    expect(output).toContain("no process in this package writes them");
    expect(output).toContain("not published over /v1");
  });

  it("still rejects an unknown component", async () => {
    const originalExit = process.exit;
    const originalError = console.error;
    const errors: string[] = [];
    console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
    process.exit = ((code?: number) => { throw new Error(`process.exit:${code ?? 0}`); }) as typeof process.exit;
    try {
      await expect(runDaemon(["logs", "tail", "--component", "nope"])).rejects.toThrow("process.exit:1");
      expect(errors.join("\n")).toContain("Unknown log component: nope");
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
  });
});
