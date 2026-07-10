// swift-tools-version:6.0
import PackageDescription

// Emails - native macOS desktop app for the Emails client.
//
// This Swift package lives ALONGSIDE the `@hasna/emails` TypeScript CLI in the same
// repo. It is a UI copycat of open-notes' "Hasna Notes" app: a WKWebView shell
// hosting an offline web UI (`web/`) and bridging real mail data from the local
// Emails SQLite store (`~/.hasna/emails/emails.db`).
//
// Internal legacy Swift target names retained for this patch:
//   - MaileryCore  : reads inbound_emails/email_content/emails directly (read-only) and
//                    builds the CLI argv used to mutate mail (send/reply/mark-read/…).
//   - MaileryApp   : the WKWebView host (AppKit) — injects __BOOT__, bridges `mail`.
//   - MailerySmoke : CLI smoke harness (TDD) — XCTest/swift-testing are unavailable
//                    under Command Line Tools, so this is the verification harness.
let package = Package(
    name: "Emails",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "MaileryCore", targets: ["MaileryCore"]),
    ],
    targets: [
        .target(
            name: "MaileryCore",
            path: "Sources/MaileryCore"
        ),
        // CLI smoke test for the mail store + CLI argv builder. Used as the verification
        // harness because XCTest / swift-testing are unavailable under Command Line Tools.
        .executableTarget(
            name: "MailerySmoke",
            dependencies: ["MaileryCore"],
            path: "Sources/MailerySmoke"
        ),
        // Native macOS shell (WKWebView) hosting the bundled web UI. Depends on
        // the internal legacy MaileryCore target so it can read the on-disk SQLite mail store and bridge real mail
        // data into the web UI.
        .executableTarget(
            name: "MaileryApp",
            dependencies: ["MaileryCore"],
            path: "Sources/MaileryApp"
        ),
    ]
)
