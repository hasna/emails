/**
 * `emails send-intent` — inspect and close out outbound sends whose provider
 * outcome was never established.
 *
 * A message in `send_state = 'uncertain'` is the one case where the ledger
 * genuinely does not know whether mail left the building. On 2026-07-25 seven
 * such rows existed with no command able to list them and no command able to
 * resolve them, so they stayed indistinguishable from delivered mail. These
 * subcommands are that missing path.
 *
 * Reconciliation NEVER guesses: the operator asserts the outcome, supplies the
 * evidence, and (for a `sent` outcome) the provider message id that proves it.
 */
import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { selfHostedApiRequest } from "../../db/self-hosted-store.js";
import { getEmailsMode } from "../../lib/mode.js";
import { handleError, parseCliNonNegativeIntOption, parseCliPositiveIntOption } from "../utils.js";

type OutputFn = (data: unknown, formatted: string) => void;

export interface UncertainSendIntentRow {
  id: string;
  from_addr: string;
  to_addrs: string[];
  subject: string;
  send_state: string;
  status: string;
  provider_message_id: string | null;
  created_at: string;
}

function assertSelfHosted(command: string): void {
  if (getEmailsMode() === "self_hosted") return;
  throw new Error(
    `${command} operates on the self-hosted send-intent ledger, which only exists in self_hosted mode. `
      + "Local mode sends synchronously and records no uncertain state.",
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bodyError(json: unknown, fallback: string): string {
  const error = asRecord(json)["error"];
  return typeof error === "string" && error ? error : fallback;
}

function toRow(value: unknown): UncertainSendIntentRow {
  const record = asRecord(value);
  const recipients = record["to_addrs"];
  return {
    id: String(record["id"] ?? ""),
    from_addr: String(record["from_addr"] ?? ""),
    to_addrs: Array.isArray(recipients) ? recipients.map((entry) => String(entry)) : [],
    subject: String(record["subject"] ?? ""),
    send_state: String(record["send_state"] ?? ""),
    status: String(record["status"] ?? ""),
    provider_message_id: typeof record["provider_message_id"] === "string" ? record["provider_message_id"] : null,
    created_at: String(record["created_at"] ?? ""),
  };
}

export function formatUncertainRows(rows: UncertainSendIntentRow[]): string {
  if (rows.length === 0) {
    return chalk.green("No send intents are uncertain: every outbound message has a proven outcome.");
  }
  const lines: string[] = [
    chalk.yellow(`\n${rows.length} send intent(s) with an UNKNOWN provider outcome — neither sent nor failed:`),
    "",
  ];
  for (const row of rows) {
    lines.push(`  ${chalk.cyan(row.id)}  ${row.created_at.slice(0, 19)}`);
    lines.push(`    ${chalk.dim("From:")}    ${row.from_addr}`);
    lines.push(`    ${chalk.dim("To:")}      ${row.to_addrs.join(", ")}`);
    lines.push(`    ${chalk.dim("Subject:")} ${row.subject}`);
    lines.push("");
  }
  lines.push(chalk.dim("Resolve each one against provider evidence:"));
  lines.push(chalk.dim("  emails send-intent reconcile <id> --outcome not-sent --evidence \"...\""));
  lines.push(chalk.dim("  emails send-intent reconcile <id> --outcome sent --provider-message-id <id> --evidence \"...\""));
  lines.push("");
  return lines.join("\n");
}

export function registerSendIntentCommands(program: Command, output: OutputFn): void {
  const cmd = program
    .command("send-intent")
    .description("Inspect and reconcile outbound sends with an unknown provider outcome");

  cmd
    .command("uncertain")
    .description("List sends whose provider outcome was never established")
    .option("--limit <n>", "Max rows", "100")
    .option("--offset <n>", "Skip first N rows", "0")
    .action((opts: { limit?: string; offset?: string }) => {
      try {
        assertSelfHosted("emails send-intent uncertain");
        const limit = parseCliPositiveIntOption(opts.limit, 100, 500);
        const offset = parseCliNonNegativeIntOption(opts.offset);
        const { status, json } = selfHostedApiRequest(
          "GET",
          `/messages/send-intents/uncertain?limit=${limit}&offset=${offset}`,
        );
        if (status < 200 || status >= 300) {
          return handleError(new Error(bodyError(json, `Listing uncertain send intents failed (HTTP ${status}).`)));
        }
        const payload = asRecord(json);
        const rows = (Array.isArray(payload["uncertain"]) ? payload["uncertain"] : []).map(toRow);
        output({ uncertain: rows, count: rows.length }, formatUncertainRows(rows));
      } catch (error) {
        handleError(error);
      }
    });

  cmd
    .command("reconcile <id>")
    .description("Record the TRUE outcome of one uncertain send, with evidence")
    .requiredOption("--outcome <outcome>", "sent | not-sent")
    .requiredOption("--evidence <text>", "What proves this outcome (provider message id, delivery event, metric window)")
    .option("--provider-message-id <id>", "Provider message id — required when --outcome sent")
    .action((id: string, opts: { outcome: string; evidence: string; providerMessageId?: string }) => {
      try {
        assertSelfHosted("emails send-intent reconcile");
        const normalized = opts.outcome.trim().toLowerCase().replace(/-/g, "_");
        if (normalized !== "sent" && normalized !== "not_sent") {
          return handleError(new Error("--outcome must be 'sent' (it left the provider) or 'not-sent' (it did not)"));
        }
        const evidence = opts.evidence.trim();
        if (!evidence) return handleError(new Error("--evidence must not be empty"));
        const providerMessageId = opts.providerMessageId?.trim() ?? "";
        if (normalized === "sent" && !providerMessageId) {
          return handleError(new Error(
            "--provider-message-id is required with --outcome sent: only the provider's own id proves the message left.",
          ));
        }
        const { status, json } = selfHostedApiRequest("POST", "/messages/send-intents/reconcile", {
          message_id: id.trim(),
          outcome: normalized,
          evidence,
          ...(providerMessageId ? { provider_message_id: providerMessageId } : {}),
        });
        if (status < 200 || status >= 300) {
          return handleError(new Error(bodyError(json, `Reconciliation failed (HTTP ${status}).`)));
        }
        const payload = asRecord(json);
        const row = toRow(payload["message"]);
        const verdict = normalized === "sent"
          ? chalk.green(`✓ ${row.id} recorded as SENT (provider message id ${row.provider_message_id ?? providerMessageId})`)
          : chalk.yellow(`✓ ${row.id} recorded as NOT SENT — it never left the provider`);
        output(
          { reconciled: true, outcome: normalized, message: row },
          [verdict, chalk.dim(`  Evidence: ${evidence}`), ""].join("\n"),
        );
      } catch (error) {
        handleError(error);
      }
    });
}
