import * as local from "./providers.local.js";
import * as remote from "./providers.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument, withExplicitDatabaseRoute } from "./database-routing.js";
import { PROVIDER_SECRET_FIELDS } from "./provider-secrets.js";
import type { Provider } from "../types/index.js";

export type * from "./providers.local.js";

const localCompat = {
  ...local,
  listProviders: (opts) => local.listProviders(undefined, opts),
  listProviderSummaries: (opts) => local.listProviderSummaries(undefined, opts),
  listActiveProviderSummaries: (type, opts) => local.listActiveProviderSummaries(type, undefined, opts),
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (hasDatabaseArgument(args) ? local : isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`providers.${String(key)} is unavailable in the selected mode.`);
    return withExplicitDatabaseRoute(args, () => (candidate as (...values: unknown[]) => unknown)(...args));
  }) as RoutedFunction<K>;
}

export const assertProviderCredentialsStorable = routed("assertProviderCredentialsStorable");
export const createProvider = routed("createProvider");
export const getProvider = routed("getProvider");
// Credentialed reads are NOT a second mode dispatch: they reuse the same routed
// `getProvider` and only ask it to unwrap the encrypted envelope. The self-hosted
// arm returns the server's credential-free record and ignores the flag, so the
// remote path is byte-identical to `getProvider`; the local SQLite arm attaches
// the encrypted secrets it owns. Threading the flag through the existing dispatch
// keeps the credential path off the deployment-mode table entirely.
export const getProviderWithCredentials: typeof local.getProviderWithCredentials = (id, db) =>
  getProvider(id, db, true);

// Overlay the durable encrypted credentials onto a caller-supplied provider at the
// execution boundary, WITHOUT replacing the caller's own identity, type, or config.
// A credential-free DTO thus gains only its secret fields, while a candidate whose
// id resolves to no stored row (validation objects, mismatched types) keeps exactly
// the shape it was handed — so the adapter that gets built is chosen by the caller's
// provider, not by whatever the id happens to point at.
export function applyDurableCredentials(provider: Provider): Provider {
  const durable = getProviderWithCredentials(provider.id);
  if (!durable) return provider;
  const merged: Provider = { ...provider };
  for (const field of PROVIDER_SECRET_FIELDS) merged[field] = durable[field];
  return merged;
}
export const resolveProviderId = routed("resolveProviderId");
export const getProviderByNameAndType = routed("getProviderByNameAndType");
export const listProviders = routed("listProviders");
export const listProviderSummaries = routed("listProviderSummaries");
export const listProviderNamesByIds = routed("listProviderNamesByIds");
export const listActiveProviders = routed("listActiveProviders");
export const listActiveProviderSummaries = routed("listActiveProviderSummaries");
export const getLatestActiveProvider = routed("getLatestActiveProvider");
export const getLatestActiveProviderId = routed("getLatestActiveProviderId");
export const updateProvider = routed("updateProvider");
export const deleteProvider = routed("deleteProvider");
export const getActiveProvider = routed("getActiveProvider");
