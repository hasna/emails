import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "../../lib/chalk-lite.js";
import { getDataDir, getDatabase } from "../../db/database.js";
import { getProvisioningWorkSummary } from "../../db/provisioning.js";
import {
  renderStatusCount,
  renderStatusUnavailable,
  type StatusAvailability,
} from "../../lib/status-availability.js";
import { createSqliteEmailStore } from "../../store-sqlite/index.js";
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
 * The provisioning queue, over the store seam.
 *
 * `getProvisioningWorkSummary` used to be four SQL `COUNT(*)`s and four bare integers. The
 * seam publishes NO count operation, so the four numbers now come from a bounded client-side
 * enumeration and each is `number | null` with a `StatusAvailability` record saying whether
 * the read finished. They are rendered through `renderStatusCount` for exactly that reason —
 * an incomplete enumeration prints `≥N`, a read that did not happen prints its reason, and
 * neither prints a confident integer it has not earned. That is what the self-hosted sibling
 * (`daemon.remote.ts`) already does, and its header records the shape of the failure on the
 * other side of the fence: "600 due domains rendered as `Due work: 500 domain(s)`".
 *
 * The store is built from THIS handle rather than the configured one, so every fact on this
 * page comes from one dataset.
 */
async function daemonStatus() {
  const db = getDatabase();
  const { getEmailSystemStatusForRuntime } = await import("../../lib/agent-context.js");
  const now = new Date().toISOString();
  const queue = await getProvisioningWorkSummary(
    now,
    createSqliteEmailStore({ database: db, detail: "SQLite (daemon status)" }),
  );
  const system = await getEmailSystemStatusForRuntime();
  return {
    generated_at: now,
    queue: {
      availability: queue.availability,
      due_domains: queue.due_domains,
      due_addresses: queue.due_addresses,
      failed_domains: queue.failed_domains,
      failed_addresses: queue.failed_addresses,
      drainable: false,
    },
    realtime: system.inbox.realtime,
    // The provisioning queue below is REPORTED but never drained: no
    // provisioning reconciler ships in this build (`emails provision daemon`
    // is not implemented). Advertising a start command for it told operators to
    // run something that always throws, so it is gone; `queue.drainable`
    // states the truth for scripts.
    start_commands: {
      realtime_watch: "emails inbox watch --all-buckets",
    },
  };
}

/** A number the queue reported, or null when it did not. `>` on a null is false, not zero. */
function positive(value: number | null): boolean {
  return value !== null && value > 0;
}

/**
 * What the renderer below needs, declared rather than inferred from `daemonStatus`.
 *
 * EXPORTED SO THE RENDERER CAN BE PINNED DIRECTLY. Two earlier collapses in this programme
 * carried a lower bound correctly in the payload and DROPPED it in the formatter, so the
 * operator still read a confident integer; the only way to catch that is to assert the
 * rendered text for an availability record a real store rarely produces. Declaring the shape
 * narrowly (rather than exporting `typeof daemonStatus`) also keeps the test free of the
 * agent-context status block, which this function never reads past three fields.
 */
export interface DaemonQueueView {
  availability: StatusAvailability;
  due_domains: number | null;
  due_addresses: number | null;
  failed_domains: number | null;
  failed_addresses: number | null;
}

export interface DaemonStatusView {
  queue: DaemonQueueView;
  realtime: {
    queue_configured: boolean | null;
    last_poll_at: string | null;
    last_error: string | null;
    availability?: StatusAvailability;
  };
  start_commands: { realtime_watch: string };
}

export function formatDaemonStatus(status: DaemonStatusView): string {
  const lines = [chalk.bold("\nDaemon status:")];
  const queue = status.queue;
  if (!queue.availability.available) {
    // NOT four zeros. The counts are null because nothing was read, and a zero here would
    // read as "there is no work" to the operator whose queue is the reason they ran this.
    lines.push(`  Provisioning: ${renderStatusUnavailable(queue.availability)}`);
  } else {
    const count = (value: number | null) => renderStatusCount(value, queue.availability);
    lines.push(`  Due work:   ${count(queue.due_domains)} domain(s), ${count(queue.due_addresses)} address(es)`);
    lines.push(`  Failed:     ${count(queue.failed_domains)} domain(s), ${count(queue.failed_addresses)} address(es)`);
    if (queue.availability.complete === false) {
      lines.push(chalk.yellow(`  Counts are LOWER BOUNDS: ${queue.availability.reason ?? "the enumeration could not be completed"}`));
    }
  }
  // `queue_configured` IS NULLABLE AND NULL IS NOT `false`. `realtimeBlock`
  // (src/lib/status-facts.ts) nulls all four realtime fields whenever the config file cannot
  // be read, and this line used to render that null as "not configured" — a confident negative
  // claim about a measurement that did not happen, in the one command an operator runs to find
  // out whether ingestion is running. Every other renderer of this exact field already guards
  // it (`daemon.remote.ts`, `inbox-sync-status-format.ts`, `agent-context.ts`); this one did
  // not, and widening the field's declared type without widening the branch is what made it
  // visible. Adversarial review caught it.
  const realtimeLabel = status.realtime.queue_configured === null
    ? renderStatusUnavailable(status.realtime.availability)
    : status.realtime.queue_configured
      ? chalk.green("configured")
      : chalk.yellow("not configured");
  lines.push(`  Realtime:   ${realtimeLabel}`);
  if (status.realtime.last_poll_at) lines.push(`  Last poll:  ${chalk.green(status.realtime.last_poll_at)}`);
  if (status.realtime.last_error) lines.push(`  Last error: ${chalk.red(status.realtime.last_error)}`);
  lines.push("");
  // A LOWER BOUND above zero is still work to drain, and an unavailable read is not proof
  // that there is none — so the guidance shows unless the queue was read and was empty.
  if (
    !queue.availability.available
    || positive(queue.due_domains) || positive(queue.failed_domains)
    || positive(queue.due_addresses) || positive(queue.failed_addresses)
  ) {
    lines.push(chalk.yellow("  No provisioning reconciler ships in this build; the queue above is not drained automatically."));
    lines.push(chalk.dim("  Provision manually: emails domain adopt <domain> --provider <id>"));
  }
  lines.push(chalk.dim(`  Start realtime:    ${status.start_commands.realtime_watch}`));
  return lines.join("\n");
}

function readTail(component: LogComponent, lines: number): { component: LogComponent; files: Array<{ path: string; exists: boolean; text: string }> } {
  const dir = getDataDir();
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
  const daemon = program.command("daemon").description("Inspect local email daemon and background worker health");

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
    .action(async () => {
      try {
        const status = await daemonStatus();
        const result = {
          managed_process: false,
          reason: "No built-in supervisor or PID file is configured for this package.",
          start_commands: status.start_commands,
          cli_equivalent: "emails daemon status --json",
        };
        output(result, [
          chalk.yellow("No managed email daemon process is configured."),
          chalk.dim(`Start realtime:    ${status.start_commands.realtime_watch}`),
        ].join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  const logs = program.command("logs").description("Inspect local emails logs");
  logs
    .command("tail")
    .description("Tail local emails logs")
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
          : chalk.dim(`No local ${component} log files found in ${getDataDir()}.`);
        output(result, formatted);
      } catch (e) {
        handleError(e);
      }
    });
}
