import type { Command } from "commander";
import { executeControlledSend } from "../../lib/controlled-send-envelope.js";
import { handleError, isCliJsonOutput } from "../utils.js";

type OutputFn = (data: unknown, formatted: string) => void;

interface ControlledSendOptions {
  descriptor: string;
  requestId: string;
  receipt: string;
}

export function registerControlledSendCommands(program: Command, output: OutputFn): void {
  const command = program
    .command("send-controlled")
    .description("Send from a private descriptor and write an owner-only terminal receipt");

  for (const operation of ["apply", "readback"] as const) {
    command
      .command(operation)
      .description(operation === "apply"
        ? "Apply one idempotent send request from a private descriptor"
        : "Read back one send intent without sending")
      .requiredOption("--descriptor <path>", "Owner-only mode 0600 request descriptor")
      .requiredOption("--request-id <id>", "Opaque request identifier")
      .requiredOption("--receipt <path>", "New owner-only receipt path")
      .action(async (opts: ControlledSendOptions) => {
        try {
          const result = await executeControlledSend(operation, {
            descriptorPath: opts.descriptor,
            requestId: opts.requestId,
            receiptPath: opts.receipt,
          });
          output(
            result.receipt,
            `${result.receipt.request_id} ${result.receipt.terminal_state}`,
          );
          if (result.diagnostic && !isCliJsonOutput()) console.error(result.diagnostic);
          if (result.exitCode !== 0) process.exitCode = result.exitCode;
        } catch (error) {
          handleError(error);
        }
      });
  }
}
