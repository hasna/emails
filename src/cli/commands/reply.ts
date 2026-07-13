import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { resolveMailDataSource } from "../../lib/mail-data-source.js";
import { handleError } from "../utils.js";

function fwdPrefix(subject: string): string {
  return /^fwd?:/i.test(subject.trim()) ? subject : `Fwd: ${subject}`;
}

function quoteBody(from: string, at: string, body: string): string {
  return `\n\n---------- Forwarded message ----------\nFrom: ${from}\nDate: ${at}\n\n${body}`;
}

export function registerReplyCommand(program: Command, output: (data: unknown, formatted: string) => void): void {
  // ── forward ───────────────────────────────────────────────────────────────
  program
    .command("forward <id>")
    .description("Forward an inbound or sent email to new recipients (quoted body)")
    .requiredOption("--to <email...>", "Recipient(s)")
    .requiredOption("--from <email>", "From address")
    .option("--body <text>", "Optional note prepended to the quoted message")
    .option("--provider <id>", "Provider ID")
    .action(async (id: string, opts: { to: string[]; from: string; body?: string; provider?: string }) => {
      try {
        // Read the source message through the mail data source seam and forward
        // via the server send API (self-hosted-only client).
        const ds = resolveMailDataSource();
        const msg = await ds.getMessage(id);
        if (!msg) return handleError(new Error(`Email not found: ${id}`));
        const body = await ds.getMessageBody(msg);
        const origBody = body?.text ?? body?.html ?? "";
        const subject = fwdPrefix(msg.subject);
        const fwdBody = (opts.body ? opts.body : "") + quoteBody(msg.from, msg.date, origBody);
        const result = await ds.send({ from: opts.from, to: opts.to.join(", "), subject, body: fwdBody, markdown: false });
        output({ id: result.id, to: opts.to, subject }, chalk.green(`✓ forwarded to ${opts.to.join(", ")} — "${subject}"`));
      } catch (e) { handleError(e); }
    });

  program
    .command("reply <id>")
    .description("Reply to an inbound or sent email, in-thread (sets In-Reply-To/References, Re: subject)")
    .requiredOption("--body <text>", "Reply body")
    .option("--html", "Treat --body as HTML")
    .option("--provider <id>", "Provider ID (defaults to first active)")
    .option("--all", "Reply-all (include other recipients)")
    .option("--from <email>", "Override the From address")
    .action(async (id: string, opts: { body: string; html?: boolean; provider?: string; all?: boolean; from?: string }) => {
      try {
        // Read the parent through the seam and reply via the server send API.
        // NOTE: the server /messages/send endpoint carries no in-reply-to/references, so
        // the reply is delivered as a new message and is not thread-linked server-side.
        // We report the parent's real thread id (when present) rather than fabricating one.
        const ds = resolveMailDataSource();
        const msg = await ds.getMessage(id);
        if (!msg) return handleError(new Error(`Email not found: ${id}`));
        const { replyDefaults } = await import("../tui/data.js");
        const defaults = replyDefaults(msg);
        const from = opts.from ?? defaults.from;
        if (!from) return handleError(new Error("Could not determine From address; pass --from"));
        // Base recipients from the reply target; --all folds in the other recipients,
        // excluding ourselves and de-duping (addresses, not the joined string).
        const candidates = opts.all ? [defaults.to, ...msg.to.split(",")] : [defaults.to];
        const seen = new Set<string>();
        const toArr: string[] = [];
        for (const raw of candidates.flatMap((value) => value.split(","))) {
          const addr = raw.trim();
          if (!addr) continue;
          const key = addr.toLowerCase();
          if (key === from.toLowerCase() || seen.has(key)) continue;
          seen.add(key);
          toArr.push(addr);
        }
        const result = await ds.send({
          from,
          to: toArr.join(", "),
          subject: defaults.subject,
          body: opts.html ? "" : opts.body,
          html: opts.html ? opts.body : undefined,
          markdown: false,
          replyToId: id,
        });
        const threadId = msg.thread_id ?? null;
        const suffix = threadId ? ` (thread ${threadId.slice(0, 8)})` : "";
        output({ id: result.id, thread_id: threadId, to: toArr, subject: defaults.subject },
          chalk.green(`✓ replied to ${toArr.join(", ")} — "${defaults.subject}"${suffix}`));
      } catch (e) { handleError(e); }
    });
}
