/**
 * Test-only seeders for two legacy SQLite tables that the shipped product still
 * READS but no longer WRITES.
 *
 * `email_triage` and `email_agent_runs` are read by live surfaces — the
 * `emails serve` REST route GET /api/inbound/:id folds an agent-run summary into
 * the response, and the TUI data layer joins both tables — but the last writer
 * was removed with the triage/email-agent feature. The former writer modules
 * (src/db/triage.*, src/db/email-agents.*) were unreachable product code and are
 * gone; these helpers keep the read paths under test without resurrecting a
 * write API that nothing ships.
 *
 * Deliberately raw SQL and deliberately in test-support: if a real writer ever
 * comes back it belongs in src/db, not here.
 */
import type { Database } from "../db/database.js";
import { getDatabase, now, uuid } from "../db/database.js";

export interface SeedTriageInput {
  email_id?: string;
  inbound_email_id?: string;
  label: string;
  priority: number;
  summary?: string;
  sentiment?: string;
  draft_reply?: string;
  confidence?: number;
  model?: string;
}

/** Insert (replacing any prior row for the same email) one `email_triage` row. */
export function seedTriage(input: SeedTriageInput, db?: Database): string {
  const d = db ?? getDatabase();
  if (!input.email_id && !input.inbound_email_id) {
    throw new Error("seedTriage requires email_id or inbound_email_id");
  }
  if (input.email_id) d.run("DELETE FROM email_triage WHERE email_id = ?", [input.email_id]);
  if (input.inbound_email_id) d.run("DELETE FROM email_triage WHERE inbound_email_id = ?", [input.inbound_email_id]);

  const id = uuid();
  const timestamp = now();
  d.run(
    `INSERT INTO email_triage (id, email_id, inbound_email_id, label, priority, summary, sentiment, draft_reply, confidence, model, triaged_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.email_id ?? null,
      input.inbound_email_id ?? null,
      input.label,
      input.priority,
      input.summary ?? null,
      input.sentiment ?? null,
      input.draft_reply ?? null,
      input.confidence ?? 0,
      input.model ?? null,
      timestamp,
      timestamp,
    ],
  );
  return id;
}

export interface SeedEmailAgentRunInput {
  agent_key: string;
  inbound_email_id: string;
  provider: string;
  model: string;
  status: string;
  category?: string;
  labels?: string[];
  priority?: number;
  confidence?: number;
  risk_score?: number;
  summary?: string;
  reasoning?: string;
  output?: Record<string, unknown>;
  error?: string;
  started_at?: string;
  completed_at?: string;
}

/** Insert (upserting on agent_key + inbound_email_id) one `email_agent_runs` row. */
export function seedEmailAgentRun(input: SeedEmailAgentRunInput, db?: Database): string {
  const d = db ?? getDatabase();
  const id = uuid();
  const startedAt = input.started_at ?? now();
  const completedAt = input.completed_at ?? now();
  d.run(
    `INSERT INTO email_agent_runs
       (id, agent_key, inbound_email_id, provider, model, status, category, labels_json,
        priority, confidence, risk_score, summary, reasoning, tool_calls_json, output_json,
        error, started_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_key, inbound_email_id) DO UPDATE SET
       id = excluded.id,
       provider = excluded.provider,
       model = excluded.model,
       status = excluded.status,
       category = excluded.category,
       labels_json = excluded.labels_json,
       priority = excluded.priority,
       confidence = excluded.confidence,
       risk_score = excluded.risk_score,
       summary = excluded.summary,
       reasoning = excluded.reasoning,
       tool_calls_json = excluded.tool_calls_json,
       output_json = excluded.output_json,
       error = excluded.error,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at`,
    [
      id,
      input.agent_key,
      input.inbound_email_id,
      input.provider,
      input.model,
      input.status,
      input.category ?? null,
      JSON.stringify(input.labels ?? []),
      input.priority ?? null,
      input.confidence ?? null,
      input.risk_score ?? null,
      input.summary ?? null,
      input.reasoning ?? null,
      JSON.stringify([]),
      JSON.stringify(input.output ?? {}),
      input.error ?? null,
      startedAt,
      completedAt,
      completedAt,
    ],
  );
  return id;
}
