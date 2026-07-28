import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createDomain } from "../../db/domains.local.js";
import { createProvider } from "../../db/providers.local.js";
import { setDomainProvisioning } from "../../db/provisioning.js";
import { formatDaemonStatus, registerDaemonCommands } from "./daemon.local.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}
function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

async function runDaemonCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerDaemonCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

beforeEach(() => {
  captureInheritedProcessEnv();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  restoreInheritedProcessEnv();
});

describe("daemon commands", () => {
  it("reports queue status without requiring a process manager", async () => {
    const result = await runDaemonCommand(["daemon", "status"]);
    expect(result.out).toContain("Daemon status");
    expect(result.data).toMatchObject({ queue: { due_domains: 0, due_addresses: 0 } });
  });

  it("restart returns managed-process guidance", async () => {
    const result = await runDaemonCommand(["daemon", "restart"]);
    expect(result.out).toContain("No managed email daemon process");
    expect(result.data).toMatchObject({ managed_process: false });
  });

  // Regression: `daemon status` used to print
  //   "Start provisioner: emails provision daemon --provider <p> --bucket <b>"
  // and expose it as start_commands.provisioner_loop. That command's action is an
  // unconditional throw — no reconciler ships in this build — so the status
  // output told operators to run something that cannot work, while implying the
  // queue below it would eventually drain.
  it("never advertises a provisioning daemon and says the queue is not drained", async () => {
    getDatabase();
    const provider = createProvider({ name: "ses", type: "ses", active: true });
    const domain = createDomain(provider.id, "due.example.com");
    await setDomainProvisioning(domain.id, {
      provisioning_status: "ses_identity_created",
      next_check_at: "2020-01-01T00:00:00.000Z",
    });

    const result = await runDaemonCommand(["daemon", "status"]);
    expect(result.data).toMatchObject({ queue: { due_domains: 1, drainable: false } });
    expect(result.data).not.toHaveProperty("start_commands.provisioner_loop");
    expect(JSON.stringify(result.data)).not.toContain("emails provision");

    expect(result.out).toContain("No provisioning reconciler ships in this build");
    expect(result.out).toContain("emails domain adopt");
    expect(result.out).not.toContain("emails provision");
  });

  // ── the queue counts are no longer four bare integers ─────────────────────────
  //
  // `getProvisioningWorkSummary` used to be four SQL `COUNT(*)`s. The store seam publishes NO
  // count operation, so they come from a bounded client-side enumeration now and carry a
  // `StatusAvailability` record. THE RENDERER IS THE POINT OF THESE THREE CASES: two earlier
  // collapses in this programme carried the bound in the payload and dropped it in the
  // formatter, so the operator still read a confident integer.

  it("prints the counts as LOWER BOUNDS when the enumeration could not finish", async () => {
    const provider = createProvider({ name: "ses", type: "ses", active: true });
    const domain = createDomain(provider.id, "due.example.com");
    await setDomainProvisioning(domain.id, {
      provisioning_status: "ses_identity_created",
      next_check_at: "2020-01-01T00:00:00.000Z",
    });
    // A store whose window MOVES under paging: the enumeration answers rows but cannot call
    // them all of them. Injected by giving the command a database whose domain list drops the
    // first row of every page after the first — see src/db/provisioning.test.ts for the same
    // fixture and why one is not enough.
    const status = {
      generated_at: "2026-01-01T00:00:00.000Z",
      queue: {
        availability: {
          available: true,
          reason: "enumeration_cap_exceeded:200 pages — counts are lower bounds, not totals",
          source: "store:provisioning_queue",
          basis: "client_enumeration" as const,
          complete: false,
        },
        due_domains: 500,
        due_addresses: 0,
        failed_domains: 0,
        failed_addresses: 0,
        drainable: false,
      },
      realtime: { queue_configured: false, last_poll_at: null, last_error: null },
      start_commands: { realtime_watch: "emails inbox watch --all-buckets" },
    };
    const rendered = formatDaemonStatus(status);
    expect(rendered).toContain("≥500 domain(s)");
    expect(rendered).toContain("Counts are LOWER BOUNDS");
    expect(rendered).toContain("counts are lower bounds, not totals");
    // A bound above zero is still work to drain.
    expect(rendered).toContain("No provisioning reconciler ships in this build");
  });

  it("prints the reason, not four zeros, when the queue could not be read at all", async () => {
    const status = {
      generated_at: "2026-01-01T00:00:00.000Z",
      queue: {
        availability: {
          available: false,
          reason: "source_unreachable:provisioning_queue_domains — connection reset",
          source: "store:provisioning_queue",
          basis: null,
          complete: null,
        },
        due_domains: null,
        due_addresses: null,
        failed_domains: null,
        failed_addresses: null,
        drainable: false,
      },
      realtime: { queue_configured: false, last_poll_at: null, last_error: null },
      start_commands: { realtime_watch: "emails inbox watch --all-buckets" },
    };
    const rendered = formatDaemonStatus(status);
    expect(rendered).toContain("unavailable");
    expect(rendered).toContain("connection reset");
    // NOT a zero anywhere in the queue block, and not a bare "Due work:" line either.
    expect(rendered).not.toContain("Due work:");
    expect(rendered).not.toContain("0 domain(s)");
    // An unreadable queue is NOT proof there is no work, so the guidance still shows.
    expect(rendered).toContain("No provisioning reconciler ships in this build");
  });

  it("CONTROL: a complete read prints bare integers with no bound marker", async () => {
    const status = {
      generated_at: "2026-01-01T00:00:00.000Z",
      queue: {
        availability: {
          available: true,
          reason: null,
          source: "store:provisioning_queue",
          basis: "client_enumeration" as const,
          complete: true,
        },
        due_domains: 3,
        due_addresses: 0,
        failed_domains: 0,
        failed_addresses: 0,
        drainable: false,
      },
      realtime: { queue_configured: false, last_poll_at: null, last_error: null },
      start_commands: { realtime_watch: "emails inbox watch --all-buckets" },
    };
    const rendered = formatDaemonStatus(status);
    expect(rendered).toContain("Due work:   3 domain(s), 0 address(es)");
    expect(rendered).not.toContain("≥");
    expect(rendered).not.toContain("LOWER BOUNDS");
  });

  it("carries the availability record into the JSON payload", async () => {
    const result = await runDaemonCommand(["daemon", "status"]);
    expect(result.data).toMatchObject({
      queue: { availability: { available: true, complete: true, basis: "client_enumeration" } },
    });
  });
});
