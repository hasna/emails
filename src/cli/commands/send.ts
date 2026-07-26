import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { resolveMailDataSource, type MailSendAttachment } from "../../lib/mail-data-source.js";
import { getTemplate, renderTemplate } from "../../db/templates.js";
import { suppressedRecipientsAmong } from "../../db/contacts.js";
import { handleError } from "../utils.js";
import { getEmailsMode } from "../../lib/mode.js";
import {
  describeSendAttachmentLimits,
  LOCAL_SEND_ATTACHMENT_LIMITS,
  SELF_HOSTED_SEND_ATTACHMENT_LIMITS,
} from "../../lib/send-attachment-limits.js";

const MAX_ATTACHMENT_SIZE = LOCAL_SEND_ATTACHMENT_LIMITS.maxBytesPerFile;
const MAX_ATTACHMENT_COUNT = LOCAL_SEND_ATTACHMENT_LIMITS.maxFiles;
const ATTACHMENT_MIME_TYPES: Record<string, string> = {
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

// Read + base64-encode attachment files, enforcing the count/size caps before
// handing the composed message to the self-hosted send API via the seam.
function readSendAttachments(paths: string[] | undefined): MailSendAttachment[] {
  if (!paths || paths.length === 0) return [];
  if (paths.length > MAX_ATTACHMENT_COUNT) {
    handleError(new Error(`Too many attachments: ${paths.length} (max ${MAX_ATTACHMENT_COUNT})`));
  }
  const attachments: MailSendAttachment[] = [];
  for (const path of paths) {
    const stat = statSync(path);
    if (stat.size > MAX_ATTACHMENT_SIZE) {
      handleError(new Error(`Attachment "${basename(path)}" is too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 25MB)`));
    }
    const content = readFileSync(path);
    const ext = extname(path).toLowerCase();
    attachments.push({
      filename: basename(path),
      content: content.toString("base64"),
      content_type: ATTACHMENT_MIME_TYPES[ext] ?? "application/octet-stream",
    });
  }
  return attachments;
}

export function registerSendCommands(program: Command, _output: (data: unknown, formatted: string) => void): void {
  program
    .command("send")
    .description("Send an email")
    .requiredOption("--from <email>", "Sender email address")
    .option("--to <email...>", "Recipient email address(es)")
    .option("--to-group <name>", "Send to all members of a recipient group")
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
    .option("--force", "Send even if recipients are suppressed (local mode only; the self-hosted server refuses regardless)")
    .option("--dry-run", "Preview what would be sent without actually sending")
    .option("--schedule <datetime>", "Schedule email for later (ISO 8601 datetime)")
    .option("--unsubscribe-url <url>", "Inject List-Unsubscribe headers (RFC 8058 one-click)")
    .option("--idempotency-key <key>", "Prevent duplicate sends — returns existing email if key was used before")
    .option("--track-opens", "Inject tracking pixel to detect email opens (requires emails serve running)")
    .option("--track-clicks", "Rewrite links to track clicks (requires emails serve running)")
    .option("--tracking-url <url>", "Base URL for tracking server (default: http://localhost:3900)")
    .option("--in-reply-to <id>", "Reply to an existing sent email — sets In-Reply-To/References headers for threading")
    .action(async (opts: {
      from: string;
      to?: string[];
      toGroup?: string;
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
      dryRun?: boolean;
      schedule?: string;
      trackOpens?: boolean;
      trackClicks?: boolean;
      trackingUrl?: string;
    }) => {
      try {
        const ds = resolveMailDataSource();

        // Resolve recipients from --to or --to-group. Group member fan-out is a
        // server-side concern in the self-hosted client; require explicit --to.
        let toAddresses: string[] = opts.to || [];
        if (opts.toGroup) {
          handleError(new Error("--to-group is not available in the self-hosted client without a self-hosted group-members send API. Pass explicit --to recipients."));
        }
        if (toAddresses.length === 0) handleError(new Error("No recipients specified. Use --to or --to-group"));

        // Suppressed contacts. This used to print "Use --force to send anyway"
        // and then FALL THROUGH with no return and no filtering, so a suppressed
        // recipient was mailed whether or not --force was passed — and in local
        // mode there is no second gate anywhere further down the chain. The
        // suppression is now enforced here, where it is checked.
        const allRecipients = [...toAddresses, ...(opts.cc || []), ...(opts.bcc || [])];
        // Canonical comparison (see db/contacts): `Blocked@ext.com` and
        // `"Blocked Person <blocked@ext.com>"` are the same recipient as
        // `blocked@ext.com`, and an exact string match let both forms through.
        const suppressedRecipients = suppressedRecipientsAmong(allRecipients);
        if (suppressedRecipients.length > 0) {
          const list = suppressedRecipients.join(", ");
          console.log(chalk.yellow(`Warning: Suppressed recipients: ${list}`));
          if (opts.dryRun) {
            // A dry run sends nothing, so it reports instead of refusing.
            console.log(chalk.dim("  A real send would be refused; --force overrides in local mode only."));
          } else if (!opts.force) {
            handleError(new Error(
              `Refusing to send to suppressed recipient(s): ${list}. `
              + "Pass --force to send anyway, or clear the suppression with `emails contact unsuppress <email>`.",
            ));
          } else if (ds.mode === "self_hosted") {
            // --force has always been dead on this path: it is never transmitted,
            // and the server refuses a suppressed recipient unconditionally with
            // 409 recipient_suppressed and offers no override. Say so here instead
            // of spending a round-trip to arrive at a confusing 409.
            handleError(new Error(
              `--force cannot override suppression in self-hosted mode: the server refuses a send to a `
              + `suppressed recipient (409 recipient_suppressed) and accepts no override. `
              + "Clear the suppression first with `emails contact unsuppress <email>`. "
              + `Suppressed recipient(s): ${list}.`,
            ));
          } else {
            console.log(chalk.yellow("  --force: sending to the suppressed recipient(s) anyway."));
          }
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
          const tpl = getTemplate(opts.template);
          if (!tpl) handleError(new Error(`Template not found: ${opts.template}`));
          const vars: Record<string, string> = opts.vars ? JSON.parse(opts.vars) : {};
          subject = renderTemplate(tpl!.subject_template, vars);
          if (tpl!.html_template) htmlBody = renderTemplate(tpl!.html_template, vars);
          if (tpl!.text_template) textBody = renderTemplate(tpl!.text_template, vars);
        }

        if (!subject) handleError(new Error("Subject is required (use --subject or --template)"));

        // Send through the server API via the seam. Local-only concerns (provider
        // creds/warming/tracking/scheduling/threading tables, local ledger) do not
        // apply — the server owns sending.
        const attachments = readSendAttachments(opts.attachment);
        if (opts.dryRun) {
          // --dry-run PREDICTS the send, so every claim below must be true for the
          // mode that would actually run it. This block had no mode branch: in
          // local mode it announced "(self-hosted)", quoted the server's
          // attachment caps, and predicted that scheduling would fail — none of
          // which applies to a local send, which does support scheduling.
          const mode = getEmailsMode();
          const selfHosted = mode === "self_hosted";
          const limits = selfHosted ? SELF_HOSTED_SEND_ATTACHMENT_LIMITS : LOCAL_SEND_ATTACHMENT_LIMITS;
          console.log(chalk.bold(`\n[DRY RUN] Would send (${selfHosted ? "self-hosted" : "local"}):`));
          console.log(`  ${chalk.dim("From:")}    ${opts.from}`);
          console.log(`  ${chalk.dim("To:")}      ${toAddresses.join(", ")}`);
          if (opts.cc?.length) console.log(`  ${chalk.dim("CC:")}      ${opts.cc.join(", ")}`);
          console.log(`  ${chalk.dim("Subject:")} ${subject}`);
          if (htmlBody) console.log(`  ${chalk.dim("Body:")}    HTML (${htmlBody.length} chars)`);
          else if (textBody) console.log(`  ${chalk.dim("Body:")}    ${textBody.slice(0, 100)}${textBody.length > 100 ? "..." : ""}`);
          if (attachments.length) {
            console.log(chalk.dim(`  Attachments: ${attachments.length} inline file(s); ${mode} caps are ${describeSendAttachmentLimits(limits)}`));
          }
          if (opts.schedule) {
            console.log(selfHosted
              ? chalk.yellow(`  Schedule:    ${opts.schedule} — the self-hosted server does not accept a scheduled send (a real send would fail)`)
              : chalk.dim(`  Schedule:    ${opts.schedule} — a real send enqueues this locally; use \`emails schedule list\` to inspect the queue`));
          }
          console.log(chalk.yellow("\n  [NOT SENT] Use without --dry-run to send.\n"));
          return;
        }
        const result = await ds.send({
          from: opts.from,
          to: toAddresses.join(", "),
          cc: opts.cc && opts.cc.length > 0 ? opts.cc.join(", ") : undefined,
          bcc: opts.bcc && opts.bcc.length > 0 ? opts.bcc.join(", ") : undefined,
          subject,
          body: textBody ?? "",
          html: htmlBody,
          markdown: false,
          replyTo: opts.replyTo,
          // `--provider` used to be parsed and then dropped on the floor in BOTH
          // modes. Thread it through: local honours it, self_hosted refuses it
          // explicitly (the server chooses the sender), so it is never silently
          // ignored again.
          providerId: opts.provider,
          replyToId: (opts as Record<string, unknown>).inReplyTo as string | undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
          scheduledAt: opts.schedule,
          idempotencyKey: (opts as Record<string, unknown>).idempotencyKey as string | undefined,
        });
        console.log(chalk.green(`✓ Email sent to ${toAddresses.join(", ")}`));
        if (result.messageId) console.log(chalk.dim(`  Message ID: ${result.messageId}`));
        // The message left the provider even though a post-send step failed —
        // tell the operator NOT to re-send.
        if (result.warning) console.log(chalk.yellow(`  ⚠ ${result.warning}`));
      } catch (e) {
        handleError(e);
      }
    });

}
