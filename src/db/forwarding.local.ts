import type { Database } from "./database.js";
import { getDatabase, now, uuid } from "./database.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";

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

interface ForwardingRuleRow extends Omit<ForwardingRule, "enabled" | "mode"> {
  mode: string;
  enabled: number;
}

interface ForwardingDeliveryRow extends Omit<ForwardingDelivery, "status"> {
  status: string;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`Invalid email address: ${value}`);
  }
  return email;
}

function rowToRule(row: ForwardingRuleRow): ForwardingRule {
  return {
    id: row.id,
    source_address: row.source_address,
    target_address: row.target_address,
    mode: row.mode as ForwardingMode,
    provider_id: row.provider_id,
    from_address: row.from_address,
    enabled: !!row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToDelivery(row: ForwardingDeliveryRow): ForwardingDelivery {
  return { ...row, status: row.status as ForwardingDeliveryStatus };
}

export function createForwardingRule(input: {
  source_address: string;
  target_address: string;
  mode?: ForwardingMode;
  provider_id?: string | null;
  from_address?: string | null;
  enabled?: boolean;
}, db?: Database): ForwardingRule {
  const d = db || getDatabase();
  const source = normalizeEmail(input.source_address);
  const target = normalizeEmail(input.target_address);
  const from = input.from_address ? normalizeEmail(input.from_address) : null;
  const mode = input.mode ?? "app-copy";
  const enabled = input.enabled === false ? 0 : 1;
  const existing = d.query(
    "SELECT * FROM forwarding_rules WHERE source_address = ? AND target_address = ? AND mode = ?",
  ).get(source, target, mode) as ForwardingRuleRow | null;
  if (existing) {
    d.run(
      "UPDATE forwarding_rules SET provider_id = ?, from_address = ?, enabled = ?, updated_at = ? WHERE id = ?",
      [input.provider_id ?? null, from, enabled, now(), existing.id],
    );
    return getForwardingRule(existing.id, d)!;
  }

  const id = uuid();
  const ts = now();
  d.run(
    `INSERT INTO forwarding_rules
      (id, source_address, target_address, mode, provider_id, from_address, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, source, target, mode, input.provider_id ?? null, from, enabled, ts, ts],
  );
  return getForwardingRule(id, d)!;
}

export function getForwardingRule(id: string, db?: Database): ForwardingRule | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM forwarding_rules WHERE id = ?").get(id) as ForwardingRuleRow | null;
  return row ? rowToRule(row) : null;
}

export function listForwardingRules(opts?: {
  source_address?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}, db?: Database): ForwardingRule[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (opts?.source_address) {
    conditions.push("source_address = ?");
    params.push(normalizeEmail(opts.source_address));
  }
  if (opts?.enabled !== undefined) {
    conditions.push("enabled = ?");
    params.push(opts.enabled ? 1 : 0);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = safeOptionalLimit(opts?.limit);
  if (limit !== null) {
    params.push(limit, safeOffset(opts?.offset));
  }
  const rows = d.query(
    `SELECT * FROM forwarding_rules ${where} ORDER BY source_address, target_address${limit !== null ? " LIMIT ? OFFSET ?" : ""}`,
  ).all(...params) as ForwardingRuleRow[];
  return rows.map(rowToRule);
}

export function setForwardingRuleEnabled(id: string, enabled: boolean, db?: Database): ForwardingRule {
  const d = db || getDatabase();
  d.run("UPDATE forwarding_rules SET enabled = ?, updated_at = ? WHERE id = ?", [enabled ? 1 : 0, now(), id]);
  const rule = getForwardingRule(id, d);
  if (!rule) throw new Error(`Forwarding rule not found: ${id}`);
  return rule;
}

export function removeForwardingRule(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  return d.run("DELETE FROM forwarding_rules WHERE id = ?", [id]).changes > 0;
}

export function listPendingForwarding(limit = 100, db?: Database, opts: { backfill?: boolean } = {}): PendingForwarding[] {
  const d = db || getDatabase();
  const receivedAtGate = opts.backfill ? "" : "AND datetime(inbound.received_at) >= datetime(rules.created_at)";
  const rows = d.query(
    `SELECT
       rules.*,
       inbound.id AS inbound_email_id
     FROM forwarding_rules rules
     JOIN inbound_recipients recipient ON recipient.address = rules.source_address
     JOIN inbound_emails inbound ON inbound.id = recipient.inbound_email_id
     LEFT JOIN forwarding_deliveries delivery
       ON delivery.rule_id = rules.id
      AND delivery.inbound_email_id = inbound.id
      AND delivery.status = 'sent'
     WHERE rules.enabled = 1
       AND rules.mode = 'app-copy'
       AND inbound.is_sent = 0
       ${receivedAtGate}
       AND delivery.id IS NULL
     ORDER BY inbound.received_at ASC, rules.source_address ASC
     LIMIT ?`,
  ).all(Math.max(1, Math.min(1000, Math.trunc(limit)))) as Array<ForwardingRuleRow & { inbound_email_id: string }>;
  return rows.map((row) => ({ rule: rowToRule(row), inbound_email_id: row.inbound_email_id }));
}

export function recordForwardingDelivery(input: {
  rule_id: string;
  inbound_email_id: string;
  sent_email_id?: string | null;
  status: ForwardingDeliveryStatus;
  error?: string | null;
}, db?: Database): ForwardingDelivery {
  const d = db || getDatabase();
  const id = uuid();
  d.run(
    `INSERT OR REPLACE INTO forwarding_deliveries
      (id, rule_id, inbound_email_id, sent_email_id, status, error, created_at)
     VALUES (
       COALESCE((SELECT id FROM forwarding_deliveries WHERE rule_id = ? AND inbound_email_id = ?), ?),
       ?, ?, ?, ?, ?, datetime('now')
     )`,
    [
      input.rule_id,
      input.inbound_email_id,
      id,
      input.rule_id,
      input.inbound_email_id,
      input.sent_email_id ?? null,
      input.status,
      input.error ?? null,
    ],
  );
  const row = d.query(
    "SELECT * FROM forwarding_deliveries WHERE rule_id = ? AND inbound_email_id = ?",
  ).get(input.rule_id, input.inbound_email_id) as ForwardingDeliveryRow;
  return rowToDelivery(row);
}
