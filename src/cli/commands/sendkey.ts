import type { Command } from "commander";
import chalk from "chalk";
import { createSendKey, listSendKeys, revokeSendKey, getSendKey, canOwnerSendFrom } from "../../db/send-keys.js";
import { getOwner, getOwnerByName, listAddressesByOwner } from "../../db/owners.js";
import { handleError } from "../utils.js";

export function registerSendKeyCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const cmd = program.command("sendkey").description("Scoped send keys — restrict an agent to sending from its own addresses");

  cmd
    .command("create <owner>")
    .description("Issue a send key for an owner (agent/human). The token is shown ONCE.")
    .option("--label <label>", "A label to identify this key")
    .action((owner: string, opts: { label?: string }) => {
      try {
        const o = getOwnerByName(owner) ?? getOwner(owner);
        if (!o) return handleError(new Error(`Owner not found: ${owner}`));
        const { token, key } = createSendKey(o.id, opts.label);
        const scope = listAddressesByOwner(o.id, "owner").concat(listAddressesByOwner(o.id, "administrator"));
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
    .description("List send keys (hashes only; tokens are never stored)")
    .option("--owner <owner>", "Filter by owner name or id")
    .action((opts: { owner?: string }) => {
      try {
        let ownerId: string | undefined;
        if (opts.owner) {
          const o = getOwnerByName(opts.owner) ?? getOwner(opts.owner);
          if (!o) return handleError(new Error(`Owner not found: ${opts.owner}`));
          ownerId = o.id;
        }
        const keys = listSendKeys(ownerId);
        if (keys.length === 0) { output([], chalk.dim("No send keys.")); return; }
        const lines = [chalk.bold("\nSend keys:")];
        for (const k of keys) {
          const o = getOwner(k.owner_id);
          const status = k.revoked_at ? chalk.red("revoked") : chalk.green("active");
          lines.push(`  ${chalk.cyan(k.id.slice(0, 8))} ${k.prefix}…  ${o?.name ?? k.owner_id.slice(0, 8)}  [${status}]${k.label ? `  ${chalk.dim(k.label)}` : ""}`);
        }
        output(keys, lines.join("\n"));
      } catch (e) { handleError(e); }
    });

  cmd
    .command("revoke <id>")
    .description("Revoke a send key by ID")
    .action((id: string) => {
      try {
        const k = getSendKey(id);
        if (!k) return handleError(new Error(`Send key not found: ${id}`));
        revokeSendKey(id);
        output(k, chalk.green(`✓ Revoked send key ${id.slice(0, 8)}`));
      } catch (e) { handleError(e); }
    });

  cmd
    .command("check <owner> <from>")
    .description("Check whether an owner is allowed to send from an address")
    .action((owner: string, from: string) => {
      try {
        const o = getOwnerByName(owner) ?? getOwner(owner);
        if (!o) return handleError(new Error(`Owner not found: ${owner}`));
        const ok = canOwnerSendFrom(o.id, from);
        output({ owner: o.name, from, authorized: ok },
          ok ? chalk.green(`✓ ${o.name} may send from ${from}`) : chalk.red(`✗ ${o.name} may NOT send from ${from}`));
      } catch (e) { handleError(e); }
    });
}
