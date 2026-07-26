import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createDomain } from "../../db/domains.local.js";
import { createProvider } from "../../db/providers.local.js";
import { setDomainProvisioning } from "../../db/provisioning.local.js";
import { registerDaemonCommands } from "./daemon.local.js";

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
    setDomainProvisioning(domain.id, {
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
});
