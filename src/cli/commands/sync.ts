import type { Command } from "commander";
import { handleError } from "../utils.js";

// Provider event ingestion, local sent-log stats/analytics and the local
// monitor are owned by the self-hosted server. This client is self-hosted-only,
// so these commands are kept for CLI discoverability but fail loud: there is no
// local island to sync/aggregate and no /v1 equivalent to route them through.
function serverOnly(command: string): never {
  throw new Error(
    `${command} is not available in the self-hosted client; it runs on the self-hosted server.`,
  );
}

export function registerSyncCommands(program: Command, _output: (data: unknown, formatted: string) => void): void {
  // ─── PROVIDER SYNC ────────────────────────────────────────────────────────────
  const providerCmd = program.commands.find(c => c.name() === "provider");
  if (providerCmd) {
    providerCmd
      .command("sync")
      .description("Sync delivery events from all providers")
      .option("--provider <id>", "Specific provider ID")
      .action(async () => {
        try { serverOnly("emails provider sync"); } catch (e) { handleError(e); }
      });
  }

  // ─── PULL ─────────────────────────────────────────────────────────────────────
  program
    .command("pull")
    .description("Sync events from provider(s) (alias: emails provider sync)")
    .option("--provider <id>", "Provider ID (syncs all if not specified)")
    .option("--watch", "Keep syncing on an interval")
    .option("--interval <duration>", "Watch interval (e.g. 30s, 5m, 1h)", "5m")
    .action(async () => {
      try { serverOnly("emails pull"); } catch (e) { handleError(e); }
    });

  // ─── STATS ────────────────────────────────────────────────────────────────────
  program
    .command("stats")
    .description("Show email delivery statistics")
    .option("--provider <id>", "Provider ID")
    .option("--period <period>", "Period: 7d, 30d, 90d", "30d")
    .option("--inbox", "Show inbound email stats instead of outbound")
    .action(() => {
      try { serverOnly("emails stats"); } catch (e) { handleError(e); }
    });

  // ─── MONITOR ──────────────────────────────────────────────────────────────────
  program
    .command("monitor")
    .description("Live monitor with auto-refresh")
    .option("--provider <id>", "Provider ID")
    .option("--interval <seconds>", "Refresh interval in seconds", "30")
    .action(async () => {
      try { serverOnly("emails monitor"); } catch (e) { handleError(e); }
    });

  // ─── ANALYTICS ────────────────────────────────────────────────────────────────
  program
    .command("analytics")
    .description("Show email analytics (daily volume, top recipients, busiest hours, delivery trend)")
    .option("--provider <id>", "Filter by provider ID")
    .option("--period <period>", "Time period (e.g. 30d, 7d, 90d)", "30d")
    .action(() => {
      try { serverOnly("emails analytics"); } catch (e) { handleError(e); }
    });
}
