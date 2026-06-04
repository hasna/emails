# OpenTUI UI Spike

Date: 2026-06-04

## Scope

Evaluate whether `emails ui` should move from Ink to OpenTUI after the UI was
simplified to:

- Home
- Inbox
- Compose
- Profiles
- Settings

The target OpenTUI reproduction would cover home selection, Inbox rows, address
picker, reader scrolling, and compose fields.

## Current OpenTUI Facts

- OpenTUI is a native terminal UI core written in Zig with TypeScript bindings.
- OpenTUI is currently Bun-exclusive; Node and Deno support are still in progress.
- First-party packages expose React support.
- Core components include layout, text, input, select, scrollbox, keyboard
  handling, and focus support.
- Current npm versions checked on 2026-06-04:
  - `@opentui/core`: `0.3.1`
  - `@opentui/react`: `0.3.1`

References:

- https://opentui.com/
- https://opentui.com/docs/getting-started/
- https://opentui.com/docs/plugins/react/

## Prototype Mapping

The simplified `emails ui` can map cleanly to OpenTUI:

- Home: `Select` rows for Inbox, Compose, Profiles, Settings.
- Inbox: `Box` header plus a selectable message list.
- Address picker: `Select` rows for All addresses and exact addresses.
- Reader: `ScrollBox` for message body and attachment metadata.
- Compose: input fields for From, To, Subject, and body.
- Footer/status: a fixed bottom `Box` with compact key hints.

No data-layer changes would be required. The existing `listMailbox`,
`mailboxCounts`, `listInboxAddresses`, `sendComposed`, and message mutation
helpers can be reused.

## Dependency Impact

Adding OpenTUI would add at least:

- `@opentui/core`
- `@opentui/react`
- native runtime artifacts through OpenTUI's Zig core

The package already targets Bun, so Bun-only support is acceptable for this
repo. The bigger cost is not runtime compatibility; it is replacing the current
Ink tests and validating terminal cleanup, focus, input handling, and rendering
across local machines.

## Recommendation

Do not migrate to OpenTUI now.

The major issue was product structure, not terminal rendering capacity:

- The app started directly in Inbox.
- Inbox exposed provider/domain/source concepts.
- Address selection was not the user-facing model.

Those issues are now addressed in Ink by the home screen, address-only Inbox
filtering, and exact address data-layer support. Migrating immediately would add
dependency and test churn without a clear user-facing gain.

## When To Revisit

Reconsider OpenTUI if any of these remain true after dogfooding the simplified
Ink UI:

- Large Inbox scrolling is still visibly slow.
- Input focus or compose editing remains unreliable.
- Background refresh still causes terminal rendering stalls.
- We need richer widgets that Ink cannot support cleanly.

## Migration Estimate

If migration becomes justified:

- 0.5 day: build a disposable OpenTUI prototype with static fixtures.
- 1 day: port data wiring and view transitions.
- 1 day: port compose, reader, address picker, and settings.
- 1 day: replace Ink tests with OpenTUI-specific render/input tests or a thin
  state-machine harness.
- 0.5 day: terminal cleanup, packaging, smoke tests across local machines.

Estimated total: 3.5 to 5 engineering days.
