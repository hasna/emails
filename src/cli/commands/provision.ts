import type { Command } from "commander";
import chalk from "chalk";
import { getProvider } from "../../db/providers.js";
import { getDatabase } from "../../db/database.js";
import { getAdapter } from "../../providers/index.js";
import { createDomain, getDomainByName, listDomains } from "../../db/domains.js";
import { createAddress, getAddressByEmail, listAddresses } from "../../db/addresses.js";
import {
  setDomainProvisioning, getDomainProvisioning,
  setAddressProvisioning, getAddressProvisioning,
  listProvisioningEvents,
} from "../../db/provisioning.js";
import { handleError, resolveId } from "../utils.js";

type ReceiveStrategy = "ses-s3" | "cf-routing" | "resend-webhook";

export function registerProvisionCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const cmd = program.command("provision").description("Automated domain + address provisioning");

  // ── status ────────────────────────────────────────────────────────────────
  cmd
    .command("status [domain]")
    .description("Show provisioning status of domains and addresses")
    .action((domainName?: string) => {
      const db = getDatabase();
      const domains = listDomains(undefined, db).filter((d) => !domainName || d.domain === domainName);
      const lines: string[] = [];
      for (const d of domains) {
        const p = getDomainProvisioning(d.id, db);
        lines.push(`${chalk.bold(d.domain)}  ${chalk.cyan(p?.provisioning_status ?? "none")}  dns=${p?.dns_provider ?? "?"}  send=${p?.send_provider ?? "-"}${p?.last_error ? chalk.red(" err=" + p.last_error) : ""}`);
        const addrs = listAddresses(undefined, db).filter((a) => getAddressProvisioning(a.id, db)?.domain_id === d.id);
        for (const a of addrs) {
          const ap = getAddressProvisioning(a.id, db);
          lines.push(`  ${a.email}  ${chalk.cyan(ap?.provisioning_status ?? "none")}  recv=${ap?.receive_strategy ?? "-"}`);
        }
      }
      const text = lines.length ? lines.join("\n") : "No provisioned domains.";
      output({ domains: domains.map((d) => ({ domain: d.domain, provisioning: getDomainProvisioning(d.id, db) })) }, text);
    });

  // ── address create ─────────────────────────────────────────────────────────
  cmd
    .command("address <email>")
    .description("Create an email address on a provisioned domain")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--domain <id>", "Domain ID (defaults to the address's domain if registered)")
    .option("--receive <strategy>", "Receive strategy: ses-s3 | cf-routing | resend-webhook", "ses-s3")
    .option("--forward-to <email>", "Forward target (for cf-routing)")
    .action(async (email: string, opts: { provider: string; domain?: string; receive: string; forwardTo?: string }) => {
      try {
        const db = getDatabase();
        const providerId = resolveId("providers", opts.provider);
        if (!getProvider(providerId)) handleError(new Error(`Provider not found: ${opts.provider}`));
        const addr = getAddressByEmail(providerId, email, db) ?? createAddress({ provider_id: providerId, email }, db);
        const domainName = email.split("@")[1];
        const domainId = opts.domain ? resolveId("domains", opts.domain) : (domainName ? getDomainByName(providerId, domainName, db)?.id ?? null : null);
        setAddressProvisioning(addr.id, {
          domain_id: domainId,
          receive_strategy: opts.receive as ReceiveStrategy,
          forward_to: opts.forwardTo ?? null,
          provisioning_status: "requested",
          next_check_at: new Date().toISOString(),
        }, db);
        output({ id: addr.id, email, receive: opts.receive }, chalk.green(`✓ address ${email} provisioned (receive=${opts.receive})`));
      } catch (e) { handleError(e); }
    });

  // ── domain setup ─────────────────────────────────────────────────────────
  cmd
    .command("domain <domain>")
    .description("Provision a domain for sending: SES identity + publish DNS in Cloudflare")
    .requiredOption("--provider <id>", "SES provider ID")
    .option("--send <provider>", "Send provider", "ses")
    .option("--add-mx", "Also publish inbound MX (ses-s3 receive)")
    .action(async (domain: string, opts: { provider: string; send: string; addMx?: boolean }) => {
      try {
        const db = getDatabase();
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));
        const rec = getDomainByName(providerId, domain, db) ?? createDomain(providerId, domain, db);
        setDomainProvisioning(rec.id, { provisioning_status: "ses_identity_created", send_provider: opts.send, dns_provider: "cloudflare" }, db);

        const adapter = getAdapter(provider!);
        await adapter.addDomain(domain);
        const { setupEmailDns } = await import("../../lib/cloudflare-dns.js");
        const dns = await setupEmailDns({ domain, provider: provider!, addMx: !!opts.addMx });
        setDomainProvisioning(rec.id, { provisioning_status: "dns_published", next_check_at: new Date().toISOString() }, db);
        output(
          { domain, dns },
          chalk.green(`✓ ${domain}: SES identity created, ${dns.created} DNS records published to Cloudflare. Verify: emails domain verify ${domain} --provider ${opts.provider}`),
        );
      } catch (e) { handleError(e); }
    });

  // ── retry ───────────────────────────────────────────────────────────────
  cmd
    .command("retry <domain>")
    .description("Re-queue a domain for the provisioning daemon (clear error, check now)")
    .option("--provider <id>", "Provider ID")
    .action((domain: string, opts: { provider?: string }) => {
      const db = getDatabase();
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const rec = providerId ? getDomainByName(providerId, domain, db) : listDomains(undefined, db).find((d) => d.domain === domain);
      if (!rec) return handleError(new Error(`Domain not found: ${domain}`));
      setDomainProvisioning(rec.id, { last_error: null, next_check_at: new Date().toISOString() }, db);
      const events = listProvisioningEvents("domain", rec.id, db);
      output({ domain, requeued: true, events: events.length }, chalk.green(`✓ ${domain} re-queued (${events.length} prior events)`));
    });
}
