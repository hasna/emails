# Mailery — macOS desktop app

Mailery ships a native macOS desktop app alongside the `@hasna/emails` CLI. It is a UI
copycat of [open-notes](https://github.com/hasna/notes)' "Hasna Notes" app, retargeted to
email: a thin AppKit **WKWebView shell** hosting an offline web UI, bridging real mail
from the local Mailery SQLite store.

It lives in the SAME repo as the CLI:

```
Package.swift                 swift-tools 6.0, platforms [.macOS("26.0")]
Sources/MaileryCore/          read the SQLite store + build the mutation CLI argv
Sources/MaileryApp/           the WKWebView host (AppKit) — injects __BOOT__, bridges `mail`
Sources/MailerySmoke/         CLI smoke harness (TDD; XCTest is unavailable under CLT)
web/                          the 3-pane mail UI (index.html / styles.css / app.js)
scripts/build_mailery_app.sh  build + assemble dist/Mailery.app (run on a Mac)
scripts/run_on_apple_mac.sh   rsync to a Mac, run the smoke test, then build there
```

## Architecture — the read/write split (key decision)

Mailery deliberately splits reads from writes:

- **Reads go straight to SQLite (read-only).** `MaileryCore.MailStore` opens
  `~/.hasna/emails/emails.db` with `SQLITE_OPEN_READONLY` and reads `inbound_emails`
  (received + synced-sent), plus the outbound `emails` log joined with `email_content`.
  This is the fast path that powers the boot payload and every refresh. The app **never
  writes to the database itself.**
- **Writes ALWAYS go through the `mailery` CLI.** Every mutation — send, reply, mark-read,
  archive, star, label, trash/spam, refresh — is delegated to the `emails inbox …` /
  `emails send` / `emails refresh` commands. The CLI owns provider auth,
  inbound refresh, threading headers (In-Reply-To/References), and write-path invariants;
  re-implementing those in Swift would drift from the source of truth and risk corrupting
  the shared DB. `MaileryCore.MaileryCLI` builds the exact argv (pure + unit-tested) and
  shells out.

This mirrors open-notes' shell/bridge structure (WKWebView + `__BOOT__` + a message
handler) while swapping the Markdown-file store for the email SQLite store and the
direct-disk writes for CLI-delegated mutations.

### The bridge contract

| Notes (reference) | Mailery |
|-------------------|---------|
| message handler `notes` | message handler **`mail`** |
| `window.HasnaNotes` | **`window.HasnaMail`** |
| `__BOOT__ = {notes, machines, thisMachine}` | **`__BOOT__ = {threads, folders, thisAddress}`** |

At launch the shell injects `window.__BOOT__` as a document-start user script, so `app.js`
renders from disk on first paint (no sample fallback in the app). The web posts
`{action, …}` messages to `window.webkit.messageHandlers.mail`; the shell runs the
matching CLI command on a background thread and pushes fresh data back via
`window.HasnaMail.hydrate(...)` plus an `actionResult(...)` ack.

`app.js` is **dual-mode**: in a plain browser (screenshots/dev) there is no bridge, so it
falls back to `sampleBoot()` and applies mutations optimistically in-memory only.

#### Actions the web can post on `mail`

`markRead {id, unread?}` · `archive {id, undo?}` · `star {id, undo?}` ·
`label {id, label, remove?}` · `trash {id, confirmed}` · `spam {id, confirmed}` ·
`reply {id, body, html?}` · `send {to[], cc[], subject, body, from, html?}` · `refresh {}` ·
`shareAttachment {path, requestId}` (→ `attachments upload`).

## Persistence

App-level UI state belongs under `~/.hasna/apps/mailery/` (e.g. theme is currently in
`localStorage`). The mail data itself is **not** owned by the app — it lives in the shared
`~/.hasna/emails/emails.db` and is managed by the `mailery` CLI.

## HTML email rendering

Message HTML is isolated in a **sandboxed `<iframe>`** (`sandbox="allow-same-origin
allow-popups"`, no `allow-scripts`) so the email's own scripts never run; the parent sizes
it to its content. Plain-text bodies render in a `<pre>`-like block. Remote images in HTML
mail will load — acceptable for a personal client.

## Build & run

Build on a **macOS 26** Mac (Command Line Tools, no Xcode required):

```bash
# On the Mac, from the repo root:
swift run -c release MailerySmoke      # TDD harness — must print "SMOKE OK"
bash scripts/build_mailery_app.sh      # assembles dist/Mailery.app (bundle id com.hasna.mailery)
open dist/Mailery.app
```

From spark01/spark02, do it remotely in one shot:

```bash
REMOTE_HOST=apple03 bash scripts/run_on_apple_mac.sh
```

### Verifying

The local inbox may be **empty** — pull mail first, then launch:

```bash
emails refresh          # pull new inbound mail into emails.db (S3 buckets and realtime queue)
emails inbox list       # sanity-check there is data
open dist/Mailery.app
# Confirm render via the app's NSLog diagnostics:
log show --last 2m --predicate 'eventMessage CONTAINS "Mailery:"' --info
#   → "Mailery: rendered N thread rows"
```

A send goes through `emails send` (same argv the app builds):

```bash
emails send --from andrei@hasna.com --to andrei@hasna.com \
  --subject "Mailery test" --body "round-trip"
```

### apple03 host-key gotcha

`ssh apple03` can fail with a host-key verification error after the Mac is reinstalled or
its key rotates (the run script shells out over SSH and will abort). If so, refresh the
known-hosts entry on the calling machine before re-running:

```bash
ssh-keygen -R apple03            # drop the stale key
ssh apple03 true                 # re-accept the new key once
REMOTE_HOST=apple03 bash scripts/run_on_apple_mac.sh
```

The macOS hosts also answer on the `remote-apple03` SSH alias when the bare name won't
resolve off-LAN (see `~/.claude/rules/workspace.md`).

## Distribution / evidence

The built bundle is uploaded as build evidence with the `attachments` CLI:

```bash
ditto -c -k --keepParent dist/Mailery.app dist/Mailery.app.zip
attachments upload dist/Mailery.app.zip
```

The in-app **Share** action on an attachment calls `attachments upload <path>` and copies
the returned link to the clipboard.
