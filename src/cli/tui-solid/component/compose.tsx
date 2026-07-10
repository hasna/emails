import { Show } from "solid-js";
import { TextAttributes, type TextareaRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { useEmails } from "../context/emails-state.js";
import { useTheme } from "../context/theme.js";
import { Button } from "../ui/primitives.js";
import { useToast } from "../context/toast.js";

export function ComposeWindow() {
  const emails = useEmails();
  const theme = useTheme();
  const toast = useToast();
  const dimensions = useTerminalDimensions();
  let bodyInput: (TextareaRenderable & { plainText?: string }) | undefined;

  useKeyboard((key) => {
    if (!emails.state.compose) return;
    if (key.name === "escape") {
      emails.actions.closeCompose();
      return;
    }
    if (key.name === "tab") {
      emails.actions.cycleComposeField(key.shift ? -1 : 1);
    }
  });

  const send = async () => {
    try {
      await emails.actions.sendCompose();
      toast.show({ title: "Sent", message: "Message sent successfully.", tone: "success" });
    } catch (error) {
      toast.show({ title: "Send failed", message: error instanceof Error ? error.message : String(error), tone: "error" });
    }
  };

  return (
    <Show when={emails.state.compose}>
      {(compose) => (
        <box
          position="absolute"
          zIndex={2500}
          right={2}
          bottom={1}
          width={Math.min(92, Math.max(48, dimensions().width - 6))}
          height={Math.min(20, Math.max(12, dimensions().height - 5))}
          backgroundColor={theme.backgroundMenu}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          flexDirection="column"
          rowGap={1}
        >
          <box height={1} flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {compose().mode === "reply" ? "Reply" : compose().mode === "forward" ? "Forward" : "Compose"}
            </text>
            <Button label="Close" onPress={() => emails.actions.closeCompose()} />
          </box>
          <input
            focused={compose().field === "from"}
            value={compose().from}
            placeholder="From"
            backgroundColor={compose().field === "from" ? theme.backgroundActive : theme.backgroundElement}
            textColor={theme.text}
            focusedTextColor={theme.text}
            focusedBackgroundColor={theme.backgroundActive}
            placeholderColor={theme.textMuted}
            cursorColor={theme.text}
            width="100%"
            onInput={(value) => emails.actions.patchCompose({ from: value, field: "from" })}
          />
          <input
            focused={compose().field === "to"}
            value={compose().to}
            placeholder="To"
            backgroundColor={compose().field === "to" ? theme.backgroundActive : theme.backgroundElement}
            textColor={theme.text}
            focusedTextColor={theme.text}
            focusedBackgroundColor={theme.backgroundActive}
            placeholderColor={theme.textMuted}
            cursorColor={theme.text}
            width="100%"
            onInput={(value) => emails.actions.patchCompose({ to: value, field: "to" })}
          />
          <input
            focused={compose().field === "subject"}
            value={compose().subject}
            placeholder="Subject"
            backgroundColor={compose().field === "subject" ? theme.backgroundActive : theme.backgroundElement}
            textColor={theme.text}
            focusedTextColor={theme.text}
            focusedBackgroundColor={theme.backgroundActive}
            placeholderColor={theme.textMuted}
            cursorColor={theme.text}
            width="100%"
            onInput={(value) => emails.actions.patchCompose({ subject: value, field: "subject" })}
          />
          <textarea
            ref={(node) => {
              bodyInput = node as TextareaRenderable & { plainText?: string };
            }}
            focused={compose().field === "body"}
            initialValue={compose().body}
            placeholder="Write in Markdown"
            backgroundColor={compose().field === "body" ? theme.backgroundActive : theme.backgroundElement}
            textColor={theme.text}
            focusedTextColor={theme.text}
            focusedBackgroundColor={theme.backgroundActive}
            placeholderColor={theme.textMuted}
            cursorColor={theme.text}
            height="100%"
            width="100%"
            onContentChange={() => {
              emails.actions.patchCompose({ body: bodyInput?.plainText ?? "", field: "body" });
            }}
          />
          <box height={1} flexDirection="row" columnGap={1}>
            <Button label="Send" active onPress={() => void send()} />
            <Button label="Discard" onPress={() => emails.actions.closeCompose()} />
            <text fg={theme.textMuted}>Markdown enabled</text>
          </box>
        </box>
      )}
    </Show>
  );
}
