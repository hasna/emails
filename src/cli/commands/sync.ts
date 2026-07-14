import type { Command } from "commander";
import { getEmailsMode } from "../../lib/mode.js";
import { registerSyncCommands as registerLocal } from "./sync.local.js";
import { registerSyncCommands as registerRemote } from "./sync.remote.js";

export function registerSyncCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  return (getEmailsMode() === "self_hosted" ? registerRemote : registerLocal)(program, output);
}
