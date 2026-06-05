/** @jsxImportSource @opentui/react */
import type { Command } from "commander";
import chalk from "chalk";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "../tui/App.js";
import type { Mailbox } from "../tui/data.js";

export function registerUiCommand(program: Command, _output: (data: unknown, formatted: string) => void): void {
  program
    .command("ui")
    .description("Open the email UI")
    .option("--mailbox <name>", "Start in: inbox | unread | starred | sent | archived (default: your saved setting)")
    .action(async (opts: { mailbox?: string }) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(chalk.red("Email UI requires a TTY terminal."));
        console.error(chalk.dim("Use `emails inbox list`, `emails inbox read <id>`, or `emails send` non-interactively."));
        process.exit(1);
      }
      const valid: Mailbox[] = ["inbox", "unread", "starred", "sent", "archived"];
      const mailbox = opts.mailbox && valid.includes(opts.mailbox as Mailbox) ? (opts.mailbox as Mailbox) : undefined;
      await runOpenTuiApp(mailbox);
    });
}

export async function runOpenTuiApp(initialMailbox?: Mailbox): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
    consoleMode: "disabled",
    openConsoleOnError: false,
    useKittyKeyboard: {},
    useMouse: true,
    enableMouseMovement: true,
    backgroundColor: "#101418",
  });
  renderer.setTerminalTitle("emails ui");
  createRoot(renderer).render(<App initialMailbox={initialMailbox} />);
  await new Promise<void>((resolve) => {
    renderer.on("destroy", () => resolve());
  });
}
