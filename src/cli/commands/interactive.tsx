import type { Command } from "commander";
import chalk from "chalk";
import { render } from "ink";
import { App } from "../tui/App.js";
import type { Mailbox } from "../tui/data.js";

export function registerInteractiveCommand(program: Command, _output: (data: unknown, formatted: string) => void): void {
  program
    .command("interactive")
    .alias("ui")
    .description("Open the interactive mailbox — a Gmail-style TUI with auto-refresh & auto-pull")
    .option("--mailbox <name>", "Start in: inbox | unread | starred | sent | archived", "inbox")
    .action((opts: { mailbox?: string }) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(chalk.red("Interactive mode requires a TTY terminal."));
        console.error(chalk.dim("Use `emails inbox list`, `emails inbox read <id>`, or `emails send` non-interactively."));
        process.exit(1);
      }
      const valid: Mailbox[] = ["inbox", "unread", "starred", "sent", "archived"];
      const mailbox = (valid.includes(opts.mailbox as Mailbox) ? opts.mailbox : "inbox") as Mailbox;
      const app = render(<App initialMailbox={mailbox} />);
      void app.waitUntilExit().then(() => process.exit(0));
    });
}
