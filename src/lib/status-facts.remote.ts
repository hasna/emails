// Self-hosted status facts — read from the operator's `/v1` API, or reported
// unavailable with a reason. NOTHING here is hardcoded.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
// -----------------------------------------
// It does not go through src/db/domains.remote.ts apiToDomain or
// src/db/addresses.remote.ts apiToAddress. Those mappers reconstruct the rich
// LOCAL row shape from the minimal `/v1` entity and, in doing so, invent
// evidence: apiToDomain derives dkim_status/spf_status/dmarc_status,
// ownership/inbound/outbound/monitoring status, dns_records and
// provider_metadata from a single `verified` boolean, and apiToAddress coerces a
// missing provider_id to "". Feeding status through them would replace a
// fabricated zero with a fabricated verdict. So this module reads the RAW `/v1`
// rows and only reports columns the server actually sent.
//
// WHAT `/v1` ANSWERS (verified against the deployed openapi.json, 97 paths):
//   GET /v1/providers  -> id, name, type, region, active, timestamps
//   GET /v1/domains    -> id, domain, verified, provider, provisioning_status,
//                         dns_provider, send_provider, mail_from_domain,
//                         last_error, next_check_at, timestamps
//   GET /v1/addresses  -> id, email, domain, status, verified, owner_id,
//                         domain_id, provisioning_status, last_error, ...
//   GET /v1/sources    -> id, type, name, status, last_synced_at, ...
//
// WHAT `/v1` DOES NOT ANSWER (each gets an explicit reason, never a zero):
//   - send eligibility ("which From addresses will the server actually sign?").
//     That lives server-side in the SES identity set + outbound policy. 319 of
//     325 production addresses have verified=false yet demonstrably send, so
//     `verified` MUST NOT be used as the proxy — it would manufacture a new
//     plausible zero. Needs a `GET /v1/senders` route.
//   - per-domain DKIM/SPF/DMARC evidence and inbound/outbound route state.
//   - the operator's inbound S3 buckets and realtime SQS queue state (server-owned).
//   - source legacy/orphaned classification (a local-SQLite concept).

import { enumerateSelfHostedRows, type SelfHostedEnumeration } from "../db/self-hosted-page.js";
import { SelfHostedHttpError } from "../db/self-hosted-store.js";
import {
  statusAvailable,
  statusReasonCode,
  statusUnavailable,
  type StatusAvailability,
} from "./status-availability.js";
import type { StatusFactsBundle, StatusFactsInput } from "./status-facts.js";
import type { DomainStatusRow } from "./status-types.js";

const PENDING_EXCLUDED = new Set(["ready", "failed", "none", ""]);

function sourceOf(resource: string): string {
  return `self_hosted_api:/v1/${resource}`;
}

function readError(error: unknown): string {
  if (error instanceof SelfHostedHttpError) {
    return `GET ${error.path} -> HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

interface ResourceRead {
  rows: Record<string, unknown>[];
  availability: StatusAvailability;
}

/**
 * Enumerate one `/v1` resource. A failure yields `available: false` with the
 * real HTTP outcome — never an empty row set that would then be counted as 0.
 */
function readResource(resource: string): ResourceRead {
  const source = sourceOf(resource);
  let result: SelfHostedEnumeration;
  try {
    result = enumerateSelfHostedRows(resource);
  } catch (error) {
    return {
      rows: [],
      availability: statusUnavailable(
        "source_unreachable",
        readError(error),
        source,
        `the ${resource} inventory could not be read, so no count is reported`,
      ),
    };
  }
  if (!result.complete) {
    // Honest lower bound: the numbers are real but not final. Two DIFFERENT
    // reasons, never conflated — one is "I stopped early", the other is "the
    // server handed me an inconsistent window, so rows I never saw exist".
    const reason = result.stable
      ? `enumeration_cap_exceeded:${result.pages} pages — counts are lower bounds, not totals`
      : `enumeration_unstable:${result.duplicates} duplicate row(s) across ${result.pages} pages — `
        + "the server's list order is not total under limit/offset paging, so at least that many "
        + "rows were skipped; counts are lower bounds, not totals";
    return {
      rows: result.rows,
      availability: { ...statusAvailable(source, "client_enumeration", false), reason },
    };
  }
  return { rows: result.rows, availability: statusAvailable(source, "client_enumeration", true) };
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function strOrNull(value: unknown): string | null {
  const text = value == null ? null : String(value);
  return text === null || text === "" ? null : text;
}

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "true" || value === "1" || value === "t";
  return Boolean(value);
}

function countByKey(rows: Record<string, unknown>[], key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = str(row[key]) || "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function domainIssues(row: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const provisioning = str(row["provisioning_status"]);
  if (provisioning === "failed") issues.push("Provisioning failed");
  else if (provisioning && !PENDING_EXCLUDED.has(provisioning)) issues.push(`Provisioning ${provisioning}`);
  if (!truthy(row["verified"])) issues.push("Not verified by the server");
  const lastError = strOrNull(row["last_error"]);
  if (lastError) issues.push(lastError);
  return issues;
}

function domainFixCommands(row: Record<string, unknown>): string[] {
  // Only commands justified by a column the server actually returned. The client
  // has no DNS evidence in self_hosted, so it must not prescribe a DNS fix on a
  // guess.
  const name = str(row["domain"]);
  if (!name) return [];
  if (str(row["provisioning_status"]) === "failed" || strOrNull(row["last_error"])) {
    // NOT `emails domain status`: src/cli/commands/domain.ts serverOnly()s it
    // unconditionally, and agent-context.ts promotes fix_commands[0] straight into
    // `next_actions`. Proposing it made this module emit the refusal the whole
    // status rework exists to stop. `domain list` reads the same rows and runs.
    return [`emails domain list --json`, `emails address list --json`];
  }
  return [];
}

export function collectStatusFacts(input: StatusFactsInput): StatusFactsBundle {
  const gaps: Record<string, StatusAvailability> = {};
  const mark = (path: string, availability: StatusAvailability): null => {
    gaps[path] = availability;
    return null;
  };

  const providersRead = readResource("providers");
  const domainsRead = readResource("domains");
  const addressesRead = readResource("addresses");
  const configuredRead = readResource("sources");

  // ── database ──────────────────────────────────────────────────────────────
  const databaseAvailability = statusUnavailable(
    "not_applicable",
    "local_database_absent_in_self_hosted",
    "self_hosted_api",
    "the self-hosted client holds no local SQLite data directory",
  );
  const database = {
    availability: databaseAvailability,
    data_dir: mark("database.data_dir", databaseAvailability),
  };

  // ── providers ─────────────────────────────────────────────────────────────
  const providersOk = providersRead.availability.available;
  const providers = {
    availability: providersRead.availability,
    total: providersOk ? providersRead.rows.length : mark("providers.total", providersRead.availability),
    active: providersOk
      ? providersRead.rows.filter((row) => truthy(row["active"])).length
      : mark("providers.active", providersRead.availability),
    by_type: providersOk
      ? countByKey(providersRead.rows.filter((row) => truthy(row["active"])), "type")
      : mark("providers.by_type", providersRead.availability),
  };
  const providerNames = new Map(
    providersRead.rows.map((row) => [str(row["id"]), str(row["name"])]),
  );

  // ── domains ───────────────────────────────────────────────────────────────
  const domainsOk = domainsRead.availability.available;
  const addressesOk = addressesRead.availability.available;
  // A per-domain ready-address count is an AGGREGATE over the whole address
  // inventory, so it inherits that inventory's completeness — not the domain
  // block's. `available` alone is not enough: a partial enumeration still
  // returns rows, and every domain whose address rows fell in the skipped window
  // would be counted down to a confident `0`.
  const readyAddressesCountable = addressesOk && addressesRead.availability.complete !== false;
  const readyAddressesByDomain = new Map<string, number>();
  if (addressesOk) {
    for (const row of addressesRead.rows) {
      const domainId = strOrNull(row["domain_id"]);
      if (!domainId || str(row["provisioning_status"]) !== "ready") continue;
      readyAddressesByDomain.set(domainId, (readyAddressesByDomain.get(domainId) ?? 0) + 1);
    }
  }

  const dnsEvidenceGap = statusUnavailable(
    "not_modelled_over_v1",
    "domain_dns_evidence",
    sourceOf("domains"),
    "the /v1 domain entity carries no DKIM/SPF/DMARC records and no inbound/outbound route state, "
      + "so send/receive readiness cannot be computed client-side; `verified` is reported instead",
  );
  const readyAddressesGap = statusUnavailable(
    "source_unreachable",
    "GET /v1/addresses",
    sourceOf("addresses"),
    "per-domain ready-address counts are derived from the address inventory, which could not be read",
  );
  // The address inventory answered, but not with every row. Unlike a block-level
  // count, a per-domain aggregate cannot be published as a lower bound: a
  // DomainStatusRow carries no availability record of its own, so renderers key
  // the `≥` prefix off `domains.availability` — which is complete here — and the
  // number would read as measured. A domain whose address rows all fell in the
  // skipped window would render a flat `0`, i.e. the exact fabricated-count
  // failure this module exists to remove.
  const readyAddressesBoundGap = statusUnavailable(
    statusReasonCode(addressesRead.availability.reason) ?? "enumeration_cap_exceeded",
    "GET /v1/addresses",
    sourceOf("addresses"),
    "per-domain ready-address counts aggregate the whole address inventory, and that enumeration was "
      + "incomplete, so an unseen domain would report a confident 0 rather than a lower bound",
  );

  const sortedDomains = [...domainsRead.rows].sort((a, b) =>
    str(b["created_at"]).localeCompare(str(a["created_at"])));
  const domainSample = sortedDomains.slice(0, input.domainLimit);
  const usableRows: DomainStatusRow[] = domainSample.map((row) => {
    const id = str(row["id"]);
    const providerId = str(row["provider"] ?? row["provider_id"]);
    return {
      id,
      domain: str(row["domain"]),
      provider_id: providerId,
      provider_name: providerNames.get(providerId) ?? null,
      state: null,
      send_ready: null,
      receive_ready: null,
      ready_addresses: readyAddressesCountable ? (readyAddressesByDomain.get(id) ?? 0) : null,
      provisioning_status: strOrNull(row["provisioning_status"]),
      last_error: strOrNull(row["last_error"]),
      next_check_at: strOrNull(row["next_check_at"]),
      issues: domainIssues(row),
      fix_commands: domainFixCommands(row),
    };
  });
  if (domainsOk && usableRows.length > 0) {
    gaps["domains.usable[].state"] = dnsEvidenceGap;
    gaps["domains.usable[].send_ready"] = dnsEvidenceGap;
    gaps["domains.usable[].receive_ready"] = dnsEvidenceGap;
    if (!readyAddressesCountable) {
      gaps["domains.usable[].ready_addresses"] = addressesOk ? readyAddressesBoundGap : readyAddressesGap;
    }
  }

  const domains = {
    availability: domainsRead.availability,
    total: domainsOk ? domainsRead.rows.length : mark("domains.total", domainsRead.availability),
    verified: domainsOk
      ? domainsRead.rows.filter((row) => truthy(row["verified"])).length
      : mark("domains.verified", domainsRead.availability),
    send_ready: mark("domains.send_ready", domainsOk ? dnsEvidenceGap : domainsRead.availability),
    receive_ready: mark("domains.receive_ready", domainsOk ? dnsEvidenceGap : domainsRead.availability),
    usable: domainsOk ? usableRows : mark("domains.usable", domainsRead.availability),
    usable_limit: input.domainLimit,
    usable_truncated: domainsOk && sortedDomains.length > input.domainLimit,
  };

  // ── addresses ─────────────────────────────────────────────────────────────
  const sendEligibilityGap = statusUnavailable(
    "server_route_absent",
    "/v1/senders",
    sourceOf("addresses"),
    "send eligibility is resolved server-side from the SES identity set and outbound policy; "
      + "the /v1 address `verified` flag is NOT a send-readiness proxy (mail sends from verified=false rows)",
  );
  const addresses = {
    availability: addressesRead.availability,
    total: addressesOk ? addressesRead.rows.length : mark("addresses.total", addressesRead.availability),
    active: addressesOk
      ? addressesRead.rows.filter((row) => str(row["status"]) !== "suspended").length
      : mark("addresses.active", addressesRead.availability),
    verified: addressesOk
      ? addressesRead.rows.filter((row) => truthy(row["verified"])).length
      : mark("addresses.verified", addressesRead.availability),
    owned: addressesOk
      ? addressesRead.rows.filter((row) => strOrNull(row["owner_id"]) !== null).length
      : mark("addresses.owned", addressesRead.availability),
    ready_to_receive: addressesOk
      ? addressesRead.rows.filter((row) => str(row["provisioning_status"]) === "ready").length
      : mark("addresses.ready_to_receive", addressesRead.availability),
    usable_from: mark("addresses.usable_from", addressesOk ? sendEligibilityGap : addressesRead.availability),
    usable_from_limit: input.usableFromLimit,
    usable_from_truncated: false,
  };

  // ── inbox: buckets + realtime (server-owned ingestion) ────────────────────
  const bucketsGap = statusUnavailable(
    "not_applicable",
    "server_owned_ingestion",
    "self_hosted_api",
    "inbound S3 buckets belong to the operator's server, which publishes no inventory route; "
      + "an empty list here would falsely claim no bucket is configured",
  );
  const inboundBuckets = {
    availability: bucketsGap,
    items: mark("inbox.inbound_buckets.items", bucketsGap),
    total: mark("inbox.inbound_buckets.total", bucketsGap),
  };
  const realtimeGap = statusUnavailable(
    "not_modelled_over_v1",
    "realtime_queue_state",
    "self_hosted_api",
    "the realtime ingestion queue lives on the server and is not published over /v1; "
      + "`queue_configured: false` would be a fabricated negative claim",
  );
  const realtime = {
    availability: realtimeGap,
    queue_configured: mark("inbox.realtime.queue_configured", realtimeGap),
    queue_url: mark("inbox.realtime.queue_url", realtimeGap),
    last_poll_at: mark("inbox.realtime.last_poll_at", realtimeGap),
    last_error: mark("inbox.realtime.last_error", realtimeGap),
  };

  // ── sources ───────────────────────────────────────────────────────────────
  // `total`/`items` stay the mail-VIEW aggregate (the shared self-hosted store
  // presented as one source) because that is what `inbox sync-status` means by a
  // source. The ingestion-source CLASSIFICATION has no /v1 equivalent, and the
  // real configured-source inventory is published separately below.
  const countedSources = input.mailboxSources.filter((source) => source.kind !== "all");
  const classificationGap = statusUnavailable(
    "not_modelled_over_v1",
    "source_classification",
    "self_hosted_mail_view",
    "the /v1 mail view exposes one shared store and carries no active/legacy/orphaned badges; "
      + "see sources.configured for the server's real ingestion-source inventory",
  );
  const configuredOk = configuredRead.availability.available;
  const configured = {
    availability: configuredRead.availability,
    total: configuredOk ? configuredRead.rows.length : mark("sources.configured.total", configuredRead.availability),
    by_status: configuredOk
      ? countByKey(configuredRead.rows, "status")
      : mark("sources.configured.by_status", configuredRead.availability),
    latest_last_synced_at: configuredOk
      ? configuredRead.rows
        .map((row) => strOrNull(row["last_synced_at"]))
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ?? null
      : mark("sources.configured.latest_last_synced_at", configuredRead.availability),
  };
  const sources = {
    availability: statusAvailable("self_hosted_mail_view", "client_enumeration"),
    total: input.mailboxSources.length,
    active: mark("sources.active", classificationGap),
    legacy: mark("sources.legacy", classificationGap),
    orphaned: mark("sources.orphaned", classificationGap),
    items: input.mailboxSources.slice(0, input.sourceLimit),
    limit: input.sourceLimit,
    truncated: countedSources.length > input.sourceLimit,
    configured,
  };

  // ── provisioning ──────────────────────────────────────────────────────────
  // Real: provisioning_status is a column on the /v1 domain and address rows.
  const pendingCount = (rows: Record<string, unknown>[]): number =>
    rows.filter((row) => !PENDING_EXCLUDED.has(str(row["provisioning_status"]))).length;
  const failedCount = (rows: Record<string, unknown>[]): number =>
    rows.filter((row) => str(row["provisioning_status"]) === "failed").length;
  const provisioningAvailability = domainsOk && addressesOk
    ? statusAvailable("self_hosted_api:/v1/domains+/v1/addresses", "client_enumeration",
      domainsRead.availability.complete !== false && addressesRead.availability.complete !== false)
    : (domainsOk ? addressesRead.availability : domainsRead.availability);
  const provisioning = {
    availability: provisioningAvailability,
    domains_pending: domainsOk ? pendingCount(domainsRead.rows) : mark("provisioning.domains_pending", domainsRead.availability),
    domains_failed: domainsOk ? failedCount(domainsRead.rows) : mark("provisioning.domains_failed", domainsRead.availability),
    addresses_pending: addressesOk ? pendingCount(addressesRead.rows) : mark("provisioning.addresses_pending", addressesRead.availability),
    addresses_failed: addressesOk ? failedCount(addressesRead.rows) : mark("provisioning.addresses_failed", addressesRead.availability),
  };

  return { database, providers, domains, addresses, inboundBuckets, realtime, sources, provisioning, gaps };
}
