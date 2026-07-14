import { now, uuid } from "./runtime.js";
import { safeOptionalLimit } from "./pagination.js";
import { selfHostedResource, selfHostedListQuery, selfHostedPage, carray, cobj, cstrArray, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const SCHEDULED_RESOURCE = "scheduled";

export type ScheduledStatus = "pending" | "sent" | "cancelled" | "failed";

export interface ScheduledEmail {
  id: string;
  provider_id: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  reply_to: string | null;
  subject: string;
  html: string | null;
  text_body: string | null;
  attachments_json: unknown[];
  template_name: string | null;
  template_vars: Record<string, string> | null;
  scheduled_at: string;
  status: ScheduledStatus;
  error: string | null;
  created_at: string;
}

export type ScheduledEmailSummary = Omit<ScheduledEmail, "html" | "text_body" | "attachments_json" | "template_vars">;

function apiToScheduledEmail(e: Record<string, unknown>): ScheduledEmail {
  return {
    id: cstr(e["id"]),
    provider_id: cstr(e["provider_id"]),
    from_address: cstr(e["from_address"]),
    to_addresses: cstrArray(e["to_addresses"]),
    cc_addresses: cstrArray(e["cc_addresses"]),
    bcc_addresses: cstrArray(e["bcc_addresses"]),
    reply_to: cstrOrNull(e["reply_to"]),
    subject: cstr(e["subject"]),
    html: cstrOrNull(e["html"]),
    text_body: cstrOrNull(e["text_body"]),
    attachments_json: carray(e["attachments_json"]),
    template_name: cstrOrNull(e["template_name"]),
    template_vars: e["template_vars"] == null ? null : (cobj(e["template_vars"]) as Record<string, string>),
    scheduled_at: cstr(e["scheduled_at"]),
    status: (cstr(e["status"]) || "pending") as ScheduledStatus,
    error: cstrOrNull(e["error"]),
    created_at: ciso(e["created_at"]),
  };
}

function scheduledToSummary(s: ScheduledEmail): ScheduledEmailSummary {
  const { html: _h, text_body: _t, attachments_json: _a, template_vars: _v, ...summary } = s;
  return summary;
}

export function createScheduledEmail(
  input: {
    provider_id: string;
    from_address: string;
    to_addresses: string[];
    cc_addresses?: string[];
    bcc_addresses?: string[];
    reply_to?: string;
    subject: string;
    html?: string;
    text_body?: string;
    attachments_json?: unknown[];
    template_name?: string;
    template_vars?: Record<string, string>;
    scheduled_at: string;
  },
): ScheduledEmail {
  const id = uuid();
  const timestamp = now();
  const created = selfHostedResource(SCHEDULED_RESOURCE).create({
    id,
    provider_id: input.provider_id,
    from_address: input.from_address,
    to_addresses: input.to_addresses,
    cc_addresses: input.cc_addresses || [],
    bcc_addresses: input.bcc_addresses || [],
    reply_to: input.reply_to || null,
    subject: input.subject,
    html: input.html || null,
    text_body: input.text_body || null,
    attachments_json: input.attachments_json || [],
    template_name: input.template_name || null,
    template_vars: input.template_vars ?? null,
    scheduled_at: input.scheduled_at,
    status: "pending",
    created_at: timestamp,
  });
  return apiToScheduledEmail(created);
}

export function getScheduledEmail(id: string): ScheduledEmail | null {
  const record = selfHostedResource(SCHEDULED_RESOURCE).get(id);
  return record ? apiToScheduledEmail(record) : null;
}

export interface ListScheduledEmailOptions {
  status?: ScheduledStatus;
  limit?: number;
  offset?: number;
}

export interface ListDueEmailOptions {
  limit?: number;
}

export function listScheduledEmails(opts?: ListScheduledEmailOptions): ScheduledEmail[] {
  const { query, limit, offset } = selfHostedListQuery(opts);
  if (opts?.status) query["status"] = opts.status;
  let rows = selfHostedResource(SCHEDULED_RESOURCE).list(query).map(apiToScheduledEmail);
  if (opts?.status) rows = rows.filter((s) => s.status === opts.status);
  rows.sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""));
  return selfHostedPage(rows, limit, offset);
}

export function listScheduledEmailSummaries(opts?: ListScheduledEmailOptions): ScheduledEmailSummary[] {
  const { query, limit, offset } = selfHostedListQuery(opts);
  if (opts?.status) query["status"] = opts.status;
  let rows = selfHostedResource(SCHEDULED_RESOURCE).list(query).map(apiToScheduledEmail).map(scheduledToSummary);
  if (opts?.status) rows = rows.filter((s) => s.status === opts.status);
  rows.sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""));
  return selfHostedPage(rows, limit, offset);
}

export function cancelScheduledEmail(id: string): boolean {
  const store = selfHostedResource(SCHEDULED_RESOURCE);
  const record = store.get(id);
  if (!record || cstr(record["status"]) !== "pending") return false;
  store.update(id, { status: "cancelled" });
  return true;
}

export function getDueEmails(opts?: ListDueEmailOptions): ScheduledEmail[] {
  const currentTime = now();
  const limit = safeOptionalLimit(opts?.limit);
  const rows = selfHostedResource(SCHEDULED_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToScheduledEmail)
    .filter((s) => s.status === "pending" && s.scheduled_at <= currentTime)
    .sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "") || a.id.localeCompare(b.id));
  return limit === null ? rows : rows.slice(0, limit);
}

export function markSent(id: string): void {
  selfHostedResource(SCHEDULED_RESOURCE).update(id, { status: "sent" });
}

export function markFailed(id: string, error: string): void {
  selfHostedResource(SCHEDULED_RESOURCE).update(id, { status: "failed", error });
}
