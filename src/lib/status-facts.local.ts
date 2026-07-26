// Local-mode status facts — read from the local SQLite database and the
// operator's own config file. Same shape as the self-hosted facts
// (src/lib/status-facts.remote.ts), so `emails status --json` is structurally
// identical in both modes.
//
// Local mode answers everything self_hosted cannot: it owns the domain readiness
// columns (DKIM/SPF/DMARC + inbound/outbound route state), the usable-sender
// query, the inbound S3 bucket list and the realtime queue config.
//
// It is NOT gap-free, and this module must not pretend otherwise: `sources.configured`
// is a self-hosted server inventory that local mode has no equivalent for, so it is
// always reported unavailable here (`not_applicable`). That is a STRUCTURAL limit —
// it shows up in `limited`/`limitations`, not in `degraded` — see
// src/lib/status-availability.ts (statusGapClass). On a healthy local install
// `degraded` is false and `limited` is true.

import { getDatabase, getDatabasePath, type Database } from "../db/database.js";
import { dirname } from "node:path";
import { listProviderSummaries } from "../db/providers.local.js";
import { listDomains } from "../db/domains.local.js";
import { listUsableSendingAddresses } from "../db/addresses.local.js";
import { listDomainProvisioningByIds, listReadyAddressCountsByDomains } from "../db/provisioning.local.js";
import { countValue } from "../db/scalars.js";
import { assessDomainReadiness } from "./domain-readiness.js";
import { domainInboundReadinessSignals } from "./domain-inbound-evidence.js";
import { getInboundBuckets, loadConfig } from "./config.js";
import { enrichAddresses } from "./address-ownership.js";
import { resolveEmailsMode } from "./mode.js";
import { statusAvailable, statusUnavailable, type StatusAvailability } from "./status-availability.js";
import type { StatusFactsBundle, StatusFactsInput } from "./status-facts.js";
import type { DomainStatusRow } from "./status-types.js";

const LOCAL_SQLITE = "local_sqlite";
const LOCAL_CONFIG = "local_config";

/**
 * The directory the database ACTUALLY lives in.
 *
 * Deliberately derived from getDatabasePath() rather than getDataDir(): an
 * EMAILS_DB_PATH override moves the database, so getDataDir() would name a
 * directory the data is not in — and getDataDir() also creates/migrates
 * directories and refuses untrusted ancestors, i.e. it can throw. `emails status`
 * must never fail because it tried to report where its own files are, and it must
 * never name the wrong directory either.
 */
function dataDirFacts(): { availability: StatusAvailability; data_dir: string | null; gap: string | null } {
  let path: string;
  try {
    path = getDatabasePath();
  } catch (error) {
    return {
      availability: statusUnavailable(
        "source_unreachable",
        error instanceof Error ? error.message : String(error),
        LOCAL_SQLITE,
        "the database path could not be resolved",
      ),
      data_dir: null,
      gap: "database.data_dir",
    };
  }
  if (path === ":memory:") {
    return {
      availability: statusUnavailable(
        "not_applicable",
        "in_memory_database",
        LOCAL_SQLITE,
        "the database is in memory, so there is no data directory",
      ),
      data_dir: null,
      gap: "database.data_dir",
    };
  }
  return { availability: statusAvailable(LOCAL_SQLITE, "local_query"), data_dir: dirname(path), gap: null };
}

function configString(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value : null;
}

interface AddressSummaryRow {
  total: unknown;
  active: unknown;
  verified: unknown;
  owned: unknown;
  ready_to_receive: unknown;
}

function addressSummary(db: Database): {
  total: number; active: number; verified: number; owned: number; ready_to_receive: number;
} {
  const row = db
    .query(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN COALESCE(status, 'active') != 'suspended' THEN 1 ELSE 0 END), 0) AS active,
         COALESCE(SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END), 0) AS verified,
         COALESCE(SUM(CASE WHEN owner_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS owned,
         COALESCE(SUM(CASE WHEN provisioning_status = 'ready' THEN 1 ELSE 0 END), 0) AS ready_to_receive
       FROM addresses`,
    )
    .get() as AddressSummaryRow | null;
  return {
    total: countValue(row?.total),
    active: countValue(row?.active),
    verified: countValue(row?.verified),
    owned: countValue(row?.owned),
    ready_to_receive: countValue(row?.ready_to_receive),
  };
}

function provisioningSummary(db: Database): {
  domains_pending: number; domains_failed: number; addresses_pending: number; addresses_failed: number;
} {
  const domainRow = db
    .query(
      `SELECT
         COALESCE(SUM(CASE WHEN provisioning_status NOT IN ('ready', 'failed', 'none') THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN provisioning_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
       FROM domains`,
    )
    .get() as { pending: unknown; failed: unknown } | null;
  const addressRow = db
    .query(
      `SELECT
         COALESCE(SUM(CASE WHEN provisioning_status NOT IN ('ready', 'failed', 'none') THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN provisioning_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
       FROM addresses`,
    )
    .get() as { pending: unknown; failed: unknown } | null;
  return {
    domains_pending: countValue(domainRow?.pending),
    domains_failed: countValue(domainRow?.failed),
    addresses_pending: countValue(addressRow?.pending),
    addresses_failed: countValue(addressRow?.failed),
  };
}

export function collectStatusFacts(input: StatusFactsInput): StatusFactsBundle {
  const gaps: Record<string, StatusAvailability> = {};
  const db = getDatabase();
  const mode = resolveEmailsMode();
  const config = loadConfig();

  const providerRows = listProviderSummaries(db);
  const providersById = new Map(providerRows.map((provider) => [provider.id, provider]));
  const byType: Record<string, number> = {};
  for (const provider of providerRows.filter((candidate) => candidate.active)) {
    byType[provider.type] = (byType[provider.type] ?? 0) + 1;
  }

  const allDomains = listDomains(undefined, db);
  const allDomainIds = allDomains.map((domain) => domain.id);
  const allProvisioning = listDomainProvisioningByIds(allDomainIds, db);
  const allReadyAddresses = listReadyAddressCountsByDomains(allDomainIds, db);
  const readinessOf = (domain: (typeof allDomains)[number]) => assessDomainReadiness(
    domain,
    allProvisioning.get(domain.id) ?? null,
    {
      ...domainInboundReadinessSignals(domain, mode),
      ready_addresses: allReadyAddresses.get(domain.id) ?? 0,
    },
  );

  let sendReady = 0;
  let receiveReady = 0;
  for (const domain of allDomains) {
    const readiness = readinessOf(domain);
    if (readiness.send_ready) sendReady += 1;
    if (readiness.receive_ready) receiveReady += 1;
  }

  const domainSample = allDomains.slice(0, input.domainLimit);
  const usableRows: DomainStatusRow[] = domainSample.map((domain) => {
    const readiness = readinessOf(domain);
    const provisioning = allProvisioning.get(domain.id) ?? null;
    return {
      id: domain.id,
      domain: domain.domain,
      provider_id: domain.provider_id,
      provider_name: providersById.get(domain.provider_id)?.name ?? null,
      state: readiness.state,
      send_ready: readiness.send_ready,
      receive_ready: readiness.receive_ready,
      ready_addresses: readiness.ready_addresses,
      provisioning_status: provisioning?.provisioning_status ?? null,
      last_error: provisioning?.last_error ?? null,
      next_check_at: provisioning?.next_check_at ?? null,
      issues: readiness.issues,
      fix_commands: readiness.fix_commands,
    };
  });

  const addressCounts = addressSummary(db);
  const senderRows = listUsableSendingAddresses(db, { limit: input.usableFromLimit + 1 });
  const usableFromTruncated = senderRows.length > input.usableFromLimit;
  const usableFrom = enrichAddresses(senderRows.slice(0, input.usableFromLimit));

  const buckets = getInboundBuckets();
  const queueUrl = configString(config, "inbound_realtime_queue_url");

  const countedSources = input.mailboxSources.filter((source) => source.kind !== "all");
  const configuredGap = statusUnavailable(
    "not_applicable",
    "server_source_inventory",
    LOCAL_SQLITE,
    "the /v1 configured-source inventory is a self-hosted server concept; local mode's sources are the mailbox view above",
  );
  const mark = (path: string, availability: StatusAvailability): null => {
    gaps[path] = availability;
    return null;
  };

  const provisioningCounts = provisioningSummary(db);
  const dataDir = dataDirFacts();
  if (dataDir.gap) gaps[dataDir.gap] = dataDir.availability;

  return {
    database: {
      availability: dataDir.availability,
      data_dir: dataDir.data_dir,
    },
    providers: {
      availability: statusAvailable(`${LOCAL_SQLITE}:providers`, "local_query"),
      total: providerRows.length,
      active: providerRows.filter((provider) => provider.active).length,
      by_type: byType,
    },
    domains: {
      availability: statusAvailable(`${LOCAL_SQLITE}:domains`, "local_query"),
      total: allDomains.length,
      verified: allDomains.filter((domain) => domain.ownership_status === "verified").length,
      send_ready: sendReady,
      receive_ready: receiveReady,
      usable: usableRows,
      usable_limit: input.domainLimit,
      usable_truncated: allDomains.length > input.domainLimit,
    },
    addresses: {
      availability: statusAvailable(`${LOCAL_SQLITE}:addresses`, "local_query"),
      total: addressCounts.total,
      active: addressCounts.active,
      verified: addressCounts.verified,
      owned: addressCounts.owned,
      ready_to_receive: addressCounts.ready_to_receive,
      usable_from: usableFrom,
      usable_from_limit: input.usableFromLimit,
      usable_from_truncated: usableFromTruncated,
    },
    inboundBuckets: {
      availability: statusAvailable(LOCAL_CONFIG, "local_config"),
      items: buckets,
      total: buckets.length,
    },
    realtime: {
      availability: statusAvailable(LOCAL_CONFIG, "local_config"),
      queue_configured: queueUrl !== null,
      queue_url: queueUrl,
      last_poll_at: configString(config, "inbound_realtime_last_poll_at"),
      last_error: configString(config, "inbound_realtime_last_error"),
    },
    sources: {
      availability: statusAvailable(`${LOCAL_SQLITE}:mail_sources`, "local_query"),
      total: countedSources.length,
      active: countedSources.filter((source) =>
        source.badges.includes("active") || source.badges.includes("configured")).length,
      legacy: countedSources.filter((source) => source.badges.includes("legacy")).length,
      orphaned: countedSources.filter((source) => source.badges.includes("orphaned")).length,
      items: input.mailboxSources.slice(0, input.sourceLimit),
      limit: input.sourceLimit,
      truncated: countedSources.length > input.sourceLimit,
      configured: {
        availability: configuredGap,
        total: mark("sources.configured.total", configuredGap),
        by_status: mark("sources.configured.by_status", configuredGap),
        latest_last_synced_at: mark("sources.configured.latest_last_synced_at", configuredGap),
      },
    },
    provisioning: {
      availability: statusAvailable(`${LOCAL_SQLITE}:provisioning`, "local_query"),
      ...provisioningCounts,
    },
    gaps,
  };
}
