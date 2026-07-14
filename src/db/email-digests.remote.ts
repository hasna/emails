import { now, uuid } from "./runtime.js";
import { cappedLimit, safeOffset } from "./pagination.js";
import { selfHostedResource, cnum, cobj, cstrArray, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const DIGEST_RESOURCE = "email-digests";

export type EmailDigestPeriod = "today" | "yesterday" | "last7" | "month";
export type EmailDigestStatus = "ok" | "error";
export type EmailDigestProvider = "local" | "external";

export interface EmailDigest {
  id: string;
  period: EmailDigestPeriod;
  since: string;
  until: string;
  provider: EmailDigestProvider;
  model: string;
  status: EmailDigestStatus;
  message_count: number;
  summary: string | null;
  highlights: string[];
  action_items: string[];
  important_email_ids: string[];
  label_counts: Record<string, number>;
  error: string | null;
  started_at: string;
  completed_at: string;
  created_at: string;
}

export interface SaveEmailDigestInput {
  period: EmailDigestPeriod;
  since: string;
  until: string;
  provider: EmailDigestProvider;
  model: string;
  status: EmailDigestStatus;
  message_count: number;
  summary?: string | null;
  highlights?: string[];
  action_items?: string[];
  important_email_ids?: string[];
  label_counts?: Record<string, number>;
  error?: string | null;
  started_at?: string;
  completed_at?: string;
}

export interface ListEmailDigestsOptions {
  period?: EmailDigestPeriod;
  status?: EmailDigestStatus;
  limit?: number;
  offset?: number;
}

const MAX_DIGEST_LIST_LIMIT = 200;
const PERIODS = new Set<EmailDigestPeriod>(["today", "yesterday", "last7", "month"]);
const STATUSES = new Set<EmailDigestStatus>(["ok", "error"]);

export function normalizeEmailDigestPeriod(value: string | undefined): EmailDigestPeriod {
  const normalized = (value ?? "today").trim().toLowerCase().replace(/[_\s-]+/g, "");
  const aliases: Record<string, EmailDigestPeriod> = {
    today: "today",
    yesterday: "yesterday",
    last7: "last7",
    lastseven: "last7",
    last7days: "last7",
    week: "last7",
    month: "month",
    thismonth: "month",
  };
  const period = aliases[normalized];
  if (!period || !PERIODS.has(period)) {
    throw new Error("Digest period must be today, yesterday, last7, or month.");
  }
  return period;
}

export function emailDigestPeriodLabel(period: EmailDigestPeriod): string {
  return {
    today: "Today",
    yesterday: "Yesterday",
    last7: "Last 7 Days",
    month: "This Month",
  }[period];
}

function normalizeStringArray(values: string[] | undefined, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of values ?? []) {
    const value = String(item ?? "").replace(/\s+/g, " ").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value.slice(0, 500));
    if (out.length >= max) break;
  }
  return out;
}

function normalizeLabelCounts(value: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    const label = key.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 64);
    const count = Number(raw);
    if (!label || !Number.isFinite(count) || count <= 0) continue;
    out[label] = Math.trunc(count);
  }
  return out;
}

function apiToDigest(e: Record<string, unknown>): EmailDigest {
  const period = cstr(e["period"]) as EmailDigestPeriod;
  if (!PERIODS.has(period)) throw new Error(`Invalid digest period in database: ${String(e["period"])}`);
  const status = cstr(e["status"]) as EmailDigestStatus;
  if (!STATUSES.has(status)) throw new Error(`Invalid digest status in database: ${String(e["status"])}`);
  return {
    id: cstr(e["id"]),
    period,
    since: cstr(e["since"]),
    until: cstr(e["until"]),
    provider: cstr(e["provider"]) as EmailDigestProvider,
    model: cstr(e["model"]),
    status,
    message_count: cnum(e["message_count"]),
    summary: cstrOrNull(e["summary"]) || null,
    highlights: cstrArray(e["highlights"] ?? e["highlights_json"]),
    action_items: cstrArray(e["action_items"] ?? e["action_items_json"]),
    important_email_ids: cstrArray(e["important_email_ids"] ?? e["important_email_ids_json"]),
    label_counts: cobj(e["label_counts"] ?? e["label_counts_json"]) as Record<string, number>,
    error: cstrOrNull(e["error"]) || null,
    started_at: cstr(e["started_at"]),
    completed_at: cstr(e["completed_at"]),
    created_at: ciso(e["created_at"]),
  };
}

export function saveEmailDigest(input: SaveEmailDigestInput): EmailDigest {
  const id = uuid();
  const startedAt = input.started_at ?? now();
  const completedAt = input.completed_at ?? now();
  const created = selfHostedResource(DIGEST_RESOURCE).create({
    id,
    period: input.period,
    since: input.since,
    until: input.until,
    provider: input.provider,
    model: input.model,
    status: input.status,
    message_count: Math.max(0, Math.trunc(input.message_count)),
    summary: input.summary ?? null,
    highlights_json: JSON.stringify(normalizeStringArray(input.highlights, 12)),
    action_items_json: JSON.stringify(normalizeStringArray(input.action_items, 12)),
    important_email_ids_json: JSON.stringify(normalizeStringArray(input.important_email_ids, 30)),
    label_counts_json: JSON.stringify(normalizeLabelCounts(input.label_counts)),
    error: input.error ?? null,
    started_at: startedAt,
    completed_at: completedAt,
    created_at: completedAt,
  });
  return apiToDigest(created);
}

export function getEmailDigest(id: string): EmailDigest | null {
  const record = selfHostedResource(DIGEST_RESOURCE).get(id);
  return record ? apiToDigest(record) : null;
}

export function getLatestEmailDigest(period: EmailDigestPeriod): EmailDigest | null {
  const match = selfHostedResource(DIGEST_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToDigest)
    .filter((d) => d.period === period && d.status === "ok")
    .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""))[0];
  return match ?? null;
}

export function listEmailDigests(opts: ListEmailDigestsOptions = {}): EmailDigest[] {
  let rows = selfHostedResource(DIGEST_RESOURCE).list({ limit: 1000 }).map(apiToDigest);
  if (opts.period) rows = rows.filter((d) => d.period === opts.period);
  if (opts.status) rows = rows.filter((d) => d.status === opts.status);
  rows.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
  const limit = cappedLimit(opts.limit, 20, MAX_DIGEST_LIST_LIMIT);
  const offset = safeOffset(opts.offset);
  return rows.slice(offset, offset + limit);
}
