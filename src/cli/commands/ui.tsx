import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import type { Mailbox } from "../tui/data.js";

interface UiRuntime {
  runOpenTuiApp(initialMailbox?: Mailbox): Promise<void>;
}

const runtimeBundleSpecifier = "./ui-runtime-bundle.js";
const workspaceDistRuntimeSpecifier = "../../../dist/cli/ui-runtime-bundle.js";
const sourceRuntimeSpecifier = "../tui/runtime.js";
const VALID_MAILBOXES: Mailbox[] = ["inbox", "unread", "starred", "sent", "archived", "spam", "trash"];

export function registerUiCommand(program: Command, _output: (data: unknown, formatted: string) => void): void {
  program
    .command("ui")
    .description("Open the Mailery UI")
    .option("--mailbox <name>", "Start in: inbox | unread | starred | sent | archived | spam | trash (default: your saved setting)")
    .option("--clipboard-test [text]", "Copy test text using the same clipboard path as the UI")
    .action(async (opts: { mailbox?: string; clipboardTest?: string | boolean }) => {
      if (opts.clipboardTest !== undefined) {
        const { copyTextToClipboard } = await import("../tui/clipboard.js");
        const text = typeof opts.clipboardTest === "string" && opts.clipboardTest.trim()
          ? opts.clipboardTest
          : `mailery ui clipboard test ${new Date().toISOString()}`;
        const result = copyTextToClipboard(text);
        if (result.ok) {
          console.log(chalk.green(`Copied clipboard test via ${result.method ?? "clipboard"}`));
          console.log(chalk.dim(text));
        } else {
          console.error(chalk.red(`Clipboard test failed: ${result.error ?? "clipboard unavailable"}`));
          process.exitCode = 1;
        }
        return;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(chalk.red("Mailery UI requires a TTY terminal."));
        console.error(chalk.dim("Use `mailery inbox list`, `mailery inbox read <id>`, or `mailery send` non-interactively."));
        process.exitCode = 1;
        return;
      }
      const mailbox = opts.mailbox && VALID_MAILBOXES.includes(opts.mailbox as Mailbox) ? (opts.mailbox as Mailbox) : undefined;
      await runOpenTuiApp(mailbox);
    });
}

export async function runOpenTuiApp(initialMailbox?: Mailbox): Promise<void> {
  const runtime = await loadUiRuntime();
  await runtime.runOpenTuiApp(initialMailbox);
}

async function loadUiRuntime(): Promise<UiRuntime> {
  const bundledRuntime = await tryImportRuntime(runtimeBundleSpecifier);
  if (bundledRuntime) return bundledRuntime;

  if (import.meta.url.includes("/src/cli/commands/")) {
    const sourceRuntime = await tryImportRuntime(sourceRuntimeSpecifier);
    if (sourceRuntime) return sourceRuntime;
  }

  const workspaceDistRuntime = await tryImportRuntime(workspaceDistRuntimeSpecifier);
  if (workspaceDistRuntime) return workspaceDistRuntime;

  return await import(sourceRuntimeSpecifier) as UiRuntime;
}

async function tryImportRuntime(specifier: string): Promise<UiRuntime | null> {
  try {
    return await import(specifier) as UiRuntime;
  } catch (error) {
    if (!isMissingRuntime(error, specifier)) throw error;
    return null;
  }
}

function isMissingRuntime(error: unknown, specifier: string): boolean {
  const message = String((error as { message?: unknown })?.message ?? error);
  return message.includes("ui-runtime-bundle.js") || message.includes(runtimeBundleSpecifier) || message.includes(specifier);
}
