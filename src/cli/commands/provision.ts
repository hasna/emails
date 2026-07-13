import type { Command } from "commander";
import { handleError } from "../utils.js";
import type { MxAssessment } from "../../lib/mx-ownership.js";

// Automated provisioning (SES identity/MAIL FROM, Cloudflare DNS, S3 inbound
// receipt rules, the provisioning reconciler and round-trip acceptance tests)
// is local orchestration with no /v1 equivalent: it runs on the self-hosted
// server/operator workers. This client is self-hosted-only, so these commands
// are kept for discoverability but fail loud. Domain adoption remains available
// via `emails domain adopt`.
function serverOnly(command: string): never {
  throw new Error(
    `${command} is not available in the self-hosted client; it runs on the self-hosted server.`,
  );
}

export interface ProvisionCommandDeps {
  inspectMx?: (domain: string) => Promise<MxAssessment>;
}

export function registerProvisionCommands(program: Command, _output: (data: unknown, formatted: string) => void, _deps: ProvisionCommandDeps = {}): void {
  const cmd = program.command("provision").description("Automated domain + address provisioning");

  // ── status ────────────────────────────────────────────────────────────────
  cmd
    .command("status [domain]")
    .description("Show provisioning status of domains and addresses")
    .option("--limit <n>", "Maximum domains to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of domains to skip", "0")
    .option("--verbose", "Show all address provisioning rows per domain")
    .action(() => {
      try { serverOnly("emails provision status"); } catch (e) { handleError(e); }
    });

  // ── address create ─────────────────────────────────────────────────────────
  cmd
    .command("address <email>")
    .description("Create an email address on a provisioned domain")
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
      try { serverOnly("emails provision address"); } catch (e) { handleError(e); }
    });

  // ── domain setup ─────────────────────────────────────────────────────────
  cmd
    .command("domain <domain>")
    .description("Provision a domain for sending: SES identity + MAIL FROM + publish DNS in Cloudflare")
    .requiredOption("--provider <id>", "SES provider ID")
    .option("--send <provider>", "Send provider", "ses")
    .option("--add-mx", "Also publish inbound MX (ses-s3 receive)")
    .option("--force-mx-switch", "Allow adding SES inbound MX even when existing root MX belongs to another provider")
    .option("--mail-from <subdomain>", "Custom MAIL FROM subdomain (default mail.<domain>)")
    .option("--dry-run", "Resolve inputs and show the planned change without calling providers or writing to the DB")
    .option("--wait", "Poll SES until the domain is verified for sending")
    .option("--timeout <sec>", "Max seconds to wait for verification", "600")
    .action(async () => {
      try { serverOnly("emails provision domain"); } catch (e) { handleError(e); }
    });

  // ── up: full end-to-end orchestrator ─────────────────────────────────────
  cmd
    .command("up <domain>")
    .description("One command: SES identity + MAIL FROM → publish DNS (Cloudflare) → wait verify → inbound → addresses → round-trip test")
    .requiredOption("--provider <id>", "SES provider ID")
    .option("--addresses <list>", "Comma-separated local parts to create", "one,two,three")
    .option("--bucket <name>", "Inbound S3 bucket (defaults to config inbound_s3_bucket)")
    .option("--add-mx", "Publish inbound MX (ses-s3 receive)", true)
    .option("--no-add-mx", "Preserve existing root MX and skip SES inbound MX publishing")
    .option("--force-mx-switch", "Allow adding SES inbound MX even when existing root MX belongs to another provider")
    .option("--count <n>", "Round-trip messages per pair (0 = skip test)", "1")
    .option("--timeout <sec>", "Max seconds to wait for SES verification", "600")
    .option("--no-test", "Skip the final round-trip test")
    .option("--buy-if-needed", "Buy + delegate the domain first (via @hasna/domains SDK) if not already owned")
    .option("--purchase-profile <profile>", "AWS profile for the purchase (defaults to the current AWS_PROFILE or ambient credentials)")
    .action(async () => {
      try { serverOnly("emails provision up"); } catch (e) { handleError(e); }
    });

  // ── roundtrip (acceptance test) ─────────────────────────────────────────
  cmd
    .command("roundtrip")
    .description("Send N tokened emails around a ring of addresses and confirm 100% receipt (via SES inbound → S3 → SQLite)")
    .requiredOption("--domain <domain>", "Domain whose addresses to test")
    .requiredOption("--provider <id>", "SES provider ID (sends + inbound association)")
    .option("--addresses <list>", "Comma-separated local parts", "one,two,three")
    .option("--count <n>", "Messages per directed pair", "16")
    .option("--bucket <name>", "Inbound S3 bucket (defaults to config inbound_s3_bucket)")
    .option("--profile <profile>", "AWS profile for S3 sync")
    .option("--poll-attempts <n>", "Receipt poll attempts", "12")
    .option("--poll-interval <ms>", "Receipt poll interval ms", "10000")
    .option("--throttle <ms>", "Delay between sends (SES sandbox = 1100)", "1100")
    .action(async () => {
      try { serverOnly("emails provision roundtrip"); } catch (e) { handleError(e); }
    });

  // ── daemon (reconciler loop) ─────────────────────────────────────────────
  cmd
    .command("daemon")
    .description("Run the provisioning reconciler: advance due domains/addresses toward ready")
    .requiredOption("--provider <id>", "SES provider ID")
    .option("--bucket <name>", "Inbound S3 bucket (defaults to config inbound_s3_bucket)")
    .option("--add-mx", "Publish inbound MX when setting up domains")
    .option("--force-mx-switch", "Allow adding SES inbound MX even when existing root MX belongs to another provider")
    .option("--once", "Run a single reconcile tick and exit")
    .option("--interval <sec>", "Seconds between ticks", "30")
    .option("--max-ticks <n>", "Stop after N ticks (default: unlimited)")
    .action(async () => {
      try { serverOnly("emails provision daemon"); } catch (e) { handleError(e); }
    });

  // ── retry ───────────────────────────────────────────────────────────────
  cmd
    .command("retry <domain>")
    .description("Re-queue a domain for the provisioning daemon (clear error, check now)")
    .option("--provider <id>", "Provider ID")
    .action(() => {
      try { serverOnly("emails provision retry"); } catch (e) { handleError(e); }
    });
}
