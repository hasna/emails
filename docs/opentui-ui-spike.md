# OpenTUI UI Implementation

Date: 2026-06-04

## Scope

`emails ui` has moved from Ink to OpenTUI. The command now creates an
OpenTUI `CliRenderer`, renders through `@opentui/react`, and keeps OpenTUI
core/react packages external in the Bun bundle so native runtime package
resolution works correctly.

The implemented UI covers:

- Home
- Inbox
- Address picker
- Reader
- Compose
- Profiles
- Settings

## Current OpenTUI Facts

- OpenTUI is a native terminal UI core written in Zig with TypeScript bindings.
- OpenTUI is currently Bun-exclusive; Node and Deno support are still in progress.
- The UI uses `@opentui/core` and `@opentui/react` at `0.3.2`.
- React is pinned to `19.2.0` to satisfy the OpenTUI React peer dependency.
- OpenTUI detects terminal theme mode; `emails ui` uses that for the persisted
  `auto` theme setting and falls back to local terminal environment hints.

References:

- https://opentui.com/
- https://opentui.com/docs/getting-started/
- https://opentui.com/docs/bindings/react/
- https://opentui.com/docs/core-concepts/renderer/

## Implementation Notes

- `src/cli/commands/ui.tsx` owns renderer creation, terminal title setup, and
  shutdown waiting.
- `src/cli/tui/App.tsx` owns OpenTUI keyboard handling, theme detection,
  terminal background control, and renderable layout.
- `src/cli/tui/data.ts` remains the DB-backed data layer for mailbox lists,
  counts, address choices, profiles, settings, compose send, and mutations.
- `src/cli/tui/theme.ts` now exposes hex palettes for OpenTUI `fg`/`bg` colors.
- `src/cli/tui/App.test.ts` uses `@opentui/react/test-utils` and OpenTUI mock
  keyboard input instead of `ink-testing-library`.

## UX Model

- Startup without `--mailbox` opens Home, not Inbox.
- Inbox is a unified all-address view by default.
- Press `a` in Inbox to choose an exact email address.
- The Inbox surface does not show provider/domain/source groupings.
- Compose has editable From, To, Subject, and Body fields.
- Settings can cycle auto-pull, Gmail auto-pull, dim-read, default folder,
  default inbox address, default From, and theme mode.

## Verification

Focused verification should include:

```bash
bun run build
bun test src/cli/tui
bun dist/cli/index.js ui --help
bun dist/cli/index.js interactive
```

`interactive` should remain an unknown command; this internal app intentionally
uses `emails ui` only.
