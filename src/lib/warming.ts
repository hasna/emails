import { listEmails } from "../db/emails.js";

export interface WarmingSchedule {
  id: string;
  domain: string;
  provider_id: string | null;
  target_daily_volume: number;
  start_date: string;
  status: "active" | "paused" | "completed";
  created_at: string;
  updated_at: string;
}

export interface WarmingDay {
  day: number;
  date: string;
  limit: number;
  is_today: boolean;
  is_past: boolean;
}

/**
 * Generate a warming schedule: exponential ramp-up.
 * Day 1: 50, day 3: 100, day 5: 250, day 7: 500, day 9: 1000...
 * Doubles roughly every 2 days until target is reached.
 * Returns array of {day, limit} entries.
 */
export function generateWarmingPlan(targetDailyVolume: number): { day: number; limit: number }[] {
  const plan: { day: number; limit: number }[] = [];
  let current = 50;
  let day = 1;

  while (current < targetDailyVolume) {
    plan.push({ day, limit: Math.min(current, targetDailyVolume) });
    if (day % 2 === 0) current = Math.round(current * 2);
    day++;
    if (day > 60) break; // safety cap at 60 days
  }
  plan.push({ day, limit: targetDailyVolume }); // final day = full volume

  return plan;
}

/**
 * 1-based day index of the ramp, anchored on the UTC calendar date.
 *
 * UTC, not local time, on purpose: the self-hosted server enforces the limit
 * with `warmingLimit()` in src/server/self-hosted/store.ts, which anchors on
 * `Date.UTC(...getUTCFullYear/Month/Date)`, and `getTodaySentCountsByDomain`
 * below counts sent mail over a UTC day window. Normalizing to LOCAL midnight
 * here (as this math used to) put the client one day ahead of the server for
 * every operator at a non-zero UTC offset — reporting up to twice the limit the
 * server would actually allow, on roughly half the days of a ramp.
 *
 * Returns null when `start_date` is missing or unparseable. That is reachable:
 * SQLite declares `start_date` NOT NULL, but the Postgres schema relaxed it, and
 * the /v1 client coerces null to "".
 */
export function warmingDayIndex(startDate: string, now: Date = new Date()): number | null {
  if (!startDate) return null;
  const start = new Date(startDate);
  if (!Number.isFinite(start.getTime())) return null;
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  return Math.floor((todayUtc - startUtc) / 86_400_000) + 1;
}

/**
 * Get today's sending limit for a domain, given the warming schedule.
 * Returns null if no active schedule exists for the domain.
 */
export function getTodayLimit(schedule: WarmingSchedule): number | null {
  if (schedule.status !== "active") return null;

  const currentDay = warmingDayIndex(schedule.start_date);
  // An unusable start date fails closed (0) rather than returning the full
  // target: this value gates local sending, so "unknown" must not mean "go".
  if (currentDay === null) return 0;
  if (currentDay < 1) return 0; // not started yet

  const plan = generateWarmingPlan(schedule.target_daily_volume);
  const dayEntry = plan.find(p => p.day >= currentDay) ?? plan[plan.length - 1];

  if (!dayEntry) return schedule.target_daily_volume;
  if (currentDay > plan[plan.length - 1]!.day) return schedule.target_daily_volume; // graduated

  return dayEntry.limit;
}

/**
 * Count today's sent mail per sending domain in ONE ledger read.
 *
 * The read takes the WHOLE UTC-day window — deliberately no row cap. This used to
 * pass `limit: 1000`, believing it a defensive clamp over a bounded superset; by the
 * time `listEmails` collapsed onto the store seam that argument had become a
 * client-side newest-first WINDOW across ALL domains. One busy sibling domain then
 * crowded a warming domain's sends out of the window, this function answered 0, and
 * `assertWarmingLimit` — which gates every local send on that number — never tripped
 * the ramp cap. `listEmails` enumerates the whole filtered stream and REFUSES when it
 * cannot finish, so the numbers returned here are totals, never lower bounds: a count
 * this function cannot establish throws instead of under-reporting.
 *
 * Every requested domain is present in the result, zero included.
 */
export async function getTodaySentCountsByDomain(domains: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const domain of domains) {
    const key = domain.trim().toLowerCase();
    if (key) counts.set(key, 0);
  }
  if (counts.size === 0) return counts;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const start = `${today}T00:00:00.000Z`;
  const tomorrow = new Date(start);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  for (const email of await listEmails({ since: start, until: tomorrow.toISOString() })) {
    const sender = (email.from_address ?? "").toLowerCase().split("@")[1]?.trim();
    if (sender !== undefined && counts.has(sender)) counts.set(sender, counts.get(sender)! + 1);
  }
  return counts;
}

/** Get how many emails have been sent from a single domain today. */
export async function getTodaySentCount(domain: string): Promise<number> {
  return (await getTodaySentCountsByDomain([domain])).get(domain.trim().toLowerCase()) ?? 0;
}

export interface WarmingProgress {
  /** 1-based day index within the ramp, clamped to >= 1 before the start date. */
  current_day: number;
  /** Day on which the plan reaches the full target volume. */
  total_days: number;
  progress_percent: number;
  /** null while the schedule is not active (paused/completed impose no cap). */
  today_limit: number | null;
  today_sent: number;
}

/**
 * Single source of truth for "where is this domain in its ramp" — shared by the
 * CLI (`emails domain warm*`), the MCP warming tools, the local REST warming
 * route, and the terminal formatter, so they all report the same numbers, and
 * the same numbers the self-hosted server enforces.
 *
 * `todaySent` lets a caller listing many schedules pass a count it already
 * batched via getTodaySentCountsByDomain instead of paying one ledger read
 * per row.
 */
export async function describeWarmingProgress(schedule: WarmingSchedule, todaySent?: number): Promise<WarmingProgress> {
  // An unusable start date reports day 1 (with a 0 limit from getTodayLimit)
  // rather than propagating NaN into JSON output and rendered tables.
  const currentDay = Math.max(1, warmingDayIndex(schedule.start_date) ?? 1);

  const plan = generateWarmingPlan(schedule.target_daily_volume);
  const totalDays = plan[plan.length - 1]?.day ?? 30;

  return {
    current_day: currentDay,
    total_days: totalDays,
    progress_percent: Math.min(100, Math.round((currentDay / totalDays) * 100)),
    today_limit: getTodayLimit(schedule),
    today_sent: todaySent ?? (await getTodaySentCount(schedule.domain)),
  };
}

/**
 * Format warming schedule status for terminal display. Callers that already
 * computed progress pass it in so the sent-mail read is not repeated.
 */
export async function formatWarmingStatus(
  schedule: WarmingSchedule,
  progress?: WarmingProgress,
): Promise<string> {
  // The default is resolved HERE rather than in the parameter list: a default parameter
  // cannot be awaited, and awaiting the promise instead of the value would have rendered
  // `[object Promise]` into an operator-facing line.
  const resolved = progress ?? (await describeWarmingProgress(schedule));
  return formatWarmingProgress(schedule, resolved);
}

/** The pure half, so a caller that already has a progress record pays no read. */
function formatWarmingProgress(schedule: WarmingSchedule, progress: WarmingProgress): string {
  return [
    `Domain: ${schedule.domain}`,
    `Status: ${schedule.status} | Day ${progress.current_day}/${progress.total_days} (${progress.progress_percent}% complete)`,
    `Today's limit: ${progress.today_limit ?? "unlimited"} | Sent today: ${progress.today_sent}`,
    `Target: ${schedule.target_daily_volume}/day | Started: ${schedule.start_date}`,
  ].join("\n");
}
