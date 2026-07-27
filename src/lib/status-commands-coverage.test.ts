// CLASS-LEVEL guard: the refusal registry is checked against the CLI, not itself.
//
// THE DEFECT THIS GUARDS. src/lib/status-commands.ts documented its source of
// truth as `grep -n 'serverOnly(' src/cli/commands/*.remote.ts`. That glob is
// wrong twice over: `serverOnly()` is also defined and called in the SHARED
// modules src/cli/commands/domain.ts and src/cli/commands/address.ts, and their
// helper throws UNCONDITIONALLY — there is no mode in which those commands run.
// Fifteen refusals were missing from the registry, so `emails status` against a
// server holding a failed domain emitted
//
//   next_actions[0].command = "emails domain status --json"
//
// (src/lib/status-facts.remote.ts domainFixCommands -> agent-context.ts
// buildNextActions), and `isCommandAvailableInMode` waved it through. Running it
// throws "emails domain status is not available in the self-hosted client" — the
// exact "remedy that refuses" defect the registry was introduced to remove.
//
// WHY THE EXISTING TESTS COULD NOT CATCH IT. agent-context.local.test.ts asserted
// `isCommandAvailableInMode(action.command, "local") === true` — the payload
// validated against the same registry that filtered it, so a command missing from
// the registry passes while it throws. A guard whose oracle is the thing under
// test proves nothing. This file's oracle is the CLI source.
//
// Precedent for source-scanning tests here: src/lib/status-fabrication-scan.test.ts,
// src/server/self-hosted/list-order.test.ts, src/no-cloud-boundary.test.ts.

import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  NEVER_AVAILABLE_COMMANDS,
  SELF_HOSTED_REFUSED_COMMANDS,
  isCommandAvailableInMode,
} from "./status-commands.js";

const COMMANDS_DIR = join(import.meta.dir, "..", "cli", "commands");

/** `serverOnly("emails x y")` / `notImplementedAnywhere("emails x y")`. */
const REFUSAL_CALL = /(?:serverOnly|notImplementedAnywhere)\(\s*"([^"]+)"\s*\)/g;

interface Refusal {
  command: string;
  file: string;
  /** true when the module ships in BOTH modes, so the refusal is unconditional. */
  shared: boolean;
}

function scanRefusals(): Refusal[] {
  const found: Refusal[] = [];
  for (const entry of readdirSync(COMMANDS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    const text = readFileSync(join(COMMANDS_DIR, entry.name), "utf8");
    // Only count call sites, not the `function serverOnly(command: string)`
    // definitions — those take an identifier, never a string literal.
    for (const match of text.matchAll(REFUSAL_CALL)) {
      const command = match[1];
      if (!command || !command.startsWith("emails ")) continue;
      found.push({
        command,
        file: entry.name,
        shared: !entry.name.endsWith(".remote.ts") && !entry.name.endsWith(".local.ts"),
      });
    }
  }
  return found;
}

function covered(command: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => command === prefix || command.startsWith(`${prefix} `));
}

describe("refusal registry covers every CLI refusal call site", () => {
  const refusals = scanRefusals();

  // POSITIVE CONTROL. If the regex, the directory or the exclusion rules ever
  // stop matching, every assertion below would pass over an empty set. Both the
  // shared and the self-hosted-only partitions must be non-empty, and the scan
  // must see the two helpers by name.
  it("finds a non-empty, correctly partitioned set of refusals", () => {
    expect(refusals.length).toBeGreaterThan(20);
    expect(refusals.filter((r) => r.shared).length).toBeGreaterThan(10);
    expect(refusals.filter((r) => !r.shared).length).toBeGreaterThan(10);
    expect(new Set(refusals.map((r) => r.file))).toContain("domain.ts");
    expect(new Set(refusals.map((r) => r.file))).toContain("address.ts");
    expect(new Set(refusals.map((r) => r.file))).toContain("provision.ts");
  });

  // The regression, named. These are the call sites the `*.remote.ts` glob missed.
  it("sees the shared-module refusals the original grep could not", () => {
    const shared = refusals.filter((r) => r.shared).map((r) => r.command);
    expect(shared).toContain("emails domain status");
    expect(shared).toContain("emails domain check");
    expect(shared).toContain("emails domain verify");
    expect(shared).toContain("emails address provision");
  });

  it("registers every unconditional refusal in NEVER_AVAILABLE_COMMANDS", () => {
    const missing = refusals
      .filter((r) => r.shared && !covered(r.command, NEVER_AVAILABLE_COMMANDS))
      .map((r) => `${r.file}: ${r.command}`);
    expect(missing, "these commands throw in EVERY mode but the registry does not "
      + "know, so status/next_actions/fix_commands can still propose them — add a "
      + "prefix to NEVER_AVAILABLE_COMMANDS:\n" + missing.join("\n")).toEqual([]);
  });

  it("registers every self-hosted-only refusal in SELF_HOSTED_REFUSED_COMMANDS", () => {
    const missing = refusals
      .filter((r) => !r.shared)
      .filter((r) => !covered(r.command, SELF_HOSTED_REFUSED_COMMANDS)
        && !covered(r.command, NEVER_AVAILABLE_COMMANDS))
      .map((r) => `${r.file}: ${r.command}`);
    expect(missing, "these commands refuse in self_hosted mode but the registry "
      + "does not know:\n" + missing.join("\n")).toEqual([]);
  });

  // The registry exists to be consulted, so assert the consulted ANSWER, not just
  // list membership: a covered prefix that isCommandAvailableInMode disagrees with
  // would be a silent hole.
  it("answers `unavailable` for every scanned refusal, in the mode that refuses", () => {
    const wrong: string[] = [];
    for (const refusal of refusals) {
      if (refusal.shared) {
        for (const mode of ["local", "self_hosted"] as const) {
          if (isCommandAvailableInMode(refusal.command, mode)) {
            wrong.push(`${refusal.command} reported available in ${mode} (${refusal.file})`);
          }
        }
      } else if (isCommandAvailableInMode(refusal.command, "self_hosted")) {
        wrong.push(`${refusal.command} reported available in self_hosted (${refusal.file})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  // Counter-control: the registry must not refuse the commands the payload leans
  // on as remedies, or "never propose a refusal" would be satisfied by proposing
  // nothing at all.
  it("still reports the real remedies as available in both modes", () => {
    for (const command of [
      "emails domain list --json",
      "emails address list --json",
      "emails address add ops@example.com --provider p1",
      "emails provider list --json",
      "emails status --json",
      "emails inbox sync-status --json",
    ]) {
      expect(isCommandAvailableInMode(command, "local"), command).toBe(true);
      expect(isCommandAvailableInMode(command, "self_hosted"), command).toBe(true);
    }
  });
});
