import { Show, createContext, onCleanup, useContext, type ParentProps } from "solid-js";
import { createStore } from "solid-js/store";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { useTheme } from "./theme.js";
import { SplitBorder } from "../ui/border.js";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastInput {
  title?: string;
  message: string;
  tone?: ToastTone;
  duration?: number;
}

function createToastStore() {
  const [state, setState] = createStore<{ current: (ToastInput & { id: number; tone: ToastTone }) | null }>({ current: null });
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    setState("current", null);
  };

  onCleanup(clear);

  return {
    get current() {
      return state.current;
    },
    show(input: ToastInput) {
      if (timer) clearTimeout(timer);
      setState("current", {
        ...input,
        id: Date.now(),
        tone: input.tone ?? "info",
      });
      timer = setTimeout(clear, input.duration ?? 5200);
      timer.unref?.();
    },
    clear,
  };
}

type ToastContextValue = ReturnType<typeof createToastStore>;
const ToastContext = createContext<ToastContextValue>();

export function ToastProvider(props: ParentProps) {
  const toast = createToastStore();
  return <ToastContext.Provider value={toast}>{props.children}</ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast must be used within ToastProvider");
  return toast;
}

export function ToastViewport() {
  const toast = useToast();
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const toneColor = () => {
    const current = toast.current;
    if (!current) return theme.info;
    if (current.tone === "success") return theme.success;
    if (current.tone === "warning") return theme.warning;
    if (current.tone === "error") return theme.error;
    return theme.info;
  };

  return (
    <Show when={toast.current}>
      {(current) => (
        <box
          position="absolute"
          top={1}
          right={2}
          zIndex={4000}
          width={Math.min(60, Math.max(20, dimensions().width - 6))}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          backgroundColor={theme.backgroundMenu}
          borderColor={toneColor()}
          border={SplitBorder.border}
          customBorderChars={SplitBorder.customBorderChars}
          flexDirection="column"
          rowGap={1}
        >
          {current().title ? (
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {current().title}
            </text>
          ) : null}
          <text fg={theme.text} wrapMode="word" width="100%">
            {current().message}
          </text>
        </box>
      )}
    </Show>
  );
}
