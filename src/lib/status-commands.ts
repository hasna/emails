// Which CLI commands actually RUN in the selected mode.
//
// WHY: suggesting a remedy that refuses is the same defect as reporting a
// fabricated count — the payload states something untrue about the system. Before
// this registry existed, `emails status` proposed `emails provision status` and
// every JSON error proposed `emails doctor --json`, both of which refuse in
// self_hosted mode ("... runs on the self-hosted server"). An agent following the
// advice got a second failure and no closer to the truth.
//
// THE REGISTRY IS NOT THE SOURCE OF TRUTH — THE CLI IS. The first cut of this
// module documented its source as `grep 'serverOnly(' src/cli/commands/*.remote.ts`,
// and that glob is wrong: `serverOnly()` is also defined and called in the SHARED
// modules src/cli/commands/domain.ts and src/cli/commands/address.ts, which
// src/cli/index.tsx loads in BOTH modes and whose helper throws unconditionally.
// Fifteen commands were therefore missing, so `emails status` against a server
// with a failed domain proposed `emails domain status --json` — a refusal,
// promoted into `next_actions` by the very code that exists to stop that.
//
// src/lib/status-commands-coverage.test.ts parses every refusal call site out of
// src/cli/commands/*.ts and fails if this registry does not cover it. Add a
// refusal to the CLI and the test names it; nothing here has to be remembered.
//
// A command that refuses in EVERY mode does not belong in a per-mode list. Put it
// in NEVER_AVAILABLE_COMMANDS: a per-mode entry only removes the suggestion from
// the mode it is listed under, so `emails provision` sitting in the self_hosted
// list alone still let `emails status` propose it in LOCAL mode, where it refuses
// just as hard.

import type { EmailsMode } from "./mode.js";

/**
 * Command prefixes that refuse in EVERY mode because the feature does not ship in
 * this build at all — neither the local orchestrator nor a `/v1` route exists.
 *
 * Source of truth: every `notImplementedAnywhere(...)` and `serverOnly(...)` call
 * site in a SHARED command module (one that is not `*.remote.ts` / `*.local.ts`),
 * because those helpers throw regardless of mode. Enforced by
 * src/lib/status-commands-coverage.test.ts — do not hand-maintain this list
 * against a remembered grep.
 */
export const NEVER_AVAILABLE_COMMANDS: readonly string[] = [
  // src/cli/commands/provision.ts — notImplementedAnywhere()
  "emails provision",
  // src/cli/commands/address.ts — serverOnly()
  "emails address provision",
  // src/cli/commands/domain.ts — serverOnly(). Both the singular `domain` and the
  // plural `domains` alias refuse, and `emails domain status` is the one that was
  // reaching `next_actions`.
  "emails domain check",
  "emails domain connect",
  "emails domain dns",
  "emails domain setup",
  "emails domain setup-cloudflare",
  "emails domain status",
  "emails domain verify",
  "emails domains check",
  "emails domains connect",
  "emails domains disable-outbound",
  "emails domains dns",
  "emails domains enable-inbound",
  "emails domains enable-outbound",
  "emails domains verify",
];

/**
 * Command prefixes that refuse in self_hosted mode because they need
 * server-side state, local SQLite, or a local daemon.
 * Source of truth: `grep -n 'serverOnly(' src/cli/commands/*.remote.ts`.
 */
export const SELF_HOSTED_REFUSED_COMMANDS: readonly string[] = [
  "emails analytics",
  "emails batch",
  // Only the delivery sub-diagnosis refuses; `emails doctor` itself probes the
  // operator service (src/lib/doctor.remote.ts) and is a real remedy.
  "emails doctor delivery",
  "emails inbox explain",
  "emails inbox listen",
  "emails inbox open",
  "emails inbox realtime-status",
  "emails inbox setup-realtime",
  "emails inbox sync-s3",
  "emails inbox watch",
  "emails monitor",
  "emails provider sync",
  "emails pull",
  "emails refresh",
  // The scheduler LOOP refuses (it needs the local send pipeline); reading and
  // cancelling the schedule over /v1/scheduled does not.
  "emails schedule run",
  "emails scheduler",
  "emails stats",
  "emails test",
  "emails webhook listen",
];

/** Command prefixes that refuse in local mode (server/API-only surfaces). */
export const LOCAL_REFUSED_COMMANDS: readonly string[] = [
  "emails auth",
  "emails serve",
];

function refusedFor(mode: EmailsMode): readonly string[] {
  const modeSpecific = mode === "self_hosted" ? SELF_HOSTED_REFUSED_COMMANDS : LOCAL_REFUSED_COMMANDS;
  return [...NEVER_AVAILABLE_COMMANDS, ...modeSpecific];
}

/**
 * True when `command` (a full command line, e.g. `emails provision status`) is
 * runnable in `mode`. Matching is prefix-on-word-boundary so
 * `emails provision status` matches the `emails provision` entry while
 * `emails provisioning-report` would not.
 */
export function isCommandAvailableInMode(command: string, mode: EmailsMode): boolean {
  const normalized = command.trim();
  return !refusedFor(mode).some((prefix) =>
    normalized === prefix || normalized.startsWith(`${prefix} `));
}

/** Drop every suggestion that would refuse in `mode`, preserving order. */
export function keepAvailableCommands(commands: string[], mode: EmailsMode): string[] {
  return commands.filter((command) => isCommandAvailableInMode(command, mode));
}
