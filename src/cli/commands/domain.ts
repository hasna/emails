import type { Command } from "commander";
import type { DomainType } from "../../types/index.js";
import chalk from "../../lib/chalk-lite.js";
import { createDomain, listDomains, listUsableDomains, deleteDomain, findDomainsByName, getDomain, getDomainByName, moveDomainProvider, updateDnsStatus, updateDomainReadiness } from "../../db/domains.js";
import { getProvider } from "../../db/providers.js";
import { createCatchAll, ensureDefaultCatchAll } from "../../db/aliases.js";
import { setDomainProvisioning } from "../../db/provisioning.js";
import { getAdapter } from "../../providers/index.js";
import { colorDnsStatus } from "../../lib/format.js";
import { confirmDestructiveAction, formatListHint, handleError, isCliVerboseOutput, parseCliListPage, resolveId } from "../utils.js";
import { normalizeRoute53RegistrationContact } from "../../lib/route53-contact.js";
import { resolveEmailsMode } from "../../lib/mode.js";
import { now } from "../../db/runtime.js";

// Domain provisioning that requires provider adapters (live SES/Resend calls),
// AWS/Cloudflare/BrandSight/Route53 DNS orchestration, live DNS/MX checks, the
// server-owned lifecycle-readiness ledger, or warming schedules has no /v1
// equivalent in this self-hosted-only client — it runs on the self-hosted
// server. Those commands are kept for discoverability but fail loud. Core
// domain CRUD (`add`/`list`/`remove`/`usable`/`move-provider`) and the operator
// `adopt` command route through the /v1 API.
function serverOnly(command: string): never {
  throw new Error(
    `${command} is not available in the self-hosted client; it runs on the self-hosted server.`,
  );
}

function normalizeDomainType(value: string | undefined): DomainType | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (["system", "self_hosted", "local_only"].includes(normalized)) return normalized as DomainType;
  handleError(new Error(`Invalid domain type '${value}'. Use system, self_hosted, or local_only.`));
}

function resolveSelfHostedDomainId(ref: string): string {
  const exact = getDomain(ref);
  if (exact) return exact.id;
  const matches = listDomains(undefined, { limit: 1000 })
    .filter((domain) => domain.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    handleError(new Error(`Domain ID is ambiguous: ${matches.map((domain) => domain.id.slice(0, 8)).join(", ")}`));
  }
  handleError(new Error(`Domain not found: ${ref}`));
}

export function registerDomainCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const domainCmd = program.command("domain").description("Manage sending domains");
  const domainsCmd = program.command("domains").description("Manage domain lifecycle");

  const listDomainsAction = (opts: { provider?: string; limit?: string; offset?: string; verbose?: boolean }) => {
    try {
      const page = parseCliListPage(opts);
      const domains = listDomains(opts.provider, page);
      if (domains.length === 0) {
        output([], chalk.dim("No domains configured."));
        return;
      }
      const lines: string[] = [chalk.bold("\nDomains:")];
      for (const d of domains) {
        const dkim = colorDnsStatus(d.dkim_status);
        const spf = colorDnsStatus(d.spf_status);
        const dmarc = colorDnsStatus(d.dmarc_status);
        lines.push(`  ${chalk.cyan(d.id.slice(0, 8))}  ${d.domain}  DKIM:${dkim}  SPF:${spf}  DMARC:${dmarc}`);
      }
      lines.push("");
      lines.push(formatListHint({
        shown: domains.length,
        limit: page.limit,
        offset: page.offset,
        noun: "domain",
        detailCommand: "use emails domain dns <domain> on the self-hosted server for DNS details",
        verbose: opts.verbose || isCliVerboseOutput(),
      }));
      output(domains, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  };

  const statusLifecycleAction = (domainOrId: string | undefined, opts: { provider?: string; limit?: string; offset?: string; verbose?: boolean }) => {
    try {
      // No local lifecycle data in the self-hosted client: list via the /v1 API,
      // or render the single matching domain's API record.
      if (!domainOrId) {
        listDomainsAction(opts);
        return;
      }
      const match = listDomains(undefined, { limit: 1000 })
        .find((d) => d.id === domainOrId || d.id.startsWith(domainOrId) || d.domain.toLowerCase() === domainOrId.toLowerCase());
      if (!match) {
        handleError(new Error(`Domain not found: ${domainOrId}`));
        return;
      }
      output(match, `${chalk.bold(`\nDomain ${match.domain}`)}\n  ID:   ${match.id.slice(0, 8)}\n  DNS:  DKIM:${colorDnsStatus(match.dkim_status)} SPF:${colorDnsStatus(match.spf_status)} DMARC:${colorDnsStatus(match.dmarc_status)}\n  ${chalk.dim("Full lifecycle readiness is served by the self-hosted operator API.")}\n`);
    } catch (e) {
      handleError(e);
    }
  };

  const addDomainAction = (
    domain: string,
    opts: { provider: string; dryRun?: boolean; domainType?: string; sourceOfTruth?: string },
    commandPrefix: "domain" | "domains",
  ) => {
    try {
      // The domain is created directly on the /v1/domains API. Providers are a
      // label carried through, so we do NOT resolve a local provider row or call
      // a provider adapter.
      const existing = getDomainByName(opts.provider, domain);
      const mode = resolveEmailsMode();
      const domainType = normalizeDomainType(opts.domainType) ?? "self_hosted";
      if (opts.dryRun) {
        output({
          dry_run: true,
          domain,
          provider_id: opts.provider,
          mode: mode.mode,
          provider: null,
          source_of_truth: "postgres",
          domain_type: domainType,
          existing: existing ? { id: existing.id, domain: existing.domain } : null,
          would_create_domain: !existing,
          would_call_provider: false,
          cli_equivalent: `emails ${commandPrefix} add ${domain} --provider ${opts.provider}`,
        }, existing
          ? chalk.dim(`Domain already exists: ${domain} (${existing.id.slice(0, 8)})`)
          : chalk.dim(`Would create ${domain} on the /v1 API (provider label ${opts.provider}).`));
        return;
      }
      if (existing) {
        output(existing, chalk.green(`✓ Domain already exists: ${domain} (${existing.id.slice(0, 8)})`));
        return;
      }
      const created = createDomain(opts.provider, domain);
      output(created, chalk.green(`✓ Domain added: ${domain} (${created.id.slice(0, 8)})`));
    } catch (e) {
      handleError(e);
    }
  };

  domainsCmd
    .action(() => listDomainsAction({}));

  domainsCmd
    .command("list")
    .description("List domains with lifecycle readiness")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Maximum domains to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of domains to skip", "0")
    .option("--verbose", "Show expanded lifecycle details")
    .action(listDomainsAction);

  domainsCmd
    .command("status [domain]")
    .description("Show domain lifecycle readiness")
    .option("--provider <id>", "Provider ID")
    .option("--limit <n>", "Maximum domains to show when no domain is passed")
    .option("--offset <n>", "Number of domains to skip when no domain is passed", "0")
    .option("--verbose", "Show expanded lifecycle details")
    .action(statusLifecycleAction);

  domainsCmd
    .command("add <domain>")
    .description("Add a domain to a provider")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--domain-type <type>", "Domain type: system, self_hosted, or local_only")
    .option("--source-of-truth <source>", "Source of truth: local or postgres")
    .option("--dry-run", "Resolve inputs and show the planned change without calling the provider or writing to the DB")
    .action((domain: string, opts: { provider: string; dryRun?: boolean; domainType?: string; sourceOfTruth?: string }) => addDomainAction(domain, opts, "domains"));

  domainsCmd
    .command("connect <domain>")
    .description("Connect an already-owned domain and generate DNS readiness tasks")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--domain-type <type>", "Domain type: system, self_hosted, or local_only")
    .option("--source-of-truth <source>", "Source of truth: local or postgres")
    .option("--dns-provider <provider>", "DNS provider label: manual, cloudflare, or route53", "manual")
    .option("--no-register-provider", "Do not call the mail provider to register the domain")
    .option("--dry-run", "Show the connection plan without calling the provider or writing to the DB")
    .action(() => { try { serverOnly("emails domains connect"); } catch (e) { handleError(e); } });

  domainsCmd
    .command("dns <domain>")
    .description("Show required DNS records and lifecycle context for a domain")
    .option("--provider <id>", "Provider ID")
    .action(() => { try { serverOnly("emails domains dns"); } catch (e) { handleError(e); } });

  domainsCmd
    .command("verify <domain>")
    .description("Re-verify domain DNS status and update lifecycle context")
    .option("--provider <id>", "Provider ID")
    .action(() => { try { serverOnly("emails domains verify"); } catch (e) { handleError(e); } });

  domainsCmd
    .command("check <domain>")
    .description("Live DNS check with per-domain authentication readiness")
    .option("--provider <id>", "Provider ID")
    .action(() => { try { serverOnly("emails domains check"); } catch (e) { handleError(e); } });

  domainsCmd
    .command("enable-inbound <domain>")
    .description("Mark a domain inbound-ready after provider/DNS routing is configured")
    .option("--provider <id>", "Provider ID")
    .option("--force", "Mark inbound ready even if local readiness checks are not yet verified")
    .action(() => { try { serverOnly("emails domains enable-inbound"); } catch (e) { handleError(e); } });

  domainsCmd
    .command("enable-outbound <domain>")
    .description("Enable outbound sending for a verified domain")
    .option("--provider <id>", "Provider ID")
    .option("--force", "Enable outbound even if local DKIM/SPF checks are not yet verified")
    .action(() => { try { serverOnly("emails domains enable-outbound"); } catch (e) { handleError(e); } });

  domainsCmd
    .command("disable-outbound <domain>")
    .description("Disable outbound sending for a domain")
    .option("--provider <id>", "Provider ID")
    .action(() => { try { serverOnly("emails domains disable-outbound"); } catch (e) { handleError(e); } });

  domainCmd
    .command("add <domain>")
    .description("Add a domain to a provider")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--domain-type <type>", "Domain type: system, self_hosted, or local_only")
    .option("--source-of-truth <source>", "Source of truth: local or postgres")
    .option("--dry-run", "Resolve inputs and show the planned change without calling the provider or writing to the DB")
    .action((domain: string, opts: { provider: string; dryRun?: boolean; domainType?: string; sourceOfTruth?: string }) => addDomainAction(domain, opts, "domain"));

  domainCmd
    .command("connect <domain>")
    .description("Connect an already-owned domain and generate DNS readiness tasks")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--domain-type <type>", "Domain type: system, self_hosted, or local_only")
    .option("--source-of-truth <source>", "Source of truth: local or postgres")
    .option("--dns-provider <provider>", "DNS provider label: manual, cloudflare, or route53", "manual")
    .option("--no-register-provider", "Do not call the mail provider to register the domain")
    .option("--dry-run", "Show the connection plan without calling the provider or writing to the DB")
    .action(() => { try { serverOnly("emails domain connect"); } catch (e) { handleError(e); } });

  // ── adopt: seamlessly add an already-registered & SES-verified domain ────────
  // Operator command. Domain/alias/provisioning writes route through the /v1 db
  // repos; SES/S3 wiring runs against the operator's own AWS credentials.
  domainCmd
    .command("adopt <domain>")
    .description("Add an already-registered, SES-verified domain: register it, wire SES inbound (S3), add a catch-all, and optionally sync")
    .requiredOption("--provider <id>", "SES provider where the domain is verified")
    .option("--no-inbound", "Skip SES inbound (S3 receipt rule) setup")
    .option("--bucket <name>", "Inbound S3 bucket (default: config, else emails-inbound-<accountId>)")
    .option("--region <region>", "AWS region (default: the provider's region)")
    .option("--catch-all <target>", "Route ALL mail for this domain to this address")
    .option("--sync", "Run an initial inbound sync after wiring")
    .option("--force-mx-switch", "Allow SES inbound setup even when public root MX belongs to another provider")
    .action(async (domain: string, opts: { provider: string; inbound?: boolean; bucket?: string; region?: string; catchAll?: string; sync?: boolean; forceMxSwitch?: boolean }) => {
      try {
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) return handleError(new Error(`Provider not found: ${opts.provider}`));

        const region = opts.region ?? provider.region ?? "us-east-1";
        const accessKeyId = provider.access_key ?? undefined;
        const secretAccessKey = provider.secret_key ?? undefined;
        const lines: string[] = [chalk.bold(`\nAdopting ${domain} → ${provider.name}`)];

        if (opts.inbound !== false && provider.type === "ses") {
          const { guardSesInboundMx } = await import("../../lib/mx-ownership.js");
          await guardSesInboundMx(domain, !!opts.forceMxSwitch);
        }

        // 1. Ensure the SES identity exists (idempotent if already verified).
        const adapter = getAdapter(provider);
        await adapter.addDomain(domain);
        lines.push(chalk.green(`✓ SES identity ensured`));

        // 2. Register in the emails store (/v1).
        const rec = getDomainByName(providerId, domain) ?? createDomain(providerId, domain);
        setDomainProvisioning(rec.id, {
          provisioning_status: "ses_identity_created",
          dns_provider: "cloudflare",
          send_provider: provider.type,
          last_error: null,
        });
        lines.push(chalk.green(`✓ Registered in Emails (${rec.id.slice(0, 8)})`));

        // 3. Record verification status.
        try {
          const st = await adapter.verifyDomain(domain);
          updateDnsStatus(rec.id, st.dkim, st.spf, st.dmarc);
          if (st.dkim === "verified") {
            setDomainProvisioning(rec.id, { provisioning_status: "verified", next_check_at: null, last_error: null });
          }
          lines.push(`  ${colorDnsStatus(st.dkim)} DKIM · ${colorDnsStatus(st.spf)} SPF · ${colorDnsStatus(st.dmarc)} DMARC`);
        } catch { /* non-fatal */ }

        // 4. Inbound — per provider.
        if (opts.inbound !== false && provider.type === "resend") {
          lines.push(chalk.green(`✓ Resend domain ready`));
          lines.push(chalk.dim(`  Inbound is push: add a Resend inbound webhook -> POST /webhook/resend-inbound on 'emails serve'`));
        }
        // 4a. SES inbound (S3 bucket + receipt rule → mail for *@domain lands in S3).
        if (opts.inbound !== false && provider.type === "ses") {
          // Bucket is account-specific — resolve the SES account for this provider
          // so domains in different accounts get the right bucket.
          let bucket = opts.bucket;
          if (!bucket) {
            const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
            const sts = new STSClient({ region, credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined });
            const acct = (await sts.send(new GetCallerIdentityCommand({}))).Account;
            bucket = `emails-inbound-${acct}`;
          }
          const { setupInboundEmail } = await import("../../lib/aws-inbound.js");
          const r = await setupInboundEmail({ domain, bucket, region, accessKeyId, secretAccessKey });
          lines.push(chalk.green(`✓ SES inbound → s3://${r.bucket}/${r.s3_prefix}`) + chalk.dim(` (rule ${r.rule_name}${r.bucket_created ? ", bucket created" : ""})`));
          lines.push(chalk.dim(`  Publish MX in DNS:  ${r.mx_record}  (for @${domain})`));
          // Register the bucket so 'inbox watch' / the TUI auto-pull sync it
          // (multi-bucket: domains can live in different AWS accounts).
          const { addInboundBucket } = await import("../../lib/config.js");
          addInboundBucket(r.bucket, region, providerId);
          const { registerS3Source } = await import("../../lib/s3-sync.js");
          const source = registerS3Source({
            bucket: r.bucket,
            prefix: r.s3_prefix,
            region,
            providerId,
            name: `${domain} SES/S3 inbound`,
            status: "live",
            liveSyncEnabled: true,
          });
          setDomainProvisioning(rec.id, { provisioning_status: "ready", next_check_at: null, last_error: null });
          updateDomainReadiness(rec.id, {
            provider_metadata: {
              inbound: {
                strategy: "ses-s3",
                bucket: r.bucket,
                prefix: r.s3_prefix,
                region,
                source_id: source.id,
                rule_set: r.rule_set,
                rule_name: r.rule_name,
              },
            },
            last_inbound_check_at: now(),
          });
        }

        // 5. Catch-all: the protected global catch-all already covers every domain;
        // optionally pin a domain-specific target.
        ensureDefaultCatchAll();
        if (opts.catchAll) {
          createCatchAll(domain, opts.catchAll);
          lines.push(chalk.green(`✓ catch-all *@${domain} → ${opts.catchAll}`));
        }

        // 6. Optional initial sync.
        if (opts.sync && opts.inbound !== false) {
          const { getInboundConfig } = await import("../../lib/config.js");
          const bucket = opts.bucket ?? getInboundConfig().bucket;
          if (bucket) {
            const { syncS3Inbox } = await import("../../lib/s3-sync.js");
            const sr = await syncS3Inbox({ bucket, prefix: `inbound/${domain}/`, region, providerId, limit: 500 });
            lines.push(chalk.green(`✓ Synced ${sr.synced} message(s)`) + (sr.errors.length ? chalk.yellow(` (${sr.errors.length} errors)`) : ""));
          }
        }

        lines.push(chalk.dim(`\n  Live mail:  emails inbox watch   ·   browse:  emails ui`));
        output({ domain, provider: provider.name, domain_id: rec.id }, lines.join("\n"));
      } catch (e) { handleError(e); }
    });

  domainCmd
    .command("list")
    .description("List domains")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Maximum domains to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of domains to skip", "0")
    .option("--verbose", "Show expanded list hints")
    .action(listDomainsAction);

  domainCmd
    .command("dns <domain>")
    .description("Show DNS records for a domain")
    .option("--provider <id>", "Provider ID (optional if domain is unambiguous)")
    .action(() => { try { serverOnly("emails domain dns"); } catch (e) { handleError(e); } });

  domainCmd
    .command("verify <domain>")
    .description("Re-verify domain DNS status")
    .option("--provider <id>", "Provider ID")
    .action(() => { try { serverOnly("emails domain verify"); } catch (e) { handleError(e); } });

  domainCmd
    .command("status")
    .description("Show domain readiness summary table")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Maximum domains to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of domains to skip", "0")
    .option("--verbose", "Show per-domain issues and first fix command")
    .action(() => { try { serverOnly("emails domain status"); } catch (e) { handleError(e); } });

  domainCmd
    .command("usable")
    .description("List domains usable for sending and/or receiving")
    .option("--receive", "Only domains ready to receive")
    .option("--send", "Only domains ready to send")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Maximum domains to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of domains to skip after filtering", "0")
    .option("--verbose", "Show expanded list hints")
    .action((opts: { receive?: boolean; send?: boolean; provider?: string; limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        const page = parseCliListPage(opts);
        // A verified domain sends and receives in the self-hosted model; the /v1
        // usable filter keys off verification.
        const domains = listUsableDomains({
          provider_id: opts.provider,
          send: opts.send,
          receive: opts.receive,
          limit: page.limit,
          offset: page.offset,
        });
        const lines = domains.length ? [chalk.bold("\nUsable domains:")] : [chalk.dim("No usable domains found.")];
        for (const d of domains) {
          lines.push(`  ${chalk.cyan(d.domain)}  ${chalk.dim(d.provider_id.slice(0, 8))}  ${chalk.green("send+receive")}`);
        }
        lines.push("");
        lines.push(formatListHint({
          shown: domains.length,
          limit: page.limit,
          offset: page.offset,
          noun: "domain",
          detailCommand: "domains are usable once verified on the self-hosted server",
          verbose: opts.verbose || isCliVerboseOutput(),
        }));
        output(domains, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("move-provider <domain>")
    .description("Move an existing domain and its addresses to another provider")
    .requiredOption("--to-provider <id>", "Target provider ID")
    .option("--from-provider <id>", "Source provider ID; required if the domain exists on multiple providers")
    .option("--dry-run", "Show the planned provider move without mutating state")
    .option("--yes", "Skip confirmation prompt")
    .action(async (domainName: string, opts: { toProvider: string; fromProvider?: string; dryRun?: boolean; yes?: boolean }) => {
      try {
        const toProviderId = resolveId("providers", opts.toProvider);
        const toProvider = getProvider(toProviderId);
        if (!toProvider) handleError(new Error(`Provider not found: ${opts.toProvider}`));

        let domain;
        if (opts.fromProvider) {
          const fromProviderId = resolveId("providers", opts.fromProvider);
          domain = getDomainByName(fromProviderId, domainName);
          if (!domain) handleError(new Error(`Domain not found for source provider: ${domainName}`));
        } else {
          const matches = findDomainsByName(domainName);
          if (matches.length === 0) handleError(new Error(`Domain not found: ${domainName}`));
          if (matches.length > 1) {
            const choices = matches.map((d) => `${d.id.slice(0, 8)} provider=${d.provider_id.slice(0, 8)}`).join(", ");
            handleError(new Error(`Domain is ambiguous; pass --from-provider. Matches: ${choices}`));
          }
          domain = matches[0];
        }

        const plan = {
          domain: domain!.domain,
          domain_id: domain!.id,
          from_provider_id: domain!.provider_id,
          to_provider_id: toProviderId,
          to_provider_name: toProvider!.name,
        };

        if (opts.dryRun) {
          output({ dry_run: true, ...plan }, chalk.dim(`Would move ${domain!.domain} to ${toProvider!.name}. Address reassignment is handled server-side.`));
          return;
        }

        await confirmDestructiveAction(`Move ${domain!.domain} to ${toProvider!.name}?`, opts.yes);
        const result = moveDomainProvider(domain!.id, toProviderId);
        output({ ...plan, ...result }, chalk.green(`✓ Moved ${domain!.domain} to ${toProvider!.name}; server owns address reassignment.`));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("remove <id>")
    .description("Remove a domain")
    .option("--yes", "Skip confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      try {
        const resolvedId = resolveSelfHostedDomainId(id);
        const domain = getDomain(resolvedId);
        if (!domain) handleError(new Error(`Domain not found: ${id}`));
        await confirmDestructiveAction(`Remove domain ${domain.domain}?`, opts.yes);
        deleteDomain(resolvedId);
        console.log(chalk.green(`✓ Domain removed: ${domain.domain}`));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("check <domain>")
    .description("Live DNS check — verify actual DNS records against expected")
    .option("--provider <id>", "Provider ID")
    .action(() => { try { serverOnly("emails domain check"); } catch (e) { handleError(e); } });

  // ─── DNS / WARMING SETUP (server-side) ─────────────────────────────────────

  domainCmd
    .command("setup-cloudflare <domain>")
    .description("Auto-create DNS records in Cloudflare for email sending (DKIM, SPF, DMARC)")
    .requiredOption("--provider <id>", "SES or Resend provider ID")
    .option("--cloudflare-token <token>", "Cloudflare API token (falls back to config/env)")
    .option("--mx", "Also add MX record for receiving email")
    .option("--mx-server <host>", "Custom MX server hostname")
    .option("--register-ses", "Register the domain with SES first if not already added")
    .option("--force-mx-switch", "Allow adding MX even when existing root MX belongs to another provider")
    .action(() => { try { serverOnly("emails domain setup-cloudflare"); } catch (e) { handleError(e); } });

  domainCmd
    .command("setup-brandsight <domain>")
    .description("Auto-create DNS records in BrandSight/GCD for email sending and SES receiving")
    .requiredOption("--provider <id>", "SES or Resend provider ID")
    .option("--api-key <key>", "BrandSight API key (falls back to config/env)")
    .option("--api-secret <secret>", "BrandSight API secret (falls back to config/env)")
    .option("--customer-id <id>", "BrandSight customer ID (falls back to config/env)")
    .option("--mx", "Also add SES inbound MX record for receiving email")
    .option("--mail-from <subdomain>", "Custom SES MAIL FROM subdomain (default mail.<domain>)")
    .option("--no-set-nameservers", "Do not switch the registrar nameservers to BrandSight/GCD")
    .option("--remove-dnssec", "Remove stale registrar DNSSEC records before/while switching to unsigned BrandSight DNS")
    .option("--force-mx-switch", "Allow adding SES inbound MX even when existing root MX belongs to another provider")
    .action(() => { try { serverOnly("emails domain setup-brandsight"); } catch (e) { handleError(e); } });

  domainCmd
    .command("warm <domain>")
    .description("Start a warming schedule for a domain")
    .requiredOption("--target <n>", "Target daily send volume", parseInt)
    .option("--start-date <YYYY-MM-DD>", "Start date (default: today)")
    .option("--provider <id>", "Provider ID to associate")
    .action(() => { try { serverOnly("emails domain warm"); } catch (e) { handleError(e); } });

  domainCmd
    .command("warm-status <domain>")
    .description("Show warming schedule status for a domain")
    .action(() => { try { serverOnly("emails domain warm-status"); } catch (e) { handleError(e); } });

  domainCmd
    .command("warm-list")
    .description("List all domain warming schedules")
    .option("--status <status>", "Filter by status (active, paused, completed)")
    .option("--limit <n>", "Maximum schedules to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of schedules to skip", "0")
    .option("--verbose", "Show expanded list hints")
    .action(() => { try { serverOnly("emails domain warm-list"); } catch (e) { handleError(e); } });

  domainCmd
    .command("warm-pause <domain>")
    .description("Pause a domain warming schedule")
    .action(() => { try { serverOnly("emails domain warm-pause"); } catch (e) { handleError(e); } });

  domainCmd
    .command("warm-resume <domain>")
    .description("Resume a paused domain warming schedule")
    .action(() => { try { serverOnly("emails domain warm-resume"); } catch (e) { handleError(e); } });

  domainCmd
    .command("warm-complete <domain>")
    .description("Mark a domain warming schedule as completed")
    .action(() => { try { serverOnly("emails domain warm-complete"); } catch (e) { handleError(e); } });

  // ─── DOMAIN PURCHASING (via @hasna/domains / Route 53) ───────────────────

  domainCmd
    .command("available <domain>")
    .description("Check if a domain is available for purchase and get pricing")
    .action(async (domain: string) => {
      try {
        const { r53CheckAvailability } = await import("@hasna/domains");
        const result = await r53CheckAvailability(domain);
        if (result.available) {
          const price = result.price ? chalk.green(` — ${result.currency ?? "USD"} ${result.price}/yr`) : "";
          console.log(chalk.green(`✓ ${domain} is available${price}`));
        } else {
          console.log(chalk.red(`✗ ${domain} is not available`));
        }
        output(result, "");
      } catch (e) { handleError(e); }
    });

  domainCmd
    .command("buy <domain>")
    .description("Purchase a domain via Route 53")
    .requiredOption("--email <email>", "Registrant email")
    .requiredOption("--first-name <name>", "First name")
    .requiredOption("--last-name <name>", "Last name")
    .requiredOption("--phone <phone>", "Phone in E.164 format (e.g. +1.5551234567)")
    .requiredOption("--address <addr>", "Street address")
    .requiredOption("--city <city>", "City")
    .option("--state <state>", "State/province; optional and omitted for countries where Route 53 rejects it")
    .requiredOption("--country <code>", "Two-letter country code (e.g. US, RO)")
    .requiredOption("--zip <zip>", "ZIP/postal code")
    .option("--org <name>", "Organization name")
    .option("--years <n>", "Registration years", "1")
    .action(async (domain: string, opts: {
      email: string; firstName: string; lastName: string;
      phone: string; address: string; city: string; state?: string;
      country: string; zip: string; org?: string; years: string;
    }) => {
      try {
        const { r53CheckAvailability, r53RegisterDomain } = await import("@hasna/domains");
        console.log(chalk.dim(`Checking availability of ${domain}...`));
        const avail = await r53CheckAvailability(domain);
        if (!avail.available) { console.error(chalk.red(`✗ ${domain} is not available`)); process.exit(1); }
        const price = avail.price ? ` (${avail.currency ?? "USD"} ${avail.price}/yr)` : "";
        console.log(chalk.green(`  ✓ Available${price}`));
        const contact = normalizeRoute53RegistrationContact({
          first_name: opts.firstName, last_name: opts.lastName,
          email: opts.email, phone: opts.phone,
          address_line_1: opts.address, city: opts.city,
          state: opts.state, country_code: opts.country,
          zip_code: opts.zip, organization_name: opts.org,
        });
        const result = await r53RegisterDomain(domain, contact as Parameters<typeof r53RegisterDomain>[1], parseInt(opts.years));
        console.log(chalk.green(`✓ Registration submitted for ${domain}`));
        console.log(chalk.dim(`  Operation ID: ${result.operationId}`));
        console.log(chalk.dim(`  Check status: emails domain purchase-status ${result.operationId}`));
        output(result, "");
      } catch (e) { handleError(e); }
    });

  domainCmd
    .command("purchase-status <operationId>")
    .description("Check domain registration/purchase status")
    .action(async (operationId: string) => {
      try {
        const { r53GetRegistrationStatus } = await import("@hasna/domains");
        const result = await r53GetRegistrationStatus(operationId);
        const color = result.status === "SUCCESSFUL" ? chalk.green : result.status === "FAILED" ? chalk.red : chalk.yellow;
        console.log(`Status: ${color(result.status)}`);
        if (result.domain) console.log(`Domain: ${result.domain}`);
        if (result.message) console.log(`Message: ${result.message}`);
        output(result, "");
      } catch (e) { handleError(e); }
    });

  domainCmd
    .command("list-registered")
    .description("List domains registered in Route 53")
    .action(async () => {
      try {
        const { r53ListRegisteredDomains } = await import("@hasna/domains");
        const domains = await r53ListRegisteredDomains();
        if (domains.length === 0) { output([], chalk.dim("No domains registered in Route 53.")); return; }
        const lines = [chalk.bold("\nRegistered domains:")];
        for (const d of domains) {
          const expiry = d.expiry ? chalk.dim(` — expires ${d.expiry.split("T")[0]}`) : "";
          const renew = d.auto_renew ? chalk.green(" [auto-renew]") : "";
          lines.push(`  ${chalk.cyan(d.domain)}${expiry}${renew}`);
        }
        lines.push("");
        output(domains, lines.join("\n"));
      } catch (e) { handleError(e); }
    });

  domainCmd
    .command("setup <domain>")
    .description("Full setup: buy + Route 53 zone + register with SES + configure DNS (DKIM/SPF/DMARC)")
    .requiredOption("--provider <id>", "SES or Resend provider ID")
    .requiredOption("--email <email>", "Registrant email")
    .requiredOption("--first-name <name>", "First name")
    .requiredOption("--last-name <name>", "Last name")
    .requiredOption("--phone <phone>", "Phone (e.g. +1.5551234567)")
    .requiredOption("--address <addr>", "Street address")
    .requiredOption("--city <city>", "City")
    .option("--state <state>", "State/province; optional and omitted for countries where Route 53 rejects it")
    .requiredOption("--country <code>", "Country code (e.g. US, RO)")
    .requiredOption("--zip <zip>", "ZIP code")
    .option("--org <name>", "Organization name")
    .option("--years <n>", "Registration years", "1")
    .option("--skip-buy", "Skip domain purchase (domain already registered)")
    .action(() => { try { serverOnly("emails domain setup"); } catch (e) { handleError(e); } });
}
