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
    // FLOORS ARE 1, NOT 10 — on purpose, and this is a strengthening rather than a
    // relaxation. Refusals are being DELETED as capabilities get wired up (that is
    // the whole programme), so a count floor is a countdown to a vacuous guard: the
    // non-shared partition went 21 -> 12 in one change, leaving 2 of margin over a
    // floor of 10, and two more legitimate deletions would have failed this test for
    // doing the right thing. The mode-axis ratchet already learned this lesson and
    // records it in src/mode-axis-ratchet.test.ts: prove the counter still FIRES
    // against fixtures, because repo counts are supposed to reach zero.
    //
    // So the emptiness check stays (a scan over nothing must fail), and the real
    // proof that the regex and the partition rules still work moved to the
    // fixture-driven case below, which cannot be eroded by deleting refusals.
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.filter((r) => r.shared).length).toBeGreaterThan(0);
    expect(refusals.filter((r) => !r.shared).length).toBeGreaterThan(0);
    expect(new Set(refusals.map((r) => r.file))).toContain("domain.ts");
    expect(new Set(refusals.map((r) => r.file))).toContain("provision.ts");
  });

  // The check that survives every count reaching zero. Both directions are asserted:
  // a regex that stopped matching would silently empty the scan, and one widened
  // until it matches anything would flag unrelated code.
  it("proves the refusal scan still fires, independently of repo content", () => {
    const matches = (source: string): string[] =>
      [...source.matchAll(new RegExp(REFUSAL_CALL.source, "g"))].map((m) => m[1] ?? "");

    for (const hit of [
      'serverOnly("emails schedule run");',
      'notImplementedAnywhere("emails provision");',
      '  try { serverOnly( "emails batch" ); } catch (e) { handleError(e); }',
    ]) {
      expect(matches(hit).length, hit).toBeGreaterThan(0);
    }
    for (const miss of [
      "function serverOnly(command: string): never {",
      "notImplementedAnywhere(command);",
      "// serverOnly is described in prose here",
    ]) {
      expect(matches(miss).filter((c) => c.startsWith("emails ")), miss).toEqual([]);
    }
    // The partition rule: only `*.remote.ts` / `*.local.ts` are mode-specific.
    for (const [file, shared] of [
      ["misc.remote.ts", false], ["misc.local.ts", false], ["domain.ts", true], ["provision.ts", true],
    ] as const) {
      expect(!file.endsWith(".remote.ts") && !file.endsWith(".local.ts"), file).toBe(shared);
    }
  });

  // The scan's BLIND SPOT, stated so it cannot be mistaken for coverage: `:57` drops
  // any literal that does not start with `emails `, and flag-conditional refusals are
  // inline `handleError(new Error(...))` calls with no literal at all. Neither can
  // ever appear in `refusals`, so neither is protected by the assertions below.
  // src/lib/status-commands.test.ts pins those by name instead.
  it("declares what the scan cannot see", () => {
    const inbox = readFileSync(join(COMMANDS_DIR, "inbox.remote.ts"), "utf8");
    // Real refusals in the file, invisible because the literal omits the `emails ` prefix.
    expect(inbox).toContain('serverOnly("sync-s3")');
    expect(refusals.map((r) => r.command)).not.toContain("emails inbox sync-s3");
    // A flag-conditional refusal: no matchable literal at all.
    expect(inbox).toContain("`inbox unread-count --by-address` is not available");
    expect(refusals.map((r) => r.command)).not.toContain("emails inbox unread-count --by-address");
  });

  // The regression, named. These are the call sites the `*.remote.ts` glob missed.
  //
  // `emails domain check` was on this list until it was WIRED UP: its whole
  // implementation already shipped in src/lib/dns-check.ts and no command reached
  // it. It is asserted absent below rather than quietly dropped, so the day
  // someone re-refuses it this test says so.
  it("sees the shared-module refusals the original grep could not", () => {
    const shared = refusals.filter((r) => r.shared).map((r) => r.command);
    expect(shared).toContain("emails domain status");
    expect(shared).toContain("emails domain verify");
    expect(shared).toContain("emails address provision");
  });

  it("no longer counts the DNS commands that were wired to their libraries", () => {
    const shared = refusals.filter((r) => r.shared).map((r) => r.command);
    for (const wired of [
      "emails domain check",
      "emails domains check",
      "emails domain dns",
      "emails domains dns",
    ]) {
      expect(shared, `${wired} refuses again — is that intended?`).not.toContain(wired);
      // And the registry must not still be suppressing them from every
      // suggestion path: the coverage check above only fails in one direction.
      for (const mode of ["local", "self_hosted"] as const) {
        expect(isCommandAvailableInMode(`${wired} example.com`, mode), `${wired} in ${mode}`).toBe(true);
      }
    }
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
