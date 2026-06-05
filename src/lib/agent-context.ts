import { getDatabase, getDataDir } from "../db/database.js";
import type { Database } from "../db/database.js";
import { listProviders } from "../db/providers.js";
import { listDomains } from "../db/domains.js";
import { listAddresses } from "../db/addresses.js";
import { getInboundCount, getUnreadCount, listInboundEmails } from "../db/inbound.js";
import { getGmailSyncState } from "../db/gmail-sync-state.js";
import { getAddressProvisioning, getDomainProvisioning } from "../db/provisioning.js";
import { assessDomainReadiness } from "./domain-readiness.js";
import { getInboundBuckets, getGmailSyncConfig, loadConfig } from "./config.js";
import { listEnrichedAddresses, type EnrichedAddress } from "./address-ownership.js";

export interface EmailSystemStatus {
  generated_at: string;
  database: {
    data_dir: string;
  };
  providers: {
    total: number;
    active: number;
    by_type: Record<string, number>;
    gmail: Array<{
      id: string;
      name: string;
      synced_count: number;
      unread_count: number;
      last_synced_at: string | null;
      last_message_id: string | null;
    }>;
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
  };
  addresses: {
    total: number;
    active: number;
    verified: number;
    owned: number;
    ready_to_receive: number;
    usable_from: EnrichedAddress[];
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
    gmail_attachment_storage: ReturnType<typeof getGmailSyncConfig>["attachment_storage"];
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

function countByType(providers: ReturnType<typeof listProviders>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const provider of providers) counts[provider.type] = (counts[provider.type] ?? 0) + 1;
  return counts;
}

export function getEmailSystemStatus(db: Database = getDatabase()): EmailSystemStatus {
  const providers = listProviders(db);
  const domains = listDomains(undefined, db);
  const addresses = listAddresses(undefined, db);
  const enrichedAddresses = listEnrichedAddresses(undefined, db);
  const config = loadConfig();
  const inboundBuckets = getInboundBuckets();
  const latest = listInboundEmails({ limit: 1, archived: true }, db)[0]
    ?? listInboundEmails({ limit: 1 }, db)[0]
    ?? null;

  const domainReadiness = domains.map((domain) => {
    const readyAddresses = addresses.filter((address) => {
      const provisioning = getAddressProvisioning(address.id, db);
      return provisioning?.domain_id === domain.id && provisioning.provisioning_status === "ready";
    }).length;
    const readiness = assessDomainReadiness(domain, getDomainProvisioning(domain.id, db), {
      ready_addresses: readyAddresses,
    });
    return {
      id: domain.id,
      domain: domain.domain,
      provider_id: domain.provider_id,
      provider_name: providers.find((provider) => provider.id === domain.provider_id)?.name ?? null,
      state: readiness.state,
      send_ready: readiness.send_ready,
      receive_ready: readiness.receive_ready,
      ready_addresses: readiness.ready_addresses,
      issues: readiness.issues,
      fix_commands: readiness.fix_commands,
    };
  });

  const gmail = providers.filter((provider) => provider.type === "gmail").map((provider) => {
    const state = getGmailSyncState(provider.id, db);
    return {
      id: provider.id,
      name: provider.name,
      synced_count: getInboundCount(provider.id, db),
      unread_count: getUnreadCount(provider.id, db),
      last_synced_at: state?.last_synced_at ?? null,
      last_message_id: state?.last_message_id ?? null,
    };
  });

  const provisioningRows = {
    domains_pending: domains.filter((domain) => {
      const p = getDomainProvisioning(domain.id, db);
      return p && p.provisioning_status !== "ready" && p.provisioning_status !== "failed" && p.provisioning_status !== "none";
    }).length,
    domains_failed: domains.filter((domain) => getDomainProvisioning(domain.id, db)?.provisioning_status === "failed").length,
    addresses_pending: addresses.filter((address) => {
      const p = getAddressProvisioning(address.id, db);
      return p && p.provisioning_status !== "ready" && p.provisioning_status !== "failed" && p.provisioning_status !== "none";
    }).length,
    addresses_failed: addresses.filter((address) => getAddressProvisioning(address.id, db)?.provisioning_status === "failed").length,
  };

  const nextActions: string[] = [];
  if (providers.length === 0) nextActions.push("emails provider add --help");
  if (domains.length === 0) nextActions.push("emails domain add --help");
  if (addresses.length === 0) nextActions.push("emails address add --help");
  if (inboundBuckets.length === 0 && gmail.length === 0) nextActions.push("emails inbox sync-status");
  const firstBrokenDomain = domainReadiness.find((domain) => domain.fix_commands.length > 0);
  if (firstBrokenDomain?.fix_commands[0]) nextActions.push(firstBrokenDomain.fix_commands[0]);
  if (provisioningRows.addresses_failed > 0 || provisioningRows.domains_failed > 0) nextActions.push("emails provision status");

  return {
    generated_at: new Date().toISOString(),
    database: {
      data_dir: getDataDir(),
    },
    providers: {
      total: providers.length,
      active: providers.filter((provider) => provider.active).length,
      by_type: countByType(providers),
      gmail,
    },
    domains: {
      total: domains.length,
      send_ready: domainReadiness.filter((domain) => domain.send_ready).length,
      receive_ready: domainReadiness.filter((domain) => domain.receive_ready).length,
      usable: domainReadiness,
    },
    addresses: {
      total: addresses.length,
      active: addresses.filter((address) => address.status !== "suspended").length,
      verified: addresses.filter((address) => address.verified).length,
      owned: addresses.filter((address) => address.owner_id).length,
      ready_to_receive: addresses.filter((address) => getAddressProvisioning(address.id, db)?.provisioning_status === "ready").length,
      usable_from: enrichedAddresses.filter((address) => address.status !== "suspended" && address.verified),
    },
    inbox: {
      total: getInboundCount(undefined, db),
      unread: getUnreadCount(undefined, db),
      latest_received_at: latest?.received_at ?? null,
      inbound_buckets: inboundBuckets,
      realtime: {
        queue_configured: typeof config["inbound_realtime_queue_url"] === "string",
        queue_url: typeof config["inbound_realtime_queue_url"] === "string" ? config["inbound_realtime_queue_url"] : null,
        last_poll_at: typeof config["inbound_realtime_last_poll_at"] === "string" ? config["inbound_realtime_last_poll_at"] : null,
        last_error: typeof config["inbound_realtime_last_error"] === "string" ? config["inbound_realtime_last_error"] : null,
      },
      gmail_attachment_storage: getGmailSyncConfig().attachment_storage,
    },
    provisioning: provisioningRows,
    next_actions: [...new Set(nextActions)].slice(0, 5),
    cli_equivalents: {
      status: "emails status --json",
      inbox_sync_status: "emails inbox sync-status --json",
      provision_address: "emails address provision <email> --provider <provider>",
      wait_code: "emails inbox wait-code <address> --timeout 120",
      address_owner: "emails address owner <email-or-id>",
    },
  };
}

export function formatEmailSystemStatus(status: EmailSystemStatus): string {
  const lines: string[] = [];
  lines.push("Email system status");
  lines.push(`  Providers: ${status.providers.active}/${status.providers.total} active`);
  lines.push(`  Domains:   ${status.domains.send_ready} send-ready, ${status.domains.receive_ready} receive-ready, ${status.domains.total} total`);
  lines.push(`  Addresses: ${status.addresses.active}/${status.addresses.total} active, ${status.addresses.owned} owned, ${status.addresses.usable_from.length} verified senders`);
  lines.push(`  Inbox:     ${status.inbox.total} total, ${status.inbox.unread} unread${status.inbox.latest_received_at ? `, latest ${status.inbox.latest_received_at}` : ""}`);
  lines.push(`  Sources:   ${status.inbox.inbound_buckets.length} S3 bucket(s), ${status.providers.gmail.length} Gmail provider(s), realtime ${status.inbox.realtime.queue_configured ? "configured" : "not configured"}`);
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

export function getAgentContext(db: Database = getDatabase()): Record<string, unknown> {
  const status = getEmailSystemStatus(db);
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
      ui_gmail_pull_ms: 120000,
      realtime_watch_command: "emails inbox watch --all-buckets",
    },
  };
}

export function getNextEmailAction(goal?: string, db: Database = getDatabase()): Record<string, unknown> {
  const status = getEmailSystemStatus(db);
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
