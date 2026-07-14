import type { CreateProviderInput, Provider, ProviderSummary, ProviderType } from "../types/index.js";
import { ProviderNotFoundError } from "../types/index.js";
import { selfHostedResource, selfHostedListQuery, selfHostedPage, cbool, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const PROVIDER_RESOURCE = "providers";
const SUPPORTED_PROVIDER_TYPES = ["resend", "ses", "sandbox"] as const;

function isSupportedProviderType(value: string): value is ProviderType {
  return (SUPPORTED_PROVIDER_TYPES as readonly string[]).includes(value);
}

function assertSupportedProviderType(value: string): asserts value is ProviderType {
  if (!isSupportedProviderType(value)) {
    throw new Error("Provider type must be 'resend', 'ses', or 'sandbox'");
  }
}

// The self-hosted `providers` resource carries only NON-SECRET metadata (id,
// name, type, region, active, timestamps) — provider credentials (api_key/
// secret_key/oauth tokens) are never distributed to or fetched by a client.
// Secret columns map to null; the client uses server-side send (`/v1/send`), not
// local provider secrets.
function apiToProviderSummary(e: Record<string, unknown>): ProviderSummary {
  const updatedAt = ciso(e["updated_at"]);
  const type = cstr(e["type"]);
  assertSupportedProviderType(type);
  return {
    id: cstr(e["id"]),
    name: cstr(e["name"]),
    type,
    region: cstrOrNull(e["region"]),
    active: cbool(e["active"]),
    created_at: ciso(e["created_at"], updatedAt),
    updated_at: updatedAt,
  };
}

function apiToProvider(e: Record<string, unknown>): Provider {
  return {
    ...apiToProviderSummary(e),
    api_key: null,
    access_key: null,
    secret_key: null,
    oauth_client_id: null,
    oauth_client_secret: null,
    oauth_refresh_token: null,
    oauth_access_token: null,
    oauth_token_expiry: null,
  };
}

/** Bounded superset of providers restricted to supported types, mapped to Provider. */
function listSupportedProviders(): Provider[] {
  return selfHostedResource(PROVIDER_RESOURCE)
    .list({ limit: 1000 })
    .filter((row) => isSupportedProviderType(cstr(row["type"])))
    .map(apiToProvider);
}

export function createProvider(input: CreateProviderInput): Provider {
  assertSupportedProviderType(input.type);
  return apiToProvider(selfHostedResource(PROVIDER_RESOURCE).create({
    name: input.name,
    type: input.type,
    region: input.region || null,
    active: true,
  }));
}

export function getProvider(id: string): Provider | null {
  const record = selfHostedResource(PROVIDER_RESOURCE).get(id);
  return record ? apiToProvider(record) : null;
}

export function resolveProviderId(id: string): string | null {
  const trimmed = id.trim();
  if (!trimmed) return null;
  const store = selfHostedResource(PROVIDER_RESOURCE);
  if (trimmed.length >= 36) return store.get(trimmed) ? trimmed : null;
  const matches = store.list({ limit: 1000 })
    .map((row) => cstr(row["id"]))
    .filter((providerId) => providerId.startsWith(trimmed));
  return matches.length === 1 ? matches[0]! : null;
}

export function getProviderByNameAndType(name: string, type: ProviderType): Provider | null {
  return listSupportedProviders().find((p) => p.name === name && p.type === type) ?? null;
}

export interface ListProviderOptions {
  limit?: number;
  offset?: number;
}

export function listProviders(opts?: ListProviderOptions): Provider[] {
  const { query, limit, offset } = selfHostedListQuery(opts);
  const rows = selfHostedResource(PROVIDER_RESOURCE).list(query)
    .filter((row) => isSupportedProviderType(cstr(row["type"])))
    .map(apiToProvider);
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return selfHostedPage(rows, limit, offset);
}

export function listProviderSummaries(opts?: ListProviderOptions): ProviderSummary[] {
  const { query, limit, offset } = selfHostedListQuery(opts);
  const rows = selfHostedResource(PROVIDER_RESOURCE).list(query)
    .filter((row) => isSupportedProviderType(cstr(row["type"])))
    .map(apiToProviderSummary);
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return selfHostedPage(rows, limit, offset);
}

export function listProviderNamesByIds(providerIds: Iterable<string>): Map<string, string> {
  const ids = new Set([...providerIds].map((id) => id.trim()).filter(Boolean));
  if (ids.size === 0) return new Map();
  const map = new Map<string, string>();
  for (const row of selfHostedResource(PROVIDER_RESOURCE).list({ limit: 1000 })) {
    const id = cstr(row["id"]);
    if (ids.has(id)) map.set(id, cstr(row["name"]));
  }
  return map;
}

export function listActiveProviders(type?: ProviderType): Provider[] {
  return listSupportedProviders()
    .filter((p) => p.active && (type ? p.type === type : true))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

export function listActiveProviderSummaries(type?: ProviderType, opts?: ListProviderOptions): ProviderSummary[] {
  const { limit: pageLimit, offset: pageOffset } = selfHostedListQuery({ limit: opts?.limit, offset: opts?.offset });
  // listActiveProviders already returns fully-mapped Provider objects (a superset
  // of ProviderSummary); do not re-map raw rows.
  const rows: ProviderSummary[] = listActiveProviders(type);
  return selfHostedPage(rows, pageLimit, pageOffset);
}

export function getLatestActiveProvider(type?: ProviderType): Provider | null {
  return listActiveProviders(type)[0] ?? null;
}

export function getLatestActiveProviderId(type?: ProviderType): string | null {
  return getLatestActiveProvider(type)?.id ?? null;
}

export function updateProvider(
  id: string,
  input: Partial<CreateProviderInput> & { active?: boolean },
): Provider {
  const store = selfHostedResource(PROVIDER_RESOURCE);
  if (!store.get(id)) throw new ProviderNotFoundError(id);
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch["name"] = input.name;
  if (input.type !== undefined) {
    assertSupportedProviderType(input.type);
    patch["type"] = input.type;
  }
  if (input.region !== undefined) patch["region"] = input.region || null;
  if (input.active !== undefined) patch["active"] = input.active;
  return apiToProvider(store.update(id, patch));
}

export function deleteProvider(id: string): boolean {
  return selfHostedResource(PROVIDER_RESOURCE).del(id);
}

export function getActiveProvider(): Provider {
  const active = listSupportedProviders()
    .filter((p) => p.active)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  const provider = active[0];
  if (!provider) throw new ProviderNotFoundError("(no active provider)");
  return provider;
}
