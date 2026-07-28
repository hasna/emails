import type { Command } from "commander";
import type { DnsRecord, DomainType, Provider } from "../../types/index.js";
import chalk from "../../lib/chalk-lite.js";
import { createDomain, listDomains, listUsableDomains, deleteDomain, findDomainsByName, getDomain, getDomainByName, moveDomainProvider, updateDnsStatus, updateDomainReadiness } from "../../db/domains.js";
import { getProvider } from "../../db/providers.js";
import { createCatchAll, ensureDefaultCatchAll } from "../../db/aliases.js";
import { setDomainProvisioning } from "../../db/provisioning.js";
import { getAdapter, providerDnsPublishing } from "../../providers/index.js";
import { createWarmingSchedule, deleteWarmingSchedule, getWarmingSchedule, listWarmingSchedules, updateWarmingStatus } from "../../db/warming.js";
import { describeWarmingProgress, formatWarmingStatus, generateWarmingPlan, getTodaySentCountsByDomain, type WarmingSchedule } from "../../lib/warming.js";
import { colorDnsStatus, tableRow, truncate } from "../../lib/format.js";
import { confirmDestructiveAction, formatListHint, handleError, isCliVerboseOutput, parseCliListPage, resolveId } from "../utils.js";
import { normalizeRoute53RegistrationContact } from "../../lib/route53-contact.js";
import { resolveEmailsMode } from "../../lib/mode.js";
import { now } from "../../db/runtime.js";

// Every domain command below used to throw one sentence — "… is not available
// in the self-hosted client; it runs on the self-hosted server" — from a single
// `serverOnly()` helper, and the sentence was false in both halves:
//
//   * It fired UNCONDITIONALLY. `emails domain check example.com` printed it in
//     LOCAL mode, naming a client the operator was not running.
//   * There is no self-hosted server route behind any of them. `openapi.ts`
//     defines plain CRUD for `/v1/domains` and `/v1/addresses` and nothing else
//     for this surface: no verify route, no DNS route, no readiness route, no
//     provisioning orchestrator. Pointing at a server was pointing at nothing.
//
// So a refusal here now says what is MISSING and what to run instead, and never
// names a deployment mode. `emails provision *` was fixed to this shape first;
// this table is the same contract for the domain surface, and it is a table
// rather than one string because the commands are in different situations and a
// single sentence could only be true of one of them.
//
// The four read-only DNS commands (`domain check`, `domains check`, `domain
// dns`, `domains dns`) are no longer in the table at all: their implementations
// (src/lib/dns.ts, src/lib/dns-check.ts, src/lib/mx-ownership.ts) are pure,
// tested, mode-free library code that was simply never wired to a command, so
// they are wired below instead of being explained away.
interface UnshippedSurface {
  /** What does not exist, stated without blaming a configuration. */
  missing: string;
  /** A command (or commands) that DO run and get the operator closer. */
  instead: string;
}

const UNSHIPPED_DOMAIN_SURFACES: Record<string, UnshippedSurface> = {
  "emails domain connect": {
    missing: "the connect orchestration — register the domain, call the provider, then emit DNS "
      + "readiness tasks — was removed and nothing replaced it",
    instead: "Do those steps explicitly: 'emails domain add <domain> --provider <id>', then "
      + "'emails domain dns <domain>' for the records to publish, then "
      + "'emails domain adopt <domain> --provider <id>' once the provider has verified it.",
  },
  "emails domain verify": {
    missing: "no command is wired to the provider's verification API",
    // "needs no provider" was FALSE and this file is the one place it must not be:
    // `emails domain check` resolves the domain's registered provider when it has
    // one, and only falls back to the generic SPF/DMARC pair when none resolves.
    // `--json` returns a non-null `provider_id` for any registered domain.
    instead: "'emails domain adopt <domain> --provider <id>' re-checks the provider and records "
      + "DKIM/SPF/DMARC through the same adapter; 'emails domain check <domain>' reads the "
      + "published DNS, resolving the domain's provider for DKIM when it has one and reporting "
      + "SPF/DMARC alone when it does not.",
  },
  "emails domain status": {
    missing: "no command is wired to the domain lifecycle-readiness ledger; it is reachable only "
      + "from the library export and the HTTP readiness API (GET /api/domains/readiness)",
    instead: "'emails domains status [domain]' renders the domain records this client holds, and "
      + "'emails domain check <domain>' reports live DNS readiness.",
  },
  "emails domains enable-inbound": {
    missing: "no command is wired to the readiness ledger; the transition ships only as a library "
      + "export and on the HTTP readiness API (PATCH /api/domains/:id/readiness)",
    instead: "'emails domain adopt <domain> --provider <id>' wires SES inbound and marks the "
      + "domain ready when it succeeds; 'emails aws setup-inbound --domain <domain>' does the "
      + "S3 + receipt-rule half on its own.",
  },
  "emails domains enable-outbound": {
    missing: "no command is wired to the readiness ledger; the transition ships only as a library "
      + "export and on the HTTP readiness API (PATCH /api/domains/:id/readiness)",
    instead: "'emails domain check <domain>' reports whether DKIM and SPF are actually published, "
      + "which is the evidence the transition would have required.",
  },
  "emails domains disable-outbound": {
    missing: "no command is wired to the readiness ledger; the transition ships only as a library "
      + "export and on the HTTP readiness API (PATCH /api/domains/:id/readiness)",
    instead: "To stop mail from an address today, suspend it: 'emails address suspend <id>'.",
  },
  "emails domain setup-cloudflare": {
    missing: "the Cloudflare DNS writer ships as a library but no command is wired to it, because "
      + "it would publish records using whatever provider and Cloudflare credentials the calling "
      + "machine happens to have",
    instead: "Publish the records from 'emails domain dns <domain>' yourself, then confirm them "
      + "with 'emails domain check <domain>'.",
  },
  "emails domain setup": {
    missing: "the buy -> zone -> provider -> DNS orchestration does not ship",
    instead: "Run the steps that do: 'emails domain available <domain>', 'emails domain buy "
      + "<domain> ...', then 'emails domain adopt <domain> --provider <id>' once the provider "
      + "has verified it.",
  },
};

// Plural aliases refuse for exactly the same reason as their singular twins, so
// they share one entry instead of drifting apart.
const UNSHIPPED_DOMAIN_ALIASES: Record<string, string> = {
  "emails domains connect": "emails domain connect",
  "emails domains verify": "emails domain verify",
};

function notImplementedAnywhere(command: string): never {
  const entry = UNSHIPPED_DOMAIN_SURFACES[UNSHIPPED_DOMAIN_ALIASES[command] ?? command];
  // Unreachable while the table covers every call site; a bare, honest sentence
  // beats a `undefined` splice if a command is ever added without an entry.
  if (!entry) throw new Error(`${command} is not implemented in this build.`);
  throw new Error(`${command} is not implemented in this build: ${entry.missing}. ${entry.instead}`);
}

/**
 * The DNS records `domain` is expected to publish.
 *
 * Mirrors the MCP `get_dns_records` tool: the provider's own records when a
 * provider resolves (explicitly, or from the domain's registration), otherwise
 * the generic SES SPF + DMARC pair, which needs no credentials at all. Both
 * `dns` and `check` need exactly this, so they share it rather than each
 * growing their own resolution rules.
 */
async function expectedDnsRecords(
  domain: string,
  providerRef: string | undefined,
): Promise<{ records: DnsRecord[]; providerId: string | null; provider: Provider | null; dkimUnavailable: string | null }> {
  let provider = null;
  if (providerRef) {
    const providerId = resolveId("providers", providerRef);
    provider = getProvider(providerId);
    if (!provider) handleError(new Error(`Provider not found: ${providerRef}`));
  } else {
    const registered = findDomainsByName(domain)[0];
    if (registered) provider = getProvider(registered.provider_id);
  }
  const generic = async (): Promise<DnsRecord[]> => {
    const { generateSpfRecord, generateDmarcRecord } = await import("../../lib/dns.js");
    return [generateSpfRecord(domain), generateDmarcRecord(domain)];
  };
  if (!provider) {
    return { records: await generic(), providerId: null, provider: null, dkimUnavailable: null };
  }
  // The provider itself is returned, not just its id: `formatDnsTable` needs the
  // `DnsPublishingSupport` descriptor to say anything true about an EMPTY table,
  // and `providerDnsPublishing()` is the only producer of one.
  //
  // `getAdapter` throws when the row cannot configure an adapter, and one such
  // row is NOT an operator error: `apiToProvider` in src/db/providers.remote.ts
  // maps every credential column to null on purpose — provider secrets are never
  // distributed to a client — so in self_hosted mode EVERY Resend provider hits
  // `assertProviderConfig`'s "Resend provider requires an API key". Letting that
  // escape turned a read-only question into an exit-1 whose suggested fix was to
  // go configure a client-side key that structurally cannot live there.
  //
  // The domain's SPF and DMARC do not depend on the provider account at all, so
  // answer with those and say plainly that DKIM is the part that is missing and
  // why. A wrong-but-real credential (a rejected key, a throttled call) still
  // surfaces from the adapter itself, which is where it belongs.
  let adapter;
  try {
    adapter = getAdapter(provider);
  } catch (e) {
    return {
      records: await generic(),
      providerId: provider.id,
      provider,
      dkimUnavailable: e instanceof Error ? e.message : String(e),
    };
  }
  return { records: await adapter.getDnsRecords(domain), providerId: provider.id, provider, dkimUnavailable: null };
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
        detailCommand: "use emails domain dns <domain> for DNS details",
        verbose: opts.verbose || isCliVerboseOutput(),
      }));
      output(domains, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  };

  const statusLifecycleAction = (domainOrId: string | undefined, opts: { provider?: string; limit?: string; offset?: string; verbose?: boolean }) => {
    try {
      // There is no lifecycle-readiness ledger this client can read, in any
      // configuration: list the domain records, or render the single match.
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
      output(match, `${chalk.bold(`\nDomain ${match.domain}`)}\n  ID:   ${match.id.slice(0, 8)}\n  DNS:  DKIM:${colorDnsStatus(match.dkim_status)} SPF:${colorDnsStatus(match.spf_status)} DMARC:${colorDnsStatus(match.dmarc_status)}\n  ${chalk.dim(`Live DNS readiness: emails domain check ${match.domain}`)}\n`);
    } catch (e) {
      handleError(e);
    }
  };

  // ── dns / check: read-only, wired to the libraries that always implemented them ──
  // Neither command needs a server or a mode. `src/lib/dns.ts` builds the
  // expected records, `src/lib/dns-check.ts` resolves what is actually published
  // and grades the authentication signals, and `src/lib/mx-ownership.ts` names
  // who owns root MX — all pure, all covered by their own suites, and all
  // previously unreachable from any command.

  const dnsAction = async (domain: string, opts: { provider?: string }) => {
    try {
      const { records, providerId, provider, dkimUnavailable } = await expectedDnsRecords(domain, opts.provider);
      const { formatDnsTable } = await import("../../lib/dns.js");
      // An empty table is ambiguous on its own — a provider type that publishes no
      // DNS records at all, a domain not yet added to a provider that does, and a
      // provider lookup that failed all arrive here as `[]`. `providerDnsPublishing`
      // is what distinguishes the first from the other two. Asked only when the
      // table is empty AND a provider resolved, exactly as the MCP `get_dns_records`
      // twin does it: a provider type `getAdapter()` accepts but the descriptor does
      // not would otherwise turn a good table into a throw.
      const support = records.length === 0 && provider && !dkimUnavailable
        ? providerDnsPublishing(provider)
        : undefined;
      const lines = [chalk.bold(`\nDNS records for ${domain}:`), "", formatDnsTable(records, support)];
      if (!providerId) {
        // Said out loud: without a provider these are the generic SES SPF/DMARC
        // pair, NOT the domain's DKIM records. Silently omitting DKIM would read
        // as "no DKIM required".
        lines.push(chalk.dim("  No provider resolved — showing generic SPF/DMARC only."));
        lines.push(chalk.dim(`  Pass --provider <id> to include the provider's DKIM records.`));
      } else if (dkimUnavailable) {
        // The provider resolved but could not be asked, so these are the generic
        // SPF/DMARC pair. Naming DKIM as the missing part is the whole point:
        // printing the pair silently would read as "no DKIM required".
        lines.push(chalk.yellow(`  DKIM was NOT retrieved: ${dkimUnavailable}.`));
        lines.push(chalk.dim("  SPF and DMARC above are the domain's own and do not depend on the provider account."));
        lines.push(chalk.dim("  Read the provider's DKIM records where the credentials live, or from the provider's dashboard."));
      }
      lines.push(chalk.dim(`  Confirm what is published: emails domain check ${domain}`));
      output({ domain, provider_id: providerId, records, dkim_unavailable: dkimUnavailable }, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  };

  const checkAction = async (domain: string, opts: { provider?: string }) => {
    try {
      const { records, providerId, provider, dkimUnavailable } = await expectedDnsRecords(domain, opts.provider);
      const [{ checkDomainAuthentication, formatDnsCheck }, { inspectPublicMx, ownerLabel }] = await Promise.all([
        import("../../lib/dns-check.js"),
        import("../../lib/mx-ownership.js"),
      ]);
      const check = await checkDomainAuthentication(domain, records);
      // Root-MX ownership is the check that stops an operator pointing a live
      // mailbox domain at SES by accident; it is why `--force-mx-switch` exists.
      const mx = await inspectPublicMx(domain);

      // The same descriptor `dnsAction` passes, for the same reason and under the
      // same condition. `expectedDnsRecords` returns the provider precisely so
      // BOTH siblings can answer the empty case; this one was reading only
      // `providerId` and discarding it, so `domain dns` said "Nothing is missing"
      // while the `domain check` it recommends answered "No DNS records to check."
      const support = check.records.length === 0 && provider && !dkimUnavailable
        ? providerDnsPublishing(provider)
        : undefined;
      const lines = [chalk.bold(`\nLive DNS check for ${domain}:`), "", formatDnsCheck(check.records, support)];
      lines.push(`  Root MX:   ${ownerLabel(mx.owner)} ${chalk.dim(`(${mx.summary})`)}`);
      lines.push(`  Outbound:  ${check.outbound_ready ? chalk.green("ready") : chalk.yellow("not ready")}`);
      lines.push(`  Inbound:   ${check.inbound_ready ? chalk.green("ready") : chalk.yellow("not ready")}`);
      for (const requirement of check.missing_requirements) lines.push(chalk.red(`  ✗ ${requirement}`));
      for (const warning of check.warnings) lines.push(chalk.yellow(`  ⚠ ${warning}`));
      if (!providerId) {
        lines.push(chalk.dim("  No provider resolved — DKIM was not checked. Pass --provider <id> to include it."));
      } else if (dkimUnavailable) {
        lines.push(chalk.yellow(`  DKIM was NOT checked: ${dkimUnavailable}.`));
      }
      lines.push("");
      output({ ...check, provider_id: providerId, mx }, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  };

  const addDomainAction = (
    domain: string,
    opts: { provider: string; dryRun?: boolean; domainType?: string },
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
          // Not selectable: a domain created through this client is owned by the
          // app's `/v1` database, and both domain mappers report `postgres`
          // unconditionally. There is no local-SQLite-owned domain to choose, so
          // this is reported, not requested.
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
    .option("--dry-run", "Resolve inputs and show the planned change without calling the provider or writing to the DB")
    .action((domain: string, opts: { provider: string; dryRun?: boolean; domainType?: string }) => addDomainAction(domain, opts, "domains"));

  domainsCmd
    .command("connect <domain>")
    .description("Connect an already-owned domain and generate DNS readiness tasks (NOT IMPLEMENTED in this build)")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--domain-type <type>", "Domain type: system, self_hosted, or local_only")
    .option("--dns-provider <provider>", "DNS provider label: manual, cloudflare, or route53", "manual")
    .option("--no-register-provider", "Do not call the mail provider to register the domain")
    .option("--dry-run", "Show the connection plan without calling the provider or writing to the DB")
    .action(() => { try { notImplementedAnywhere("emails domains connect"); } catch (e) { handleError(e); } });

  domainsCmd
    .command("dns <domain>")
    .description("Show the DNS records a domain must publish (DKIM/SPF/DMARC)")
    .option("--provider <id>", "Provider ID")
    .action(dnsAction);

  domainsCmd
    .command("verify <domain>")
    .description("Re-verify domain DNS status and update lifecycle context (NOT IMPLEMENTED in this build)")
    .option("--provider <id>", "Provider ID")
    .action(() => { try { notImplementedAnywhere("emails domains verify"); } catch (e) { handleError(e); } });

  domainsCmd
    .command("check <domain>")
    .description("Live DNS check with per-domain authentication readiness")
    .option("--provider <id>", "Provider ID")
    .action(checkAction);

  domainsCmd
    .command("enable-inbound <domain>")
    .description("Mark a domain inbound-ready after provider/DNS routing is configured (NOT IMPLEMENTED in this build)")
    .option("--provider <id>", "Provider ID")
    .option("--force", "Mark inbound ready even if local readiness checks are not yet verified")
    .action(() => { try { notImplementedAnywhere("emails domains enable-inbound"); } catch (e) { handleError(e); } });

  domainsCmd
    .command("enable-outbound <domain>")
    .description("Enable outbound sending for a verified domain (NOT IMPLEMENTED in this build)")
    .option("--provider <id>", "Provider ID")
    .option("--force", "Enable outbound even if local DKIM/SPF checks are not yet verified")
    .action(() => { try { notImplementedAnywhere("emails domains enable-outbound"); } catch (e) { handleError(e); } });

  domainsCmd
    .command("disable-outbound <domain>")
    .description("Disable outbound sending for a domain (NOT IMPLEMENTED in this build)")
    .option("--provider <id>", "Provider ID")
    .action(() => { try { notImplementedAnywhere("emails domains disable-outbound"); } catch (e) { handleError(e); } });

  domainCmd
    .command("add <domain>")
    .description("Add a domain to a provider")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--domain-type <type>", "Domain type: system, self_hosted, or local_only")
    .option("--dry-run", "Resolve inputs and show the planned change without calling the provider or writing to the DB")
    .action((domain: string, opts: { provider: string; dryRun?: boolean; domainType?: string }) => addDomainAction(domain, opts, "domain"));

  domainCmd
    .command("connect <domain>")
    .description("Connect an already-owned domain and generate DNS readiness tasks (NOT IMPLEMENTED in this build)")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--domain-type <type>", "Domain type: system, self_hosted, or local_only")
    .option("--dns-provider <provider>", "DNS provider label: manual, cloudflare, or route53", "manual")
    .option("--no-register-provider", "Do not call the mail provider to register the domain")
    .option("--dry-run", "Show the connection plan without calling the provider or writing to the DB")
    .action(() => { try { notImplementedAnywhere("emails domain connect"); } catch (e) { handleError(e); } });

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
        // AWAITED. `setDomainProvisioning` reaches the store seam and returns a promise;
        // un-awaited it is a floating write whose rejection escapes this command's error
        // handling, and `adopt` would print the success line below for a write that failed.
        // `tsc` cannot see it — the result is discarded, so the promise is never touched.
        await setDomainProvisioning(rec.id, {
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
            await setDomainProvisioning(rec.id, { provisioning_status: "verified", next_check_at: null, last_error: null });
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
          await setDomainProvisioning(rec.id, { provisioning_status: "ready", next_check_at: null, last_error: null });
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
        await ensureDefaultCatchAll();
        if (opts.catchAll) {
          await createCatchAll(domain, opts.catchAll);
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
    .description("Show the DNS records a domain must publish (DKIM/SPF/DMARC)")
    .option("--provider <id>", "Provider ID (optional if domain is unambiguous)")
    .action(dnsAction);

  domainCmd
    .command("verify <domain>")
    .description("Re-verify domain DNS status (NOT IMPLEMENTED in this build)")
    .option("--provider <id>", "Provider ID")
    .action(() => { try { notImplementedAnywhere("emails domain verify"); } catch (e) { handleError(e); } });

  domainCmd
    .command("status")
    .description("Show domain readiness summary table (NOT IMPLEMENTED in this build; use emails domains status)")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Maximum domains to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of domains to skip", "0")
    .option("--verbose", "Show per-domain issues and first fix command")
    .action(() => { try { notImplementedAnywhere("emails domain status"); } catch (e) { handleError(e); } });

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
        // A verified domain both sends and receives; the usable filter keys off
        // verification, which is the only signal this client stores.
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
          detailCommand: "a domain becomes usable once its DKIM/SPF are verified",
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
    .action(checkAction);

  // ─── DNS SETUP (server-side) ───────────────────────────────────────────────

  domainCmd
    .command("setup-cloudflare <domain>")
    .description("Auto-create DNS records in Cloudflare for email sending (NOT IMPLEMENTED in this build)")
    .requiredOption("--provider <id>", "SES or Resend provider ID")
    .option("--cloudflare-token <token>", "Cloudflare API token (falls back to config/env)")
    .option("--mx", "Also add MX record for receiving email")
    .option("--mx-server <host>", "Custom MX server hostname")
    .option("--register-ses", "Register the domain with SES first if not already added")
    .option("--force-mx-switch", "Allow adding MX even when existing root MX belongs to another provider")
    .action(() => { try { notImplementedAnywhere("emails domain setup-cloudflare"); } catch (e) { handleError(e); } });

  // ─── DOMAIN WARMING ────────────────────────────────────────────────────────
  // Warming schedules are a first-class repository resource (`warming_schedules`
  // in SQLite, `/v1/warming` on the self-hosted server), so these commands call
  // the warming repo directly and work in every configuration. The MCP tools in
  // src/mcp/tools/warming.ts are the same calls over a different transport.

  const warmingStatusColor = (status: WarmingSchedule["status"]): string =>
    status === "active" ? chalk.green(status) : status === "paused" ? chalk.yellow(status) : chalk.dim(status);

  // pause/resume/complete are the same repository write with a different target
  // state, so they share one transition path: fail loud when the domain has no
  // schedule, otherwise emit the updated row.
  const transitionWarmingStatus = (domain: string, status: WarmingSchedule["status"], formatted: string) => {
    try {
      const updated = updateWarmingStatus(domain, status);
      if (!updated) {
        handleError(new Error(
          `Warming schedule not found for domain: ${domain}. Start one with 'emails domain warm ${domain} --target <n>'.`,
        ));
        return;
      }
      output(updated, `${formatted}\n${chalk.dim(`  Details: emails domain warm-status ${domain}`)}`);
    } catch (e) {
      handleError(e);
    }
  };

  domainCmd
    .command("warm <domain>")
    .description("Start a warming schedule for a domain")
    .requiredOption("--target <n>", "Target daily send volume", parseInt)
    .option("--start-date <YYYY-MM-DD>", "Start date (default: today)")
    .option("--provider <id>", "Provider ID to associate")
    .action((domain: string, opts: { target: number; startDate?: string; provider?: string }) => {
      try {
        if (!Number.isInteger(opts.target) || opts.target <= 0) {
          handleError(new Error(`Invalid --target '${opts.target}'. Pass a positive whole daily send volume.`));
        }
        if (opts.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(opts.startDate)) {
          handleError(new Error(`Invalid --start-date '${opts.startDate}'. Use YYYY-MM-DD.`));
        }
        // The /v1 store does not reject a duplicate domain client-side (SQLite
        // does, with a raw UNIQUE error), so check first: a second POST would
        // otherwise leave two schedules for one domain and whichever the reads
        // happened to find would win.
        const existing = getWarmingSchedule(domain);
        if (existing) {
          handleError(new Error(
            `${domain} already has a warming schedule (status ${existing.status}, target ${existing.target_daily_volume}/day, started ${existing.start_date}). ` +
              `Inspect it with 'emails domain warm-status ${domain}', change state with 'emails domain warm-pause|warm-resume|warm-complete ${domain}', ` +
              `or retarget by removing it first: 'emails domain warm-delete ${domain}'.`,
          ));
        }
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const schedule = createWarmingSchedule({
          domain,
          provider_id: providerId,
          target_daily_volume: opts.target,
          start_date: opts.startDate,
        });
        const progress = describeWarmingProgress(schedule);
        const plan = generateWarmingPlan(schedule.target_daily_volume);
        output({ schedule, ...progress, plan_days: plan.length, final_day: progress.total_days }, [
          chalk.green(`✓ Warming schedule created for ${domain}`),
          formatWarmingStatus(schedule, progress),
          chalk.dim(`\nWill reach target (${schedule.target_daily_volume}/day) in ${progress.total_days} days`),
        ].join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm-status <domain>")
    .description("Show warming schedule status for a domain")
    .action((domain: string) => {
      try {
        const schedule = getWarmingSchedule(domain);
        if (!schedule) {
          handleError(new Error(
            `Warming schedule not found for domain: ${domain}. Start one with 'emails domain warm ${domain} --target <n>'.`,
          ));
          return;
        }
        const progress = describeWarmingProgress(schedule);
        output(
          { schedule, ...progress },
          `\n${formatWarmingStatus(schedule, progress)}\n`,
        );
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm-list")
    .description("List all domain warming schedules")
    .option("--status <status>", "Filter by status (active, paused, completed)")
    .option("--limit <n>", "Maximum schedules to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of schedules to skip", "0")
    .option("--verbose", "Show expanded list hints")
    .action((opts: { status?: string; limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        if (opts.status && !["active", "paused", "completed"].includes(opts.status)) {
          handleError(new Error(`Invalid --status '${opts.status}'. Use active, paused, or completed.`));
        }
        const page = parseCliListPage(opts);
        const schedules = listWarmingSchedules(opts.status, page);
        if (schedules.length === 0) {
          output([], chalk.dim("No warming schedules found."));
          return;
        }
        // One ledger read for the whole page instead of one per row: in
        // self-hosted mode each read is a synchronous curl spawn over today's
        // messages, so a 20-row page used to cost 20 identical requests.
        const sentByDomain = getTodaySentCountsByDomain(schedules.map((schedule) => schedule.domain));
        const lines: string[] = [""];
        lines.push(tableRow(
          [chalk.bold("Domain"), 20],
          [chalk.bold("Status"), 10],
          [chalk.bold("Start Date"), 12],
          [chalk.bold("Target"), 10],
          [chalk.bold("Today's Limit"), 14],
          [chalk.bold("Sent Today"), 12],
        ));
        for (const schedule of schedules) {
          const progress = describeWarmingProgress(
            schedule,
            sentByDomain.get(schedule.domain.trim().toLowerCase()) ?? 0,
          );
          lines.push(tableRow(
            [truncate(schedule.domain, 20), 20],
            [warmingStatusColor(schedule.status), 10],
            [schedule.start_date, 12],
            [String(schedule.target_daily_volume), 10],
            [progress.today_limit !== null ? String(progress.today_limit) : chalk.dim("n/a"), 14],
            [String(progress.today_sent), 12],
          ));
        }
        lines.push("");
        lines.push(formatListHint({
          shown: schedules.length,
          limit: page.limit,
          offset: page.offset,
          noun: "warming schedule",
          detailCommand: "use emails domain warm-status <domain> for details",
          verbose: opts.verbose || isCliVerboseOutput(),
        }));
        output(schedules, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm-pause <domain>")
    .description("Pause a domain warming schedule")
    .action((domain: string) => transitionWarmingStatus(
      domain,
      "paused",
      chalk.yellow(`⏸ Warming schedule paused for ${domain}`),
    ));

  domainCmd
    .command("warm-resume <domain>")
    .description("Resume a paused domain warming schedule")
    .action((domain: string) => transitionWarmingStatus(
      domain,
      "active",
      chalk.green(`▶ Warming schedule resumed for ${domain}`),
    ));

  domainCmd
    .command("warm-complete <domain>")
    .description("Mark a domain warming schedule as completed")
    .action((domain: string) => transitionWarmingStatus(
      domain,
      "completed",
      chalk.green(`✓ Warming schedule completed for ${domain}; daily warming limits no longer apply`),
    ));

  // The fifth warming repository operation. Without it there is no way to
  // retarget a domain — `warm` refuses to shadow an existing schedule, and
  // pause/resume/complete only move status — so the refusal above would name a
  // recovery path that did not exist.
  domainCmd
    .command("warm-delete <domain>")
    .description("Delete a domain warming schedule (removes the daily cap entirely)")
    .option("--yes", "Skip confirmation prompt")
    .action(async (domain: string, opts: { yes?: boolean }) => {
      try {
        const existing = getWarmingSchedule(domain);
        if (!existing) {
          handleError(new Error(
            `Warming schedule not found for domain: ${domain}. Start one with 'emails domain warm ${domain} --target <n>'.`,
          ));
          return;
        }
        await confirmDestructiveAction(
          `Delete the warming schedule for ${domain} (status ${existing.status}, target ${existing.target_daily_volume}/day)?`,
          opts.yes,
        );
        if (!deleteWarmingSchedule(domain)) {
          handleError(new Error(`Warming schedule for ${domain} could not be deleted.`));
          return;
        }
        output(
          { deleted: true, schedule: existing },
          chalk.green(`✓ Warming schedule deleted for ${domain}`) + "\n" +
            chalk.dim(`  Sends from ${domain} are no longer warming-capped. Start a new ramp with 'emails domain warm ${domain} --target <n>'.`),
        );
      } catch (e) {
        handleError(e);
      }
    });

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
    .description("Full setup: buy + Route 53 zone + register with SES + configure DNS (NOT IMPLEMENTED in this build)")
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
    .action(() => { try { notImplementedAnywhere("emails domain setup"); } catch (e) { handleError(e); } });
}
