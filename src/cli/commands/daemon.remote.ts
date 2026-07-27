import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "../../lib/chalk-lite.js";
import { getEmailsDataDir } from "../../lib/config.js";
import { renderStatusCount, renderStatusUnavailable } from "../../lib/status-availability.js";
import { handleError } from "../utils.js";

type LogComponent = "daemon" | "sync" | "inbound" | "scheduler" | "nightly";

const LOG_FILES: Record<LogComponent, string[]> = {
  daemon: ["daemon.log", "provision-daemon.log"],
  sync: ["sync.log", "nightly-sync.log"],
  inbound: ["inbound.log", "watch.log"],
  scheduler: ["scheduler.log"],
  nightly: ["nightly-sync.log"],
};

/**
 * The provisioning queue, taken from the SAME status facts `emails status` reports.
 *
 * This used to call `getProvisioningWorkSummary()` (src/db/provisioning.remote.ts),
 * which is a single `list({ limit: 1000 })` against `/v1/domains` and
 * `/v1/addresses` — not `/v1/provisioning`, which holds only the audit trail. The
 * server clamps every list to 500 rows, so those four counts were computed over at
 * most the first 500 rows of each resource and printed as bare integers: 600 due
 * domains rendered as `Due work: 500 domain(s)`.
 *
 * The honest answer was already in hand and thrown away.
 * `getEmailSystemStatusForRuntime()` is awaited here anyway, and its `provisioning`
 * block is built by `enumerateSelfHostedRows` and carries
 * `availability.complete === false` with the reason "counts are lower bounds, not
 * totals" whenever it cannot walk the table.
 *
 * Two consequences, both deliberate:
 *  - the counts render through `renderStatusCount`, so an incomplete read prints
 *    `≥N` exactly as `emails status` does, and `availability` is carried in the JSON
 *    so `scanStatusAvailability` can see it;
 *  - the fields are named for what they MEASURE. `pending` is not `due`: a
 *    schedule-aware "due now" count needs `next_check_at <= now` over the WHOLE
 *    table, which this client cannot establish completely over `/v1`. Reporting
 *    pending under the old `due_*` keys would have kept the label and quietly
 *    changed the question.
 */
async function daemonStatus() {
  const { getEmailSystemStatusForRuntime } = await import("../../lib/agent-context.js");
  const now = new Date().toISOString();
  const system = await getEmailSystemStatusForRuntime();
  return {
    generated_at: now,
    queue: {
      availability: system.provisioning.availability,
      domains_pending: system.provisioning.domains_pending,
      domains_failed: system.provisioning.domains_failed,
      addresses_pending: system.provisioning.addresses_pending,
      addresses_failed: system.provisioning.addresses_failed,
      // A schedule-aware "due now" count is NOT derivable here; see the note above.
      due_derivable: false,
      drainable: false,
    },
    realtime: system.inbox.realtime,
    // No client-side start command is advertised. Realtime ingestion runs on the
    // operator's server, and `emails inbox watch` refuses in this mode — naming it
    // here would propose a remedy that throws.
    start_commands: {},
  };
}

function formatDaemonStatus(status: Awaited<ReturnType<typeof daemonStatus>>): string {
  const lines = [chalk.bold("\nDaemon status:")];
  const queue = status.queue;
  if (!queue.availability.available) {
    lines.push(`  Provisioning: ${renderStatusUnavailable(queue.availability)}`);
  } else {
    const count = (value: number | null) => renderStatusCount(value, queue.availability);
    lines.push(`  Pending:    ${count(queue.domains_pending)} domain(s), ${count(queue.addresses_pending)} address(es)`);
    lines.push(`  Failed:     ${count(queue.domains_failed)} domain(s), ${count(queue.addresses_failed)} address(es)`);
    if (queue.availability.complete === false) {
      lines.push(chalk.yellow(`  Counts are LOWER BOUNDS: ${queue.availability.reason ?? "the enumeration could not be completed"}`));
    }
  }
  // The realtime block is an availability gap over /v1 in every case
  // (src/lib/status-facts.remote.ts realtimeGap), so it is rendered as one. There is
  // no "configured / not configured" branch here because there is no measurement to
  // branch on, and `not configured` would be a fabricated negative claim.
  lines.push(`  Realtime:   ${renderStatusUnavailable(status.realtime.availability)}`);
  lines.push("");
  lines.push(chalk.dim("  No schedule-aware 'due now' count is derivable over /v1; pending/failed are shown instead."));
  lines.push(chalk.dim("  No provisioning reconciler ships in this build; the queue above is not drained automatically."));
  lines.push(chalk.dim("  Realtime ingestion runs on the self-hosted server; this client starts no worker."));
  return lines.join("\n");
}

function readTail(component: LogComponent, lines: number): { component: LogComponent; files: Array<{ path: string; exists: boolean; text: string }> } {
  const dir = getEmailsDataDir();
  return {
    component,
    files: LOG_FILES[component].map((name) => {
      const path = join(dir, name);
      if (!existsSync(path)) return { path, exists: false, text: "" };
      const text = readFileSync(path, "utf-8").split(/\r?\n/).slice(-Math.max(1, lines)).join("\n");
      return { path, exists: true, text };
    }),
  };
}

export function registerDaemonCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const daemon = program.command("daemon").description("Inspect email daemon and background worker health");

  daemon
    .command("status")
    .description("Show provisioning/realtime daemon queue status")
    .action(async () => {
      try {
        const status = await daemonStatus();
        output(status, formatDaemonStatus(status));
      } catch (e) {
        handleError(e);
      }
    });

  daemon
    .command("restart")
    .description("Show restart guidance for configured email background workers")
    .action(() => {
      try {
        // Every field below is a constant. This used to `await daemonStatus()` first,
        // which cost four `/v1` enumerations and turned a fixed answer into one that
        // failed with a transport error whenever the service was unreachable — the
        // question "is a supervisor configured in THIS process?" does not depend on
        // the server being up.
        const result = {
          managed_process: false,
          reason: "No built-in supervisor or PID file is configured for this package; "
            + "background workers run on the self-hosted server.",
          start_commands: {},
          cli_equivalent: "emails daemon status --json",
        };
        output(result, chalk.yellow("No managed email daemon process is configured in this client."));
      } catch (e) {
        handleError(e);
      }
    });

  // Log tailing is PROCESS-LOCAL: it reads whatever this machine's `emails`
  // processes wrote under the data directory. It opens no database and makes no
  // request, which is why it does not belong behind a mode guard — but it is also
  // NOT the server's log. Nothing in this package writes these files today, and the
  // operator's service logs are not published over /v1, so an empty result states
  // both of those things rather than implying the deployment produced no output.
  const logs = program.command("logs").description("Inspect emails logs written by this machine's own processes");
  logs
    .command("tail")
    .description("Tail emails logs written by this machine's processes (NOT the self-hosted server's)")
    .option("--component <name>", "daemon | sync | inbound | scheduler | nightly", "daemon")
    .option("--lines <n>", "Lines to show from each file", "80")
    .action((opts: { component: string; lines: string }) => {
      try {
        const component = opts.component as LogComponent;
        if (!LOG_FILES[component]) handleError(new Error(`Unknown log component: ${opts.component}`));
        const result = readTail(component, parseInt(opts.lines, 10) || 80);
        const existing = result.files.filter((file) => file.exists);
        const formatted = existing.length
          ? existing.map((file) => `${chalk.bold(file.path)}\n${file.text}`).join("\n\n")
          : [
            chalk.dim(`No ${component} log files found in ${getEmailsDataDir()}.`),
            chalk.dim("This reads THIS machine's files only, and no process in this package writes them"),
            chalk.dim("today. The self-hosted server's logs are not published over /v1 — read them where"),
            chalk.dim("the service runs (for example its container logs)."),
          ].join("\n");
        output({ ...result, scope: "this_machine", server_logs_available: false }, formatted);
      } catch (e) {
        handleError(e);
      }
    });
}
