import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { createAddress, findAddressesByEmail, listAddresses, deleteAddress, getAddress, getAddressByEmail } from "../../db/addresses.js";
import { suspendAddress, activateAddress, setAddressQuota } from "../../db/address-lifecycle.js";
import { colorDnsStatus, tableRow, truncate } from "../../lib/format.js";
import { confirmDestructiveAction, formatListHint, handleError, isCliVerboseOutput, parseCliListPage, resolveId } from "../utils.js";
import {
  enrichAddresses,
  getAddressOwnershipDetail,
  getAddressOwnershipHistoryByRef,
  setAddressOwnerByRef,
  suggestAddressLocalParts,
  transferAddressOwnerByRef,
  unassignAddressOwnerByRef,
} from "../../lib/address-ownership.js";

// The local address PROVISIONING orchestration (S3/SES receive setup, the
// provisioning ledger) is owned by the self-hosted server and has no client-side
// equivalent, so `address provision` is kept for discoverability but fails loud.
//
// Address ownership is NOT in that category: `src/db/owners.ts` routes every
// ownership read/write to `src/db/owners.remote.ts`, which serves them from
// `/v1/owners`, `/v1/addresses/<id>` (owner_id/administrator_id) and
// `/v1/address-ownership-events`. Those subcommands run against the API in both
// modes.
function serverOnly(command: string): never {
  throw new Error(
    `${command} is not available in the self-hosted client; it runs on the self-hosted server.`,
  );
}

/** Upper bound for `address owner-history --limit`, mirroring the repo cap. */
const MAX_OWNER_HISTORY_LIMIT = 100;

/**
 * Provider label for display. The /v1 address entity carries no provider
 * association, so an empty provider_id means "served by the self-hosted server"
 * rather than "unknown provider".
 */
function providerLabel(address: { provider_name: string | null; provider_id: string }): string {
  return address.provider_name ?? (address.provider_id || "self_hosted");
}

/**
 * Describe the ownership an assign/transfer actually produced. Reads the
 * hydrated owner rows, so the confirmation line can never claim an owner the
 * server did not record.
 */
function describeOwnership(detail: { address: { owner: { name: string; type: string } | null; administrator: { name: string } | null } }): string {
  const { owner, administrator } = detail.address;
  if (!owner) return "has no owner recorded";
  const adminText = administrator ? `, administered by ${administrator.name}` : "";
  return `owned by ${owner.name} (${owner.type})${adminText}`;
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
      // Hydrate owner/administrator/provider_name from the mode-routed repos
      // instead of hardcoding nulls: an owned address must never be reported as
      // unowned, in the table or in --json.
      const addresses = enrichAddresses(listAddresses(opts.provider, page));
      if (addresses.length === 0) {
        output([], chalk.dim("No addresses configured."));
        return;
      }
      const verbose = opts.verbose || isCliVerboseOutput();
      const lines: string[] = [chalk.bold("\nAddresses:")];
      if (verbose) {
        for (const a of addresses) {
          const verifiedText = a.verified ? colorDnsStatus("verified") : colorDnsStatus("pending");
          const name = a.display_name ? ` (${a.display_name})` : "";
          const status = a.status === "suspended" ? chalk.red("suspended") : chalk.green("active");
          // The daily send ledger is server-owned, so show the configured LIMIT
          // only — never a client-side "used" count we cannot know.
          const quota = a.daily_quota !== null ? chalk.dim(`  quota limit ${a.daily_quota}/day`) : "";
          const owner = a.owner
            ? chalk.dim(`  owner ${a.owner.name} (${a.owner.type})`)
            : chalk.dim("  owner none");
          const administrator = a.administrator && (!a.owner || a.administrator.id !== a.owner.id)
            ? chalk.dim(`  admin ${a.administrator.name}`)
            : "";
          lines.push(`  ${chalk.cyan(a.id.slice(0, 8))}  ${a.email}${name}  [${verifiedText}] [${status}]${quota}${owner}${administrator}`);
        }
      } else {
        lines.push(tableRow(
          [chalk.bold("ID"), 8],
          [chalk.bold("Email"), 36],
          [chalk.bold("Provider"), 16],
          [chalk.bold("State"), 10],
          [chalk.bold("Owner"), 18],
        ));
        for (const a of addresses) {
          const state = `${a.verified ? "verified" : "pending"}/${a.status}`;
          const owner = a.owner
            ? `${a.owner.name}${a.administrator && a.administrator.id !== a.owner.id ? `:${a.administrator.name}` : ""}`
            : "-";
          lines.push(tableRow(
            [chalk.cyan(a.id.slice(0, 8)), 8],
            [truncate(a.email, 36), 36],
            [truncate(providerLabel(a), 16), 16],
            [state, 10],
            [truncate(owner, 18), 18],
          ));
        }
      }
      lines.push("");
      lines.push(formatListHint({
        shown: addresses.length,
        limit: page.limit,
        offset: page.offset,
        noun: "address",
        detailCommand: "use emails address owner <email-or-id> for ownership details",
        verbose,
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
    .action((ref: string) => {
      try {
        const detail = getAddressOwnershipDetail(ref);
        const owner = detail.address.owner;
        const administrator = detail.address.administrator;
        const lines = [chalk.bold(`\n${detail.address.email}`)];
        lines.push(`  ID:       ${detail.address.id}`);
        lines.push(`  Provider: ${providerLabel(detail.address)}`);
        lines.push(owner
          ? `  Owner:    ${owner.name} (${owner.type}) ${chalk.dim(owner.id)}`
          : `  Owner:    ${chalk.dim("none")}`);
        lines.push(administrator
          ? `  Admin:    ${administrator.name} (${administrator.type}) ${chalk.dim(administrator.id)}`
          : `  Admin:    ${chalk.dim("none")}`);
        const lastChange = detail.history[0];
        if (lastChange) {
          lines.push(`  Changed:  ${lastChange.action} at ${lastChange.created_at}${lastChange.actor ? ` by ${lastChange.actor}` : ""}`);
          if (lastChange.reason) lines.push(`  Reason:   ${lastChange.reason}`);
        }
        lines.push("");
        output(detail, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("set-owner <email-or-id>")
    .description("Assign address ownership; human owners require an agent administrator")
    .requiredOption("--owner <name-or-id>", "Owner name, ID, or ID prefix")
    .option("--administrator <name-or-id>", "Administering agent name, ID, or ID prefix")
    .action((ref: string, opts: { owner: string; administrator?: string }) => {
      try {
        const detail = setAddressOwnerByRef(ref, opts.owner, opts.administrator);
        output(detail, chalk.green(`✓ ${detail.address.email} ${describeOwnership(detail)}`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("transfer-owner <email-or-id>")
    .description("Explicitly transfer address ownership to another owner")
    .requiredOption("--owner <name-or-id>", "New owner name, ID, or ID prefix")
    .option("--administrator <name-or-id>", "Administering agent name, ID, or ID prefix")
    .requiredOption("--reason <reason>", "Reason recorded in the ownership audit log")
    .option("--actor <actor>", "Actor recorded in the ownership audit log", "cli")
    .option("--yes", "Skip confirmation prompt")
    .action(async (ref: string, opts: { owner: string; administrator?: string; reason: string; actor?: string; yes?: boolean }) => {
      try {
        const before = getAddressOwnershipDetail(ref);
        await confirmDestructiveAction(`Transfer owner for ${before.address.email} to ${opts.owner}?`, opts.yes);
        const detail = transferAddressOwnerByRef(ref, opts.owner, opts.administrator, { actor: opts.actor, reason: opts.reason });
        output(detail, chalk.green(`✓ ${detail.address.email} transferred — ${describeOwnership(detail)}`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("unassign-owner <email-or-id>")
    .description("Clear owner/admin assignment for an address")
    .requiredOption("--reason <reason>", "Reason recorded in the ownership audit log")
    .option("--actor <actor>", "Actor recorded in the ownership audit log", "cli")
    .option("--yes", "Skip confirmation prompt")
    .action(async (ref: string, opts: { reason: string; actor?: string; yes?: boolean }) => {
      try {
        const before = getAddressOwnershipDetail(ref);
        await confirmDestructiveAction(`Clear owner/admin assignment for ${before.address.email}?`, opts.yes);
        const detail = unassignAddressOwnerByRef(ref, { actor: opts.actor, reason: opts.reason });
        output(detail, chalk.green(`✓ ${detail.address.email} is now unowned`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("owner-history <email-or-id>")
    .description("Show ownership/admin change history for an address")
    .option("--limit <n>", "Maximum events to show", "20")
    .action((ref: string, opts: { limit: string }) => {
      try {
        const limit = Math.max(1, Math.min(MAX_OWNER_HISTORY_LIMIT, Number.parseInt(opts.limit, 10) || 20));
        const detail = getAddressOwnershipHistoryByRef(ref, limit);
        const lines = [chalk.bold(`\nOwnership history: ${detail.address.email}`)];
        if (detail.history.length === 0) {
          lines.push(chalk.dim("  No ownership changes recorded."));
        } else {
          for (const event of detail.history) {
            const owner = event.owner_id ? event.owner_id.slice(0, 8) : "none";
            const admin = event.administrator_id ? event.administrator_id.slice(0, 8) : "none";
            lines.push(`  ${event.created_at}  ${event.action}  owner=${owner} admin=${admin}${event.actor ? ` actor=${event.actor}` : ""}`);
            if (event.reason) lines.push(chalk.dim(`    ${event.reason}`));
          }
        }
        lines.push("");
        output(detail, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
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
