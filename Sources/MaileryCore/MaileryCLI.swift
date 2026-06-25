import Foundation

// MARK: - Mailery CLI bridge (mutations)
//
// Design split: MaileryCore READS the SQLite store directly (fast, no shell-out), but
// every MUTATION (send / reply / mark-read / archive / star / label / refresh) is
// delegated to the `mailery` CLI. The CLI owns provider auth, Gmail mirroring, threading
// headers, and write-path invariants — re-implementing those in Swift would drift from
// the source of truth and risk corrupting the shared DB. So the app never writes to
// emails.db itself; it shells out.
//
// The argv builders are pure + static so MailerySmoke can assert the exact command line
// without spawning a process.

public struct MaileryCLI: Sendable {

    public struct Result: Sendable {
        public let ok: Bool
        public let output: String
        public init(ok: Bool, output: String) { self.ok = ok; self.output = output }
    }

    public init() {}

    // MARK: argv builders (pure, testable)

    public static func markReadArgs(id: String, unread: Bool) -> [String] {
        var a = ["inbox", "mark-read", id]
        if unread { a.append("--unread") }
        return a
    }

    public static func archiveArgs(id: String, undo: Bool) -> [String] {
        var a = ["inbox", "archive", id]
        if undo { a.append("--undo") }
        return a
    }

    public static func starArgs(id: String, undo: Bool) -> [String] {
        var a = ["inbox", "star", id]
        if undo { a.append("--undo") }
        return a
    }

    public static func labelArgs(id: String, label: String, remove: Bool) -> [String] {
        var a = ["inbox", "label", id, label]
        if remove { a.append("--remove") }
        return a
    }

    public static func replyArgs(id: String, body: String, html: Bool) -> [String] {
        var a = ["inbox", "reply", id, "--body", body]
        if html { a.append("--html") }
        return a
    }

    public static func sendArgs(
        to: [String], subject: String, body: String,
        cc: [String] = [], bcc: [String] = [], from: String? = nil, html: Bool = false
    ) -> [String] {
        var a = ["send"]
        if let from, !from.isEmpty { a += ["--from", from] }
        if !to.isEmpty { a.append("--to"); a += to }   // --to takes a variadic list
        a += ["--subject", subject, "--body", body]
        if !cc.isEmpty { a.append("--cc"); a += cc }
        if !bcc.isEmpty { a.append("--bcc"); a += bcc }
        if html { a.append("--html") }
        return a
    }

    public static func refreshArgs() -> [String] { ["refresh"] }

    // MARK: process runner

    /// Resolve the `mailery` binary. Prefer absolute candidates, then fall back to
    /// launching via `/usr/bin/env mailery` so a PATH install still works.
    static func resolveBinary() -> (launchPath: String, prefixArgs: [String])? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/.bun/bin/mailery",
            "/opt/homebrew/bin/mailery",
            "/usr/local/bin/mailery",
            "/usr/bin/mailery",
        ]
        for p in candidates where FileManager.default.isExecutableFile(atPath: p) {
            return (p, [])
        }
        // Fall back to env-resolution via PATH.
        if FileManager.default.isExecutableFile(atPath: "/usr/bin/env") {
            return ("/usr/bin/env", ["mailery"])
        }
        return nil
    }

    /// Run `mailery <args>` synchronously. Returns ok=false (never throws) if the binary
    /// is missing or the process exits non-zero, so the caller can surface a toast.
    @discardableResult
    public func run(_ args: [String]) -> Result {
        guard let (launchPath, prefix) = MaileryCLI.resolveBinary() else {
            return Result(ok: false, output: "mailery CLI not found")
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: launchPath)
        proc.arguments = prefix + args
        let out = Pipe(), err = Pipe()
        proc.standardOutput = out
        proc.standardError = err
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            return Result(ok: false, output: "failed to launch mailery: \(error.localizedDescription)")
        }
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        let errData = err.fileHandleForReading.readDataToEndOfFile()
        let combined = (String(data: outData, encoding: .utf8) ?? "")
            + (String(data: errData, encoding: .utf8) ?? "")
        return Result(ok: proc.terminationStatus == 0, output: combined)
    }
}
