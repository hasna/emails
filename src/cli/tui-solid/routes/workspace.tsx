import { For, Show } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useMailery } from "../context/mailery-state.js";
import { useTheme } from "../context/theme.js";
import { Button, EmptyState, Row } from "../ui/primitives.js";

export function DomainsRoute() {
  const theme = useTheme();
  const mailery = useMailery();
  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background} paddingTop={1} paddingLeft={2} paddingRight={2}>
      <box height={2} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>Domains</text>
        <Button label="Back" onPress={() => mailery.actions.openRoute("mailbox")} />
      </box>
      <box height={1} flexDirection="row" columnGap={1} paddingLeft={1}>
        <box width={30}><text fg={theme.textMuted}>Domain</text></box>
        <box width={18}><text fg={theme.textMuted}>Provider</text></box>
        <box flexGrow={1}><text fg={theme.textMuted}>Readiness</text></box>
      </box>
      <Show when={mailery.state.domains.length > 0} fallback={<EmptyState title="No domains" detail="Configured domains will appear here." />}>
        <scrollbox flexGrow={1} width="100%">
          <For each={mailery.state.domains}>
            {(domain) => (
              <Row>
                <box flexDirection="row" width="100%" columnGap={1}>
                  <box width={30}><text fg={theme.text}>{domain.domain}</text></box>
                  <box width={18}><text fg={theme.textMuted}>{domain.provider}</text></box>
                  <box flexGrow={1}><text fg={domain.readiness === "ready_to_send_and_receive" ? theme.success : theme.warning}>{formatReadiness(domain.readiness)}</text></box>
                </box>
              </Row>
            )}
          </For>
        </scrollbox>
      </Show>
      <box height={1} />
      <box height={2} flexDirection="row" columnGap={1}>
        <Button label="Previous page" onPress={() => mailery.actions.workspacePage(-1)} />
        <Button label="Next page" active={mailery.state.domainsHasMore} onPress={() => mailery.actions.workspacePage(1)} />
      </box>
    </box>
  );
}

function formatReadiness(value: string): string {
  switch (value) {
    case "ready_to_send_and_receive": return "Ready";
    case "ready_to_send": return "Send ready";
    case "ready_to_receive": return "Receive ready";
    case "needs_dns": return "Needs DNS";
    case "broken": return "Broken";
    default: return value.replace(/_/g, " ");
  }
}
