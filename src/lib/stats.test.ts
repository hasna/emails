import { describe, it, expect } from "bun:test";
import { getLocalStats, formatStatsTable } from "./stats.js";

// getLocalStats aggregates the delivery `events` table, which has no /v1
// representation in the self-hosted client. It is now a loud stub; only the
// pure table formatter still runs locally.
describe("getLocalStats (self-hosted stub)", () => {
  it("throws because delivery stats run on the self-hosted server", () => {
    expect(() => getLocalStats("provider-1", "30d")).toThrow(
      /getLocalStats is not available in the self-hosted client/,
    );
  });

  it("throws regardless of provider filter", () => {
    expect(() => getLocalStats()).toThrow(/self-hosted server/);
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
