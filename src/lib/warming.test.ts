import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { generateWarmingPlan, getTodayLimit, formatWarmingStatus, getTodaySentCount } from "./warming.js";
import type { WarmingSchedule } from "./warming.js";

// getTodaySentCount / formatWarmingStatus read the outbound sent-ledger over the
// /v1 messages store, so a configured self-hosted endpoint is required even when
// no rows are seeded. generateWarmingPlan and getTodayLimit are pure and do not
// need it, but sharing the stub scaffolding keeps the file uniform.
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
});
