import type { Command } from "commander";
import { handleError } from "../utils.js";

// Local daemon/log diagnostics (provisioning/realtime queue status, worker
// restart guidance, local log tailing) have no /v1 equivalent: background
// workers and their logs live on the self-hosted server. This client is
// self-hosted-only, so these commands are kept for discoverability but fail
// loud. Use the operator service /health and /ready probes instead.
function serverOnly(command: string): never {
  throw new Error(
    `${command} is not available in the self-hosted client; it runs on the self-hosted server.`,
  );
}

export function registerDaemonCommands(program: Command, _output: (data: unknown, formatted: string) => void): void {
  const daemon = program.command("daemon").description("Inspect local email daemon and background worker health");

  daemon
    .command("status")
    .description("Show provisioning/realtime daemon queue status")
    .action(async () => {
      try { serverOnly("emails daemon status"); } catch (e) { handleError(e); }
    });

  daemon
    .command("restart")
    .description("Show restart guidance for configured email background workers")
    .action(async () => {
      try { serverOnly("emails daemon restart"); } catch (e) { handleError(e); }
    });

  const logs = program.command("logs").description("Inspect local emails logs");
  logs
    .command("tail")
    .description("Tail local emails logs")
    .option("--component <name>", "daemon | sync | inbound | scheduler | nightly", "daemon")
    .option("--lines <n>", "Lines to show from each file", "80")
    .action(() => {
      try { serverOnly("emails logs tail"); } catch (e) { handleError(e); }
    });
}
