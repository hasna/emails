import { listActiveProviders } from "../db/providers.js";
import { listDomainsByProviderIds } from "../db/domains.js";
import { listAddressesByProviderIds } from "../db/addresses.js";
import { getAdapter } from "../providers/index.js";
import type { Provider } from "../types/index.js";
import type { ProviderHealth } from "./provider-health-format.js";

export { formatProviderHealth } from "./provider-health-format.js";
export type { ProviderHealth } from "./provider-health-format.js";

export interface ProviderHealthOptions {
  validateCredentials?: boolean;
}

interface ProviderLocalHealthMetrics {
  domainCount: number;
  verifiedDomains: number;
  addressCount: number;
  verifiedAddresses: number;
  bounceRate: number;
}

function locallyConfigured(provider: Provider): { ok: boolean; message?: string } {
  switch (provider.type) {
    case "sandbox":
      return { ok: true };
    case "resend":
      return provider.api_key ? { ok: true } : { ok: false, message: "Missing Resend API key" };
    case "ses":
      return provider.region ? { ok: true } : { ok: false, message: "Missing AWS region" };
    default:
      return { ok: false, message: `Unknown provider type: ${(provider as { type?: unknown }).type}` };
  }
}

function emptyLocalHealthMetrics(): ProviderLocalHealthMetrics {
  return {
    domainCount: 0,
    verifiedDomains: 0,
    addressCount: 0,
    verifiedAddresses: 0,
    bounceRate: 0,
  };
}

async function checkCredentialState(provider: Provider, opts: ProviderHealthOptions): Promise<Pick<ProviderHealth, "credentialsValid" | "credentialsChecked" | "credentialError">> {
  const credentialsChecked = opts.validateCredentials !== false;
  if (credentialsChecked) {
    try {
      const adapter = getAdapter(provider);
      await adapter.listDomains();
      return { credentialsChecked, credentialsValid: true };
    } catch (e) {
      return {
        credentialsChecked,
        credentialsValid: false,
        credentialError: e instanceof Error ? e.message : String(e),
      };
    }
  }

  const local = locallyConfigured(provider);
  return {
    credentialsChecked,
    credentialsValid: local.ok,
    credentialError: local.message,
  };
}

function statusFrom(credentialsValid: boolean, bounceRate: number): ProviderHealth["status"] {
  if (!credentialsValid) return "error";
  if (bounceRate > 5) return "warning";
  return "healthy";
}

function buildProviderHealth(
  provider: Provider,
  credentials: Pick<ProviderHealth, "credentialsValid" | "credentialsChecked" | "credentialError">,
  metrics: ProviderLocalHealthMetrics,
): ProviderHealth {
  return {
    provider,
    ...credentials,
    ...metrics,
    status: statusFrom(credentials.credentialsValid, metrics.bounceRate),
  };
}

// Provider health metrics route to the `/v1`-backed domains + addresses repos.
// The per-provider bounce rate is derived from the local delivery `events`
// table, which has no `/v1` representation in the self-hosted client (delivery
// events live on the operator's server); it is therefore reported as 0 here.
function listProviderHealthMetrics(providers: Provider[]): Map<string, ProviderLocalHealthMetrics> {
  const ids = [...new Set(providers.map((provider) => provider.id).filter(Boolean))];
  const metrics = new Map(ids.map((id) => [id, emptyLocalHealthMetrics()]));
  if (ids.length === 0) return metrics;

  for (const domain of listDomainsByProviderIds(ids)) {
    const current = metrics.get(domain.provider_id);
    if (!current) continue;
    current.domainCount += 1;
    if (domain.dkim_status === "verified") current.verifiedDomains += 1;
  }

  for (const address of listAddressesByProviderIds(ids)) {
    const current = metrics.get(address.provider_id);
    if (!current) continue;
    current.addressCount += 1;
    if (address.verified) current.verifiedAddresses += 1;
  }

  return metrics;
}

export async function checkProviderHealth(provider: Provider, opts: ProviderHealthOptions = {}): Promise<ProviderHealth> {
  const credentials = await checkCredentialState(provider, opts);
  const metrics = listProviderHealthMetrics([provider]).get(provider.id) ?? emptyLocalHealthMetrics();

  return buildProviderHealth(provider, credentials, metrics);
}

export async function checkAllProviders(opts: ProviderHealthOptions = {}): Promise<ProviderHealth[]> {
  const providers = listActiveProviders();
  const metrics = listProviderHealthMetrics(providers);
  const credentials = await Promise.all(providers.map((provider) => checkCredentialState(provider, opts)));
  return providers.map((provider, index) => buildProviderHealth(
    provider,
    credentials[index] ?? { credentialsChecked: opts.validateCredentials !== false, credentialsValid: false },
    metrics.get(provider.id) ?? emptyLocalHealthMetrics(),
  ));
}
