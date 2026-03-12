import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { createEvent } from "../db/events.js";
import { getLocalStats, formatStatsTable } from "./stats.js";

let providerId: string;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const p = createProvider({ name: "Test", type: "resend" });
  providerId = p.id;
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("getLocalStats", () => {
  it("returns zero stats for no events", () => {
    const stats = getLocalStats(providerId, "30d");
    expect(stats.sent).toBe(0);
    expect(stats.delivered).toBe(0);
    expect(stats.bounced).toBe(0);
    expect(stats.delivery_rate).toBe(0);
    expect(stats.bounce_rate).toBe(0);
    expect(stats.open_rate).toBe(0);
    expect(stats.provider_id).toBe(providerId);
    expect(stats.period).toBe("30d");
  });

  it("counts events correctly", () => {
    const ts = new Date().toISOString();
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: ts });
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: ts });
    createEvent({ provider_id: providerId, type: "bounced", occurred_at: ts });
    createEvent({ provider_id: providerId, type: "opened", occurred_at: ts });
    createEvent({ provider_id: providerId, type: "clicked", occurred_at: ts });
    createEvent({ provider_id: providerId, type: "complained", occurred_at: ts });

    const stats = getLocalStats(providerId, "30d");
    expect(stats.delivered).toBe(2);
    expect(stats.bounced).toBe(1);
    expect(stats.opened).toBe(1);
    expect(stats.clicked).toBe(1);
    expect(stats.complained).toBe(1);
  });

  it("computes delivery rate correctly", () => {
    const ts = new Date().toISOString();
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: ts });
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: ts });
    createEvent({ provider_id: providerId, type: "bounced", occurred_at: ts });

    const stats = getLocalStats(providerId, "30d");
    // 2 delivered out of 3 total = 66.7%
    expect(stats.delivery_rate).toBeCloseTo(66.7, 0);
    // 1 bounced out of 3 = 33.3%
    expect(stats.bounce_rate).toBeCloseTo(33.3, 0);
  });

  it("computes open rate as opened/delivered", () => {
    const ts = new Date().toISOString();
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: ts });
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: ts });
    createEvent({ provider_id: providerId, type: "opened", occurred_at: ts });

    const stats = getLocalStats(providerId, "30d");
    // 1 opened out of 2 delivered = 50%
    expect(stats.open_rate).toBeCloseTo(50, 0);
  });

  it("works without provider filter (all providers)", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    const ts = new Date().toISOString();
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: ts });
    createEvent({ provider_id: p2.id, type: "delivered", occurred_at: ts });

    const stats = getLocalStats(undefined, "30d");
    expect(stats.delivered).toBe(2);
    expect(stats.provider_id).toBe("all");
  });

  it("excludes events outside the period", () => {
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: old });
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: recent });

    const stats = getLocalStats(providerId, "30d");
    expect(stats.delivered).toBe(1); // only recent one
  });
});

describe("formatStatsTable", () => {
  it("formats stats as readable text", () => {
    const stats = {
      provider_id: "test-provider",
      period: "30d",
      sent: 100,
      delivered: 95,
      bounced: 3,
      complained: 1,
      opened: 60,
      clicked: 20,
      delivery_rate: 95.0,
      bounce_rate: 3.0,
      open_rate: 63.2,
    };
    const output = formatStatsTable(stats);
    expect(output).toContain("100");
    expect(output).toContain("95");
    expect(output).toContain("Sent");
    expect(output).toContain("Delivered");
    expect(output).toContain("Bounced");
    expect(output).toContain("30d");
  });
});
