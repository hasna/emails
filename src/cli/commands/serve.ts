import type { Command } from "commander";
import { getEmailsMode } from "../../lib/mode.js";
import { registerServeCommands as registerLocal } from "./serve.local.js";
import { registerServeCommands as registerRemote } from "./serve.remote.js";

export function registerServeCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  return (getEmailsMode() === "self_hosted" ? registerRemote : registerLocal)(program, output);
}
