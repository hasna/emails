import Foundation
import SQLite3

// MARK: - Read-only mail store
//
// EmailsCore reads the local Emails SQLite database directly (READ-ONLY). This is the
// fast path that powers the boot payload + every refresh: it never writes (all writes go
// through `EmailsCLI`). Tables used:
//   - inbound_emails  : received + synced-sent messages (the rows `emails inbox` mutates)
//   - emails          : the outbound send log
//   - email_content   : html/text bodies for the outbound log
//   - addresses       : to resolve `thisAddress`
//
// SQLite3 is provided as a system module on macOS, so `import SQLite3` needs no extra
// package dependency.

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

public struct MailData: Sendable {
    public let threads: [MailThread]
    public let folders: [MailFolder]
    public let thisAddress: String
}

public final class MailStore: @unchecked Sendable {
    public let dbPath: URL

    /// Default DB location: `~/.hasna/emails/emails.db`.
    public init(path: URL? = nil) {
        if let path {
            self.dbPath = path
        } else {
            self.dbPath = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".hasna/emails/emails.db")
        }
    }

    public var exists: Bool { FileManager.default.fileExists(atPath: dbPath.path) }

    // MARK: public API

    /// Build the full `{threads, folders, thisAddress}` view. Never throws — a missing or
    /// broken DB yields empty threads (the UI falls back gracefully).
    public func load(limit: Int = 4000) -> MailData {
        let messages = loadMessages(limit: limit)
        let threads = MailStore.buildThreads(messages)
        let folders = MailStore.buildFolders(threads)
        return MailData(threads: threads, folders: folders, thisAddress: resolveThisAddress())
    }

    /// Read raw messages from inbound_emails + the outbound emails log (deduped).
    public func loadMessages(limit: Int = 4000) -> [MailMessage] {
        guard exists else { return [] }
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            sqlite3_close(db)
            return []
        }
        defer { sqlite3_close(db) }

        var messages = MailStore.readInbound(db: db, limit: limit)
        let seen = Set(messages.compactMap { $0.messageId.isEmpty ? nil : $0.messageId.lowercased() })
        let sent = MailStore.readSentLog(db: db, limit: limit, excludingMessageIds: seen)
        messages.append(contentsOf: sent)
        return messages
    }

    // MARK: inbound_emails

    private static func readInbound(db: OpaquePointer?, limit: Int) -> [MailMessage] {
        let sql = """
        SELECT id, from_address, to_addresses, cc_addresses, subject,
               COALESCE(text_body,''), COALESCE(html_body,''),
               COALESCE(attachments_json,'[]'), COALESCE(attachment_paths,'[]'),
               received_at, COALESCE(thread_id,''), COALESCE(provider_thread_id,''),
               COALESCE(message_id,''), COALESCE(label_ids_json,'[]'),
               is_read, is_archived, is_starred, is_sent, is_spam, is_trash
        FROM inbound_emails
        ORDER BY received_at DESC
        LIMIT ?
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int(stmt, 1, Int32(limit))

        var out: [MailMessage] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = text(stmt, 0)
            let from = text(stmt, 1)
            let to = parseAddressList(text(stmt, 2))
            let cc = parseAddressList(text(stmt, 3))
            let subject = text(stmt, 4)
            let textBody = text(stmt, 5)
            let htmlBody = text(stmt, 6)
            let attachments = parseAttachments(json: text(stmt, 7), paths: text(stmt, 8))
            let received = text(stmt, 9)
            let threadId = text(stmt, 10)
            let providerThread = text(stmt, 11)
            let messageId = text(stmt, 12)
            let labels = parseStringArray(text(stmt, 13))
            let isRead = int(stmt, 14) != 0
            let isArchived = int(stmt, 15) != 0
            let isStarred = int(stmt, 16) != 0
            let isSent = int(stmt, 17) != 0
            let isSpam = int(stmt, 18) != 0
            let isTrash = int(stmt, 19) != 0

            let key = threadKey(threadId: threadId, providerThread: providerThread,
                                messageId: messageId, id: id)
            out.append(MailMessage(
                id: id, source: "inbound", threadId: key, messageId: messageId,
                from: from, to: to, cc: cc, subject: subject,
                snippet: makeSnippet(text: textBody, html: htmlBody),
                textBody: textBody, htmlBody: htmlBody,
                date: received, ts: parseTs(received),
                isRead: isRead, isStarred: isStarred, isArchived: isArchived,
                isSent: isSent, isSpam: isSpam, isTrash: isTrash,
                labels: labels, attachments: attachments
            ))
        }
        return out
    }

    // MARK: emails (outbound log) + email_content

    private static func readSentLog(db: OpaquePointer?, limit: Int,
                                    excludingMessageIds seen: Set<String>) -> [MailMessage] {
        let sql = """
        SELECT e.id, e.from_address, e.to_addresses, e.cc_addresses, e.subject,
               e.sent_at, COALESCE(e.thread_id,''), COALESCE(e.message_id,''),
               COALESCE(c.text_body,''), COALESCE(c.html,''), e.has_attachments
        FROM emails e
        LEFT JOIN email_content c ON c.email_id = e.id
        ORDER BY e.sent_at DESC
        LIMIT ?
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int(stmt, 1, Int32(limit))

        var out: [MailMessage] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = text(stmt, 0)
            let from = text(stmt, 1)
            let to = parseAddressList(text(stmt, 2))
            let cc = parseAddressList(text(stmt, 3))
            let subject = text(stmt, 4)
            let sentAt = text(stmt, 5)
            let threadId = text(stmt, 6)
            let messageId = text(stmt, 7)
            let textBody = text(stmt, 8)
            let htmlBody = text(stmt, 9)
            let hasAttachments = int(stmt, 10) != 0

            if !messageId.isEmpty, seen.contains(messageId.lowercased()) { continue }

            let key = threadKey(threadId: threadId, providerThread: "",
                                messageId: messageId, id: id)
            out.append(MailMessage(
                id: id, source: "sent", threadId: key, messageId: messageId,
                from: from, to: to, cc: cc, subject: subject,
                snippet: makeSnippet(text: textBody, html: htmlBody),
                textBody: textBody, htmlBody: htmlBody,
                date: sentAt, ts: parseTs(sentAt),
                isRead: true, isStarred: false, isArchived: false,
                isSent: true, isSpam: false, isTrash: false,
                labels: [],
                attachments: hasAttachments ? [MailAttachment(filename: "attachment")] : []
            ))
        }
        return out
    }

    // MARK: thisAddress

    public func resolveThisAddress() -> String {
        if let env = ProcessInfo.processInfo.environment["EMAILS_ADDRESS"], !env.isEmpty {
            return env
        }
        guard exists else { return "andrei@hasna.com" }
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            sqlite3_close(db); return "andrei@hasna.com"
        }
        defer { sqlite3_close(db) }
        let sql = "SELECT email FROM addresses ORDER BY verified DESC, datetime(updated_at) DESC LIMIT 1"
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            defer { sqlite3_finalize(stmt) }
            if sqlite3_step(stmt) == SQLITE_ROW {
                let email = MailStore.text(stmt, 0)
                if !email.isEmpty { return email }
            }
        }
        return "andrei@hasna.com"
    }

    // MARK: thread + folder assembly (pure, testable)

    public static func buildThreads(_ messages: [MailMessage]) -> [MailThread] {
        var groups: [String: [MailMessage]] = [:]
        var order: [String] = []
        for m in messages {
            if groups[m.threadId] == nil { order.append(m.threadId) }
            groups[m.threadId, default: []].append(m)
        }
        let threads = order.map { MailThread(id: $0, messages: groups[$0] ?? []) }
        return threads.sorted { $0.ts > $1.ts }
    }

    public static func buildFolders(_ threads: [MailThread]) -> [MailFolder] {
        let inbox = threads.filter { $0.inInbox }
        return [
            MailFolder(id: "inbox", name: "Inbox",
                       count: inbox.count,
                       unread: inbox.filter { $0.unread > 0 }.count),
            MailFolder(id: "starred", name: "Starred",
                       count: threads.filter { $0.starred && !$0.inTrash }.count),
            MailFolder(id: "sent", name: "Sent",
                       count: threads.filter { $0.inSent }.count),
            MailFolder(id: "archive", name: "Archive",
                       count: threads.filter { $0.inArchive }.count),
            MailFolder(id: "spam", name: "Spam",
                       count: threads.filter { $0.inSpam }.count),
            MailFolder(id: "trash", name: "Trash",
                       count: threads.filter { $0.inTrash }.count),
        ]
    }

    // MARK: helpers

    public static func threadKey(threadId: String, providerThread: String,
                          messageId: String, id: String) -> String {
        if !threadId.isEmpty { return threadId }
        if !providerThread.isEmpty { return providerThread }
        if !messageId.isEmpty { return "msg:" + messageId }
        return "id:" + id
    }

    static func text(_ stmt: OpaquePointer?, _ i: Int32) -> String {
        guard let c = sqlite3_column_text(stmt, i) else { return "" }
        return String(cString: c)
    }
    static func int(_ stmt: OpaquePointer?, _ i: Int32) -> Int {
        Int(sqlite3_column_int64(stmt, i))
    }

    /// Parse a JSON array of addresses. Elements may be plain strings ("a@b.com" or
    /// "Name <a@b.com>") or objects ({name,address}). Returns display strings.
    public static func parseAddressList(_ raw: String) -> [String] {
        guard let data = raw.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }
        var out: [String] = []
        for el in arr {
            if let s = el as? String {
                let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { out.append(t) }
            } else if let d = el as? [String: Any] {
                let addr = (d["address"] as? String) ?? (d["email"] as? String) ?? ""
                let name = (d["name"] as? String) ?? ""
                if !addr.isEmpty {
                    out.append(name.isEmpty ? addr : "\(name) <\(addr)>")
                }
            }
        }
        return out
    }

    static func parseStringArray(_ raw: String) -> [String] {
        guard let data = raw.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }
        return arr.compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    static func parseAttachments(json: String, paths: String) -> [MailAttachment] {
        let pathList = parseStringArray(paths)
        guard let data = json.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [Any] else {
            // No structured metadata — fall back to bare paths.
            return pathList.map { p in
                MailAttachment(filename: (p as NSString).lastPathComponent, path: p)
            }
        }
        var out: [MailAttachment] = []
        for (idx, el) in arr.enumerated() {
            guard let d = el as? [String: Any] else { continue }
            let filename = (d["filename"] as? String) ?? (d["name"] as? String) ?? "attachment"
            let ctype = (d["contentType"] as? String) ?? (d["content_type"] as? String)
                ?? (d["type"] as? String) ?? ""
            let size = (d["size"] as? Int) ?? (d["size"] as? NSNumber)?.intValue ?? 0
            let path = (d["path"] as? String) ?? (idx < pathList.count ? pathList[idx] : "")
            out.append(MailAttachment(filename: filename, contentType: ctype, size: size, path: path))
        }
        if out.isEmpty {
            return pathList.map { MailAttachment(filename: ($0 as NSString).lastPathComponent, path: $0) }
        }
        return out
    }

    static func stripHTML(_ html: String) -> String {
        html.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    public static func makeSnippet(text: String, html: String) -> String {
        var s = text.isEmpty ? stripHTML(html) : text
        s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return String(s.prefix(160))
    }

    /// Parse a timestamp into epoch milliseconds. Handles ISO8601 (with/without
    /// fractional seconds) and the SQLite `datetime('now')` format ("YYYY-MM-DD HH:MM:SS").
    public static func parseTs(_ s: String) -> Double {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return 0 }
        let isoFrac = ISO8601DateFormatter()
        isoFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = isoFrac.date(from: trimmed) { return d.timeIntervalSince1970 * 1000 }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: trimmed) { return d.timeIntervalSince1970 * 1000 }
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = TimeZone(identifier: "UTC")
        for pattern in ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd"] {
            fmt.dateFormat = pattern
            if let d = fmt.date(from: trimmed) { return d.timeIntervalSince1970 * 1000 }
        }
        return 0
    }
}
