import type { Mailbox } from "../tui/data.js";

export async function runSolidOpenTuiApp(initialMailbox?: Mailbox): Promise<void> {
  const previousAlternateScreen = process.env["OTUI_USE_ALTERNATE_SCREEN"];
  process.env["OTUI_USE_ALTERNATE_SCREEN"] = "true";
  let renderer: Awaited<ReturnType<(typeof import("@opentui/core"))["createCliRenderer"]>> | null = null;
  const signalExitCodes: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 130, SIGTERM: 143 };
  const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
  const restoreAlternateScreenEnv = () => {
    if (previousAlternateScreen === undefined) delete process.env["OTUI_USE_ALTERNATE_SCREEN"];
    else process.env["OTUI_USE_ALTERNATE_SCREEN"] = previousAlternateScreen;
  };

  const [{ createCliRenderer }, { render }, { createDefaultOpenTuiKeymap }, { KeymapProvider }, { App }] = await Promise.all([
    import("@opentui/core"),
    import("@opentui/solid"),
    import("@opentui/keymap/opentui"),
    import("@opentui/keymap/solid"),
    import("./App.js"),
  ]);

  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      screenMode: "alternate-screen",
      clearOnShutdown: true,
      targetFps: 60,
      consoleMode: "disabled",
      openConsoleOnError: false,
      useKittyKeyboard: {},
      useMouse: true,
      enableMouseMovement: true,
      backgroundColor: "#0a0a0a",
    });
    const keymap = createDefaultOpenTuiKeymap(renderer);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        process.exitCode = signalExitCodes[signal] ?? 1;
        renderer?.destroy();
      };
      signalHandlers.push([signal, handler]);
      process.once(signal, handler);
    }
    renderer.setTerminalTitle("Mailery");
    const destroyed = new Promise<void>((resolve) => renderer!.on("destroy", () => resolve()));
    await render(() => (
      <KeymapProvider keymap={keymap}>
        <App initialMailbox={initialMailbox} />
      </KeymapProvider>
    ), renderer);
    await destroyed;
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    renderer?.destroy();
    restoreAlternateScreenEnv();
  }
}
