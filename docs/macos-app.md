# macOS desktop app

Status: **not shipped and not buildable from the current repository**.

The package currently ships the `emails`, `emails-mcp`, and `emails-serve`
bins, the OpenTUI client (`emails ui`), and the browser dashboard served by
`emails serve`. It does not contain a Swift package or native desktop-app
source: `Package.swift`, `Sources/`, and the former native app's `web/` assets
are absent.

`scripts/build_emails_app.sh` and `scripts/run_on_apple_mac.sh` are legacy
helpers left from the removed prototype. They still expect those absent files,
so they fail and must not be treated as a supported build or release path. The
scripts are not included in the published package.

On macOS, use the supported interfaces instead:

```bash
emails ui
emails serve
open http://127.0.0.1:3900
```

Any future native app must restore its complete source, tests, packaging, and
release contract before this page can describe it as available.
