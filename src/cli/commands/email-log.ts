/**
 * Email log, search, history, and sync commands.
 * Extracted from send.ts to keep the send command focused.
 *
 * Registers: email (namespace), log, search, show, replies, conversation,
 * test, export, webhook
 */
import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { resolveMailDataSource, type MailDataSource } from "../../lib/mail-data-source.js";
import { handleError, parseCliPositiveIntOption, parseCliNonNegativeIntOption } from "../utils.js";
import type { MessageBody, TuiMessage, TuiThreadMessage } from "../tui/data.js";
import { readableMessageText } from "../tui/format.js";

const DEFAULT_REPLY_LIMIT = 20;
const MAX_REPLY_LIMIT = 200;

interface ReplyPageOpts {
  limit?: string;
  offset?: string;
}

interface SentLogPageOpts {
  provider?: string;
  status?: string;
  from?: string;
  since?: string;
  limit?: string;
  offset?: string;
}

interface SelfHostedEmailSummary {
  id: string;
  kind: "inbound" | "sent";
  from_address: string;
  to_addresses: string[];
  subject: string;
  date: string;
  is_read: boolean;
  is_starred: boolean;
  labels: string[];
  attachments: number;
}

interface SelfHostedEmailDetail extends SelfHostedEmailSummary {
  cc_addresses: string[];
  text_body: string | null;
  html_body: string | null;
  flags: string[];
}

// Local sent-log/reporting, the local test-send and the local webhook/event
// listener have no /v1 equivalent in this self-hosted-only client: they run on
// the self-hosted server. These commands are kept for discoverability but fail
// loud.
function serverOnly(command: string): never {
  throw new Error(
    `${command} is not available in the self-hosted client; it runs on the self-hosted server.`,
  );
}

function parseReplyPage(opts: ReplyPageOpts): { limit: number; offset: number } {
  return {
    limit: parseCliPositiveIntOption(opts.limit, DEFAULT_REPLY_LIMIT, MAX_REPLY_LIMIT),
    offset: parseCliNonNegativeIntOption(opts.offset),
  };
}

function assertSupportedSelfHostedSentFilters(command: string, opts: SentLogPageOpts): void {
  const unsupported = [
    opts.provider ? "--provider" : null,
    opts.status ? "--status" : null,
    opts.from ? "--from" : null,
  ].filter(Boolean);
  if (unsupported.length === 0) return;
  handleError(new Error(
    `\`${command}\` is API-backed and does not support local sent-log filter(s): ${unsupported.join(", ")}. ` +
      "Use `emails inbox search` for mailbox search, or retry without those filters.",
  ));
}

function splitRecipients(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function toSelfHostedSummary(msg: TuiMessage): SelfHostedEmailSummary {
  return {
    id: msg.id,
    kind: msg.kind,
    from_address: msg.from,
    to_addresses: splitRecipients(msg.to),
    subject: msg.subject,
    date: msg.date,
    is_read: msg.is_read,
    is_starred: msg.is_starred,
    labels: msg.labels,
    attachments: msg.attachments,
  };
}

function toSelfHostedDetail(msg: TuiMessage, body: MessageBody | null): SelfHostedEmailDetail {
  const labels = msg.is_read
    ? msg.labels.filter((label) => label.trim().toLowerCase() !== "unread")
    : msg.labels;
  const flags = [
    msg.is_read ? "read" : "unread",
    msg.is_starred ? "starred" : null,
    ...labels,
    ...(body?.flags ?? []),
  ].filter((flag, index, list): flag is string => Boolean(flag) && list.indexOf(flag) === index);
  return {
    ...toSelfHostedSummary({ ...msg, labels }),
    from_address: body?.from ?? msg.from,
    to_addresses: splitRecipients(body?.to ?? msg.to),
    cc_addresses: splitRecipients(body?.cc ?? ""),
    subject: body?.subject ?? msg.subject,
    date: body?.date ?? msg.date,
    text_body: body?.text ?? null,
    html_body: body?.html ?? null,
    flags,
  };
}

function formatSelfHostedSummaries(rows: SelfHostedEmailSummary[], title: string): string {
  if (rows.length === 0) return chalk.dim(`${title}: no messages found.`);
  const lines: string[] = [];
  lines.push(chalk.bold(`\n${title} (${rows.length})`));
  lines.push(chalk.bold(`${"Date".padEnd(20)}  ${"From".padEnd(30)}  ${"To".padEnd(30)}  Subject`));
  lines.push(chalk.dim("─".repeat(116)));
  for (const row of rows) {
    const date = row.date ? new Date(row.date).toLocaleString().slice(0, 20) : "";
    const from = row.from_address.length > 30 ? row.from_address.slice(0, 27) + "..." : row.from_address;
    const toRaw = row.to_addresses[0] ?? "";
    const to = toRaw.length > 30 ? toRaw.slice(0, 27) + "..." : toRaw;
    const subject = row.subject.length > 44 ? row.subject.slice(0, 41) + "..." : row.subject;
    lines.push(`${date.padEnd(20)}  ${from.padEnd(30)}  ${to.padEnd(30)}  ${subject}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatSelfHostedDetail(email: SelfHostedEmailDetail): string {
  const lines: string[] = [
    chalk.bold(`\nEmail: ${email.id}`),
    `  ${chalk.dim("Subject:")}  ${email.subject}`,
    `  ${chalk.dim("From:")}     ${email.from_address}`,
    `  ${chalk.dim("To:")}       ${email.to_addresses.join(", ")}`,
  ];
  if (email.cc_addresses.length > 0) lines.push(`  ${chalk.dim("CC:")}       ${email.cc_addresses.join(", ")}`);
  lines.push(`  ${chalk.dim("Kind:")}     ${email.kind}`);
  lines.push(`  ${chalk.dim("Date:")}     ${email.date}`);
  if (email.flags.length > 0) lines.push(`  ${chalk.dim("Flags:")}    ${email.flags.join(", ")}`);
  if (email.attachments > 0) lines.push(`  ${chalk.dim("Attach:")}   ${email.attachments}`);
  const body = readableMessageText(email.text_body, email.html_body);
  if (body) {
    lines.push(chalk.bold("\n  Body:"));
    lines.push(body.split("\n").map((line: string) => `    ${line}`).join("\n"));
  }
  lines.push("");
  return lines.join("\n");
}

async function selfHostedSentList(
  ds: MailDataSource,
  opts: SentLogPageOpts,
  output: (data: unknown, formatted: string) => void,
  command: string,
): Promise<void> {
  assertSupportedSelfHostedSentFilters(command, opts);
  const rows = await ds.listMailbox("sent", {
    limit: parseCliPositiveIntOption(opts.limit, 20),
    offset: parseCliNonNegativeIntOption(opts.offset),
    since: opts.since,
  });
  const summaries = rows.map(toSelfHostedSummary);
  output(summaries, formatSelfHostedSummaries(summaries, "Self-hosted sent mail"));
}

async function selfHostedSentSearch(
  ds: MailDataSource,
  query: string,
  opts: { since?: string; limit?: string; offset?: string },
  output: (data: unknown, formatted: string) => void,
): Promise<void> {
  const rows = await ds.listMailbox("sent", {
    search: query,
    since: opts.since,
    limit: parseCliPositiveIntOption(opts.limit, 20),
    offset: parseCliNonNegativeIntOption(opts.offset),
  });
  const summaries = rows.map(toSelfHostedSummary);
  output(summaries, formatSelfHostedSummaries(summaries, `Self-hosted sent search "${query}"`));
}

async function selfHostedShow(
  ds: MailDataSource,
  id: string,
  output: (data: unknown, formatted: string) => void,
): Promise<void> {
  const resolvedId = await ds.resolveId(id);
  const msg = await ds.getMessage(resolvedId);
  if (!msg) handleError(new Error(`Email not found: ${id}`));
  const body = await ds.getMessageBody(msg!);
  const detail = toSelfHostedDetail(msg!, body);
  output(detail, formatSelfHostedDetail(detail));
}

/** Resolve a message and read its full thread through the mail data source. */
async function selfHostedConversation(ds: MailDataSource, id: string): Promise<{ msg: TuiMessage; messages: TuiThreadMessage[] }> {
  const resolvedId = await ds.resolveId(id);
  const msg = await ds.getMessage(resolvedId);
  if (!msg) handleError(new Error(`Email not found: ${id}`));
  const messages = await ds.getConversation(msg!);
  return { msg: msg!, messages };
}

function formatThreadMessages(rows: TuiThreadMessage[], header: string): string {
  const lines: string[] = [chalk.bold(`\n${header}`)];
  if (!rows.length) {
    lines.push(chalk.dim("  No messages in this thread."));
    lines.push("");
    return lines.join("\n");
  }
  for (const m of rows) {
    const tag = m.kind === "sent" ? chalk.green("→ sent") : chalk.cyan("← recv");
    lines.push(`  ${tag}  ${m.at.slice(0, 16)}  ${chalk.dim(m.from)}`);
    lines.push(`         ${m.subject}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatReplies(replies: TuiThreadMessage[], total: number, limit: number, offset: number, label: string): string {
  if (!replies.length) return chalk.dim(`No replies${total > 0 ? " in this page" : ""}.`);
  const lines: string[] = [];
  lines.push(chalk.bold(`\n${replies.length} of ${total} repl${total === 1 ? "y" : "ies"}${label ? ` for ${label}` : ""}`));
  if (offset > 0 || offset + replies.length < total) {
    lines.push(chalk.dim(`Showing offset ${offset}, limit ${limit}${offset + replies.length < total ? " (more available)" : ""}.`));
  }
  lines.push("");
  for (const r of replies) {
    lines.push(`  ${chalk.dim(r.at.slice(0, 16))}  ${chalk.cyan(r.from)}`);
    lines.push(`  ${chalk.dim("Subject:")} ${r.subject || "(no subject)"}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function registerEmailLogCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  // ─── EMAIL NAMESPACE ─────────────────────────────────────────────────────────
  // Unified `email` command group — all sent-email operations in one place.
  // The old top-level commands (log, search, show, replies, conversation, test)
  // remain as aliases for backwards compatibility.

  const emailCmd = program.command("email").description("Sent email log, search, and history");

  emailCmd
    .command("list")
    .description("List sent emails")
    .option("--provider <id>", "Filter by provider ID")
    .option("--status <status>", "Filter by status: sent|delivered|bounced|complained|failed")
    .option("--from <email>", "Filter by sender address")
    .option("--since <date>", "Show emails since date (ISO 8601)")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip first N emails", "0")
    .action(async (opts: SentLogPageOpts) => {
      try {
        await selfHostedSentList(resolveMailDataSource(), opts, output, "emails email list");
      } catch (e) { handleError(e); }
    });

  emailCmd
    .command("search <query>")
    .description("Search sent email by subject, from, or to")
    .option("--since <date>", "Show emails since date")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip first N results", "0")
    .action(async (query: string, opts: { since?: string; limit?: string; offset?: string }) => {
      try {
        await selfHostedSentSearch(resolveMailDataSource(), query, opts, output);
      } catch (e) { handleError(e); }
    });

  emailCmd
    .command("show <id>")
    .description("Show full details and body of a sent email")
    .action(async (id: string) => {
      try {
        await selfHostedShow(resolveMailDataSource(), id, output);
      } catch (e) { handleError(e); }
    });

  emailCmd
    .command("replies <id>")
    .description("Show replies received for a sent email")
    .option("--limit <n>", "Max replies", String(DEFAULT_REPLY_LIMIT))
    .option("--offset <n>", "Skip first N replies", "0")
    .action(async (id: string, opts: ReplyPageOpts) => {
      try {
        const { messages } = await selfHostedConversation(resolveMailDataSource(), id);
        const received = messages.filter((m) => m.kind === "received");
        const { limit, offset } = parseReplyPage(opts);
        const total = received.length;
        const pageItems = received.slice(offset, offset + limit);
        output(
          { replies: pageItems, total, limit, offset, has_more: offset + pageItems.length < total },
          formatReplies(pageItems, total, limit, offset, ""),
        );
      } catch (e) { handleError(e); }
    });

  emailCmd
    .command("thread <id>")
    .description("Show the full conversation (sent + received), grouped by thread_id")
    .option("--limit <n>", "Max reply bodies for fallback conversations", String(DEFAULT_REPLY_LIMIT))
    .option("--offset <n>", "Skip first N fallback replies", "0")
    .action(async (id: string) => {
      try {
        const { msg, messages } = await selfHostedConversation(resolveMailDataSource(), id);
        const header = `Thread${msg.thread_id ? ` ${msg.thread_id.slice(0, 8)}` : ""} (${messages.length} message${messages.length !== 1 ? "s" : ""})`;
        output({ thread_id: msg.thread_id, messages }, formatThreadMessages(messages, header));
      } catch (e) { handleError(e); }
    });

  emailCmd
    .command("send")
    .description("Send an email (alias of top-level `emails send`)")
    .option("--from <email>", "Sender")
    .option("--to <email...>", "Recipient(s)")
    .option("--subject <subject>", "Subject")
    .option("--body <text>", "Body")
    .option("--provider <id>", "Provider ID")
    .action(() => { console.log(chalk.dim("Use: emails send --from ... --to ... --subject ... --body ...")); });

  // ─── LOG ─────────────────────────────────────────────────────────────────────
  program.command("log").description("Show email send log (alias: emails email list)")
    .option("--provider <id>", "Filter by provider ID")
    .option("--status <status>", "Filter by status: sent|delivered|bounced|complained|failed")
    .option("--from <email>", "Filter by sender address")
    .option("--since <date>", "Show emails since date (ISO 8601)")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip first N emails", "0")
    .action(async (opts: SentLogPageOpts) => {
      try {
        await selfHostedSentList(resolveMailDataSource(), opts, output, "emails log");
      } catch (e) { handleError(e); }
    });

  // ─── SEARCH ─────────────────────────────────────────────────────────────────
  program.command("search <query>").description("Search email by subject, from, or to")
    .option("--since <date>", "Show emails since date (ISO 8601)")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip first N results", "0")
    .action(async (query: string, opts: { since?: string; limit?: string; offset?: string }) => {
      try {
        await selfHostedSentSearch(resolveMailDataSource(), query, opts, output);
      } catch (e) { handleError(e); }
    });

  // ─── SHOW EMAIL ──────────────────────────────────────────────────────────────
  program.command("show <id>").description("Show full email details including body content")
    .action(async (id: string) => {
      try {
        await selfHostedShow(resolveMailDataSource(), id, output);
      } catch (e) { handleError(e); }
    });

  // ─── REPLIES ─────────────────────────────────────────────────────────────────
  program.command("replies <id>").description("Show replies received for a sent email")
    .option("--limit <n>", "Max replies", String(DEFAULT_REPLY_LIMIT))
    .option("--offset <n>", "Skip first N replies", "0")
    .action(async (id: string, opts: ReplyPageOpts) => {
      try {
        const { messages } = await selfHostedConversation(resolveMailDataSource(), id);
        const received = messages.filter((m) => m.kind === "received");
        const { limit, offset } = parseReplyPage(opts);
        const total = received.length;
        const pageItems = received.slice(offset, offset + limit);
        output(
          { replies: pageItems, total, limit, offset, has_more: offset + pageItems.length < total },
          formatReplies(pageItems, total, limit, offset, `email ${id.slice(0, 8)}`),
        );
      } catch (e) { handleError(e); }
    });

  // ─── CONVERSATION ─────────────────────────────────────────────────────────────
  program.command("conversation <id>").description("Show full conversation thread for a sent email (email + all replies)")
    .option("--limit <n>", "Max reply bodies", String(DEFAULT_REPLY_LIMIT))
    .option("--offset <n>", "Skip first N replies", "0")
    .action(async (id: string) => {
      try {
        const { msg, messages } = await selfHostedConversation(resolveMailDataSource(), id);
        const header = `Conversation thread${msg.thread_id ? ` ${msg.thread_id.slice(0, 8)}` : ""} (${messages.length} message${messages.length === 1 ? "" : "s"})`;
        output({ thread_id: msg.thread_id, messages }, formatThreadMessages(messages, header));
      } catch (e) { handleError(e); }
    });

  // ─── TEST ────────────────────────────────────────────────────────────────────
  program.command("test [provider-id]").description("Send a test email")
    .option("--to <email>", "Recipient email address")
    .action(async () => {
      try { serverOnly("emails test"); } catch (e) { handleError(e); }
    });

  // ─── EXPORT ──────────────────────────────────────────────────────────────────
  program
    .command("export <type>")
    .description("Export emails or events (type: emails | events)")
    .option("--provider <id>", "Filter by provider ID")
    .option("--from <email>", "Filter exported emails by sender address")
    .option("--since <date>", "Filter from date (ISO)")
    .option("--until <date>", "Filter until date (ISO)")
    .option("--limit <n>", "Maximum rows to export")
    .option("--offset <n>", "Number of rows to skip")
    .option("--format <fmt>", "Output format: json | csv", "json")
    .option("--output <file>", "Write to file instead of stdout")
    .action(() => {
      try { serverOnly("emails export"); } catch (e) { handleError(e); }
    });

  // ─── WEBHOOK ─────────────────────────────────────────────────────────────────
  const webhookCmd = program.command("webhook").description("Webhook receiver for email events");
  webhookCmd
    .command("listen")
    .description("Start webhook listener server")
    .option("--port <port>", "Port to listen on", "9877")
    .option("--provider <id>", "Provider ID to associate events with")
    .action(async () => {
      try { serverOnly("emails webhook listen"); } catch (e) { handleError(e); }
    });
}
