import type { Domain, DomainMonitoringStatus, DomainOwnershipStatus, DomainRouteStatus, DomainSourceOfTruth, DomainType, Provider } from "../types/index.js";
import { now } from "../db/runtime.js";
import {
  findDomainsByName,
  getDomain,
  getDomainByName,
  listDomains,
  updateDomainReadiness,
  type DomainReadinessUpdate,
  type ListDomainOptions,
} from "../db/domains.js";
import { getProvider } from "../db/providers.js";
import {
  getDomainProvisioning,
  listDomainProvisioningByIds,
  listReadyAddressCountsByDomains,
  setDomainProvisioning,
  type DomainProvisioning,
} from "../db/provisioning.js";
import { assessDomainReadiness, type DomainReadiness } from "./domain-readiness.js";
import { domainInboundReadinessSignals } from "./domain-inbound-evidence.js";
import { resolveEmailsMode, type EmailsModeResolution } from "./mode.js";

export type DomainReadinessProviderSummary = Pick<Provider, "id" | "name" | "type" | "region" | "active">;

export interface DomainLifecycleReadiness extends DomainReadiness {
  inbound_ready: boolean;
  outbound_ready: boolean;
  monitored: boolean;
  restricted: boolean;
  suspended: boolean;
}

export interface DomainDnsLifecycleStatus {
  dkim: Domain["dkim_status"];
  spf: Domain["spf_status"];
  dmarc: Domain["dmarc_status"];
  missing_records: string[];
  warnings: string[];
}

export interface DomainLifecycleSummary {
  id: string;
  domain: string;
  mode: EmailsModeResolution["mode"];
  mode_label: EmailsModeResolution["label"];
  source_of_truth: DomainSourceOfTruth;
  domain_type: DomainType;
  provider: DomainReadinessProviderSummary | null;
  ownership_status: Domain["ownership_status"];
  inbound_status: Domain["inbound_status"];
  outbound_status: Domain["outbound_status"];
  monitoring_status: Domain["monitoring_status"];
  readiness: DomainLifecycleReadiness;
  dns: DomainDnsLifecycleStatus;
  provisioning: DomainProvisioning | null;
  provider_metadata: Record<string, unknown>;
  missing_requirements: string[];
  next_actions: string[];
}

export interface BuildDomainLifecycleSummaryOptions {
  mode?: EmailsModeResolution;
  provider?: Provider | null;
  provisioning?: DomainProvisioning | null;
  ready_addresses?: number;
}

export interface ListDomainLifecycleSummaryOptions extends ListDomainOptions {
  provider_id?: string;
  mode?: EmailsModeResolution;
}

export interface ResolveDomainLifecycleOptions {
  provider_id?: string;
  mode?: EmailsModeResolution;
}

export interface DomainReadinessMutationInput {
  domain_type?: DomainType;
  source_of_truth?: DomainSourceOfTruth;
  ownership_status?: DomainOwnershipStatus;
  inbound_status?: DomainRouteStatus;
  outbound_status?: DomainRouteStatus;
  monitoring_status?: DomainMonitoringStatus;
  dns_records?: Record<string, unknown>;
  provider_metadata?: Record<string, unknown>;
  last_dns_check_at?: string | null;
  last_inbound_check_at?: string | null;
  last_outbound_check_at?: string | null;
  last_monitored_at?: string | null;
  restricted_at?: string | null;
  suspended_at?: string | null;
  force?: boolean;
}

export interface DomainReadinessMutationResult {
  before: DomainLifecycleSummary;
  after: DomainLifecycleSummary;
  updated: Domain;
}

/**
 * ASYNCHRONOUS BECAUSE THE PROVISIONING READS ARE. Every summary carries the domain's
 * provisioning columns and its ready-address count, and `src/db/provisioning.ts` reaches
 * those through the store seam, where every operation returns a promise. Three of these
 * were synchronous and are re-exported from `src/index.ts`; the shape change is recorded
 * there.
 */
export interface DomainReadinessService {
  list(options?: Omit<ListDomainLifecycleSummaryOptions, "db">): Promise<DomainLifecycleSummary[]>;
  get(domainOrId: string, options?: Omit<ResolveDomainLifecycleOptions, "db">): Promise<DomainLifecycleSummary>;
  update(domainOrId: string, input: DomainReadinessMutationInput, options?: Omit<ResolveDomainLifecycleOptions, "db">): Promise<DomainReadinessMutationResult>;
}

/**
 * Refuse to publish a readiness verdict built from TWO DIFFERENT DATASETS.
 *
 * The domain rows come from `listDomains`, which is still a two-arm family routing on the
 * deployment word. The provisioning columns and the ready-address counts come from
 * `src/db/provisioning`, which resolves its store from the STORAGE CONFIGURATION instead.
 * Those are different resolvers reading different inputs, and they can disagree: an
 * installation with an API url and key exported but no deployment word set resolves `local`
 * for the domain rows and `api` for the provisioning read. Every local domain id is then
 * absent from both maps.
 *
 * Absence is normally a VALUE here — it is what the two deleted arms did, and it is safe when
 * both reads saw the same table, because every `domains` row carries its own provisioning
 * columns and therefore always resolves. Absence for EVERY id is different: it is the
 * signature of two datasets, and publishing it would report a fully provisioned installation
 * as `provisioning: null, ready_addresses: 0` — a confident, wrong readiness verdict on
 * `GET /api/domains/readiness`, `emails domain list` and the MCP domains resource. That is the
 * exact fabricated zero this programme exists to remove, so it is a refusal.
 *
 * This guard disappears when `src/db/domains` collapses onto the seam too and both reads take
 * the same store. Adversarial review found the split.
 */
function assertOneDataset(domainIds: string[], resolved: number): void {
  if (domainIds.length === 0 || resolved > 0) return;
  throw new Error(
    `This installation resolved ${domainIds.length} domain(s) but no provisioning state for any `
      + "of them. Every domain row carries its own provisioning columns, so this means the "
      + "domain list and the provisioning read reached different storage; refusing to report "
      + "these domains as unprovisioned",
  );
}

function providerSummary(provider: Provider | null): DomainReadinessProviderSummary | null {
  if (!provider) return null;
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    region: provider.region,
    active: provider.active,
  };
}

function resolveMode(mode?: EmailsModeResolution): EmailsModeResolution {
  return mode ?? resolveEmailsMode();
}

export function defaultDomainSourceOfTruth(mode: EmailsModeResolution["mode"]): DomainSourceOfTruth {
  if (mode === "self_hosted") return "postgres";
  return "local";
}

export function assessDomainLifecycleReadiness(
  domain: Domain,
  mode: EmailsModeResolution,
  readyAddresses: number,
  provisioning: DomainProvisioning | null,
): DomainReadiness {
  return assessDomainReadiness(domain, provisioning, {
    ...domainInboundReadinessSignals(domain, mode),
    ready_addresses: readyAddresses,
  });
}

function lifecycleSummaryFromParts(
  domain: Domain,
  opts: Required<Pick<BuildDomainLifecycleSummaryOptions, "mode">> & {
    provider: Provider | null;
    provisioning: DomainProvisioning | null;
    ready_addresses: number;
  },
): DomainLifecycleSummary {
  const readiness = assessDomainLifecycleReadiness(domain, opts.mode, opts.ready_addresses, opts.provisioning);
  const missingRecords: string[] = [];
  const warnings: string[] = [];
  const missingRequirements: string[] = [];
  const nextActions: string[] = [];

  if (domain.dkim_status !== "verified") missingRecords.push("DKIM");
  if (domain.spf_status !== "verified") missingRecords.push("SPF");
  if (domain.dmarc_status !== "verified") {
    missingRecords.push("DMARC");
    warnings.push("DMARC is per-domain monitoring; it does not block inbound aggregation.");
  }
  if (!opts.provider) missingRequirements.push("provider is missing");
  if (domain.ownership_status !== "verified") missingRequirements.push("domain ownership is not verified");
  if (!readiness.receive_ready) missingRequirements.push("inbound route is not ready");
  if (domain.outbound_status !== "ready") missingRequirements.push("outbound sending is not enabled");
  if (domain.dkim_status !== "verified") missingRequirements.push("DKIM is not verified");
  if (domain.spf_status !== "verified") missingRequirements.push("SPF is not verified");

  if (missingRecords.length > 0) nextActions.push(`emails domains dns ${domain.domain}`);
  if (domain.dkim_status !== "verified" || domain.spf_status !== "verified") nextActions.push(`emails domains verify ${domain.domain}`);
  if (!readiness.receive_ready) nextActions.push(readiness.fix_commands.find((command) => command.includes("domain adopt")) ?? `emails domains enable-inbound ${domain.domain} --force`);
  if (domain.outbound_status !== "ready") nextActions.push(`emails domains enable-outbound ${domain.domain}`);
  if (opts.mode.warning) warnings.push(opts.mode.warning);

  return {
    id: domain.id,
    domain: domain.domain,
    mode: opts.mode.mode,
    mode_label: opts.mode.label,
    source_of_truth: domain.source_of_truth,
    domain_type: domain.domain_type,
    provider: providerSummary(opts.provider),
    ownership_status: domain.ownership_status,
    inbound_status: domain.inbound_status,
    outbound_status: domain.outbound_status,
    monitoring_status: domain.monitoring_status,
    readiness: {
      ...readiness,
      inbound_ready: readiness.receive_ready,
      outbound_ready: domain.outbound_status === "ready" && readiness.send_ready,
      monitored: domain.monitoring_status === "monitoring" || domain.monitoring_status === "clean",
      restricted: !!domain.restricted_at || domain.outbound_status === "disabled",
      suspended: !!domain.suspended_at,
    },
    dns: {
      dkim: domain.dkim_status,
      spf: domain.spf_status,
      dmarc: domain.dmarc_status,
      missing_records: missingRecords,
      warnings,
    },
    provisioning: opts.provisioning,
    provider_metadata: domain.provider_metadata,
    missing_requirements: [...new Set(missingRequirements)],
    next_actions: [...new Set(nextActions)],
  };
}

export async function buildDomainLifecycleSummary(
  domain: Domain,
  opts: BuildDomainLifecycleSummaryOptions = {},
): Promise<DomainLifecycleSummary> {
  return lifecycleSummaryFromParts(domain, {
    mode: resolveMode(opts.mode),
    provider: opts.provider === undefined ? getProvider(domain.provider_id) : opts.provider,
    provisioning: opts.provisioning === undefined ? await getDomainProvisioning(domain.id) : opts.provisioning,
    // `?? 0` on a MISSING key, never on a truncated read: `listReadyAddressCountsByDomains`
    // refuses rather than returning a short map, so an absent domain here means the whole
    // address table was read and none of it belongs to this domain.
    ready_addresses: opts.ready_addresses ?? ((await listReadyAddressCountsByDomains([domain.id])).get(domain.id) ?? 0),
  });
}

export async function buildDomainLifecycleSummaries(
  domains: Domain[],
  opts: Pick<BuildDomainLifecycleSummaryOptions, "mode"> = {},
): Promise<DomainLifecycleSummary[]> {
  if (domains.length === 0) return [];
  const mode = resolveMode(opts.mode);
  const domainIds = domains.map((domain) => domain.id);
  const provisioningById = await listDomainProvisioningByIds(domainIds);
  const readyAddressesById = await listReadyAddressCountsByDomains(domainIds);
  assertOneDataset(domainIds, provisioningById.size);
  const providerById = new Map<string, Provider | null>();

  return domains.map((domain) => {
    if (!providerById.has(domain.provider_id)) {
      providerById.set(domain.provider_id, getProvider(domain.provider_id));
    }
    return lifecycleSummaryFromParts(domain, {
      mode,
      provider: providerById.get(domain.provider_id) ?? null,
      provisioning: provisioningById.get(domain.id) ?? null,
      ready_addresses: readyAddressesById.get(domain.id) ?? 0,
    });
  });
}

export function listDomainLifecycleSummaries(options: ListDomainLifecycleSummaryOptions = {}): Promise<DomainLifecycleSummary[]> {
  const domains = listDomains(options.provider_id, { limit: options.limit, offset: options.offset });
  return buildDomainLifecycleSummaries(domains, { mode: options.mode });
}

export function resolveDomainLifecycleRecord(
  domainOrId: string,
  options: Pick<ResolveDomainLifecycleOptions, "provider_id"> = {},
): Domain {
  if (options.provider_id) {
    const domain = getDomainByName(options.provider_id, domainOrId);
    if (!domain) throw new Error(`Domain not found for provider ${options.provider_id}: ${domainOrId}`);
    return domain;
  }

  const byId = getDomain(domainOrId);
  if (byId) return byId;

  const matches = findDomainsByName(domainOrId);
  if (matches.length === 0) throw new Error(`Domain not found: ${domainOrId}`);
  if (matches.length > 1) {
    const choices = matches.map((domain) => `${domain.domain} provider=${domain.provider_id.slice(0, 8)}`).join(", ");
    throw new Error(`Domain is ambiguous; pass provider_id. Matches: ${choices}`);
  }
  return matches[0]!;
}

export function getDomainLifecycleSummary(
  domainOrId: string,
  options: ResolveDomainLifecycleOptions = {},
): Promise<DomainLifecycleSummary> {
  const domain = resolveDomainLifecycleRecord(domainOrId, { provider_id: options.provider_id });
  return buildDomainLifecycleSummary(domain, { mode: options.mode });
}

function toReadinessUpdate(input: DomainReadinessMutationInput): DomainReadinessUpdate {
  const update: DomainReadinessUpdate = {};
  if (input.domain_type !== undefined) update.domain_type = input.domain_type;
  if (input.source_of_truth !== undefined) update.source_of_truth = input.source_of_truth;
  if (input.ownership_status !== undefined) update.ownership_status = input.ownership_status;
  if (input.inbound_status !== undefined) update.inbound_status = input.inbound_status;
  if (input.outbound_status !== undefined) update.outbound_status = input.outbound_status;
  if (input.monitoring_status !== undefined) update.monitoring_status = input.monitoring_status;
  if (input.dns_records !== undefined) update.dns_records = input.dns_records;
  if (input.provider_metadata !== undefined) update.provider_metadata = input.provider_metadata;
  if (input.last_dns_check_at !== undefined) update.last_dns_check_at = input.last_dns_check_at;
  if (input.last_inbound_check_at !== undefined) update.last_inbound_check_at = input.last_inbound_check_at;
  if (input.last_outbound_check_at !== undefined) update.last_outbound_check_at = input.last_outbound_check_at;
  if (input.last_monitored_at !== undefined) update.last_monitored_at = input.last_monitored_at;
  if (input.restricted_at !== undefined) update.restricted_at = input.restricted_at;
  if (input.suspended_at !== undefined) update.suspended_at = input.suspended_at;
  return update;
}

export async function updateDomainLifecycleReadiness(
  domainOrId: string,
  input: DomainReadinessMutationInput,
  options: ResolveDomainLifecycleOptions = {},
): Promise<DomainReadinessMutationResult> {
  const domain = resolveDomainLifecycleRecord(domainOrId, { provider_id: options.provider_id });
  const before = await buildDomainLifecycleSummary(domain, { mode: options.mode });
  const update = toReadinessUpdate(input);
  const timestamp = now();

  if (input.inbound_status === "ready") {
    if (!input.force && !before.readiness.receive_ready && !before.readiness.inbound_evidence_ready) {
      throw new Error(`Inbound self_hosted source is not configured for ${domain.domain}; register an SES/S3 source or pass force after manual/provider setup.`);
    }
    update.last_inbound_check_at ??= timestamp;
  }

  if (input.outbound_status === "ready") {
    const dnsReady = domain.dkim_status === "verified" && domain.spf_status === "verified";
    if (!input.force && !dnsReady) {
      throw new Error(`Outbound is not verified for ${domain.domain}; DKIM and SPF must be verified or pass force after manual/provider setup.`);
    }
    update.ownership_status ??= domain.verified_at || dnsReady ? "verified" : domain.ownership_status;
    update.monitoring_status ??= domain.dmarc_status === "verified" ? "monitoring" : domain.monitoring_status;
    update.last_outbound_check_at ??= timestamp;
  }

  if (input.outbound_status === "disabled") {
    update.restricted_at ??= timestamp;
  }

  const updated = Object.keys(update).length > 0
    ? updateDomainReadiness(domain.id, update)
    : domain;

  // AWAITED, not fired and forgotten. Un-awaited these are floating promises: the summary
  // below would be built before the write landed, so `after.provisioning` would report the
  // state the row had BEFORE the transition this function just performed, and a rejected
  // write would surface as an unhandled rejection rather than as a failed command.
  if (input.inbound_status === "ready") {
    await setDomainProvisioning(domain.id, {
      provisioning_status: "inbound_ready",
      last_error: null,
      next_check_at: null,
    });
  }

  if (input.outbound_status === "ready" && domain.dkim_status === "verified" && domain.spf_status === "verified") {
    await setDomainProvisioning(domain.id, {
      provisioning_status: "verified",
      last_error: null,
      next_check_at: null,
    });
  }

  return {
    before,
    updated,
    after: await buildDomainLifecycleSummary(updated, { mode: options.mode }),
  };
}

export function enableDomainInboundReadiness(
  domainOrId: string,
  options: ResolveDomainLifecycleOptions & { force?: boolean } = {},
): Promise<DomainReadinessMutationResult> {
  return updateDomainLifecycleReadiness(domainOrId, { inbound_status: "ready", force: options.force }, options);
}

export function enableDomainOutboundReadiness(
  domainOrId: string,
  options: ResolveDomainLifecycleOptions & { force?: boolean } = {},
): Promise<DomainReadinessMutationResult> {
  return updateDomainLifecycleReadiness(domainOrId, { outbound_status: "ready", force: options.force }, options);
}

export function disableDomainOutboundReadiness(
  domainOrId: string,
  options: ResolveDomainLifecycleOptions = {},
): Promise<DomainReadinessMutationResult> {
  return updateDomainLifecycleReadiness(domainOrId, { outbound_status: "disabled" }, options);
}

export function createDomainReadinessService(): DomainReadinessService {
  return {
    list: (options = {}) => listDomainLifecycleSummaries(options),
    get: (domainOrId, options = {}) => getDomainLifecycleSummary(domainOrId, options),
    update: (domainOrId, input, options = {}) => updateDomainLifecycleReadiness(domainOrId, input, options),
  };
}
