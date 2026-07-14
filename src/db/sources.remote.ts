import type {
  CreateMailboxSourceInput,
  MailboxSource,
  ProviderProvenanceSnapshot,
} from "../types/index.js";
import { now, uuid } from "./runtime.js";
import { getProvider } from "./providers.remote.js";
import { selfHostedResource, cobj, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const SOURCE_RESOURCE = "sources";

function apiToSource(e: Record<string, unknown>): MailboxSource {
  const updatedAt = ciso(e["updated_at"]);
  return {
    id: cstr(e["id"]),
    mailbox_id: cstr(e["mailbox_id"]),
    provider_id: cstrOrNull(e["provider_id"]),
    type: cstr(e["type"]) as MailboxSource["type"],
    name: cstr(e["name"]),
    external_account_id: cstrOrNull(e["external_account_id"]),
    external_mailbox: cstrOrNull(e["external_mailbox"]),
    status: cstr(e["status"]) as MailboxSource["status"],
    settings: cobj(e["settings"] ?? e["settings_json"]),
    provider_snapshot: cobj(e["provider_snapshot"] ?? e["provider_snapshot_json"]),
    last_synced_at: cstrOrNull(e["last_synced_at"]),
    created_at: ciso(e["created_at"], updatedAt),
    updated_at: updatedAt,
  };
}

function getProviderSnapshot(providerId: string): ProviderProvenanceSnapshot | Record<string, unknown> {
  const provider = getProvider(providerId);
  if (!provider) return {};
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    region: provider.region,
    active: provider.active,
    created_at: provider.created_at,
    updated_at: provider.updated_at,
  };
}

export function createMailboxSource(input: CreateMailboxSourceInput): MailboxSource {
  const id = uuid();
  const timestamp = now();
  const providerSnapshot = input.provider_snapshot ?? (input.provider_id ? getProviderSnapshot(input.provider_id) : {});
  const created = selfHostedResource(SOURCE_RESOURCE).create({
    id,
    mailbox_id: input.mailbox_id,
    provider_id: input.provider_id ?? null,
    type: input.type,
    name: input.name,
    external_account_id: input.external_account_id ?? null,
    external_mailbox: input.external_mailbox ?? null,
    status: input.status ?? "active",
    settings_json: JSON.stringify(input.settings ?? {}),
    provider_snapshot_json: JSON.stringify(providerSnapshot),
    last_synced_at: input.last_synced_at ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  });
  return apiToSource(created);
}

export function getMailboxSource(id: string): MailboxSource | null {
  const record = selfHostedResource(SOURCE_RESOURCE).get(id);
  return record ? apiToSource(record) : null;
}

export function listMailboxSources(mailboxId: string): MailboxSource[] {
  return selfHostedResource(SOURCE_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToSource)
    .filter((s) => s.mailbox_id === mailboxId)
    .sort((a, b) =>
      (a.status ?? "").localeCompare(b.status ?? "") ||
      (a.type ?? "").localeCompare(b.type ?? "") ||
      (a.created_at ?? "").localeCompare(b.created_at ?? ""),
    );
}
