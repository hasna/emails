import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listAddresses } from "../db/addresses.js";
import { listDomains } from "../db/domains.js";
import { assessDomainReadiness } from "../lib/domain-readiness.js";
import { domainInboundReadinessSignals } from "../lib/domain-inbound-evidence.js";
import { resolveEmailsMode } from "../lib/mode.js";
import { resolveMailDataSource } from "../lib/mail-data-source.js";

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

export function domainsResourcePayloadForRuntime(): Record<string, unknown> {
  try {
    const mode = resolveEmailsMode();
    const domainRows = listDomains(undefined, { limit: DOMAIN_RESOURCE_LIMIT + 1, offset: 0 });
    const truncated = domainRows.length > DOMAIN_RESOURCE_LIMIT;
    const domains = domainRows.slice(0, DOMAIN_RESOURCE_LIMIT).map((domain) => ({
      ...domain,
      provisioning: null,
      readiness: assessDomainReadiness(domain, null, {
        ...domainInboundReadinessSignals(domain, mode),
        ready_addresses: 0,
      }),
    }));
    return {
      domains,
      total: null,
      total_source: "unavailable_without_api_count",
      limit: DOMAIN_RESOURCE_LIMIT,
      truncated,
      mode: "self_hosted",
      source: "self_hosted_api",
      api: selfHostedApiStatus(),
      cli_equivalent: `emails domain status --limit ${DOMAIN_RESOURCE_LIMIT} --json`,
    };
  } catch (error) {
    return {
      domains: [],
      total: 0,
      limit: DOMAIN_RESOURCE_LIMIT,
      truncated: false,
      mode: "self_hosted",
      source: "self_hosted_api",
      api: selfHostedApiStatus(error),
      note: "Self-hosted API domain resource data is unavailable; no local database or config state was read.",
      cli_equivalent: `emails domain status --limit ${DOMAIN_RESOURCE_LIMIT} --json`,
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
    return {
      addresses: [],
      total: 0,
      limit: ADDRESS_RESOURCE_LIMIT,
      truncated: false,
      mode: "self_hosted",
      source: "self_hosted_api",
      api: selfHostedApiStatus(error),
      note: "Self-hosted API address resource data is unavailable; no local database or config state was read.",
      cli_equivalent: `emails address list --limit ${ADDRESS_RESOURCE_LIMIT} --json`,
    };
  }
}

export async function agentContextResourcePayload(): Promise<Record<string, unknown>> {
  const { getAgentContextForRuntime } = await import("../lib/agent-context.js");
  const context = await getAgentContextForRuntime();
  const status = context["status"] as Record<string, unknown>;
  const domains = status["domains"] as { usable?: unknown[]; usable_limit?: number; usable_truncated?: boolean } | undefined;
  const addresses = status["addresses"] as { usable_from?: Array<Record<string, unknown>>; usable_from_limit?: number; usable_from_truncated?: boolean } | undefined;
  const allUsableDomains = Array.isArray(domains?.usable) ? domains.usable : [];
  const allUsableFrom = Array.isArray(addresses?.usable_from) ? addresses.usable_from : [];
  const usableDomains = allUsableDomains.slice(0, AGENT_CONTEXT_SAMPLE_LIMIT);
  const usableFrom = allUsableFrom
    .slice(0, AGENT_CONTEXT_SAMPLE_LIMIT)
    .map((address) => ({
        id: address["id"],
        email: address["email"],
        provider_id: address["provider_id"],
        provider_name: address["provider_name"],
        owner: address["owner"],
        administrator: address["administrator"],
        status: address["status"],
        verified: address["verified"],
      }));
  return {
    status: {
      generated_at: status["generated_at"],
      database: status["database"],
      providers: status["providers"],
      domains: {
        ...(domains ?? {}),
        usable: usableDomains,
      },
      addresses: {
        ...(addresses ?? {}),
        usable_from: usableFrom,
      },
      inbox: status["inbox"],
      mailboxes: status["mailboxes"],
      sources: status["sources"],
      provisioning: status["provisioning"],
      next_actions: status["next_actions"],
      cli_equivalents: status["cli_equivalents"],
    },
    workflows: context["workflows"],
    refresh_cadence: context["refresh_cadence"],
    limits: {
      samples: AGENT_CONTEXT_SAMPLE_LIMIT,
      domain_full_limit: domains?.usable_limit ?? null,
      address_full_limit: addresses?.usable_from_limit ?? null,
    },
    truncated: {
      domains: Boolean(domains?.usable_truncated) || allUsableDomains.length > AGENT_CONTEXT_SAMPLE_LIMIT,
      addresses: Boolean(addresses?.usable_from_truncated) || allUsableFrom.length > AGENT_CONTEXT_SAMPLE_LIMIT,
    },
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
      const { getEmailSystemStatusForRuntime } = await import("../lib/agent-context.js");
      const status = await getEmailSystemStatusForRuntime();
      return jsonResource("emails://inbox/sync-status", {
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
      return jsonResource("emails://domains", domainsResourcePayloadForRuntime());
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
