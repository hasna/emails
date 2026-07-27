// The system-status facts, read from THE ONE STORE this installation configured.
//
// WHAT THIS FILE USED TO BE, and why it is not that any more. Until this change it
// was a three-module family: this facade plus two sibling implementations that were
// picked at runtime by a deployment word. The two differed by WHO RAN THE READ, not
// by what any fact means — one issued local SQL, the other enumerated an HTTP API —
// and so the same field had two definitions, two provenances and, in three places,
// two different answers. That is the axis `docs/PLAN-MODE-REMOVAL.md` deletes. Both
// sibling modules are gone; this is the whole implementation, and it reads through
// the store seam (`src/store/`), whose implementation the operator's STORAGE
// configuration selects (`src/store-resolution.ts`).
//
// THE ONE RULE THIS MODULE IS HELD TO. Every field it publishes must be OBSERVABLE
// on the store it is talking to. Where the store models the data, the number is
// measured and its provenance recorded. Where it does not — no operation returns it,
// or the operation that would is behind a capability the store declares false — the
// field is `null` with a machine-readable reason, never a 0, never `[]`, never
// `false`, never a comfortable default. See src/lib/status-availability.ts for why
// `null` and not `0`.
//
// WHAT COLLAPSING THE TWO SIBLINGS CHANGED, stated here rather than left for a
// reader to discover by diffing them. Three of these are capability LOSSES, recorded
// as named gaps rather than quietly dropped; one is a defect removal:
//
//   1. domains.send_ready / receive_ready and the per-domain `state` / `send_ready` /
//      `receive_ready` verdicts are now REFUSED, and the per-domain `issues` list no
//      longer carries DNS lines. All of it was computed by `assessDomainReadiness`
//      (src/lib/domain-readiness.ts) from `dkim_status` / `spf_status` /
//      `dmarc_status` and the inbound/outbound route columns. `DomainRecord`
//      (src/store/records.ts) carries NONE of those — the seam's record shapes were
//      derived from the strongest arm, which has no such columns — so no store
//      answers the question and the only honest reply is a reason. `issues` keeps the
//      lines the store DOES justify: provisioning state, `verified`, `last_error`.
//   2. sources.configured.* is now REFUSED. `EmailStore` has no ingestion-source
//      repository at all; the deleted HTTP sibling read a `/v1` route directly.
//   3. addresses.usable_from is now REFUSED, and this one is a DEFECT REMOVAL rather
//      than a loss. Send eligibility is `getAddressSendability`, gated on the
//      `outboundPolicy` capability, which BOTH implementations declare false
//      (src/store-sqlite/index.ts, src/store-http/index.ts) — and `AddressRecord`
//      carries no `provider_id`, so an `EnrichedAddress` cannot even be built from
//      store rows. The local sibling answered it anyway, from
//      `verified = 1 AND status != 'suspended'`. That is exactly the proxy the HTTP
//      sibling's own header forbade in writing: production holds 319 of 325
//      addresses with `verified = false` that demonstrably send. A refusal replaces
//      a fabricated verdict.
//   4. Every count is now a CLIENT ENUMERATION for both stores, because the seam
//      publishes list operations and not one aggregate. So every count carries the
//      completeness of the enumeration that produced it, and a bounded read is
//      published as a lower bound instead of a total. The local sibling's exact
//      `COUNT(*)` aggregates had no way to be wrong — and no way to say so either.
//
// THE ONE THING HERE THAT IS NOT A STORE READ. Three fields describe how this
// installation is WIRED rather than what its store holds: where the local database
// file is, which inbound buckets this installation's pullers walk, and the realtime
// ingestion queue. No store operation returns any of them, and `StoreDescriptor`
// (src/store/descriptor.ts) is two human strings that must never be branched on. So
// they are answered from STORAGE CONFIGURATION, read once, through the resolver that
// owns that question (`planEmailStore`). That is not the deleted axis wearing a new
// name, and the difference is exact: the resolver reads storage settings only, it
// answers "which store did you configure?" rather than "what kind of deployment is
// this?", and a contradiction is a refusal instead of a silently-picked winner. The
// three fields need it because ingestion into a local database is performed BY THIS
// INSTALLATION and recorded in its own config file, while ingestion into an Emails
// API is performed by the service — so an empty bucket list or a `queue_configured`
// negative would be a fabricated claim there rather than a measurement.
//
// THAT READ NOW LIVES IN `src/lib/storage-wiring.ts`, because the forwarding pipeline needs
// exactly the same fact for exactly the same reason — it performs its own forwarding when it
// owns its database and the service performs it otherwise — and a second copy of this
// reasoning is how a sanctioned narrow answer becomes an unsanctioned general one. The rule
// that decides who may ask is stated there, once.

import { dirname } from "node:path";
import { getInboundBuckets, loadConfig } from "./config.js";
import {
  readStorageWiring,
  storeErrorMessage as errorMessage,
  type StorageWiring,
} from "./storage-wiring.js";
import { enumerateStoreRows, type StoreEnumeration } from "./status-facts-enumeration.js";
import {
  StatusGaps,
  statusAvailable,
  statusUnavailable,
  type StatusAvailability,
} from "./status-availability.js";
import type { MailboxSourceSummary } from "./mail-types.js";
import type {
  AddressesStatusBlock,
  ConfiguredSourcesStatusBlock,
  DatabaseStatusBlock,
  DomainStatusRow,
  DomainsStatusBlock,
  InboundBucketsStatusBlock,
  ProvidersStatusBlock,
  ProvisioningStatusBlock,
  RealtimeStatusBlock,
  SourcesStatusBlock,
} from "./status-types.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome } from "../store/outcome.js";
import type { AddressRecord, DomainRecord, ResourceRow } from "../store/records.js";

export interface StatusFactsInput {
  /** Mailbox-view sources already resolved by the assembler. */
  mailboxSources: MailboxSourceSummary[];
  domainLimit: number;
  usableFromLimit: number;
  sourceLimit: number;
}

export interface StatusFactsBundle {
  database: DatabaseStatusBlock;
  providers: ProvidersStatusBlock;
  domains: DomainsStatusBlock;
  addresses: AddressesStatusBlock;
  inboundBuckets: InboundBucketsStatusBlock;
  realtime: RealtimeStatusBlock;
  sources: SourcesStatusBlock;
  provisioning: ProvisioningStatusBlock;
  /** Absolute dotted path -> why that field is null. */
  gaps: Record<string, StatusAvailability>;
}

/** One page read of a store list operation, as the pager calls it. */
type ListPage<TRow> = (opts: { limit: number; offset: number }) => Promise<Outcome<TRow[]>>;

/** Provisioning states that are neither pending nor a failure. */
const PENDING_EXCLUDED = new Set(["ready", "failed", "none", ""]);

/** Provenance for the facts that come from storage configuration, not from a store. */
const STORAGE_CONFIGURATION = "storage_configuration";

/** Provenance for the facts that come from the operator's own config file. */
const LOCAL_CONFIG = "local_config";

/** Provenance for the mailbox view the assembler hands in. */
const MAILBOX_VIEW = "mailbox_view";

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function strOrNull(value: unknown): string | null {
  const text = value == null ? null : String(value);
  return text === null || text === "" ? null : text;
}

/**
 * Truth across the three storage classes a row can carry it in: a real boolean from
 * the API, an integer from SQLite, a string from either.
 */
function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "true" || value === "1" || value === "t";
  return Boolean(value);
}

function countByKey(rows: ResourceRow[], key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = str(row[key]) || "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

// ── how this installation is wired ──────────────────────────────────────────────
//
// `StorageWiring` and `readStorageWiring` moved to `src/lib/storage-wiring.ts` when the
// forwarding pipeline needed the same fact for the same reason. The rule for who may ask it,
// and why it is not the deleted deployment axis under another name, is stated there once.

// WHO PERFORMS THE INGESTION, which is what the two ingestion blocks below turn on.
// An installation that keeps its mail in its own database performs its own
// ingestion: the pullers, the S3 bucket list and the realtime queue are its own and
// are recorded in its own config file, so they are observable. An installation that
// reads through an Emails API does not: ingestion belongs to the service, which
// publishes no inventory of it, so nothing on this side can observe it and a count
// or a negative flag here would be invented. Both blocks therefore branch on the
// storage wiring rather than on a config value that is empty for two different
// reasons.

// ── reading a family off the store ──────────────────────────────────────────────

/**
 * One family's rows, plus what may be said about them.
 *
 * `answered` and `exact` are separate flags because they answer separate questions,
 * and conflating them is how a partial read gets published as a total: `answered`
 * means rows were read at all, `exact` means they are ALL the rows.
 */
interface FactRead<TRow> {
  rows: TRow[];
  availability: StatusAvailability;
  /** false => every value field in the block is null and registered in `gaps`. */
  answered: boolean;
  /** false => the counts are lower bounds. Always false when `answered` is false. */
  exact: boolean;
}

/**
 * Enumerate one family and turn the enumeration into a publishable availability
 * record.
 *
 * The four outcomes map onto four DIFFERENT reasons, none of which is a zero: a
 * declared-false capability is structural, any other refusal and any thrown fault
 * are live failures, an exhausted budget and a moved window are lower bounds. A
 * caller cannot reach the rows without seeing which one it got.
 */
async function readFamily<TRow>(
  source: string,
  family: string,
  read: ListPage<TRow>,
  idOf: (row: TRow) => string | null,
): Promise<FactRead<TRow>> {
  const enumeration: StoreEnumeration<TRow> = await enumerateStoreRows(read, { idOf });

  if (enumeration.refusal !== null) {
    const refusal = enumeration.refusal;
    const prose = `the configured store refused to list ${family}: ${refusal.message}`;
    // A declared-false capability is permanent for this store and clears nothing an
    // operator can act on, so it is structural. Every other refusal code names
    // something that went wrong on this call.
    const availability = refusal.code === "capability_unavailable"
      ? statusUnavailable("not_modelled_on_store", `store_refusal:${refusal.code}`, source, prose)
      : statusUnavailable("source_unreachable", `store_refusal:${refusal.code}`, source, prose);
    return { rows: [], availability, answered: false, exact: false };
  }

  if (enumeration.fault !== null) {
    return {
      rows: [],
      availability: statusUnavailable(
        "source_unreachable",
        enumeration.fault,
        source,
        `the ${family} inventory could not be read, so no count is reported`,
      ),
      answered: false,
      exact: false,
    };
  }

  if (!enumeration.complete) {
    // Honest lower bound: the rows are real but not final. Two DIFFERENT reasons,
    // never conflated — one is "I stopped early", the other is "the store handed me
    // an inconsistent window, so rows I never saw exist".
    const reason = enumeration.stable
      ? `enumeration_cap_exceeded:${enumeration.pages} pages — counts are lower bounds, not totals`
      : `enumeration_unstable:${enumeration.duplicates} duplicate row(s)`
        + `${enumeration.shifted ? " and a shifted window" : ""} across ${enumeration.pages} pages — `
        + "the store's list order is not total under limit/offset paging, so at least that many rows "
        + "were skipped; counts are lower bounds, not totals";
    return {
      rows: enumeration.rows,
      availability: { ...statusAvailable(source, "client_enumeration", false), reason },
      answered: true,
      exact: false,
    };
  }

  return {
    rows: enumeration.rows,
    availability: statusAvailable(source, "client_enumeration"),
    answered: true,
    exact: true,
  };
}

/**
 * A read that never happened, because no store could be opened.
 *
 * Two causes, both carried verbatim in the message: the storage configuration does not
 * resolve to exactly one store, or it resolves and the store could not be constructed.
 * Either way NOTHING was read, so the rows are empty for a reason that has nothing to
 * do with how many rows exist.
 */
function unresolvedRead<TRow>(family: string, message: string): FactRead<TRow> {
  return {
    rows: [],
    availability: statusUnavailable(
      "source_unreachable",
      "store_unresolved",
      STORAGE_CONFIGURATION,
      `no store could be opened from this installation's storage configuration, so the ${family} `
        + `inventory was never read: ${message}`,
    ),
    answered: false,
    exact: false,
  };
}

function resourceRowId(row: ResourceRow): string | null {
  return row["id"] == null ? null : String(row["id"]);
}

/**
 * Turn a block's own availability record into the field-level gap that a DERIVED
 * value has to carry.
 *
 * Used where a number is aggregated out of an inventory that ANSWERED but not in
 * full: the block is available, the derived field is not, and copying the record
 * with `available: false` keeps the original reason attached to the field it
 * actually nulled.
 */
function derivedGap(availability: StatusAvailability): StatusAvailability {
  return { ...availability, available: false, basis: null, complete: null };
}

// ── domain rows ─────────────────────────────────────────────────────────────────

/**
 * Issues justified by a column the store actually returned.
 *
 * No DNS verdicts: the store's domain record carries no DKIM/SPF/DMARC evidence, so
 * an issue list that named one would be inventing it.
 */
function domainIssues(row: DomainRecord): string[] {
  const issues: string[] = [];
  const provisioning = str(row.provisioning_status);
  if (provisioning === "failed") issues.push("Provisioning failed");
  else if (provisioning && !PENDING_EXCLUDED.has(provisioning)) issues.push(`Provisioning ${provisioning}`);
  if (!truthy(row.verified)) issues.push("Not verified");
  const lastError = strOrNull(row.last_error);
  if (lastError) issues.push(lastError);
  return issues;
}

/**
 * Remedies justified by the same columns — and only commands that RUN.
 *
 * `emails domain status` is deliberately absent: src/cli/commands/domain.ts refuses
 * it unconditionally, and src/lib/agent-context.ts promotes `fix_commands[0]`
 * straight into `next_actions`, so proposing it made this module emit the refusal the
 * status rework exists to stop. `domain list` reads the same rows and runs. The
 * deleted local sibling had the same defect one level down: its readiness helper
 * proposed `emails domain check|dns|verify`, all of which refuse everywhere.
 */
function domainFixCommands(row: DomainRecord): string[] {
  if (!str(row.domain)) return [];
  if (str(row.provisioning_status) === "failed" || strOrNull(row.last_error)) {
    return ["emails domain list --json", "emails address list --json"];
  }
  return [];
}

// ── the facts ───────────────────────────────────────────────────────────────────

/**
 * Gather every system-status fact.
 *
 * `store` is an INJECTION POINT FOR TESTS. A caller that passes nothing gets the
 * store this installation's configuration means, which is what every shipped call
 * site wants; a caller that passes one is responsible for the environment agreeing
 * with it, because the three wiring fields are read from configuration either way.
 */
export async function collectStatusFacts(
  input: StatusFactsInput,
  store?: EmailStore,
): Promise<StatusFactsBundle> {
  const gaps = new StatusGaps();
  const wiring = readStorageWiring(process.env);

  let resolved: EmailStore | null = store ?? null;
  let storeError: string | null = null;
  if (resolved === null) {
    try {
      resolved = createConfiguredEmailStore();
    } catch (error) {
      storeError = errorMessage(error);
    }
  }
  const kind = resolved === null ? "unresolved_store" : resolved.descriptor.kind;
  const sourceOf = (family: string): string => `${kind}:${family}`;

  const readOrRefuse = async <TRow>(
    family: string,
    listPage: (open: EmailStore) => ListPage<TRow>,
    idOf: (row: TRow) => string | null,
  ): Promise<FactRead<TRow>> => {
    const open = resolved;
    if (open === null) {
      return unresolvedRead<TRow>(family, storeError ?? "the storage configuration is contradictory");
    }
    return readFamily(sourceOf(family), family, listPage(open), idOf);
  };

  const [providersRead, domainsRead, addressesRead] = await Promise.all([
    readOrRefuse<ResourceRow>("providers", (open) => (opts) => open.providers.list(opts), resourceRowId),
    readOrRefuse<DomainRecord>("domains", (open) => (opts) => open.domains.listDomains(opts), (row) => row.id),
    readOrRefuse<AddressRecord>("addresses", (open) => (opts) => open.addresses.listAddresses(opts), (row) => row.id),
  ]);

  return {
    database: databaseBlock(wiring, gaps),
    providers: providersBlock(providersRead, gaps),
    domains: domainsBlock(input, providersRead, domainsRead, addressesRead, gaps),
    addresses: addressesBlock(input, addressesRead, resolved, sourceOf("addresses"), gaps),
    inboundBuckets: inboundBucketsBlock(wiring, gaps),
    realtime: realtimeBlock(wiring, gaps),
    sources: sourcesBlock(input, sourceOf("sources"), gaps),
    provisioning: provisioningBlock(domainsRead, addressesRead, kind, gaps),
    gaps: gaps.toRecord(),
  };
}

function databaseBlock(wiring: StorageWiring, gaps: StatusGaps): DatabaseStatusBlock {
  const refuse = (availability: StatusAvailability): DatabaseStatusBlock => ({
    availability,
    data_dir: gaps.mark("database.data_dir", availability),
  });
  switch (wiring.kind) {
    case "database_file":
      return {
        availability: statusAvailable(STORAGE_CONFIGURATION, LOCAL_CONFIG),
        data_dir: dirname(wiring.path),
      };
    case "database_in_memory":
      return refuse(statusUnavailable(
        "not_applicable",
        "in_memory_database",
        STORAGE_CONFIGURATION,
        "this installation's database is in memory, so there is no data directory",
      ));
    case "api":
      return refuse(statusUnavailable(
        "not_applicable",
        "no_local_database_configured",
        STORAGE_CONFIGURATION,
        "this installation keeps its mail in an Emails API, so it holds no local data directory",
      ));
    case "unresolved":
      return refuse(statusUnavailable(
        "source_unreachable",
        "store_unresolved",
        STORAGE_CONFIGURATION,
        `this installation's storage configuration does not name one store: ${wiring.message}`,
      ));
  }
}

function providersBlock(providersRead: FactRead<ResourceRow>, gaps: StatusGaps): ProvidersStatusBlock {
  const availability = providersRead.availability;
  if (!providersRead.answered) {
    return {
      availability,
      total: gaps.mark("providers.total", availability),
      active: gaps.mark("providers.active", availability),
      by_type: gaps.mark("providers.by_type", availability),
    };
  }
  const active = providersRead.rows.filter((row) => truthy(row["active"]));
  return {
    availability,
    total: providersRead.rows.length,
    active: active.length,
    by_type: countByKey(active, "type"),
  };
}

function domainsBlock(
  input: StatusFactsInput,
  providersRead: FactRead<ResourceRow>,
  domainsRead: FactRead<DomainRecord>,
  addressesRead: FactRead<AddressRecord>,
  gaps: StatusGaps,
): DomainsStatusBlock {
  const availability = domainsRead.availability;

  // Send/receive readiness needs DNS evidence and route state. `DomainRecord` carries
  // neither, so no store answers it. The real `verified` column is reported instead,
  // and it is a column rather than a substitute verdict.
  const dnsEvidenceGap = statusUnavailable(
    "not_modelled_on_store",
    "domain_dns_evidence",
    availability.source,
    "the store's domain record (src/store/records.ts DomainRecord) carries no DKIM/SPF/DMARC records "
      + "and no inbound/outbound route state, so send/receive readiness cannot be computed from it; "
      + "the real `verified` column is reported instead",
  );

  if (!domainsRead.answered) {
    return {
      availability,
      total: gaps.mark("domains.total", availability),
      verified: gaps.mark("domains.verified", availability),
      send_ready: gaps.mark("domains.send_ready", availability),
      receive_ready: gaps.mark("domains.receive_ready", availability),
      usable: gaps.mark("domains.usable", availability),
      usable_limit: input.domainLimit,
      // NOT `false`. Nothing was read, so whether a sample would leave rows out is
      // unknown, and `false` claims the (absent) sample is the whole list.
      usable_truncated: gaps.mark("domains.usable_truncated", availability),
    };
  }

  // A per-domain ready-address count is an AGGREGATE over the whole address
  // inventory, so it inherits THAT inventory's completeness rather than this block's.
  // `answered` alone is not enough: a partial enumeration still returns rows, and
  // every domain whose address rows fell in the skipped window would be counted down
  // to a confident `0` — published inside a block whose own enumeration is complete,
  // so a renderer would print it without the `≥` that marks a bound.
  const readyAddressesCountable = addressesRead.answered && addressesRead.exact;
  const readyAddressesByDomain = new Map<string, number>();
  if (addressesRead.answered) {
    for (const row of addressesRead.rows) {
      const domainId = strOrNull(row.domain_id);
      if (domainId === null || str(row.provisioning_status) !== "ready") continue;
      readyAddressesByDomain.set(domainId, (readyAddressesByDomain.get(domainId) ?? 0) + 1);
    }
  }

  const providerNames = new Map(providersRead.rows.map((row) => [str(row["id"]), str(row["name"])]));

  // A TOTAL order, matching what the SQLite store's own list already applies
  // (`created_at DESC, id DESC`). Sorting on the timestamp alone leaves rows created
  // in the same millisecond in whatever order the enumeration happened to see them,
  // so which domains land in the sample would drift between runs on exactly the
  // installations where every row was seeded at once.
  const sorted = [...domainsRead.rows].sort((a, b) =>
    str(b.created_at).localeCompare(str(a.created_at)) || str(b.id).localeCompare(str(a.id)));
  const sample = sorted.slice(0, input.domainLimit);
  const usable: DomainStatusRow[] = sample.map((row) => {
    const providerId = str(row.provider);
    return {
      id: row.id,
      domain: str(row.domain),
      provider_id: providerId,
      provider_name: providerNames.get(providerId) ?? null,
      state: null,
      send_ready: null,
      receive_ready: null,
      ready_addresses: readyAddressesCountable ? (readyAddressesByDomain.get(row.id) ?? 0) : null,
      provisioning_status: strOrNull(row.provisioning_status),
      last_error: strOrNull(row.last_error),
      next_check_at: strOrNull(row.next_check_at),
      issues: domainIssues(row),
      fix_commands: domainFixCommands(row),
    };
  });

  if (usable.length > 0) {
    gaps.mark("domains.usable[].state", dnsEvidenceGap);
    gaps.mark("domains.usable[].send_ready", dnsEvidenceGap);
    gaps.mark("domains.usable[].receive_ready", dnsEvidenceGap);
    if (!readyAddressesCountable) {
      // Two different reasons again: the address inventory could not be read at all,
      // or it answered with only some of its rows. A per-domain aggregate cannot be
      // published as a lower bound — a DomainStatusRow carries no availability record
      // of its own — so it is nulled either way, with the address block's reason.
      gaps.mark(
        "domains.usable[].ready_addresses",
        addressesRead.answered ? derivedGap(addressesRead.availability) : addressesRead.availability,
      );
    }
    if (!providersRead.exact) {
      // Without this the provider column of every sampled row reads as "no provider is
      // attached" when the truth is that the provider inventory was never read — or was
      // read only in part, in which case a provider that really exists is simply one of
      // the rows the enumeration skipped. Both are gaps; only one is a read failure.
      gaps.mark(
        "domains.usable[].provider_name",
        providersRead.answered ? derivedGap(providersRead.availability) : providersRead.availability,
      );
    }
  }

  return {
    availability,
    total: domainsRead.rows.length,
    verified: domainsRead.rows.filter((row) => truthy(row.verified)).length,
    send_ready: gaps.mark("domains.send_ready", dnsEvidenceGap),
    receive_ready: gaps.mark("domains.receive_ready", dnsEvidenceGap),
    usable,
    usable_limit: input.domainLimit,
    // `|| !exact` because the field claims "the sample is not the whole list", and an
    // incomplete enumeration means exactly that whether or not the rows it managed to
    // read outnumbered the limit. The type admits no null, so the alternative is
    // `false` — a claim that the sample is complete, made about a read that is known
    // not to be.
    usable_truncated: sorted.length > input.domainLimit || !domainsRead.exact,
  };
}

function addressesBlock(
  input: StatusFactsInput,
  addressesRead: FactRead<AddressRecord>,
  store: EmailStore | null,
  source: string,
  gaps: StatusGaps,
): AddressesStatusBlock {
  const availability = addressesRead.availability;

  // Send eligibility is a POLICY answer, and it is gated on `outboundPolicy`. The gap
  // names the store's OWN declaration rather than asserting the answer, so a store
  // that one day declares the capability true produces a different reason instead of
  // the same stale one.
  const declared = store === null ? "nothing about (no store could be resolved)" : String(store.capabilities.outboundPolicy);
  const sendEligibilityGap = statusUnavailable(
    "not_modelled_on_store",
    "store_capability_outboundPolicy",
    source,
    "send eligibility is getAddressSendability, gated on the outboundPolicy capability, which this "
      + `store declares ${declared}; the store's address record also carries no provider_id, so an `
      + "enriched sender row cannot be built from it. The `verified` column is NOT a send-readiness "
      + "proxy — mail sends from verified=false rows — so a list derived from it would be a "
      + "fabricated verdict",
  );

  if (!addressesRead.answered) {
    return {
      availability,
      total: gaps.mark("addresses.total", availability),
      active: gaps.mark("addresses.active", availability),
      verified: gaps.mark("addresses.verified", availability),
      owned: gaps.mark("addresses.owned", availability),
      ready_to_receive: gaps.mark("addresses.ready_to_receive", availability),
      usable_from: gaps.mark("addresses.usable_from", availability),
      usable_from_limit: input.usableFromLimit,
      usable_from_truncated: gaps.mark("addresses.usable_from_truncated", availability),
    };
  }

  const rows = addressesRead.rows;
  return {
    availability,
    total: rows.length,
    active: rows.filter((row) => str(row.status) !== "suspended").length,
    verified: rows.filter((row) => truthy(row.verified)).length,
    owned: rows.filter((row) => strOrNull(row.owner_id) !== null).length,
    ready_to_receive: rows.filter((row) => str(row.provisioning_status) === "ready").length,
    usable_from: gaps.mark("addresses.usable_from", sendEligibilityGap),
    usable_from_limit: input.usableFromLimit,
    // The list itself is refused, so "is it truncated?" has no answer either. `false`
    // here would be a confident claim about a list that was never produced.
    usable_from_truncated: gaps.mark("addresses.usable_from_truncated", sendEligibilityGap),
  };
}

function inboundBucketsBlock(wiring: StorageWiring, gaps: StatusGaps): InboundBucketsStatusBlock {
  const refuse = (availability: StatusAvailability): InboundBucketsStatusBlock => ({
    availability,
    items: gaps.mark("inbox.inbound_buckets.items", availability),
    total: gaps.mark("inbox.inbound_buckets.total", availability),
  });

  if (wiring.kind === "api") {
    return refuse(statusUnavailable(
      "not_applicable",
      "service_owned_ingestion",
      STORAGE_CONFIGURATION,
      "this installation reads its mail through an Emails API, so inbound S3 buckets belong to that "
        + "service and it publishes no inventory of them; an empty list here would falsely claim no "
        + "bucket is configured",
    ));
  }
  if (wiring.kind === "unresolved") {
    return refuse(statusUnavailable(
      "source_unreachable",
      "store_unresolved",
      STORAGE_CONFIGURATION,
      "this installation's storage configuration does not name one store, so whether it ingests its "
        + `own mail is not known: ${wiring.message}`,
    ));
  }
  try {
    const items = getInboundBuckets();
    return { availability: statusAvailable(LOCAL_CONFIG, LOCAL_CONFIG), items, total: items.length };
  } catch (error) {
    return refuse(statusUnavailable(
      "source_unreachable",
      errorMessage(error),
      LOCAL_CONFIG,
      "the inbound bucket list could not be read from this installation's config file",
    ));
  }
}

function realtimeBlock(wiring: StorageWiring, gaps: StatusGaps): RealtimeStatusBlock {
  const refuse = (availability: StatusAvailability): RealtimeStatusBlock => ({
    availability,
    queue_configured: gaps.mark("inbox.realtime.queue_configured", availability),
    queue_url: gaps.mark("inbox.realtime.queue_url", availability),
    last_poll_at: gaps.mark("inbox.realtime.last_poll_at", availability),
    last_error: gaps.mark("inbox.realtime.last_error", availability),
  });

  if (wiring.kind === "api") {
    return refuse(statusUnavailable(
      "not_applicable",
      "service_owned_ingestion",
      STORAGE_CONFIGURATION,
      "the realtime ingestion queue belongs to the Emails API this installation reads through and is "
        + "not published to clients; a negative here would be a fabricated claim rather than a "
        + "measurement",
    ));
  }
  if (wiring.kind === "unresolved") {
    return refuse(statusUnavailable(
      "source_unreachable",
      "store_unresolved",
      STORAGE_CONFIGURATION,
      "this installation's storage configuration does not name one store, so whether it ingests its "
        + `own mail is not known: ${wiring.message}`,
    ));
  }

  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = loadConfig();
  } catch (error) {
    return refuse(statusUnavailable(
      "source_unreachable",
      errorMessage(error),
      LOCAL_CONFIG,
      "the realtime queue settings could not be read from this installation's config file",
    ));
  }
  const configString = (key: string): string | null => {
    const value = config[key];
    return typeof value === "string" && value.trim() ? value : null;
  };
  const queueUrl = configString("inbound_realtime_queue_url");
  return {
    availability: statusAvailable(LOCAL_CONFIG, LOCAL_CONFIG),
    queue_configured: queueUrl !== null,
    queue_url: queueUrl,
    last_poll_at: configString("inbound_realtime_last_poll_at"),
    last_error: configString("inbound_realtime_last_error"),
  };
}

function sourcesBlock(input: StatusFactsInput, source: string, gaps: StatusGaps): SourcesStatusBlock {
  // THE AGGREGATE ROW IS NOT A SOURCE. The mailbox view puts one at the head of its
  // list (`kind: "all"` — src/cli/tui/data.local.ts, and it is the ONLY row the view
  // in src/lib/self-hosted-mail-data-source.ts returns, because that store is a
  // single shared one). The two deleted siblings disagreed about exactly this field
  // and BOTH were wrong in one direction:
  //
  //   * counting the whole list (what the HTTP sibling did) reports one ingestion
  //     source on an installation that has configured none — the aggregate row is
  //     always there — which suppresses the setup remedy src/lib/agent-context.ts
  //     derives from a zero.
  //   * counting only the non-aggregate rows (what the local sibling did) reports
  //     ZERO ingestion sources for a view that publishes only its aggregate, i.e. it
  //     reads "nothing is delivering mail" off a view that never enumerates sources
  //     at all.
  //
  // So neither answer is adopted. The count is the non-aggregate rows, and a view
  // that returned ONLY an aggregate is reported as not answering the question —
  // which is the one thing that is actually observable about it. Nothing is lost on
  // an un-configured local installation: an active provider always yields a
  // non-aggregate row, so "aggregate only" there means no provider, no bucket and no
  // stored mail, and `providers.total` / `addresses.total` already carry that zero.
  const counted = input.mailboxSources.filter((entry) => entry.kind !== "all");
  const aggregateOnly = counted.length === 0 && input.mailboxSources.length > 0;
  const enumerationGap = statusUnavailable(
    "not_modelled_on_store",
    "aggregate_only_mailbox_view",
    MAILBOX_VIEW,
    "the mailbox view this installation reads publishes one aggregate row and no per-source "
      + "inventory, so the number of ingestion sources cannot be measured; the aggregate is listed "
      + "in `items`",
  );

  // Whether the view CLASSIFIES its sources is observable: it either badges them or
  // it does not. A view that badges none cannot distinguish "no source is legacy"
  // from "this view has no notion of legacy", and answering the second with a count
  // is the fabricated negative this payload exists to remove.
  const classified = counted.some((entry) => entry.badges.length > 0);
  const classificationGap = statusUnavailable(
    "not_modelled_on_store",
    "source_classification",
    MAILBOX_VIEW,
    "the mailbox view this installation reads publishes no active/legacy/orphaned badge on any of its "
      + "sources, so the classification counts cannot be measured; a count would claim none is legacy "
      + "or orphaned rather than admitting the view does not say",
  );
  const badged = (badge: string): number => counted.filter((entry) => entry.badges.includes(badge)).length;

  const configuredGap = statusUnavailable(
    "not_modelled_on_store",
    "no_ingestion_source_repository",
    source,
    "the ingestion-source inventory has no repository on the store seam (src/store/email-store.ts "
      + "declares none), so no store operation answers it; the mailbox view above is what "
      + "`emails inbox sync-status` reads",
  );
  const configured: ConfiguredSourcesStatusBlock = {
    availability: configuredGap,
    total: gaps.mark("sources.configured.total", configuredGap),
    by_status: gaps.mark("sources.configured.by_status", configuredGap),
    latest_last_synced_at: gaps.mark("sources.configured.latest_last_synced_at", configuredGap),
  };

  return {
    availability: statusAvailable(MAILBOX_VIEW, "client_enumeration"),
    total: aggregateOnly ? gaps.mark("sources.total", enumerationGap) : counted.length,
    active: classified
      ? counted.filter((entry) => entry.badges.includes("active") || entry.badges.includes("configured")).length
      : gaps.mark("sources.active", classificationGap),
    legacy: classified ? badged("legacy") : gaps.mark("sources.legacy", classificationGap),
    orphaned: classified ? badged("orphaned") : gaps.mark("sources.orphaned", classificationGap),
    items: input.mailboxSources.slice(0, input.sourceLimit),
    limit: input.sourceLimit,
    truncated: counted.length > input.sourceLimit,
    configured,
  };
}

function provisioningBlock(
  domainsRead: FactRead<DomainRecord>,
  addressesRead: FactRead<AddressRecord>,
  kind: string,
  gaps: StatusGaps,
): ProvisioningStatusBlock {
  const pending = (rows: Array<{ provisioning_status?: string }>): number =>
    rows.filter((row) => !PENDING_EXCLUDED.has(str(row.provisioning_status))).length;
  const failed = (rows: Array<{ provisioning_status?: string }>): number =>
    rows.filter((row) => str(row.provisioning_status) === "failed").length;

  // The block spans TWO inventories, so its availability is the weaker of the two:
  // available only when both answered, complete only when both are complete.
  const availability = domainsRead.answered && addressesRead.answered
    ? statusAvailable(`${kind}:domains+addresses`, "client_enumeration", domainsRead.exact && addressesRead.exact)
    : (domainsRead.answered ? addressesRead.availability : domainsRead.availability);

  return {
    availability,
    domains_pending: domainsRead.answered
      ? pending(domainsRead.rows)
      : gaps.mark("provisioning.domains_pending", domainsRead.availability),
    domains_failed: domainsRead.answered
      ? failed(domainsRead.rows)
      : gaps.mark("provisioning.domains_failed", domainsRead.availability),
    addresses_pending: addressesRead.answered
      ? pending(addressesRead.rows)
      : gaps.mark("provisioning.addresses_pending", addressesRead.availability),
    addresses_failed: addressesRead.answered
      ? failed(addressesRead.rows)
      : gaps.mark("provisioning.addresses_failed", addressesRead.availability),
  };
}
