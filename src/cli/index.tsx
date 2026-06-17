#!/usr/bin/env bun
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function getPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string }).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function shouldPrintVersionEarly(args: string[]): boolean {
  return args.length === 1 && (args[0] === "--version" || args[0] === "-V");
}

type OutputFn = (data: unknown, formatted: string) => void;
type RegisterFn = (program: Command, output: OutputFn) => void;

const allCommandModules = [
  "provider",
  "domain",
  "address",
  "send",
  "email-log",
  "sync",
  "serve",
  "config",
  "templates",
  "contacts",
  "groups",
  "sequences",
  "sandbox",
  "misc",
  "inbox",
  "refresh",
  "provision",
  "owner",
  "alias",
  "sendkey",
  "reply",
  "forwarding",
  "ui",
  "triage",
  "aws",
  "storage",
  "status",
  "daemon",
] as const;

type CommandModule = typeof allCommandModules[number];

const knownCommandNames = new Set([
  "provider",
  "domain",
  "domains",
  "address",
  "addresses",
  "send",
  "email",
  "log",
  "search",
  "show",
  "replies",
  "conversation",
  "test",
  "export",
  "webhook",
  "pull",
  "stats",
  "monitor",
  "analytics",
  "serve",
  "mcp",
  "config",
  "template",
  "preview",
  "contact",
  "contacts",
  "group",
  "sequence",
  "sandbox",
  "schedule",
  "scheduled",
  "scheduler",
  "batch",
  "completion",
  "doctor",
  "delivery",
  "verify-email",
  "inbox",
  "code",
  "refresh",
  "provision",
  "owner",
  "alias",
  "sendkey",
  "reply",
  "forward",
  "forwarding",
  "ui",
  "links",
  "triage",
  "agent",
  "ask",
  "aws",
  "storage",
  "status",
  "daemon",
  "logs",
]);

function routeRootPromptArgs(args: string[]): string[] {
  const command = requestedCommand(args);
  if (args.includes("--help") || args.includes("-h")) return args;

  const firstCommandIndex = args.findIndex((arg) => arg === command);
  const promptArgs = firstCommandIndex >= 0 ? args.slice(firstCommandIndex) : args;
  if (!command) return args;
  if (knownCommandNames.has(command)) {
    if (command !== "links" || !looksLikeLinksPrompt(promptArgs)) return args;
  }
  const promptText = promptArgs.join(" ").trim();
  const looksNatural = promptArgs.length > 1 || /\s|\?/.test(command);
  if (!promptText || !looksNatural) return args;

  const leading = firstCommandIndex > 0 ? args.slice(0, firstCommandIndex) : [];
  return [...leading, "agent", ...promptArgs];
}

function looksLikeLinksPrompt(args: string[]): boolean {
  const target = args.slice(1).find((arg) => !arg.startsWith("-"));
  if (!target) return false;
  return !/^[a-f0-9-]{4,}$/i.test(target);
}

function requestedCommand(args: string[]): string | null {
  for (const arg of args) {
    if (arg === "--") return null;
    if (arg === "--help" || arg === "-h") return null;
    if (arg === "--json" || arg === "-q" || arg === "--quiet" || arg === "-v" || arg === "--verbose") continue;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

function commandModulesFor(args: string[]): readonly CommandModule[] {
  switch (requestedCommand(args)) {
    case "provider": return ["provider", "sync"];
    case "domain":
    case "domains": return ["domain"];
    case "address":
    case "addresses": return ["address"];
    case "send": return ["send"];
    case "email":
    case "log":
    case "search":
    case "show":
    case "replies":
    case "conversation":
    case "test":
    case "export":
    case "webhook": return ["email-log"];
    case "pull":
    case "stats":
    case "monitor":
    case "analytics": return ["sync"];
    case "serve":
    case "mcp": return ["serve"];
    case "config": return ["config"];
    case "template":
    case "preview": return ["templates"];
    case "contact":
    case "contacts": return ["contacts"];
    case "group": return ["groups"];
    case "sequence": return ["sequences"];
    case "sandbox": return ["sandbox"];
    case "schedule":
    case "scheduled":
    case "scheduler":
    case "batch":
    case "completion":
    case "doctor":
    case "delivery":
    case "verify-email": return ["misc"];
    case "inbox":
    case "links": return ["inbox"];
    case "refresh": return ["refresh"];
    case "provision": return ["provision"];
    case "owner": return ["owner"];
    case "alias": return ["alias"];
    case "sendkey": return ["sendkey"];
    case "reply":
    case "forward": return ["reply"];
    case "forwarding": return ["forwarding"];
    case "ui": return ["ui"];
    case "triage": return ["triage"];
    case "agent":
    case "ask": return ["status"];
    case "aws": return ["aws"];
    case "storage": return ["storage"];
    case "status": return ["status"];
    case "daemon":
    case "logs": return ["daemon"];
    default: return allCommandModules;
  }
}

async function loadCommandModule(module: CommandModule): Promise<RegisterFn> {
  switch (module) {
    case "provider": return (await import("./commands/provider.js")).registerProviderCommands;
    case "domain": return (await import("./commands/domain.js")).registerDomainCommands;
    case "address": return (await import("./commands/address.js")).registerAddressCommands;
    case "send": return (await import("./commands/send.js")).registerSendCommands;
    case "email-log": return (await import("./commands/email-log.js")).registerEmailLogCommands;
    case "sync": return (await import("./commands/sync.js")).registerSyncCommands;
    case "serve": return (await import("./commands/serve.js")).registerServeCommands;
    case "config": return (await import("./commands/config.js")).registerConfigCommands;
    case "templates": return (await import("./commands/templates.js")).registerTemplateCommands;
    case "contacts": return (await import("./commands/contacts.js")).registerContactCommands;
    case "groups": return (await import("./commands/groups.js")).registerGroupCommands;
    case "sequences": return (await import("./commands/sequences.js")).registerSequenceCommands;
    case "sandbox": return (await import("./commands/sandbox.js")).registerSandboxCommands;
    case "misc": return (await import("./commands/misc.js")).registerMiscCommands;
    case "inbox": return (await import("./commands/inbox.js")).registerInboxCommands;
    case "refresh": return (await import("./commands/refresh.js")).registerRefreshCommand;
    case "provision": return (await import("./commands/provision.js")).registerProvisionCommands;
    case "owner": return (await import("./commands/owner.js")).registerOwnerCommands;
    case "alias": return (await import("./commands/alias.js")).registerAliasCommands;
    case "sendkey": return (await import("./commands/sendkey.js")).registerSendKeyCommands;
    case "reply": return (await import("./commands/reply.js")).registerReplyCommand;
    case "forwarding": return (await import("./commands/forwarding.js")).registerForwardingCommands;
    case "ui": return (await import("./commands/ui.js")).registerUiCommand;
    case "triage": return (await import("./commands/triage.js")).registerTriageCommands;
    case "aws": return (await import("./commands/aws.js")).registerAwsCommands;
    case "storage": return (await import("./commands/storage.js")).registerStorageCommands;
    case "status": return (await import("./commands/status.js")).registerStatusCommands;
    case "daemon": return (await import("./commands/daemon.js")).registerDaemonCommands;
  }
}

async function registerCommandsForArgs(program: Command, output: OutputFn, args: string[]): Promise<void> {
  const registrars = await Promise.all(commandModulesFor(args).map(loadCommandModule));
  for (const register of registrars) {
    register(program, output);
  }
}

async function registerOptionalEventsCommands(program: Command): Promise<void> {
  try {
    const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<{ registerEventsCommands?: (program: Command, opts: { source: string }) => void }>;
    const events = await importer("@hasna/events/commander");
    events.registerEventsCommands?.(program, { source: "mailery" });
  } catch {
    // The events integration is optional; keep the Mailery CLI usable when the
    // companion package is not installed in a global/npm environment.
  }
}

async function main(): Promise<void> {
  const version = getPackageVersion();
  const rawArgs = process.argv.slice(2);
  if (shouldPrintVersionEarly(rawArgs)) {
    console.log(version);
    return;
  }
  const cliArgs = routeRootPromptArgs(rawArgs);

  const program = new Command();
  const [{ setLogLevel }, { configureCliRuntime, emitJson }] = await Promise.all([
    import("../lib/logger.js"),
    import("./utils.js"),
  ]);

  program
    .name("mailery")
    .description("Mailery email management CLI - send, receive, sync, and manage email via Resend, AWS SES, and Gmail")
    .version(version)
    .option("--json", "Output JSON instead of formatted text")
    .option("-q, --quiet", "Suppress info output")
    .option("-v, --verbose", "Show debug info")
    .hook("preAction", () => {
      const opts = program.opts();
      configureCliRuntime({ json: !!opts.json });
      setLogLevel(!!opts.quiet, !!opts.verbose);
    });

  function output(data: unknown, formatted: string): void {
    const opts = program.opts();
    if (opts.json) {
      emitJson(data);
    } else {
      console.log(formatted);
    }
  }

  await registerCommandsForArgs(program, output, cliArgs);
  await registerOptionalEventsCommands(program);

  await program.parseAsync([process.argv[0] ?? "bun", process.argv[1] ?? "mailery", ...cliArgs]);
}

await main();
