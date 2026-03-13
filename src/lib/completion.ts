export function generateBashCompletion(): string {
  return `# bash completion for emails
_emails_completion() {
  local cur prev commands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="provider domain address send pull stats monitor serve mcp config log test search export template contacts group batch scheduled scheduler webhook analytics doctor completion"

  case "\${prev}" in
    emails)
      COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
      ;;
    provider)
      COMPREPLY=( $(compgen -W "add list remove update status" -- "\${cur}") )
      ;;
    domain)
      COMPREPLY=( $(compgen -W "add list dns verify remove status check" -- "\${cur}") )
      ;;
    address)
      COMPREPLY=( $(compgen -W "add list verify remove" -- "\${cur}") )
      ;;
    template)
      COMPREPLY=( $(compgen -W "add list show remove" -- "\${cur}") )
      ;;
    contacts)
      COMPREPLY=( $(compgen -W "list suppress unsuppress" -- "\${cur}") )
      ;;
    group)
      COMPREPLY=( $(compgen -W "create list show add remove-member delete" -- "\${cur}") )
      ;;
    scheduled)
      COMPREPLY=( $(compgen -W "list cancel" -- "\${cur}") )
      ;;
    config)
      COMPREPLY=( $(compgen -W "set get list" -- "\${cur}") )
      ;;
    export)
      COMPREPLY=( $(compgen -W "emails events" -- "\${cur}") )
      ;;
    batch)
      COMPREPLY=( $(compgen -W "send" -- "\${cur}") )
      ;;
    completion)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") )
      ;;
  esac
}
complete -F _emails_completion emails`;
}

export function generateZshCompletion(): string {
  return `#compdef emails

_emails() {
  local -a commands
  commands=(
    'provider:Manage email providers'
    'domain:Manage domains'
    'address:Manage sender addresses'
    'send:Send an email'
    'pull:Sync events from providers'
    'stats:Show email statistics'
    'monitor:Monitor provider health'
    'serve:Start HTTP server'
    'mcp:Start MCP server'
    'config:Manage configuration'
    'log:Show email log'
    'test:Send a test email'
    'search:Search emails'
    'export:Export data'
    'template:Manage templates'
    'contacts:Manage contacts'
    'group:Manage contact groups'
    'batch:Batch operations'
    'scheduled:Manage scheduled emails'
    'scheduler:Run the scheduler'
    'webhook:Manage webhooks'
    'analytics:Show email analytics'
    'doctor:Run system diagnostics'
    'completion:Generate shell completions'
  )

  _arguments '1: :->command' '*:: :->args'

  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        provider)
          _values 'subcommand' 'add' 'list' 'remove' 'update' 'status'
          ;;
        domain)
          _values 'subcommand' 'add' 'list' 'dns' 'verify' 'remove' 'status' 'check'
          ;;
        address)
          _values 'subcommand' 'add' 'list' 'verify' 'remove'
          ;;
        template)
          _values 'subcommand' 'add' 'list' 'show' 'remove'
          ;;
        contacts)
          _values 'subcommand' 'list' 'suppress' 'unsuppress'
          ;;
        group)
          _values 'subcommand' 'create' 'list' 'show' 'add' 'remove-member' 'delete'
          ;;
        scheduled)
          _values 'subcommand' 'list' 'cancel'
          ;;
        config)
          _values 'subcommand' 'set' 'get' 'list'
          ;;
        export)
          _values 'subcommand' 'emails' 'events'
          ;;
        batch)
          _values 'subcommand' 'send'
          ;;
        completion)
          _values 'subcommand' 'bash' 'zsh' 'fish'
          ;;
      esac
      ;;
  esac
}

_emails "$@"`;
}

export function generateFishCompletion(): string {
  return `# fish completion for emails
complete -c emails -f

# Top-level commands
complete -c emails -n '__fish_use_subcommand' -a 'provider' -d 'Manage email providers'
complete -c emails -n '__fish_use_subcommand' -a 'domain' -d 'Manage domains'
complete -c emails -n '__fish_use_subcommand' -a 'address' -d 'Manage sender addresses'
complete -c emails -n '__fish_use_subcommand' -a 'send' -d 'Send an email'
complete -c emails -n '__fish_use_subcommand' -a 'pull' -d 'Sync events from providers'
complete -c emails -n '__fish_use_subcommand' -a 'stats' -d 'Show email statistics'
complete -c emails -n '__fish_use_subcommand' -a 'monitor' -d 'Monitor provider health'
complete -c emails -n '__fish_use_subcommand' -a 'serve' -d 'Start HTTP server'
complete -c emails -n '__fish_use_subcommand' -a 'mcp' -d 'Start MCP server'
complete -c emails -n '__fish_use_subcommand' -a 'config' -d 'Manage configuration'
complete -c emails -n '__fish_use_subcommand' -a 'log' -d 'Show email log'
complete -c emails -n '__fish_use_subcommand' -a 'test' -d 'Send a test email'
complete -c emails -n '__fish_use_subcommand' -a 'search' -d 'Search emails'
complete -c emails -n '__fish_use_subcommand' -a 'export' -d 'Export data'
complete -c emails -n '__fish_use_subcommand' -a 'template' -d 'Manage templates'
complete -c emails -n '__fish_use_subcommand' -a 'contacts' -d 'Manage contacts'
complete -c emails -n '__fish_use_subcommand' -a 'group' -d 'Manage contact groups'
complete -c emails -n '__fish_use_subcommand' -a 'batch' -d 'Batch operations'
complete -c emails -n '__fish_use_subcommand' -a 'scheduled' -d 'Manage scheduled emails'
complete -c emails -n '__fish_use_subcommand' -a 'scheduler' -d 'Run the scheduler'
complete -c emails -n '__fish_use_subcommand' -a 'webhook' -d 'Manage webhooks'
complete -c emails -n '__fish_use_subcommand' -a 'analytics' -d 'Show email analytics'
complete -c emails -n '__fish_use_subcommand' -a 'doctor' -d 'Run system diagnostics'
complete -c emails -n '__fish_use_subcommand' -a 'completion' -d 'Generate shell completions'

# Provider subcommands
complete -c emails -n '__fish_seen_subcommand_from provider' -a 'add list remove update status'

# Domain subcommands
complete -c emails -n '__fish_seen_subcommand_from domain' -a 'add list dns verify remove status check'

# Address subcommands
complete -c emails -n '__fish_seen_subcommand_from address' -a 'add list verify remove'

# Template subcommands
complete -c emails -n '__fish_seen_subcommand_from template' -a 'add list show remove'

# Contacts subcommands
complete -c emails -n '__fish_seen_subcommand_from contacts' -a 'list suppress unsuppress'

# Group subcommands
complete -c emails -n '__fish_seen_subcommand_from group' -a 'create list show add remove-member delete'

# Scheduled subcommands
complete -c emails -n '__fish_seen_subcommand_from scheduled' -a 'list cancel'

# Config subcommands
complete -c emails -n '__fish_seen_subcommand_from config' -a 'set get list'

# Export subcommands
complete -c emails -n '__fish_seen_subcommand_from export' -a 'emails events'

# Batch subcommands
complete -c emails -n '__fish_seen_subcommand_from batch' -a 'send'

# Completion subcommands
complete -c emails -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'`;
}
