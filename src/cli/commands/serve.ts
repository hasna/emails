import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import { getClaudeMcpInstallCommand, getClaudeMcpRemoveCommand, getCodexMcpConfig, getGeminiMcpConfig } from "../../lib/mcp-install.js";
import { handleError } from "../utils.js";

export function registerServeCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  // ─── SERVE ────────────────────────────────────────────────────────────────────
  program
    .command("serve")
    .description("Start the self-hosted HTTP service")
    .option("--port <port>", "Port to listen on", "8080")
    .option("--host <host>", "Host to bind to (default: 0.0.0.0)", "0.0.0.0")
    .action(async (opts: { port?: string; host?: string }) => {
      const { startSelfHostedServer } = await import("../../server/self-hosted/serve.js");
      const port = parseInt(opts.port ?? "8080", 10);
      const host = opts.host ?? "0.0.0.0";
      await startSelfHostedServer(pkg.version, port, host);
    });

  // ─── MCP ──────────────────────────────────────────────────────────────────────
  program
    .command("mcp")
    .description("Install/configure the MCP server")
    .option("--claude", "Install into Claude Code")
    .option("--codex", "Show Codex config snippet")
    .option("--gemini", "Show Gemini config snippet")
    .option("--uninstall", "Uninstall from Claude Code")
    .option("--dry-run", "Print the installation command/config without modifying local agent configuration")
    .action((opts: { claude?: boolean; codex?: boolean; gemini?: boolean; uninstall?: boolean; dryRun?: boolean }) => {
      if (opts.uninstall) {
        const remove = getClaudeMcpRemoveCommand();
        if (opts.dryRun) {
          output({ target: "claude", action: "remove", ...remove }, remove.shell);
          return;
        }
        try {
          execFileSync(remove.command, remove.args, { stdio: "inherit" });
          console.log(chalk.green("✓ Uninstalled from Claude Code"));
        } catch (e) {
          handleError(e);
        }
        return;
      }

      if (opts.claude) {
        const install = getClaudeMcpInstallCommand();
        if (opts.dryRun) {
          output({ target: "claude", action: "install", ...install }, install.shell);
          return;
        }
        try {
          execFileSync(install.command, install.args, { stdio: "inherit" });
          console.log(chalk.green("✓ Installed into Claude Code"));
        } catch (e) {
          handleError(e);
        }
        return;
      }

      if (opts.codex) {
        console.log(`\nAdd to ~/.codex/config.toml:\n`);
        console.log(getCodexMcpConfig());
        return;
      }

      if (opts.gemini) {
        console.log(`\nAdd to ~/.gemini/settings.json under mcpServers:\n`);
        console.log(JSON.stringify(getGeminiMcpConfig().mcpServers, null, 2));
        console.log();
        return;
      }

      program.help();
    });

  // ─── REMOVE ───────────────────────────────────────────────────────────────────
  program
    .command("remove")
    .alias("uninstall")
    .description("Uninstall the Emails MCP from agent configs")
    .option("--claude", "Remove from Claude Code")
    .option("--codex", "Remove from Codex CLI (~/.codex/config.toml)")
    .option("--gemini", "Remove from Gemini CLI (~/.gemini/settings.json)")
    .option("--all", "Remove from all agent configs")
    .action((opts: { claude?: boolean; codex?: boolean; gemini?: boolean; all?: boolean }) => {
      const doAll = opts.all || (!opts.claude && !opts.codex && !opts.gemini);
      const HOME = process.env["HOME"] || process.env["USERPROFILE"] || "~";

      if (doAll || opts.claude) {
        const remove = getClaudeMcpRemoveCommand();
        try {
          execFileSync(remove.command, remove.args, { stdio: "pipe" });
          console.log(chalk.green("✓ Removed from Claude Code"));
        } catch {
          console.log(chalk.yellow("⚠ Could not auto-remove from Claude Code. Run manually:"));
          console.log(chalk.dim(`  ${remove.shell}`));
        }
      }

      if (doAll || opts.codex) {
        try {
          const configPath = join(HOME, ".codex", "config.toml");
          if (!existsSync(configPath)) {
            console.log(chalk.dim("Codex CLI config not found, skipping"));
          } else {
            const lines = readFileSync(configPath, "utf-8").split("\n");
            const result: string[] = [];
            let skipping = false;
            for (const line of lines) {
              if (line.trim() === "[mcp_servers.emails]") { skipping = true; continue; }
              if (skipping && line.startsWith("[")) skipping = false;
              if (!skipping) result.push(line);
            }
            writeFileSync(configPath, result.join("\n").trimEnd() + "\n");
            console.log(chalk.green("✓ Removed from Codex CLI config"));
          }
        } catch (e) { handleError(e); }
      }

      if (doAll || opts.gemini) {
        try {
          const configPath = join(HOME, ".gemini", "settings.json");
          if (!existsSync(configPath)) {
            console.log(chalk.dim("Gemini CLI config not found, skipping"));
          } else {
            const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
            const mcpServers = config["mcpServers"] as Record<string, unknown> | undefined;
            if (mcpServers?.["emails"] || mcpServers?.["emails"]) {
              delete mcpServers["emails"];
              delete mcpServers["emails"];
              writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
              console.log(chalk.green("✓ Removed from Gemini CLI config"));
            } else {
              console.log(chalk.dim("emails not found in Gemini CLI config, skipping"));
            }
          }
        } catch (e) { handleError(e); }
      }
    });
}
