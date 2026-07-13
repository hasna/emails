import { now, uuid } from "./runtime.js";
import { cappedLimit, safeOffset } from "./pagination.js";
import { selfHostedResource, cbool, cnum, cobj, cstrArray, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

// Agent SETTINGS are keyed on agent_key (categorizer/labeler/fraud), seeded
// server-side; GET/PATCH/DELETE /v1/email-agents/<agent_key>, POST is an
// idempotent upsert. The per-inbound RUN ledger is a SEPARATE uuid-keyed
// resource.
const EMAIL_AGENT_RESOURCE = "email-agents";
const EMAIL_AGENT_RUN_RESOURCE = "email-agent-runs";

export type EmailAgentKey = "categorizer" | "labeler" | "fraud";
export type EmailAgentProvider = "external";
export type EmailAgentRunStatus = "ok" | "error" | "skipped";

export interface EmailAgentDefinition {
  key: EmailAgentKey;
  name: string;
  description: string;
  defaultModel: string;
  appliesLabels: boolean;
  investigatesDomains: boolean;
}

export interface EmailAgentSetting {
  agent_key: EmailAgentKey;
  enabled: boolean;
  always_on: boolean;
  provider: EmailAgentProvider;
  model: string | null;
  apply_labels: boolean;
  use_network_tools: boolean;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SaveEmailAgentSettingInput {
  enabled?: boolean;
  always_on?: boolean;
  provider?: EmailAgentProvider;
  model?: string | null;
  apply_labels?: boolean;
  use_network_tools?: boolean;
  config?: Record<string, unknown>;
}

export interface EmailAgentRun {
  id: string;
  agent_key: EmailAgentKey;
  inbound_email_id: string;
  provider: EmailAgentProvider;
  model: string;
  status: EmailAgentRunStatus;
  category: string | null;
  labels: string[];
  priority: number | null;
  confidence: number | null;
  risk_score: number | null;
  summary: string | null;
  reasoning: string | null;
  tool_calls: string[];
  output: Record<string, unknown>;
  error: string | null;
  started_at: string;
  completed_at: string;
  created_at: string;
}

export interface SaveEmailAgentRunInput {
  agent_key: EmailAgentKey;
  inbound_email_id: string;
  provider: EmailAgentProvider;
  model: string;
  status: EmailAgentRunStatus;
  category?: string | null;
  labels?: string[];
  priority?: number | null;
  confidence?: number | null;
  risk_score?: number | null;
  summary?: string | null;
  reasoning?: string | null;
  tool_calls?: string[];
  output?: Record<string, unknown>;
  error?: string | null;
  started_at?: string;
  completed_at?: string;
}

export interface EmailAgentRunFilter {
  agent_key?: EmailAgentKey;
  inbound_email_id?: string;
  status?: EmailAgentRunStatus;
  limit?: number;
  offset?: number;
}

export interface PendingAgentEmail {
  id: string;
  from_address: string;
  subject: string;
  created_at: string;
  received_at: string;
}

export const EMAIL_AGENT_DEFINITIONS: EmailAgentDefinition[] = [
  {
    key: "categorizer",
    name: "Categorizer",
    description: "Classifies each inbound email into a useful category, priority, and short summary.",
    defaultModel: "external-summary",
    appliesLabels: false,
    investigatesDomains: false,
  },
  {
    key: "labeler",
    name: "Labeler",
    description: "Applies concise local labels to each inbound email for mailbox organization.",
    defaultModel: "external-summary",
    appliesLabels: true,
    investigatesDomains: false,
  },
  {
    key: "fraud",
    name: "Fraud Investigator",
    description: "Checks sender/link domains with read-only investigation tools and scores fraud risk.",
    defaultModel: "external-summary",
    appliesLabels: true,
    investigatesDomains: true,
  },
];

const MAX_AGENT_RUN_LIST_LIMIT = 500;

function assertAgentKey(value: string): asserts value is EmailAgentKey {
  if (!EMAIL_AGENT_DEFINITIONS.some((agent) => agent.key === value)) {
    throw new Error(`Unknown email agent "${value}". Use one of: ${EMAIL_AGENT_DEFINITIONS.map((agent) => agent.key).join(", ")}`);
  }
}

export function normalizeEmailAgentKey(value: string): EmailAgentKey {
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  const aliases: Record<string, EmailAgentKey> = {
    category: "categorizer",
    classify: "categorizer",
    classifier: "categorizer",
    categories: "categorizer",
    labels: "labeler",
    label: "labeler",
    fraud: "fraud",
    risk: "fraud",
    security: "fraud",
  };
  const key = aliases[normalized] ?? normalized;
  assertAgentKey(key);
  return key;
}

export function getEmailAgentDefinition(agentKey: EmailAgentKey): EmailAgentDefinition {
  return EMAIL_AGENT_DEFINITIONS.find((agent) => agent.key === agentKey)!;
}

function apiToSetting(e: Record<string, unknown>): EmailAgentSetting {
  const agentKey = cstr(e["agent_key"]);
  assertAgentKey(agentKey);
  return {
    agent_key: agentKey,
    enabled: cbool(e["enabled"]),
    always_on: cbool(e["always_on"]),
    provider: cstr(e["provider"]) as EmailAgentProvider,
    model: cstrOrNull(e["model"]) || null,
    apply_labels: cbool(e["apply_labels"]),
    use_network_tools: cbool(e["use_network_tools"]),
    config: cobj(e["config"] ?? e["config_json"]),
    created_at: ciso(e["created_at"]),
    updated_at: ciso(e["updated_at"]),
  };
}

function apiToRun(e: Record<string, unknown>): EmailAgentRun {
  const agentKey = cstr(e["agent_key"]);
  assertAgentKey(agentKey);
  return {
    id: cstr(e["id"]),
    agent_key: agentKey,
    inbound_email_id: cstr(e["inbound_email_id"]),
    provider: cstr(e["provider"]) as EmailAgentProvider,
    model: cstr(e["model"]),
    status: cstr(e["status"]) as EmailAgentRunStatus,
    category: cstrOrNull(e["category"]) || null,
    labels: cstrArray(e["labels"] ?? e["labels_json"]),
    priority: e["priority"] == null ? null : cnum(e["priority"]),
    confidence: e["confidence"] == null ? null : cnum(e["confidence"]),
    risk_score: e["risk_score"] == null ? null : cnum(e["risk_score"]),
    summary: cstrOrNull(e["summary"]) || null,
    reasoning: cstrOrNull(e["reasoning"]) || null,
    tool_calls: cstrArray(e["tool_calls"] ?? e["tool_calls_json"]),
    output: cobj(e["output"] ?? e["output_json"]),
    error: cstrOrNull(e["error"]) || null,
    started_at: cstr(e["started_at"]),
    completed_at: cstr(e["completed_at"]),
    created_at: cstr(e["created_at"]),
  };
}

export function ensureEmailAgentSettings(): EmailAgentSetting[] {
  // Settings rows are seeded server-side; ensuring is a read.
  return listEmailAgentSettings();
}

export function listEmailAgentSettings(): EmailAgentSetting[] {
  return selfHostedResource(EMAIL_AGENT_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToSetting)
    .sort((a, b) => a.agent_key.localeCompare(b.agent_key));
}

export function getEmailAgentSetting(agentKey: EmailAgentKey): EmailAgentSetting {
  const record = selfHostedResource(EMAIL_AGENT_RESOURCE).get(agentKey);
  if (!record) throw new Error(`Email agent setting missing: ${agentKey}`);
  return apiToSetting(record);
}

export function updateEmailAgentSetting(agentKey: EmailAgentKey, input: SaveEmailAgentSettingInput): EmailAgentSetting {
  const current = getEmailAgentSetting(agentKey);
  const next = {
    enabled: input.enabled ?? current.enabled,
    always_on: input.always_on ?? current.always_on,
    provider: input.provider ?? current.provider,
    model: input.model === undefined ? current.model : input.model,
    apply_labels: input.apply_labels ?? current.apply_labels,
    use_network_tools: input.use_network_tools ?? current.use_network_tools,
    config: input.config ? { ...current.config, ...input.config } : current.config,
  };
  const updated = selfHostedResource(EMAIL_AGENT_RESOURCE).update(agentKey, {
    enabled: next.enabled,
    always_on: next.always_on,
    provider: next.provider,
    model: next.model,
    apply_labels: next.apply_labels,
    use_network_tools: next.use_network_tools,
    config_json: JSON.stringify(next.config),
    updated_at: now(),
  });
  return apiToSetting(updated);
}

export function listEnabledAlwaysOnEmailAgents(): EmailAgentSetting[] {
  return listEmailAgentSettings().filter((setting) => setting.enabled && setting.always_on);
}

export function saveEmailAgentRun(input: SaveEmailAgentRunInput): EmailAgentRun {
  const store = selfHostedResource(EMAIL_AGENT_RUN_RESOURCE);
  // One run per (agent_key, inbound_email_id): replace any existing row.
  const existing = store
    .list({ limit: 1000 })
    .map(apiToRun)
    .filter((r) => r.agent_key === input.agent_key && r.inbound_email_id === input.inbound_email_id);
  for (const r of existing) store.del(r.id);

  const id = uuid();
  const startedAt = input.started_at ?? now();
  const completedAt = input.completed_at ?? now();
  const created = store.create({
    id,
    agent_key: input.agent_key,
    inbound_email_id: input.inbound_email_id,
    provider: input.provider,
    model: input.model,
    status: input.status,
    category: input.category ?? null,
    labels_json: JSON.stringify(normalizeLabels(input.labels ?? [])),
    priority: input.priority ?? null,
    confidence: input.confidence ?? null,
    risk_score: input.risk_score ?? null,
    summary: input.summary ?? null,
    reasoning: input.reasoning ?? null,
    tool_calls_json: JSON.stringify(input.tool_calls ?? []),
    output_json: JSON.stringify(input.output ?? {}),
    error: input.error ?? null,
    started_at: startedAt,
    completed_at: completedAt,
    created_at: completedAt,
  });
  return apiToRun(created);
}

export function getEmailAgentRun(agentKey: EmailAgentKey, inboundEmailId: string): EmailAgentRun | null {
  const match = selfHostedResource(EMAIL_AGENT_RUN_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToRun)
    .find((r) => r.agent_key === agentKey && r.inbound_email_id === inboundEmailId);
  return match ?? null;
}

export function listEmailAgentRuns(filter: EmailAgentRunFilter = {}): EmailAgentRun[] {
  let rows = selfHostedResource(EMAIL_AGENT_RUN_RESOURCE).list({ limit: 1000 }).map(apiToRun);
  if (filter.agent_key) rows = rows.filter((r) => r.agent_key === filter.agent_key);
  if (filter.inbound_email_id) rows = rows.filter((r) => r.inbound_email_id === filter.inbound_email_id);
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  rows.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
  const limit = cappedLimit(filter.limit, 50, MAX_AGENT_RUN_LIST_LIMIT);
  const offset = safeOffset(filter.offset);
  return rows.slice(offset, offset + limit);
}

export function listPendingInboundEmailsForAgent(_agentKey: EmailAgentKey, _limit = 50): PendingAgentEmail[] {
  // Pending selection joins inbound_emails against the agent run ledger — the
  // inbound message table is owned by the server, so there is no client-side
  // /v1 equivalent for this scan.
  throw new Error(
    "listPendingInboundEmailsForAgent is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

function normalizeLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const label of labels) {
    const value = label.trim().toLowerCase().replace(/[_\s]+/g, "-").replace(/[^a-z0-9:-]/g, "").slice(0, 64);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}
