// Self-hosted-ONLY: the TUI data layer (src/cli/tui/data.ts) presents a unified
// mail view over the operator `/v1` API. There is no local SQLite anymore, so
// these tests drive the REAL data functions against an out-of-process /v1 stub
// (see src/test-support/v1-stub.ts). The old SQL-internal assertions (query
// plans, index names, json_each, db handles) exercised a deleted SQLite layer
// and are gone; this suite covers the observable behavior instead.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { storeInboundEmail, setInboundReadFlag, setInboundStarredFlag } from "../../db/inbound.js";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import {
  listMailbox, mailboxCounts, listMailboxStatus, searchMailbox, listMailboxSources,
  getMessageBody, getConversation, toggleStar, toggleRead, archiveMessage, toggleMessageLabel,
  listLabelSummaries, labelDisplayName, isMailCategoryLabel, mailboxLabel,
  replyDefaults, sendComposed, defaultFromAddress, providerIdForSender,
  listInboxAddresses, addressChoiceByAddress, listSources, listDomainSummaries,
  getSettings, setSetting, renderMarkdown, type TuiMessage,
} from "./data.js";

let stub: V1Stub;

// data.ts keeps a short TTL cache over the full message scan; mutations through
// data.ts invalidate it, but direct seeding does not — bust it between tests so
// each test observes only its own freshly-seeded state.
function bustScanCache(): void {
  try {
    toggleRead({ kind: "inbound", id: "__cache_bust__", is_read: false } as TuiMessage);
  } catch {
    // The 404 PATCH is expected on the empty store; the cache was already nulled.
  }
}

interface SeedOpts {
  read?: boolean;
  star?: boolean;
  labels?: string[];
  to?: string[];
  from?: string;
  body?: string;
  receivedAt?: string;
  attachments?: Array<{ filename: string; content_type: string; size: number }>;
}

function seed(subject: string, opts: SeedOpts = {}) {
  const e = storeInboundEmail({
    provider_id: null,
    message_id: `<${subject}@x>`,
    from_address: opts.from ?? "alice@ext.com",
    to_addresses: opts.to ?? ["me@x.com"],
    cc_addresses: [],
    subject,
    text_body: opts.body ?? `body of ${subject}`,
    html_body: null,
    attachments: opts.attachments ?? [],
    label_ids: opts.labels ?? [],
    headers: {},
    raw_size: 1,
    received_at: opts.receivedAt ?? new Date().toISOString(),
  });
  if (opts.read) setInboundReadFlag(e.id, true);
  if (opts.star) setInboundStarredFlag(e.id, true);
  return e;
}

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
  bustScanCache();
});
afterEach(() => stub.clearEnv());

describe("tui data — mailboxes", () => {
  it("routes messages to the right mailbox", () => {
    seed("unread-1");
    seed("read-1", { read: true });
    seed("starred-1", { star: true });
    seed("archived-1", { labels: ["archived"] });

    expect(listMailbox("inbox").map((m) => m.subject).sort()).toEqual(["read-1", "starred-1", "unread-1"]); // archived hidden
    expect(listMailbox("unread").map((m) => m.subject)).toContain("unread-1");
    expect(listMailbox("unread").map((m) => m.subject)).not.toContain("read-1");
    expect(listMailbox("starred").map((m) => m.subject)).toEqual(["starred-1"]);
    expect(listMailbox("archived").map((m) => m.subject)).toEqual(["archived-1"]);
  });

  it("computes folder counts", () => {
    seed("a");
    seed("b", { read: true });
    seed("s", { star: true });
    seed("z", { labels: ["archived"] });

    const c = mailboxCounts();
    expect(c.unread).toBe(2); // a + s (s is unread + starred)
    expect(c.starred).toBe(1);
    expect(c.archived).toBe(1);
    expect(c.inbox).toBe(3); // a, b, s (archived excluded)
  });

  it("keeps outbound (sent) mail in the Sent folder only", () => {
    seed("received-1");
    storeInboundEmail({
      provider_id: null, message_id: "<imported-sent@x>", from_address: "me@x.com", to_addresses: ["client@y.com"],
      cc_addresses: [], subject: "imported sent", text_body: "b", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: "2026-01-04T10:00:00.000Z",
    });

    expect(listMailbox("sent").map((m) => m.subject)).toContain("imported sent");
    expect(listMailbox("inbox").map((m) => m.subject)).not.toContain("imported sent");
    expect(listMailbox("inbox").map((m) => m.subject)).toContain("received-1");
    expect(mailboxCounts().sent).toBe(1);
  });

  it("routes spam and trash labels out of the regular folders", () => {
    seed("plain");
    seed("spammy", { labels: ["spam"] });
    seed("trashed", { labels: ["trash"] });

    expect(listMailbox("inbox").map((m) => m.subject).sort()).toEqual(["plain"]);
    expect(listMailbox("spam").map((m) => m.subject)).toEqual(["spammy"]);
    expect(listMailbox("trash").map((m) => m.subject)).toEqual(["trashed"]);
    expect(mailboxCounts()).toMatchObject({ inbox: 1, spam: 1, trash: 1 });
  });

  it("filters by subject search", () => {
    seed("invoice report");
    seed("lunch plans");
    expect(listMailbox("inbox", { search: "invoice" }).map((m) => m.subject)).toEqual(["invoice report"]);
    expect(searchMailbox("lunch").map((m) => m.subject)).toEqual(["lunch plans"]);
  });

  it("searches message body text", () => {
    seed("subject-only");
    seed("plain subject", { body: "body-only-token from aws mail" });
    expect(listMailbox("inbox", { search: "body-only-token" }).map((m) => m.subject)).toEqual(["plain subject"]);
  });

  it("sorts newest-first and paginates", () => {
    seed("oldest", { receivedAt: "2026-01-01T10:00:00.000Z" });
    seed("middle", { receivedAt: "2026-01-02T10:00:00.000Z" });
    seed("newest", { receivedAt: "2026-01-03T10:00:00.000Z" });

    expect(listMailbox("inbox", { limit: 2 }).map((m) => m.subject)).toEqual(["newest", "middle"]);
    expect(listMailbox("inbox", { limit: 1, offset: 1 }).map((m) => m.subject)).toEqual(["middle"]);
    expect(listMailbox("inbox", { sort: "oldest" }).map((m) => m.subject)).toEqual(["oldest", "middle", "newest"]);
  });

  it("filters inbox by since instant, not timestamp text", () => {
    seed("before cutoff", { receivedAt: "2026-07-11T23:59:59+00:00" });
    seed("offset after cutoff", { receivedAt: "2026-07-11T23:30:00-02:00" }); // 01:30Z on the 12th

    expect(listMailbox("inbox", { since: "2026-07-12T00:00:00.000Z" }).map((m) => m.subject)).toEqual(["offset after cutoff"]);
  });

  it("normalizes bad mailbox and pagination inputs", () => {
    seed("first");
    seed("second");

    expect(mailboxLabel("bad-folder" as never)).toBe("Inbox");
    expect(listMailbox("bad-folder" as never).map((m) => m.subject).sort()).toEqual(["first", "second"]);
    expect(listMailbox("inbox", { limit: Number.NaN, offset: Number.NaN }).length).toBe(2);
    expect(listMailbox("inbox", { limit: Number.POSITIVE_INFINITY, offset: Number.POSITIVE_INFINITY }).length).toBe(2);
  });

  it("reports a single self-hosted mailbox source with folder counts", () => {
    seed("one");
    seed("two", { read: true });

    const status = listMailboxStatus();
    expect(status.counts.inbox).toBe(2);

    const sources = listMailboxSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ id: "all", total: 2, unread: 1 });

    expect(listSources()[0]?.label).toContain("Self-hosted Emails");
  });
});

describe("tui data — labels", () => {
  it("toggles a label through /v1 and summarizes common + popular labels", () => {
    seed("needs label");
    const msg = listMailbox("inbox")[0]!;

    expect(toggleMessageLabel(msg, "Urgent")).toContain("urgent");
    const summaries = listLabelSummaries();
    expect(summaries.find((label) => label.name === "urgent")).toMatchObject({ count: 1, popular: true });
    expect(summaries.find((label) => label.name === "follow-up")).toMatchObject({ count: 0, popular: false });
    expect(listLabelSummaries({ search: "urg" }).map((label) => label.name)).toEqual(["urgent"]);

    const updated = listMailbox("inbox")[0]!;
    expect(toggleMessageLabel(updated, "urgent")).not.toContain("urgent");
  });

  it("filters mailboxes by label and displays mail categories without the Category prefix", () => {
    seed("category update", { labels: ["CATEGORY_UPDATES"] });
    seed("plain note");

    // The label filter matches the stored label case-insensitively (no separator
    // normalization), so the underscore form of the stored label matches.
    expect(listMailbox("inbox", { label: "category_updates" }).map((m) => m.subject)).toEqual(["category update"]);
    expect(labelDisplayName("category_updates")).toBe("Updates");
    expect(isMailCategoryLabel("category-updates")).toBe(true);
    expect(isMailCategoryLabel("urgent")).toBe(false);
  });
});

describe("tui data — body + conversation", () => {
  it("reads a body with flags and attachments", () => {
    const e = seed("hello", {
      star: true,
      attachments: [
        { filename: "report.pdf", content_type: "application/pdf", size: 2048 },
        { filename: "pic.png", content_type: "image/png", size: 512 },
      ],
    });
    const b = getMessageBody({ kind: "inbound", id: e.id } as TuiMessage)!;
    expect(b.subject).toBe("hello");
    expect(b.text).toContain("body of hello");
    expect(b.flags).toContain("starred");
    expect(b.attachments).toHaveLength(2);
    expect(b.attachments[0]!.filename).toBe("report.pdf");
  });

  it("groups a conversation by normalized subject", () => {
    storeInboundEmail({
      provider_id: null, message_id: "<sent-thread@x>", from_address: "me@x.com", to_addresses: ["client@y.com"],
      cc_addresses: [], subject: "Project kickoff", text_body: "sent body", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: "2026-01-01T10:00:00.000Z",
    });
    const reply = storeInboundEmail({
      provider_id: null, message_id: "<reply-thread@x>", from_address: "client@y.com", to_addresses: ["me@x.com"],
      cc_addresses: [], subject: "Re: Project kickoff", text_body: "reply body", html_body: null, attachments: [],
      headers: {}, raw_size: 1, received_at: "2026-01-01T11:00:00.000Z",
    });

    const msg = listMailbox("inbox").find((item) => item.id === reply.id)!;
    expect(getConversation(msg).map((item) => `${item.kind}:${item.subject}`)).toEqual([
      "sent:Project kickoff",
      "received:Re: Project kickoff",
    ]);
  });
});

describe("tui data — mutations", () => {
  it("toggles star and read through /v1", () => {
    const e = seed("x");
    const msg = listMailbox("inbox")[0]!;

    expect(toggleStar(msg)).toBe(true);
    expect(listMailbox("starred").map((m) => m.id)).toContain(e.id);

    expect(toggleRead(msg)).toBe(true);
    expect(listMailbox("unread").map((m) => m.id)).not.toContain(e.id);
  });

  it("archiveMessage writes the archived flag to the /v1 API", async () => {
    const e = seed("to-archive");
    const msg = listMailbox("inbox").find((m) => m.id === e.id)!;

    archiveMessage(msg, true);

    const stored = (await stub.list("messages")).find((m) => m["id"] === e.id);
    expect(stored?.["archived"]).toBe(true);
  });
});

describe("tui data — compose / reply", () => {
  it("derives reply defaults (Re: + swap from/to)", () => {
    seed("Quarterly", { to: ["ops@me.com"] });
    const msg = listMailbox("inbox")[0]!;
    const d = replyDefaults(msg);
    expect(d.subject).toBe("Re: Quarterly");
    expect(d.to).toBe("alice@ext.com");
    expect(d.from).toBe("ops@me.com");
  });

  it("derives reply defaults for imported sent mail via sentByMe", () => {
    storeInboundEmail({
      provider_id: null, message_id: "<imported-sent-reply@x>", from_address: "me@x.com", to_addresses: ["client@y.com"],
      cc_addresses: [], subject: "Sent from import", text_body: "already sent", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: "2026-01-01T10:00:00.000Z",
    });
    const msg = listMailbox("sent").find((item) => item.subject === "Sent from import")!;
    const d = replyDefaults(msg);
    expect(msg.sentByMe).toBe(true);
    expect(d.subject).toBe("Re: Sent from import");
    expect(d.from).toBe("me@x.com");
    expect(d.to).toBe("client@y.com");
  });

  it("sends a composed message via /v1/messages/send and it lands in Sent", async () => {
    const r = await sendComposed({ from: "me@x.com", to: "you@y.com", subject: "hi there", body: "yo" });
    expect(r.messageId).toBeTruthy();
    expect(listMailbox("sent").map((m) => m.subject)).toContain("hi there");
    expect((await stub.list("messages")).some((m) => m["subject"] === "hi there" && m["direction"] === "outbound")).toBe(true);
  });

  it("rejects an empty recipient and a missing From", async () => {
    await expect(sendComposed({ from: "me@x.com", to: "  ", subject: "x", body: "y" })).rejects.toThrow(/recipient/i);
    await expect(sendComposed({ from: "", to: "you@y.com", subject: "x", body: "y" })).rejects.toThrow(/from/i);
  });

  it("renders markdown to HTML", () => {
    const html = renderMarkdown("# Hi\n\n- one\n- two\n\n**bold**");
    expect(html).toContain("<h1>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<strong>bold</strong>");
  });
});

describe("tui data — addresses / senders / domains", () => {
  it("lists All mailboxes plus configured active addresses", async () => {
    await stub.seed({
      addresses: [
        { id: "addr-1", email: "ops@primary.test", display_name: "Ops", provider_id: "prov-1", status: "active", verified: true },
        { id: "addr-2", email: "paused@primary.test", provider_id: "prov-1", status: "suspended", verified: false },
      ],
    });
    bustScanCache();

    const choices = listInboxAddresses();
    expect(choices[0]).toMatchObject({ id: "all", label: "All mailboxes" });
    expect(choices.some((c) => c.address === "ops@primary.test" && c.configured && c.receiveStatus === "ready")).toBe(true);
    expect(choices.some((c) => c.address === "paused@primary.test")).toBe(false);
    expect(addressChoiceByAddress("ops@primary.test").configured).toBe(true);
  });

  it("resolves the default From and sender provider from /v1 addresses", async () => {
    await stub.seed({
      addresses: [
        { id: "addr-v", email: "ops@acme.com", provider_id: "prov-acme", status: "active", verified: true },
      ],
    });

    expect(defaultFromAddress({ source: { domain: "acme.com" } })).toBe("ops@acme.com");
    expect(defaultFromAddress({ source: { domain: "missing.com" }, fallback: "selected@inbox.com" })).toBe("selected@inbox.com");
    expect(providerIdForSender("ops@acme.com")).toBe("prov-acme");
  });

  it("summarizes domains from /v1", async () => {
    await stub.seed({
      domains: [{ id: "dom-1", domain: "acme.com", provider: "self_hosted", verified: true }],
    });

    const summaries = listDomainSummaries();
    expect(summaries.some((s) => s.domain === "acme.com")).toBe(true);
  });
});

describe("tui data — settings (self-hosted)", () => {
  it("returns default TUI settings and refuses local settings writes", () => {
    expect(getSettings()).toEqual({
      autoPull: false,
      dimRead: false,
      defaultMailbox: "inbox",
      defaultAddress: null,
      defaultFrom: null,
      theme: "light",
    });
    expect(() => setSetting("theme", "dark")).toThrow(/self_hosted API-only mode/);
  });
});
