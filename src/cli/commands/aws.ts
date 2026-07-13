/**
 * `emails aws` command group — AWS infrastructure setup for email.
 */

import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { handleError } from "../utils.js";

export function registerAwsCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const awsCmd = program.command("aws").description("AWS infrastructure setup for email (S3, SES receipt rules)");

  // ─── SETUP INBOUND ────────────────────────────────────────────────────────

  awsCmd
    .command("setup-inbound")
    .description("Create S3 bucket + SES receipt rules to receive inbound email. Defaults --bucket/--region to config inbound_s3_bucket/region.")
    .requiredOption("--domain <domain>", "Domain to receive email for (e.g. example.com)")
    .option("--bucket <name>", "S3 bucket name (defaults to config inbound_s3_bucket)")
    .option("--region <region>", "AWS region (defaults to config inbound_s3_region or us-east-1)")
    .option("--prefix <prefix>", "S3 key prefix (default: inbound/<domain>/)")
    .option("--catch-all", "Also catch subdomains (*.example.com)")
    .option("--profile <profile>", "AWS profile name (uses env vars if not set)")
    .option("--provider <id>", "SES provider id for local source provenance")
    .action(async () => {
      try {
        throw new Error(
          "emails aws setup-inbound is not available in the self-hosted client; it runs on the self-hosted server.",
        );
      } catch (e) { handleError(e); }
    });

  // ─── STATUS ───────────────────────────────────────────────────────────────

  awsCmd
    .command("status")
    .description("Show current SES receipt rules and inbound email configuration")
    .option("--region <region>", "AWS region", "us-east-1")
    .option("--profile <profile>", "AWS profile name")
    .action(async (opts: { region: string; profile?: string }) => {
      try {
        if (opts.profile) process.env["AWS_PROFILE"] = opts.profile;

        const { SESClient, DescribeActiveReceiptRuleSetCommand, ListReceiptRuleSetsCommand } = await import("@aws-sdk/client-ses");
        const ses = new SESClient({ region: opts.region });

        // Active rule set
        let activeRuleSet = "(none)";
        let rules: { Name?: string; Enabled?: boolean; Recipients?: string[] }[] = [];
        try {
          const active = await ses.send(new DescribeActiveReceiptRuleSetCommand({}));
          if (active.Metadata?.Name) {
            activeRuleSet = active.Metadata.Name;
            rules = active.Rules ?? [];
          }
        } catch { /* no active rule set */ }

        const allSets = await ses.send(new ListReceiptRuleSetsCommand({}));

        console.log(chalk.bold("\nSES Inbound Status:"));
        console.log(`  Active rule set: ${chalk.cyan(activeRuleSet)}`);
        console.log(`  All rule sets:   ${(allSets.RuleSets ?? []).map(r => r.Name).join(", ") || "(none)"}`);

        if (rules.length > 0) {
          console.log(chalk.bold("\n  Receipt rules:"));
          for (const r of rules) {
            const status = r.Enabled ? chalk.green("enabled") : chalk.dim("disabled");
            console.log(`    ${chalk.cyan(r.Name ?? "")}  [${status}]  ${(r.Recipients ?? []).join(", ")}`);
          }
        }
        console.log();
        output({ active_rule_set: activeRuleSet, rules }, "");
      } catch (e) { handleError(e); }
    });
}
