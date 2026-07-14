import type { Command } from "commander";
import { getEmailsMode } from "../../lib/mode.js";
import { registerEmailLogCommands as registerLocal } from "./email-log.local.js";
import { registerEmailLogCommands as registerRemote } from "./email-log.remote.js";

export function registerEmailLogCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  return (getEmailsMode() === "self_hosted" ? registerRemote : registerLocal)(program, output);
}
