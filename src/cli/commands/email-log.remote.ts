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
import { registerEmailSendAlias } from "./email-send-alias.js";
import { handleError, parseCliPositiveIntOption, parseCliNonNegativeIntOption, resolveId } from "../utils.js";
import type { MessageBody, TuiMessage, TuiThreadMessage } from "../tui/data.js";
import { formatThreadLabel, readableMessageText } from "../tui/format.js";

const DEFAULT_REPLY_LIMIT = 20;
const MAX_REPLY_LIMIT = 200;
const MAX_EMAIL_EXPORT_LIMIT = 10000;

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

export interface SelfHostedEmailSummary {
  id: string;
  kind: "inbound" | "sent";
  from_address: string;
  /** Recipients — same content as to_addresses; kept under both keys because
   * operators script against `to`/`cc` (they read null during the 2026-07-25
   * incident) while `to_addresses` predates them. */
  to: string[];
  cc: string[];
  to_addresses: string[];
  cc_addresses: string[];
  /** Ledger status (sent | failed | uncertain | …); null when unreported. An
   * uncertain/failed send must never serialize identically to a delivered one. */
  status: string | null;
  send_state: string | null;
  /**
   * Why an outbound policy gate refused this message (e.g. `sender_unverified`);
   * null when it was not refused.
   *
   * A status of `blocked` is not a diagnosis. The refusal happens in
   * evaluateOutboundPolicy before any provider call, and the reason was written
   * only into the server's headers.policy_denial — a field this serializer used to
   * drop, along with all other headers. So every CLI path (`emails show`,
   * `emails log`, `emails email list`) printed the bare word `blocked`, and the
   * only way to learn the cause was to call GET /v1/messages/{id} by hand. On
   * 2026-07-22 that hid a refused customs-document email for a held shipment for
   * five days, until the shipment was returned to its shipper (2026-07-27).
   */
  policy_denial: string | null;
  subject: string;
  date: string;
  is_read: boolean;
  is_starred: boolean;
  labels: string[];
  attachments: number;
}

interface SelfHostedEmailDetail extends SelfHostedEmailSummary {
  text_body: string | null;
  html_body: string | null;
  flags: string[];
}

// The local test-send and the local webhook/event listener have no /v1
// equivalent in this self-hosted-only client: one drives the local provider
// pipeline, the other binds a local HTTP port to receive provider callbacks that
// are addressed to the operator's server. Both are kept for discoverability but
// fail loud.
//
// `emails export` is NOT one of them: src/lib/export.ts reads through the routed
// `db/emails.js` and `db/events.js` repositories, which are `/v1/messages` and
// `/v1/events` clients in this mode — the same path the MCP `export_emails` /
// `export_events` tools already take.
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

export function toSelfHostedSummary(msg: TuiMessage): SelfHostedEmailSummary {
  const to = splitRecipients(msg.to);
  const cc = splitRecipients(msg.cc ?? "");
  return {
    id: msg.id,
    kind: msg.kind,
    from_address: msg.from,
    to,
    cc,
    to_addresses: to,
    cc_addresses: cc,
    status: msg.status ?? null,
    send_state: msg.send_state ?? null,
    policy_denial: msg.policy_denial ?? null,
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
  const to = splitRecipients(body?.to ?? msg.to);
  const cc = splitRecipients(body?.cc ?? msg.cc ?? "");
  return {
    ...toSelfHostedSummary({ ...msg, labels }),
    from_address: body?.from ?? msg.from,
    to,
    cc,
    to_addresses: to,
    cc_addresses: cc,
    subject: body?.subject ?? msg.subject,
    date: body?.date ?? msg.date,
    text_body: body?.text ?? null,
    html_body: body?.html ?? null,
    flags,
  };
}

/** Status cell: highlight anything that is NOT a completed send. */
function statusCell(row: SelfHostedEmailSummary): string {
  const value = (row.send_state ?? row.status ?? "").trim();
  if (!value) return "-";
  return value;
}

const STATES_THAT_NEED_NO_REASON = ["sent", "delivered", "received", "-"] as const;

/**
 * `blocked (sender_unverified)` rather than `blocked`.
 *
 * The state alone tells an operator that mail did not go out; the code tells them
 * what to change. Falls back to the bare state when the row carries no reason —
 * inventing one would be worse than the silence this fixes.
 */
function statusWithReason(row: SelfHostedEmailSummary): string {
  const reason = policyDenialToShow(row);
  const state = statusCell(row);
  return reason ? `${state} (${reason})` : state;
}

/**
 * The denial code worth showing for this row, or null.
 *
 * Shared by the table and the single-message view so they cannot disagree. A row
 * that reached a completed state suppresses it: a stale code left on a message that
 * ultimately sent would otherwise make delivered mail read as refused.
 */
function policyDenialToShow(row: SelfHostedEmailSummary): string | null {
  const reason = row.policy_denial?.trim();
  if (!reason) return null;
  const state = statusCell(row);
  if ((STATES_THAT_NEED_NO_REASON as readonly string[]).includes(state)) return null;
  // The detail view reads send_state ?? status while the table reads the same pair;
  // if EITHER says the send completed, treat it as completed.
  const settled = [row.send_state, row.status]
    .map((value) => (value ?? "").trim())
    .filter(Boolean);
  if (settled.some((value) => (STATES_THAT_NEED_NO_REASON as readonly string[]).includes(value))) return null;
  return reason;
}

/** Status column width: wide enough for the widest cell actually present. */
const MIN_STATUS_WIDTH = 10;
const MAX_STATUS_WIDTH = 34;

export function formatSelfHostedSummaries(rows: SelfHostedEmailSummary[], title: string): string {
  if (rows.length === 0) return chalk.dim(`${title}: no messages found.`);
  const lines: string[] = [];
  lines.push(chalk.bold(`\n${title} (${rows.length})`));
  // The column is sized from the rows rather than fixed at 10, because a fixed 10
  // would truncate `blocked (sender_unverified)` to `blocked (s` — which is how a
  // reason gets lost a second time, in the renderer instead of the serializer.
  // Pages with no refusals keep the original width, so ordinary output is unchanged.
  const statusWidth = Math.min(
    MAX_STATUS_WIDTH,
    Math.max(MIN_STATUS_WIDTH, ...rows.map((row) => statusWithReason(row).length)),
  );
  lines.push(chalk.bold(`${"Date".padEnd(20)}  ${"Status".padEnd(statusWidth)}  ${"From".padEnd(28)}  ${"To".padEnd(28)}  Subject`));
  lines.push(chalk.dim("─".repeat(106 + statusWidth)));
  for (const row of rows) {
    const date = row.date ? new Date(row.date).toLocaleString().slice(0, 20) : "";
    const rawStatus = statusWithReason(row);
    // Truncate with an ellipsis, like the From/To/Subject columns. An unmarked cut
    // produces `blocked (recipient_domain_not_veri` — a value that looks complete and
    // is not, which is the same "reason lost in the renderer" failure one step later.
    const paddedStatus = rawStatus.length > statusWidth
      ? `${rawStatus.slice(0, Math.max(1, statusWidth - 3))}...`
      : rawStatus.padEnd(statusWidth);
    // A send that is not `sent`/delivered/received must stand out — rendering
    // `uncertain`/`failed` like delivered mail is what hid the 2026-07-25 defect.
    const ok = (STATES_THAT_NEED_NO_REASON as readonly string[]).includes(rawStatus);
    const status = ok ? paddedStatus : chalk.yellow(paddedStatus);
    const from = row.from_address.length > 28 ? row.from_address.slice(0, 25) + "..." : row.from_address;
    const toRaw = row.to_addresses[0] ?? "";
    const to = toRaw.length > 28 ? toRaw.slice(0, 25) + "..." : toRaw;
    const subject = row.subject.length > 42 ? row.subject.slice(0, 39) + "..." : row.subject;
    lines.push(`${date.padEnd(20)}  ${status}  ${from.padEnd(28)}  ${to.padEnd(28)}  ${subject}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function formatSelfHostedDetail(email: SelfHostedEmailDetail): string {
  const lines: string[] = [
    chalk.bold(`\nEmail: ${email.id}`),
    `  ${chalk.dim("Subject:")}  ${email.subject}`,
    `  ${chalk.dim("From:")}     ${email.from_address}`,
    `  ${chalk.dim("To:")}       ${email.to_addresses.join(", ")}`,
  ];
  if (email.cc_addresses.length > 0) lines.push(`  ${chalk.dim("CC:")}       ${email.cc_addresses.join(", ")}`);
  {
    // The single-message view must expose the ledger truth too — hiding it is
    // how the 2026-07-25 never-sent mail read as delivered.
    const state = (email.send_state ?? email.status ?? "").trim();
    if (state) {
      const ok = ["sent", "delivered", "received"].includes(state);
      lines.push(`  ${chalk.dim("Status:")}   ${ok ? state : chalk.yellow(state)}`);
    }
    // …and the REASON on its own line, because this is the view an operator opens
    // when a send did not arrive. `blocked` means a local outbound policy gate
    // refused the message before any provider was contacted — it is not a provider
    // or DNS problem, and it will not resolve on retry until the cause is fixed.
    //
    // Suppressed for a completed send, by the SAME rule the table uses: a row that
    // ended up `sent` while still carrying a stale denial code must not read as
    // refused in one view and delivered in the other. One rule, both renderers.
    const reason = policyDenialToShow(email);
    if (reason) {
      lines.push(`  ${chalk.dim("Blocked by:")} ${chalk.red(reason)} ${chalk.dim("(outbound policy gate; no provider was contacted)")}`);
    }
  }
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

/**
 * The other messages of the conversation that came IN — i.e. the replies. The
 * selected message is excluded even when it is itself inbound, so `replies <id>`
 * never counts the message you asked about as a reply to itself.
 *
 * This is the whole inbound side of the conversation, not local mode's strict
 * depth-1 `in_reply_to_email_id` children: the self-hosted rows expose the
 * conversation, not a parent-child edge per message, and under-reporting a reply
 * is the failure this replaces. The response SHAPE is identical to local's
 * ({ replies, total, limit, offset, has_more }).
 */
function repliesInConversation(msg: TuiMessage, conversation: TuiThreadMessage[]): TuiThreadMessage[] {
  return conversation.filter((entry) => entry.kind === "received" && entry.id !== msg.id);
}

function threadPage<T>(rows: T[], limit: number, offset: number): { items: T[]; total: number; has_more: boolean } {
  const items = rows.slice(offset, offset + limit);
  return { items, total: rows.length, has_more: offset + items.length < rows.length };
}

function formatThreadMessages(rows: TuiThreadMessage[], header: string, total = rows.length): string {
  const lines: string[] = [chalk.bold(`\n${header}`)];
  if (!rows.length) {
    // An empty PAGE of a non-empty thread is not an empty thread.
    lines.push(chalk.dim(total > 0 ? "  No messages on this page of the thread." : "  No messages in this thread."));
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
    .description("Show the inbound messages received in this email's conversation")
    .option("--limit <n>", "Max replies", String(DEFAULT_REPLY_LIMIT))
    .option("--offset <n>", "Skip first N replies", "0")
    .action(async (id: string, opts: ReplyPageOpts) => {
      try {
        const { msg, messages } = await selfHostedConversation(resolveMailDataSource(), id);
        const received = repliesInConversation(msg, messages);
        const { limit, offset } = parseReplyPage(opts);
        const { items, total, has_more } = threadPage(received, limit, offset);
        output(
          { replies: items, total, limit, offset, has_more },
          formatReplies(items, total, limit, offset, ""),
        );
      } catch (e) { handleError(e); }
    });

  emailCmd
    .command("thread <id>")
    .description("Show the full conversation (sent + received) this email belongs to")
    .option("--limit <n>", "Max thread messages to show", String(DEFAULT_REPLY_LIMIT))
    .option("--offset <n>", "Skip first N thread messages", "0")
    .action(async (id: string, opts: ReplyPageOpts) => {
      try {
        const { msg, messages } = await selfHostedConversation(resolveMailDataSource(), id);
        const { limit, offset } = parseReplyPage(opts);
        const { items, total, has_more } = threadPage(messages, limit, offset);
        const header = `Thread${formatThreadLabel(msg.thread_id)} (${items.length} of ${total} message${total !== 1 ? "s" : ""})`;
        output(
          { thread_id: msg.thread_id, messages: items, total, limit, offset, has_more },
          formatThreadMessages(items, header, total),
        );
      } catch (e) { handleError(e); }
    });

  // Forwards verbatim to the real `send` command — the previous stub here
  // accepted a fully-specified send and exited 0 without sending (task
  // 95f66fd3). The shared helper carries the full rationale.
  registerEmailSendAlias(emailCmd, output);

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
  program.command("replies <id>").description("Show the inbound messages received in this email's conversation")
    .option("--limit <n>", "Max replies", String(DEFAULT_REPLY_LIMIT))
    .option("--offset <n>", "Skip first N replies", "0")
    .action(async (id: string, opts: ReplyPageOpts) => {
      try {
        const { msg, messages } = await selfHostedConversation(resolveMailDataSource(), id);
        const received = repliesInConversation(msg, messages);
        const { limit, offset } = parseReplyPage(opts);
        const { items, total, has_more } = threadPage(received, limit, offset);
        output(
          { replies: items, total, limit, offset, has_more },
          formatReplies(items, total, limit, offset, `email ${id.slice(0, 8)}`),
        );
      } catch (e) { handleError(e); }
    });

  // ─── CONVERSATION ─────────────────────────────────────────────────────────────
  program.command("conversation <id>").description("Show full conversation thread for a sent email (email + all replies)")
    .option("--limit <n>", "Max thread messages to show", String(DEFAULT_REPLY_LIMIT))
    .option("--offset <n>", "Skip first N thread messages", "0")
    .action(async (id: string, opts: ReplyPageOpts) => {
      try {
        const { msg, messages } = await selfHostedConversation(resolveMailDataSource(), id);
        const { limit, offset } = parseReplyPage(opts);
        const { items, total, has_more } = threadPage(messages, limit, offset);
        const header = `Conversation thread${formatThreadLabel(msg.thread_id)} (${items.length} of ${total} message${total === 1 ? "" : "s"})`;
        output(
          { thread_id: msg.thread_id, messages: items, total, limit, offset, has_more },
          formatThreadMessages(items, header, total),
        );
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
    .action(async (type: string, opts: { provider?: string; from?: string; since?: string; until?: string; limit?: string; offset?: string; format?: string; output?: string }) => {
      try {
        if (type !== "emails" && type !== "events") {
          handleError(new Error("Export type must be 'emails' or 'events'"));
        }

        const { exportEmailsCsv, exportEmailsJson, exportEventsCsv, exportEventsJson, EXPORT_DEFAULT_LIMIT } =
          await import("../../lib/export.js");
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const fmt = opts.format ?? "json";
        const hasPage = opts.limit !== undefined || opts.offset !== undefined;
        // The fallback is the EXPORT default (1000), not 50. `--offset` alone used to
        // flip `hasPage` and then apply a 50-row limit nobody asked for, so a no-op
        // `--offset 0` silently cut a 120-row export to 50 while reporting success.
        const limit = hasPage
          ? parseCliPositiveIntOption(opts.limit, EXPORT_DEFAULT_LIMIT, MAX_EMAIL_EXPORT_LIMIT)
          : undefined;
        const offset = hasPage ? parseCliNonNegativeIntOption(opts.offset, 0) : undefined;
        const page = hasPage ? { limit, offset } : {};
        let result: string;

        if (type === "emails") {
          const filters = { provider_id: providerId, from_address: opts.from, since: opts.since, until: opts.until, ...page };
          result = fmt === "csv" ? await exportEmailsCsv(filters) : await exportEmailsJson(filters);
        } else {
          const filters = { provider_id: providerId, since: opts.since, until: opts.until, ...page };
          result = fmt === "csv" ? await exportEventsCsv(filters) : await exportEventsJson(filters);
        }

        if (opts.output) {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(opts.output, result, "utf-8");
          output({ exported: type, format: fmt, output: opts.output }, chalk.green("✓ Exported " + type + " to " + opts.output));
        } else if (fmt === "json") {
          // output(parsed, raw) rather than console.log(raw): the export is
          // already a JSON string, and under --json the console wrapper
          // re-encoded it as {"output":["<entire export as one string>"]}
          // (task 15908bba).
          output(JSON.parse(result), result);
        } else {
          console.log(result);
        }
      } catch (e) {
        handleError(e);
      }
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
