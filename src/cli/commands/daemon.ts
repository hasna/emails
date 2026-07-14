import type { Command } from "commander";
import { getEmailsMode } from "../../lib/mode.js";
import { registerDaemonCommands as registerLocal } from "./daemon.local.js";
import { registerDaemonCommands as registerRemote } from "./daemon.remote.js";

export function registerDaemonCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  return (getEmailsMode() === "self_hosted" ? registerRemote : registerLocal)(program, output);
}
