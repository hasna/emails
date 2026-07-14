import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { createAddress, findAddressesByEmail, listAddresses, deleteAddress, getAddress, getAddressByEmail } from "../../db/addresses.js";
import { suspendAddress, activateAddress, setAddressQuota } from "../../db/address-lifecycle.js";
import { tableRow, truncate } from "../../lib/format.js";
import { confirmDestructiveAction, formatListHint, handleError, isCliVerboseOutput, parseCliListPage, resolveId } from "../utils.js";

/** Pure sender-address suggestions for a domain (no local state; excludes existing). */
function suggestAddressLocalParts(domain: string, existingEmails: string[]): string[] {
  const normalized = domain.trim().toLowerCase();
  const used = new Set(
    existingEmails
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.endsWith(`@${normalized}`))
      .map((email) => email.split("@")[0]),
  );
  const candidates = [
    "hello", "hi", "contact", "support", "team", "admin", "inbox",
    "mail", "me", "bot", "agent", "verify", "accounts", "notify",
  ];
  return candidates.filter((local) => !used.has(local)).slice(0, 8).map((local) => `${local}@${normalized}`);
}

// Address ownership (owner/admin/audit history) and the local address
// provisioning orchestration (S3/SES receive setup, provisioning ledger) have
// no /v1 equivalent in this self-hosted-only client: they are owned by the
// self-hosted server. These commands are kept for discoverability but fail
// loud.
function serverOnly(command: string): never {
  throw new Error(
    `${command} is not available in the self-hosted client; it runs on the self-hosted server.`,
  );
}

function resolveSelfHostedAddressId(ref: string): string {
  const exact = getAddress(ref);
  if (exact) return exact.id;
  const matches = listAddresses(undefined, { limit: 1000 })
    .filter((address) => address.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    handleError(new Error(`Address ID is ambiguous: ${matches.map((address) => address.id.slice(0, 8)).join(", ")}`));
  }
  handleError(new Error(`Address not found: ${ref}`));
}

export function registerAddressCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const addressCmd = program.command("address").description("Manage sender email addresses");

  const listAddressesAction = (opts: { provider?: string; limit?: string; offset?: string; verbose?: boolean }) => {
    try {
      const page = parseCliListPage(opts);
      const addresses = listAddresses(opts.provider, page).map((address) => ({
        ...address,
        provider_name: null,
        owner: null,
        administrator: null,
      }));
      if (addresses.length === 0) {
        output([], chalk.dim("No addresses configured."));
        return;
      }
      const lines: string[] = [chalk.bold("\nAddresses:")];
      lines.push(tableRow(
        [chalk.bold("ID"), 8],
        [chalk.bold("Email"), 36],
        [chalk.bold("Provider"), 16],
        [chalk.bold("State"), 10],
        [chalk.bold("Owner"), 18],
      ));
      for (const a of addresses) {
        const state = `${a.verified ? "verified" : "pending"}/${a.status}`;
        lines.push(tableRow(
          [chalk.cyan(a.id.slice(0, 8)), 8],
          [truncate(a.email, 36), 36],
          [truncate(a.provider_id || "self_hosted", 16), 16],
          [state, 10],
          ["-", 18],
        ));
      }
      lines.push("");
      lines.push(formatListHint({
        shown: addresses.length,
        limit: page.limit,
        offset: page.offset,
        noun: "address",
        detailCommand: "use the self-hosted operator API for address lifecycle details",
        verbose: opts.verbose || isCliVerboseOutput(),
      }));
      output(addresses, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  };

  program
    .command("addresses")
    .description("List sender email addresses (alias: emails address list)")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Maximum addresses to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of addresses to skip", "0")
    .option("--verbose", "Show expanded owner/admin/quota fields")
    .action(listAddressesAction);

  addressCmd
    .command("add <email>")
    .description("Add a sender address")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--name <displayName>", "Display name")
    .action(async (email: string, opts: { provider: string; name?: string }) => {
      try {
        // Addresses are created directly on the app's /v1/addresses API. Providers
        // are a label carried through (the /v1 API exposes no /v1/providers), so we
        // do NOT resolve a local provider row or invoke a provider adapter.
        const existing = getAddressByEmail(opts.provider, email);
        if (existing) {
          output(existing, chalk.green(`✓ Address already exists: ${email} (${existing.id.slice(0, 8)})`));
          return;
        }
        const addr = createAddress({ provider_id: opts.provider, email, display_name: opts.name });
        output(addr, chalk.green(`✓ Address added: ${email} (${addr.id.slice(0, 8)})`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("list")
    .description("List sender addresses")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Maximum addresses to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of addresses to skip", "0")
    .option("--verbose", "Show expanded owner/admin/quota fields")
    .action(listAddressesAction);

  addressCmd
    .command("owner <email-or-id>")
    .description("Show owner and administering agent for an address")
    .action(() => {
      try { serverOnly("emails address owner"); } catch (e) { handleError(e); }
    });

  addressCmd
    .command("set-owner <email-or-id>")
    .description("Assign address ownership; human owners require an agent administrator")
    .requiredOption("--owner <name-or-id>", "Owner name, ID, or ID prefix")
    .option("--administrator <name-or-id>", "Administering agent name, ID, or ID prefix")
    .action(() => {
      try { serverOnly("emails address set-owner"); } catch (e) { handleError(e); }
    });

  addressCmd
    .command("transfer-owner <email-or-id>")
    .description("Explicitly transfer address ownership to another owner")
    .requiredOption("--owner <name-or-id>", "New owner name, ID, or ID prefix")
    .option("--administrator <name-or-id>", "Administering agent name, ID, or ID prefix")
    .requiredOption("--reason <reason>", "Reason recorded in the ownership audit log")
    .option("--actor <actor>", "Actor recorded in the ownership audit log", "cli")
    .option("--yes", "Skip confirmation prompt")
    .action(async () => {
      try { serverOnly("emails address transfer-owner"); } catch (e) { handleError(e); }
    });

  addressCmd
    .command("unassign-owner <email-or-id>")
    .description("Clear owner/admin assignment for an address")
    .requiredOption("--reason <reason>", "Reason recorded in the ownership audit log")
    .option("--actor <actor>", "Actor recorded in the ownership audit log", "cli")
    .option("--yes", "Skip confirmation prompt")
    .action(async () => {
      try { serverOnly("emails address unassign-owner"); } catch (e) { handleError(e); }
    });

  addressCmd
    .command("owner-history <email-or-id>")
    .description("Show ownership/admin change history for an address")
    .option("--limit <n>", "Maximum events to show", "20")
    .action(() => {
      try { serverOnly("emails address owner-history"); } catch (e) { handleError(e); }
    });

  addressCmd
    .command("suggest")
    .description("Suggest available sender addresses for a domain")
    .requiredOption("--domain <domain>", "Domain name")
    .action((opts: { domain: string }) => {
      try {
        const domain = opts.domain.trim().toLowerCase();
        const exists = listAddresses(undefined, { limit: 1000 }).map((address) => address.email);
        const suggestions = suggestAddressLocalParts(domain, exists);
        output({ domain, suggestions }, suggestions.length ? suggestions.join("\n") : chalk.dim(`No obvious suggestions left for ${domain}.`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("provision <email>")
    .description("Create an email address on a provisioned domain (alias of the address provisioning workflow)")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--domain <id>", "Domain ID (defaults to the address's domain if registered)")
    .option("--receive <strategy>", "Receive strategy: ses-s3 | cf-routing | resend-webhook", "ses-s3")
    .option("--forward-to <email>", "Forward target (for cf-routing)")
    .option("--owner <name|id>", "Owner (human or agent). Human owners require --administrator.")
    .option("--administrator <name|id>", "Administering agent (required for human owners; defaults to owner for agents)")
    .option("--dry-run", "Resolve inputs and show the planned change without writing address, provisioning, or ownership state")
    .option("--wait", "Advance provisioning now and wait until the address is ready to receive")
    .option("--timeout <sec>", "Max seconds to wait when --wait is used", "120")
    .option("--interval <sec>", "Seconds between readiness checks when --wait is used", "5")
    .option("--bucket <name>", "Inbound S3 bucket for receive validation (defaults to config inbound_s3_bucket)")
    .action(async () => {
      try { serverOnly("emails address provision"); } catch (e) { handleError(e); }
    });

  addressCmd
    .command("verify <email>")
    .description("Check verification status of an address")
    .option("--provider <id>", "Provider ID")
    .action(async (email: string, opts: { provider?: string }) => {
      try {
        // Providers are a label; the /v1 address record is the source of truth for
        // verification state — report its `verified` flag directly.
        const providerFilter = opts.provider;
        const found = findAddressesByEmail(email).find(
          (a) => !providerFilter || a.provider_id === providerFilter,
        );
        if (!found) handleError(new Error(`Address not found: ${email}`));
        if (found!.verified) {
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
        const resolvedId = resolveSelfHostedAddressId(id);
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
