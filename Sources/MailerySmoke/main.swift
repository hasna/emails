import Foundation
import SQLite3
import MaileryCore

// CLI smoke test for the Mailery mail store + CLI argv builder. Exits 0 on success, 1 on
// failure. Used as the verification harness because XCTest / swift-testing are unavailable
// under macOS Command Line Tools (no Xcode). Mirrors open-notes' OpenNotesSmoke.

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

final class Counter { var failures = 0 }
let counter = Counter()

@MainActor
func check(_ condition: Bool, _ message: String) {
    if condition {
        print("  ok: \(message)")
    } else {
        print("  FAIL: \(message)")
        counter.failures += 1
    }
}

// MARK: - tiny SQLite fixture helpers

@MainActor
func exec(_ db: OpaquePointer?, _ sql: String) {
    var err: UnsafeMutablePointer<CChar>?
    if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
        let msg = err.map { String(cString: $0) } ?? "?"
        print("  FAIL: exec error: \(msg) for \(sql.prefix(60))")
        counter.failures += 1
    }
    if let err { sqlite3_free(err) }
}

/// Insert via a prepared statement so values with special chars are safe.
@MainActor
func insert(_ db: OpaquePointer?, _ sql: String, _ values: [Any]) {
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
        print("  FAIL: prepare insert failed: \(String(cString: sqlite3_errmsg(db)))")
        counter.failures += 1
        return
    }
    defer { sqlite3_finalize(stmt) }
    for (i, v) in values.enumerated() {
        let idx = Int32(i + 1)
        switch v {
        case let s as String: sqlite3_bind_text(stmt, idx, s, -1, SQLITE_TRANSIENT)
        case let n as Int:    sqlite3_bind_int64(stmt, idx, Int64(n))
        default:              sqlite3_bind_null(stmt, idx)
        }
    }
    if sqlite3_step(stmt) != SQLITE_DONE {
        print("  FAIL: step insert failed: \(String(cString: sqlite3_errmsg(db)))")
        counter.failures += 1
    }
}

// MARK: - build a fixture DB

let tempDB = FileManager.default.temporaryDirectory
    .appendingPathComponent("mailery-smoke-\(UUID().uuidString).db")
defer { try? FileManager.default.removeItem(at: tempDB) }

var db: OpaquePointer?
guard sqlite3_open(tempDB.path, &db) == SQLITE_OK else {
    print("FATAL: cannot open temp DB")
    exit(1)
}

exec(db, """
CREATE TABLE inbound_emails (
  id TEXT PRIMARY KEY, from_address TEXT, to_addresses TEXT, cc_addresses TEXT,
  subject TEXT, text_body TEXT, html_body TEXT, attachments_json TEXT,
  attachment_paths TEXT, received_at TEXT, thread_id TEXT, provider_thread_id TEXT,
  message_id TEXT, label_ids_json TEXT,
  is_read INTEGER, is_archived INTEGER, is_starred INTEGER,
  is_sent INTEGER, is_spam INTEGER, is_trash INTEGER
);
""")
exec(db, """
CREATE TABLE emails (
  id TEXT PRIMARY KEY, from_address TEXT, to_addresses TEXT, cc_addresses TEXT,
  subject TEXT, sent_at TEXT, thread_id TEXT, message_id TEXT, has_attachments INTEGER
);
""")
exec(db, "CREATE TABLE email_content (email_id TEXT PRIMARY KEY, html TEXT, text_body TEXT);")
exec(db, "CREATE TABLE addresses (id TEXT PRIMARY KEY, email TEXT, verified INTEGER, updated_at TEXT);")

let inboundSQL = """
INSERT INTO inbound_emails
(id, from_address, to_addresses, cc_addresses, subject, text_body, html_body,
 attachments_json, attachment_paths, received_at, thread_id, provider_thread_id,
 message_id, label_ids_json, is_read, is_archived, is_starred, is_sent, is_spam, is_trash)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
"""

// Thread A: received (unread) + a sent reply.
insert(db, inboundSQL, ["a1", "Alice <alice@ex.com>", #"["andrei@hasna.com"]"#, "[]",
    "Hello", "first message body", "", "[]", "[]", "2026-06-20T10:00:00Z", "tA", "",
    "m1", "[]", 0, 0, 0, 0, 0, 0])
insert(db, inboundSQL, ["a2", "andrei@hasna.com", #"["alice@ex.com"]"#, "[]",
    "Re: Hello", "my reply", "", "[]", "[]", "2026-06-20T11:00:00Z", "tA", "",
    "m2", "[]", 1, 0, 0, 1, 0, 0])
// Thread B: archived.
insert(db, inboundSQL, ["b1", "Bob <bob@ex.com>", #"["andrei@hasna.com"]"#, "[]",
    "Archived", "archived body", "", "[]", "[]", "2026-06-19T09:00:00Z", "tB", "",
    "m3", "[]", 1, 1, 0, 0, 0, 0])
// Thread C: trashed.
insert(db, inboundSQL, ["c1", "spammer@x.com", #"["andrei@hasna.com"]"#, "[]",
    "Trashy", "trash body", "", "[]", "[]", "2026-06-18T09:00:00Z", "tC", "",
    "m4", "[]", 1, 0, 0, 0, 0, 1])
// Thread D: starred (unread) with an attachment.
insert(db, inboundSQL, ["d1", "Carol <carol@ex.com>", #"["andrei@hasna.com"]"#, "[]",
    "Starred", "starred body", "",
    #"[{"filename":"file.pdf","contentType":"application/pdf","size":1234}]"#, "[]",
    "2026-06-21T08:00:00Z", "tD", "", "m5", "[]", 0, 0, 1, 0, 0, 0])

// Outbound log: one genuinely outbound-only (m6), and one that duplicates inbound m2.
let emailsSQL = "INSERT INTO emails (id, from_address, to_addresses, cc_addresses, subject, sent_at, thread_id, message_id, has_attachments) VALUES (?,?,?,?,?,?,?,?,?)"
insert(db, emailsSQL, ["e1", "andrei@hasna.com", #"["dave@ex.com"]"#, "[]",
    "Outbound only", "2026-06-22T07:00:00Z", "tE", "m6", 0])
insert(db, emailsSQL, ["e2", "andrei@hasna.com", #"["alice@ex.com"]"#, "[]",
    "Re: Hello", "2026-06-20T11:00:00Z", "tA", "m2", 0])
insert(db, "INSERT INTO email_content (email_id, html, text_body) VALUES (?,?,?)",
    ["e1", "", "outbound body"])

insert(db, "INSERT INTO addresses (id, email, verified, updated_at) VALUES (?,?,?,?)",
    ["addr1", "andrei@hasna.com", 1, "2026-06-01T00:00:00Z"])

sqlite3_close(db)

// MARK: - exercise MaileryCore

let store = MailStore(path: tempDB)

print("== store exists & loads ==")
check(store.exists, "fixture DB exists")
let data = store.load()

print("== message read + dedup ==")
let messages = store.loadMessages()
check(messages.count == 6, "5 inbound + 1 outbound-only (m2 deduped) = 6 messages (got \(messages.count))")
check(!messages.contains { $0.source == "sent" && $0.messageId == "m2" }, "duplicate outbound m2 excluded")
check(messages.contains { $0.source == "sent" && $0.messageId == "m6" }, "outbound-only m6 included")

print("== thread assembly ==")
check(data.threads.count == 5, "5 threads (got \(data.threads.count))")
check(data.threads.first?.id == "tE", "newest thread (tE, 06-22) sorts first (got \(data.threads.first?.id ?? "nil"))")
let tA = data.threads.first { $0.id == "tA" }
check(tA?.messages.count == 2, "thread A has 2 messages")
check(tA?.subject == "Hello", "thread A subject is the first non-empty subject 'Hello' (got \(tA?.subject ?? "nil"))")
check(tA?.unread == 1, "thread A has 1 unread (the received message)")
check(tA?.messages.first?.id == "a1", "thread A messages sorted oldest-first (a1 then a2)")
check((tA?.participants.count ?? 0) >= 2, "thread A has >=2 participants")
let tD = data.threads.first { $0.id == "tD" }
check(tD?.hasAttachments == true, "thread D has attachments")
check(tD?.messages.first?.attachments.first?.filename == "file.pdf", "attachment filename parsed")
check(tD?.starred == true, "thread D is starred")

print("== folder counts ==")
func folder(_ id: String) -> MailFolder? { data.folders.first { $0.id == id } }
check(folder("inbox")?.count == 2, "inbox has 2 threads (tA, tD) (got \(folder("inbox")?.count ?? -1))")
check(folder("inbox")?.unread == 2, "inbox unread = 2 (got \(folder("inbox")?.unread ?? -1))")
check(folder("starred")?.count == 1, "starred has 1 thread")
check(folder("sent")?.count == 2, "sent has 2 threads (tA reply + tE) (got \(folder("sent")?.count ?? -1))")
check(folder("archive")?.count == 1, "archive has 1 thread")
check(folder("spam")?.count == 0, "spam empty")
check(folder("trash")?.count == 1, "trash has 1 thread")

print("== thisAddress ==")
check(data.thisAddress == "andrei@hasna.com", "thisAddress resolved from addresses table")

print("== empty / missing DB is graceful ==")
let missing = MailStore(path: FileManager.default.temporaryDirectory.appendingPathComponent("nope-\(UUID().uuidString).db"))
check(!missing.exists, "missing DB reported absent")
let emptyData = missing.load()
check(emptyData.threads.isEmpty, "missing DB yields no threads")
check(emptyData.folders.count == 6, "folders list always present (6 folders)")
check(emptyData.thisAddress == "andrei@hasna.com", "missing DB falls back to canonical mailbox")

// MARK: - CLI argv builders (pure)

print("== CLI argv builders ==")
check(MaileryCLI.markReadArgs(id: "x", unread: false) == ["inbox", "mark-read", "x"], "mark-read argv")
check(MaileryCLI.markReadArgs(id: "x", unread: true) == ["inbox", "mark-read", "x", "--unread"], "mark-unread argv")
check(MaileryCLI.archiveArgs(id: "x", undo: false) == ["inbox", "archive", "x"], "archive argv")
check(MaileryCLI.archiveArgs(id: "x", undo: true) == ["inbox", "archive", "x", "--undo"], "unarchive argv")
check(MaileryCLI.starArgs(id: "x", undo: false) == ["inbox", "star", "x"], "star argv")
check(MaileryCLI.starArgs(id: "x", undo: true) == ["inbox", "star", "x", "--undo"], "unstar argv")
check(MaileryCLI.labelArgs(id: "x", label: "work", remove: false) == ["inbox", "label", "x", "work"], "label argv")
check(MaileryCLI.labelArgs(id: "x", label: "work", remove: true) == ["inbox", "label", "x", "work", "--remove"], "label remove argv")
check(MaileryCLI.replyArgs(id: "x", body: "hi there", html: false) == ["inbox", "reply", "x", "--body", "hi there"], "reply argv")
check(MaileryCLI.replyArgs(id: "x", body: "hi", html: true) == ["inbox", "reply", "x", "--body", "hi", "--html"], "reply html argv")
check(MaileryCLI.refreshArgs() == ["refresh"], "refresh argv")
check(
    MaileryCLI.sendArgs(to: ["a@b.com", "c@d.com"], subject: "Hi", body: "yo",
                        cc: ["e@f.com"], from: "me@x.com", html: false)
    == ["send", "--from", "me@x.com", "--to", "a@b.com", "c@d.com", "--subject", "Hi", "--body", "yo", "--cc", "e@f.com"],
    "send argv with from/to/cc"
)
check(
    MaileryCLI.sendArgs(to: ["a@b.com"], subject: "S", body: "B", html: true)
    == ["send", "--to", "a@b.com", "--subject", "S", "--body", "B", "--html"],
    "send argv minimal + html"
)

// MARK: - pure helpers

print("== helpers ==")
check(MailThread.canonical("Alice <alice@ex.com>") == "alice@ex.com", "canonical extracts bare email from display form")
check(MailThread.canonical("BOB@EX.COM") == "bob@ex.com", "canonical lowercases")
check(MailStore.threadKey(threadId: "", providerThread: "", messageId: "m", id: "i") == "msg:m", "threadKey falls back to message id")
check(MailStore.threadKey(threadId: "", providerThread: "", messageId: "", id: "i") == "id:i", "threadKey falls back to row id")
check(MailStore.threadKey(threadId: "T", providerThread: "P", messageId: "m", id: "i") == "T", "threadKey prefers thread_id")
check(MailStore.parseAddressList(#"["a@b.com","Name <c@d.com>"]"#) == ["a@b.com", "Name <c@d.com>"], "parseAddressList parses string array")
check(MailStore.parseAddressList(#"[{"name":"X","address":"x@y.com"}]"#) == ["X <x@y.com>"], "parseAddressList parses object array")
check(MailStore.parseTs("2026-06-20T10:00:00Z") > 0, "ISO8601 timestamp parses")
check(MailStore.parseTs("2026-06-20 10:00:00") > 0, "SQLite datetime format parses")
check(MailStore.parseTs("garbage") == 0, "unparseable timestamp is 0")
check(MailStore.makeSnippet(text: "  multi   space\n\nbody ", html: "") == "multi space body", "snippet collapses whitespace")
check(MailStore.makeSnippet(text: "", html: "<p>html <b>only</b></p>").contains("html only"), "snippet strips html when no text")

print("")
if counter.failures == 0 {
    print("SMOKE OK — all checks passed")
    exit(0)
} else {
    print("SMOKE FAILED — \(counter.failures) check(s) failed")
    exit(1)
}
