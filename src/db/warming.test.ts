// Self-hosted-ONLY: the warming repo routes every read/write to the /v1
// `warming` resource. Exercises the REAL synchronous curl transport against an
// out-of-process /v1 stub (see src/test-support/v1-stub.ts for why it must run
// in a separate process).
//
// Migrated from the deleted local-SQLite pattern. One former test is dropped:
//   - "domain is unique — duplicate throws": was a SQLite UNIQUE(domain)
//     constraint; domain uniqueness is now enforced server-side by /v1, not by
//     the client (a second POST simply succeeds against the generic store).
// Ordering that the old test forced with `UPDATE ... SET created_at` is now
// established by seeding explicit created_at values.

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  createWarmingSchedule,
  getWarmingSchedule,
  listWarmingSchedules,
  updateWarmingStatus,
  deleteWarmingSchedule,
} from "./warming.js";

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

describe("warming CRUD", () => {
  it("creates a warming schedule", () => {
    const schedule = createWarmingSchedule({ domain: "example-warm-create.com", target_daily_volume: 1000 });
    expect(schedule.domain).toBe("example-warm-create.com");
    expect(schedule.target_daily_volume).toBe(1000);
    expect(schedule.status).toBe("active");
    expect(schedule.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(schedule.id).toBeTruthy();
  });

  it("creates a warming schedule with custom start_date", () => {
    const schedule = createWarmingSchedule({ domain: "custom.com", target_daily_volume: 500, start_date: "2025-01-01" });
    expect(schedule.start_date).toBe("2025-01-01");
  });

  it("getWarmingSchedule returns null for unknown domain", () => {
    expect(getWarmingSchedule("notfound.com")).toBeNull();
  });

  it("getWarmingSchedule retrieves by domain", () => {
    createWarmingSchedule({ domain: "get-test.com", target_daily_volume: 200 });
    const result = getWarmingSchedule("get-test.com");
    expect(result).not.toBeNull();
    expect(result!.domain).toBe("get-test.com");
  });

  it("listWarmingSchedules returns all", () => {
    createWarmingSchedule({ domain: "a.com", target_daily_volume: 100 });
    createWarmingSchedule({ domain: "b.com", target_daily_volume: 200 });
    const domains = listWarmingSchedules().map((s) => s.domain);
    expect(domains).toContain("a.com");
    expect(domains).toContain("b.com");
  });

  it("listWarmingSchedules filters by status", () => {
    createWarmingSchedule({ domain: "active1.com", target_daily_volume: 100 });
    createWarmingSchedule({ domain: "paused1.com", target_daily_volume: 100 });
    updateWarmingStatus("paused1.com", "paused");

    const active = listWarmingSchedules("active");
    const paused = listWarmingSchedules("paused");

    expect(active.every((s) => s.status === "active")).toBe(true);
    expect(paused.every((s) => s.status === "paused")).toBe(true);
    expect(active.some((s) => s.domain === "active1.com")).toBe(true);
    expect(paused.some((s) => s.domain === "paused1.com")).toBe(true);
  });

  it("listWarmingSchedules paginates after status filtering", async () => {
    // Seed explicit created_at so the newest-first ordering is deterministic.
    await stub.seed({
      warming: Array.from({ length: 4 }, (_v, i) => ({
        id: `warm-${i + 1}`,
        domain: `warm-${i + 1}.example.com`,
        provider_id: null,
        target_daily_volume: 100,
        start_date: "2026-01-01",
        status: "active",
        created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        updated_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      })),
    });
    updateWarmingStatus("warm-4.example.com", "paused");

    const page = listWarmingSchedules("active", { limit: 2, offset: 1 });

    expect(page.map((schedule) => schedule.domain)).toEqual([
      "warm-2.example.com",
      "warm-1.example.com",
    ]);
  });

  it("updateWarmingStatus changes status", () => {
    createWarmingSchedule({ domain: "status-test.com", target_daily_volume: 300 });
    const paused = updateWarmingStatus("status-test.com", "paused");
    expect(paused).not.toBeNull();
    expect(paused!.status).toBe("paused");

    const completed = updateWarmingStatus("status-test.com", "completed");
    expect(completed!.status).toBe("completed");
  });

  it("updateWarmingStatus returns null for unknown domain", () => {
    expect(updateWarmingStatus("ghost.com", "paused")).toBeNull();
  });

  it("deleteWarmingSchedule removes the schedule", () => {
    createWarmingSchedule({ domain: "del.com", target_daily_volume: 100 });
    expect(deleteWarmingSchedule("del.com")).toBe(true);
    expect(getWarmingSchedule("del.com")).toBeNull();
  });

  it("deleteWarmingSchedule returns false for unknown domain", () => {
    expect(deleteWarmingSchedule("ghost.com")).toBe(false);
  });
});
