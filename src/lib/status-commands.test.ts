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
  SELF_HOSTED_REFUSED_COMMANDS,
} from "./status-commands.js";

describe("mode-aware command availability", () => {
  it("rejects the commands that refuse in self_hosted", () => {
    expect(isCommandAvailableInMode("emails doctor --json", "self_hosted")).toBe(false);
    expect(isCommandAvailableInMode("emails provision status", "self_hosted")).toBe(false);
    expect(isCommandAvailableInMode("emails inbox watch --all-buckets", "self_hosted")).toBe(false);
    expect(isCommandAvailableInMode("emails refresh", "self_hosted")).toBe(false);
  });

  it("keeps the same commands in local mode", () => {
    for (const command of ["emails doctor --json", "emails provision status", "emails refresh"]) {
      expect(isCommandAvailableInMode(command, "local")).toBe(true);
    }
  });

  it("matches on a word boundary, not a bare string prefix", () => {
    // `emails provision` must not swallow a hypothetical sibling command.
    expect(isCommandAvailableInMode("emails provisioning-report", "self_hosted")).toBe(true);
    expect(isCommandAvailableInMode("emails provision", "self_hosted")).toBe(false);
  });

  it("filters a suggestion list while preserving order", () => {
    const filtered = keepAvailableCommands(
      ["emails status --json", "emails doctor --json", "emails provider list --json"],
      "self_hosted",
    );
    expect(filtered).toEqual(["emails status --json", "emails provider list --json"]);
  });

  it("keeps both registries non-empty and namespaced to this CLI", () => {
    expect(SELF_HOSTED_REFUSED_COMMANDS.length).toBeGreaterThan(0);
    expect(LOCAL_REFUSED_COMMANDS.length).toBeGreaterThan(0);
    for (const command of [...SELF_HOSTED_REFUSED_COMMANDS, ...LOCAL_REFUSED_COMMANDS]) {
      expect(command.startsWith("emails ")).toBe(true);
    }
  });
});
