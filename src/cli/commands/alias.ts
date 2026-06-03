import type { Command } from "commander";
import chalk from "chalk";
import { createAlias, createCatchAll, removeAlias, getAlias, listAliases, resolveAlias, CATCH_ALL } from "../../db/aliases.js";
import { handleError } from "../utils.js";

function display(a: { local_part: string; domain: string }): string {
  return a.local_part === CATCH_ALL ? `*@${a.domain}` : `${a.local_part}@${a.domain}`;
}

export function registerAliasCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const cmd = program.command("alias").description("Manage per-domain aliases and catch-all routing");

  cmd
    .command("add <alias> <target>")
    .description("Route an alias address to a target, e.g. alias add hello@acme.com ops@acme.com")
    .action((alias: string, target: string) => {
      try {
        const a = createAlias(alias, target);
        output(a, chalk.green(`✓ ${display(a)} → ${a.target_address}`));
      } catch (e) { handleError(e); }
    });

  cmd
    .command("catch-all <domain> <target>")
    .description("Route every unmatched recipient on a domain to a target")
    .action((domain: string, target: string) => {
      try {
        const a = createCatchAll(domain, target);
        output(a, chalk.green(`✓ catch-all *@${a.domain} → ${a.target_address}`));
      } catch (e) { handleError(e); }
    });

  cmd
    .command("list")
    .description("List aliases (optionally for one domain)")
    .option("--domain <domain>", "Filter by domain")
    .action((opts: { domain?: string }) => {
      const aliases = listAliases(opts.domain);
      if (aliases.length === 0) { output([], chalk.dim("No aliases configured.")); return; }
      const lines = [chalk.bold("\nAliases:")];
      for (const a of aliases) {
        const kind = a.local_part === CATCH_ALL ? chalk.magenta("[catch-all]") : "           ";
        lines.push(`  ${chalk.cyan(a.id.slice(0, 8))} ${kind} ${display(a).padEnd(32)} → ${a.target_address}`);
      }
      output(aliases, lines.join("\n"));
    });

  cmd
    .command("remove <id>")
    .description("Remove an alias or catch-all by ID")
    .action((id: string) => {
      try {
        const a = getAlias(id);
        if (!a) return handleError(new Error(`Alias not found: ${id}`));
        removeAlias(id);
        output(a, chalk.green(`✓ Removed ${display(a)}`));
      } catch (e) { handleError(e); }
    });

  cmd
    .command("resolve <recipient>")
    .description("Show where a recipient address would be routed")
    .action((recipient: string) => {
      const target = resolveAlias(recipient);
      if (target) output({ recipient, target }, `${recipient} → ${chalk.green(target)}`);
      else output({ recipient, target: null }, chalk.dim(`${recipient} → (no alias; delivered as-is)`));
    });
}
