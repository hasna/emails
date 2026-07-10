/** @jsxImportSource @opentui/solid */
import { Match, Switch, onCleanup, onMount, type ParentProps } from "solid-js";
import { useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/solid";
import type { Mailbox } from "../tui/data.js";
import { copyTextToClipboardAsync } from "../tui/clipboard.js";
import { startEventLoopWatchdog } from "../tui/watchdog.js";
import { ThemeProvider, useTheme } from "./context/theme.js";
import { EmailsProvider, useEmails } from "./context/emails-state.js";
import { ToastProvider, ToastViewport, useToast } from "./context/toast.js";
import { DialogProvider, DialogViewport } from "./context/dialog.js";
import { CommandProvider } from "./context/commands.js";
import { Sidebar, sidebarWidth } from "./component/sidebar.js";
import { MailboxRoute } from "./component/mailbox.js";
import { ReaderRoute } from "./component/reader.js";
import { ComposeWindow } from "./component/compose.js";
import { EmailsDialogs } from "./component/dialogs.js";
import { DomainsRoute } from "./routes/workspace.js";
import { useStaticBindings } from "./context/keymap.js";

export interface AppProps {
  initialMailbox?: Mailbox;
}

function RuntimeWatchdog() {
  onMount(() => {
    const stop = startEventLoopWatchdog();
    onCleanup(stop);
  });
  return null;
}

function RoutedContent() {
  const emails = useEmails();
  return (
    <Switch fallback={<MailboxRoute />}>
      <Match when={emails.state.route === "mailbox"}><MailboxRoute /></Match>
      <Match when={emails.state.route === "reader"}><ReaderRoute /></Match>
      <Match when={emails.state.route === "domains"}><DomainsRoute /></Match>
    </Switch>
  );
}

function AppShell() {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const theme = useTheme();
  const toast = useToast();

  useSelectionHandler((selection) => {
    const text = selection.getSelectedText().trim();
    if (!text) return;
    void copyTextToClipboardAsync(text).then((result) => {
      if (!result.ok) return;
      toast.show({ title: "Copied", message: `Selection copied via ${result.method ?? "clipboard"}.`, tone: "success" });
    });
  });

  useStaticBindings(() => ({
    priority: 10,
    bindings: [
      {
        key: "ctrl+c",
        desc: "Exit",
        group: "System",
        cmd: () => {
          if (renderer.getSelection()) renderer.clearSelection();
          else renderer.destroy();
        },
      },
    ],
  }));

  const sidebarW = () => sidebarWidth(dimensions().width);
  return (
    <box width={dimensions().width} height={dimensions().height} flexDirection="row" backgroundColor={theme.background}>
      <box width={sidebarW()} height="100%" backgroundColor={theme.backgroundPanel}>
        <Sidebar />
      </box>
      <box flexGrow={1} height="100%" backgroundColor={theme.background}>
        <RoutedContent />
      </box>
      <ComposeWindow />
      <EmailsDialogs />
      <DialogViewport />
      <ToastViewport />
    </box>
  );
}

function ThemedApp(props: ParentProps) {
  const emails = useEmails();
  return (
    <ThemeProvider mode={emails.state.settings.theme}>
      {props.children}
    </ThemeProvider>
  );
}

export function App(props: AppProps) {
  return (
    <EmailsProvider initialMailbox={props.initialMailbox}>
      <RuntimeWatchdog />
      <ThemedApp>
        <ToastProvider>
          <DialogProvider>
            <CommandProvider>
              <AppShell />
            </CommandProvider>
          </DialogProvider>
        </ToastProvider>
      </ThemedApp>
    </EmailsProvider>
  );
}
