import { describe, expect, it } from "bun:test";
import { injectOpenPixel, injectClickTracking, prepareTrackedHtml } from "./tracking.js";

const BASE_URL = "http://localhost:3900";
const EMAIL_ID = "test-email-123";

describe("injectOpenPixel", () => {
  it("inserts pixel before </body>", () => {
    const html = "<html><body><p>Hello</p></body></html>";
    const result = injectOpenPixel(html, EMAIL_ID, BASE_URL);
    expect(result).toContain(`<img src="${BASE_URL}/track/open/${EMAIL_ID}"`);
    expect(result).toContain("</body>");
    // pixel should appear before </body>
    const pixelPos = result.indexOf(`/track/open/${EMAIL_ID}`);
    const bodyPos = result.indexOf("</body>");
    expect(pixelPos).toBeLessThan(bodyPos);
  });

  it("appends pixel when no </body> tag", () => {
    const html = "<p>No closing body tag</p>";
    const result = injectOpenPixel(html, EMAIL_ID, BASE_URL);
    expect(result).toContain(`<img src="${BASE_URL}/track/open/${EMAIL_ID}"`);
    expect(result.endsWith("/>")).toBe(true);
  });

  it("includes display:none style", () => {
    const result = injectOpenPixel("<body></body>", EMAIL_ID, BASE_URL);
    expect(result).toContain("display:none");
  });

  it("uses correct width and height", () => {
    const result = injectOpenPixel("<body></body>", EMAIL_ID, BASE_URL);
    expect(result).toContain('width="1"');
    expect(result).toContain('height="1"');
  });
});

describe("injectClickTracking", () => {
  it("rewrites http links", () => {
    const html = `<a href="http://example.com">Link</a>`;
    const result = injectClickTracking(html, EMAIL_ID, BASE_URL);
    expect(result).toContain(`${BASE_URL}/track/click/${EMAIL_ID}/`);
    expect(result).not.toContain('href="http://example.com"');
  });

  it("rewrites https links", () => {
    const html = `<a href="https://example.com/path?foo=bar">Link</a>`;
    const result = injectClickTracking(html, EMAIL_ID, BASE_URL);
    expect(result).toContain(`${BASE_URL}/track/click/${EMAIL_ID}/`);
    expect(result).not.toContain('href="https://example.com');
  });

  it("does not rewrite mailto: links", () => {
    const html = `<a href="mailto:user@example.com">Email me</a>`;
    const result = injectClickTracking(html, EMAIL_ID, BASE_URL);
    expect(result).toContain('href="mailto:user@example.com"');
    expect(result).not.toContain("/track/click/");
  });

  it("does not rewrite relative links", () => {
    const html = `<a href="/relative/path">Link</a>`;
    const result = injectClickTracking(html, EMAIL_ID, BASE_URL);
    expect(result).toContain('href="/relative/path"');
    expect(result).not.toContain("/track/click/");
  });

  it("rewrites multiple links in a single HTML string", () => {
    const html = `<a href="https://a.com">A</a><a href="https://b.com">B</a>`;
    const result = injectClickTracking(html, EMAIL_ID, BASE_URL);
    const matches = result.match(/\/track\/click\//g);
    expect(matches).toHaveLength(2);
  });

  it("round-trip: encoded URL can be decoded back to original", () => {
    const originalUrl = "https://example.com/path?foo=bar&baz=qux";
    const html = `<a href="${originalUrl}">Link</a>`;
    const result = injectClickTracking(html, EMAIL_ID, BASE_URL);
    // Extract the encoded part
    const match = result.match(/\/track\/click\/[^/]+\/([^"]+)/);
    expect(match).not.toBeNull();
    const encoded = match![1]!;
    const decoded = Buffer.from(encoded, "base64url").toString("utf-8");
    expect(decoded).toBe(originalUrl);
  });
});

describe("prepareTrackedHtml", () => {
  it("applies both open pixel and click tracking", async () => {
    const html = `<html><body><a href="https://example.com">Link</a></body></html>`;
    const result = await prepareTrackedHtml(html, EMAIL_ID, true, true);
    expect(result).toContain(`/track/open/${EMAIL_ID}`);
    expect(result).toContain(`/track/click/${EMAIL_ID}/`);
  });

  it("applies only open pixel when trackClicks is false", async () => {
    const html = `<html><body><a href="https://example.com">Link</a></body></html>`;
    const result = await prepareTrackedHtml(html, EMAIL_ID, true, false);
    expect(result).toContain(`/track/open/${EMAIL_ID}`);
    expect(result).toContain('href="https://example.com"');
  });

  it("applies only click tracking when trackOpens is false", async () => {
    const html = `<html><body><a href="https://example.com">Link</a></body></html>`;
    const result = await prepareTrackedHtml(html, EMAIL_ID, false, true);
    expect(result).not.toContain(`/track/open/${EMAIL_ID}`);
    expect(result).toContain(`/track/click/${EMAIL_ID}/`);
  });

  it("returns html unchanged when both flags are false", async () => {
    const html = `<html><body><p>Hello</p></body></html>`;
    const result = await prepareTrackedHtml(html, EMAIL_ID, false, false);
    expect(result).toBe(html);
  });
});
