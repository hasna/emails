import {
  emailDigestPeriodLabel,
  getLatestEmailDigest,
  normalizeEmailDigestPeriod,
  type EmailDigest,
  type EmailDigestPeriod,
} from "../db/email-digests.js";

export interface EmailDigestWindow {
  period: EmailDigestPeriod;
  since: string;
  until: string;
}

export interface GenerateEmailDigestOptions {
  period?: EmailDigestPeriod | string;
  limit?: number;
  offline?: boolean;
  now?: Date;
}

export interface LoadEmailDigestOptions extends GenerateEmailDigestOptions {
  fresh?: boolean;
  allowLocalFallback?: boolean;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function resolveEmailDigestWindow(periodInput: EmailDigestPeriod | string | undefined, at = new Date()): EmailDigestWindow {
  const period = normalizeEmailDigestPeriod(typeof periodInput === "string" ? periodInput : periodInput ?? "today");
  const todayStart = startOfLocalDay(at);
  if (period === "today") {
    return { period, since: todayStart.toISOString(), until: at.toISOString() };
  }
  if (period === "yesterday") {
    const since = addDays(todayStart, -1);
    return { period, since: since.toISOString(), until: todayStart.toISOString() };
  }
  if (period === "last7") {
    return { period, since: addDays(todayStart, -6).toISOString(), until: at.toISOString() };
  }
  const monthStart = new Date(at.getFullYear(), at.getMonth(), 1);
  return { period, since: monthStart.toISOString(), until: at.toISOString() };
}

/**
 * Generate an email digest. Generation reads the LOCAL inbound message store and
 * per-message AI agent runs (categorizer/labeler/summary) via a SQL join. In the
 * self-hosted client there is no local inbound/agent-run store — digests are
 * computed on the operator's server — so generation fails loud. Read the latest
 * server-generated digest with `loadEmailDigest` instead.
 */
export async function generateEmailDigest(
  _periodOrOptions: EmailDigestPeriod | string | GenerateEmailDigestOptions = "today",
  _optsOrDeps: GenerateEmailDigestOptions = {},
): Promise<EmailDigest> {
  throw new Error(
    "generateEmailDigest is not available in the self-hosted client; digests are generated on the self-hosted server. Use loadEmailDigest to read the latest server-generated digest.",
  );
}

export async function loadEmailDigest(
  periodOrOptions: EmailDigestPeriod | string | LoadEmailDigestOptions = "today",
  optsOrDeps: LoadEmailDigestOptions = {},
): Promise<EmailDigest> {
  const opts = typeof periodOrOptions === "object"
    ? periodOrOptions
    : { ...(optsOrDeps as LoadEmailDigestOptions), period: periodOrOptions };
  const period = normalizeEmailDigestPeriod(typeof opts.period === "string" ? opts.period : opts.period ?? "today");
  if (!opts.fresh) {
    const latest = getLatestEmailDigest(period);
    if (latest) return latest;
  }
  // No cached digest (or a fresh one was requested): generation is server-side.
  return generateEmailDigest({ ...opts, period });
}

export function formatEmailDigest(digest: EmailDigest): string {
  const lines = [
    `${emailDigestPeriodLabel(digest.period)} digest`,
    `  window: ${digest.since} to ${digest.until}`,
    `  messages: ${digest.message_count}`,
    `  provider: ${digest.provider} ${digest.model}`,
    "",
    `Summary: ${digest.summary ?? "(no summary)"}`,
  ];
  if (digest.highlights.length) {
    lines.push("", "Highlights:");
    for (const item of digest.highlights) lines.push(`- ${item}`);
  }
  if (digest.action_items.length) {
    lines.push("", "Action items:");
    for (const item of digest.action_items) lines.push(`- ${item}`);
  }
  if (digest.important_email_ids.length) {
    lines.push("", `Important email ids: ${digest.important_email_ids.join(", ")}`);
  }
  return lines.join("\n");
}
