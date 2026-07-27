import { describe, expect, it } from "bun:test";
import { cliRefusalFor } from "../test-support/cli-refusals.js";
import { cliEquivalentForTool } from "./contracts.js";

describe("MCP CLI equivalents", () => {
  it("includes provider pagination flags", () => {
    expect(cliEquivalentForTool("list_providers", { limit: 2, offset: 1 }))
      .toBe("emails provider list --limit 2 --offset 1 --json");
  });

  it("includes sequence pagination flags", () => {
    expect(cliEquivalentForTool("list_sequences", { limit: 2, offset: 1 }))
      .toBe("emails sequence list --limit 2 --offset 1 --json");
  });

  it("includes optional enrollment filters and pagination flags", () => {
    expect(cliEquivalentForTool("list_enrollments", {
      sequence_id: "welcome",
      status: "active",
      limit: 2,
      offset: 1,
    })).toBe("emails sequence enrollments welcome --status active --limit 2 --offset 1 --json");

    expect(cliEquivalentForTool("list_enrollments", { limit: 2 }))
      .toBe("emails sequence enrollments --limit 2 --json");

    expect(cliEquivalentForTool("list_replies", { email_id: "email-1", limit: 2, offset: 1 }))
      .toBe("emails replies email-1 --limit 2 --offset 1 --json");
  });

  it("includes group pagination flags", () => {
    expect(cliEquivalentForTool("list_groups", { limit: 2, offset: 1 }))
      .toBe("emails group list --limit 2 --offset 1 --json");

    expect(cliEquivalentForTool("list_group_members", {
      group_name: "newsletter",
      limit: 2,
      offset: 1,
    })).toBe("emails group members newsletter --limit 2 --offset 1 --json");
  });

  it("includes template pagination flags", () => {
    expect(cliEquivalentForTool("list_templates", { limit: 2, offset: 1 }))
      .toBe("emails template list --limit 2 --offset 1 --json");

    expect(cliEquivalentForTool("get_template", { name_or_id: "welcome" }))
      .toBe("emails template show welcome --json");
  });

  it("includes scheduled list filters and pagination flags", () => {
    expect(cliEquivalentForTool("list_scheduled", { status: "pending", limit: 2, offset: 1 }))
      .toBe("emails schedule list --status pending --limit 2 --offset 1 --json");
  });

  it("includes alias pagination flags", () => {
    expect(cliEquivalentForTool("list_aliases", { domain: "example.com", limit: 2, offset: 1 }))
      .toBe("emails alias list --domain example.com --limit 2 --offset 1 --json");
  });

  it("includes send key pagination flags", () => {
    expect(cliEquivalentForTool("list_send_keys", { owner_id: "agent-1", limit: 2, offset: 1 }))
      .toBe("emails sendkey list --owner agent-1 --limit 2 --offset 1 --json");
  });

  it("includes domain and address pagination flags", () => {
    expect(cliEquivalentForTool("list_domains", { provider_id: "provider-1", limit: 2, offset: 1 }))
      .toBe("emails domain list --provider provider-1 --limit 2 --offset 1 --json");

    expect(cliEquivalentForTool("list_addresses", { provider_id: "provider-1", limit: 2, offset: 1 }))
      .toBe("emails address list --provider provider-1 --limit 2 --offset 1 --json");
  });

  it("includes explicit MX switch flags for domain provisioning", () => {
    expect(cliEquivalentForTool("provision_domain", {
      domain: "example.com",
      provider_id: "provider-1",
      add_mx: true,
      force_mx_switch: true,
    })).toBe("emails provision domain example.com --provider provider-1 --add-mx --force-mx-switch --json");
  });

  it("includes forwarding rule commands", () => {
    expect(cliEquivalentForTool("add_forwarding_rule", {
      source_address: "user@example.com",
      target_address: "archive@example.net",
      provider_id: "provider-1",
      from_address: "user@example.com",
      enabled: false,
    })).toBe("emails forwarding add user@example.com archive@example.net --provider provider-1 --from user@example.com --disabled --json");

    expect(cliEquivalentForTool("run_forwarding_rules", { provider_id: "provider-1", limit: 5, backfill: true }))
      .toBe("emails forwarding run --provider provider-1 --limit 5 --backfill --json");
  });

  it("includes usable domain and address pagination flags", () => {
    expect(cliEquivalentForTool("list_usable_domains", { provider_id: "provider-1", send: true, limit: 2, offset: 1 }))
      .toBe("emails domain usable --provider provider-1 --send --limit 2 --offset 1 --json");

    expect(cliEquivalentForTool("list_usable_from_addresses", { provider_id: "provider-1", limit: 2, offset: 1 }))
      .toBe("emails address list --provider provider-1 --limit 2 --offset 1 --json");
  });

  it("includes warming schedule pagination flags", () => {
    expect(cliEquivalentForTool("list_warming_schedules", { status: "active", limit: 2, offset: 1 }))
      .toBe("emails domain warm-list --status active --limit 2 --offset 1 --json");
  });

  it("includes sent-email sender filters", () => {
    expect(cliEquivalentForTool("list_emails", {
      status: "sent",
      from_address: "ops@example.com",
      since: "2026-01-01T00:00:00.000Z",
      limit: 2,
      offset: 1,
    })).toBe("emails log --status sent --from ops@example.com --since 2026-01-01T00:00:00.000Z --limit 2 --offset 1 --json");
    expect(cliEquivalentForTool("search_emails", {
      query: "invoice",
      since: "2026-01-01T00:00:00.000Z",
      limit: 2,
      offset: 1,
    })).toBe("emails search invoice --since 2026-01-01T00:00:00.000Z --limit 2 --offset 1 --json");
  });

  it("includes inbound link extraction commands", () => {
    expect(cliEquivalentForTool("get_inbound_email", { id: "abc123" }))
      .toBe("emails inbox read abc123 --json");
    expect(cliEquivalentForTool("extract_inbound_email_links", { id: "abc123", include_non_web: true }))
      .toBe("emails inbox links abc123 --all --json");
  });

  it("includes mailbox source and folder commands", () => {
    expect(cliEquivalentForTool("list_mailbox_sources", { search: "legacy", limit: 5 }))
      .toBe("emails inbox sources --search legacy --limit 5 --json");
    expect(cliEquivalentForTool("list_mailboxes", { source_id: "legacy" }))
      .toBe("emails inbox mailboxes --source legacy --json");
    expect(cliEquivalentForTool("search_mailbox", {
      query: "invoice",
      mailbox: "sent",
      source_id: "provider:abc",
      limit: 2,
      offset: 1,
    })).toBe("emails inbox search invoice --folder sent --source provider:abc --limit 2 --offset 1 --json");
  });

  it("includes inbound attachment commands", () => {
    expect(cliEquivalentForTool("list_attachments", {
      limit: 25,
      cursor: "opaque cursor",
      direction: "inbound",
      since: "2026-07-24T00:00:00.000Z",
    })).toBe('emails inbox attachments --limit 25 --cursor "opaque cursor" --direction inbound --since 2026-07-24T00:00:00.000Z --json');
    expect(cliEquivalentForTool("get_attachment", { email_id: "abc123", filename: "invoice.pdf" }))
      .toBe("emails inbox attachment abc123 --filename invoice.pdf --json");
    expect(cliEquivalentForTool("download_attachment", {
      email_id: "abc123",
      index: 2,
      output_dir: "/tmp/email files",
      max_bytes: 4096,
    })).toBe('emails inbox attachment abc123 --download --index 2 --output-dir "/tmp/email files" --max-bytes 4096 --json');
  });

  it("includes export filters and pagination flags", () => {
    expect(cliEquivalentForTool("export_emails", {
      format: "csv",
      provider_id: "provider-1",
      from_address: "ops@example.com",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-02-01T00:00:00.000Z",
      limit: 2,
      offset: 1,
    })).toBe("emails export emails --provider provider-1 --from ops@example.com --since 2026-01-01T00:00:00.000Z --until 2026-02-01T00:00:00.000Z --limit 2 --offset 1 --format csv");

    expect(cliEquivalentForTool("export_events", { limit: 2 }))
      .toBe("emails export events --limit 2 --format json");
  });

  // ─── cli_equivalent honesty ────────────────────────────────────────────────
  //
  // A `cli_equivalent` naming a command that cannot run is the same class of lie as
  // a mode guard standing in front of a working route: the agent is told to go do
  // something that will throw. These pin the tools whose mode guard was removed,
  // because their advertised command is now reachable for the first time.

  it("renders a runnable command for every tool whose mode guard was removed", () => {
    // `emails sequence step add` has THREE required options — the old rendering
    // omitted all of them, so the advertised command exited with
    // "required option '--step <number>' not specified".
    expect(cliEquivalentForTool("add_sequence_step", {
      sequence_id: "onboarding",
      step_number: 1,
      delay_hours: 24,
      template_name: "welcome",
    })).toBe("emails sequence step add onboarding --step 1 --delay 24 --template welcome --json");

    expect(cliEquivalentForTool("enroll_contact", { sequence_id: "onboarding", contact_email: "ada@acme.example" }))
      .toBe("emails sequence enroll onboarding ada@acme.example --json");
    expect(cliEquivalentForTool("unenroll_contact", { sequence_id: "onboarding", contact_email: "ada@acme.example" }))
      .toBe("emails sequence unenroll onboarding ada@acme.example --json");

    // The group-member tools take a group NAME, which is what the CLI takes too;
    // the old lookup only knew `group_id` and always emitted a placeholder.
    expect(cliEquivalentForTool("add_group_member", { group_name: "beta-testers", email: "ada@acme.example" }))
      .toBe("emails group add beta-testers ada@acme.example --json");
    expect(cliEquivalentForTool("remove_group_member", { group_name: "beta-testers", email: "ada@acme.example" }))
      .toBe("emails group remove-member beta-testers ada@acme.example --json");

    // `remove_alias` takes `alias_id` and `resolve_alias` takes `recipient`; neither
    // key was read, so both rendered an unsubstituted placeholder.
    expect(cliEquivalentForTool("remove_alias", { alias_id: "alias-1" }))
      .toBe("emails alias remove alias-1 --json");
    expect(cliEquivalentForTool("resolve_alias", { recipient: "hello@acme.example" }))
      .toBe("emails alias resolve hello@acme.example --json");
    expect(cliEquivalentForTool("add_alias", { alias: "hello@acme.example", target: "ops@acme.example" }))
      .toBe("emails alias add hello@acme.example ops@acme.example --json");
    expect(cliEquivalentForTool("add_catch_all", { domain: "acme.example", target: "ops@acme.example" }))
      .toBe("emails alias catch-all acme.example ops@acme.example --json");

    // `set_address_quota` takes `per_day`, and `null` means "clear", which the CLI
    // spells `none` — `emails address quota <id> null` fails "Invalid quota".
    expect(cliEquivalentForTool("set_address_quota", { address_id: "address-1", per_day: 25 }))
      .toBe("emails address quota address-1 25 --json");
    expect(cliEquivalentForTool("set_address_quota", { address_id: "address-1", per_day: null }))
      .toBe("emails address quota address-1 none --json");

    expect(cliEquivalentForTool("remove_domain", { domain_id: "domain-1" }))
      .toBe("emails domain remove domain-1 --yes --json");
    expect(cliEquivalentForTool("suggest_address", { domain: "acme.example" }))
      .toBe("emails address suggest --domain acme.example --json");
    for (const [tool, verb] of [["remove_address", "remove"], ["suspend_address", "suspend"], ["activate_address", "activate"]] as const) {
      const suffix = verb === "remove" ? " --yes --json" : " --json";
      expect(cliEquivalentForTool(tool, { address_id: "address-1" })).toBe(`emails address ${verb} address-1${suffix}`);
    }
  });

  it("never points an unblocked tool at a CLI command that refuses", () => {
    // The oracle is the CLI's own `serverOnly()` / `notImplementedAnywhere()` call
    // sites (src/test-support/cli-refusals.ts), not a registry this file also feeds.
    const unblocked: Array<[string, Record<string, unknown>]> = [
      ["add_alias", { alias: "hello@acme.example", target: "ops@acme.example" }],
      ["add_catch_all", { domain: "acme.example", target: "ops@acme.example" }],
      ["list_aliases", { domain: "acme.example" }],
      ["remove_alias", { alias_id: "alias-1" }],
      ["resolve_alias", { recipient: "hello@acme.example" }],
      ["remove_domain", { domain_id: "domain-1" }],
      ["suggest_address", { domain: "acme.example" }],
      ["remove_address", { address_id: "address-1" }],
      ["suspend_address", { address_id: "address-1" }],
      ["activate_address", { address_id: "address-1" }],
      ["set_address_quota", { address_id: "address-1", per_day: 25 }],
      ["add_group_member", { group_name: "beta-testers", email: "ada@acme.example" }],
      ["remove_group_member", { group_name: "beta-testers", email: "ada@acme.example" }],
      ["list_group_members", { group_name: "beta-testers" }],
      ["add_sequence_step", { sequence_id: "onboarding", step_number: 1, delay_hours: 24, template_name: "welcome" }],
      ["enroll_contact", { sequence_id: "onboarding", contact_email: "ada@acme.example" }],
      ["unenroll_contact", { sequence_id: "onboarding", contact_email: "ada@acme.example" }],
      ["list_enrollments", { sequence_id: "onboarding" }],
      ["list_warming_schedules", { status: "active" }],
    ];
    for (const [tool, input] of unblocked) {
      const command = cliEquivalentForTool(tool, input);
      expect(command, `${tool} advertises a command with no arguments substituted`).not.toContain("<");
      expect(cliRefusalFor(command, "self_hosted"), `${tool} advertises ${command}`).toBeNull();
    }
  });

  it("still admits that the two guarded tools name refused commands", () => {
    // `get_dns_records` and `verify_domain` keep their mode guard because their CLI
    // twins genuinely refuse. This is the negative control for the check above: if
    // the oracle stopped seeing refusals, it would go green over everything.
    expect(cliRefusalFor(cliEquivalentForTool("get_dns_records", { domain: "acme.example" }), "self_hosted"))
      .toBe("emails domain dns");
    expect(cliRefusalFor(cliEquivalentForTool("verify_domain", { domain: "acme.example" }), "self_hosted"))
      .toBe("emails domain verify");
  });
});
