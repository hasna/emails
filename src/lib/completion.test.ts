import { describe, it, expect } from "bun:test";
import { generateBashCompletion, generateZshCompletion, generateFishCompletion } from "./completion.js";

describe("generateBashCompletion", () => {
  it("returns a non-empty string", () => {
    const result = generateBashCompletion();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(100);
  });

  it("contains the mailery command", () => {
    const result = generateBashCompletion();
    expect(result).toContain("mailery");
  });

  it("contains bash shebang / completion function", () => {
    const result = generateBashCompletion();
    expect(result).toContain("_mailery_completion");
  });

  it("contains core command names", () => {
    const result = generateBashCompletion();
    expect(result).toContain("provider");
    expect(result).toContain("domain");
    expect(result).toContain("forwarding");
    expect(result).toContain("send");
  });
});

describe("generateZshCompletion", () => {
  it("returns a non-empty string", () => {
    const result = generateZshCompletion();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(100);
  });

  it("contains zsh-specific syntax", () => {
    const result = generateZshCompletion();
    expect(result).toContain("compdef");
  });

  it("contains core command names", () => {
    const result = generateZshCompletion();
    expect(result).toContain("provider");
    expect(result).toContain("domain");
    expect(result).toContain("forwarding");
  });
});

describe("generateFishCompletion", () => {
  it("returns a non-empty string", () => {
    const result = generateFishCompletion();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(100);
  });

  it("contains fish complete commands", () => {
    const result = generateFishCompletion();
    expect(result).toContain("complete");
    expect(result).toContain("mailery");
  });

  it("contains core command names", () => {
    const result = generateFishCompletion();
    expect(result).toContain("provider");
    expect(result).toContain("domain");
    expect(result).toContain("forwarding");
    expect(result).toContain("send");
  });
});
