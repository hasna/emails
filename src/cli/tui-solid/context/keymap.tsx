import { onCleanup, onMount } from "solid-js";
import { useKeymap } from "@opentui/keymap/solid";
import type { KeyEvent, Renderable } from "@opentui/core";
import type { Layer } from "@opentui/keymap";

export function useStaticBindings(createLayer: () => Layer<Renderable, KeyEvent>): void {
  const keymap = useKeymap();
  let dispose: (() => void) | undefined;
  onMount(() => {
    const layer = createLayer();
    dispose = keymap.registerLayer({
      ...layer,
      bindings: layer.bindings?.map((binding) => ({ ...binding, preventDefault: false })),
    });
  });
  onCleanup(() => dispose?.());
}
