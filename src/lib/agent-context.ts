import { getInboundBuckets } from "./config.js";
import type { EnrichedAddress } from "./address-ownership.js";
import { resolveMailDataSource } from "./mail-data-source.js";
import { resolveEmailsMode, type EmailsMode, type EmailsModeLabel, type EmailsModeSource } from "./mode.js";
import type { MailboxSourceSummary, MailboxStatusSummary } from "./mail-types.js";

const USABLE_FROM_LIMIT = 25;
const DOMAIN_READINESS_LIMIT = 25;
const SOURCE_STATUS_LIMIT = 50;

export interface EmailSystemStatus {
  generated_at: string;
  mode: {
    current: EmailsMode;
    label: EmailsModeLabel;
    source: EmailsModeSource;
    warning: string | null;
  };
  database: {
    data_dir: string | null;
  };
  providers: {
    total: number;
    active: number;
    by_type: Record<string, number>;
  };
  domains: {
    total: number;
    send_ready: number;
    receive_ready: number;
    usable: Array<{
      id: string;
      domain: string;
      provider_id: string;
      provider_name: string | null;
      state: string;
      send_ready: boolean;
      receive_ready: boolean;
      ready_addresses: number;
      issues: string[];
      fix_commands: string[];
    }>;
    usable_limit: number;
    usable_truncated: boolean;
  };
  addresses: {
    total: number;
    active: number;
    verified: number;
    owned: number;
    ready_to_receive: number;
    usable_from: EnrichedAddress[];
    usable_from_limit: number;
    usable_from_truncated: boolean;
  };
  inbox: {
    total: number;
    unread: number;
    latest_received_at: string | null;
    inbound_buckets: ReturnType<typeof getInboundBuckets>;
    realtime: {
      queue_configured: boolean;
      queue_url: string | null;
      last_poll_at: string | null;
      last_error: string | null;
    };
  };
  mailboxes: MailboxStatusSummary;
  sources: {
    total: number;
    active: number;
    legacy: number;
    orphaned: number;
    items: MailboxSourceSummary[];
    limit: number;
    truncated: boolean;
  };
  provisioning: {
    domains_pending: number;
    domains_failed: number;
    addresses_pending: number;
    addresses_failed: number;
  };
  next_actions: string[];
  cli_equivalents: Record<string, string>;
}

// The client is self-hosted-ONLY: the runtime system status resolves the API
// source of truth (mailbox counts/status/sources over the `/v1` mail data
// source) and never opens a local SQLite database. The rich provider/domain/
// address/provisioning aggregates were local-SQLite views that the operator's
// server now owns, so they are reported as empty here — the authoritative
// numbers are served by the operator API and its own status endpoints.
async function buildSystemStatus(): Promise<EmailSystemStatus> {
  const mode = resolveEmailsMode();
  const ds = resolveMailDataSource();
  const [counts, mailboxes, sources] = await Promise.all([
    ds.mailboxCounts(),
    ds.listMailboxStatus(),
    ds.listMailboxSources({ limit: Math.max(SOURCE_STATUS_LIMIT + 1, 1000), includeLatest: false }),
  ]);
  const primarySource = sources[0];
  const receivedTotal = counts.inbox + counts.archived + counts.spam + counts.trash;
  return {
    generated_at: new Date().toISOString(),
    mode: {
      current: mode.mode,
      label: mode.label,
      source: mode.source,
      warning: mode.warning,
    },
    database: {
      data_dir: null,
    },
    providers: {
      total: 0,
      active: 0,
      by_type: {},
    },
    domains: {
      total: 0,
      send_ready: 0,
      receive_ready: 0,
      usable: [],
      usable_limit: DOMAIN_READINESS_LIMIT,
      usable_truncated: false,
    },
    addresses: {
      total: 0,
      active: 0,
      verified: 0,
      owned: 0,
      ready_to_receive: 0,
      usable_from: [],
      usable_from_limit: USABLE_FROM_LIMIT,
      usable_from_truncated: false,
    },
    inbox: {
      total: receivedTotal,
      unread: counts.unread,
      latest_received_at: primarySource?.latestReceivedAt ?? null,
      inbound_buckets: [],
      realtime: {
        queue_configured: false,
        queue_url: null,
        last_poll_at: null,
        last_error: null,
      },
    },
    mailboxes,
    sources: {
      total: sources.length,
      active: sources.length,
      legacy: 0,
      orphaned: 0,
      items: sources.slice(0, SOURCE_STATUS_LIMIT),
      limit: SOURCE_STATUS_LIMIT,
      truncated: sources.length > SOURCE_STATUS_LIMIT,
    },
    provisioning: {
      domains_pending: 0,
      domains_failed: 0,
      addresses_pending: 0,
      addresses_failed: 0,
    },
    next_actions: [],
    cli_equivalents: {
      status: "emails status --json",
      inbox_sync_status: "emails inbox sync-status --json",
      provision_address: "emails address provision <email> --provider <provider>",
      wait_code: "emails inbox wait-code <address> --timeout 120",
      address_owner: "emails address owner <email-or-id>",
    },
  };
}

export async function getEmailSystemStatus(): Promise<EmailSystemStatus> {
  return buildSystemStatus();
}

// The runtime status backs `emails status`, `emails agent context`, and the MCP
// status resources/tools. In the self-hosted client it resolves the API source
// of truth and never opens a local database.
export async function getEmailSystemStatusForRuntime(): Promise<EmailSystemStatus> {
  return buildSystemStatus();
}

export function formatEmailSystemStatus(status: EmailSystemStatus): string {
  const lines: string[] = [];
  lines.push("Email system status");
  lines.push(`  Mode:       ${status.mode.current} (${status.mode.label})`);
  if (status.mode.warning) lines.push(`  Mode note:  ${status.mode.warning}`);
  lines.push(`  Capabilities: ${status.providers.active}/${status.providers.total} active provider credential(s)`);
  lines.push(`  Domains:   ${status.domains.send_ready} send-ready, ${status.domains.receive_ready} receive-ready, ${status.domains.total} total`);
  const usableFromLabel = status.addresses.usable_from_truncated
    ? `${status.addresses.usable_from.length}+ listed`
    : `${status.addresses.usable_from.length} listed`;
  lines.push(`  Addresses: ${status.addresses.active}/${status.addresses.total} active, ${status.addresses.owned} owned, ${status.addresses.verified} verified, ${usableFromLabel} usable sender(s)`);
  lines.push(`  Mailboxes: ${status.mailboxes.counts.inbox} inbox, ${status.mailboxes.counts.unread} unread, ${status.mailboxes.counts.sent} sent`);
  lines.push(`  Inbox:     ${status.inbox.total} total, ${status.inbox.unread} unread${status.inbox.latest_received_at ? `, latest ${status.inbox.latest_received_at}` : ""}`);
  lines.push(`  Sources:   ${status.sources.total} ingestion source(s), ${status.sources.legacy} legacy, ${status.sources.orphaned} orphaned, realtime ${status.inbox.realtime.queue_configured ? "configured" : "not configured"}`);
  if (status.inbox.realtime.last_error) lines.push(`  Last realtime error: ${status.inbox.realtime.last_error}`);
  if (status.provisioning.domains_failed || status.provisioning.addresses_failed) {
    lines.push(`  Provisioning failures: ${status.provisioning.domains_failed} domain(s), ${status.provisioning.addresses_failed} address(es)`);
  }
  if (status.next_actions.length > 0) {
    lines.push("");
    lines.push("Next actions:");
    for (const action of status.next_actions) lines.push(`  ${action}`);
  }
  return lines.join("\n");
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
  lines.push(`  Readiness: ${status.domains.send_ready}/${status.domains.total} send-ready domains, ${status.addresses.ready_to_receive}/${status.addresses.total} receive-ready addresses`);
  if (status.domains.usable.length > 0) {
    lines.push("  Usable domains:");
    for (const domain of status.domains.usable.slice(0, 5)) {
      lines.push(`    ${domain.domain} ${domain.state} send=${domain.send_ready ? "yes" : "no"} receive=${domain.receive_ready ? "yes" : "no"}`);
    }
    if (status.domains.usable.length > 5 || status.domains.usable_truncated) {
      lines.push(`    ... use emails domain status --limit ${status.domains.usable_limit} for the full readiness table`);
    }
  }
  if (status.addresses.usable_from.length > 0) {
    lines.push("  Usable from-addresses:");
    for (const address of status.addresses.usable_from.slice(0, 5)) {
      const owner = address.owner ? ` owner=${address.owner.name}` : "";
      lines.push(`    ${address.email}${owner}`);
    }
    if (status.addresses.usable_from.length > 5 || status.addresses.usable_from_truncated) {
      lines.push(`    ... use emails address list --limit ${status.addresses.usable_from_limit} for more addresses`);
    }
  }
  lines.push("");
  lines.push("Details: use emails agent context --verbose or emails agent context --json for the full redacted snapshot.");
  return lines.join("\n");
}

function buildAgentContext(status: EmailSystemStatus): Record<string, unknown> {
  return {
    status,
    workflows: {
      create_receive_address: [
        "emails owner register <name> --type agent",
        "emails address provision <email> --provider <provider> --owner <agent>",
        "emails inbox wait-code <email> --timeout 120",
      ],
      diagnose_missing_mail: [
        "emails status",
        "emails inbox sync-status",
        "emails inbox explain <email-id>",
        "emails doctor delivery <address>",
      ],
      ownership: [
        "emails address owner <email-or-id>",
        "emails address set-owner <email-or-id> --owner <owner> --administrator <agent>",
      ],
    },
    refresh_cadence: {
      ui_local_reload_ms: 30000,
      ui_s3_pull_ms: 45000,
      realtime_watch_command: "emails inbox watch --all-buckets",
    },
  };
}

export async function getAgentContext(): Promise<Record<string, unknown>> {
  return buildAgentContext(await buildSystemStatus());
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
  return {
    command: status.next_actions[0] ?? "emails status",
    reason: status.next_actions.length > 0 ? "This is the first unresolved setup or health action." : "The system has no obvious setup gaps.",
    status,
  };
}
