import { now, uuid } from "./runtime.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { selfHostedResource, cnum, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";
import type { WarmingSchedule } from "../lib/warming.js";

const WARMING_RESOURCE = "warming";

function apiToSchedule(e: Record<string, unknown>): WarmingSchedule {
  const updatedAt = ciso(e["updated_at"]);
  return {
    id: cstr(e["id"]),
    domain: cstr(e["domain"]),
    provider_id: cstrOrNull(e["provider_id"]),
    target_daily_volume: cnum(e["target_daily_volume"]),
    start_date: cstr(e["start_date"]),
    status: (cstr(e["status"]) || "active") as WarmingSchedule["status"],
    created_at: ciso(e["created_at"], updatedAt),
    updated_at: updatedAt,
  };
}

export function createWarmingSchedule(
  input: {
    domain: string;
    provider_id?: string;
    target_daily_volume: number;
    start_date?: string;
  },
): WarmingSchedule {
  const id = uuid();
  const timestamp = now();
  const startDate = input.start_date ?? new Date().toISOString().slice(0, 10);
  const created = selfHostedResource(WARMING_RESOURCE).create({
    id,
    domain: input.domain,
    provider_id: input.provider_id ?? null,
    target_daily_volume: input.target_daily_volume,
    start_date: startDate,
    status: "active",
    created_at: timestamp,
    updated_at: timestamp,
  });
  return apiToSchedule(created);
}

export function getWarmingSchedule(domain: string): WarmingSchedule | null {
  const match = selfHostedResource(WARMING_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToSchedule)
    .find((s) => s.domain === domain);
  return match ?? null;
}

export interface ListWarmingScheduleOptions {
  limit?: number;
  offset?: number;
}

export function listWarmingSchedules(status?: string, opts?: ListWarmingScheduleOptions): WarmingSchedule[] {
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  let rows = selfHostedResource(WARMING_RESOURCE).list({ limit: 1000 }).map(apiToSchedule);
  if (status) rows = rows.filter((s) => s.status === status);
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return limit === null ? rows : rows.slice(offset, offset + limit);
}

export function updateWarmingStatus(
  domain: string,
  status: "active" | "paused" | "completed",
): WarmingSchedule | null {
  const store = selfHostedResource(WARMING_RESOURCE);
  const existing = store.list({ limit: 1000 }).map(apiToSchedule).find((s) => s.domain === domain);
  if (!existing) return null;
  return apiToSchedule(store.update(existing.id, { status, updated_at: now() }));
}

export function deleteWarmingSchedule(domain: string): boolean {
  const store = selfHostedResource(WARMING_RESOURCE);
  const existing = store.list({ limit: 1000 }).map(apiToSchedule).find((s) => s.domain === domain);
  if (!existing) return false;
  return store.del(existing.id);
}
