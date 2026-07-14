import type { Command } from "commander";
import { getEmailsMode } from "../../lib/mode.js";
import { registerInboundCommands as registerLocal } from "./inbound.local.js";
import { registerInboundCommands as registerRemote } from "./inbound.remote.js";

export function registerInboundCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  return (getEmailsMode() === "self_hosted" ? registerRemote : registerLocal)(program, output);
}
