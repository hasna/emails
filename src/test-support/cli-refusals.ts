// The CLI's own refusal call sites, read out of the source.
//
// This exists so a test that asserts "the payload never proposes a command that
// refuses" can use the CLI as its oracle. The previous guards asserted proposed
// commands against src/lib/status-commands.ts — the same registry that filtered
// them — so a refusal missing from the registry passed the test and threw at the
// terminal. A guard whose oracle is the thing under test proves nothing.
//
// `serverOnly()` / `notImplementedAnywhere()` are defined per command module and
// always throw. A refusal in a SHARED module (not `*.remote.ts` / `*.local.ts`,
// which src/cli/index.tsx loads in both modes) therefore refuses in every mode.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { EmailsMode } from "../lib/mode.js";

const COMMANDS_DIR = join(import.meta.dir, "..", "cli", "commands");

/**
 * The refusal helpers this oracle knows how to see, named individually.
 *
 * Enumerated rather than buried inside one alternation so that a control can
 * assert EACH shape is still observed, and so the regex below cannot drift from
 * the list. Deleting one alternative from the old combined regex made the oracle
 * half-blind with the entire suite green: all 17 `serverOnly(...)` call sites live
 * in `*.remote.ts`, so once `src/cli/commands/domain.ts` stopped using that helper
 * nothing asserted the `serverOnly` arm at all. See `refusalHelpersObserved()`.
 */
export const REFUSAL_HELPERS = ["serverOnly", "notImplementedAnywhere"] as const;

export type RefusalHelper = (typeof REFUSAL_HELPERS)[number];

/**
 * Matches the call sites, never the `function serverOnly(command: string)` decls.
 *
 * Built from `REFUSAL_HELPERS` so there is one list, not two to keep in sync, and
 * the helper name is CAPTURED rather than discarded in a non-capturing group —
 * that capture is what lets a control count coverage per shape.
 */
const REFUSAL_CALL = new RegExp(`(${REFUSAL_HELPERS.join("|")})\\(\\s*"([^"]+)"\\s*\\)`, "g");

export interface CliRefusal {
  /** Command string as the CLI itself names it, e.g. `emails domain status`. */
  command: string;
  file: string;
  /** true => the module ships in both modes, so the refusal is unconditional. */
  shared: boolean;
  /** The helper whose call site this is. */
  helper: RefusalHelper;
}

let cached: CliRefusal[] | null = null;

export function scanCliRefusals(): CliRefusal[] {
  if (cached) return cached;
  const found: CliRefusal[] = [];
  for (const entry of readdirSync(COMMANDS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    const text = readFileSync(join(COMMANDS_DIR, entry.name), "utf8");
    for (const match of text.matchAll(REFUSAL_CALL)) {
      const helper = match[1] as RefusalHelper;
      const command = match[2];
      if (!command || !command.startsWith("emails ")) continue;
      found.push({
        command,
        file: entry.name,
        shared: !entry.name.endsWith(".remote.ts") && !entry.name.endsWith(".local.ts"),
        helper,
      });
    }
  }
  cached = found;
  return found;
}

/**
 * How many refusals this oracle currently sees, per helper.
 *
 * A control asserts every entry is non-zero, because that is the ONLY way this
 * oracle's own blindness is detectable: every downstream assertion is of the form
 * "this proposed command must NOT refuse", and an oracle that sees fewer refusals
 * only ever RELAXES those. Going blind is silently green.
 */
export function refusalHelpersObserved(): Record<RefusalHelper, number> {
  const counts = Object.fromEntries(REFUSAL_HELPERS.map((h) => [h, 0])) as Record<RefusalHelper, number>;
  for (const refusal of scanCliRefusals()) counts[refusal.helper] += 1;
  return counts;
}

/** Command prefixes that throw in `mode`, according to the CLI source. */
export function cliRefusedPrefixes(mode: EmailsMode): string[] {
  return scanCliRefusals()
    .filter((refusal) => refusal.shared || mode === "self_hosted")
    .map((refusal) => refusal.command);
}

/**
 * The refusal a command would hit in `mode`, or null if it runs.
 *
 * Deliberately independent of src/lib/status-commands.ts: this is the oracle, and
 * that registry is what is being tested.
 */
export function cliRefusalFor(command: string, mode: EmailsMode): string | null {
  const normalized = command.trim();
  for (const prefix of cliRefusedPrefixes(mode)) {
    if (normalized === prefix || normalized.startsWith(`${prefix} `)) return prefix;
  }
  return null;
}
