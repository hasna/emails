import { For, Show, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { useMailery, COMMON_LABELS, MAILBOXES } from "../context/mailery-state.js";
import { useCommands } from "../context/commands.js";
import { labelColor, useTheme } from "../context/theme.js";
import { useDialog } from "../context/dialog.js";
import { SelectDialog, type SelectDialogItem } from "../ui/select-dialog.js";
import { copyTextToClipboardAsync } from "../../tui/clipboard.js";
import { useToast } from "../context/toast.js";
import { Button, EmptyState, Row } from "../ui/primitives.js";
import { labelDisplayName, mailboxLabel, type Mailbox } from "../../tui/data.js";

export function MaileryDialogs() {
  const mailery = useMailery();
  const commands = useCommands();
  const dialog = useDialog();
  const theme = useTheme();
  const toast = useToast();

  const close = () => {
    mailery.actions.closeDialog();
    dialog.clear();
  };

  const commandItems = createMemo<SelectDialogItem[]>(() => commands.visibleCommands().map((command) => ({
    id: command.id,
    title: command.title,
    detail: command.category,
    category: command.category,
  })));

  const addressItems = createMemo<SelectDialogItem[]>(() => mailery.state.addresses.map((address) => ({
    id: address.id,
    title: address.label,
    detail: inboxDetail(address),
    marker: mailery.state.selectedAddressId === address.id ? "●" : " ",
    markerColor: theme.primary,
  })));

  const labelItems = createMemo<SelectDialogItem[]>(() => {
    const selected = new Set(mailery.selectedMessage()?.labels.map((label) => label.toLowerCase()) ?? []);
    const summaries = mailery.state.labels.map((label) => ({
      id: label.name,
      title: labelDisplayName(label.name),
      detail: label.popular ? `${label.count} selected` : label.count ? String(label.count) : "",
      category: label.popular ? "Popular" : "Labels",
      marker: selected.has(label.name.toLowerCase()) ? "■" : "□",
      markerColor: labelColor(theme, label.name),
    }));
    const existing = new Set(summaries.map((item) => item.id));
    const common = COMMON_LABELS.filter((label) => !existing.has(label)).map((label) => ({
      id: label,
      title: labelDisplayName(label),
      detail: "",
      category: "Common",
      marker: selected.has(label.toLowerCase()) ? "■" : "□",
      markerColor: labelColor(theme, label),
    }));
    const q = mailery.state.labelSearch.trim();
    const custom = q && !existing.has(q.toLowerCase().replace(/\s+/g, "-")) ? [{
      id: q,
      title: `Create ${labelDisplayName(q)}`,
      detail: "new label",
      category: "Create",
      marker: "+",
      markerColor: theme.primary,
    }] : [];
    return [...summaries, ...common, ...custom];
  });

  const linkItems = createMemo<SelectDialogItem[]>(() => mailery.links().map((link, index) => ({
    id: String(index),
    title: link.text || link.url,
    detail: link.url,
    category: link.source,
    marker: "↗",
    markerColor: theme.secondary,
  })));

  createEffect(() => {
    const kind = mailery.state.dialog;
    untrack(() => {
      if (kind === null) {
        dialog.clear();
        return;
      }

    if (kind === "commands") {
      dialog.replace(() => (
        <SelectDialog
          title="Shortcuts"
          placeholder="Search commands"
          items={commandItems()}
          query={mailery.state.commandSearch}
          onQuery={mailery.actions.setCommandSearch}
          onSelect={(item) => {
            close();
            void commands.runCommand(item.id);
          }}
          onClose={close}
          footer="Use buttons, command palette, and safe global bindings. Single-letter shortcuts are disabled."
        />
      ), { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "address") {
      dialog.replace(() => (
        <SelectDialog
          title="Inboxes"
          placeholder="Search inboxes"
          items={addressItems()}
          query={mailery.state.addressSearch}
          onQuery={mailery.actions.setAddressSearch}
          onSelect={(item) => {
            mailery.actions.setAddress(item.id);
            close();
          }}
          onClose={close}
        />
      ), { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "search") {
      dialog.replace(() => (
        <box flexDirection="column" width="100%" rowGap={1}>
          <box height={1} flexDirection="row" justifyContent="space-between">
            <text fg={theme.text}>Search Mail</text>
            <Button label="Close" onPress={close} />
          </box>
          <input
            focused
            value={mailery.state.searchDraft}
            placeholder="Search subject, sender, recipient, body"
            width="100%"
            textColor={theme.text}
            backgroundColor={theme.backgroundElement}
            focusedTextColor={theme.text}
            focusedBackgroundColor={theme.backgroundActive}
            placeholderColor={theme.textMuted}
            cursorColor={theme.text}
            onInput={mailery.actions.setSearchDraft}
            onSubmit={(value) => {
              mailery.actions.search(String(value));
              close();
            }}
          />
          <box height={1} flexDirection="row" columnGap={1}>
            <Button label="Apply" active onPress={() => {
              mailery.actions.search(mailery.state.searchDraft);
              close();
            }} />
            <Button label="Clear" onPress={() => {
              mailery.actions.search("");
              close();
            }} />
          </box>
        </box>
      ), { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "domains") {
      dialog.replace(() => <DomainsDialog close={close} />, { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "settings") {
      dialog.replace(() => <SettingsDialog close={close} />, { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "labels") {
      dialog.replace(() => (
        <SelectDialog
          title="Labels"
          placeholder="Search or create label"
          items={labelItems()}
          query={mailery.state.labelSearch}
          onQuery={mailery.actions.setLabelSearch}
          onSelect={(item) => {
            mailery.actions.toggleSelectedLabel(item.id);
            toast.show({ title: "Label updated", message: labelDisplayName(item.id), tone: "success" });
            close();
          }}
          onClose={close}
        />
      ), { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "links") {
      dialog.replace(() => (
        <box flexDirection="column" width="100%" rowGap={1}>
          <SelectDialog
            title="Links"
            placeholder="Filter links"
            items={linkItems()}
            query=""
            onQuery={() => undefined}
            onSelect={(item) => {
              const link = mailery.links()[Number(item.id)];
              if (!link) return;
              void copyTextToClipboardAsync(link.url).then((result) => {
                toast.show({
                  title: result.ok ? "Link copied" : "Copy failed",
                  message: result.ok ? link.url : result.error ?? "Clipboard unavailable",
                  tone: result.ok ? "success" : "error",
                });
              });
              close();
            }}
            onClose={close}
          />
          <Button
            label="Copy all links"
            onPress={() => {
              const links = mailery.links().map((link) => link.url).join("\n");
              void copyTextToClipboardAsync(links).then((result) => {
                toast.show({ title: result.ok ? "Links copied" : "Copy failed", message: `${mailery.links().length} link(s)`, tone: result.ok ? "success" : "error" });
              });
              close();
            }}
          />
          <For each={mailery.links().length === 0 ? ["No links detected."] : []}>
            {(message) => <text fg={theme.textMuted}>{message}</text>}
          </For>
        </box>
      ), { size: "large", onClose: mailery.actions.closeDialog });
    }
    });
  });

  return null;
}

function inboxDetail(address: { provider?: string; receiveStatus?: string; configured: boolean; observed: boolean }): string {
  if (!address.configured) return address.observed ? "observed" : "";
  const parts = [address.provider, formatReceiveStatus(address.receiveStatus)];
  if (address.observed) parts.push("observed");
  return parts.filter((part): part is string => !!part).join(" · ");
}

function formatReceiveStatus(value: string | undefined): string | undefined {
  if (!value || value === "none") return "configured";
  if (value === "ready") return "ready";
  return value.replace(/_/g, " ");
}

function boolText(value: boolean): string {
  return value ? "On" : "Off";
}

function readinessLabel(value: string): string {
  switch (value) {
    case "ready_to_send_and_receive": return "Ready";
    case "ready_to_send": return "Send ready";
    case "ready_to_receive": return "Receive ready";
    case "needs_dns": return "Needs DNS";
    case "broken": return "Broken";
    default: return value.replace(/_/g, " ");
  }
}

function readinessColor(theme: ReturnType<typeof useTheme>, value: string) {
  if (value === "ready_to_send_and_receive") return theme.success;
  if (value === "ready_to_send" || value === "ready_to_receive") return theme.info;
  if (value === "broken") return theme.error;
  return theme.warning;
}

function DomainsDialog(props: { close: () => void }) {
  const mailery = useMailery();
  const theme = useTheme();
  useKeyboard((key) => {
    if (key.name === "escape") props.close();
  });
  return (
    <box flexDirection="column" width="100%" rowGap={1}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>Domains</text>
        <Button label="Close" onPress={props.close} />
      </box>

      <box height={1} flexDirection="row" columnGap={2} paddingLeft={1}>
        <box width={34}><text fg={theme.textMuted}>Domain</text></box>
        <box width={22}><text fg={theme.textMuted}>Provider</text></box>
        <box flexGrow={1}><text fg={theme.textMuted}>Readiness</text></box>
      </box>

      <Show when={mailery.state.domains.length > 0} fallback={<EmptyState title="No domains" detail="Configured domains will appear here." />}>
        <scrollbox height={14} width="100%">
          <For each={mailery.state.domains}>
            {(domain) => (
              <Row>
                <box flexDirection="row" width="100%" columnGap={2}>
                  <box width={34}><text fg={theme.text}>{domain.domain}</text></box>
                  <box width={22}><text fg={theme.textMuted}>{domain.provider}</text></box>
                  <box flexGrow={1}><text fg={readinessColor(theme, domain.readiness)}>{readinessLabel(domain.readiness)}</text></box>
                </box>
              </Row>
            )}
          </For>
        </scrollbox>
      </Show>

      <box height={1} />
      <box height={1} flexDirection="row" columnGap={1}>
        <Button label="Previous page" onPress={() => mailery.actions.workspacePage(-1)} />
        <Button label="Next page" active={mailery.state.domainsHasMore} onPress={() => mailery.actions.workspacePage(1)} />
      </box>
    </box>
  );
}

type SettingsSection = "main" | "sync" | "defaults" | "display";

function settingsTitle(section: SettingsSection): string {
  switch (section) {
    case "sync": return "Settings / Sync";
    case "defaults": return "Settings / Defaults";
    case "display": return "Settings / Display";
    default: return "Settings";
  }
}

function SettingsMenuRow(props: { title: string; detail: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Row height={2} onPress={props.onPress}>
      <box flexDirection="column" width="100%">
        <text fg={theme.text}>{props.title}</text>
        <text fg={theme.textMuted}>{props.detail}</text>
      </box>
    </Row>
  );
}

function SettingsActionRow(props: { title: string; value: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Row onPress={props.onPress}>
      <box flexDirection="row" width="100%" justifyContent="space-between">
        <text fg={theme.text}>{props.title}</text>
        <text fg={theme.textMuted}>{props.value}</text>
      </box>
    </Row>
  );
}

function SettingsDialog(props: { close: () => void }) {
  const mailery = useMailery();
  const [section, setSection] = createSignal<SettingsSection>("main");
  const settings = () => mailery.state.settings;
  const goBack = () => {
    if (section() === "main") props.close();
    else setSection("main");
  };
  const cycleMailbox = () => {
    const index = MAILBOXES.indexOf(settings().defaultMailbox);
    mailery.actions.setSetting("defaultMailbox", MAILBOXES[(index + 1) % MAILBOXES.length] as Mailbox);
  };
  const openInboxes = () => {
    props.close();
    mailery.actions.openDialog("address");
  };
  const openCompose = () => {
    props.close();
    mailery.actions.startCompose("new");
  };

  useKeyboard((key) => {
    if (key.name !== "escape") return;
    goBack();
    key.preventDefault();
    key.stopPropagation();
  });

  const theme = useTheme();
  return (
    <box flexDirection="column" width="100%" rowGap={1}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>{settingsTitle(section())}</text>
        <Button label={section() === "main" ? "Close" : "Back"} onPress={goBack} />
      </box>

      <Show when={section() === "main"}>
        <box flexDirection="column" width="100%" rowGap={1}>
          <SettingsMenuRow title="Sync" detail="Auto-pull and Gmail refresh" onPress={() => setSection("sync")} />
          <SettingsMenuRow title="Defaults" detail="Inbox, folder, and sender" onPress={() => setSection("defaults")} />
          <SettingsMenuRow title="Display" detail="Theme and read-state styling" onPress={() => setSection("display")} />
        </box>
      </Show>

      <Show when={section() === "sync"}>
        <box flexDirection="column" width="100%" rowGap={1}>
          <SettingsActionRow
            title="Auto-pull inbound"
            value={boolText(settings().autoPull)}
            onPress={() => mailery.actions.setSetting("autoPull", !settings().autoPull)}
          />
          <SettingsActionRow
            title="Gmail auto-pull"
            value={boolText(settings().gmailAutoPull)}
            onPress={() => mailery.actions.setSetting("gmailAutoPull", !settings().gmailAutoPull)}
          />
        </box>
      </Show>

      <Show when={section() === "defaults"}>
        <box flexDirection="column" width="100%" rowGap={1}>
          <SettingsActionRow title="Default folder" value={mailboxLabel(settings().defaultMailbox)} onPress={cycleMailbox} />
          <SettingsActionRow title="Default inbox" value={settings().defaultAddress ?? "All inboxes"} onPress={openInboxes} />
          <SettingsActionRow title="Default From" value={settings().defaultFrom ?? "Automatic"} onPress={openCompose} />
        </box>
      </Show>

      <Show when={section() === "display"}>
        <box flexDirection="column" width="100%" rowGap={1}>
          <SettingsActionRow
            title="Dim read messages"
            value={boolText(settings().dimRead)}
            onPress={() => mailery.actions.setSetting("dimRead", !settings().dimRead)}
          />
          <SettingsActionRow
            title="Theme"
            value={settings().theme}
            onPress={() => mailery.actions.setSetting("theme", settings().theme === "dark" ? "light" : "dark")}
          />
        </box>
      </Show>
    </box>
  );
}
