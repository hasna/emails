#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createProvider, listProviders, deleteProvider, getProvider } from "../db/providers.js";
import { createDomain, listDomains, deleteDomain, getDomain, updateDnsStatus } from "../db/domains.js";
import { createAddress, listAddresses, deleteAddress, getAddress } from "../db/addresses.js";
import { createEmail, listEmails } from "../db/emails.js";
import { getDatabase, resolvePartialId } from "../db/database.js";
import { getAdapter } from "../providers/index.js";
import { formatDnsTable } from "../lib/dns.js";
import { getLocalStats, formatStatsTable } from "../lib/stats.js";
import { syncAll, syncProvider } from "../lib/sync.js";

function getPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string }).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

function handleError(e: unknown): never {
  console.error(chalk.red(e instanceof Error ? e.message : String(e)));
  process.exit(1);
}

function resolveId(table: string, partialId: string): string {
  const db = getDatabase();
  const id = resolvePartialId(db, table, partialId);
  if (!id) {
    console.error(chalk.red(`Could not resolve ID: ${partialId}`));
    process.exit(1);
  }
  return id;
}

program
  .name("emails")
  .description("Email management CLI — Resend, AWS SES, and Gmail")
  .version(getPackageVersion());

// ─── PROVIDER ─────────────────────────────────────────────────────────────────

const providerCmd = program.command("provider").description("Manage email providers");

providerCmd
  .command("add")
  .description("Add an email provider (resend, ses, or gmail)")
  .requiredOption("--name <name>", "Provider name")
  .requiredOption("--type <type>", "Provider type: resend | ses | gmail")
  .option("--api-key <key>", "Resend API key")
  .option("--region <region>", "SES region")
  .option("--access-key <key>", "SES access key ID")
  .option("--secret-key <key>", "SES secret access key")
  .option("--client-id <id>", "Gmail OAuth client ID")
  .option("--client-secret <secret>", "Gmail OAuth client secret")
  .action(async (opts: {
    name: string;
    type: string;
    apiKey?: string;
    region?: string;
    accessKey?: string;
    secretKey?: string;
    clientId?: string;
    clientSecret?: string;
  }) => {
    try {
      if (opts.type !== "resend" && opts.type !== "ses" && opts.type !== "gmail") {
        handleError(new Error("Provider type must be 'resend', 'ses', or 'gmail'"));
      }

      if (opts.type === "gmail") {
        if (!opts.clientId) handleError(new Error("Gmail provider requires --client-id"));
        if (!opts.clientSecret) handleError(new Error("Gmail provider requires --client-secret"));

        const { startGmailOAuthFlow } = await import("../lib/gmail-oauth.js");
        console.log(chalk.dim("Starting Gmail OAuth flow..."));
        const tokens = await startGmailOAuthFlow(opts.clientId!, opts.clientSecret!);

        const provider = createProvider({
          name: opts.name,
          type: "gmail",
          oauth_client_id: opts.clientId,
          oauth_client_secret: opts.clientSecret,
          oauth_refresh_token: tokens.refresh_token,
          oauth_access_token: tokens.access_token,
          oauth_token_expiry: tokens.expiry,
        });
        console.log(chalk.green(`✓ Gmail provider created: ${provider.name} (${provider.id.slice(0, 8)})`));
        return;
      }

      const provider = createProvider({
        name: opts.name,
        type: opts.type as "resend" | "ses",
        api_key: opts.apiKey,
        region: opts.region,
        access_key: opts.accessKey,
        secret_key: opts.secretKey,
      });
      console.log(chalk.green(`✓ Provider created: ${provider.name} (${provider.id.slice(0, 8)})`));
    } catch (e) {
      handleError(e);
    }
  });

providerCmd
  .command("list")
  .description("List configured providers")
  .action(() => {
    try {
      const providers = listProviders();
      if (providers.length === 0) {
        console.log(chalk.dim("No providers configured. Use 'emails provider add' to add one."));
        return;
      }
      console.log(chalk.bold("\nProviders:"));
      for (const p of providers) {
        const status = p.active ? chalk.green("active") : chalk.dim("inactive");
        console.log(`  ${chalk.cyan(p.id.slice(0, 8))}  ${p.name}  [${p.type}]  ${status}`);
      }
      console.log();
    } catch (e) {
      handleError(e);
    }
  });

providerCmd
  .command("remove <id>")
  .description("Remove a provider")
  .action((id: string) => {
    try {
      const resolvedId = resolveId("providers", id);
      const provider = getProvider(resolvedId);
      if (!provider) handleError(new Error(`Provider not found: ${id}`));
      deleteProvider(resolvedId);
      console.log(chalk.green(`✓ Provider removed: ${provider!.name}`));
    } catch (e) {
      handleError(e);
    }
  });

providerCmd
  .command("auth <id>")
  .description("Re-authenticate a Gmail provider (refresh OAuth tokens)")
  .action(async (id: string) => {
    try {
      const resolvedId = resolveId("providers", id);
      const provider = getProvider(resolvedId);
      if (!provider) handleError(new Error(`Provider not found: ${id}`));
      if (provider!.type !== "gmail") {
        handleError(new Error("Only Gmail providers require OAuth re-authentication"));
      }
      if (!provider!.oauth_client_id || !provider!.oauth_client_secret) {
        handleError(new Error("Provider is missing oauth_client_id or oauth_client_secret"));
      }

      const { startGmailOAuthFlow } = await import("../lib/gmail-oauth.js");
      console.log(chalk.dim("Starting Gmail OAuth flow..."));
      const tokens = await startGmailOAuthFlow(provider!.oauth_client_id!, provider!.oauth_client_secret!);

      const { updateProvider } = await import("../db/providers.js");
      updateProvider(resolvedId, {
        oauth_refresh_token: tokens.refresh_token,
        oauth_access_token: tokens.access_token,
        oauth_token_expiry: tokens.expiry,
      });

      console.log(chalk.green(`✓ Gmail provider re-authenticated: ${provider!.name}`));
    } catch (e) {
      handleError(e);
    }
  });

// ─── DOMAIN ───────────────────────────────────────────────────────────────────

const domainCmd = program.command("domain").description("Manage sending domains");

domainCmd
  .command("add <domain>")
  .description("Add a domain to a provider")
  .requiredOption("--provider <id>", "Provider ID")
  .action(async (domain: string, opts: { provider: string }) => {
    try {
      const providerId = resolveId("providers", opts.provider);
      const provider = getProvider(providerId);
      if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));

      const adapter = getAdapter(provider!);
      await adapter.addDomain(domain);

      const d = createDomain(providerId, domain);
      console.log(chalk.green(`✓ Domain added: ${domain} (${d.id.slice(0, 8)})`));
      console.log(chalk.dim("Run 'emails domain dns <domain>' to see required DNS records."));
    } catch (e) {
      handleError(e);
    }
  });

domainCmd
  .command("list")
  .description("List domains")
  .option("--provider <id>", "Filter by provider ID")
  .action((opts: { provider?: string }) => {
    try {
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const domains = listDomains(providerId);
      if (domains.length === 0) {
        console.log(chalk.dim("No domains configured."));
        return;
      }
      console.log(chalk.bold("\nDomains:"));
      for (const d of domains) {
        const dkim = statusBadge(d.dkim_status);
        const spf = statusBadge(d.spf_status);
        const dmarc = statusBadge(d.dmarc_status);
        console.log(`  ${chalk.cyan(d.id.slice(0, 8))}  ${d.domain}  DKIM:${dkim}  SPF:${spf}  DMARC:${dmarc}`);
      }
      console.log();
    } catch (e) {
      handleError(e);
    }
  });

domainCmd
  .command("dns <domain>")
  .description("Show DNS records for a domain")
  .option("--provider <id>", "Provider ID (optional if domain is unambiguous)")
  .action(async (domain: string, opts: { provider?: string }) => {
    try {
      let providerId: string | undefined;
      if (opts.provider) {
        providerId = resolveId("providers", opts.provider);
      }

      // Find domain in DB
      const domains = listDomains(providerId);
      const found = domains.find((d) => d.domain === domain);

      if (found) {
        const provider = getProvider(found.provider_id);
        if (provider) {
          const adapter = getAdapter(provider);
          const records = await adapter.getDnsRecords(domain);
          console.log(chalk.bold(`\nDNS Records for ${domain}:`));
          console.log(formatDnsTable(records));
          return;
        }
      }

      // Fallback: generate generic records
      const { generateSpfRecord, generateDmarcRecord } = await import("../lib/dns.js");
      const records = [generateSpfRecord(domain), generateDmarcRecord(domain)];
      console.log(chalk.bold(`\nDNS Records for ${domain} (generic):`));
      console.log(formatDnsTable(records));
    } catch (e) {
      handleError(e);
    }
  });

domainCmd
  .command("verify <domain>")
  .description("Re-verify domain DNS status")
  .option("--provider <id>", "Provider ID")
  .action(async (domain: string, opts: { provider?: string }) => {
    try {
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const domains = listDomains(providerId);
      const found = domains.find((d) => d.domain === domain);
      if (!found) handleError(new Error(`Domain not found: ${domain}`));

      const provider = getProvider(found!.provider_id);
      if (!provider) handleError(new Error("Provider not found"));

      const adapter = getAdapter(provider!);
      const status = await adapter.verifyDomain(domain);
      updateDnsStatus(found!.id, status.dkim, status.spf, status.dmarc);

      console.log(chalk.bold(`\nDNS Status for ${domain}:`));
      console.log(`  DKIM:  ${statusBadge(status.dkim)}`);
      console.log(`  SPF:   ${statusBadge(status.spf)}`);
      console.log(`  DMARC: ${statusBadge(status.dmarc)}`);
      console.log();
    } catch (e) {
      handleError(e);
    }
  });

domainCmd
  .command("remove <id>")
  .description("Remove a domain")
  .action((id: string) => {
    try {
      const resolvedId = resolveId("domains", id);
      const domain = getDomain(resolvedId);
      if (!domain) handleError(new Error(`Domain not found: ${id}`));
      deleteDomain(resolvedId);
      console.log(chalk.green(`✓ Domain removed: ${domain!.domain}`));
    } catch (e) {
      handleError(e);
    }
  });

// ─── ADDRESS ──────────────────────────────────────────────────────────────────

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
        console.log(chalk.dim("No addresses configured."));
        return;
      }
      console.log(chalk.bold("\nAddresses:"));
      for (const a of addresses) {
        const verified = a.verified ? chalk.green("verified") : chalk.yellow("unverified");
        const name = a.display_name ? ` (${a.display_name})` : "";
        console.log(`  ${chalk.cyan(a.id.slice(0, 8))}  ${a.email}${name}  [${verified}]`);
      }
      console.log();
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
  .action((id: string) => {
    try {
      const resolvedId = resolveId("addresses", id);
      const addr = getAddress(resolvedId);
      if (!addr) handleError(new Error(`Address not found: ${id}`));
      deleteAddress(resolvedId);
      console.log(chalk.green(`✓ Address removed: ${addr!.email}`));
    } catch (e) {
      handleError(e);
    }
  });

// ─── SEND ─────────────────────────────────────────────────────────────────────

program
  .command("send")
  .description("Send an email")
  .requiredOption("--from <email>", "Sender email address")
  .requiredOption("--to <email...>", "Recipient email address(es)")
  .requiredOption("--subject <subject>", "Email subject")
  .option("--body <text>", "Email body text")
  .option("--html", "Treat --body as HTML")
  .option("--cc <email...>", "CC recipients")
  .option("--bcc <email...>", "BCC recipients")
  .option("--reply-to <email>", "Reply-to address")
  .option("--attachment <path...>", "Attachment file path(s)")
  .option("--provider <id>", "Provider ID (uses first active if not specified)")
  .action(async (opts: {
    from: string;
    to: string[];
    subject: string;
    body?: string;
    html?: boolean;
    cc?: string[];
    bcc?: string[];
    replyTo?: string;
    attachment?: string[];
    provider?: string;
  }) => {
    try {
      const db = getDatabase();
      let providerId: string;
      if (opts.provider) {
        providerId = resolveId("providers", opts.provider);
      } else {
        const providers = listProviders(db).filter((p) => p.active);
        if (providers.length === 0) handleError(new Error("No active providers. Add one with 'emails provider add'"));
        providerId = providers[0]!.id;
      }

      const provider = getProvider(providerId, db);
      if (!provider) handleError(new Error(`Provider not found: ${providerId}`));

      // Read attachments
      const attachments = [];
      if (opts.attachment) {
        const { readFileSync } = await import("node:fs");
        const { basename, extname } = await import("node:path");
        for (const path of opts.attachment) {
          const content = readFileSync(path);
          const ext = extname(path).toLowerCase();
          const mimeTypes: Record<string, string> = {
            ".pdf": "application/pdf",
            ".txt": "text/plain",
            ".html": "text/html",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".gif": "image/gif",
            ".zip": "application/zip",
            ".csv": "text/csv",
            ".json": "application/json",
          };
          attachments.push({
            filename: basename(path),
            content: content.toString("base64"),
            content_type: mimeTypes[ext] ?? "application/octet-stream",
          });
        }
      }

      const sendOpts = {
        provider_id: providerId,
        from: opts.from,
        to: opts.to,
        cc: opts.cc,
        bcc: opts.bcc,
        reply_to: opts.replyTo,
        subject: opts.subject,
        text: !opts.html ? opts.body : undefined,
        html: opts.html ? opts.body : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      };

      const adapter = getAdapter(provider!);
      const messageId = await adapter.sendEmail(sendOpts);

      createEmail(providerId, sendOpts, messageId, db);

      console.log(chalk.green(`✓ Email sent to ${Array.isArray(opts.to) ? opts.to.join(", ") : opts.to}`));
      if (messageId) console.log(chalk.dim(`  Message ID: ${messageId}`));
    } catch (e) {
      handleError(e);
    }
  });

// ─── PULL ─────────────────────────────────────────────────────────────────────

program
  .command("pull")
  .description("Sync events from provider(s)")
  .option("--provider <id>", "Provider ID (syncs all if not specified)")
  .action(async (opts: { provider?: string }) => {
    try {
      if (opts.provider) {
        const providerId = resolveId("providers", opts.provider);
        console.log(chalk.dim("Syncing events..."));
        const count = await syncProvider(providerId);
        console.log(chalk.green(`✓ Synced ${count} events`));
      } else {
        console.log(chalk.dim("Syncing all providers..."));
        const results = await syncAll();
        let total = 0;
        for (const [id, count] of Object.entries(results)) {
          console.log(`  ${id.slice(0, 8)}: ${count} events`);
          total += count;
        }
        console.log(chalk.green(`✓ Synced ${total} events total`));
      }
    } catch (e) {
      handleError(e);
    }
  });

// ─── STATS ────────────────────────────────────────────────────────────────────

program
  .command("stats")
  .description("Show email delivery statistics")
  .option("--provider <id>", "Provider ID")
  .option("--period <period>", "Period: 7d, 30d, 90d", "30d")
  .action((opts: { provider?: string; period?: string }) => {
    try {
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const stats = getLocalStats(providerId, opts.period ?? "30d");
      console.log(chalk.bold("\nEmail Stats:"));
      console.log(formatStatsTable(stats));
    } catch (e) {
      handleError(e);
    }
  });

// ─── MONITOR ──────────────────────────────────────────────────────────────────

program
  .command("monitor")
  .description("Live monitor with auto-refresh")
  .option("--provider <id>", "Provider ID")
  .option("--interval <seconds>", "Refresh interval in seconds", "30")
  .action(async (opts: { provider?: string; interval?: string }) => {
    const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
    const intervalSec = parseInt(opts.interval ?? "30", 10);

    const render = () => {
      process.stdout.write("\x1Bc"); // Clear screen
      const now = new Date().toLocaleTimeString();
      console.log(chalk.bold(`Email Monitor  [${now}]  (Ctrl+C to exit)\n`));

      try {
        const stats = getLocalStats(providerId, "7d");
        console.log(chalk.bold("Last 7 days:"));
        console.log(`  ${chalk.cyan("Sent")}:       ${stats.sent}`);
        console.log(`  ${chalk.green("Delivered")}: ${stats.delivered}  (${stats.delivery_rate.toFixed(1)}%)`);
        console.log(`  ${chalk.red("Bounced")}:   ${stats.bounced}  (${stats.bounce_rate.toFixed(1)}%)`);
        console.log(`  ${chalk.yellow("Opened")}:    ${stats.opened}  (${stats.open_rate.toFixed(1)}%)`);
        console.log();

        const emails = listEmails({ provider_id: providerId, limit: 5 });
        if (emails.length > 0) {
          console.log(chalk.bold("Recent emails:"));
          for (const e of emails) {
            const status = emailStatusBadge(e.status);
            console.log(`  ${status}  ${e.subject.slice(0, 40)}  → ${e.to_addresses[0] ?? ""}`);
          }
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
      }
    };

    render();
    const timer = setInterval(render, intervalSec * 1000);

    process.on("SIGINT", () => {
      clearInterval(timer);
      console.log("\n" + chalk.dim("Monitor stopped."));
      process.exit(0);
    });
  });

// ─── SERVE ────────────────────────────────────────────────────────────────────

program
  .command("serve")
  .description("Start the HTTP server and dashboard")
  .option("--port <port>", "Port to listen on", "3900")
  .action(async (opts: { port?: string }) => {
    const { startServer } = await import("../server/serve.js");
    const port = parseInt(opts.port ?? "3900", 10);
    await startServer(port);
  });

// ─── MCP ──────────────────────────────────────────────────────────────────────

program
  .command("mcp")
  .description("Install/configure the MCP server")
  .option("--claude", "Install into Claude Code")
  .option("--codex", "Show Codex config snippet")
  .option("--gemini", "Show Gemini config snippet")
  .option("--uninstall", "Uninstall from Claude Code")
  .action((opts: { claude?: boolean; codex?: boolean; gemini?: boolean; uninstall?: boolean }) => {
    if (opts.uninstall) {
      try {
        execSync("claude mcp remove emails", { stdio: "inherit" });
        console.log(chalk.green("✓ Uninstalled from Claude Code"));
      } catch (e) {
        handleError(e);
      }
      return;
    }

    if (opts.claude) {
      try {
        execSync("claude mcp add --transport stdio --scope user emails -- emails-mcp", {
          stdio: "inherit",
        });
        console.log(chalk.green("✓ Installed into Claude Code"));
      } catch (e) {
        handleError(e);
      }
      return;
    }

    if (opts.codex) {
      console.log(`\nAdd to ~/.codex/config.toml:\n`);
      console.log(`[mcp_servers.emails]`);
      console.log(`command = "emails-mcp"`);
      console.log(`args = []\n`);
      return;
    }

    if (opts.gemini) {
      console.log(`\nAdd to ~/.gemini/settings.json under mcpServers:\n`);
      console.log(JSON.stringify({ emails: { command: "emails-mcp", args: [] } }, null, 2));
      console.log();
      return;
    }

    program.help();
  });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusBadge(status: string): string {
  switch (status) {
    case "verified": return chalk.green("✓");
    case "failed": return chalk.red("✗");
    default: return chalk.yellow("⏳");
  }
}

function emailStatusBadge(status: string): string {
  switch (status) {
    case "delivered": return chalk.green("delivered ");
    case "bounced": return chalk.red("bounced   ");
    case "complained": return chalk.red("complained");
    case "failed": return chalk.red("failed    ");
    default: return chalk.dim("sent      ");
  }
}

program.parse(process.argv);
