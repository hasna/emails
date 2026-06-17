import { describe, expect, it } from "bun:test";
import { detectEmailLinkSpans, extractEmailLinks, formatEmailLinks } from "./email-links.js";

describe("email link extraction", () => {
  it("extracts and dedupes links from html anchors and bare text", () => {
    const links = extractEmailLinks({
      html: `<p>Open <a href="https://Example.com/path?a=1&amp;b=2">Docs</a></p><p>https://example.com/path?a=1&amp;b=2.</p>`,
    });

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      url: "https://Example.com/path?a=1&b=2",
      normalized_url: "https://example.com/path?a=1&b=2",
      text: "Docs",
      source: "html",
      occurrences: 2,
    });
  });

  it("extracts markdown links and www links from text", () => {
    const links = extractEmailLinks({
      text: "See [invoice](https://billing.example.com/pay) or www.example.com/help.",
    });

    expect(links.map((link) => link.normalized_url)).toEqual([
      "https://billing.example.com/pay",
      "https://www.example.com/help",
    ]);
    expect(links[0]?.text).toBe("invoice");
  });

  it("does not double-count markdown links while scanning bare text", () => {
    const links = extractEmailLinks({
      text: "See [Docs](https://example.com/path) and then https://example.com/path",
    });

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      normalized_url: "https://example.com/path",
      text: "Docs",
      occurrences: 2,
    });
  });

  it("handles balanced parentheses in markdown URLs", () => {
    const links = extractEmailLinks({
      text: "Read [spec](https://example.com/a_(b)) now.",
    });

    expect(links.map((link) => link.normalized_url)).toEqual(["https://example.com/a_(b)"]);
    expect(links[0]?.text).toBe("spec");
  });

  it("rejects unsafe protocols by default", () => {
    const links = extractEmailLinks({
      html: `<a href="javascript:alert(1)">bad</a><a href="mailto:ops@example.com">mail</a><a href="https://safe.example">safe</a>`,
    });

    expect(links.map((link) => link.normalized_url)).toEqual(["https://safe.example/"]);
  });

  it("can include mailto and tel links explicitly", () => {
    const links = extractEmailLinks({
      text: "mailto:ops@example.com tel:+15551234567 https://example.com",
      includeNonWeb: true,
    });

    expect(links.map((link) => link.normalized_url)).toEqual([
      "mailto:ops@example.com",
      "tel:+15551234567",
      "https://example.com/",
    ]);
  });

  it("keeps malformed numeric HTML entities from crashing extraction", () => {
    const links = extractEmailLinks({
      html: `<a href="https://example.com?a=&#99999999999;">Bad entity</a>`,
    });

    expect(links).toHaveLength(1);
    expect(links[0]?.normalized_url).toContain("https://example.com/");
  });

  it("formats extracted links for CLI output", () => {
    const text = formatEmailLinks(extractEmailLinks({ text: "[Docs](https://example.com)" }));

    expect(text).toContain("Links (1)");
    expect(text).toContain("1. https://example.com");
    expect(text).toContain("text: Docs");
  });

  it("detects exact visible link spans for clickable TUI rendering", () => {
    const text = "Open www.example.com/help, mailto:ops@example.com and https://Example.com/path.";
    const links = detectEmailLinkSpans(text, { includeNonWeb: true });

    expect(links.map((link) => text.slice(link.start, link.end))).toEqual([
      "www.example.com/help",
      "mailto:ops@example.com",
      "https://Example.com/path",
    ]);
    expect(links.map((link) => link.url)).toEqual([
      "https://www.example.com/help",
      "mailto:ops@example.com",
      "https://Example.com/path",
    ]);
  });
});
