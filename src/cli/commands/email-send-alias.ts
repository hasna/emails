import { Command } from "commander";

type Output = (data: unknown, formatted: string) => void;

/**
 * `emails email send` — forwards its argv verbatim to the real top-level `send`
 * command.
 *
 * WHY FORWARDING AND NOT A RE-DECLARED OPTION SURFACE. Until this helper
 * existed, both arms of the `email` command declared a plausible subset of the
 * send options (--from/--to/--subject/--body/--provider), matched a fully
 * specified send, printed a one-line usage hint, and exited 0 — a silent
 * discard wearing a success exit code (task 95f66fd3). An operator or an agent
 * scripting `emails email send --from a --to b --subject s --body t` was told
 * the send succeeded and no mail moved. Re-declaring the real option surface
 * here would recreate that bug the day `send` gains an option this copy lacks;
 * forwarding raw argv keeps the alias in lockstep with the real command by
 * construction, including its refusals.
 *
 * WHY A THROWAWAY PROGRAM. The real command registers onto a root `Command`,
 * and re-parsing through the live root would re-run global option handling.
 * A fresh single-command program parses `["send", ...args]` exactly the way
 * the top-level invocation does, and the CLI's JSON/quiet runtime is
 * module-level state (src/cli/utils.ts), so `--json` and error shaping behave
 * identically without re-wiring. Refusals keep their nonzero exit: commander's
 * own option errors exit 1, and the send action's failures go through
 * `handleError` as they do at the top level.
 *
 * WHY A DYNAMIC IMPORT. `./send.js` pulls the send stack; the alias only pays
 * for it when actually invoked, matching the lazy command registry in
 * src/cli/index.tsx.
 */
export function registerEmailSendAlias(emailCmd: Command, output: Output): void {
  emailCmd
    .command("send")
    .description("Send an email (alias of top-level `emails send`; accepts every `emails send` option)")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument("[args...]", "arguments forwarded verbatim to `emails send`")
    .action(async (args: string[]) => {
      const { registerSendCommands } = await import("./send.js");
      const delegate = new Command();
      registerSendCommands(delegate, output);
      await delegate.parseAsync(["send", ...args], { from: "user" });
    });
}
