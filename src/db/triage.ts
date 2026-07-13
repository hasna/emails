import { now, uuid } from "./runtime.js";
import { safeLimit, safeOffset } from "./pagination.js";
import { selfHostedResource, cnum, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const TRIAGE_RESOURCE = "triage";

// ─── Types ───────────────────────────────────────────────────────────────────

export type TriageLabel = "action-required" | "fyi" | "urgent" | "follow-up" | "spam" | "newsletter" | "transactional";
export type TriageSentiment = "positive" | "negative" | "neutral";

export interface TriageResult {
  id: string;
  email_id: string | null;
  inbound_email_id: string | null;
  label: TriageLabel;
  priority: number;
  summary: string | null;
  sentiment: TriageSentiment | null;
  draft_reply: string | null;
  confidence: number;
  model: string | null;
  triaged_at: string;
  created_at: string;
}

export type TriageSummary = Omit<TriageResult, "draft_reply">;

export interface SaveTriageInput {
  email_id?: string | null;
  inbound_email_id?: string | null;
  label: TriageLabel;
  priority: number;
  summary?: string | null;
  sentiment?: TriageSentiment | null;
  draft_reply?: string | null;
  confidence?: number;
  model?: string | null;
}

export interface TriageFilter {
  label?: TriageLabel;
  priority?: number;
  sentiment?: TriageSentiment;
  limit?: number;
  offset?: number;
}

export interface TriageStats {
  total: number;
  by_label: Record<string, number>;
  by_priority: Record<number, number>;
  by_sentiment: Record<string, number>;
  avg_priority: number;
  avg_confidence: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function apiToTriage(e: Record<string, unknown>): TriageResult {
  return {
    id: cstr(e["id"]),
    email_id: cstrOrNull(e["email_id"]) || null,
    inbound_email_id: cstrOrNull(e["inbound_email_id"]) || null,
    label: cstr(e["label"]) as TriageLabel,
    priority: cnum(e["priority"]),
    summary: cstrOrNull(e["summary"]) || null,
    sentiment: (cstrOrNull(e["sentiment"]) || null) as TriageSentiment | null,
    draft_reply: cstrOrNull(e["draft_reply"]) || null,
    confidence: cnum(e["confidence"]),
    model: cstrOrNull(e["model"]) || null,
    triaged_at: ciso(e["triaged_at"]),
    created_at: ciso(e["created_at"]),
  };
}

function toTriageSummary(t: TriageResult): TriageSummary {
  const { draft_reply: _draftReply, ...summary } = t;
  return summary;
}

function matchesTriageFilter(t: TriageResult, filter?: TriageFilter): boolean {
  if (filter?.label && t.label !== filter.label) return false;
  if (filter?.priority && t.priority !== filter.priority) return false;
  if (filter?.sentiment && t.sentiment !== filter.sentiment) return false;
  return true;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export function saveTriage(input: SaveTriageInput): TriageResult {
  if (!input.email_id && !input.inbound_email_id) {
    throw new Error("Either email_id or inbound_email_id must be provided");
  }
  const store = selfHostedResource(TRIAGE_RESOURCE);

  // Upsert: delete existing triage for this email if any.
  const all = store.list({ limit: 1000 }).map(apiToTriage);
  for (const t of all) {
    if (input.email_id && t.email_id === input.email_id) store.del(t.id);
    else if (input.inbound_email_id && t.inbound_email_id === input.inbound_email_id) store.del(t.id);
  }

  const id = uuid();
  const timestamp = now();
  const created = store.create({
    id,
    email_id: input.email_id || null,
    inbound_email_id: input.inbound_email_id || null,
    label: input.label,
    priority: input.priority,
    summary: input.summary || null,
    sentiment: input.sentiment || null,
    draft_reply: input.draft_reply || null,
    confidence: input.confidence ?? 0,
    model: input.model || null,
    triaged_at: timestamp,
    created_at: timestamp,
  });
  return apiToTriage(created);
}

export function getTriage(
  emailId: string,
  type: "sent" | "inbound" = "sent",
): TriageResult | null {
  const match = selfHostedResource(TRIAGE_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToTriage)
    .find((t) => (type === "inbound" ? t.inbound_email_id : t.email_id) === emailId);
  return match ?? null;
}

export function getTriageById(id: string): TriageResult | null {
  const record = selfHostedResource(TRIAGE_RESOURCE).get(id);
  return record ? apiToTriage(record) : null;
}

export function listTriaged(filter?: TriageFilter): TriageResult[] {
  const limit = safeLimit(filter?.limit);
  const offset = safeOffset(filter?.offset);
  const rows = selfHostedResource(TRIAGE_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToTriage)
    .filter((t) => matchesTriageFilter(t, filter))
    .sort((a, b) => (b.triaged_at ?? "").localeCompare(a.triaged_at ?? ""));
  return rows.slice(offset, offset + limit);
}

export function listTriagedSummaries(filter?: TriageFilter): TriageSummary[] {
  return listTriaged(filter).map(toTriageSummary);
}

export function getUntriaged(
  _type: "sent" | "inbound" = "sent",
  _limit = 20,
): { id: string; subject: string; from_address: string }[] {
  // Selecting emails NOT yet triaged joins the triage table against the sent
  // (`emails`) / inbound (`inbound_emails`) message tables — data owned by the
  // server. There is no client-side /v1 equivalent for this cross-table scan.
  throw new Error(
    "getUntriaged is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

export function deleteTriage(id: string): boolean {
  return selfHostedResource(TRIAGE_RESOURCE).del(id);
}

export function deleteTriageByEmail(emailId: string, type: "sent" | "inbound" = "sent"): boolean {
  const store = selfHostedResource(TRIAGE_RESOURCE);
  const matches = store
    .list({ limit: 1000 })
    .map(apiToTriage)
    .filter((t) => (type === "inbound" ? t.inbound_email_id : t.email_id) === emailId);
  let deleted = false;
  for (const t of matches) if (store.del(t.id)) deleted = true;
  return deleted;
}

export function getTriageStats(): TriageStats {
  const rows = selfHostedResource(TRIAGE_RESOURCE).list({ limit: 1000 }).map(apiToTriage);
  const by_label: Record<string, number> = {};
  const by_priority: Record<number, number> = {};
  const by_sentiment: Record<string, number> = {};
  let prioritySum = 0;
  let confidenceSum = 0;
  for (const t of rows) {
    by_label[t.label] = (by_label[t.label] ?? 0) + 1;
    by_priority[t.priority] = (by_priority[t.priority] ?? 0) + 1;
    if (t.sentiment) by_sentiment[t.sentiment] = (by_sentiment[t.sentiment] ?? 0) + 1;
    prioritySum += t.priority;
    confidenceSum += t.confidence;
  }
  const total = rows.length;
  return {
    total,
    by_label,
    by_priority,
    by_sentiment,
    avg_priority: total > 0 ? prioritySum / total : 0,
    avg_confidence: total > 0 ? confidenceSum / total : 0,
  };
}

export function clearTriage(): number {
  const store = selfHostedResource(TRIAGE_RESOURCE);
  const all = store.list({ limit: 1000 }).map(apiToTriage);
  let count = 0;
  for (const t of all) if (store.del(t.id)) count++;
  return count;
}
