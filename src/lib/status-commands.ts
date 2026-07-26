// Which CLI commands actually RUN in the selected mode.
//
// WHY: suggesting a remedy that refuses is the same defect as reporting a
// fabricated count — the payload states something untrue about the system. Before
// this registry existed, `emails status` proposed `emails provision status` and
// every JSON error proposed `emails doctor --json`, both of which refuse in
// self_hosted mode ("... runs on the self-hosted server"). An agent following the
// advice got a second failure and no closer to the truth.
//
// The self_hosted refusal list mirrors the `serverOnly(...)` call sites in the
// `*.remote.ts` command modules. Keep them in sync: a command that starts
// refusing must be added here, and this list is the only place that knows.
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
 * Source of truth: the `notImplementedAnywhere(...)` call sites in
 * src/cli/commands/provision.ts.
 */
export const NEVER_AVAILABLE_COMMANDS: readonly string[] = [
  "emails provision",
];

/**
 * Command prefixes that refuse in self_hosted mode because they need
 * server-side state, local SQLite, or a local daemon.
 * Source of truth: `grep -n 'serverOnly(' src/cli/commands/*.remote.ts`.
 */
export const SELF_HOSTED_REFUSED_COMMANDS: readonly string[] = [
  "emails analytics",
  "emails batch",
  "emails daemon",
  "emails doctor",
  "emails export",
  "emails inbox explain",
  "emails inbox listen",
  "emails inbox open",
  "emails inbox realtime-status",
  "emails inbox setup-realtime",
  "emails inbox source",
  "emails inbox sync-s3",
  "emails inbox watch",
  "emails logs tail",
  "emails monitor",
  "emails provider sync",
  "emails pull",
  "emails refresh",
  "emails schedule",
  "emails scheduled",
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
