import { describe, it, expect } from "bun:test";
import { formatAnalytics } from "./analytics.js";
import { getAnalytics } from "./analytics.remote.js";

// The self-hosted client is server-side for aggregation: getAnalytics joins the
// delivery `events` table, which has no /v1 representation. It is now a loud
// stub. Only the pure formatter still runs locally.
describe("getAnalytics (self-hosted stub)", () => {
  it("throws because analytics run on the self-hosted server", () => {
    expect(() => getAnalytics("provider-1", "30d")).toThrow(
      /getAnalytics is not available in the self-hosted client/,
    );
  });

  it("throws regardless of provider filter", () => {
    expect(() => getAnalytics()).toThrow(/self-hosted server/);
  });
});

describe("formatAnalytics", () => {
  it("formats empty data without errors", () => {
    const data = {
      dailyVolume: [],
      topRecipients: [],
      busiestHours: [],
      deliveryTrend: [],
    };
    const out = formatAnalytics(data);
    expect(out).toContain("Daily Send Volume");
    expect(out).toContain("Top Recipients");
    expect(out).toContain("Busiest Hours");
    expect(out).toContain("Delivery Trend");
    expect(out).toContain("No data");
  });

  it("formats data with values", () => {
    const data = {
      dailyVolume: [{ date: "2025-01-15", count: 10 }],
      topRecipients: [{ email: "user@test.com", count: 5 }],
      busiestHours: [{ hour: 14, count: 8 }],
      deliveryTrend: [{ date: "2025-01-15", sent: 10, delivered: 9, bounced: 1 }],
    };
    const out = formatAnalytics(data);
    expect(out).toContain("2025-01-15");
    expect(out).toContain("user@test.com");
    expect(out).toContain("5 emails");
    expect(out).toContain("14:00");
    expect(out).toContain("sent:10");
    expect(out).toContain("delivered:9");
    expect(out).toContain("bounced:1");
    expect(out).toContain("90.0%");
  });

  it("shows last 14 days of volume only", () => {
    const days = [];
    for (let i = 0; i < 20; i++) {
      days.push({ date: `2025-01-${String(i + 1).padStart(2, "0")}`, count: i + 1 });
    }
    const data = {
      dailyVolume: days,
      topRecipients: [],
      busiestHours: [],
      deliveryTrend: [],
    };
    const out = formatAnalytics(data);
    // Should contain last 14 days (7-20) but not day 1-6
    expect(out).toContain("2025-01-20");
    expect(out).toContain("2025-01-07");
    expect(out).not.toContain("2025-01-06");
  });

  it("shows last 7 days of delivery trend only", () => {
    const trend = [];
    for (let i = 0; i < 10; i++) {
      trend.push({ date: `2025-01-${String(i + 1).padStart(2, "0")}`, sent: 10, delivered: 9, bounced: 1 });
    }
    const data = {
      dailyVolume: [],
      topRecipients: [],
      busiestHours: [],
      deliveryTrend: trend,
    };
    const out = formatAnalytics(data);
    expect(out).toContain("2025-01-10");
    expect(out).toContain("2025-01-04");
    expect(out).not.toContain("2025-01-03");
  });
});
