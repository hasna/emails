import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("agent documentation contract", () => {
  it("keeps AGENTS.md aligned with current agent-facing surfaces", () => {
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");

    expect(agents).toContain("~/.hasna/emails/emails.db");
    expect(agents).toContain("HASNA_EMAILS_DB_PATH");
    expect(agents).toContain("100+ MCP tools");
    expect(agents).toContain("prepare_inbox");
    expect(agents).toContain("wait_for_code");
    expect(agents).toContain("list_usable_from_addresses");
    expect(agents).toContain("add_forwarding_rule");
    expect(agents).toContain("backfill=true");
    expect(agents).toContain("diagnose_inbound_delivery");
    expect(agents).toContain("--force-mx-switch");
    expect(agents).toContain("emails://agent/context");
    expect(agents).toContain("emails://recent-errors");
    expect(agents).not.toContain("59 MCP tools");
    expect(agents).not.toContain("mcp/index.ts               # MCP server (59 tools)");
  });

  it("documents checked feature-extension conventions for future agents", () => {
    const conventions = readFileSync(join(root, "docs", "FEATURE-CONVENTIONS.md"), "utf8");

    for (const phrase of [
      "DB-backed feature",
      "CLI command",
      "MCP tool",
      "REST endpoint",
      "Public library export",
      "Release gate",
      "src/cli/cli-contract.test.ts",
      "src/mcp/http.test.ts",
      "src/server/routes/rest-parity.test.ts",
      "src/index.test.ts",
      "fresh tmux session",
    ]) {
      expect(conventions).toContain(phrase);
    }
  });

  it("keeps the current CLI, auth, UI, and migration documentation honest", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const cli = readFileSync(join(root, "docs", "CLI.md"), "utf8");
    const auth = readFileSync(join(root, "docs", "AUTHENTICATION.md"), "utf8");
    const provisioning = readFileSync(join(root, "docs", "PROVISIONING.md"), "utf8");
    const openTui = readFileSync(join(root, "docs", "opentui-ui-spike.md"), "utf8");
    const macos = readFileSync(join(root, "docs", "macos-app.md"), "utf8");
    const cutover = readFileSync(join(root, "docs", "DEPLOYMENT_CUTOVER.md"), "utf8");

    expect(readme).not.toContain("emails config            #");
    for (const command of ["emails send-intent", "emails self-hosted key", "emails auth", "emails keys"]) {
      expect(readme).toContain(command);
    }

    for (const command of [
      "`provider`",
      "`domain`",
      "`inbox`",
      "`send-intent`",
      "`self-hosted`",
      "`auth`",
      "`keys`",
    ]) {
      expect(cli).toContain(command);
    }
    expect(cli).toContain("`emails-serve`");
    expect(cli).toContain("`emails-mcp`");

    expect(auth).toContain("EMAILS_SESSION_TOKEN");
    expect(auth).toContain("EMAILS_IDP_TOKEN");
    expect(auth).toContain("EMAILS_SELF_HOSTED_API_KEY");
    expect(auth).toContain("0021_idp_principal_tenants");

    expect(provisioning).toContain("the stateful provisioning workflow is not implemented");
    expect(provisioning).toContain("There is no\n`emails config` command");
    expect(openTui).toContain("@opentui/solid` 0.4.1");
    expect(openTui).toContain("There is no `src/cli/tui/App.tsx` compatibility component");
    expect(macos).toContain("not shipped and not buildable");
    expect(cutover).toContain("0020_attachment_repair_ledger");
    expect(cutover).toContain("pre-0020");
  });

  it("keeps station-local retirement behind the two-station backup and rollback gate", () => {
    const runtime = readFileSync(join(root, "docs", "SELF_HOSTED_RUNTIME.md"), "utf8");
    const retirement = readFileSync(join(root, "docs", "STATION_LOCAL_RETIREMENT.md"), "utf8");
    const smoke = readFileSync(join(root, "scripts", "self-hosted-client-smoke.sh"), "utf8");

    expect(runtime).toContain("./scripts/self-hosted-client-smoke.sh");
    expect(runtime).toContain("STATION_LOCAL_RETIREMENT.md");
    for (const phrase of [
      "Two-station pre-stop barrier",
      "independent backup verifier",
      "-wal",
      "-shm",
      "attachment/cache",
      "final fenced backup",
      "Remote proof and non-recreation proof",
      "original-paths.tsv",
      "Rollback",
      "retention owner",
      "Never delete",
    ]) {
      expect(retirement).toContain(phrase);
    }
    expect(smoke).toContain('test "${HASNA_EMAILS_DB_PATH+x}" = "x"');
    expect(smoke).toContain('test "${EMAILS_DB_PATH+x}" = "x"');
    expect(smoke).toContain('"$emails_cli" status --json');
    expect(smoke).toContain('"$emails_cli" provider list --json');
    expect(smoke).toContain('"$emails_cli" inbox list --limit 1 --json');
  });
});
