import type { Mailbox } from "./data.js";

export async function runOpenTuiApp(initialMailbox?: Mailbox): Promise<void> {
  const { runSolidOpenTuiApp } = await import("../tui-solid/runtime.js");
  await runSolidOpenTuiApp(initialMailbox);
}
