import type { Command } from "commander";
import { handleError } from "../utils.js";

// The local SMTP listener and the local inbound_emails store have no /v1
// equivalent here: inbound ingestion runs on the self-hosted server and the
// API-backed mail view is exposed through `emails inbox ...`. This client is
// self-hosted-only, so these commands are kept for discoverability but fail
// loud.
function serverOnly(command: string): never {
  throw new Error(
    `${command} is not available in the self-hosted client; it runs on the self-hosted server. Use \`emails inbox ...\` for the API-backed mail view.`,
  );
}

export function registerInboundCommands(program: Command, _output: (data: unknown, formatted: string) => void): void {
  const inboundCmd = program.command("inbound").description("Receive and inspect inbound emails");

  inboundCmd
    .command("listen")
    .description("Start a local SMTP listener to receive inbound emails")
    .option("--port <port>", "SMTP port to listen on", "2525")
    .option("--provider <id>", "Associate received emails with this provider ID")
    .action(async () => {
      try { serverOnly("emails inbound listen"); } catch (e) { handleError(e); }
    });

  inboundCmd
    .command("list")
    .description("List received inbound emails")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip first N emails", "0")
    .action(() => {
      try { serverOnly("emails inbound list"); } catch (e) { handleError(e); }
    });

  inboundCmd
    .command("show <id>")
    .description("Show full inbound email details")
    .action(() => {
      try { serverOnly("emails inbound show"); } catch (e) { handleError(e); }
    });

  inboundCmd
    .command("open <id>")
    .description("Open a readable local HTML view of an inbound email")
    .action(async () => {
      try { serverOnly("emails inbound open"); } catch (e) { handleError(e); }
    });

  inboundCmd
    .command("clear")
    .description("Delete all received inbound emails")
    .option("--provider <id>", "Only clear emails for a specific provider")
    .action(() => {
      try { serverOnly("emails inbound clear"); } catch (e) { handleError(e); }
    });

  inboundCmd
    .command("count")
    .description("Show count of received inbound emails")
    .option("--provider <id>", "Filter by provider ID")
    .action(() => {
      try { serverOnly("emails inbound count"); } catch (e) { handleError(e); }
    });
}
