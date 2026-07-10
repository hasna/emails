// Emails — native macOS shell hosting the bundled web UI in a WKWebView.
//
// A UI copycat of open-notes' "Hasna Notes" app, retargeted to email. This shell:
//   1. opens a hidden-titlebar window and loads web/index.html offline (file://),
//   2. tags the document with the `native` body class so the web UI drops its
//      desktop-frame chrome and fills the OS window edge-to-edge, and
//   3. bridges REAL mail data between the local Emails SQLite store (read via
//      EmailsCore.MailStore) and the web UI:
//        - reads the store at launch and injects
//          `window.__BOOT__ = { threads, folders, thisAddress }` as a document-start
//          user script (available before the page's JS runs),
//        - receives `{action, …}` messages on the `mail` message handler
//          (markRead / archive / star / label / reply / send / refresh /
//          shareAttachment), performs them via the `emails` CLI, then pushes fresh
//          data back into the page via `window.HasnaMail.hydrate(...)`.
//
// Design split (see EmailsCore): reads go straight to SQLite; writes ALWAYS go through
// the `emails` CLI so provider auth, inbound refresh, and threading headers stay correct.
import AppKit
import WebKit
import EmailsCore
import Foundation

// MARK: - JSON helpers

private func jsonString(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value) else {
        if let data = try? JSONSerialization.data(withJSONObject: [value], options: []),
           let s = String(data: data, encoding: .utf8) {
            return String(s.dropFirst().dropLast())
        }
        return "null"
    }
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: []),
          let s = String(data: data, encoding: .utf8) else {
        return "null"
    }
    return s
}

/// Bound very large bodies so the injected BOOT payload stays reasonable.
private func cap(_ s: String, _ max: Int) -> String {
    s.count <= max ? s : String(s.prefix(max))
}

private func attachmentJSON(_ a: MailAttachment) -> [String: Any] {
    ["filename": a.filename, "contentType": a.contentType, "size": a.size, "path": a.path]
}

private func messageJSON(_ m: MailMessage) -> [String: Any] {
    [
        "id": m.id,
        "source": m.source,
        "threadId": m.threadId,
        "messageId": m.messageId,
        "from": m.from,
        "to": m.to,
        "cc": m.cc,
        "subject": m.subject,
        "snippet": m.snippet,
        "textBody": cap(m.textBody, 200_000),
        "htmlBody": cap(m.htmlBody, 400_000),
        "date": m.date,
        "ts": m.ts,
        "isRead": m.isRead,
        "isStarred": m.isStarred,
        "isArchived": m.isArchived,
        "isSent": m.isSent,
        "isSpam": m.isSpam,
        "isTrash": m.isTrash,
        "labels": m.labels,
        "attachments": m.attachments.map(attachmentJSON),
    ]
}

private func threadJSON(_ t: MailThread) -> [String: Any] {
    [
        "id": t.id,
        "subject": t.subject,
        "participants": t.participants,
        "snippet": t.snippet,
        "date": t.date,
        "ts": t.ts,
        "unread": t.unread,
        "starred": t.starred,
        "hasAttachments": t.hasAttachments,
        "folders": [
            "inbox": t.inInbox,
            "sent": t.inSent,
            "archive": t.inArchive,
            "spam": t.inSpam,
            "trash": t.inTrash,
            "starred": t.starred,
        ],
        "messages": t.messages.map(messageJSON),
    ]
}

private func folderJSON(_ f: MailFolder) -> [String: Any] {
    ["id": f.id, "name": f.name, "count": f.count, "unread": f.unread]
}

// MARK: - Mail bridge

/// Owns the read-only store + the CLI bridge and the boot/hydrate/mutate round-trip.
final class MailBridge {
    let store = MailStore()

    /// The `{threads, folders, thisAddress}` boot payload as a JSON string.
    func bootJSON(limit: Int = 2000) -> String {
        let data = store.load(limit: limit)
        let payload: [String: Any] = [
            "threads": data.threads.map(threadJSON),
            "folders": data.folders.map(folderJSON),
            "thisAddress": data.thisAddress,
            "dbPath": store.dbPath.path,
            "dbExists": store.exists,
        ]
        return jsonString(payload)
    }

    // MARK: mutations (delegated to the emails CLI)

    private func str(_ d: [String: Any], _ k: String) -> String { (d[k] as? String) ?? "" }
    private func bool(_ d: [String: Any], _ k: String) -> Bool { (d[k] as? Bool) ?? false }
    private func list(_ d: [String: Any], _ k: String) -> [String] {
        if let a = d[k] as? [String] { return a.filter { !$0.isEmpty } }
        if let s = d[k] as? String, !s.isEmpty {
            return s.split(whereSeparator: { $0 == "," || $0 == " " || $0 == ";" }).map(String.init)
        }
        return []
    }

    /// Translate a JS payload into the `emails` CLI argv. Pure + main-thread; returns nil
    /// for an unknown action. The argv ([String]) is Sendable, so it can cross to the
    /// background queue where the CLI actually runs (avoids capturing the non-Sendable
    /// payload dictionary in a @Sendable closure under Swift 6).
    func argv(for payload: [String: Any]) -> [String]? {
        let action = str(payload, "action")
        let id = str(payload, "id")
        switch action {
        case "markRead": return EmailsCLI.markReadArgs(id: id, unread: bool(payload, "unread"))
        case "archive":  return EmailsCLI.archiveArgs(id: id, undo: bool(payload, "undo"))
        case "star":     return EmailsCLI.starArgs(id: id, undo: bool(payload, "undo"))
        case "label":    return EmailsCLI.labelArgs(id: id, label: str(payload, "label"), remove: bool(payload, "remove"))
        case "trash":    return EmailsCLI.labelArgs(id: id, label: "trash", remove: bool(payload, "undo"))
        case "spam":     return EmailsCLI.labelArgs(id: id, label: "spam", remove: bool(payload, "undo"))
        case "reply":    return EmailsCLI.replyArgs(id: id, body: str(payload, "body"), html: bool(payload, "html"))
        case "send":
            let from = str(payload, "from")
            return EmailsCLI.sendArgs(
                to: list(payload, "to"), subject: str(payload, "subject"),
                body: str(payload, "body"), cc: list(payload, "cc"), bcc: list(payload, "bcc"),
                from: from.isEmpty ? nil : from, html: bool(payload, "html"))
        case "refresh":  return EmailsCLI.refreshArgs()
        default:         return nil
        }
    }
}

// MARK: - external tool runner (attachments)

/// Resolve + run an arbitrary hasna CLI (used for the `attachments` evidence/share flow).
enum ToolRunner {
    static func resolve(_ name: String) -> (String, [String])? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = ["\(home)/.bun/bin/\(name)", "/opt/homebrew/bin/\(name)",
                          "/usr/local/bin/\(name)", "/usr/bin/\(name)"]
        for p in candidates where FileManager.default.isExecutableFile(atPath: p) { return (p, []) }
        if FileManager.default.isExecutableFile(atPath: "/usr/bin/env") { return ("/usr/bin/env", [name]) }
        return nil
    }

    @discardableResult
    static func run(_ name: String, _ args: [String]) -> (ok: Bool, output: String) {
        guard let (launch, prefix) = resolve(name) else { return (false, "\(name) not found") }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: launch)
        proc.arguments = prefix + args
        let out = Pipe(), err = Pipe()
        proc.standardOutput = out; proc.standardError = err
        do { try proc.run(); proc.waitUntilExit() }
        catch { return (false, "failed to launch \(name): \(error.localizedDescription)") }
        let o = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let e = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (proc.terminationStatus == 0, o + e)
    }
}

// MARK: - Weak message-handler proxy (leak-safety)

final class WeakScriptProxy: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}

// MARK: - Window drag strip

/// Transparent strip pinned to the top of the window so the hidden-titlebar window can be
/// dragged (a WKWebView swallows mouse drags). Mirrors open-notes.
final class WindowDragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { bounds.contains(point) ? self : nil }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    let bridge = MailBridge()
    private let mailHandlerName = "mail"
    private let windowHandlerName = "window"

    // Compact / quick-compose window mode state.
    private var savedFrame: NSRect?
    private var savedLevel: NSWindow.Level = .normal
    private var savedCollectionBehavior: NSWindow.CollectionBehavior = []
    private var savedMinSize: NSSize = NSSize(width: 920, height: 640)
    private var isCompact = false

    func applicationDidFinishLaunching(_ note: Notification) {
        let frame = NSRect(x: 0, y: 0, width: 1280, height: 820)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Emails"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.backgroundColor = .white
        window.minSize = NSSize(width: 920, height: 640)
        window.center()

        let cfg = WKWebViewConfiguration()

        // 1. Inject the `native` class as early as possible (avoid a flash of the
        //    desktop-frame layout), and again on DOMContentLoaded for certainty.
        let nativeJS = """
        document.documentElement.classList.add('native');
        document.addEventListener('DOMContentLoaded', function () {
          document.body.classList.add('native');
        }, { once: true });
        """
        cfg.userContentController.addUserScript(
            WKUserScript(source: nativeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        // 2. Inject REAL mail data as `window.__BOOT__` BEFORE the page's JS runs, so
        //    app.js renders from disk on first paint (no sample fallback in the app).
        let boot = bridge.bootJSON()
        let bootJS = "window.__BOOT__ = \(boot);"
        cfg.userContentController.addUserScript(
            WKUserScript(source: bootJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        // 3. Register the `mail` + `window` message handlers via a WEAK proxy so the
        //    controller→handler retain does not leak the web view.
        cfg.userContentController.add(WeakScriptProxy(self), name: mailHandlerName)
        cfg.userContentController.add(WeakScriptProxy(self), name: windowHandlerName)

        web = WKWebView(frame: frame, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self

        let container = NSView(frame: frame)
        container.autoresizingMask = [.width, .height]
        web.frame = container.bounds
        container.addSubview(web)
        let dragStrip = WindowDragStrip(frame: NSRect(x: 0, y: frame.height - 30, width: frame.width, height: 30))
        dragStrip.identifier = NSUserInterfaceItemIdentifier("window-drag-strip")
        dragStrip.autoresizingMask = [.width, .minYMargin]
        container.addSubview(dragStrip)
        window.contentView = container

        guard let webDir = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true) else {
            NSLog("Emails: resourceURL is nil — cannot locate bundled web UI")
            return
        }
        let index = webDir.appendingPathComponent("index.html")
        NSLog("Emails: loading \(index.path) exists=\(FileManager.default.fileExists(atPath: index.path))")
        NSLog("Emails: boot payload bytes=\(boot.utf8.count)")
        web.loadFileURL(index, allowingReadAccessTo: webDir)

        buildMenu()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        NSLog("Emails: didFinish navigation")
        webView.evaluateJavaScript("document.body && document.body.classList.add('native')", completionHandler: nil)
        // Diagnostic: count how many thread rows the page rendered. Proves REAL mail
        // (not the browser sample) reached the DOM.
        webView.evaluateJavaScript("document.querySelectorAll('.thread-row').length") { result, _ in
            let count = (result as? Int) ?? (result as? NSNumber)?.intValue ?? -1
            NSLog("Emails: rendered \(count) thread rows")
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("Emails: didFail navigation: \(error.localizedDescription)")
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("Emails: didFailProvisionalNavigation: \(error.localizedDescription)")
    }

    // MARK: bridge (JS → Swift)

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let payload = message.body as? [String: Any],
              let action = payload["action"] as? String else { return }

        // The `window` handler controls native window state (compact / quick-compose).
        if message.name == windowHandlerName {
            if action == "setCompact" {
                let on = (payload["on"] as? Bool) ?? false
                DispatchQueue.main.async { [weak self] in self?.setCompact(on) }
            }
            return
        }

        guard message.name == mailHandlerName else { return }

        // The attachments evidence/share flow shells out to the `attachments` CLI.
        if action == "shareAttachment" {
            let path = (payload["path"] as? String) ?? ""
            let requestId = (payload["requestId"] as? String) ?? ""
            DispatchQueue.global(qos: .userInitiated).async {
                let res = ToolRunner.run("attachments", ["upload", path])
                let url = EmailsApp.firstURL(in: res.output)
                let reply = jsonString(["requestId": requestId, "ok": res.ok, "url": url, "output": res.output])
                DispatchQueue.main.async { [weak self] in
                    self?.web.evaluateJavaScript("window.HasnaMail && window.HasnaMail.attachmentShared(\(reply))", completionHandler: nil)
                }
            }
            return
        }

        // Destructive guard mirrors open-notes (trash/spam require confirmation).
        let destructive = ["trash", "spam"].contains(action)
        if destructive, (payload["confirmed"] as? Bool) != true, (payload["undo"] as? Bool) != true {
            NSLog("Emails: ignored unconfirmed destructive action '\(action)'")
            return
        }

        // Build the CLI argv on the main thread (the payload dict is not Sendable). Only the
        // Sendable [String] argv + plain strings cross to the background queue, where a fresh
        // CLI + store do the work (the CLI may hit the network for send/reply/refresh).
        guard let args = bridge.argv(for: payload) else {
            NSLog("Emails: unknown action '\(action)'")
            return
        }
        let requestId = (payload["requestId"] as? String) ?? ""
        let actionName = action
        DispatchQueue.global(qos: .userInitiated).async {
            let result = EmailsCLI().run(args)
            let fresh = MailBridge().bootJSON()
            let ack = jsonString(["requestId": requestId, "action": actionName,
                                  "ok": result.ok, "message": result.output])
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.web.evaluateJavaScript("window.HasnaMail && window.HasnaMail.hydrate(\(fresh))", completionHandler: nil)
                self.web.evaluateJavaScript("window.HasnaMail && window.HasnaMail.actionResult && window.HasnaMail.actionResult(\(ack))", completionHandler: nil)
            }
        }
    }

    // MARK: compact / quick-compose window mode

    private func setCompact(_ on: Bool) {
        guard let window = window else { return }
        if on {
            guard !isCompact else { return }
            savedFrame = window.frame
            savedLevel = window.level
            savedCollectionBehavior = window.collectionBehavior
            isCompact = true
            let size = NSSize(width: 420, height: 300)
            savedMinSize = window.minSize
            window.minSize = size
            let screen = window.screen ?? NSScreen.main
            var origin = NSPoint(x: 200, y: 200)
            if let vf = screen?.visibleFrame {
                origin = NSPoint(x: vf.maxX - size.width - 24, y: vf.maxY - size.height - 24)
            }
            window.level = .floating
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            window.setFrame(NSRect(origin: origin, size: size), display: true, animate: true)
            window.makeKeyAndOrderFront(nil)
        } else {
            guard isCompact else { return }
            isCompact = false
            window.level = savedLevel
            window.collectionBehavior = savedCollectionBehavior
            window.minSize = savedMinSize
            if let f = savedFrame { window.setFrame(f, display: true, animate: true) }
            window.makeKeyAndOrderFront(nil)
        }
    }

    // MARK: teardown

    func applicationWillTerminate(_ notification: Notification) {
        web?.configuration.userContentController.removeScriptMessageHandler(forName: mailHandlerName)
        web?.configuration.userContentController.removeScriptMessageHandler(forName: windowHandlerName)
        web?.evaluateJavaScript("window.HasnaMail && window.HasnaMail.destroy && window.HasnaMail.destroy()", completionHandler: nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    private func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Hide Emails", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Emails", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let winItem = NSMenuItem()
        main.addItem(winItem)
        let winMenu = NSMenu(title: "Window")
        winMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        winItem.submenu = winMenu
        NSApp.mainMenu = main
    }
}

enum EmailsApp {
    /// Extract the first http(s) URL from CLI output (used to surface the attachment link).
    static func firstURL(in text: String) -> String {
        guard let range = text.range(of: "https?://[^\\s\"']+", options: .regularExpression) else { return "" }
        return String(text[range])
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
