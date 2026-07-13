import type { Stats } from "../types/index.js";

// Delivery statistics aggregate the local `events` table (delivered/bounced/
// complained/opened/clicked). That table has NO `/v1` representation in the
// self-hosted client — delivery events are recorded and aggregated on the
// operator's server — so this stub fails loud rather than fabricating rates.
export function getLocalStats(_providerId?: string, _period = "30d"): Stats {
  throw new Error(
    "getLocalStats is not available in the self-hosted client; it aggregates the delivery events table, which runs on the self-hosted server.",
  );
}

export function formatStatsTable(stats: Stats): string {
  const lines = [
    `Provider: ${stats.provider_id}   Period: ${stats.period}`,
    ``,
    `  Sent:         ${stats.sent}`,
    `  Delivered:    ${stats.delivered}  (${stats.delivery_rate.toFixed(1)}%)`,
    `  Bounced:      ${stats.bounced}  (${stats.bounce_rate.toFixed(1)}%)`,
    `  Complained:   ${stats.complained}`,
    `  Opened:       ${stats.opened}  (${stats.open_rate.toFixed(1)}%)`,
    `  Clicked:      ${stats.clicked}`,
  ];
  return lines.join("\n") + "\n";
}
