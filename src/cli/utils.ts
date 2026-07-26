import chalk from "../lib/chalk-lite.js";
import { writeSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolveResourceId, listResourceIdMatches } from "../db/self-hosted-store.js";
import { getDatabase, listPartialIdMatches, resolvePartialIdOrThrow } from "../db/database.js";
import { getEmailsMode } from "../lib/mode.js";
import { redactSecrets } from "../lib/redaction.js";

const ID_ERROR_SUGGESTION_LIMIT = 5;
const CLI_JSON_WRITE_CHUNK_BYTES = 16 * 1024;
let jsonOutput = false;
let verboseOutput = false;
let jsonConsolePatched = false;
let structuredJsonEmitted = false;
const jsonStdoutLines: string[] = [];
const jsonStderrLines: string[] = [];
let pendingJsonOutput = Promise.resolve();
let jsonOutputFailure: Error | null = null;

export const DEFAULT_CLI_PAGE_LIMIT = 50;
export const MAX_CLI_PAGE_LIMIT = 1000;
export const DEFAULT_COMPACT_CLI_PAGE_LIMIT = 20;

function jsonDocument(data: unknown): string {
  return `${JSON.stringify(redactSecrets(data), null, 2)}\n`;
}

function normalizeJsonOutputError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
    return new Error("CLI output pipe closed before the JSON document was fully written.");
  }
  return error instanceof Error ? error : new Error(String(error));
}

function writeJsonChunk(stream: NodeJS.WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      stream.off("error", onError);
      if (error) reject(normalizeJsonOutputError(error));
      else resolve();
    };
    const onError = (error: Error) => finish(error);
    stream.once("error", onError);
    stream.write(chunk, (error) => finish(error));
  });
}

async function writeJsonDocument(stream: NodeJS.WriteStream, data: unknown): Promise<void> {
  const document = Buffer.from(jsonDocument(data));
  for (let offset = 0; offset < document.length; offset += CLI_JSON_WRITE_CHUNK_BYTES) {
    await writeJsonChunk(stream, document.subarray(offset, offset + CLI_JSON_WRITE_CHUNK_BYTES));
  }
}

function queueJsonDocument(stream: NodeJS.WriteStream, data: unknown): void {
  pendingJsonOutput = pendingJsonOutput
    .then(() => {
      if (jsonOutputFailure) return;
      return writeJsonDocument(stream, data);
    })
    .catch((error) => {
      jsonOutputFailure ??= normalizeJsonOutputError(error);
    });
}

function writeJsonDocumentSync(fd: number, data: unknown): void {
  const buffer = Buffer.from(jsonDocument(data));
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error("CLI JSON output could not be written.");
    offset += written;
  }
}

export function configureCliRuntime(opts: { json?: boolean; verbose?: boolean }): void {
  jsonOutput = !!opts.json;
  verboseOutput = !!opts.verbose;
  if (jsonOutput) process.env["EMAILS_JSON_OUTPUT"] = "1";
  if (jsonOutput && !jsonConsolePatched) {
    jsonConsolePatched = true;
    console.log = (...args: unknown[]) => {
      jsonStdoutLines.push(args.map(formatJsonConsoleArg).join(" "));
    };
    console.error = (...args: unknown[]) => {
      jsonStderrLines.push(args.map(formatJsonConsoleArg).join(" "));
    };
    process.once("exit", (code) => {
      if (!jsonOutput || structuredJsonEmitted) return;
      if (jsonStdoutLines.length === 0 && jsonStderrLines.length === 0) return;
      const stderr = jsonStderrLines.join("\n").trim();
      const payload = code && code !== 0
        ? {
            error: {
              message: stderr || `Command failed with exit code ${code}`,
              code: errorCode(stderr || "Command failed"),
              fix_commands: fixCommands(stderr || "Command failed"),
              retryable: false,
            },
            output: jsonStdoutLines,
          }
        : {
            output: jsonStdoutLines,
            errors: jsonStderrLines,
          };
      try {
        writeJsonDocumentSync(process.stdout.fd, payload);
      } catch {
        // The process is already exiting; a closed stdout pipe has no consumer.
      }
    });
  }
}

export function isCliVerboseOutput(): boolean {
  return verboseOutput;
}

export function hasCliOption(name: string): boolean {
  const flag = `--${name}`;
  return process.argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function formatJsonConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(redactSecrets(arg));
  } catch {
    return String(arg);
  }
}

export function emitJson(data: unknown): void {
  structuredJsonEmitted = true;
  queueJsonDocument(process.stdout, data);
}

export function finalizeCliOutput(exitCode = process.exitCode ?? 0): void {
  if (!jsonOutput || structuredJsonEmitted) return;
  if (jsonStdoutLines.length === 0 && jsonStderrLines.length === 0) return;
  const stderr = jsonStderrLines.join("\n").trim();
  emitJson(exitCode !== 0
    ? {
        error: {
          message: stderr || `Command failed with exit code ${exitCode}`,
          code: errorCode(stderr || "Command failed"),
          fix_commands: fixCommands(stderr || "Command failed"),
          retryable: false,
        },
        output: jsonStdoutLines,
      }
    : {
        output: jsonStdoutLines,
        errors: jsonStderrLines,
      });
}

export async function drainCliOutput(): Promise<void> {
  await pendingJsonOutput;
  if (jsonOutputFailure) throw jsonOutputFailure;
}

function errorCode(message: string): string {
  if (/output pipe closed|EPIPE|broken pipe/i.test(message)) return "output_closed";
  if (/unknown command/i.test(message)) return "unknown_command";
  if (/could not resolve id|not found/i.test(message)) return "not_found";
  if (/requires|missing|required/i.test(message)) return "missing_required_input";
  if (/invalid|must be/i.test(message)) return "invalid_input";
  if (/credential|oauth|auth/i.test(message)) return "auth_error";
  if (/non-interactive|--yes|cancelled/i.test(message)) return "confirmation_required";
  return "error";
}

function fixCommands(message: string): string[] {
  const lower = message.toLowerCase();
  if (lower.includes("unknown command")) return ["emails --help"];
  if (lower.includes("provider")) return ["emails provider list --json", "emails provider add --help"];
  if (lower.includes("domain")) return ["emails domain list --json", "emails domain add --help"];
  if (lower.includes("address")) return ["emails address list --json", "emails address provision --help"];
  if (lower.includes("template")) return ["emails template list --json", "emails template add --help"];
  if (lower.includes("sequence")) return ["emails sequence list --json", "emails sequence --help"];
  if (lower.includes("inbound") || lower.includes("inbox")) return ["emails inbox sync-status --json", "emails doctor delivery <address> --json"];
  if (lower.includes("--yes") || lower.includes("destructive")) return ["Re-run the same command with --yes after confirming the target ID"];
  return ["emails status --json", "emails doctor --json"];
}

export function handleError(e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  if (jsonOutput) {
    structuredJsonEmitted = true;
    try {
      writeJsonDocumentSync(process.stderr.fd, {
        error: {
          message,
          code: errorCode(message),
          fix_commands: fixCommands(message),
          retryable: false,
        },
      });
    } catch {
      // Preserve the deterministic nonzero exit even when stderr is also closed.
    }
  } else {
    console.error(chalk.red(message));
  }
  process.exit(1);
}

// Map the legacy SQL table names still passed by CLI commands to their /v1
// resource path. Unknown names pass through unchanged.
const TABLE_TO_RESOURCE: Record<string, string> = {
  providers: "providers",
  domains: "domains",
  addresses: "addresses",
  emails: "emails",
  templates: "templates",
  contacts: "contacts",
  groups: "groups",
  sequences: "sequences",
  owners: "owners",
  aliases: "aliases",
  send_keys: "send-keys",
  scheduled_emails: "scheduled",
  forwarding_rules: "forwarding",
  inbound_emails: "messages",
  sandbox_emails: "sandbox_emails",
};

function resourceForTable(table: string): string {
  return TABLE_TO_RESOURCE[table] ?? table;
}

export function resolveId(table: string, partialId: string): string {
  if (getEmailsMode() === "local") {
    try {
      return resolvePartialIdOrThrow(getDatabase(), table, partialId);
    } catch (error) {
      handleError(error);
    }
  }
  const resource = resourceForTable(table);
  const id = resolveResourceId(resource, partialId);
  if (!id) {
    const suggestions = getIdSuggestions(resource, partialId);
    const suggestionText = suggestions.length > 0
      ? `\nSimilar IDs in ${table}: ${suggestions.join(", ")}`
      : "";
    handleError(new Error(`Could not resolve ID '${partialId}' in table '${table}'.${suggestionText}`));
  }
  return id;
}

function getIdSuggestions(resource: string, partialId: string): string[] {
  try {
    if (getEmailsMode() === "local") {
      const table = Object.entries(TABLE_TO_RESOURCE).find(([, mapped]) => mapped === resource)?.[0] ?? resource;
      return listPartialIdMatches(getDatabase(), table, partialId, ID_ERROR_SUGGESTION_LIMIT);
    }
    return listResourceIdMatches(resource, partialId, ID_ERROR_SUGGESTION_LIMIT);
  } catch {
    return [];
  }
}

export async function confirmDestructiveAction(message: string, yes?: boolean): Promise<void> {
  if (yes) return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Destructive operation blocked in non-interactive mode. Re-run with --yes to confirm.");
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${message} Type 'yes' to continue: `)).trim().toLowerCase();
    if (answer !== "yes") {
      throw new Error("Operation cancelled.");
    }
  } finally {
    rl.close();
  }
}

export function parseDuration(str: string): number {
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

export function parseCliPositiveIntOption(
  value: number | string | undefined,
  fallback: number,
  max = Number.POSITIVE_INFINITY,
): number {
  const cap = Number.isFinite(max) ? Math.max(1, Math.trunc(max)) : Number.POSITIVE_INFINITY;
  const safeFallback = Number.isFinite(fallback) && fallback >= 1
    ? Math.min(cap, Math.trunc(fallback))
    : 1;
  const parsed = typeof value === "number"
    ? value
    : Number.parseInt(value ?? String(safeFallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return safeFallback;
  return Math.min(cap, Math.trunc(parsed));
}

export function parseCliNonNegativeIntOption(value: number | string | undefined, fallback = 0): number {
  const safeFallback = Number.isFinite(fallback) && fallback >= 0 ? Math.trunc(fallback) : 0;
  const parsed = typeof value === "number"
    ? value
    : Number.parseInt(value ?? String(safeFallback), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return safeFallback;
  return Math.trunc(parsed);
}

export function parseCliPage(
  opts: { limit?: number | string; offset?: number | string },
  fallbackLimit = DEFAULT_CLI_PAGE_LIMIT,
  maxLimit = MAX_CLI_PAGE_LIMIT,
): { limit: number; offset: number } {
  return {
    limit: parseCliPositiveIntOption(opts.limit, fallbackLimit, maxLimit),
    offset: parseCliNonNegativeIntOption(opts.offset, 0),
  };
}

export function parseCliListPage(
  opts: { limit?: number | string; offset?: number | string; verbose?: boolean },
  fallbackLimit = DEFAULT_CLI_PAGE_LIMIT,
  maxLimit = MAX_CLI_PAGE_LIMIT,
  compactLimit = DEFAULT_COMPACT_CLI_PAGE_LIMIT,
): { limit: number; offset: number; compact: boolean } {
  const rawLimit = opts.limit === undefined ? undefined : String(opts.limit);
  const looksLikeDefaultLimit = rawLimit === undefined || rawLimit === String(fallbackLimit);
  const compact = !jsonOutput && !verboseOutput && !opts.verbose && !hasCliOption("limit") && looksLikeDefaultLimit;
  const page = parseCliPage(
    compact ? { ...opts, limit: String(Math.min(compactLimit, fallbackLimit)) } : opts,
    fallbackLimit,
    maxLimit,
  );
  return { ...page, compact };
}

export function formatListHint(opts: {
  shown: number;
  limit: number;
  offset?: number;
  noun: string;
  pluralNoun?: string;
  detailCommand?: string;
  verbose?: boolean;
}): string {
  const offset = opts.offset ?? 0;
  const pluralNoun = opts.pluralNoun
    ?? (opts.noun === "address" ? "addresses" : opts.noun === "alias" ? "aliases" : `${opts.noun}s`);
  const noun = opts.shown === 1 ? opts.noun : pluralNoun;
  const parts: string[] = [`Showing ${opts.shown} ${noun}${offset > 0 ? ` from offset ${offset}` : ""}.`];
  const hints: string[] = [];
  if (!opts.verbose) hints.push("use --verbose for expanded rows");
  if (opts.detailCommand) hints.push(opts.detailCommand);
  if (opts.shown >= opts.limit) hints.push(`page with --offset ${offset + opts.shown} or set --limit`);
  if (hints.length > 0) parts.push(hints.join("; "));
  return chalk.dim(parts.join(" "));
}

export function padRight(str: string, len: number): string {
  const visibleLen = str.replace(/\[[0-9;]*m/g, "").length;
  return str + " ".repeat(Math.max(0, len - visibleLen));
}
