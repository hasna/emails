import { For, Show } from "solid-js";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import { useMailery } from "../context/mailery-state.js";
import { useTheme } from "../context/theme.js";
import { Button, EmptyState } from "../ui/primitives.js";
import { formatDate, renderReadableBodyLines } from "../../tui/format.js";
import { copyTextToClipboardAsync } from "../../tui/clipboard.js";
import { useToast } from "../context/toast.js";

function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function ReaderRoute() {
  const theme = useTheme();
  const mailery = useMailery();
  const toast = useToast();
  const bodyLines = () => {
    const body = mailery.selectedBody();
    return body ? renderReadableBodyLines(body.text, body.html, 110, 180) : [];
  };
  const lineColor = (line: ReturnType<typeof renderReadableBodyLines>[number]) => {
    if (line.kind === "quote") return theme.markdownBlockQuote;
    if (line.kind === "muted") return theme.textMuted;
    if (line.links?.length) return theme.markdownLinkText;
    return theme.markdownText;
  };

  const copyLink = async (url: string) => {
    const result = await copyTextToClipboardAsync(url);
    toast.show({
      title: result.ok ? "Link copied" : "Copy failed",
      message: result.ok ? url : result.error ?? "Clipboard unavailable",
      tone: result.ok ? "success" : "error",
    });
  };

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background} paddingTop={1} paddingLeft={2} paddingRight={2}>
      <Show when={mailery.selectedBody()} fallback={<EmptyState title="No message selected" detail="Choose a message from the inbox." />}>
        {(body) => (
          <>
            <box height={5} flexDirection="column" rowGap={0}>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme.text} attributes={TextAttributes.BOLD}>{body().subject}</text>
                <Button label="Back" onPress={() => mailery.actions.backToList()} />
              </box>
              <text fg={theme.textMuted}>From: {body().from}</text>
              <text fg={theme.textMuted}>To: {body().to}</text>
              <text fg={theme.textMuted}>Date: {formatDate(body().date)}</text>
            </box>

            <Show when={body().attachments.length > 0}>
              <box
                height={Math.min(8, body().attachments.length + 4)}
                marginTop={1}
                marginBottom={1}
                paddingLeft={2}
                paddingRight={2}
                paddingTop={1}
                paddingBottom={1}
                backgroundColor={theme.backgroundElement}
                flexDirection="column"
              >
                <text fg={theme.text} attributes={TextAttributes.BOLD}>Attachments</text>
                <For each={body().attachments}>
                  {(attachment) => (
                    <text fg={theme.textMuted} wrapMode="word" width="100%">
                      {attachment.filename} - {attachment.content_type} - {formatAttachmentSize(attachment.size)}{attachment.location ? ` - ${attachment.location}` : ""}
                    </text>
                  )}
                </For>
              </box>
            </Show>

            <Show when={body().summary}>
              <box
                marginTop={1}
                marginBottom={1}
                paddingLeft={2}
                paddingRight={2}
                paddingTop={1}
                paddingBottom={1}
                backgroundColor={theme.backgroundElement}
              >
                <text fg={theme.markdownText} wrapMode="word" width="100%">{body().summary}</text>
              </box>
            </Show>

            <scrollbox flexGrow={1} width="100%" paddingTop={1}>
              <For each={mailery.conversation()}>
                {(entry) => (
                  <box flexDirection="column" marginBottom={1}>
                    <text fg={theme.textMuted}>
                      {entry.item.kind === "sent" ? "Sent" : "Received"} · {entry.body?.from ?? entry.item.from} · {formatDate(entry.body?.date ?? entry.item.at)}
                    </text>
                    <For each={renderReadableBodyLines(entry.body?.text, entry.body?.html, 110, 120)}>
                      {(line) => (
                        <text
                          fg={lineColor(line)}
                          wrapMode="word"
                          width="100%"
                          onMouseDown={(event: MouseEvent) => {
                            const link = line.links?.[0];
                            if (!link) return;
                            event.stopPropagation();
                            void copyLink(link.url);
                          }}
                        >
                          {line.text}
                        </text>
                      )}
                    </For>
                  </box>
                )}
              </For>
              <Show when={mailery.conversation().length === 0}>
                <For each={bodyLines()}>
                  {(line) => <text fg={lineColor(line)}>{line.text}</text>}
                </For>
              </Show>
            </scrollbox>

            <box height={2} flexDirection="row" columnGap={1}>
              <Button label="Reply" onPress={() => mailery.selectedMessage() && mailery.actions.startCompose("reply", mailery.selectedMessage()!)} />
              <Button label="Forward" onPress={() => mailery.selectedMessage() && mailery.actions.startCompose("forward", mailery.selectedMessage()!)} />
              <Button label="Links" onPress={() => mailery.actions.openDialog("links")} />
              <Button label="Label" onPress={() => mailery.actions.openDialog("labels")} />
            </box>
          </>
        )}
      </Show>
    </box>
  );
}
