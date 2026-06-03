import { describe, it, expect } from "bun:test";
import { truncate, pad, bareAddress, senderName, relativeTime, wrapText } from "./format.js";

describe("format helpers", () => {
  it("truncates and pads", () => {
    expect(truncate("hello world", 5)).toBe("hell…");
    expect(truncate("hi", 5)).toBe("hi");
    expect(pad("hi", 5)).toBe("hi   ");
  });

  it("extracts bare address and sender name", () => {
    expect(bareAddress("Andrei <a@x.com>")).toBe("a@x.com");
    expect(bareAddress("a@x.com")).toBe("a@x.com");
    expect(senderName('"Andrei Hasna" <a@x.com>')).toBe("Andrei Hasna");
    expect(senderName("Andrei <a@x.com>")).toBe("Andrei");
    expect(senderName("a@x.com")).toBe("a@x.com");
  });

  it("formats relative time", () => {
    const now = new Date("2026-06-03T12:00:00Z").getTime();
    expect(relativeTime("2026-06-03T11:59:30Z", now)).toBe("30s");
    expect(relativeTime("2026-06-03T11:55:00Z", now)).toBe("5m");
    expect(relativeTime("2026-06-03T09:00:00Z", now)).toBe("3h");
    expect(relativeTime("2026-06-01T12:00:00Z", now)).toBe("2d");
    expect(relativeTime("2026-05-01T12:00:00Z", now)).toBe("2026-05-01");
    expect(relativeTime(null, now)).toBe("—");
  });

  it("wraps text to width and max lines", () => {
    const lines = wrapText("the quick brown fox jumps over", 10, 5);
    expect(lines.every((l) => l.length <= 10)).toBe(true);
    expect(lines.join(" ")).toContain("quick");
    expect(wrapText("a\n\nb", 10, 5)).toEqual(["a", "", "b"]);
    expect(wrapText("aaaa bbbb cccc dddd", 4, 2)).toHaveLength(2);
  });
});
