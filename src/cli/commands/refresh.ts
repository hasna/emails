import type { Command } from "commander";
import chalk from "chalk";
import { autoPull } from "../tui/autopull.js";
import { handleError } from "../utils.js";

/**
 * `emails refresh` — one-shot "pull everything now". Syncs every configured
 * inbound S3 bucket (each with its own provider creds / AWS account) and,
 * optionally, the Gmail accounts — the same engine the interactive TUI runs in
 * the background, exposed as a single instant command so you never have to type
 * `inbox sync-s3 --bucket … --prefix … --profile … --provider …` by hand.
 */
export function registerRefreshCommand(program: Command, output: (data: unknown, formatted: string) => void): void {
  program
    .command("refresh")
    .description("Pull all new inbound mail now — syncs every configured S3 inbound bucket (add --gmail to also pull Gmail)")
    .option("--gmail", "Also pull the newest messages from each active Gmail account")
    .option("--limit <n>", "Max objects to scan per bucket", "1000")
    .action(async (opts: { gmail?: boolean; limit?: string }) => {
      try {
        const limit = Math.max(1, parseInt(opts.limit ?? "1000", 10) || 1000);
        const r = await autoPull({ s3: true, gmail: opts.gmail === true, limit });

        if (!r.configured) {
          console.log(chalk.yellow("No inbound sources configured."));
          console.log(chalk.dim("Adopt a domain (`emails domain adopt <domain>`) or add a bucket, then refresh."));
          return;
        }
        if (!r.ok && r.reason) {
          console.log(chalk.red(`Refresh hit an error: ${r.reason}`));
          if (r.pulled > 0) console.log(chalk.green(`(still pulled ${r.pulled} before failing)`));
          return;
        }
        const msg = r.pulled > 0 ? `✓ Pulled ${r.pulled} new email${r.pulled === 1 ? "" : "s"}` : "✓ Up to date — no new mail";
        output({ pulled: r.pulled, ok: r.ok }, r.pulled > 0 ? chalk.green(msg) : chalk.dim(msg));
      } catch (e) {
        handleError(e);
      }
    });
}
