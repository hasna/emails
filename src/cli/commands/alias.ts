import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { createAlias, createCatchAll, setGlobalCatchAll, getGlobalCatchAll, ensureDefaultCatchAll, removeAlias, getAlias, listAliases, resolveAlias, CATCH_ALL, ALL_DOMAINS } from "../../db/aliases.js";
import { formatListHint, handleError, isCliVerboseOutput, parseCliListPage } from "../utils.js";

function display(a: { local_part: string; domain: string }): string {
  if (a.domain === ALL_DOMAINS) return "*@* (all domains)";
  return a.local_part === CATCH_ALL ? `*@${a.domain}` : `${a.local_part}@${a.domain}`;
}

export function registerAliasCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const cmd = program.command("alias").description("Manage per-domain aliases and catch-all routing");

  cmd
    .command("add <alias> <target>")
    .description("Route an alias address to a target, e.g. alias add hello@acme.com ops@acme.com")
    .action(async (alias: string, target: string) => {
      try {
        const a = await createAlias(alias, target);
        output(a, chalk.green(`✓ ${display(a)} → ${a.target_address}`));
      } catch (e) { handleError(e); }
    });

  cmd
    .command("catch-all <domain> <target>")
    .description("Route every unmatched recipient on a domain to a target")
    .action(async (domain: string, target: string) => {
      try {
        const a = await createCatchAll(domain, target);
        output(a, chalk.green(`✓ catch-all *@${a.domain} → ${a.target_address}`));
      } catch (e) { handleError(e); }
    });

  cmd
    .command("global <target>")
    // "never deletable" was the old wording and it was not true of every row this command can
    // reach: `setGlobalCatchAll` sets the protected flag when it CREATES the row and leaves it
    // alone when it updates one, so a global catch-all another writer left unprotected stays
    // deletable. `src/db/aliases.ts` records that as an inherited defect and pins it; the help
    // text now describes what the command actually guarantees.
    .description("Set the GLOBAL catch-all (all domains) → target; a catch-all created here is protected from deletion")
    .action(async (target: string) => {
      try {
        const a = await setGlobalCatchAll(target);
        output(a, chalk.green(`✓ global catch-all (all domains) → ${a.target_address || "(keep, no forward)"}`));
      } catch (e) { handleError(e); }
    });

  cmd
    .command("list")
    .description("List aliases (optionally for one domain), incl. the protected global catch-all")
    .option("--domain <domain>", "Filter by domain")
    .option("--limit <n>", "Maximum aliases to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of aliases to skip", "0")
    .option("--verbose", "Show explanatory alias notes")
    .action(async (opts: { domain?: string; limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        if (!opts.domain) await ensureDefaultCatchAll(); // make sure the protected default exists
        const page = parseCliListPage(opts);
        const aliases = await listAliases(opts.domain, page);
        if (aliases.length === 0) { output([], chalk.dim("No aliases configured.")); return; }
        const verbose = opts.verbose || isCliVerboseOutput();
        const lines = [chalk.bold("\nAliases:")];
        for (const a of aliases) {
          const kind = a.protected ? chalk.green("[protected]") : a.local_part === CATCH_ALL ? chalk.magenta("[catch-all]") : "           ";
          const target = a.target_address || chalk.dim("(keep, no forward)");
          lines.push(`  ${chalk.cyan(a.id.slice(0, 8))} ${kind} ${display(a).padEnd(34)} → ${target}`);
        }
        const g = await getGlobalCatchAll();
        lines.push("");
        lines.push(formatListHint({
          shown: aliases.length,
          limit: page.limit,
          offset: page.offset,
          noun: "alias",
          detailCommand: "use emails alias resolve <recipient> to test routing",
          verbose,
        }));
        if (verbose && g) lines.push(chalk.dim("\n  The global catch-all is protected — it catches mail for every domain and can't be deleted."));
        output(aliases, lines.join("\n"));
      } catch (e) { handleError(e); }
    });

  // Accepts every handle the CLI itself hands out: the full UUID, the 8-char
  // prefix `alias list` prints, and the alias address `alias add` took. The
  // previous version accepted only the full UUID — a handle visible only via
  // --json (task 55c19dde).
  async function resolveAliasSelector(ref: string) {
    const direct = await getAlias(ref);
    if (direct) return direct;
    const wanted = ref.trim().toLowerCase();
    const rows = await listAliases(undefined, { limit: 1000 });
    const matches = rows.filter((a) =>
      a.id.startsWith(ref)
      || `${a.local_part}@${a.domain}`.toLowerCase() === wanted
      || display(a).toLowerCase() === wanted);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      handleError(new Error(`Alias '${ref}' is ambiguous: ${matches.map((a) => a.id.slice(0, 8)).join(", ")}`));
    }
    handleError(new Error(`Alias not found: ${ref}`));
  }

  cmd
    .command("remove <id>")
    .description("Remove an alias or catch-all by ID (full or 8-char), or by its alias address")
    .action(async (id: string) => {
      try {
        const a = await resolveAliasSelector(id);
        await removeAlias(a.id);
        output(a, chalk.green(`✓ Removed ${display(a)}`));
      } catch (e) { handleError(e); }
    });

  cmd
    .command("resolve <recipient>")
    .description("Show where a recipient address would be routed")
    .action(async (recipient: string) => {
      try {
        const target = await resolveAlias(recipient);
        if (target) output({ recipient, target }, `${recipient} → ${chalk.green(target)}`);
        else output({ recipient, target: null }, chalk.dim(`${recipient} → (no alias; delivered as-is)`));
      } catch (e) { handleError(e); }
    });
}
