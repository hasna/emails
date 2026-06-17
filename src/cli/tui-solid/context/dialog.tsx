import { Show, createContext, createSignal, useContext, type Accessor, type JSX, type ParentProps } from "solid-js";
import { RGBA, type MouseEvent } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { useTheme } from "./theme.js";
import { useStaticBindings } from "./keymap.js";

export type DialogSize = "medium" | "large" | "xlarge";

export interface DialogEntry {
  id: number;
  size: DialogSize;
  element: () => JSX.Element;
  onClose?: () => void;
}

function createDialogStore() {
  const [stack, setStack] = createSignal<DialogEntry[]>([]);
  let nextId = 1;
  return {
    stack,
    get current() {
      return stack().at(-1) ?? null;
    },
    push(element: () => JSX.Element, options?: { size?: DialogSize; onClose?: () => void }) {
      setStack((items) => [...items, { id: nextId++, element, size: options?.size ?? "medium", onClose: options?.onClose }]);
    },
    replace(element: () => JSX.Element, options?: { size?: DialogSize; onClose?: () => void }) {
      for (const item of stack()) item.onClose?.();
      setStack([{ id: nextId++, element, size: options?.size ?? "medium", onClose: options?.onClose }]);
    },
    pop() {
      const current = stack().at(-1);
      current?.onClose?.();
      setStack((items) => items.slice(0, -1));
      return !!current;
    },
    clear() {
      for (const item of stack()) item.onClose?.();
      setStack([]);
    },
  };
}

type DialogContextValue = ReturnType<typeof createDialogStore>;
const DialogContext = createContext<DialogContextValue>();

export function DialogProvider(props: ParentProps) {
  const dialog = createDialogStore();
  return <DialogContext.Provider value={dialog}>{props.children}</DialogContext.Provider>;
}

export function useDialog(): DialogContextValue {
  const dialog = useContext(DialogContext);
  if (!dialog) throw new Error("useDialog must be used within DialogProvider");
  return dialog;
}

function widthFor(size: DialogSize, terminalWidth: number): number {
  const target = size === "xlarge" ? 116 : size === "large" ? 88 : 60;
  return Math.max(36, Math.min(target, terminalWidth - 2));
}

export function DialogViewport() {
  const dialog = useDialog();
  const theme = useTheme();
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  let selectionDrag = false;

  useStaticBindings(() => ({
    priority: 300,
    bindings: [
      {
        key: "escape",
        desc: "Close dialog",
        group: "Dialog",
        cmd: () => {
          if (dialog.stack().length === 0) return;
          if (renderer.getSelection()) renderer.clearSelection();
          else dialog.pop();
        },
      },
      {
        key: "ctrl+c",
        desc: "Close dialog",
        group: "Dialog",
        cmd: () => {
          if (dialog.stack().length === 0) return;
          if (renderer.getSelection()) renderer.clearSelection();
          else dialog.pop();
        },
      },
    ],
  }));

  const current: Accessor<DialogEntry | null> = () => dialog.current;
  return (
    <Show when={current()}>
      {(entry) => (
        <box
          position="absolute"
          zIndex={3000}
          left={0}
          top={0}
          width={dimensions().width}
          height={dimensions().height}
          alignItems="center"
          paddingTop={Math.floor(dimensions().height / 4)}
          backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
          onMouseDown={() => {
            selectionDrag = !!renderer.getSelection();
          }}
          onMouseUp={() => {
            if (selectionDrag) {
              selectionDrag = false;
              return;
            }
            dialog.pop();
          }}
        >
          <box
            width={widthFor(entry().size, dimensions().width)}
            maxHeight={Math.max(8, dimensions().height - 4)}
            backgroundColor={theme.backgroundMenu}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
            onMouseUp={(event: MouseEvent) => {
              selectionDrag = false;
              event.stopPropagation();
            }}
          >
            {entry().element()}
          </box>
        </box>
      )}
    </Show>
  );
}
