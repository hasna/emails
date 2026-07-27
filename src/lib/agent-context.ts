// `emails status`, `emails agent context`, `emails inbox sync-status` and the MCP
// status resources/tools all render THIS payload. It is the first thing an
// operator or an agent reads to decide whether the system is usable, so it must
// never state a number it did not measure.
//
// HISTORY (the defect this file exists to prevent)
// ------------------------------------------------
// buildSystemStatus() used to hardcode, in both modes:
//   providers: { total: 0, active: 0, by_type: {} }
//   domains:   { total: 0, send_ready: 0, receive_ready: 0, usable: [] }
//   addresses: { total: 0, active: 0, verified: 0, owned: 0, ready_to_receive: 0, usable_from: [] }
//   inbox.inbound_buckets: []      inbox.realtime.queue_configured: false
//   sources.legacy: 0              sources.orphaned: 0
//   provisioning: four zeros       next_actions: []
// while the operator's server held 37 providers, 75 domains and 325 addresses,
// and `emails provider list` / `emails domain list` printed them in the SAME
// session. The rendered line "0/0 active provider credential(s)" told agents the
// system was unusable; "0 listed usable sender(s)" told them mail could not be
// sent from an address that had just sent mail.
//
// THE RULE NOW
// ------------
// One assembler, one shape (src/lib/status-types.ts), facts gathered through the
// mode seam (src/lib/status-facts.ts). Every field is either measured from a real
// source or `null` with a machine-readable reason in `gaps` — see
// src/lib/status-availability.ts for why `null` and not `0`/`[]`.

import { resolveMailDataSource } from "./mail-data-source.js";
import { getEmailsMode, resolveEmailsMode, type EmailsMode } from "./mode.js";
import { collectStatusFacts } from "./status-facts.js";
import { isCommandAvailableInMode } from "./status-commands.js";
import {
  renderStatusCount,
  renderStatusUnavailable,
  scanStatusAvailability,
  statusGapClass,
  statusReasonCode,
  type StatusAvailability,
} from "./status-availability.js";
import type { EmailSystemStatus, NextAction } from "./status-types.js";

export type {
  AddressesStatusBlock,
  ConfiguredSourcesStatusBlock,
  DatabaseStatusBlock,
  DomainStatusRow,
  DomainsStatusBlock,
  EmailSystemStatus,
  InboundBucketsStatusBlock,
  InboxStatusBlock,
  NextAction,
  ProvidersStatusBlock,
  ProvisioningStatusBlock,
  RealtimeStatusBlock,
  SourcesStatusBlock,
} from "./status-types.js";

const USABLE_FROM_LIMIT = 25;
const DOMAIN_READINESS_LIMIT = 25;
const SOURCE_STATUS_LIMIT = 50;

/** Command a caller can run to read a block's real inventory directly. */
const BLOCK_INVENTORY_COMMANDS: Record<string, string> = {
  providers: "emails provider list --json",
  domains: "emails domain list --json",
  addresses: "emails address list --json",
  "sources.configured": "emails inbox sync-status --json",
};

function isPositive(value: number | null): boolean {
  return typeof value === "number" && value > 0;
}

function isZero(value: number | null): boolean {
  return value === 0;
}

/**
 * Derive remediation steps from the MEASURED numbers, filtered to commands that
 * actually run in this mode. Never an unexplained `[]`: an empty list is a claim
 * ("nothing to fix"), so when nothing is wrong the list says so explicitly.
 */
function buildNextActions(
  status: Omit<EmailSystemStatus, "next_actions">,
  mode: EmailsMode,
): NextAction[] {
  const candidates: NextAction[] = [];
  const push = (command: string, reason: string): void => {
    if (!isCommandAvailableInMode(command, mode)) return;
    if (candidates.some((action) => action.command === command)) return;
    candidates.push({ command, reason });
  };

  // A source that could not be read outranks a setup gap: the operator must know
  // the read failed before acting on any number derived from it.
  for (const [path, availability] of Object.entries(status.gaps)) {
    if (statusReasonCode(availability.reason) !== "source_unreachable") continue;
    const block = path.split(".").slice(0, -1).join(".") || path;
    const command = BLOCK_INVENTORY_COMMANDS[block];
    if (command) push(command, `${block} could not be read (${availability.reason}); read the inventory directly.`);
  }

  if (isZero(status.providers.total)) push("emails provider add --help", "No provider credential is configured.");
  if (isZero(status.domains.total)) push("emails domain add --help", "No domain is registered.");
  if (isZero(status.addresses.total)) push("emails address add --help", "No email address is registered.");
  if (status.sources.total === 0) push("emails inbox sync-status", "No ingestion source is reporting mail.");

  for (const domain of status.domains.usable ?? []) {
    const command = domain.fix_commands[0];
    if (command) {
      push(command, `Domain ${domain.domain} reports: ${domain.issues[0] ?? "a readiness gap"}.`);
      break;
    }
  }

  if (isPositive(status.provisioning.domains_failed) || isPositive(status.provisioning.addresses_failed)) {
    // `?? 0` here would report an UNMEASURED half as zero failures inside the very
    // reason string that exists to be believed. renderStatusCount says
    // "unavailable" instead. `emails provision status` is deliberately NOT
    // proposed: it throws notImplementedAnywhere() in every mode, so the only
    // honest remedy is the command that shows the failed rows.
    const domains = renderStatusCount(status.provisioning.domains_failed, status.provisioning.availability);
    const addresses = renderStatusCount(status.provisioning.addresses_failed, status.provisioning.availability);
    const failures = `${domains} domain(s), ${addresses} address(es)`;
    push("emails domain list --json", `Provisioning failed for ${failures}; inspect the rows directly.`);
    push("emails address list --json", `Provisioning failed for ${failures}; inspect the address rows directly.`);
  }

  if (candidates.length === 0) {
    return [{
      command: null,
      reason: "No setup gap or failure is visible in the data this mode can read. "
        + "Check `unavailable` for fields that were not measured.",
    }];
  }
  return candidates.slice(0, 5);
}

async function buildSystemStatus(): Promise<EmailSystemStatus> {
  const mode = resolveEmailsMode();
  const ds = resolveMailDataSource();
  const [counts, mailboxes, mailboxSources] = await Promise.all([
    ds.mailboxCounts(),
    ds.listMailboxStatus(),
    ds.listMailboxSources({ limit: Math.max(SOURCE_STATUS_LIMIT + 1, 1000), includeLatest: false }),
  ]);
  const primarySource = mailboxSources[0];
  const receivedTotal = counts.inbox + counts.archived + counts.spam + counts.trash;

  const facts = collectStatusFacts({
    mailboxSources,
    domainLimit: DOMAIN_READINESS_LIMIT,
    usableFromLimit: USABLE_FROM_LIMIT,
    sourceLimit: SOURCE_STATUS_LIMIT,
  });

  // Assemble the blocks first, then DERIVE the top-level gap index from them.
  // Nothing here is a placeholder: `unavailable` / `incomplete` / `degraded` are
  // computed from the assembled payload, never initialised to an empty default.
  const blocks = {
    generated_at: new Date().toISOString(),
    mode: {
      current: mode.mode,
      label: mode.label,
      source: mode.source,
      warning: mode.warning,
    },
    database: facts.database,
    providers: facts.providers,
    domains: facts.domains,
    addresses: facts.addresses,
    inbox: {
      total: receivedTotal,
      unread: counts.unread,
      latest_received_at: primarySource?.latestReceivedAt ?? null,
      inbound_buckets: facts.inboundBuckets,
      realtime: facts.realtime,
    },
    mailboxes,
    sources: facts.sources,
    provisioning: facts.provisioning,
    cli_equivalents: {
      status: "emails status --json",
      inbox_sync_status: "emails inbox sync-status --json",
      // NOT `emails address provision`: src/cli/commands/address.ts serverOnly()s
      // it in every mode. A cli_equivalent is a promise that the command runs.
      provision_address: "emails address add <email> --provider <provider>",
      wait_code: "emails inbox wait-code <address> --timeout 120",
      address_owner: "emails address owner <email-or-id>",
    },
  };

  const scan = scanStatusAvailability(blocks);
  const unavailable = [...new Set([...Object.keys(facts.gaps), ...scan.unavailableBlocks])].sort();

  // EVERY unavailable path carries its reason in `gaps`. The facts layer registers
  // field-level paths; the scan finds BLOCK-level ones (`database`,
  // `inbox.realtime`, …) whose reason lives on the block's own availability record.
  // Merging them means `gaps[path]` resolves for every path in `unavailable` — a
  // path listed as unavailable with no retrievable reason is just a nicer-looking
  // silence.
  const gaps: Record<string, StatusAvailability> = { ...facts.gaps };
  for (const path of scan.unavailableBlocks) {
    const availability = scan.availabilityByPath[path];
    if (availability && !gaps[path]) gaps[path] = availability;
  }

  // CLASSIFY every gap; do not assume. An unclassifiable gap counts as a FAILURE,
  // never as an expected limitation: guessing "expected" is how a real fault would
  // get hidden behind a green `degraded: false`.
  //
  // `statusGapClass` answers with THREE classes, and this loop used to test only
  // for "structural", so the third — "bound" (enumeration_cap_exceeded /
  // enumeration_unstable) — fell into `failures`. That put a number the source DID
  // answer under "Read failures — these numbers could not be measured", and into a
  // field documented as "caused by a live read failure". A lower bound is a
  // successful read of a moving table; it belongs with the other lower bounds.
  const limitations: string[] = [];
  const failures: string[] = [];
  const boundPaths: string[] = [];
  for (const path of unavailable) {
    switch (statusGapClass(gaps[path]?.reason)) {
      case "structural": limitations.push(path); break;
      case "bound": boundPaths.push(path); break;
      default: failures.push(path); break;
    }
  }
  // Field-level bounds join the block-level ones the availability scan found.
  const incomplete = [...new Set([...scan.incompleteBlocks, ...boundPaths])].sort();

  const partial: Omit<EmailSystemStatus, "next_actions"> = {
    ...blocks,
    // A bound still degrades: the caller asked for a total and got a floor.
    degraded: failures.length > 0 || incomplete.length > 0,
    limited: limitations.length > 0,
    unavailable,
    limitations,
    failures,
    incomplete,
    gaps: Object.fromEntries(Object.entries(gaps).sort(([a], [b]) => a.localeCompare(b))),
  };

  return { ...partial, next_actions: buildNextActions(partial, mode.mode) };
}

export async function getEmailSystemStatus(): Promise<EmailSystemStatus> {
  return buildSystemStatus();
}

/**
 * Runtime status for `emails status`, `emails agent context` and the MCP status
 * resources/tools. Mode-aware: local reads SQLite, self_hosted reads `/v1`.
 */
export async function getEmailSystemStatusForRuntime(): Promise<EmailSystemStatus> {
  return buildSystemStatus();
}

// ── human rendering ─────────────────────────────────────────────────────────
//
// A null NEVER renders as a number and never as an empty count. An incomplete
// count renders with `≥`. And whenever anything is unavailable, a trailing
// "Data gaps" section lists every path and reason, so an operator reading the
// terminal cannot mistake a gap for a healthy zero.

function countsLine(
  label: string,
  parts: Array<{ value: number | null; suffix: string }>,
  availability: StatusAvailability,
): string {
  if (!availability.available) return `  ${label} ${renderStatusUnavailable(availability)}`;
  const rendered = parts
    .map((part) => `${renderStatusCount(part.value, availability)} ${part.suffix}`)
    .join(", ");
  return `  ${label} ${rendered}`;
}

export function formatEmailSystemStatus(status: EmailSystemStatus): string {
  const lines: string[] = [];
  lines.push("Email system status");
  lines.push(`  Mode:       ${status.mode.current} (${status.mode.label})`);
  if (status.mode.warning) lines.push(`  Mode note:  ${status.mode.warning}`);

  if (status.providers.availability.available) {
    const active = renderStatusCount(status.providers.active, status.providers.availability);
    const total = renderStatusCount(status.providers.total, status.providers.availability);
    lines.push(`  Capabilities: ${active}/${total} active provider credential(s)`);
  } else {
    lines.push(`  Capabilities: ${renderStatusUnavailable(status.providers.availability)}`);
  }

  if (status.domains.availability.available) {
    const total = renderStatusCount(status.domains.total, status.domains.availability);
    const verified = renderStatusCount(status.domains.verified, status.domains.availability);
    const send = status.domains.send_ready === null
      ? "send-ready unavailable"
      : `${renderStatusCount(status.domains.send_ready, status.domains.availability)} send-ready`;
    const receive = status.domains.receive_ready === null
      ? "receive-ready unavailable"
      : `${renderStatusCount(status.domains.receive_ready, status.domains.availability)} receive-ready`;
    lines.push(`  Domains:   ${total} total, ${verified} verified, ${send}, ${receive}`);
  } else {
    lines.push(`  Domains:   ${renderStatusUnavailable(status.domains.availability)}`);
  }

  if (status.addresses.availability.available) {
    const usableFrom = status.addresses.usable_from === null
      ? "usable sender(s) unavailable"
      : `${status.addresses.usable_from.length}${status.addresses.usable_from_truncated ? "+" : ""} listed usable sender(s)`;
    lines.push(countsLine("Addresses:", [
      { value: status.addresses.active, suffix: "active" },
      { value: status.addresses.total, suffix: "total" },
      { value: status.addresses.owned, suffix: "owned" },
      { value: status.addresses.verified, suffix: "verified" },
    ], status.addresses.availability) + `, ${usableFrom}`);
  } else {
    lines.push(`  Addresses: ${renderStatusUnavailable(status.addresses.availability)}`);
  }

  lines.push(`  Mailboxes: ${status.mailboxes.counts.inbox} inbox, ${status.mailboxes.counts.unread} unread, ${status.mailboxes.counts.sent} sent`);
  lines.push(`  Inbox:     ${status.inbox.total} total, ${status.inbox.unread} unread${status.inbox.latest_received_at ? `, latest ${status.inbox.latest_received_at}` : ""}`);

  const classification = status.sources.legacy === null || status.sources.orphaned === null
    ? "classification unavailable"
    : `${status.sources.legacy} legacy, ${status.sources.orphaned} orphaned`;
  const realtime = status.inbox.realtime.queue_configured === null
    ? "realtime unavailable"
    : `realtime ${status.inbox.realtime.queue_configured ? "configured" : "not configured"}`;
  lines.push(`  Sources:   ${renderStatusCount(status.sources.total, status.sources.availability)} ingestion source(s), ${classification}, ${realtime}`);
  if (status.sources.configured.availability.available) {
    lines.push(`  Configured sources: ${renderStatusCount(status.sources.configured.total, status.sources.configured.availability)} on the server`);
  }
  if (status.inbox.realtime.last_error) lines.push(`  Last realtime error: ${status.inbox.realtime.last_error}`);

  if (isPositive(status.provisioning.domains_failed) || isPositive(status.provisioning.addresses_failed)) {
    // Interpolating the raw field printed the literal string "null address(es)"
    // whenever one half was measured and the other was not. renderStatusCount
    // prints "unavailable" for a null and "≥N" for a lower bound.
    const domains = renderStatusCount(status.provisioning.domains_failed, status.provisioning.availability);
    const addresses = renderStatusCount(status.provisioning.addresses_failed, status.provisioning.availability);
    lines.push(`  Provisioning failures: ${domains} domain(s), ${addresses} address(es)`);
  } else if (!status.provisioning.availability.available) {
    lines.push(`  Provisioning: ${renderStatusUnavailable(status.provisioning.availability)}`);
  }

  const actionable = status.next_actions.filter((action) => action.command !== null);
  if (actionable.length > 0) {
    lines.push("");
    lines.push("Next actions:");
    for (const action of actionable) lines.push(`  ${action.command}  — ${action.reason}`);
  }

  lines.push(...formatStatusDataGaps(status));
  return lines.join("\n");
}

/**
 * The gap signals that EVERY subset view of this payload must carry (the
 * `inbox sync-status` CLI/MCP/resource views publish `inbox`/`sources` without
 * the surrounding status).
 *
 * One function, one field list: the four subset call sites each used to enumerate
 * their own selection of `degraded`/`unavailable`/`gaps`, so they all silently
 * omitted `incomplete` — a subset consumer could therefore read
 * `sources.configured.total` as a total when the assembler knew it was a lower
 * bound. Adding a signal here reaches every view.
 */
export function statusGapSignals(status: EmailSystemStatus): {
  degraded: boolean;
  limited: boolean;
  unavailable: string[];
  failures: string[];
  limitations: string[];
  incomplete: string[];
  gaps: Record<string, StatusAvailability>;
} {
  return {
    degraded: status.degraded,
    limited: status.limited,
    unavailable: status.unavailable,
    failures: status.failures,
    limitations: status.limitations,
    incomplete: status.incomplete,
    gaps: status.gaps,
  };
}

/**
 * The mandatory "Data gaps" section. Printed by every human renderer of this
 * payload so a missing measurement is impossible to read as a healthy zero.
 *
 * Gated on the GAPS THEMSELVES, never on `degraded`: `degraded` is false on a
 * healthy deployment that still cannot answer some fields, and suppressing the
 * section then would hide every `null` behind a green summary line — which is the
 * defect, wearing a different hat.
 */
export function formatStatusDataGaps(status: EmailSystemStatus): string[] {
  if (status.unavailable.length === 0 && status.incomplete.length === 0) return [];
  const lines: string[] = [""];
  const failures = status.failures;
  if (failures.length > 0) {
    lines.push(`Read failures (${failures.length}) — these numbers could not be measured:`);
    for (const path of failures) {
      lines.push(`  ${path} — ${status.gaps[path]?.reason ?? pathAvailability(status, path)?.reason ?? "unavailable"}`);
    }
  }
  if (status.incomplete.length > 0) {
    lines.push(`Lower bounds (${status.incomplete.length}) — counts shown with ≥ are not totals:`);
    for (const path of status.incomplete) {
      const availability = pathAvailability(status, path);
      lines.push(`  ${path} — ${availability?.reason ?? "enumeration_cap_exceeded"}`);
    }
  }
  if (status.limitations.length > 0) {
    lines.push(`Data gaps (${status.limitations.length}) — not answerable in ${status.mode.current} mode:`);
    for (const path of status.limitations) {
      lines.push(`  ${path} — ${status.gaps[path]?.reason ?? pathAvailability(status, path)?.reason ?? "unavailable"}`);
    }
  }
  return lines;
}

function pathAvailability(status: EmailSystemStatus, path: string): StatusAvailability | null {
  let cursor: unknown = status;
  for (const segment of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (!cursor || typeof cursor !== "object") return null;
  const availability = (cursor as Record<string, unknown>)["availability"];
  return availability ? (availability as StatusAvailability) : null;
}

export function formatAgentContextSummary(context: Record<string, unknown>): string {
  const status = context["status"] as EmailSystemStatus | undefined;
  if (!status) return JSON.stringify(context, null, 2);

  const workflows = context["workflows"] as Record<string, unknown> | undefined;
  const workflowNames = workflows ? Object.keys(workflows) : [];
  const lines: string[] = [formatEmailSystemStatus(status)];
  lines.push("");
  lines.push("Agent context summary");
  lines.push(`  Workflows: ${workflowNames.length ? workflowNames.join(", ") : "none"}`);
  const sendReady = status.domains.send_ready === null
    ? "unavailable"
    : `${status.domains.send_ready}/${renderStatusCount(status.domains.total, status.domains.availability)}`;
  const receiveReady = status.addresses.ready_to_receive === null
    ? "unavailable"
    : `${status.addresses.ready_to_receive}/${renderStatusCount(status.addresses.total, status.addresses.availability)}`;
  lines.push(`  Readiness: ${sendReady} send-ready domains, ${receiveReady} receive-ready addresses`);
  const usableDomains = status.domains.usable;
  if (usableDomains && usableDomains.length > 0) {
    lines.push("  Usable domains:");
    for (const domain of usableDomains.slice(0, 5)) {
      const send = domain.send_ready === null ? "send=unavailable" : `send=${domain.send_ready ? "yes" : "no"}`;
      const receive = domain.receive_ready === null ? "receive=unavailable" : `receive=${domain.receive_ready ? "yes" : "no"}`;
      lines.push(`    ${domain.domain} ${domain.state ?? domain.provisioning_status ?? "state unavailable"} ${send} ${receive}`);
    }
    if (usableDomains.length > 5 || status.domains.usable_truncated) {
      // `emails domain status` refuses in every mode (src/cli/commands/domain.ts).
      lines.push(`    ... use emails domain list --json for the full readiness table (${status.domains.usable_limit} sampled here)`);
    }
  }
  const usableFrom = status.addresses.usable_from;
  if (usableFrom === null) {
    lines.push(`  Usable from-addresses: ${renderStatusUnavailable(status.gaps["addresses.usable_from"] ?? null)}`);
  } else if (usableFrom.length > 0) {
    lines.push("  Usable from-addresses:");
    for (const address of usableFrom.slice(0, 5)) {
      const owner = address.owner ? ` owner=${address.owner.name}` : "";
      lines.push(`    ${address.email}${owner}`);
    }
    if (usableFrom.length > 5 || status.addresses.usable_from_truncated) {
      lines.push(`    ... use emails address list --limit ${status.addresses.usable_from_limit} for more addresses`);
    }
  }
  lines.push("");
  lines.push("Details: use emails agent context --verbose or emails agent context --json for the full redacted snapshot.");
  return lines.join("\n");
}

export interface AgentContextSample {
  status: Record<string, unknown>;
  limits: { samples: number; domain_full_limit: number | null; address_full_limit: number | null };
  truncated: { domains: boolean; addresses: boolean };
}

/**
 * Shared sampler for the MCP `agent/context` resource in both modes.
 *
 * It exists because BOTH resource modules used to do
 * `Array.isArray(addresses?.usable_from) ? addresses.usable_from : []`, which
 * turns an honest `null` ("send eligibility is not published by this server")
 * straight back into a confident empty list. A null list stays null here.
 */
export function sampleAgentContext(
  context: Record<string, unknown>,
  sampleLimit: number,
): AgentContextSample {
  const status = context["status"] as EmailSystemStatus;
  const usableDomains = status.domains.usable;
  const usableFrom = status.addresses.usable_from;
  return {
    status: {
      generated_at: status.generated_at,
      mode: status.mode,
      degraded: status.degraded,
      unavailable: status.unavailable,
      incomplete: status.incomplete,
      gaps: status.gaps,
      database: status.database,
      providers: status.providers,
      domains: {
        ...status.domains,
        usable: usableDomains === null ? null : usableDomains.slice(0, sampleLimit),
      },
      addresses: {
        ...status.addresses,
        usable_from: usableFrom === null ? null : usableFrom.slice(0, sampleLimit).map((address) => ({
          id: address.id,
          email: address.email,
          provider_id: address.provider_id,
          provider_name: address.provider_name,
          owner: address.owner,
          administrator: address.administrator,
          status: address.status,
          verified: address.verified,
        })),
      },
      inbox: status.inbox,
      mailboxes: status.mailboxes,
      sources: status.sources,
      provisioning: status.provisioning,
      next_actions: status.next_actions,
      cli_equivalents: status.cli_equivalents,
    },
    limits: {
      samples: sampleLimit,
      domain_full_limit: status.domains.usable_limit,
      address_full_limit: status.addresses.usable_from_limit,
    },
    truncated: {
      domains: status.domains.usable_truncated || (usableDomains?.length ?? 0) > sampleLimit,
      addresses: status.addresses.usable_from_truncated || (usableFrom?.length ?? 0) > sampleLimit,
    },
  };
}

function buildAgentContext(status: EmailSystemStatus): Record<string, unknown> {
  // EVERY workflow is filtered, not just one. Only `diagnose_missing_mail` was,
  // so `create_receive_address` step 2 published `emails address provision`, which
  // src/cli/commands/address.ts serverOnly()s in both modes — a workflow whose
  // second step cannot be run is worse than no workflow.
  const runnable = (steps: string[]): string[] => {
    const mode = getEmailsMode();
    return steps.filter((command) => isCommandAvailableInMode(command, mode));
  };
  return {
    status,
    workflows: {
      create_receive_address: runnable([
        "emails owner register <name> --type agent",
        // `address add` takes only --provider/--name (src/cli/commands/address.ts),
        // so attaching the owner registered in step 1 is its own step — otherwise
        // the workflow registers an owner and never uses it.
        "emails address add <email> --provider <provider>",
        "emails address set-owner <email> --owner <owner>",
        "emails inbox wait-code <email> --timeout 120",
      ]),
      diagnose_missing_mail: runnable([
        "emails status",
        "emails inbox sync-status",
        "emails inbox explain <email-id>",
        "emails doctor delivery <address>",
      ]),
      ownership: runnable([
        "emails address owner <email-or-id>",
        "emails address set-owner <email-or-id> --owner <owner> --administrator <agent>",
      ]),
    },
    refresh_cadence: {
      ui_local_reload_ms: 30000,
      ui_s3_pull_ms: 45000,
      realtime_watch_command: "emails inbox watch --all-buckets",
    },
  };
}

export async function getAgentContextForRuntime(): Promise<Record<string, unknown>> {
  return buildAgentContext(await buildSystemStatus());
}

export async function getNextEmailAction(goal?: string): Promise<Record<string, unknown>> {
  return nextEmailActionFromStatus(await buildSystemStatus(), goal);
}

export async function getNextEmailActionForRuntime(goal?: string): Promise<Record<string, unknown>> {
  return nextEmailActionFromStatus(await buildSystemStatus(), goal);
}

function nextEmailActionFromStatus(status: EmailSystemStatus, goal?: string): Record<string, unknown> {
  const normalized = goal?.toLowerCase() ?? "";
  if (normalized.includes("code") || normalized.includes("verification")) {
    return {
      command: "emails inbox wait-code <address> --timeout 120",
      reason: "Wait-code refreshes inbound S3 by default and extracts the latest matching code.",
      status,
    };
  }
  if (normalized.includes("owner")) {
    return {
      command: "emails address owner <email-or-id>",
      reason: "Address ownership is stored on the address row and enriched with owner/admin records.",
      status,
    };
  }
  const first = status.next_actions.find((action) => action.command !== null);
  return {
    command: first?.command ?? "emails status",
    reason: first?.reason ?? "The system has no obvious setup gaps.",
    status,
  };
}
