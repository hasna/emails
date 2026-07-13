import { now, uuid } from "./runtime.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { selfHostedResource, cbool, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const FORWARDING_RESOURCE = "forwarding";

export type ForwardingMode = "app-copy";
export type ForwardingDeliveryStatus = "sent" | "failed";

export interface ForwardingRule {
  id: string;
  source_address: string;
  target_address: string;
  mode: ForwardingMode;
  provider_id: string | null;
  from_address: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ForwardingDelivery {
  id: string;
  rule_id: string;
  inbound_email_id: string;
  sent_email_id: string | null;
  status: ForwardingDeliveryStatus;
  error: string | null;
  created_at: string;
}

export interface PendingForwarding {
  rule: ForwardingRule;
  inbound_email_id: string;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`Invalid email address: ${value}`);
  }
  return email;
}

function apiToRule(e: Record<string, unknown>): ForwardingRule {
  const updatedAt = ciso(e["updated_at"]);
  return {
    id: cstr(e["id"]),
    source_address: cstr(e["source_address"]),
    target_address: cstr(e["target_address"]),
    mode: (cstr(e["mode"]) || "app-copy") as ForwardingMode,
    provider_id: cstrOrNull(e["provider_id"]),
    from_address: cstrOrNull(e["from_address"]),
    enabled: cbool(e["enabled"]),
    created_at: ciso(e["created_at"], updatedAt),
    updated_at: updatedAt,
  };
}

export function createForwardingRule(input: {
  source_address: string;
  target_address: string;
  mode?: ForwardingMode;
  provider_id?: string | null;
  from_address?: string | null;
  enabled?: boolean;
}): ForwardingRule {
  const store = selfHostedResource(FORWARDING_RESOURCE);
  const source = normalizeEmail(input.source_address);
  const target = normalizeEmail(input.target_address);
  const from = input.from_address ? normalizeEmail(input.from_address) : null;
  const mode = input.mode ?? "app-copy";
  const enabled = input.enabled !== false;
  const existing = store
    .list({ limit: 1000 })
    .map(apiToRule)
    .find((r) => r.source_address === source && r.target_address === target && r.mode === mode);
  if (existing) {
    return apiToRule(store.update(existing.id, {
      provider_id: input.provider_id ?? null,
      from_address: from,
      enabled,
      updated_at: now(),
    }));
  }
  const id = uuid();
  const ts = now();
  return apiToRule(store.create({
    id,
    source_address: source,
    target_address: target,
    mode,
    provider_id: input.provider_id ?? null,
    from_address: from,
    enabled,
    created_at: ts,
    updated_at: ts,
  }));
}

export function getForwardingRule(id: string): ForwardingRule | null {
  const record = selfHostedResource(FORWARDING_RESOURCE).get(id);
  return record ? apiToRule(record) : null;
}

export function listForwardingRules(opts?: {
  source_address?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}): ForwardingRule[] {
  let rows = selfHostedResource(FORWARDING_RESOURCE).list({ limit: 1000 }).map(apiToRule);
  if (opts?.source_address) {
    const source = normalizeEmail(opts.source_address);
    rows = rows.filter((r) => r.source_address === source);
  }
  if (opts?.enabled !== undefined) {
    rows = rows.filter((r) => r.enabled === opts.enabled);
  }
  rows.sort((a, b) => a.source_address.localeCompare(b.source_address) || a.target_address.localeCompare(b.target_address));
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  return limit === null ? rows : rows.slice(offset, offset + limit);
}

export function setForwardingRuleEnabled(id: string, enabled: boolean): ForwardingRule {
  const store = selfHostedResource(FORWARDING_RESOURCE);
  if (!store.get(id)) throw new Error(`Forwarding rule not found: ${id}`);
  return apiToRule(store.update(id, { enabled, updated_at: now() }));
}

export function removeForwardingRule(id: string): boolean {
  return selfHostedResource(FORWARDING_RESOURCE).del(id);
}

export function listPendingForwarding(_limit = 100, _opts: { backfill?: boolean } = {}): PendingForwarding[] {
  // Computing pending forwards joins the forwarding rules against inbound
  // emails/recipients and the delivery ledger — data the client does not own.
  // The self-hosted server runs the forwarding pipeline, so there is no /v1
  // equivalent to expose this to the client.
  throw new Error(
    "listPendingForwarding is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

export function recordForwardingDelivery(_input: {
  rule_id: string;
  inbound_email_id: string;
  sent_email_id?: string | null;
  status: ForwardingDeliveryStatus;
  error?: string | null;
}): ForwardingDelivery {
  // The forwarding delivery ledger (`forwarding_deliveries`) is written by the
  // server's forwarding pipeline; there is no client-side /v1 equivalent.
  throw new Error(
    "recordForwardingDelivery is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}
