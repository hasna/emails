import { describe, it, expect } from "bun:test";
import { generateBashCompletion, generateZshCompletion, generateFishCompletion } from "./completion.js";

describe("generateBashCompletion", () => {
  it("returns a non-empty string", () => {
    const result = generateBashCompletion();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(100);
  });

  it("contains the emails command", () => {
    const result = generateBashCompletion();
    expect(result).toContain("emails");
  });

  it("contains bash shebang / completion function", () => {
    const result = generateBashCompletion();
    expect(result).toContain("_emails_completion");
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
    expect(result).toContain("emails");
  });

  it("contains core command names", () => {
    const result = generateFishCompletion();
    expect(result).toContain("provider");
    expect(result).toContain("domain");
    expect(result).toContain("forwarding");
    expect(result).toContain("send");
  });
});

// ─── TRUTHFULNESS: the scripts must suggest the CLI that exists ────────────────
//
// The hand-maintained lists had rotted both ways (task 78653c1c item 1): they
// suggested `config` — which the router refuses as unknown — and omitted whole
// real command groups. Top-level suggestions are now derived from the router's
// own dispatch set; these tests pin that derivation.

import { knownCommandNames } from "../cli/router.js";

describe("completion scripts match the router's dispatch set", () => {
  const scripts: Array<[string, string]> = [
    ["bash", generateBashCompletion()],
    ["zsh", generateZshCompletion()],
    ["fish", generateFishCompletion()],
  ];

  for (const [shell, script] of scripts) {
    it(`${shell}: suggests no removed command`, () => {
      // `config` was removed from the CLI; suggesting it completes to an
      // unknown-command error.
      expect(script).not.toMatch(/[ '"]config[ '")]/);
    });

    it(`${shell}: carries the real command groups the old list omitted`, () => {
      for (const command of ["inbox", "owner", "alias", "sendkey", "auth", "db", "whoami", "sequence", "status"]) {
        expect(script, `${shell} completion omits '${command}'`).toContain(command);
      }
    });
  }

  it("bash: every top-level suggestion is a command the router dispatches", () => {
    const script = generateBashCompletion();
    const commands = /commands="([^"]+)"/.exec(script)?.[1]?.split(" ") ?? [];
    expect(commands.length).toBeGreaterThan(30);
    for (const command of commands) {
      expect(knownCommandNames.has(command), `'${command}' is suggested but not dispatchable`).toBe(true);
    }
    // And the derivation is complete, not a hand-copied subset.
    for (const command of knownCommandNames) {
      expect(commands, `dispatchable '${command}' is missing from completion`).toContain(command);
    }
  });
});
