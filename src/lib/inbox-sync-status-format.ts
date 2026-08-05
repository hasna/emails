// Single renderer for `emails inbox sync-status`.
//
// This was duplicated byte-for-byte in src/cli/commands/inbox.local.ts and
// inbox.remote.ts, and BOTH copies painted a literal yellow `0` for the inbound
// bucket count plus `0 legacy, 0 orphaned` sources — numbers the self-hosted
// client never measured. One copy now, and it renders an unmeasured field as
// "unavailable" with its reason instead of as a confident zero.

import chalk from "./chalk-lite.js";
import { formatStatusDataGaps, type EmailSystemStatus } from "./agent-context.js";
import { renderStatusCount, renderStatusUnavailable } from "./status-availability.js";
import { isCommandAvailableInMode } from "./status-commands.js";

export function formatInboxSyncStatus(status: EmailSystemStatus): string {
  const lines: string[] = [chalk.bold("\nInbox sync status:")];
  // The mode note comes FIRST and in red, above any count. When an explicit
  // local-mode selector shadows a configured EMAILS_CLIENT_ENV_SECRET pointer, every
  // number below describes the LOCAL database — usually an empty one — while the
  // operator believes they are looking at the self-hosted deployment. Printing
  // "0 total, 0 unread" with no note is how a ~170,000-message deployment read as
  // an empty mailbox during the 2026-07-27 incident. A wrong-database reading is not a
  // footnote to the counts, it invalidates them.
  if (status.mode.warning) {
    lines.push(`  ${chalk.red("Mode note:")}   ${status.mode.warning}`);
  }
  lines.push(`  Local inbox: ${status.inbox.total} total, ${status.inbox.unread} unread`);
  lines.push(`  Folders:     ${status.mailboxes.counts.inbox} inbox, ${status.mailboxes.counts.sent} sent, ${status.mailboxes.counts.archived} archived`);
  lines.push(`  Latest mail: ${status.inbox.latest_received_at ? chalk.green(status.inbox.latest_received_at) : chalk.dim("never")}`);

  const classification = status.sources.legacy === null || status.sources.orphaned === null
    ? chalk.dim("classification unavailable")
    : `${status.sources.legacy} legacy, ${status.sources.orphaned} orphaned`;
  lines.push(`  Sources:     ${renderStatusCount(status.sources.total, status.sources.availability)} ingestion source(s), ${classification}`);
  for (const source of status.sources.items.filter((item) => item.kind !== "all").slice(0, 5)) {
    const badges = source.badges.length ? chalk.dim(` [${source.badges.join(", ")}]`) : "";
    lines.push(`    - ${source.label}${badges}: ${source.total} total, ${source.unread} unread`);
  }
  if (status.sources.configured.availability.available) {
    const byStatus = status.sources.configured.by_status ?? {};
    const detail = Object.entries(byStatus).map(([key, count]) => `${count} ${key}`).join(", ");
    lines.push(`  Server sources: ${renderStatusCount(status.sources.configured.total, status.sources.configured.availability)}${detail ? chalk.dim(` (${detail})`) : ""}`);
    if (status.sources.configured.latest_last_synced_at) {
      lines.push(`  Last sync:   ${chalk.green(status.sources.configured.latest_last_synced_at)}`);
    }
  }

  const buckets = status.inbox.inbound_buckets;
  if (buckets.items === null || buckets.total === null) {
    lines.push(`  S3 buckets:  ${chalk.dim(renderStatusUnavailable(buckets.availability))}`);
  } else {
    lines.push(`  S3 buckets:  ${buckets.total > 0 ? chalk.green(String(buckets.total)) : chalk.yellow("0")}`);
    for (const bucket of buckets.items) {
      lines.push(`    - s3://${bucket.bucket} ${chalk.dim(bucket.region)}${bucket.providerId ? chalk.dim(` provider=${bucket.providerId.slice(0, 8)}`) : ""}`);
    }
  }

  const realtime = status.inbox.realtime;
  if (realtime.queue_configured === null) {
    lines.push(`  Realtime:    ${chalk.dim(renderStatusUnavailable(realtime.availability))}`);
  } else {
    lines.push(`  Realtime:    ${realtime.queue_configured ? chalk.green("configured") : chalk.yellow("not configured")}`);
    if (realtime.last_poll_at) lines.push(`  Last poll:   ${chalk.green(realtime.last_poll_at)}`);
    if (realtime.last_error) lines.push(`  Last error:  ${chalk.red(realtime.last_error)}`);
  }

  lines.push(...formatStatusDataGaps(status));

  // Only advertise commands that actually run in this mode: `emails pull` and
  // `emails inbox watch` both refuse in self_hosted (the server owns ingestion),
  // so printing them there is the same defect in hint form.
  //
  // The verb is `emails pull` (alias `emails provider sync`). This used to read
  // `emails refresh`, which is not a registered command in ANY mode — it exits
  // with "error: unknown command 'refresh'". The per-mode filter could not save
  // it, because `emails refresh` was listed only under
  // SELF_HOSTED_REFUSED_COMMANDS, so local mode printed the dead verb happily.
  // An operator followed the hint and hit that dead end (2026-07-27).
  const hints: Array<[string, string]> = [
    ["emails pull", "Pull now"],
    ["emails inbox watch --all-buckets", "Watch realtime"],
  ];
  const usable = hints.filter(([command]) => isCommandAvailableInMode(command, status.mode.current));
  if (usable.length > 0) {
    lines.push("");
    for (const [command, label] of usable) lines.push(chalk.dim(`  ${label}: ${command}`));
  }
  lines.push("");
  return lines.join("\n");
}
