# OpenTUI UI implementation

Status: shipped as `emails ui`. The original React spike has been replaced by
Solid/OpenTUI; this page describes the current tree.

## Runtime and build

The command module at `src/cli/commands/ui.tsx` stays lightweight and loads a
separate UI runtime. Source runs through `src/cli/tui/runtime.tsx`; packaged
builds prefer `dist/cli/ui-runtime-bundle.js`, produced by
`scripts/build-tui-runtime.ts`.

The current UI stack is:

- `@opentui/core` 0.4.1;
- `@opentui/solid` 0.4.1;
- `@opentui/keymap` 0.4.1;
- `solid-js` 1.9.13.

The dedicated bundle uses the OpenTUI Solid transform and keeps native
platform packages external. The main CLI bundle also keeps packages external,
so the native OpenTUI library is resolved for the machine running the command.
The renderer uses an alternate screen, mouse input, Kitty keyboard support,
60 FPS targeting, and explicit signal cleanup.

## Source layout

- `src/cli/tui-solid/App.tsx` composes providers, sidebar, mailbox/reader
  routes, compose window, dialogs, toasts, and renderer cleanup.
- `src/cli/tui-solid/component/` contains the sidebar, mailbox, reader,
  composer, and dialogs.
- `src/cli/tui-solid/context/` owns state, commands, keymaps, themes, dialogs,
  and toasts.
- `src/cli/tui/data.ts` routes the shared data API to local or self-hosted
  implementations; formatting, clipboard handling, auto-pull, and settings
  remain under `src/cli/tui/`.

There is no `src/cli/tui/App.tsx` compatibility component and no
`@opentui/react` dependency in the current implementation.

## Current UX

`emails ui` requires stdin and stdout to be TTYs. It opens the saved mailbox,
or the mailbox selected by `--mailbox`; the default is Inbox. The layout has a
persistent mailbox/sidebar region and a workspace for mailbox lists, reader,
and domains. It supports address and source selection, search/filter/grouping,
labels and categories, digests, attachment/link/raw dialogs, compose/reply/
forward, settings, light/dark/auto themes, background refresh, and both local
and self-hosted mail data sources.

Valid startup mailbox values are `inbox`, `unread`, `starred`, `sent`,
`archived`, `spam`, and `trash`. For a non-interactive workflow use the commands
suggested by the refusal: `emails inbox list`, `emails inbox read <id>`, and
`emails send`.

## Verification

```bash
bun run build
bun test src/cli/tui
bun dist/cli/index.js ui --help
```

`interactive` is not a command; the terminal application is exposed only as
`emails ui`.
