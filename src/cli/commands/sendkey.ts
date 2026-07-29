import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { createSendKey, listSendKeySummaries, revokeSendKey, getSendKey, canOwnerSendFrom } from "../../db/send-keys.js";
import { getOwner, getOwnerByName, listAddressesByOwner, listOwnerNamesByIds } from "../../db/owners.js";
import { formatListHint, handleError, isCliVerboseOutput, parseCliListPage } from "../utils.js";

/**
 * A key's owner, for display only.
 *
 * `owner_id` IS NULLABLE on the store seam — the local table clears it when an owner is
 * deleted (`ON DELETE SET NULL`) and the service's column is nullable too — so a key that
 * outlived its owner has to render as something. It renders as an explicit "(no owner)"
 * rather than as a blank column or a fabricated id, because a key bound to nobody is
 * exactly what a reader reviewing keys needs to see.
 */
function ownerLabel(ownerId: string | null, names: Map<string, string>): string {
  if (ownerId === null) return chalk.dim("(no owner)");
  return names.get(ownerId) ?? ownerId.slice(0, 8);
}

export function registerSendKeyCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const cmd = program.command("sendkey").description("Scoped send keys — restrict an agent to sending from its own addresses");

  cmd
    .command("create <owner>")
    .description("Issue a send key for an owner (agent/human). The token is shown ONCE.")
    .option("--label <label>", "A label to identify this key")
    .action(async (owner: string, opts: { label?: string }) => {
      try {
        const o = (await getOwnerByName(owner)) ?? (await getOwner(owner));
        if (!o) return handleError(new Error(`Owner not found: ${owner}`));
        const { token, key } = await createSendKey(o.id, opts.label);
        const scope = (await listAddressesByOwner(o.id, "owner"))
          .concat(await listAddressesByOwner(o.id, "administrator"));
        const uniq = [...new Set(scope.map((a) => a.email))];
        const text = [
          chalk.green(`✓ Send key issued for ${o.type} '${o.name}'`),
          chalk.bold(`\n  ${token}\n`),
          chalk.yellow("  Store it now — it will not be shown again."),
          chalk.dim(`  Authorized to send from: ${uniq.length ? uniq.join(", ") : "(no addresses yet)"}`),
        ].join("\n");
        output({ id: key.id, token, owner_id: o.id, label: key.label }, text);
      } catch (e) { handleError(e); }
    });

  cmd
    .command("list")
    .description("List send keys (tokens and hashes are never shown)")
    .option("--owner <owner>", "Filter by owner name or id")
    .option("--limit <n>", "Maximum send keys to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of send keys to skip", "0")
    .option("--verbose", "Show expanded list hints")
    .action(async (opts: { owner?: string; limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        let ownerId: string | undefined;
        if (opts.owner) {
          const o = (await getOwnerByName(opts.owner)) ?? (await getOwner(opts.owner));
          if (!o) return handleError(new Error(`Owner not found: ${opts.owner}`));
          ownerId = o.id;
        }
        const page = parseCliListPage(opts);
        const keys = await listSendKeySummaries(ownerId, page);
        if (keys.length === 0) { output([], chalk.dim("No send keys.")); return; }
        const ownerNames = await listOwnerNamesByIds(
          keys.map((key) => key.owner_id).filter((id): id is string => id !== null),
        );
        const lines = [chalk.bold("\nSend keys:")];
        for (const k of keys) {
          const status = k.revoked_at ? chalk.red("revoked") : chalk.green("active");
          lines.push(`  ${chalk.cyan(k.id.slice(0, 8))} ${k.prefix ?? "—"}…  ${ownerLabel(k.owner_id, ownerNames)}  [${status}]${k.label ? `  ${chalk.dim(k.label)}` : ""}`);
        }
        lines.push("");
        lines.push(formatListHint({
          shown: keys.length,
          limit: page.limit,
          offset: page.offset,
          noun: "send key",
          detailCommand: "filter with --owner <owner>",
          verbose: opts.verbose || isCliVerboseOutput(),
        }));
        output(keys, lines.join("\n"));
      } catch (e) { handleError(e); }
    });

  cmd
    .command("revoke <id>")
    .description("Revoke a send key by ID")
    .action(async (id: string) => {
      try {
        const k = await getSendKey(id);
        if (!k) return handleError(new Error(`Send key not found: ${id}`));
        // THE ANSWER IS READ NOW, where it used to be discarded. `revokeSendKey` returns
        // true only when THIS call revoked the key; the previous version printed the
        // success line unconditionally, so re-revoking an already-revoked key reported a
        // revocation that did not happen and stamped nothing.
        const revoked = await revokeSendKey(id);
        output(
          { ...k, revoked },
          revoked
            ? chalk.green(`✓ Revoked send key ${id.slice(0, 8)}`)
            : chalk.yellow(`Send key ${id.slice(0, 8)} was already revoked; nothing changed`),
        );
      } catch (e) { handleError(e); }
    });

  cmd
    .command("check <owner> <from>")
    .description("Check whether an owner is allowed to send from an address")
    .action(async (owner: string, from: string) => {
      try {
        const o = (await getOwnerByName(owner)) ?? (await getOwner(owner));
        if (!o) return handleError(new Error(`Owner not found: ${owner}`));
        const ok = await canOwnerSendFrom(o.id, from);
        output({ owner: o.name, from, authorized: ok },
          ok ? chalk.green(`✓ ${o.name} may send from ${from}`) : chalk.red(`✗ ${o.name} may NOT send from ${from}`));
      } catch (e) { handleError(e); }
    });
}
