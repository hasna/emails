import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listAddresses } from "../db/addresses.js";
import { listDomains } from "../db/domains.js";
import { listDomainProvisioningByIds, listReadyAddressCountsByDomains } from "../db/provisioning.js";
import { assessDomainReadiness } from "../lib/domain-readiness.js";
import { domainInboundReadinessSignals } from "../lib/domain-inbound-evidence.js";
import { resolveEmailsMode } from "../lib/mode.js";
import { resolveMailDataSource } from "../lib/mail-data-source.js";
import { fetchIdentitySafe } from "../lib/whoami.js";
import { statusUnavailable } from "../lib/status-availability.js";

const RECENT_ERROR_LIMIT_PER_COMPONENT = 50;
const DOMAIN_RESOURCE_LIMIT = 50;
const ADDRESS_RESOURCE_LIMIT = 100;
const AGENT_CONTEXT_SAMPLE_LIMIT = 5;

function jsonResource(uri: string, value: unknown) {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(value, null, 2),
    }],
  };
}

function selfHostedApiStatus(error?: unknown): Record<string, unknown> {
  return {
    available: error === undefined,
    error: error instanceof Error ? error.message : (error === undefined ? null : String(error)),
  };
}

// Self-hosted-ONLY resource payloads. Every read routes to the operator's `/v1`
// API through the resource repositories and mail data-source seam; there is no
// local SQLite island to fall back to.

export async function domainsResourcePayloadForRuntime(): Promise<Record<string, unknown>> {
  try {
    const mode = resolveEmailsMode();
    const domainRows = listDomains(undefined, { limit: DOMAIN_RESOURCE_LIMIT + 1, offset: 0 });
    const truncated = domainRows.length > DOMAIN_RESOURCE_LIMIT;
    const sample = domainRows.slice(0, DOMAIN_RESOURCE_LIMIT);
    // Real provisioning state and real ready-address counts: both are columns on
    // the /v1 domain and address entities. Passing `null` provisioning and a
    // hardcoded `ready_addresses: 0` here produced a fabricated readiness VERDICT
    // that this resource then published to agents.
    const sampleIds = sample.map((domain) => domain.id);
    const provisioningById = await listDomainProvisioningByIds(sampleIds);
    const readyAddressesById = await listReadyAddressCountsByDomains(sampleIds);
    const domains = sample.map((domain) => {
      const provisioning = provisioningById.get(domain.id) ?? null;
      return {
        ...domain,
        provisioning,
        readiness: assessDomainReadiness(domain, provisioning, {
          ...domainInboundReadinessSignals(domain, mode),
          ready_addresses: readyAddressesById.get(domain.id) ?? 0,
        }),
      };
    });
    return {
      domains,
      total: null,
      total_source: "unavailable_without_api_count",
      limit: DOMAIN_RESOURCE_LIMIT,
      truncated,
      mode: "self_hosted",
      source: "self_hosted_api",
      api: selfHostedApiStatus(),
      cli_equivalent: `emails domain list --limit ${DOMAIN_RESOURCE_LIMIT} --json`,
    };
  } catch (error) {
    // A read failure reports NOTHING, not an empty inventory with total 0: the
    // success path above already publishes `total: null` when it cannot count, so
    // the error path must not be the more confident of the two.
    const availability = statusUnavailable(
      "source_unreachable",
      error instanceof Error ? error.message : String(error),
      "self_hosted_api:/v1/domains",
      "no local database or config state was read",
    );
    return {
      domains: null,
      total: null,
      total_source: "unavailable_source_unreachable",
      availability,
      limit: DOMAIN_RESOURCE_LIMIT,
      truncated: null,
      mode: "self_hosted",
      source: "self_hosted_api",
      api: selfHostedApiStatus(error),
      cli_equivalent: `emails domain list --limit ${DOMAIN_RESOURCE_LIMIT} --json`,
    };
  }
}

export async function addressesResourcePayloadForRuntime(): Promise<Record<string, unknown>> {
  try {
    const addressRows = listAddresses(undefined, { limit: ADDRESS_RESOURCE_LIMIT + 1, offset: 0 });
    const truncated = addressRows.length > ADDRESS_RESOURCE_LIMIT;
    const addresses = addressRows.slice(0, ADDRESS_RESOURCE_LIMIT).map((address) => ({
      ...address,
      provider_name: null,
      owner: null,
      administrator: null,
      provisioning: null,
    }));
    return {
      addresses,
      total: null,
      total_source: "unavailable_without_api_count",
      limit: ADDRESS_RESOURCE_LIMIT,
      truncated,
      mode: "self_hosted",
      source: "self_hosted_api",
      api: selfHostedApiStatus(),
      cli_equivalent: `emails address list --limit ${ADDRESS_RESOURCE_LIMIT} --json`,
    };
  } catch (error) {
    const availability = statusUnavailable(
      "source_unreachable",
      error instanceof Error ? error.message : String(error),
      "self_hosted_api:/v1/addresses",
      "no local database or config state was read",
    );
    return {
      addresses: null,
      total: null,
      total_source: "unavailable_source_unreachable",
      availability,
      limit: ADDRESS_RESOURCE_LIMIT,
      truncated: null,
      mode: "self_hosted",
      source: "self_hosted_api",
      api: selfHostedApiStatus(error),
      cli_equivalent: `emails address list --limit ${ADDRESS_RESOURCE_LIMIT} --json`,
    };
  }
}

export async function agentContextResourcePayload(): Promise<Record<string, unknown>> {
  const { getAgentContextForRuntime, sampleAgentContext } = await import("../lib/agent-context.js");
  const context = await getAgentContextForRuntime();
  const sample = sampleAgentContext(context, AGENT_CONTEXT_SAMPLE_LIMIT);
  // Identity/tenant context derived from the caller's credential (never a
  // client-supplied tenant). Best-effort: null if /v1/me is unreachable.
  const identity = fetchIdentitySafe();
  return {
    identity: identity
      ? {
          principal_type: identity.principalType,
          user: identity.user,
          tenant: identity.tenant,
          role: identity.role,
          scopes: identity.scopes,
          memberships: identity.memberships,
        }
      : null,
    status: sample.status,
    workflows: context["workflows"],
    refresh_cadence: context["refresh_cadence"],
    limits: sample.limits,
    truncated: sample.truncated,
    full_context_resource: "emails://agent/context/full",
    full_context_cli: "emails agent context --json",
  };
}

export async function mailboxesResourcePayloadForRuntime(): Promise<Record<string, unknown>> {
  const ds = resolveMailDataSource();
  return {
    ...(await ds.listMailboxStatus()),
    cli_equivalent: "emails inbox mailboxes --json",
  };
}

export async function sourcesResourcePayloadForRuntime(): Promise<Record<string, unknown>> {
  const ds = resolveMailDataSource();
  return {
    sources: await ds.listMailboxSources({ limit: 100 }),
    cli_equivalent: "emails inbox sources --json",
  };
}

export function recentErrorsResourcePayloadForRuntime(): Record<string, unknown> {
  return {
    errors: [],
    truncated: false,
    limits: {
      per_component: RECENT_ERROR_LIMIT_PER_COMPONENT,
    },
    truncated_components: {
      domain_provisioning: false,
      address_provisioning: false,
    },
    mode: "self_hosted",
    source: "self_hosted_api",
    api: {
      available: false,
      error: null,
    },
    note: "No self-hosted API endpoint currently exposes provisioning/realtime error history; no local database or config state was read.",
    cli_equivalent: "emails status --json",
  };
}

export function registerEmailResources(server: McpServer): void {
  server.registerResource(
    "emails-agent-context",
    "emails://agent/context",
    {
      title: "Emails Agent Context",
      description: "Redacted system snapshot and recommended CLI workflows for coding agents.",
      mimeType: "application/json",
    },
    async () => {
      return jsonResource("emails://agent/context", await agentContextResourcePayload());
    },
  );

  server.registerResource(
    "emails-agent-context-full",
    "emails://agent/context/full",
    {
      title: "Emails Agent Context Full",
      description: "Full redacted system snapshot and recommended workflows for coding agents.",
      mimeType: "application/json",
    },
    async () => {
      const { getAgentContextForRuntime } = await import("../lib/agent-context.js");
      return jsonResource("emails://agent/context/full", await getAgentContextForRuntime());
    },
  );

  server.registerResource(
    "emails-status",
    "emails://status",
    {
      title: "Emails Status",
      description: "Redacted email system status, source health, and next actions.",
      mimeType: "application/json",
    },
    async () => {
      const { getEmailSystemStatusForRuntime } = await import("../lib/agent-context.js");
      return jsonResource("emails://status", await getEmailSystemStatusForRuntime());
    },
  );

  server.registerResource(
    "emails-inbox-sync-status",
    "emails://inbox/sync-status",
    {
      title: "Emails Inbox Sync Status",
      description: "Inbox source status for S3 ingestion, realtime queue, and local mailbox sources.",
      mimeType: "application/json",
    },
    async () => {
      const { getEmailSystemStatusForRuntime, statusGapSignals } = await import("../lib/agent-context.js");
      const status = await getEmailSystemStatusForRuntime();
      // Carry the gap signals into the SUBSET too: a consumer that only reads
      // emails://inbox/sync-status must still be able to tell an unmeasured field
      // from a measured zero.
      return jsonResource("emails://inbox/sync-status", {
        ...statusGapSignals(status),
        inbox: status.inbox,
        mailboxes: status.mailboxes,
        sources: status.sources,
        cli_equivalents: status.cli_equivalents,
      });
    },
  );

  server.registerResource(
    "emails-mailboxes",
    "emails://mailboxes",
    {
      title: "Emails Mailboxes",
      description: "Folder counts for the active mailbox source of truth.",
      mimeType: "application/json",
    },
    async () => {
      return jsonResource("emails://mailboxes", await mailboxesResourcePayloadForRuntime());
    },
  );

  server.registerResource(
    "emails-sources",
    "emails://sources",
    {
      title: "Emails Sources",
      description: "Ingestion streams with source-aware counts and legacy/orphaned badges.",
      mimeType: "application/json",
    },
    async () => {
      return jsonResource("emails://sources", await sourcesResourcePayloadForRuntime());
    },
  );

  server.registerResource(
    "emails-domains",
    "emails://domains",
    {
      title: "Emails Domains",
      description: "Configured domains with provisioning and send/receive readiness.",
      mimeType: "application/json",
    },
    async () => {
      return jsonResource("emails://domains", await domainsResourcePayloadForRuntime());
    },
  );

  server.registerResource(
    "emails-addresses",
    "emails://addresses",
    {
      title: "Emails Addresses",
      description: "Configured addresses with owner/admin/provider/provisioning context.",
      mimeType: "application/json",
    },
    async () => {
      return jsonResource("emails://addresses", await addressesResourcePayloadForRuntime());
    },
  );

  server.registerResource(
    "emails-recent-errors",
    "emails://recent-errors",
    {
      title: "Emails Recent Errors",
      description: "Recent sync, realtime, provisioning, and readiness errors.",
      mimeType: "application/json",
    },
    async () => {
      return jsonResource("emails://recent-errors", recentErrorsResourcePayloadForRuntime());
    },
  );
}
