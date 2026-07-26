import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { describeWarmingProgress, generateWarmingPlan, getTodayLimit, formatWarmingStatus, getTodaySentCount, getTodaySentCountsByDomain, warmingDayIndex } from "./warming.js";
import type { WarmingSchedule } from "./warming.js";

// getTodaySentCount / formatWarmingStatus read the outbound sent-ledger over the
// /v1 messages store, so a configured self-hosted endpoint is required even when
// no rows are seeded. generateWarmingPlan and getTodayLimit are pure and do not
// need it, but sharing the stub scaffolding keeps the file uniform.
/** N days before today's UTC calendar date — the calendar the ramp is anchored on. */
function utcDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

let stub: V1Stub;
beforeAll(async () => { stub = await startV1Stub(); });
afterAll(() => stub.stop());
beforeEach(async () => { await stub.reset(); stub.applyEnv(); });
afterEach(() => stub.clearEnv());

// PURE: generateWarmingPlan is a deterministic ramp computation.
describe("generateWarmingPlan", () => {
  it("starts at 50 on day 1", () => {
    const plan = generateWarmingPlan(10000);
    expect(plan[0]!.day).toBe(1);
    expect(plan[0]!.limit).toBe(50);
  });

  it("final entry equals target daily volume", () => {
    const target = 1000;
    const plan = generateWarmingPlan(target);
    expect(plan[plan.length - 1]!.limit).toBe(target);
  });

  it("never exceeds target daily volume", () => {
    const target = 500;
    const plan = generateWarmingPlan(target);
    for (const entry of plan) {
      expect(entry.limit).toBeLessThanOrEqual(target);
    }
  });

  it("day numbers are monotonically increasing", () => {
    const plan = generateWarmingPlan(2000);
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i]!.day).toBeGreaterThan(plan[i - 1]!.day);
    }
  });

  it("handles small target (below starting 50)", () => {
    const plan = generateWarmingPlan(30);
    // when target <= 50, we skip the while loop and just push target
    expect(plan[plan.length - 1]!.limit).toBe(30);
  });

  it("reaches exactly 500 in expected range", () => {
    const plan = generateWarmingPlan(500);
    const lastDay = plan[plan.length - 1]!.day;
    // Should take roughly 7-9 days to hit 500
    expect(lastDay).toBeGreaterThanOrEqual(5);
    expect(lastDay).toBeLessThanOrEqual(15);
  });
});

// The ramp is anchored on the UTC calendar date, matching warmingLimit() in
// src/server/self-hosted/store.ts (the code that actually enforces the cap) and
// the UTC day window getTodaySentCountsByDomain counts over. A local-midnight
// anchor put the client a day ahead of the server at every non-zero UTC offset.
describe("warmingDayIndex", () => {
  it("is day 1 on the start date and advances one per UTC day", () => {
    expect(warmingDayIndex(utcDaysAgo(0))).toBe(1);
    expect(warmingDayIndex(utcDaysAgo(1))).toBe(2);
    expect(warmingDayIndex(utcDaysAgo(29))).toBe(30);
  });

  it("is <= 0 before the start date", () => {
    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 3);
    expect(warmingDayIndex(future.toISOString().slice(0, 10))).toBe(-2);
  });

  it("does not depend on the process timezone", () => {
    // Fixed `now`, fixed start: the answer is a UTC calendar difference, so it
    // must be identical whatever TZ the runner is in.
    const now = new Date("2026-07-26T02:30:00.000Z");
    expect(warmingDayIndex("2026-07-20", now)).toBe(7);
    expect(warmingDayIndex("2026-07-26", now)).toBe(1);
    expect(warmingDayIndex("2026-07-26T23:59:59.000Z", now)).toBe(1);
  });

  it("returns null for a missing or unparseable start date", () => {
    expect(warmingDayIndex("")).toBeNull();
    expect(warmingDayIndex("not-a-date")).toBeNull();
  });
});

// PURE: getTodayLimit only reads the schedule + generateWarmingPlan.
describe("getTodayLimit", () => {
  function makeSchedule(overrides: Partial<WarmingSchedule> = {}): WarmingSchedule {
    const today = new Date().toISOString().slice(0, 10);
    return {
      id: "test-id",
      domain: "example.com",
      provider_id: null,
      target_daily_volume: 1000,
      start_date: today,
      status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it("returns 50 on day 1 (today = start_date)", () => {
    const schedule = makeSchedule({ target_daily_volume: 10000 });
    const limit = getTodayLimit(schedule);
    expect(limit).toBe(50);
  });

  it("returns null for paused schedule", () => {
    const schedule = makeSchedule({ status: "paused" });
    expect(getTodayLimit(schedule)).toBeNull();
  });

  it("returns null for completed schedule", () => {
    const schedule = makeSchedule({ status: "completed" });
    expect(getTodayLimit(schedule)).toBeNull();
  });

  it("returns target volume after plan completes", () => {
    // Start date far in the past — well past all warming days
    const schedule = makeSchedule({
      start_date: "2020-01-01",
      target_daily_volume: 200,
    });
    const limit = getTodayLimit(schedule);
    expect(limit).toBe(200);
  });

  it("returns 0 when start date is in the future", () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 5);
    const schedule = makeSchedule({ start_date: futureDate.toISOString().slice(0, 10) });
    const limit = getTodayLimit(schedule);
    expect(limit).toBe(0);
  });

  it("day 5 limit is 200 for large target", () => {
    // Build a schedule that started 4 days ago (so today = day 5)
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 4);
    const schedule = makeSchedule({
      start_date: startDate.toISOString().slice(0, 10),
      target_daily_volume: 100000,
    });
    const limit = getTodayLimit(schedule);
    expect(limit).toBe(200);
  });
});

// /v1 READ: getTodaySentCount reads today's outbound messages over /v1 and counts
// those whose From domain matches. The source uses a bare `from@domain` split, so
// this exercises the real domain-matching path with bare sender addresses.
describe("getTodaySentCount", () => {
  it("counts today's outbound rows by sender domain", async () => {
    const nowIso = new Date().toISOString();
    await stub.seed({
      messages: [
        { id: "warm-1", direction: "outbound", from_addr: "sender@warm.test", to_addrs: ["client@example.com"], subject: "warm sent", status: "sent", received_at: nowIso, created_at: nowIso },
        { id: "warm-2", direction: "outbound", from_addr: "ops@warm.test", to_addrs: ["client@example.com"], subject: "warm sent 2", status: "sent", received_at: nowIso, created_at: nowIso },
        { id: "other-1", direction: "outbound", from_addr: "sender@other.test", to_addrs: ["client@example.com"], subject: "other sent", status: "sent", received_at: nowIso, created_at: nowIso },
      ],
    });

    expect(getTodaySentCount("warm.test")).toBe(2);
    expect(getTodaySentCount("other.test")).toBe(1);
    expect(getTodaySentCount("nobody.test")).toBe(0);
  });

  it("excludes rows sent outside today's UTC window", async () => {
    const nowIso = new Date().toISOString();
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    await stub.seed({
      messages: [
        { id: "today", direction: "outbound", from_addr: "sender@warm.test", to_addrs: ["client@example.com"], subject: "today", status: "sent", received_at: nowIso, created_at: nowIso },
        { id: "old", direction: "outbound", from_addr: "sender@warm.test", to_addrs: ["client@example.com"], subject: "old", status: "sent", received_at: yesterday, created_at: yesterday },
      ],
    });

    expect(getTodaySentCount("warm.test")).toBe(1);
  });

  it("counts many domains in one ledger read, zeros included", async () => {
    const nowIso = new Date().toISOString();
    await stub.seed({
      messages: [
        { id: "b-1", direction: "outbound", from_addr: "a@one.test", to_addrs: ["c@example.com"], subject: "s", status: "sent", received_at: nowIso, created_at: nowIso },
        { id: "b-2", direction: "outbound", from_addr: "b@one.test", to_addrs: ["c@example.com"], subject: "s", status: "sent", received_at: nowIso, created_at: nowIso },
        { id: "b-3", direction: "outbound", from_addr: "c@two.test", to_addrs: ["c@example.com"], subject: "s", status: "sent", received_at: nowIso, created_at: nowIso },
        { id: "b-4", direction: "outbound", from_addr: "d@unlisted.test", to_addrs: ["c@example.com"], subject: "s", status: "sent", received_at: nowIso, created_at: nowIso },
      ],
    });

    const counts = getTodaySentCountsByDomain(["one.test", "TWO.test", "quiet.test"]);
    expect(counts.get("one.test")).toBe(2);
    expect(counts.get("two.test")).toBe(1);
    expect(counts.get("quiet.test")).toBe(0);
    // Domains that were not asked about are not invented.
    expect(counts.has("unlisted.test")).toBe(false);
    expect([...counts.keys()].sort()).toEqual(["one.test", "quiet.test", "two.test"]);
  });

  it("returns an empty map without reading anything for an empty domain list", () => {
    expect(getTodaySentCountsByDomain([]).size).toBe(0);
    expect(getTodaySentCountsByDomain(["", "   "]).size).toBe(0);
  });
});

// describeWarmingProgress is the single ramp-position calculation shared by the
// CLI (`emails domain warm*`), the MCP warming tools, and formatWarmingStatus, so
// all three report identical day/limit/sent numbers.
describe("describeWarmingProgress", () => {
  function makeSchedule(overrides: Partial<WarmingSchedule> = {}): WarmingSchedule {
    return {
      id: "progress-id",
      domain: "progress.test",
      provider_id: null,
      target_daily_volume: 5000,
      start_date: new Date().toISOString().slice(0, 10),
      status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it("reports day 1 on the start date", () => {
    const plan = generateWarmingPlan(5000);
    const progress = describeWarmingProgress(makeSchedule());
    expect(progress.current_day).toBe(1);
    expect(progress.total_days).toBe(plan[plan.length - 1]!.day);
    expect(progress.today_limit).toBe(50);
    expect(progress.today_sent).toBe(0);
    expect(progress.progress_percent).toBe(Math.round((1 / progress.total_days) * 100));
  });

  it("advances current_day with elapsed days and agrees with getTodayLimit", () => {
    const schedule = makeSchedule({ start_date: utcDaysAgo(6) });
    const progress = describeWarmingProgress(schedule);
    expect(progress.current_day).toBe(7);
    expect(progress.today_limit).toBe(getTodayLimit(schedule));
    expect(progress.today_limit).toBe(400);
  });

  it("accepts a precomputed sent count instead of re-reading the ledger", () => {
    expect(describeWarmingProgress(makeSchedule(), 17).today_sent).toBe(17);
  });

  it("reports day 1 with a zero limit for an unusable start date", () => {
    // Reachable in self-hosted mode: the Postgres schema relaxed start_date to
    // nullable and the /v1 client coerces null to "". NaN must not reach output,
    // and an unknown start must not read as "full volume allowed".
    for (const start_date of ["", "not-a-date"]) {
      const progress = describeWarmingProgress(makeSchedule({ start_date }));
      expect(progress.current_day).toBe(1);
      expect(Number.isFinite(progress.progress_percent)).toBe(true);
      expect(progress.today_limit).toBe(0);
    }
  });

  it("caps progress_percent at 100 once the ramp is behind schedule", () => {
    const progress = describeWarmingProgress(makeSchedule({ start_date: "2020-01-01" }));
    expect(progress.progress_percent).toBe(100);
    expect(progress.today_limit).toBe(5000);
  });

  it("reports no limit for paused and completed schedules", () => {
    expect(describeWarmingProgress(makeSchedule({ status: "paused" })).today_limit).toBeNull();
    expect(describeWarmingProgress(makeSchedule({ status: "completed" })).today_limit).toBeNull();
  });

  it("counts today's sent mail for the schedule's own domain", async () => {
    const nowIso = new Date().toISOString();
    await stub.seed({
      messages: [
        { id: "p-1", direction: "outbound", from_addr: "a@progress.test", to_addrs: ["c@example.com"], subject: "s", status: "sent", received_at: nowIso, created_at: nowIso },
        { id: "p-2", direction: "outbound", from_addr: "b@other.test", to_addrs: ["c@example.com"], subject: "s", status: "sent", received_at: nowIso, created_at: nowIso },
      ],
    });
    expect(describeWarmingProgress(makeSchedule()).today_sent).toBe(1);
  });
});

// formatWarmingStatus composes pure formatting with getTodaySentCount (a /v1 read).
// With an empty store the sent count is 0; the assertions here only concern the
// schedule fields, which are formatted purely.
describe("formatWarmingStatus", () => {
  it("includes domain name in output", () => {
    const today = new Date().toISOString().slice(0, 10);
    const schedule: WarmingSchedule = {
      id: "test",
      domain: "mysite.com",
      provider_id: null,
      target_daily_volume: 1000,
      start_date: today,
      status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const output = formatWarmingStatus(schedule);
    expect(output).toContain("mysite.com");
    expect(output).toContain("active");
    expect(output).toContain("1000");
  });

  it("shows paused status", () => {
    const today = new Date().toISOString().slice(0, 10);
    const schedule: WarmingSchedule = {
      id: "test2",
      domain: "paused.com",
      provider_id: null,
      target_daily_volume: 500,
      start_date: today,
      status: "paused",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const output = formatWarmingStatus(schedule);
    expect(output).toContain("paused");
  });

  it("renders a caller-supplied progress snapshot without re-reading sent mail", () => {
    const schedule: WarmingSchedule = {
      id: "test3",
      domain: "precomputed.com",
      provider_id: null,
      target_daily_volume: 800,
      start_date: "2026-01-01",
      status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const output = formatWarmingStatus(schedule, {
      current_day: 4,
      total_days: 10,
      progress_percent: 40,
      today_limit: 100,
      today_sent: 37,
    });
    expect(output).toContain("Day 4/10 (40% complete)");
    expect(output).toContain("Today's limit: 100 | Sent today: 37");
  });
});
