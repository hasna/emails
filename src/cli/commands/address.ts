import type { Command } from "commander";
import chalk from "chalk";
import { createAddress, listAddresses, deleteAddress, getAddress } from "../../db/addresses.js";
import { suspendAddress, activateAddress, setAddressQuota, countSendsToday } from "../../db/address-lifecycle.js";
import { getProvider } from "../../db/providers.js";
import { getDatabase } from "../../db/database.js";
import { getAdapter } from "../../providers/index.js";
import { colorDnsStatus } from "../../lib/format.js";
import { confirmDestructiveAction, handleError, resolveId } from "../utils.js";

export function registerAddressCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const addressCmd = program.command("address").description("Manage sender email addresses");

  addressCmd
    .command("add <email>")
    .description("Add a sender address")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--name <displayName>", "Display name")
    .action(async (email: string, opts: { provider: string; name?: string }) => {
      try {
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));

        const adapter = getAdapter(provider!);
        await adapter.addAddress(email);

        const addr = createAddress({ provider_id: providerId, email, display_name: opts.name });
        console.log(chalk.green(`✓ Address added: ${email} (${addr.id.slice(0, 8)})`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("list")
    .description("List sender addresses")
    .option("--provider <id>", "Filter by provider ID")
    .action((opts: { provider?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const addresses = listAddresses(providerId);
        if (addresses.length === 0) {
          output([], chalk.dim("No addresses configured."));
          return;
        }
        const lines: string[] = [chalk.bold("\nAddresses:")];
        for (const a of addresses) {
          const verified = a.verified ? colorDnsStatus("verified") : colorDnsStatus("pending");
          const name = a.display_name ? ` (${a.display_name})` : "";
          const status = a.status === "suspended" ? chalk.red("suspended") : chalk.green("active");
          const quota = a.daily_quota !== null ? chalk.dim(`  quota ${countSendsToday(a.email)}/${a.daily_quota}/day`) : "";
          lines.push(`  ${chalk.cyan(a.id.slice(0, 8))}  ${a.email}${name}  [${verified}] [${status}]${quota}`);
        }
        lines.push("");
        output(addresses, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("verify <email>")
    .description("Check verification status of an address")
    .option("--provider <id>", "Provider ID")
    .action(async (email: string, opts: { provider?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const addresses = listAddresses(providerId);
        const found = addresses.find((a) => a.email === email);
        if (!found) handleError(new Error(`Address not found: ${email}`));

        const provider = getProvider(found!.provider_id);
        if (!provider) handleError(new Error("Provider not found"));

        const adapter = getAdapter(provider!);
        const isVerified = await adapter.verifyAddress(email);

        if (isVerified) {
          const db = getDatabase();
          db.run("UPDATE addresses SET verified = 1, updated_at = datetime('now') WHERE id = ?", [found!.id]);
          console.log(chalk.green(`✓ ${email} is verified`));
        } else {
          console.log(chalk.yellow(`⚠ ${email} is not yet verified`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("remove <id>")
    .description("Remove a sender address")
    .option("--yes", "Skip confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      try {
        const resolvedId = resolveId("addresses", id);
        const addr = getAddress(resolvedId);
        if (!addr) handleError(new Error(`Address not found: ${id}`));
        await confirmDestructiveAction(`Remove sender address ${addr.email}?`, opts.yes);
        deleteAddress(resolvedId);
        console.log(chalk.green(`✓ Address removed: ${addr.email}`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("suspend <id>")
    .description("Suspend a sender address (blocks sending until reactivated)")
    .action((id: string) => {
      try {
        const resolvedId = resolveId("addresses", id);
        if (!getAddress(resolvedId)) handleError(new Error(`Address not found: ${id}`));
        const a = suspendAddress(resolvedId);
        output(a, chalk.yellow(`⏸ Suspended ${a.email} — sending blocked`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("activate <id>")
    .description("Reactivate a suspended sender address")
    .action((id: string) => {
      try {
        const resolvedId = resolveId("addresses", id);
        if (!getAddress(resolvedId)) handleError(new Error(`Address not found: ${id}`));
        const a = activateAddress(resolvedId);
        output(a, chalk.green(`✓ Activated ${a.email} — sending allowed`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("quota <id> <perDay>")
    .description("Set a daily send quota for an address (use 'none' to clear)")
    .action((id: string, perDay: string) => {
      try {
        const resolvedId = resolveId("addresses", id);
        if (!getAddress(resolvedId)) handleError(new Error(`Address not found: ${id}`));
        const quota = /^(none|null|unlimited|0?)$/i.test(perDay) && perDay !== "0"
          ? null
          : Number.parseInt(perDay, 10);
        if (quota !== null && Number.isNaN(quota)) handleError(new Error(`Invalid quota: ${perDay}`));
        const a = setAddressQuota(resolvedId, quota);
        output(a, a.daily_quota === null
          ? chalk.green(`✓ Cleared daily quota for ${a.email}`)
          : chalk.green(`✓ Daily quota for ${a.email}: ${a.daily_quota}/day`));
      } catch (e) {
        handleError(e);
      }
    });
}
