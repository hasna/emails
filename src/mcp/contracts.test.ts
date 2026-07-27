import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { REFUSAL_HELPERS, cliRefusalFor, refusalHelpersObserved, scanCliRefusals } from "../test-support/cli-refusals.js";
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
      ["get_group_member", { group_name: "beta-testers", email: "ada@acme.example" }],
      ["list_replies", { email_id: "msg-sent-1" }],
      ["list_warming_schedules", { status: "active" }],
    ];
    for (const [tool, input] of unblocked) {
      const command = cliEquivalentForTool(tool, input);
      // A missing map entry falls through to `emails --help # MCP tool: <name>`, which
      // is not a refusal and has no `<` placeholder — so it would sail through both
      // checks below while telling the agent nothing. `get_group_member` was exactly
      // that: newly reachable with no entry at all.
      expect(command, `${tool} has no cliEquivalentForTool entry`).not.toContain("emails --help");
      // Only the leading command matters for runnability; a trailing `# note: ...` is a
      // shell comment and is how this map flags a documented inexactness.
      const runnable = (command.split(" # ")[0] ?? command).trim();
      expect(runnable, `${tool} advertises a command with no arguments substituted`).not.toContain("<");
      expect(cliRefusalFor(runnable, "self_hosted"), `${tool} advertises ${runnable}`).toBeNull();
    }
  });

  it("flags the two group-member inexactnesses instead of advertising a silent divergence", () => {
    // `emails group add` has NO --vars option, so for a call carrying vars the
    // advertised command RUNS and produces a DIFFERENT row (a member with no template
    // vars). A silently divergent "equivalent" is worse than one that admits the gap.
    expect(cliEquivalentForTool("add_group_member", { group_name: "beta-testers", email: "ada@acme.example", vars: { plan: "pro" } }))
      .toBe("emails group add beta-testers ada@acme.example --json # note: per-member vars have no CLI equivalent; this command adds the member WITHOUT them");
    // No vars supplied: exact, so no note.
    expect(cliEquivalentForTool("add_group_member", { group_name: "beta-testers", email: "ada@acme.example" }))
      .toBe("emails group add beta-testers ada@acme.example --json");
    // An empty vars object is not a divergence either.
    expect(cliEquivalentForTool("add_group_member", { group_name: "beta-testers", email: "ada@acme.example", vars: {} }))
      .toBe("emails group add beta-testers ada@acme.example --json");

    // No CLI command returns ONE member with its vars, so the nearest runnable
    // command is named and the difference is stated.
    expect(cliEquivalentForTool("get_group_member", { group_name: "beta-testers", email: "ada@acme.example" }))
      .toBe("emails group members beta-testers --json # note: lists the group's members WITHOUT per-member vars; no CLI command returns a single member with them");
  });

  it("does not send an operator to debug DOMAINS for a malformed alias argument", async () => {
    // `fixCommands()` keyword-matches over the raw message, and `createAlias` throws
    // "Invalid email address (expected local@domain): ..." — whose literal "domain"
    // routed the operator to `emails domain list`. Only reachable in self_hosted mode
    // since add_alias/add_catch_all stopped refusing, so it is this PR's to own.
    // Must go through buildServer(), not runDomainTool(): installMcpToolContracts is
    // what wraps a raw throw into the structured {error:{code,fix_commands}} payload,
    // and runDomainTool registers on a bare fake server that skips it. Both alias arms
    // raise this identical message (aliases.local.ts / aliases.remote.ts), so local
    // mode exercises the same classification path.
    const { buildServer } = await import("./server.js");
    const server = buildServer() as unknown as {
      _registeredTools: Record<string, { handler: (i: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>;
    };
    const result = await server._registeredTools["add_alias"]!.handler({ alias: "not-an-address", target: "ops@acme.example" });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      error: { message: string; code: string; fix_command: string; fix_commands: string[] };
    };
    expect(payload.error.message).toContain("Invalid email address");
    expect(payload.error.code).toBe("invalid_input");
    // The fix is to re-issue the alias command with a real address, not to inspect domains.
    expect(payload.error.fix_command).toBe("emails alias add not-an-address ops@acme.example --json");
    expect(payload.error.fix_commands).not.toContain("emails domain list --json");
    expect(payload.error.fix_commands).not.toContain("emails domain add --help");
  });

  it("advertises the reply CLI twin that always worked", () => {
    // `list_replies` refused unconditionally while `emails replies <id>` ran fine.
    expect(cliEquivalentForTool("list_replies", { email_id: "msg-1", limit: 5, offset: 1 }))
      .toBe("emails replies msg-1 --limit 5 --offset 1 --json");
    expect(cliRefusalFor("emails replies msg-1 --json", "self_hosted")).toBeNull();
  });

  it("still admits that a guarded tool names a refused command", () => {
    // NEGATIVE CONTROL for the check above: if the oracle stopped seeing refusals it
    // would go green over everything, so at least one guarded tool must still be
    // observed naming a command that refuses. `verify_domain` is it — its CLI twin
    // `emails domain verify` is `notImplementedAnywhere`, because wiring a WRITE to
    // `getAdapter().verifyDomain` behind whatever ambient AWS credentials the calling
    // machine happens to carry is a decision nobody has made.
    expect(cliRefusalFor(cliEquivalentForTool("verify_domain", { domain: "acme.example" }), "self_hosted"))
      .toBe("emails domain verify");
  });

  it("sees refusals through EVERY helper shape, not just the one this file happens to name", () => {
    // The control above exercises `notImplementedAnywhere` only, and that was not
    // enough. Deleting `serverOnly` from the oracle's regex left the whole suite
    // green — `src/mcp/contracts.test.ts` 25/0, `src/cli/unshipped-surface.test.ts`
    // 26/0, both `agent-context` suites, `status-commands-coverage.test.ts` 7/0 —
    // because every downstream assertion is of the form "this command must NOT
    // refuse", and an oracle that sees fewer refusals only ever RELAXES those.
    //
    // Before `emails domain dns` was wired up, the old control happened to cover
    // the `serverOnly` arm: `src/cli/commands/domain.ts` used that helper. It now
    // uses `notImplementedAnywhere` exclusively, and all 17 surviving
    // `serverOnly(...)` call sites sit in `*.remote.ts` where nothing asserted
    // them. So this is counted per helper rather than per command: no single
    // command being wired up can silently retire a whole shape again.
    const observed = refusalHelpersObserved();
    expect(Object.keys(observed).sort()).toEqual([...REFUSAL_HELPERS].sort());
    for (const helper of REFUSAL_HELPERS) {
      expect(observed[helper], `the refusal oracle no longer sees any ${helper}(...) call site`)
        .toBeGreaterThan(0);
    }
    // And the `serverOnly` arm is reachable through the public entry point too, so
    // a scan that populated the count but broke `cliRefusalFor` still fails here.
    const serverOnlyCommand = scanCliRefusals().find((r) => r.helper === "serverOnly")?.command;
    expect(serverOnlyCommand, "no serverOnly refusal to use as a control").toBeTruthy();
    expect(cliRefusalFor(serverOnlyCommand!, "self_hosted")).toBe(serverOnlyCommand);
  });

  it("keeps the get_dns_records guard while its CLI twin runs, and advertises the twin", () => {
    // This assertion is INVERTED from what it was, on purpose. `get_dns_records`
    // keeps its self_hosted guard for the credential reason documented on
    // `assertMcpLocalStateAllowed` — an MCP client's ambient AWS/Cloudflare
    // environment is not the operator's shell. That reason never depended on the CLI
    // twin also refusing, and the twin no longer does: `emails domain dns` is wired
    // to `src/lib/dns.ts`, whose no-provider path is credential-free.
    //
    // So the tool is guarded AND the command it advertises runs. That is the useful
    // shape: an agent refused the tool is handed something it can actually execute.
    // A stale `.toBe("emails domain dns")` here would be a demand that the CLI go
    // back to refusing.
    const twin = cliEquivalentForTool("get_dns_records", { domain: "acme.example" });
    // Pinned exactly, not by `toContain`. `toContain("emails domain dns")` also passes
    // for `emails domain dns <domain-or-id> --json` — an unsubstituted placeholder —
    // and this tool is not in the `unblocked` loop above that bans `<`.
    const runnable = (twin.split(" # ")[0] ?? twin).trim();
    expect(runnable).toBe("emails domain dns acme.example --json");
    expect(cliRefusalFor(runnable, "self_hosted")).toBeNull();
    // But the command must NOT be advertised bare: for a provider-backed domain it
    // performs the very adapter call the guard exists to prevent, with the caller's
    // ambient credentials. An agent handed this has to be told that, or the guard is
    // circumventable by following its own fix_commands.
    expect(twin).toContain(" # note: ");
    expect(twin).toContain("AMBIENT credentials");
    // And the guard itself is still installed — read off the source, so deleting the
    // call cannot leave this test green.
    const impl = readFileSync(new URL("./tools/domains-impl.ts", import.meta.url), "utf8");
    expect(impl).toContain('assertMcpLocalStateAllowed("get_dns_records"');
    expect(impl).toContain('assertMcpLocalStateAllowed("verify_domain"');
  });
});
