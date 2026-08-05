import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getClaudeMcpInstallCommand, getClaudeMcpRemoveCommand, getCodexMcpConfig, getGeminiMcpConfig } from "../../lib/mcp-install.js";
import { handleError } from "../utils.js";

/**
 * Start the optional provider webhook listener for `emails serve`, AS A RESULT RATHER THAN AS A
 * THROW — and hand the server back so a caller can stop it.
 *
 * Extracted, and named, for one reason: the receiver now REFUSES on an installation whose mail
 * lives in an Emails API, because the service receives those callbacks (`src/lib/webhook.ts`
 * states why). Inline in the action, that refusal was UNTESTABLE — the action's first statement
 * starts a dashboard HTTP server that `startServer` does not hand back and nothing can stop, which
 * is why this command has no end-to-end test at all — and an unhandled rejection there would have
 * taken a dashboard that bound successfully down with an optional listener.
 *
 * `handleError` is deliberately NOT used: it exits the process, for the same reason.
 *
 * The server is RETURNED rather than discarded. The action still does not stop it (it runs until
 * the operator interrupts), but a caller that needs to — a test — now can, which is the difference
 * between a testable unit and this file's untestable action.
 *
 * THE RETURN TYPE IS DERIVED FROM THE RECEIVER, NOT HAND-WRITTEN, and that is a correction rather
 * than a style choice. A hand-written `{ port: number; stop(…) }` did not typecheck — `Bun.Server`
 * declares `port` as `number | undefined` — and the failure was invisible to the whole test suite,
 * because Bun transpiles without typechecking and the repo's only whole-program gate
 * (`src/index.test.ts`) exhausts V8's heap before it can report. Derived, it cannot drift from what
 * `Bun.serve` actually returns.
 *
 * The `Awaited<>` is defensive rather than load-bearing — `createWebhookServer` is synchronous, so
 * this resolves to `Bun.Server` today. It is kept so the alias survives that function becoming
 * async, which is the change most likely to reintroduce the drift this replaced.
 */
type WebhookListener = Awaited<ReturnType<typeof import("../../lib/webhook.js").createWebhookServer>>;

export async function startServeWebhookListener(
  port: number,
  providerId: string | undefined,
  webhookSecret: string | undefined,
): Promise<{ started: true; server: WebhookListener } | { started: false; reason: string }> {
  try {
    const { createWebhookServer } = await import("../../lib/webhook.js");
    return { started: true, server: createWebhookServer(port, providerId, webhookSecret) };
  } catch (error) {
    return { started: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function registerServeCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  // ─── SERVE ────────────────────────────────────────────────────────────────────
  program
    .command("serve")
    .description("Start the HTTP server and dashboard")
    .option("--port <port>", "Port to listen on", "3900")
    .option("--host <host>", "Host to bind to (non-loopback requires EMAILS_ALLOW_REMOTE=1)", "127.0.0.1")
    .option("--webhook-port <port>", "Also start webhook listener on this port")
    .option("--smtp-port <port>", "Also start SMTP inbound listener on this port")
    .option("--all", "Start all listeners (HTTP :3900, webhook :9877, SMTP :2525)")
    .option("--provider <id>", "Provider ID for inbound/webhook listeners")
    .option("--webhook-secret <secret>", "Resend webhook signing secret (whsec_...) for signature verification")
    .action(async (opts: { port?: string; host?: string; webhookPort?: string; smtpPort?: string; all?: boolean; provider?: string; webhookSecret?: string }) => {
      const { startServer } = await import("../../server/serve.js");
      const port = parseInt(opts.port ?? "3900", 10);
      const host = opts.host ?? "127.0.0.1";
      await startServer(port, host);

      const webhookPort = opts.all ? 9877 : (opts.webhookPort ? parseInt(opts.webhookPort, 10) : null);
      const smtpPort = opts.all ? 2525 : (opts.smtpPort ? parseInt(opts.smtpPort, 10) : null);
      if (webhookPort) {
        const outcome = await startServeWebhookListener(webhookPort, opts.provider, opts.webhookSecret);
        if (outcome.started) {
          const securityNote = opts.webhookSecret ? chalk.green(" (signature verified)") : chalk.yellow(" (no signature verification)");
          console.log(chalk.dim(`  Webhook listener on port ${webhookPort}`) + securityNote);
        } else {
          // REPORTED ALWAYS; the EXIT STATUS depends on whether the operator asked for this
          // listener specifically. `--webhook-port <n>` is a request for a receiver and its absence
          // is a failure, so the process is marked failed while the dashboard that DID bind keeps
          // serving. `--all` is a convenience meaning "start what you can", and a review pointed
          // out that failing it outright would be inconsistent anyway: the SMTP listener started
          // below is NOT gated and still writes inbound mail into local SQLite in the very
          // configuration this gate exists to refuse, so `--all` is half-gated whatever this line
          // does. (That asymmetry is `src/lib/inbound.local.ts`'s to resolve when the inbound
          // family collapses — it is named here, not papered over.)
          //
          // THE TWO LINES OF THIS CHANGE NO TEST REACHES, stated plainly rather than dressed up as
          // unreachable, and MEASURED rather than estimated: THREE mutants over them all survive —
          // never setting the status, always setting it (so `--all` stops being distinguished), and
          // dropping the report entirely. Reaching them means running the action, and the action's
          // first statement binds a dashboard that `startServer` does not hand back, so a test that
          // got here would hold a port for the rest of the run. The decision they hang off — refuse
          // versus start, and with what reason — IS tested, through the helper above.
          //
          // A PRE-EXISTING ODDITY ONE LINE UP, found while checking this and left alone because it
          // is not this change's to fix: `--all` is evaluated BEFORE `--webhook-port`, so
          // `emails serve --all --webhook-port 9999` silently binds 9877 and discards the explicit
          // port. The conditional below still reads the explicit flag correctly, so the exit status
          // is right even in that case; it is the PORT that is wrong, and it was wrong before this.
          if (opts.webhookPort) process.exitCode = 1;
          console.error(chalk.red(`  Webhook listener NOT started: ${outcome.reason}`));
        }
      }
      if (smtpPort) {
        const { createSmtpServer } = await import("../../lib/inbound.local.js");
        createSmtpServer(smtpPort, opts.provider);
        console.log(chalk.dim(`  SMTP listener on port ${smtpPort}`));
      }
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
