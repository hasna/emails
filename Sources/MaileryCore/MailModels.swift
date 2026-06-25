import Foundation

// MARK: - Mail value types
//
// The web UI consumes a `{threads, folders, thisAddress}` boot payload. These value
// types model a single inbound/sent message and the thread it belongs to. They are
// deliberately plain (no DB handles) so they can be built in MaileryCore, unit-tested
// in MailerySmoke, and JSON-encoded by the app shell.

public struct MailAttachment: Sendable, Equatable {
    public var filename: String
    public var contentType: String
    public var size: Int
    public var path: String

    public init(filename: String, contentType: String = "", size: Int = 0, path: String = "") {
        self.filename = filename
        self.contentType = contentType
        self.size = size
        self.path = path
    }
}

public struct MailMessage: Sendable, Equatable {
    /// The row id. For `inbound` messages this is the `inbound_emails.id` that the
    /// `mailery inbox …` CLI mutates. For `sent` messages (from the outbound `emails`
    /// log) this is `emails.id` and is read-only in the UI.
    public var id: String
    public var source: String          // "inbound" | "sent"
    public var threadId: String
    public var messageId: String
    public var from: String
    public var to: [String]
    public var cc: [String]
    public var subject: String
    public var snippet: String
    public var textBody: String
    public var htmlBody: String
    public var date: String            // raw received/sent timestamp (as stored)
    public var ts: Double              // epoch millis for sorting (0 if unparseable)
    public var isRead: Bool
    public var isStarred: Bool
    public var isArchived: Bool
    public var isSent: Bool
    public var isSpam: Bool
    public var isTrash: Bool
    public var labels: [String]
    public var attachments: [MailAttachment]

    public init(
        id: String, source: String = "inbound", threadId: String = "", messageId: String = "",
        from: String = "", to: [String] = [], cc: [String] = [], subject: String = "",
        snippet: String = "", textBody: String = "", htmlBody: String = "",
        date: String = "", ts: Double = 0,
        isRead: Bool = false, isStarred: Bool = false, isArchived: Bool = false,
        isSent: Bool = false, isSpam: Bool = false, isTrash: Bool = false,
        labels: [String] = [], attachments: [MailAttachment] = []
    ) {
        self.id = id; self.source = source; self.threadId = threadId; self.messageId = messageId
        self.from = from; self.to = to; self.cc = cc; self.subject = subject
        self.snippet = snippet; self.textBody = textBody; self.htmlBody = htmlBody
        self.date = date; self.ts = ts
        self.isRead = isRead; self.isStarred = isStarred; self.isArchived = isArchived
        self.isSent = isSent; self.isSpam = isSpam; self.isTrash = isTrash
        self.labels = labels; self.attachments = attachments
    }
}

public struct MailThread: Sendable, Equatable {
    public var id: String
    public var subject: String
    public var participants: [String]
    public var snippet: String
    public var date: String
    public var ts: Double
    public var unread: Int
    public var starred: Bool
    public var hasAttachments: Bool
    public var messages: [MailMessage]
    // Folder membership (a thread shows in a folder if ANY of its messages qualifies).
    public var inInbox: Bool
    public var inSent: Bool
    public var inArchive: Bool
    public var inSpam: Bool
    public var inTrash: Bool

    public init(id: String, messages: [MailMessage]) {
        let sorted = messages.sorted { $0.ts < $1.ts }
        self.id = id
        self.messages = sorted
        let latest = sorted.last
        // Subject: first non-empty subject, falling back to the latest message's.
        self.subject = sorted.first(where: { !$0.subject.isEmpty })?.subject
            ?? latest?.subject ?? "(no subject)"
        self.snippet = latest?.snippet ?? ""
        self.date = latest?.date ?? ""
        self.ts = latest?.ts ?? 0
        self.unread = sorted.filter { !$0.isRead && !$0.isSent && !$0.isTrash }.count
        self.starred = sorted.contains { $0.isStarred }
        self.hasAttachments = sorted.contains { !$0.attachments.isEmpty }
        // Build an ordered, de-duplicated participant list (from + to across messages).
        var seen = Set<String>()
        var people: [String] = []
        for m in sorted {
            for addr in ([m.from] + m.to) {
                let key = MailThread.canonical(addr)
                if !key.isEmpty, !seen.contains(key) {
                    seen.insert(key); people.append(addr)
                }
            }
        }
        self.participants = people
        self.inInbox   = sorted.contains { !$0.isSent && !$0.isArchived && !$0.isSpam && !$0.isTrash }
        self.inSent    = sorted.contains { $0.isSent && !$0.isTrash }
        self.inArchive = sorted.contains { $0.isArchived && !$0.isSpam && !$0.isTrash }
        self.inSpam    = sorted.contains { $0.isSpam && !$0.isTrash }
        self.inTrash   = sorted.contains { $0.isTrash }
    }

    /// Lower-cased bare email used for participant de-duplication. Extracts the address
    /// out of a "Display Name <email>" form when present.
    public static func canonical(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let lt = trimmed.firstIndex(of: "<"), let gt = trimmed.firstIndex(of: ">"), lt < gt {
            return String(trimmed[trimmed.index(after: lt)..<gt]).lowercased()
        }
        return trimmed.lowercased()
    }
}

public struct MailFolder: Sendable, Equatable {
    public var id: String       // inbox|starred|sent|archive|spam|trash
    public var name: String
    public var count: Int       // number of threads in the folder
    public var unread: Int      // unread thread count (meaningful for inbox)

    public init(id: String, name: String, count: Int, unread: Int = 0) {
        self.id = id; self.name = name; self.count = count; self.unread = unread
    }
}
