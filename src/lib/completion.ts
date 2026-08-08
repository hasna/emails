import { knownCommandNames } from "../cli/router.js";

// Shell completion scripts.
//
// TOP-LEVEL COMMANDS ARE DERIVED, NOT HAND-MAINTAINED. The previous version
// carried its own hand-written command list, which had rotted both ways: it
// still suggested `config` — a command the router refuses as unknown — and it
// omitted whole real command groups (inbox, owner, alias, sendkey, auth, db,
// keys, whoami, ...). `knownCommandNames` in src/cli/router.ts is the set the
// CLI actually dispatches, so deriving from it keeps completion truthful as
// commands come and go (task 78653c1c, item 1).
//
// Subcommand suggestions below remain curated: they are a convenience layer,
// and an INCOMPLETE suggestion list is acceptable where a WRONG one is not —
// every name listed is verified against the live help tree.

const TOP_LEVEL_COMMANDS = [...knownCommandNames].sort();

/** Short descriptions where useful; commands without one complete by name alone. */
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  provider: "Manage email providers",
  domain: "Manage sending domains",
  domains: "Manage domain lifecycle",
  address: "Manage sender addresses",
  addresses: "List sender addresses",
  forwarding: "Manage app-level forwarding rules",
  send: "Send an email",
  "send-controlled": "Private descriptor send with terminal receipt",
  email: "Sent email log, search, and history",
  inbox: "Sync and browse inbound emails",
  pull: "Sync events from providers",
  stats: "Show email statistics",
  monitor: "Live monitor with auto-refresh",
  serve: "Start the self-hosted HTTP service",
  mcp: "Install/configure the MCP server",
  log: "Show email send log",
  test: "Send a test email",
  search: "Search sent email",
  export: "Export emails or events",
  template: "Manage templates",
  preview: "Preview a template",
  contact: "Manage email contacts",
  contacts: "Manage email contacts",
  group: "Manage recipient groups",
  sequence: "Manage drip sequences",
  batch: "Batch send from CSV",
  schedule: "Manage and run the scheduler",
  scheduled: "Manage scheduled emails",
  scheduler: "Start the scheduler",
  webhook: "Webhook receiver for email events",
  analytics: "Show email analytics",
  doctor: "Run system diagnostics",
  completion: "Generate shell completions",
  owner: "Manage address owners",
  alias: "Manage aliases and catch-all routing",
  sendkey: "Scoped send keys",
  "send-intent": "Inspect uncertain outbound sends",
  reply: "Reply to an email in-thread",
  forward: "Forward an email",
  status: "Show email system health",
  aws: "AWS infrastructure setup",
  daemon: "Inspect daemon and worker health",
  logs: "Inspect local emails logs",
  db: "Self-hosted Postgres schema",
  "self-hosted": "Operate a self-hosted deployment",
  auth: "Accounts, sessions, and sign-in",
  keys: "Tenant-scoped API keys",
  whoami: "Show the signed-in user",
  ui: "Open the Emails UI",
  agent: "Agent-oriented context helpers",
  code: "Find the latest verification code",
  links: "Extract links from an inbound email",
  conversation: "Show a full conversation thread",
  replies: "Show replies to a sent email",
  show: "Show full email details",
  "verify-email": "Verify an email address",
  provision: "Automated provisioning (not implemented)",
};

/** Curated subcommand suggestions — every name exists on the current CLI. */
const SUBCOMMANDS: Record<string, string> = {
  provider: "add list remove update status check sync",
  domain: "add connect adopt list dns verify status usable move-provider remove check available buy",
  address: "add list verify remove activate suspend quota owner set-owner",
  forwarding: "add list enable disable remove run explain",
  template: "add list show remove",
  contact: "list suppress unsuppress",
  contacts: "list suppress unsuppress",
  group: "create list show members add remove-member delete",
  sequence: "create list show pause archive enroll unenroll enroll-bulk enrollments step",
  scheduled: "list cancel",
  schedule: "list cancel run",
  alias: "add catch-all global list remove resolve",
  sendkey: "create list revoke check",
  "send-controlled": "apply readback",
  owner: "register list addresses",
  inbox: "list unread-count search read open mailboxes sources status sync-status mark-read archive star label attachments delete clear sync-s3 code links wait",
  email: "list search show replies thread send",
  export: "emails events",
  completion: "bash zsh fish",
};

export function generateBashCompletion(): string {
  const cases = Object.entries(SUBCOMMANDS)
    .map(([command, subcommands]) => `    ${command})
      COMPREPLY=( $(compgen -W "${subcommands}" -- "\${cur}") )
      ;;`)
    .join("\n");
  return `# bash completion for emails
_emails_completion() {
  local cur prev commands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="${TOP_LEVEL_COMMANDS.join(" ")}"

  case "\${prev}" in
    emails)
      COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
      ;;
${cases}
  esac
}
complete -F _emails_completion emails`;
}

export function generateZshCompletion(): string {
  const commandEntries = TOP_LEVEL_COMMANDS
    .map((command) => {
      const description = COMMAND_DESCRIPTIONS[command];
      return description ? `    '${command}:${description}'` : `    '${command}'`;
    })
    .join("\n");
  const cases = Object.entries(SUBCOMMANDS)
    .map(([command, subcommands]) => `        ${command})
          _values 'subcommand' ${subcommands.split(" ").map((value) => `'${value}'`).join(" ")}
          ;;`)
    .join("\n");
  return `#compdef emails

_emails() {
  local -a commands
  commands=(
${commandEntries}
  )

  _arguments '1: :->command' '*:: :->args'

  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
${cases}
      esac
      ;;
  esac
}

_emails "$@"`;
}

export function generateFishCompletion(): string {
  const topLevel = TOP_LEVEL_COMMANDS
    .map((command) => {
      const description = COMMAND_DESCRIPTIONS[command];
      const suffix = description ? ` -d '${description}'` : "";
      return `complete -c emails -n '__fish_use_subcommand' -a '${command}'${suffix}`;
    })
    .join("\n");
  const subcommands = Object.entries(SUBCOMMANDS)
    .map(([command, subs]) => `complete -c emails -n '__fish_seen_subcommand_from ${command}' -a '${subs}'`)
    .join("\n");
  return `# fish completion for emails
complete -c emails -f

# Top-level commands (derived from the router's dispatch set)
${topLevel}

# Subcommands
${subcommands}`;
}
