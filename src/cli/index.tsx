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
import { createTemplate, listTemplates, getTemplate, deleteTemplate, renderTemplate } from "../db/templates.js";
import { listContacts, suppressContact, unsuppressContact, isContactSuppressed, incrementSendCount } from "../db/contacts.js";
import { getDatabase, resolvePartialId } from "../db/database.js";
import { getAdapter } from "../providers/index.js";
import { formatDnsTable } from "../lib/dns.js";
import { getLocalStats, formatStatsTable } from "../lib/stats.js";
import { syncAll, syncProvider } from "../lib/sync.js";
import { checkAllProviders, formatProviderHealth } from "../lib/health.js";
import { loadConfig, getConfigValue, setConfigValue, getDefaultProviderId } from "../lib/config.js";
import { colorStatus, colorDnsStatus, colorProvider, truncate, formatDate, tableRow } from "../lib/format.js";
import { exportEmailsCsv, exportEmailsJson, exportEventsCsv, exportEventsJson } from "../lib/export.js";

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
  .option("--skip-validation", "Skip credential validation after adding")
  .action(async (opts: {
    name: string;
    type: string;
    apiKey?: string;
    region?: string;
    accessKey?: string;
    secretKey?: string;
    clientId?: string;
    clientSecret?: string;
    skipValidation?: boolean;
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

        if (!opts.skipValidation) {
          try {
            const adapter = getAdapter(provider);
            await adapter.listAddresses();
          } catch (validationErr) {
            deleteProvider(provider.id);
            handleError(new Error(`Provider credentials are invalid: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}. Provider was not saved.`));
          }
        }

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

      if (!opts.skipValidation) {
        try {
          const adapter = getAdapter(provider);
          await adapter.listDomains();
        } catch (validationErr) {
          deleteProvider(provider.id);
          handleError(new Error(`Provider credentials are invalid: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}. Provider was not saved.`));
        }
      }

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
        const status = colorProvider(p.active, p.active ? "active" : "inactive");
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

providerCmd
  .command("status")
  .description("Health check all active providers")
  .action(async () => {
    try {
      const results = await checkAllProviders();
      if (results.length === 0) {
        console.log(chalk.dim("No active providers. Add one with 'emails provider add'"));
        return;
      }
      console.log(chalk.bold("\nProvider Health:\n"));
      for (const h of results) {
        console.log(formatProviderHealth(h));
        console.log();
      }
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
        const dkim = colorDnsStatus(d.dkim_status);
        const spf = colorDnsStatus(d.spf_status);
        const dmarc = colorDnsStatus(d.dmarc_status);
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
      console.log(`  DKIM:  ${colorDnsStatus(status.dkim)}`);
      console.log(`  SPF:   ${colorDnsStatus(status.spf)}`);
      console.log(`  DMARC: ${colorDnsStatus(status.dmarc)}`);
      console.log();
    } catch (e) {
      handleError(e);
    }
  });

domainCmd
  .command("status")
  .description("Show domain status summary table")
  .option("--provider <id>", "Filter by provider ID")
  .action((opts: { provider?: string }) => {
    try {
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const domains = listDomains(providerId);
      if (domains.length === 0) {
        console.log(chalk.dim("No domains configured."));
        return;
      }
      console.log();
      console.log(tableRow(
        [chalk.bold("Domain"), 16],
        [chalk.bold("Provider"), 12],
        [chalk.bold("DKIM"), 12],
        [chalk.bold("SPF"), 12],
        [chalk.bold("DMARC"), 12],
        [chalk.bold("Last Verified"), 18],
      ));
      for (const d of domains) {
        const provider = getProvider(d.provider_id);
        const providerName = provider ? truncate(provider.name, 12) : d.provider_id.slice(0, 8);
        const lastVerified = d.verified_at ? formatDate(d.verified_at) : chalk.dim("never");
        console.log(tableRow(
          [truncate(d.domain, 16), 16],
          [providerName, 12],
          [colorDnsStatus(d.dkim_status), 12],
          [colorDnsStatus(d.spf_status), 12],
          [colorDnsStatus(d.dmarc_status), 12],
          [lastVerified, 18],
        ));
      }
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
        const verified = a.verified ? colorDnsStatus("verified") : colorDnsStatus("pending");
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
  .option("--subject <subject>", "Email subject")
  .option("--body <text>", "Email body text")
  .option("--body-file <path>", "Read body from file")
  .option("--html", "Treat --body as HTML")
  .option("--cc <email...>", "CC recipients")
  .option("--bcc <email...>", "BCC recipients")
  .option("--reply-to <email>", "Reply-to address")
  .option("--attachment <path...>", "Attachment file path(s)")
  .option("--provider <id>", "Provider ID (uses first active if not specified)")
  .option("--template <name>", "Use a template by name")
  .option("--vars <json>", "Template variables as JSON string")
  .option("--force", "Send even if recipients are suppressed")
  .action(async (opts: {
    from: string;
    to: string[];
    subject?: string;
    body?: string;
    bodyFile?: string;
    html?: boolean;
    cc?: string[];
    bcc?: string[];
    replyTo?: string;
    attachment?: string[];
    provider?: string;
    template?: string;
    vars?: string;
    force?: boolean;
  }) => {
    try {
      const db = getDatabase();

      // Check suppressed contacts
      const allRecipients = [...opts.to, ...(opts.cc || []), ...(opts.bcc || [])];
      const suppressedRecipients = allRecipients.filter((email) => isContactSuppressed(email, db));
      if (suppressedRecipients.length > 0 && !opts.force) {
        console.log(chalk.yellow(`Warning: Suppressed recipients: ${suppressedRecipients.join(", ")}`));
        console.log(chalk.dim("  Use --force to send anyway."));
      }

      // Resolve body from --body, --body-file, or stdin pipe
      let body = opts.body;
      if (opts.bodyFile) {
        body = readFileSync(opts.bodyFile, "utf-8");
      } else if (!body && !opts.template && !process.stdin.isTTY) {
        body = await new Promise<string>((resolve) => {
          let data = "";
          process.stdin.setEncoding("utf-8");
          process.stdin.on("data", (chunk: string) => data += chunk);
          process.stdin.on("end", () => resolve(data));
        });
      }

      // Resolve template
      let subject = opts.subject || "";
      let htmlBody = opts.html ? body : undefined;
      let textBody = !opts.html ? body : undefined;

      if (opts.template) {
        const tpl = getTemplate(opts.template, db);
        if (!tpl) handleError(new Error(`Template not found: ${opts.template}`));
        const vars: Record<string, string> = opts.vars ? JSON.parse(opts.vars) : {};
        subject = renderTemplate(tpl!.subject_template, vars);
        if (tpl!.html_template) htmlBody = renderTemplate(tpl!.html_template, vars);
        if (tpl!.text_template) textBody = renderTemplate(tpl!.text_template, vars);
      }

      if (!subject) handleError(new Error("Subject is required (use --subject or --template)"));

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
        subject,
        text: textBody,
        html: htmlBody,
        attachments: attachments.length > 0 ? attachments : undefined,
      };

      const adapter = getAdapter(provider!);
      const messageId = await adapter.sendEmail(sendOpts);

      createEmail(providerId, sendOpts, messageId, db);

      // Track contacts
      for (const recipientEmail of allRecipients) {
        incrementSendCount(recipientEmail, db);
      }

      console.log(chalk.green(`✓ Email sent to ${Array.isArray(opts.to) ? opts.to.join(", ") : opts.to}`));
      if (messageId) console.log(chalk.dim(`  Message ID: ${messageId}`));
    } catch (e) {
      handleError(e);
    }
  });

// ─── TEMPLATE ────────────────────────────────────────────────────────────────

const templateCmd = program.command("template").description("Manage email templates");

templateCmd
  .command("add <name>")
  .description("Add an email template")
  .requiredOption("--subject <subject>", "Subject template (supports {{var}} placeholders)")
  .option("--html <html>", "Inline HTML template")
  .option("--text <text>", "Inline text template")
  .option("--html-file <path>", "Read HTML template from file")
  .option("--text-file <path>", "Read text template from file")
  .action((name: string, opts: { subject: string; html?: string; text?: string; htmlFile?: string; textFile?: string }) => {
    try {
      let htmlTemplate = opts.html;
      let textTemplate = opts.text;

      if (opts.htmlFile) {
        htmlTemplate = readFileSync(opts.htmlFile, "utf-8");
      }
      if (opts.textFile) {
        textTemplate = readFileSync(opts.textFile, "utf-8");
      }

      const template = createTemplate({
        name,
        subject_template: opts.subject,
        html_template: htmlTemplate,
        text_template: textTemplate,
      });
      console.log(chalk.green(`✓ Template created: ${template.name} (${template.id.slice(0, 8)})`));
    } catch (e) {
      handleError(e);
    }
  });

templateCmd
  .command("list")
  .description("List all templates")
  .action(() => {
    try {
      const templates = listTemplates();
      if (templates.length === 0) {
        console.log(chalk.dim("No templates configured. Use 'emails template add' to create one."));
        return;
      }
      console.log(chalk.bold("\nTemplates:"));
      for (const t of templates) {
        const hasHtml = t.html_template ? chalk.green("html") : chalk.dim("no-html");
        const hasText = t.text_template ? chalk.green("text") : chalk.dim("no-text");
        console.log(`  ${chalk.cyan(t.id.slice(0, 8))}  ${t.name}  subject="${truncate(t.subject_template, 30)}"  [${hasHtml}] [${hasText}]`);
      }
      console.log();
    } catch (e) {
      handleError(e);
    }
  });

templateCmd
  .command("show <name>")
  .description("Show template details")
  .action((name: string) => {
    try {
      const template = getTemplate(name);
      if (!template) handleError(new Error(`Template not found: ${name}`));
      console.log(chalk.bold(`\nTemplate: ${template!.name}`));
      console.log(`  ID:      ${template!.id}`);
      console.log(`  Subject: ${template!.subject_template}`);
      if (template!.html_template) {
        console.log(`  HTML:    ${truncate(template!.html_template, 60)}`);
      }
      if (template!.text_template) {
        console.log(`  Text:    ${truncate(template!.text_template, 60)}`);
      }
      console.log(`  Created: ${template!.created_at}`);
      console.log();
    } catch (e) {
      handleError(e);
    }
  });

templateCmd
  .command("remove <name>")
  .description("Remove a template")
  .action((name: string) => {
    try {
      const deleted = deleteTemplate(name);
      if (!deleted) handleError(new Error(`Template not found: ${name}`));
      console.log(chalk.green(`✓ Template removed: ${name}`));
    } catch (e) {
      handleError(e);
    }
  });

// ─── CONTACTS ────────────────────────────────────────────────────────────────

const contactsCmd = program.command("contacts").description("Manage email contacts");

contactsCmd
  .command("list")
  .description("List contacts")
  .option("--suppressed", "Show only suppressed contacts")
  .action((opts: { suppressed?: boolean }) => {
    try {
      const contacts = listContacts(opts.suppressed !== undefined ? { suppressed: opts.suppressed } : undefined);
      if (contacts.length === 0) {
        console.log(chalk.dim("No contacts tracked yet."));
        return;
      }
      console.log(chalk.bold("\nContacts:"));
      for (const c of contacts) {
        const suppressed = c.suppressed ? chalk.red("suppressed") : chalk.green("active");
        const name = c.name ? ` (${c.name})` : "";
        console.log(`  ${c.email}${name}  sent:${c.send_count} bounce:${c.bounce_count} complaint:${c.complaint_count}  [${suppressed}]`);
      }
      console.log();
    } catch (e) {
      handleError(e);
    }
  });

contactsCmd
  .command("suppress <email>")
  .description("Suppress a contact (prevent sending)")
  .action((email: string) => {
    try {
      suppressContact(email);
      console.log(chalk.green(`✓ Contact suppressed: ${email}`));
    } catch (e) {
      handleError(e);
    }
  });

contactsCmd
  .command("unsuppress <email>")
  .description("Unsuppress a contact (allow sending again)")
  .action((email: string) => {
    try {
      unsuppressContact(email);
      console.log(chalk.green(`✓ Contact unsuppressed: ${email}`));
    } catch (e) {
      handleError(e);
    }
  });

// ─── PULL ─────────────────────────────────────────────────────────────────────

function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h)$/);
  if (!match) return 300000;
  const val = parseInt(match[1]!);
  switch (match[2]) {
    case "s": return val * 1000;
    case "m": return val * 60000;
    case "h": return val * 3600000;
    default: return 300000;
  }
}

program
  .command("pull")
  .description("Sync events from provider(s)")
  .option("--provider <id>", "Provider ID (syncs all if not specified)")
  .option("--watch", "Keep syncing on an interval")
  .option("--interval <duration>", "Watch interval (e.g. 30s, 5m, 1h)", "5m")
  .action(async (opts: { provider?: string; watch?: boolean; interval?: string }) => {
    try {
      const runSync = async () => {
        if (opts.provider) {
          const providerId = resolveId("providers", opts.provider);
          const count = await syncProvider(providerId);
          return count;
        } else {
          const results = await syncAll();
          let total = 0;
          for (const [id, count] of Object.entries(results)) {
            if (!opts.watch) console.log(`  ${id.slice(0, 8)}: ${count} events`);
            total += count;
          }
          return total;
        }
      };

      if (opts.watch) {
        const interval = parseDuration(opts.interval || "5m");
        console.log(chalk.blue(`Watching for new events every ${opts.interval || "5m"}...`));
        while (true) {
          const total = await runSync();
          console.log(chalk.gray(`[${new Date().toLocaleTimeString()}]`) + ` Synced ${total} events`);
          await new Promise(r => setTimeout(r, interval));
        }
      } else {
        console.log(chalk.dim(opts.provider ? "Syncing events..." : "Syncing all providers..."));
        const total = await runSync();
        console.log(chalk.green(`✓ Synced ${total} events${opts.provider ? "" : " total"}`));
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
            const status = colorStatus(e.status);
            console.log(`  ${padRight(status, 12)}  ${truncate(e.subject, 40)}  \u2192 ${e.to_addresses[0] ?? ""}`);
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

// ─── EXPORT ──────────────────────────────────────────────────────────────────

program
  .command("export <type>")
  .description("Export emails or events (type: emails | events)")
  .option("--provider <id>", "Filter by provider ID")
  .option("--since <date>", "Filter from date (ISO)")
  .option("--until <date>", "Filter until date (ISO)")
  .option("--format <fmt>", "Output format: json | csv", "json")
  .option("--output <file>", "Write to file instead of stdout")
  .action((type: string, opts: { provider?: string; since?: string; until?: string; format?: string; output?: string }) => {
    try {
      if (type !== "emails" && type !== "events") {
        handleError(new Error("Export type must be 'emails' or 'events'"));
      }

      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const fmt = opts.format ?? "json";
      let result: string;

      if (type === "emails") {
        const filters = { provider_id: providerId, since: opts.since, until: opts.until };
        result = fmt === "csv" ? exportEmailsCsv(filters) : exportEmailsJson(filters);
      } else {
        const filters = { provider_id: providerId, since: opts.since };
        result = fmt === "csv" ? exportEventsCsv(filters) : exportEventsJson(filters);
      }

      if (opts.output) {
        const { writeFileSync } = require("node:fs");
        writeFileSync(opts.output, result, "utf-8");
        console.log(chalk.green("✓ Exported " + type + " to " + opts.output));
      } else {
        console.log(result);
      }
    } catch (e) {
      handleError(e);
    }
  });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function padRight(str: string, len: number): string {
  const visibleLen = str.replace(/\[[0-9;]*m/g, "").length;
  return str + " ".repeat(Math.max(0, len - visibleLen));
}

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const configCmd = program.command("config").description("Manage configuration");
configCmd.command("set <key> <value>").description("Set a config value").action((key: string, value: string) => {
  try {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { parsed = value; }
    setConfigValue(key, parsed);
    console.log(chalk.green(`✓ ${key} = ${JSON.stringify(parsed)}`));
  } catch (e) { handleError(e); }
});
configCmd.command("get <key>").description("Get a config value").action((key: string) => {
  try {
    const value = getConfigValue(key);
    if (value === undefined) { console.log(chalk.dim(`${key} is not set`)); }
    else { console.log(`${key} = ${JSON.stringify(value)}`); }
  } catch (e) { handleError(e); }
});
configCmd.command("list").description("List all config values").action(() => {
  try {
    const config = loadConfig();
    const keys = Object.keys(config);
    if (keys.length === 0) { console.log(chalk.dim("No config values set.")); return; }
    console.log(chalk.bold("\nConfig:"));
    for (const key of keys) { console.log(`  ${chalk.cyan(key)} = ${JSON.stringify(config[key])}`); }
    console.log();
  } catch (e) { handleError(e); }
});

// ─── LOG ─────────────────────────────────────────────────────────────────────
program.command("log").description("Show email send log")
  .option("--provider <id>", "Filter by provider ID")
  .option("--status <status>", "Filter by status: sent|delivered|bounced|complained|failed")
  .option("--since <date>", "Show emails since date (ISO 8601)")
  .option("--limit <n>", "Max results", "20")
  .action((opts: { provider?: string; status?: string; since?: string; limit?: string }) => {
    try {
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const limit = parseInt(opts.limit ?? "20", 10);
      const emails = listEmails({ provider_id: providerId, status: opts.status as "sent" | "delivered" | "bounced" | "complained" | "failed" | undefined, since: opts.since, limit });
      if (emails.length === 0) { console.log(chalk.dim("No emails found.")); return; }
      console.log(chalk.bold(`${"Date".padEnd(20)}  ${"From".padEnd(30)}  ${"To".padEnd(30)}  ${"Subject".padEnd(40)}  Status`));
      console.log(chalk.dim("\u2500".repeat(130)));
      for (const e of emails) {
        const date = new Date(e.sent_at).toLocaleString();
        const from = e.from_address.length > 30 ? e.from_address.slice(0, 27) + "..." : e.from_address;
        const to = (e.to_addresses[0] ?? "").length > 30 ? (e.to_addresses[0] ?? "").slice(0, 27) + "..." : (e.to_addresses[0] ?? "");
        const subj = e.subject.length > 40 ? e.subject.slice(0, 37) + "..." : e.subject;
        let statusStr: string;
        switch (e.status) {
          case "delivered": statusStr = chalk.green(e.status); break;
          case "bounced": case "complained": case "failed": statusStr = chalk.red(e.status); break;
          default: statusStr = chalk.blue(e.status);
        }
        console.log(`${date.padEnd(20)}  ${from.padEnd(30)}  ${to.padEnd(30)}  ${subj.padEnd(40)}  ${statusStr}`);
      }
      console.log();
    } catch (e) { handleError(e); }
  });

// ─── TEST ────────────────────────────────────────────────────────────────────
program.command("test [provider-id]").description("Send a test email")
  .option("--to <email>", "Recipient email address")
  .action(async (providerId?: string, opts?: { to?: string }) => {
    try {
      const db = getDatabase();
      let resolvedProviderId: string;
      if (providerId) { resolvedProviderId = resolveId("providers", providerId); }
      else {
        const defaultId = getDefaultProviderId();
        if (defaultId) {
          const resolved = resolvePartialId(db, "providers", defaultId);
          if (resolved) { resolvedProviderId = resolved; }
          else { handleError(new Error(`Default provider not found: ${defaultId}. Update with 'emails config set default_provider <id>'`)); }
        } else {
          const providers = listProviders(db).filter((p) => p.active);
          if (providers.length === 0) handleError(new Error("No active providers. Add one with 'emails provider add'"));
          resolvedProviderId = providers[0]!.id;
        }
      }
      const provider = getProvider(resolvedProviderId!, db);
      if (!provider) handleError(new Error(`Provider not found: ${resolvedProviderId!}`));
      let toEmail = opts?.to;
      if (!toEmail) {
        const addrs = listAddresses(resolvedProviderId!, db);
        const v = addrs.find((a) => a.verified);
        if (v) { toEmail = v.email; } else if (addrs.length > 0) { toEmail = addrs[0]!.email; }
        else { handleError(new Error("No --to address specified and no addresses found for this provider")); }
      }
      const fromAddrs = listAddresses(resolvedProviderId!, db);
      let fromEmail: string;
      const vf = fromAddrs.find((a) => a.verified);
      if (vf) { fromEmail = vf.email; } else if (fromAddrs.length > 0) { fromEmail = fromAddrs[0]!.email; }
      else { handleError(new Error("No sender addresses configured for this provider. Add one with 'emails address add'")); }
      const ts = new Date().toISOString();
      const subject = `Test from open-emails \u2014 ${ts}`;
      const text = `This is a test email sent via open-emails at ${ts}. Provider: ${provider!.name} (${provider!.type})`;
      const adapter = getAdapter(provider!);
      const messageId = await adapter.sendEmail({ from: fromEmail!, to: toEmail!, subject, text });
      createEmail(resolvedProviderId!, { from: fromEmail!, to: toEmail!, subject, text }, messageId, db);
      console.log(chalk.green(`✓ Test email sent to ${toEmail}`));
      if (messageId) console.log(chalk.dim(`  Message ID: ${messageId}`));
      console.log(chalk.dim(`  From: ${fromEmail!}`));
      console.log(chalk.dim(`  Provider: ${provider!.name} (${provider!.type})`));
    } catch (e) { handleError(e); }
  });

program.parse(process.argv);
