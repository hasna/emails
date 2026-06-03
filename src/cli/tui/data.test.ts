import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase, getDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { storeInboundEmail, setInboundRead, setInboundStarred, setInboundArchived } from "../../db/inbound.js";
import {
  listMailbox, mailboxCounts, getMessageBody, toggleStar, toggleRead, archiveMessage,
  replyDefaults, sendComposed,
} from "./data.js";

let providerId: string;
function seed(subject: string, opts: { read?: boolean; star?: boolean; archived?: boolean; to?: string[] } = {}) {
  const e = storeInboundEmail({
    provider_id: null, message_id: `<${subject}@x>`, from_address: "alice@ext.com",
    to_addresses: opts.to ?? ["me@x.com"], cc_addresses: [], subject, text_body: `body of ${subject}`,
    html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
  });
  if (opts.read) setInboundRead(e.id, true);
  if (opts.star) setInboundStarred(e.id, true);
  if (opts.archived) setInboundArchived(e.id, true);
  return e;
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  providerId = createProvider({ name: "sandbox", type: "sandbox", active: true }).id;
});
afterEach(() => { closeDatabase(); delete process.env["EMAILS_DB_PATH"]; });

describe("tui data — mailboxes", () => {
  it("routes messages to the right mailbox", () => {
    seed("unread-1");
    seed("read-1", { read: true });
    seed("starred-1", { star: true });
    seed("archived-1", { archived: true });

    expect(listMailbox("inbox").map((m) => m.subject).sort()).toEqual(["read-1", "starred-1", "unread-1"]); // archived hidden
    expect(listMailbox("unread").map((m) => m.subject)).toContain("unread-1");
    expect(listMailbox("unread").map((m) => m.subject)).not.toContain("read-1");
    expect(listMailbox("starred").map((m) => m.subject)).toEqual(["starred-1"]);
    expect(listMailbox("archived").map((m) => m.subject)).toEqual(["archived-1"]);
  });

  it("computes counts", () => {
    seed("a"); seed("b", { read: true }); seed("s", { star: true }); seed("z", { archived: true });
    const c = mailboxCounts();
    expect(c.unread).toBe(2);     // a + s (s is unread+starred)
    expect(c.starred).toBe(1);
    expect(c.archived).toBe(1);
    expect(c.inbox).toBe(3);      // a, b, s (archived excluded)
  });

  it("filters by search", () => {
    seed("invoice report");
    seed("lunch plans");
    expect(listMailbox("inbox", { search: "invoice" }).map((m) => m.subject)).toEqual(["invoice report"]);
  });
});

describe("tui data — body + mutations", () => {
  it("reads a body with flags", () => {
    const e = seed("hello", { star: true });
    const b = getMessageBody({ kind: "inbound", id: e.id } as never)!;
    expect(b.subject).toBe("hello");
    expect(b.text).toContain("body of hello");
    expect(b.flags).toContain("starred");
  });

  it("toggles star and read", () => {
    const e = seed("x");
    const msg = listMailbox("inbox")[0]!;
    expect(toggleStar(msg)).toBe(true);
    expect(toggleRead(msg)).toBe(true);
    archiveMessage(msg, true);
    expect(listMailbox("inbox")).toHaveLength(0);
    expect(listMailbox("archived")).toHaveLength(1);
  });
});

describe("tui data — compose / reply", () => {
  it("derives reply defaults (Re: + swap from/to)", () => {
    const e = seed("Quarterly", { to: ["ops@me.com"] });
    const msg = listMailbox("inbox")[0]!;
    const d = replyDefaults(msg);
    expect(d.subject).toBe("Re: Quarterly");
    expect(d.to).toBe("alice@ext.com");
    expect(d.from).toBe("ops@me.com");
  });

  it("sends a composed message via the active provider", async () => {
    const r = await sendComposed({ from: "me@x.com", to: "you@y.com", subject: "hi", body: "yo" });
    expect(r.messageId).toBeTruthy();
    expect(listMailbox("sent").map((m) => m.subject)).toContain("hi");
  });

  it("rejects an empty recipient", async () => {
    await expect(sendComposed({ from: "me@x.com", to: "  ", subject: "x", body: "y" })).rejects.toThrow(/recipient/i);
  });
});
