// A suggested remedy is a claim about the system. Suggesting a command that
// refuses is the same defect class as reporting a count that was never measured:
// the payload asserts something untrue. `emails status` used to propose
// `emails provision status` and every JSON error proposed `emails doctor --json`,
// both of which refuse in self_hosted mode.

import { describe, expect, it } from "bun:test";
import {
  isCommandAvailableInMode,
  keepAvailableCommands,
  LOCAL_REFUSED_COMMANDS,
  NEVER_AVAILABLE_COMMANDS,
  SELF_HOSTED_REFUSED_COMMANDS,
} from "./status-commands.js";

describe("mode-aware command availability", () => {
  it("rejects the commands that refuse in self_hosted", () => {
    expect(isCommandAvailableInMode("emails doctor --json", "self_hosted")).toBe(false);
    expect(isCommandAvailableInMode("emails provision status", "self_hosted")).toBe(false);
    expect(isCommandAvailableInMode("emails inbox watch --all-buckets", "self_hosted")).toBe(false);
    expect(isCommandAvailableInMode("emails refresh", "self_hosted")).toBe(false);
  });

  it("keeps the self_hosted-only refusals available in local mode", () => {
    for (const command of ["emails doctor --json", "emails refresh", "emails export events"]) {
      expect(isCommandAvailableInMode(command, "local")).toBe(true);
    }
  });

  // `emails provision *` throws notImplementedAnywhere() in BOTH modes
  // (src/cli/commands/provision.ts). Listing it only under self_hosted left
  // `emails status` proposing it in local mode, where it refuses just as hard.
  it("rejects a never-implemented command in EVERY mode, not just one", () => {
    for (const mode of ["local", "self_hosted"] as const) {
      expect(isCommandAvailableInMode("emails provision", mode)).toBe(false);
      expect(isCommandAvailableInMode("emails provision status", mode)).toBe(false);
      expect(isCommandAvailableInMode("emails provision domain example.com", mode)).toBe(false);
      expect(keepAvailableCommands(["emails provision status", "emails domain list --json"], mode))
        .toEqual(["emails domain list --json"]);
    }
  });

  it("matches on a word boundary, not a bare string prefix", () => {
    // `emails provision` must not swallow a hypothetical sibling command.
    expect(isCommandAvailableInMode("emails provisioning-report", "self_hosted")).toBe(true);
    expect(isCommandAvailableInMode("emails provisioning-report", "local")).toBe(true);
    expect(isCommandAvailableInMode("emails provision", "self_hosted")).toBe(false);
  });

  it("filters a suggestion list while preserving order", () => {
    const filtered = keepAvailableCommands(
      ["emails status --json", "emails doctor --json", "emails provider list --json"],
      "self_hosted",
    );
    expect(filtered).toEqual(["emails status --json", "emails provider list --json"]);
  });

  it("keeps every registry non-empty and namespaced to this CLI", () => {
    expect(NEVER_AVAILABLE_COMMANDS.length).toBeGreaterThan(0);
    expect(SELF_HOSTED_REFUSED_COMMANDS.length).toBeGreaterThan(0);
    expect(LOCAL_REFUSED_COMMANDS.length).toBeGreaterThan(0);
    for (const command of [
      ...NEVER_AVAILABLE_COMMANDS,
      ...SELF_HOSTED_REFUSED_COMMANDS,
      ...LOCAL_REFUSED_COMMANDS,
    ]) {
      expect(command.startsWith("emails ")).toBe(true);
    }
    // A mode-independent refusal must live in ONE registry. Duplicating it into a
    // per-mode list is how it gets "fixed" in one mode and left broken in the other.
    for (const command of NEVER_AVAILABLE_COMMANDS) {
      expect(SELF_HOSTED_REFUSED_COMMANDS).not.toContain(command);
      expect(LOCAL_REFUSED_COMMANDS).not.toContain(command);
    }
  });
});
