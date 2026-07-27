import { now, uuid } from "./runtime.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { selfHostedResource, carray, cobj, cstrArray, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";
import { assertHonestSelfHostedRead, enumerateSelfHostedRows } from "./self-hosted-page.js";

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

/**
 * Read the schedule through the PAGER, not through a single clamped request.
 *
 * `selfHostedListQuery` asks for `max(1000, limit + offset)` in one shot and sends
 * no server-side offset; `GET /v1/scheduled` is a generic resource and clamps every
 * list to 500 rows. Against the real service with 600 pending rows that returned
 * 500 for `--limit 600` and an EMPTY list for `--offset 500`, both with exit 0 —
 * a silently truncated page and a phantom "nothing scheduled". The pager reaches
 * the window's far edge instead, and assertHonestSelfHostedRead refuses rather
 * than hand back a page it cannot vouch for.
 *
 * `status` is a DECLARED server filter (src/server/self-hosted/resources.ts), so it
 * is pushed down as a bound on how much is read; it is re-checked in the client so
 * the answer is identical against a server that ignores unknown query params.
 */
function listFilteredScheduled(opts?: ListScheduledEmailOptions): ScheduledEmail[] {
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const need = limit === null ? null : limit + offset;
  const query: Record<string, string | number | boolean | undefined> = {};
  if (opts?.status) query["status"] = opts.status;
  const enumeration = enumerateSelfHostedRows<ScheduledEmail>(SCHEDULED_RESOURCE, {
    query,
    ...(need === null ? {} : { need }),
    // Map and filter in ONE pass so a dropped row never counts toward the window.
    select: (row) => {
      const scheduled = apiToScheduledEmail(row);
      return opts?.status && scheduled.status !== opts.status ? null : scheduled;
    },
  });
  assertHonestSelfHostedRead(enumeration, need, {
    noun: "scheduled email",
    narrowHint: "ask for a bounded page (a limit is windowed by GET /v1/scheduled) or narrow the read with --status.",
  });

  const rows = enumeration.rows;
  // Order the rows this read actually holds. Against `/v1/scheduled` this is a
  // no-op (the server already returns `scheduled_at ASC`); it is what makes the
  // ORDER of a complete, unbounded read independent of the server.
  rows.sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""));
  return limit === null ? rows : rows.slice(offset, offset + limit);
}

export function listScheduledEmails(opts?: ListScheduledEmailOptions): ScheduledEmail[] {
  return listFilteredScheduled(opts);
}

export function listScheduledEmailSummaries(opts?: ListScheduledEmailOptions): ScheduledEmailSummary[] {
  return listFilteredScheduled(opts).map(scheduledToSummary);
}

export function cancelScheduledEmail(id: string): boolean {
  const store = selfHostedResource(SCHEDULED_RESOURCE);
  const record = store.get(id);
  if (!record || cstr(record["status"]) !== "pending") return false;
  store.update(id, { status: "cancelled" });
  return true;
}

/**
 * Due rows, read through the pager for the same reason as the list above: a single
 * `list({ limit: 1000 })` is clamped to 500 server-side, so a scheduler tick over a
 * larger schedule would silently skip everything past that row — the due rows it
 * never saw would simply never be sent.
 *
 * `scheduled_at <= now` is not a server filter, so the window is filled by a
 * client-side `select`; `status` is, and is pushed down.
 */
export function getDueEmails(opts?: ListDueEmailOptions): ScheduledEmail[] {
  const currentTime = now();
  const limit = safeOptionalLimit(opts?.limit);
  const enumeration = enumerateSelfHostedRows<ScheduledEmail>(SCHEDULED_RESOURCE, {
    query: { status: "pending" },
    ...(limit === null ? {} : { need: limit }),
    select: (row) => {
      const scheduled = apiToScheduledEmail(row);
      return scheduled.status === "pending" && scheduled.scheduled_at <= currentTime ? scheduled : null;
    },
  });
  assertHonestSelfHostedRead(enumeration, limit, {
    noun: "due scheduled email",
    narrowHint: "ask for a bounded batch (a limit is windowed by GET /v1/scheduled).",
  });
  const rows = enumeration.rows
    .sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "") || a.id.localeCompare(b.id));
  return limit === null ? rows : rows.slice(0, limit);
}

export function markSent(id: string): void {
  selfHostedResource(SCHEDULED_RESOURCE).update(id, { status: "sent" });
}

export function markFailed(id: string, error: string): void {
  selfHostedResource(SCHEDULED_RESOURCE).update(id, { status: "failed", error });
}
