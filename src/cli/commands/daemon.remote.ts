import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "../../lib/chalk-lite.js";
import { getEmailsDataDir } from "../../lib/config.js";
import { getProvisioningWorkSummary } from "../../db/provisioning.js";
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
 * The provisioning queue counts come from the routed provisioning repository,
 * which reads `GET /v1/provisioning` in this mode — the same route
 * `emails status` already reports the provisioning block from. The realtime
 * block is carried through EXACTLY as the status facts produce it: over /v1 it
 * is an availability gap (`queue_configured: null`), and rendering that as
 * "not configured" would be a fabricated negative claim.
 */
async function daemonStatus() {
  const { getEmailSystemStatusForRuntime } = await import("../../lib/agent-context.js");
  const now = new Date().toISOString();
  const queue = getProvisioningWorkSummary(now);
  const system = await getEmailSystemStatusForRuntime();
  return {
    generated_at: now,
    queue: {
      due_domains: queue.due_domains,
      due_addresses: queue.due_addresses,
      failed_domains: queue.failed_domains,
      failed_addresses: queue.failed_addresses,
      drainable: false,
    },
    realtime: system.inbox.realtime,
    // No client-side start command is advertised. Realtime ingestion runs on the
    // operator's server, and `emails inbox watch` refuses in this mode — naming
    // it here would propose a remedy that throws.
    start_commands: {},
  };
}

function formatDaemonStatus(status: Awaited<ReturnType<typeof daemonStatus>>): string {
  const lines = [chalk.bold("\nDaemon status:")];
  lines.push(`  Due work:   ${status.queue.due_domains} domain(s), ${status.queue.due_addresses} address(es)`);
  lines.push(`  Failed:     ${status.queue.failed_domains} domain(s), ${status.queue.failed_addresses} address(es)`);
  const realtime = status.realtime;
  if (realtime.queue_configured === null) {
    lines.push(`  Realtime:   ${chalk.dim("unavailable")} (${realtime.availability.reason})`);
  } else {
    lines.push(`  Realtime:   ${realtime.queue_configured ? chalk.green("configured") : chalk.yellow("not configured")}`);
    if (realtime.last_poll_at) lines.push(`  Last poll:  ${chalk.green(realtime.last_poll_at)}`);
    if (realtime.last_error) lines.push(`  Last error: ${chalk.red(realtime.last_error)}`);
  }
  lines.push("");
  if (status.queue.due_domains > 0 || status.queue.failed_domains > 0 || status.queue.due_addresses > 0 || status.queue.failed_addresses > 0) {
    lines.push(chalk.yellow("  No provisioning reconciler ships in this build; the queue above is not drained automatically."));
  }
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
    .action(async () => {
      try {
        const status = await daemonStatus();
        const result = {
          managed_process: false,
          reason: "No built-in supervisor or PID file is configured for this package; "
            + "background workers run on the self-hosted server.",
          start_commands: status.start_commands,
          cli_equivalent: "emails daemon status --json",
        };
        output(result, chalk.yellow("No managed email daemon process is configured in this client."));
      } catch (e) {
        handleError(e);
      }
    });

  // Log tailing is a PROCESS-LOCAL concern in either mode: it reads whatever this
  // machine's `emails` processes wrote under the data directory. It opens no
  // database and makes no request, so there is nothing here for a server to own.
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
          : chalk.dim(`No local ${component} log files found in ${getEmailsDataDir()}.`);
        output(result, formatted);
      } catch (e) {
        handleError(e);
      }
    });
}
