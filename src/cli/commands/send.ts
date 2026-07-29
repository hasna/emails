import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { resolveMailDataSource, type MailSendAttachment } from "../../lib/mail-data-source.js";
import { getTemplate, renderTemplate } from "../../db/templates.js";
import { getGroupByName, listMemberSummaries } from "../../db/groups.js";
import { suppressedRecipientsAmong } from "../../db/contacts.js";
import { handleError } from "../utils.js";
import { getEmailsMode } from "../../lib/mode.js";
import {
  describeSendAttachmentLimits,
  LOCAL_SEND_ATTACHMENT_LIMITS,
  SELF_HOSTED_SEND_ATTACHMENT_LIMITS,
} from "../../lib/send-attachment-limits.js";
import { findAddressesByEmail } from "../../db/addresses.js";
import {
  describeUncheckedSendPolicy,
  evaluateAttachmentCaps,
  evaluateSenderPreflight,
} from "../../lib/send-preflight.js";

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

/**
 * Recipients of `--to-group <name>`.
 *
 * This used to be an unconditional refusal — "--to-group is not available in
 * the self-hosted client without a self-hosted group-members send API" — which
 * was wrong twice: it fired in local mode too, and no send API is needed. Group
 * fan-out is a CLIENT-side recipient lookup. `src/db/groups.ts` reads the store
 * seam resolved from storage configuration, and `emails group members <name>`
 * has been printing exactly this list against both stores all along. The
 * pre-febe87e implementation did the same two calls against a local handle.
 *
 * The member read now enumerates the WHOLE group or throws — never one clamped
 * page — because this list becomes the To: header: a partial read here mails a
 * subset of the group while reporting the group.
 *
 * The group expands into the To: header, which is what `--to a@x b@y` already
 * does — no per-recipient fan-out is invented here.
 */
async function resolveGroupRecipients(groupName: string): Promise<string[]> {
  const group = await getGroupByName(groupName);
  if (!group) {
    handleError(new Error(
      `Group not found: ${groupName}. List the groups you have with 'emails group list'.`,
    ));
  }
  const members = await listMemberSummaries(group!.id);
  if (members.length === 0) {
    handleError(new Error(
      `Group '${groupName}' has no members. Add some with 'emails group add ${groupName} <email...>'.`,
    ));
  }
  // A member added twice under different casing is ONE recipient; without this
  // the address appears twice in the To: header of the delivered message.
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const member of members) {
    const key = member.email.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    recipients.push(member.email.trim());
  }
  return recipients;
}

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

        // Resolve recipients from --to or --to-group.
        let toAddresses: string[] = opts.to || [];
        if (opts.toGroup) {
          // Refused rather than merged or silently overwritten: the previous
          // implementation replaced --to with the group, so an operator who
          // passed both mailed a set they did not ask for and got no warning.
          if (toAddresses.length > 0) {
            handleError(new Error(
              "Pass --to or --to-group, not both: --to-group replaces the recipient list, "
              + "so combining them would silently drop the explicit --to addresses.",
            ));
          }
          toAddresses = await resolveGroupRecipients(opts.toGroup);
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
        const suppressedRecipients = await suppressedRecipientsAmong(allRecipients);
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
          // A group expands into ONE message addressed to every member, so the
          // preview says so before the operator discovers it in the To: header
          // of the delivered mail.
          if (opts.toGroup) {
            console.log(chalk.dim(`  Group:   ${opts.toGroup} — ${toAddresses.length} member(s), all in one To: header`));
          }
          if (opts.cc?.length) console.log(`  ${chalk.dim("CC:")}      ${opts.cc.join(", ")}`);
          console.log(`  ${chalk.dim("Subject:")} ${subject}`);
          if (htmlBody) console.log(`  ${chalk.dim("Body:")}    HTML (${htmlBody.length} chars)`);
          else if (textBody) console.log(`  ${chalk.dim("Body:")}    ${textBody.slice(0, 100)}${textBody.length > 100 ? "..." : ""}`);
          if (attachments.length) {
            console.log(chalk.dim(`  Attachments: ${attachments.length} inline file(s); ${mode} caps are ${describeSendAttachmentLimits(limits)}`));
          }

          // ── the part that makes this a PRECHECK rather than an echo ──────────
          //
          // Everything above restates the arguments. Without what follows, this
          // command produced byte-identical output for a verified sender, an
          // unverified one whose send would be refused, and an address that does
          // not exist at all — while operators used it as a gate before real sends.
          if (selfHosted) {
            // Read the sender record over /v1/addresses. This creates no message
            // row and sends nothing; it answers the checks the server evaluates
            // first, in the same order, and names the same policy code.
            let senderRecord = null as { email: string; status: string; verified: boolean } | null;
            let senderLookupFailed: string | null = null;
            try {
              const matches = findAddressesByEmail(opts.from);
              senderRecord = matches[0]
                ? { email: matches[0].email, status: matches[0].status, verified: matches[0].verified }
                : null;
            } catch (e) {
              // A lookup that FAILED must never read as "sender is fine". Report the
              // failure as unknown, not as a pass.
              senderLookupFailed = e instanceof Error ? e.message : String(e);
            }
            if (senderLookupFailed) {
              console.log(chalk.yellow(`  Sender:  could not be checked — ${senderLookupFailed}`));
              console.log(chalk.dim("           This preview therefore does NOT predict whether the send is allowed."));
            } else {
              const verdict = evaluateSenderPreflight(opts.from, senderRecord);
              console.log(verdict.ok
                ? chalk.green(`  Sender:  ${verdict.message}`)
                : chalk.red(`  Sender:  WOULD BE REFUSED (${verdict.code}) — ${verdict.message}`));
            }
          }

          if (attachments.length) {
            // Evaluate the REAL files against the mode's caps. These numbers were
            // printed as prose above and never checked, so an attachment set the
            // self-hosted route refuses previewed as fine.
            const files = attachments.map((attachment) => ({
              filename: attachment.filename,
              bytes: Buffer.from(attachment.content, "base64").length,
            }));
            const capFindings = evaluateAttachmentCaps(files, limits);
            if (capFindings.length > 0) {
              for (const finding of capFindings) {
                console.log(chalk.red(`  Attach:  WOULD BE REFUSED (${finding.rule}) — ${finding.detail}`));
              }
            } else {
              console.log(chalk.green(`  Attach:  ${files.length} file(s) within the ${mode} caps.`));
            }
          }

          // Say what this did NOT prove. A preview that stops at its own green lines
          // is read as a guarantee it never made.
          console.log(chalk.dim(`  Note:    ${describeUncheckedSendPolicy(selfHosted)}`));
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
        if (result.inProgress) {
          console.log(chalk.yellow(`Send already in progress for ${toAddresses.join(", ")}; do not retry.`));
        } else {
          console.log(chalk.green(`✓ Email sent to ${toAddresses.join(", ")}`));
        }
        if (result.messageId) console.log(chalk.dim(`  Message ID: ${result.messageId}`));
        // The message left the provider even though a post-send step failed —
        // tell the operator NOT to re-send.
        if (result.warning) console.log(chalk.yellow(`  ⚠ ${result.warning}`));
      } catch (e) {
        handleError(e);
      }
    });

}
