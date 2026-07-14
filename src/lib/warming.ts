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
 * Get today's sending limit for a domain, given the warming schedule.
 * Returns null if no active schedule exists for the domain.
 */
export function getTodayLimit(schedule: WarmingSchedule): number | null {
  if (schedule.status !== "active") return null;

  const startDate = new Date(schedule.start_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  startDate.setHours(0, 0, 0, 0);

  const dayDiff = Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  const currentDay = dayDiff + 1; // 1-based

  if (currentDay < 1) return 0; // not started yet

  const plan = generateWarmingPlan(schedule.target_daily_volume);
  const dayEntry = plan.find(p => p.day >= currentDay) ?? plan[plan.length - 1];

  if (!dayEntry) return schedule.target_daily_volume;
  if (currentDay > plan[plan.length - 1]!.day) return schedule.target_daily_volume; // graduated

  return dayEntry.limit;
}

/**
 * Get how many emails have been sent from a domain today.
 *
 * Sent mail is a `/v1`-backed resource (the emails repo routes to the operator's
 * API), so this fetches today's outbound messages and counts those whose From
 * domain matches — filtering client-side over the bounded superset the repo
 * returns (the same pattern the other self-hosted repos use).
 */
export function getTodaySentCount(domain: string): number {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const start = `${today}T00:00:00.000Z`;
  const tomorrow = new Date(start);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const end = tomorrow.toISOString();
  const target = domain.trim().toLowerCase();
  return listEmails({ since: start, until: end, limit: 1000 })
    .filter((email) => (email.from_address ?? "").toLowerCase().split("@")[1]?.trim() === target)
    .length;
}

/**
 * Format warming schedule status for terminal display.
 */
export function formatWarmingStatus(schedule: WarmingSchedule): string {
  const todayLimit = getTodayLimit(schedule);
  const todaySent = getTodaySentCount(schedule.domain);

  const startDate = new Date(schedule.start_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  startDate.setHours(0, 0, 0, 0);
  const currentDay = Math.max(1, Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1);

  const plan = generateWarmingPlan(schedule.target_daily_volume);
  const totalDays = plan[plan.length - 1]?.day ?? 30;
  const progress = Math.min(100, Math.round((currentDay / totalDays) * 100));

  return [
    `Domain: ${schedule.domain}`,
    `Status: ${schedule.status} | Day ${currentDay}/${totalDays} (${progress}% complete)`,
    `Today's limit: ${todayLimit ?? "unlimited"} | Sent today: ${todaySent}`,
    `Target: ${schedule.target_daily_volume}/day | Started: ${schedule.start_date}`,
  ].join("\n");
}
