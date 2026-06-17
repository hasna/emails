import { TextAttributes, type MouseEvent } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { useTheme, selectedForeground } from "../context/theme.js";

export function Button(props: {
  label: string;
  tone?: "neutral" | "primary" | "danger" | "warning";
  active?: boolean;
  width?: number | "auto" | `${number}%`;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const bg = () => {
    if (props.active) return theme.primary;
    if (props.tone === "primary") return theme.primary;
    if (props.tone === "danger") return theme.error;
    if (props.tone === "warning") return theme.warning;
    return theme.backgroundElement;
  };
  const foreground = () => {
    if (props.active || props.tone === "primary" || props.tone === "danger" || props.tone === "warning") {
      return selectedForeground(theme, bg());
    }
    return theme.text;
  };
  return (
    <box
      width={props.width}
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={bg()}
      onMouseUp={(event: MouseEvent) => {
        event.stopPropagation();
        props.onPress?.();
      }}
    >
      <text fg={foreground()}>{props.label}</text>
    </box>
  );
}

export function SectionHeader(props: { label: string; muted?: string; onPress?: () => void }) {
  const theme = useTheme();
  return (
    <box
      height={1}
      paddingLeft={1}
      marginTop={1}
      marginBottom={0}
      onMouseUp={(event: MouseEvent) => {
        event.stopPropagation();
        props.onPress?.();
      }}
    >
      <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
        {props.label}
        {props.muted ? `  ${props.muted}` : ""}
      </text>
    </box>
  );
}

export function Row(props: {
  active?: boolean;
  height?: number;
  onPress?: () => void;
  children: JSX.Element;
}) {
  const theme = useTheme();
  return (
    <box
      height={props.height ?? 1}
      width="100%"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.active ? theme.primary : undefined}
      onMouseUp={(event: MouseEvent) => {
        event.stopPropagation();
        props.onPress?.();
      }}
    >
      {props.children}
    </box>
  );
}

export function EmptyState(props: { title: string; detail?: string }) {
  const theme = useTheme();
  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={2} rowGap={1}>
      <text fg={theme.text}>{props.title}</text>
      {props.detail ? <text fg={theme.textMuted}>{props.detail}</text> : null}
    </box>
  );
}
