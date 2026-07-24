import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  SelfHostedMailDataSource,
  type SelfHostedFetch,
  resolveSelfHostedMailDataSource,
} from "./self-hosted-mail-data-source.js";
import { resetSelfHostedConfigCache } from "../db/self-hosted-store.js";
import { resetMailDataSource, resolveMailDataSource } from "./mail-data-source.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const LEGACY_ENV_KEYS = [
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "HASNA_MAILERY_ENV_FILE",
] as const;

function clearModeEnv(): void {
  delete process.env["EMAILS_MODE"];
  delete process.env["HASNA_EMAILS_MODE"];
  delete process.env["EMAILS_SELF_HOSTED_URL"];
  delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
  for (const key of LEGACY_ENV_KEYS) delete process.env[key];
}

// A self-hosted /v1 message row (snake_case, as the API returns).
function v1(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    direction: "inbound",
    from_addr: `"Sender ${id}" <s${id}@example.com>`,
    to_addrs: ["andrei@hasna.com"],
    cc_addrs: [],
    subject: `subject ${id}`,
    body_text: `body of ${id}`,
    body_html: null,
    status: "received",
    provider_message_id: null,
    message_id: `<${id}@x>`,
    in_reply_to: null,
    received_at: `2026-06-1${id}T08:00:00.000Z`,
    is_read: false,
    is_starred: false,
    labels: [],
    headers: {},
    created_at: `2026-06-1${id}T08:00:01.000Z`,
    updated_at: `2026-06-1${id}T08:00:01.000Z`,
    ...over,
  };
}

function bodyWithHiddenNeedle(needle = "deep-needle"): string {
  return `${"filler ".repeat(90)}${needle}`;
}

function encodedChangesCursor(version: number, envelope: Record<string, unknown>): string {
  return `emails-self-hosted:v${version}:${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")}`;
}

function legacyBloomCollisionSequence(): string[] {
  const filter = Buffer.alloc(2_048);
  const bitCount = filter.length * 8;
  const cursors: string[] = [];
  for (let index = 0; index < 100_000; index += 1) {
    const cursor = `unique-cursor-${String(index).padStart(6, "0")}`;
    const digest = createHash("sha256").update(cursor, "utf8").digest();
    const bits = Array.from(
      { length: 6 },
      (_, hashIndex) => digest.readUInt32BE(hashIndex * 4) % bitCount,
    );
    if (bits.every((bit) =>
      (filter[Math.floor(bit / 8)]! & (1 << (bit % 8))) !== 0)) {
      return [...cursors, cursor];
    }
    for (const bit of bits) {
      const byte = Math.floor(bit / 8);
      filter[byte] = filter[byte]! | (1 << (bit % 8));
    }
    cursors.push(cursor);
  }
  throw new Error("expected a deterministic collision inside the old 2KiB Bloom-filter horizon");
}

function pagedRows(count: number, prefix: string, over: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  const newest = Date.parse("2026-07-20T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => v1(`${prefix}-${index}`, {
    received_at: new Date(newest - index * 1000).toISOString(),
    created_at: new Date(newest - index * 1000 + 1).toISOString(),
    ...over,
  }));
}

interface CompactCursorPage {
  messages: Array<Record<string, unknown>>;
  nextCursor: string | null | unknown;
}

function compactCursorServe(
  pages: Map<string, CompactCursorPage>,
): { fetchImpl: SelfHostedFetch; requests: string[]; deleted: string[] } {
  const requests: string[] = [];
  const deleted: string[] = [];
  const fetchImpl: SelfHostedFetch = async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    requests.push(`${method} ${u.pathname}${u.search}`);
    const ok = (body: unknown, status = 200) => ({ status, async text() { return JSON.stringify(body); } });
    const idMatch = u.pathname.match(/^\/v1\/messages\/([^/]+)$/);
    if (idMatch && method === "DELETE") {
      deleted.push(decodeURIComponent(idMatch[1]!));
      return ok({ deleted: true });
    }
    if (method !== "GET" || u.pathname !== "/v1/messages") return ok({ error: "not found" }, 404);
    if (u.searchParams.has("offset")) {
      return ok({ error: "offset is limited to 100000; use cursor pagination for deep pages" }, 400);
    }
    const cursor = u.searchParams.get("cursor") ?? "";
    const page = pages.get(cursor);
    if (!page) return ok({ error: "cursor is not a valid pagination cursor" }, 400);
    return ok({ messages: page.messages, next_cursor: page.nextCursor });
  };
  return { fetchImpl, requests, deleted };
}

function legacyOffsetServe(
  initial: Array<Record<string, unknown>>,
  options: { ignoreListFilters?: boolean } = {},
): {
  fetchImpl: SelfHostedFetch;
  rows: Map<string, Record<string, unknown>>;
  requests: string[];
  deleted: string[];
} {
  const rows = new Map(initial.map((row) => [String(row["id"]), row]));
  const requests: string[] = [];
  const deleted: string[] = [];
  const fetchImpl: SelfHostedFetch = async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    requests.push(`${method} ${u.pathname}${u.search}`);
    const ok = (body: unknown, status = 200) => ({ status, async text() { return JSON.stringify(body); } });
    const idMatch = u.pathname.match(/^\/v1\/messages\/([^/]+)$/);
    if (idMatch && method === "DELETE") {
      const id = decodeURIComponent(idMatch[1]!);
      const had = rows.delete(id);
      deleted.push(id);
      return had ? ok({ deleted: true }) : ok({ error: "not found" }, 404);
    }
    if (method !== "GET" || u.pathname !== "/v1/messages") return ok({ error: "not found" }, 404);
    if (u.searchParams.has("cursor")) return ok({ error: "legacy server does not support cursors" }, 400);
    const offset = Number(u.searchParams.get("offset") ?? "0");
    if (offset > 100_000) {
      return ok({ error: "offset is limited to 100000; use cursor pagination for deep pages" }, 400);
    }
    let ordered = [...rows.values()].sort((a, b) =>
      String(b["received_at"] ?? b["created_at"] ?? "").localeCompare(
        String(a["received_at"] ?? a["created_at"] ?? ""),
      ));
    if (!options.ignoreListFilters) {
      const direction = u.searchParams.get("direction");
      if (direction) ordered = ordered.filter((row) => String(row["direction"] ?? "").toLowerCase() === direction);
      const to = u.searchParams.get("to")?.toLowerCase();
      if (to) ordered = ordered.filter((row) => String(row["to_addrs"] ?? "").toLowerCase().includes(to));
      const from = u.searchParams.get("from")?.toLowerCase();
      if (from) ordered = ordered.filter((row) => String(row["from_addr"] ?? "").toLowerCase().includes(from));
      const search = u.searchParams.get("search")?.toLowerCase();
      if (search) {
        ordered = ordered.filter((row) => {
          const attachments = Array.isArray(row["attachments"]) ? row["attachments"] as Array<Record<string, unknown>> : [];
          const hay = [
            row["from_addr"],
            row["to_addrs"],
            row["subject"],
            row["body_text"],
            ...attachments.flatMap((attachment) => [attachment["filename"], attachment["content_type"]]),
          ].join(" ").toLowerCase();
          return hay.includes(search);
        });
      }
    }
    const limit = Number(u.searchParams.get("limit") ?? "500");
    return ok({ messages: ordered.slice(offset, offset + limit) });
  };
  return { fetchImpl, rows, requests, deleted };
}

// A fake self-hosted /v1 serve backed by an in-memory row list.
function fakeServe(
  initial: Array<Record<string, unknown>>,
  options: { ignoreListFilters?: boolean; leanList?: boolean; partialAttachmentList?: boolean } = {},
): { fetchImpl: SelfHostedFetch; rows: Map<string, Record<string, unknown>>; posted: unknown[]; deleted: string[]; requests: string[] } {
  const rows = new Map(initial.map((r) => [r["id"] as string, r]));
  const posted: unknown[] = [];
  const deleted: string[] = [];
  const requests: string[] = [];
  const fetchImpl: SelfHostedFetch = async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    requests.push(`${method} ${u.pathname}${u.search}`);
    const ok = (body: unknown, status = 200) => ({ status, async text() { return JSON.stringify(body); } });
    const includes = (value: unknown, query: string | null): boolean =>
      !query || String(value ?? "").toLowerCase().includes(query.toLowerCase());
    const list = (): { messages: Array<Record<string, unknown>>; nextCursor: string | null } => {
      let ordered = [...rows.values()].sort((a, b) =>
        String(b["received_at"]).localeCompare(String(a["received_at"])));
      if (!options.ignoreListFilters) {
        const direction = u.searchParams.get("direction");
        if (direction) ordered = ordered.filter((row) => String(row["direction"] ?? "").toLowerCase() === direction);
        const to = u.searchParams.get("to");
        if (to) ordered = ordered.filter((row) => String(row["to_addrs"] ?? "").toLowerCase().includes(to.toLowerCase()));
        ordered = ordered.filter((row) => includes(row["from_addr"], u.searchParams.get("from")));
        ordered = ordered.filter((row) => includes(row["subject"], u.searchParams.get("subject")));
        const search = u.searchParams.get("search");
        if (search) {
          ordered = ordered.filter((row) => {
            const attachments = Array.isArray(row["attachments"]) ? row["attachments"] as Array<Record<string, unknown>> : [];
            const hay = [
              row["from_addr"],
              row["to_addrs"],
              row["subject"],
              row["body_text"],
              ...attachments.flatMap((attachment) => [attachment["filename"], attachment["content_type"]]),
            ].join(" ").toLowerCase();
            return hay.includes(search.toLowerCase());
          });
        }
        const since = u.searchParams.get("since");
        if (since) {
          const cutoff = Date.parse(since);
          ordered = ordered.filter((row) => {
            const time = Date.parse(String(row["received_at"] ?? row["created_at"] ?? ""));
            return Number.isFinite(time) && time >= cutoff;
          });
        }
      }
      const limit = Number(u.searchParams.get("limit") ?? "500");
      const cursor = u.searchParams.get("cursor");
      const offset = cursor?.startsWith("cursor:")
        ? Number(cursor.slice("cursor:".length))
        : Number(u.searchParams.get("offset") ?? "0");
      const page = ordered.slice(offset, offset + limit);
      const messages = options.leanList ? page.map((row) => {
        const {
          body_text: bodyText,
          body_html: _bodyHtml,
          headers: _headers,
          attachments,
          ...summary
        } = row;
        return {
          ...summary,
          snippet: typeof bodyText === "string" ? bodyText.replace(/\s+/g, " ").trim().slice(0, 500) : null,
          attachment_count: Array.isArray(attachments) ? attachments.length : 0,
        };
      }) : options.partialAttachmentList ? page.map((row) => {
        const attachments = Array.isArray(row["attachments"])
          ? row["attachments"] as Array<Record<string, unknown>>
          : [];
        return {
          ...row,
          attachments: attachments.map((attachment) => ({ size: attachment["size"] })),
          attachment_count: attachments.length,
        };
      }) : page;
      return {
        messages,
        nextCursor: page.length === limit ? `cursor:${offset + page.length}` : null,
      };
    };
    const counts = () => {
      const messages = [...rows.values()];
      const hasLabel = (row: Record<string, unknown>, label: string) =>
        Array.isArray(row["labels"]) && (row["labels"] as unknown[]).some((value) => String(value).toLowerCase() === label);
      const isOutbound = (row: Record<string, unknown>) => String(row["direction"] ?? "").toLowerCase() === "outbound";
      const inboxRows = messages.filter((row) =>
        !isOutbound(row) && !hasLabel(row, "archived") && !hasLabel(row, "spam") && !hasLabel(row, "trash"));
      const latest = messages.reduce<string | null>((max, row) => {
        if (isOutbound(row)) return max;
        const date = String(row["received_at"] ?? row["created_at"] ?? "");
        return date && (max === null || date > max) ? date : max;
      }, null);
      return {
        inbox: inboxRows.length,
        unread: inboxRows.filter((row) => !row["is_read"]).length,
        starred: messages.filter((row) =>
          !isOutbound(row) &&
          Boolean(row["is_starred"]) &&
          !hasLabel(row, "archived") &&
          !hasLabel(row, "spam") &&
          !hasLabel(row, "trash")
        ).length,
        sent: messages.filter(isOutbound).length,
        archived: messages.filter((row) => !isOutbound(row) && hasLabel(row, "archived") && !hasLabel(row, "spam") && !hasLabel(row, "trash")).length,
        spam: messages.filter((row) => !isOutbound(row) && (hasLabel(row, "spam") || String(row["status"] ?? "").toLowerCase() === "spam")).length,
        trash: messages.filter((row) => !isOutbound(row) && hasLabel(row, "trash")).length,
        total: messages.length,
        latest_received_at: latest,
      };
    };
    const attachmentMatch = u.pathname.match(/^\/v1\/messages\/(.+)\/attachments\/(\d+)$/);
    const idMatch = u.pathname.match(/^\/v1\/messages\/([^/]+)$/);
    if (u.pathname === "/v1/messages" && method === "GET") {
      const page = list();
      return ok({ messages: page.messages, next_cursor: page.nextCursor });
    }
    if (u.pathname === "/v1/messages/counts" && method === "GET") return ok({ counts: counts() });
    if (u.pathname === "/v1/messages/send" && method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      const id = `posted-${posted.length}`;
      const rec = { id, message_id: `<${id}@x>`, ...body };
      rows.set(id, rec);
      return ok({ message: rec }, 201);
    }
    if (attachmentMatch && method === "GET") {
      const id = decodeURIComponent(attachmentMatch[1]!);
      const row = rows.get(id);
      const index = Number(attachmentMatch[2]);
      const metadata = Array.isArray(row?.["attachments"]) ? row!["attachments"] as Record<string, unknown>[] : [];
      const contents = Array.isArray(row?.["_attachment_contents"]) ? row!["_attachment_contents"] as string[] : [];
      if (!metadata[index]) return ok({ error: "not found", code: "attachment_not_found" }, 404);
      return contents[index]
        ? ok({ attachment: { ...metadata[index], content_base64: contents[index] } })
        : ok({ error: "attachment content is not stored", code: "attachment_content_unavailable", attachment: metadata[index] }, 409);
    }
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]!);
      if (method === "GET") {
        // Mirror the real server: an id may be a PREFIX. Exact id wins; else a
        // unique startsWith match resolves; multiple -> 409; none -> 404.
        if (rows.has(id)) return ok({ message: rows.get(id) });
        const prefixed = [...rows.keys()].filter((key) => key.startsWith(id));
        if (prefixed.length > 1) return ok({ error: "ambiguous message id prefix", reason: "ambiguous_id" }, 409);
        if (prefixed.length === 1) return ok({ message: rows.get(prefixed[0]!) });
        return ok({ error: "not found" }, 404);
      }
      if (method === "DELETE") { const had = rows.delete(id); deleted.push(id); return had ? ok({ deleted: true }) : ok({ error: "not found" }, 404); }
      if (method === "PATCH") {
        const row = rows.get(id);
        if (!row) return ok({ error: "not found" }, 404);
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        if (typeof body["is_read"] === "boolean") row["is_read"] = body["is_read"];
        if (typeof body["is_starred"] === "boolean") row["is_starred"] = body["is_starred"];
        const labels = Array.isArray(row["labels"]) ? [...row["labels"] as string[]] : [];
        if (typeof body["archived"] === "boolean") {
          const next = labels.filter((label) => label !== "archived");
          if (body["archived"]) next.push("archived");
          row["labels"] = next;
        }
        if (typeof body["add_label"] === "string" && !labels.includes(body["add_label"])) {
          row["labels"] = [...labels, body["add_label"]];
        }
        if (typeof body["remove_label"] === "string") {
          row["labels"] = labels.filter((label) => label !== body["remove_label"]);
        }
        return ok({ message: row });
      }
    }
    return ok({ error: "not found" }, 404);
  };
  return { fetchImpl, rows, posted, deleted, requests };
}

function make(
  rows: Array<Record<string, unknown>>,
  options?: { ignoreListFilters?: boolean; leanList?: boolean; partialAttachmentList?: boolean },
): { ds: SelfHostedMailDataSource; serve: ReturnType<typeof fakeServe> } {
  const serve = fakeServe(rows, options);
  const ds = new SelfHostedMailDataSource({ baseUrl: "https://emails.example/v1", apiKey: "test-key", fetchImpl: serve.fetchImpl });
  return { ds, serve };
}

beforeEach(() => {
  clearModeEnv();
});

afterEach(() => {
  resetMailDataSource();
  resetSelfHostedConfigCache();
  clearModeEnv();
});

describe("SelfHostedMailDataSource — /v1 resource mapping", () => {
  it("rejects remote plaintext HTTP before retaining an API key", () => {
    expect(() => new SelfHostedMailDataSource({ baseUrl: "http://emails.example/v1", apiKey: "must-not-leak" }))
      .toThrow(/requires HTTPS/);
    expect(() => new SelfHostedMailDataSource({ baseUrl: "http://localhost:8080/v1", apiKey: "local" }))
      .not.toThrow();
  });

  it("lists inbox mapping snake_case rows to TuiMessage, newest first", async () => {
    const { ds } = make([v1("2"), v1("5"), v1("3")]);
    const msgs = await ds.listMailbox("inbox");
    expect(msgs.map((m) => m.id)).toEqual(["5", "3", "2"]);
    const top = msgs[0]!;
    expect(top.from).toBe('"Sender 5" <s5@example.com>');
    expect(top.to).toBe("andrei@hasna.com");
    expect(top.subject).toBe("subject 5");
    expect(top.date).toBe("2026-06-15T08:00:00.000Z");
    expect(top.is_read).toBe(false);
    expect(top.kind).toBe("inbound");
  });

  // Regression guard for the list/detail attachment contract. The serve stopped
  // shipping the `attachments` array on list rows and now reports only
  // `attachment_count`; a client that keeps counting the (now absent) array
  // silently reports 0 attachments for mail that demonstrably has them.
  it("counts list attachments from attachment_count when the serve ships lean rows", async () => {
    const { ds } = make([
      v1("kpmg", {
        subject: "Declaratii TVA 06.2026",
        attachments: [
          { filename: "D300.pdf", content_type: "application/pdf", size: 189834 },
          { filename: "D394.pdf", content_type: "application/pdf", size: 28580 },
          { filename: "purchase-ledger.xls", content_type: "application/vnd.ms-excel", size: 38400 },
        ],
      }),
      v1("plain"),
    ], { leanList: true });

    const msgs = await ds.listMailbox("inbox");
    const byId = new Map(msgs.map((m) => [m.id, m]));
    expect(byId.get("kpmg")!.attachments).toBe(3);
    expect(byId.get("plain")!.attachments).toBe(0);
  });

  // Older serves (and the local seam) still send the metadata array; the count
  // must keep working there too, so the client spans both contract versions.
  it("falls back to the attachments array when a serve still ships it on list rows", async () => {
    const { ds } = make([
      v1("legacy", {
        attachments: [
          { filename: "a.pdf", content_type: "application/pdf", size: 10 },
          { filename: "b.pdf", content_type: "application/pdf", size: 20 },
        ],
      }),
    ]);

    const msgs = await ds.listMailbox("inbox");
    expect(msgs[0]!.attachments).toBe(2);
  });

  // The count is a summary signal only: the filenames/sizes still come from the
  // per-message read, which is the one place the download indexes are defined.
  it("keeps full attachment metadata available on the detail read behind a lean list", async () => {
    const { ds } = make([
      v1("kpmg", {
        attachments: [
          { filename: "D300.pdf", content_type: "application/pdf", size: 189834 },
          { filename: "D394.pdf", content_type: "application/pdf", size: 28580 },
        ],
      }),
    ], { leanList: true });

    const [summary] = await ds.listMailbox("inbox");
    expect(summary!.attachments).toBe(2);
    const body = await ds.getMessageBody(summary!);
    expect(body!.attachments.map((a) => a.filename)).toEqual(["D300.pdf", "D394.pdf"]);
    expect(body!.attachments[0]!.size).toBe(189834);
  });

  // An unnamed inline MIME part arrives as filename:"". Left empty it is dropped
  // by the display merge, which shifts every later download index — the read view
  // would then point at the wrong file.
  it("keeps nameless attachment parts addressable instead of dropping their index", async () => {
    const { ds } = make([
      v1("mixed", {
        attachments: [
          { filename: "", content_type: "image/png", size: 10 },
          { filename: "D394.pdf", content_type: "application/pdf", size: 28580 },
        ],
      }),
    ]);

    const [msg] = await ds.listMailbox("inbox");
    const body = await ds.getMessageBody(msg!);
    expect(body!.attachments.map((a) => a.filename)).toEqual(["attachment-1", "D394.pdf"]);
  });

  it("honors small inbox limits with one bounded server-side page", async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => v1(String(index), {
      received_at: `2026-06-18T08:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }));
    const { ds, serve } = make(rows);
    const msgs = await ds.listMailbox("inbox", { limit: 1 });
    expect(msgs).toHaveLength(1);
    expect(serve.requests.filter((request) => request.startsWith("GET /v1/messages?"))).toEqual([
      "GET /v1/messages?limit=50&direction=inbound",
    ]);
  });

  it("pushes timezone-aware since filters to the self-hosted server before pagination", async () => {
    const { ds, serve } = make([
      v1("old", { received_at: "2026-07-11T20:59:59.000Z" }),
      v1("today", { received_at: "2026-07-11T21:30:00.000Z" }),
    ]);

    const msgs = await ds.listMailbox("inbox", {
      since: "2026-07-12T00:00:00+03:00",
      limit: 10,
    });

    expect(msgs.map((m) => m.id)).toEqual(["today"]);
    expect(serve.requests.filter((request) => request.startsWith("GET /v1/messages?"))).toEqual([
      "GET /v1/messages?limit=50&direction=inbound&since=2026-07-11T21%3A00%3A00.000Z",
    ]);
  });

  it("filters the unread folder and honors a substring search", async () => {
    const { ds, serve } = make([v1("2", { is_read: true }), v1("5"), v1("3", { subject: "Oana friend suggestion" })]);
    const unread = await ds.listMailbox("unread");
    expect(unread.map((m) => m.id).sort()).toEqual(["3", "5"]);
    const hits = await ds.listMailbox("inbox", { search: "oana" });
    expect(hits.map((m) => m.id)).toEqual(["3"]);
    expect(serve.requests).toContain("GET /v1/messages?limit=200&direction=inbound&search=oana");
  });

  it("locally verifies server-returned rows when a stale server ignores filters", async () => {
    const { ds, serve } = make([
      v1("wrong-to", { to_addrs: ["other@example.com"], subject: "needle", received_at: "2026-07-13T12:00:00.000Z" }),
      v1("wrong-search", { to_addrs: ["target@example.com"], subject: "other", body_text: "other", received_at: "2026-07-13T11:00:00.000Z" }),
      v1("match", { to_addrs: ["target@example.com"], subject: "needle", body_text: "body", received_at: "2026-07-13T10:00:00.000Z" }),
      v1("old", { to_addrs: ["target@example.com"], subject: "needle", body_text: "body", received_at: "2026-07-10T10:00:00.000Z" }),
    ], { ignoreListFilters: true });

    const hits = await ds.listMailbox("inbox", {
      source: { address: "target@example.com" },
      search: "needle",
      since: "2026-07-12T00:00:00.000Z",
    });

    expect(hits.map((m) => m.id)).toEqual(["match"]);
    expect(serve.requests).toContain("GET /v1/messages?limit=200&direction=inbound&since=2026-07-12T00%3A00%3A00.000Z&to=target%40example.com&search=needle");
  });

  it("hydrates lean rows before rejecting body-only search matches with label filters", async () => {
    const { ds, serve } = make([
      v1("body-only", {
        subject: "No visible match",
        body_text: bodyWithHiddenNeedle(),
        labels: ["case"],
        received_at: "2026-07-13T10:00:00.000Z",
      }),
      v1("other", {
        subject: "Other",
        body_text: "no match here",
        labels: ["case"],
        received_at: "2026-07-13T11:00:00.000Z",
      }),
    ], { leanList: true });

    const hits = await ds.listMailbox("inbox", { label: "case", search: "deep-needle" });

    expect(hits.map((m) => m.id)).toEqual(["body-only"]);
    expect(serve.requests).toContain("GET /v1/messages/body-only");
  });

  it("hydrates lean rows before rejecting body-only search matches on oldest scans", async () => {
    const { ds, serve } = make([
      v1("newer", {
        subject: "Newer",
        body_text: "no match here",
        received_at: "2026-07-13T11:00:00.000Z",
      }),
      v1("older-body-only", {
        subject: "Older",
        body_text: bodyWithHiddenNeedle("oldest-needle"),
        received_at: "2026-07-13T10:00:00.000Z",
      }),
    ], { leanList: true });

    const hits = await ds.listMailbox("inbox", { sort: "oldest", search: "oldest-needle" });

    expect(hits.map((m) => m.id)).toEqual(["older-body-only"]);
    expect(serve.requests).toContain("GET /v1/messages/older-body-only");
  });

  it("preserves attachment-only server search matches after local detail verification", async () => {
    const { ds, serve } = make([
      v1("attachment-only", {
        subject: "Quarterly documents",
        body_text: "No searchable invoice term in the body",
        attachments: [{
          filename: "Q3-reconciliation.xlsx",
          content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: 42,
          content_base64: "must-not-be-searched",
        }],
      }),
      v1("other", {
        subject: "Other",
        body_text: "No match",
        attachments: [{ filename: "notes.txt", content_type: "text/plain", size: 5 }],
      }),
    ], { ignoreListFilters: true, partialAttachmentList: true });

    const byFilename = await ds.listMailbox("inbox", { search: "reconciliation.xlsx" });
    const byContentType = await ds.listMailbox("inbox", { search: "spreadsheetml" });
    const byPayload = await ds.listMailbox("inbox", { search: "must-not-be-searched" });

    expect(byFilename.map((message) => message.id)).toEqual(["attachment-only"]);
    expect(byContentType.map((message) => message.id)).toEqual(["attachment-only"]);
    expect(byPayload).toEqual([]);
    expect(serve.requests.filter((request) => request === "GET /v1/messages/attachment-only")).toHaveLength(3);
    expect(serve.requests.filter((request) => request === "GET /v1/messages/other")).toHaveLength(3);
  });

  it("finds an attachment-only match on the final cursor page after detail hydration", async () => {
    const rows = [
      ...pagedRows(50, "attachment-miss", {
        body_text: "No final attachment match",
        attachments: [],
      }),
      v1("attachment-final", {
        subject: "Final page fixture",
        body_text: "No searchable filename in the body",
        received_at: "2026-07-19T00:00:00.000Z",
        attachments: [{
          filename: "final-reconciliation.pdf",
          content_type: "application/pdf",
          size: 42,
        }],
      }),
    ];
    const { ds, serve } = make(rows, {
      ignoreListFilters: true,
      partialAttachmentList: true,
    });

    const messages = await ds.listMailbox("inbox", {
      search: "final-reconciliation.pdf",
      limit: 1,
    });

    expect(messages.map((message) => message.id)).toEqual(["attachment-final"]);
    expect(serve.requests).toContain(
      "GET /v1/messages?limit=50&cursor=cursor%3A50&direction=inbound&search=final-reconciliation.pdf",
    );
    expect(serve.requests).toContain("GET /v1/messages/attachment-final");
  });

  it("walks compact cursor pages past the legacy 100000-row boundary exactly once and stops on null", async () => {
    const pages = new Map<string, CompactCursorPage>([
      ["", {
        messages: [v1("newest", {
          labels: ["audit"],
          received_at: "2026-07-13T12:00:00.000Z",
        })],
        nextCursor: "after-50000",
      }],
      ["after-50000", {
        messages: [v1("middle", {
          labels: ["audit"],
          received_at: "2026-07-13T11:00:00.000Z",
        })],
        nextCursor: "after-100000",
      }],
      ["after-100000", {
        messages: [v1("oldest", {
          labels: ["audit"],
          received_at: "2026-07-13T10:00:00.000Z",
        })],
        nextCursor: null,
      }],
    ]);
    const serve = compactCursorServe(pages);
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    const messages = await ds.listMailbox("inbox", {
      label: "audit",
      sort: "oldest",
      limit: 3,
    });

    expect(messages.map((message) => message.id)).toEqual(["oldest", "middle", "newest"]);
    expect(new Set(messages.map((message) => message.id)).size).toBe(3);
    expect(serve.requests).toEqual([
      "GET /v1/messages?limit=500&direction=inbound",
      "GET /v1/messages?limit=500&cursor=after-50000&direction=inbound",
      "GET /v1/messages?limit=500&cursor=after-100000&direction=inbound",
    ]);
  });

  it("walks multiple full legacy offset pages for scoped counts and oldest reads", async () => {
    const rows = pagedRows(1001, "legacy", {
      to_addrs: ["target@example.com"],
      labels: ["audit"],
    });

    const countServe = legacyOffsetServe(rows);
    const countDs = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: countServe.fetchImpl,
    });
    const counts = await countDs.mailboxCounts({ source: { address: "target@example.com" } });
    expect(counts.inbox).toBe(1001);
    expect(countServe.requests.filter((request) => request.startsWith("GET /v1/messages?"))).toEqual([
      "GET /v1/messages?limit=500&to=target%40example.com",
      "GET /v1/messages?limit=500&offset=500&to=target%40example.com",
      "GET /v1/messages?limit=500&offset=1000&to=target%40example.com",
      "GET /v1/messages?limit=500&from=target%40example.com",
    ]);

    const oldestServe = legacyOffsetServe(rows);
    const oldestDs = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: oldestServe.fetchImpl,
    });
    const oldest = await oldestDs.listMailbox("inbox", {
      label: "audit",
      sort: "oldest",
      limit: 1,
    });
    expect(oldest.map((message) => message.id)).toEqual(["legacy-1000"]);
    expect(oldestServe.requests.filter((request) => request.startsWith("GET /v1/messages?"))).toEqual([
      "GET /v1/messages?limit=500&direction=inbound",
      "GET /v1/messages?limit=500&offset=500&direction=inbound",
      "GET /v1/messages?limit=500&offset=1000&direction=inbound",
    ]);
  });

  it("keeps bounded newest-first legacy reads to one page", async () => {
    const serve = legacyOffsetServe(pagedRows(1000, "legacy-bounded"));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    const messages = await ds.listMailbox("inbox", { limit: 1 });

    expect(messages).toHaveLength(1);
    expect(serve.requests.filter((request) => request.startsWith("GET /v1/messages?"))).toEqual([
      "GET /v1/messages?limit=50&direction=inbound",
    ]);
  });

  it("falls back from a current cursor page to the correct legacy offset", async () => {
    const requests: string[] = [];
    const fetchImpl: SelfHostedFetch = async (url) => {
      const u = new URL(url);
      requests.push(`${u.pathname}${u.search}`);
      const cursor = u.searchParams.get("cursor");
      const offset = Number(u.searchParams.get("offset") ?? "0");
      const start = cursor === "after-first-page" ? 500 : offset;
      const count = start < 1000 ? 500 : 1;
      return {
        status: 200,
        async text() {
          const body: Record<string, unknown> = {
            messages: Array.from({ length: count }, (_, index) => ({
              id: `mixed-${start + index}`,
              direction: "inbound",
              labels: ["audit"],
              received_at: new Date(Date.parse("2026-07-20T00:00:00.000Z") - (start + index) * 1000).toISOString(),
            })),
          };
          if (!cursor && offset === 0) body["next_cursor"] = "after-first-page";
          return JSON.stringify(body);
        },
      };
    };
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl,
    });

    const labels = await ds.listLabelSummaries();

    expect(labels).toContainEqual({ name: "audit", count: 1001, popular: true });
    expect(requests).toEqual([
      "/v1/messages?limit=500",
      "/v1/messages?limit=500&cursor=after-first-page",
      "/v1/messages?limit=500&offset=1000",
    ]);
  });

  it("continues a search across multiple full legacy offset pages", async () => {
    const rows = pagedRows(101, "legacy-search");
    rows[100]!["subject"] = "the deep legacy needle";
    const serve = legacyOffsetServe(rows, { ignoreListFilters: true });
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    const messages = await ds.listMailbox("inbox", { search: "deep legacy needle", limit: 1 });

    expect(messages.map((message) => message.id)).toEqual(["legacy-search-100"]);
    expect(serve.requests.filter((request) => request.startsWith("GET /v1/messages?"))).toEqual([
      "GET /v1/messages?limit=50&direction=inbound&search=deep+legacy+needle",
      "GET /v1/messages?limit=50&offset=50&direction=inbound&search=deep+legacy+needle",
      "GET /v1/messages?limit=50&offset=100&direction=inbound&search=deep+legacy+needle",
    ]);
  });

  it("preflights all legacy offset pages before clear mutates the mailbox", async () => {
    const serve = legacyOffsetServe(pagedRows(1001, "legacy-clear"));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    const result = await ds.clear({ mailbox: "inbox" });

    expect(result).toEqual({ cleared: 1001 });
    expect(serve.rows.size).toBe(0);
    expect(serve.deleted).toHaveLength(1001);
    expect(serve.requests.filter((request) => request.startsWith("GET /v1/messages?"))).toEqual([
      "GET /v1/messages?limit=500",
      "GET /v1/messages?limit=500&offset=500",
      "GET /v1/messages?limit=500&offset=1000",
    ]);
    expect(serve.requests.findIndex((request) => request.startsWith("DELETE ")))
      .toBeGreaterThan(serve.requests.findIndex((request) => request.includes("offset=1000")));
  });

  it("fails explicitly instead of returning partial success at the legacy offset cap", async () => {
    const requests: string[] = [];
    const deleted: string[] = [];
    const fetchImpl: SelfHostedFetch = async (url, init) => {
      const u = new URL(url);
      const method = (init.method ?? "GET").toUpperCase();
      requests.push(`${method} ${u.pathname}${u.search}`);
      const idMatch = u.pathname.match(/^\/v1\/messages\/([^/]+)$/);
      if (idMatch && method === "DELETE") {
        deleted.push(decodeURIComponent(idMatch[1]!));
        return {
          status: 200,
          async text() { return JSON.stringify({ deleted: true }); },
        };
      }
      const limit = Number(u.searchParams.get("limit") ?? "500");
      const offset = Number(u.searchParams.get("offset") ?? "0");
      return {
        status: 200,
        async text() {
          return JSON.stringify({
            messages: Array.from({ length: limit }, (_, index) => ({
              id: `cap-${offset + index}`,
              direction: "inbound",
              labels: ["audit"],
              received_at: "2026-07-13T00:00:00.000Z",
            })),
          });
        },
      };
    };
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(ds.clear({ mailbox: "inbox" })).rejects.toThrow(/legacy.*offset.*100000.*cursor|upgrade.*cursor/i);
    expect(requests.at(-1)).toBe("GET /v1/messages?limit=500&offset=100000");
    expect(deleted).toEqual([]);
  });

  it("preserves the array search contract while following short cursor pages", async () => {
    const serve = compactCursorServe(new Map([
      ["", {
        messages: [v1("newer-miss", {
          subject: "not it",
          body_text: "no match",
          attachment_count: 0,
          received_at: "2026-07-13T12:00:00.000Z",
        })],
        nextCursor: "after-100000",
      }],
      ["after-100000", {
        messages: [v1("older-hit", {
          subject: "needle",
          attachment_count: 0,
          received_at: "2026-07-13T10:00:00.000Z",
        })],
        nextCursor: null,
      }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    const messages = await ds.listMailbox("inbox", { search: "needle", limit: 1 });

    expect(Array.isArray(messages)).toBe(true);
    expect(messages.map((message) => message.id)).toEqual(["older-hit"]);
    expect(serve.requests).toEqual([
      "GET /v1/messages?limit=50&direction=inbound&search=needle",
      "GET /v1/messages?limit=50&cursor=after-100000&direction=inbound&search=needle",
    ]);
  });

  it("exposes an explicitly insert-only inventory page instead of a general mutation feed", async () => {
    const serve = compactCursorServe(new Map([
      ["", {
        messages: [v1("inserted", { received_at: "2026-07-13T12:00:00.000Z" })],
        nextCursor: null,
      }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    const page = await (ds as unknown as {
      listInsertionsSince(input: { receivedSince: string; limit: number }): Promise<unknown>;
    }).listInsertionsSince({
      receivedSince: "2026-07-13T00:00:00.000Z",
      limit: 1,
    });

    expect(page).toEqual({
      semantics: "insert_only",
      insertions: [expect.objectContaining({ id: "inserted" })],
      cursor: null,
    });
    expect("changesSince" in ds).toBe(false);
    expect(serve.requests).toEqual([
      "GET /v1/messages?limit=1&since=2026-07-13T00%3A00%3A00.000Z",
    ]);
  });

  it("keeps the insert-only received-time bound stable across cursor pages", async () => {
    const serve = compactCursorServe(new Map([
      ["", {
        messages: [v1("newer", { received_at: "2026-07-13T12:00:00.000Z" })],
        nextCursor: "next-page",
      }],
      ["next-page", {
        messages: [v1("older", { received_at: "2026-07-13T11:00:00.000Z" })],
        nextCursor: null,
      }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    const first = await ds.listInsertionsSince({
      receivedSince: "2026-07-13T00:00:00.000Z",
      limit: 1,
    });
    const second = await ds.listInsertionsSince({
      receivedSince: "2026-07-13T00:00:00.000Z",
      limit: 1,
      cursor: first.cursor ?? undefined,
    });

    expect(first.semantics).toBe("insert_only");
    expect(first.insertions.map((message) => message.id)).toEqual(["newer"]);
    expect(first.cursor).not.toBe("next-page");
    expect(first.cursor).toEqual(expect.any(String));
    expect(second.insertions.map((message) => message.id)).toEqual(["older"]);
    expect(second.cursor).toBeNull();
    expect(serve.requests).toEqual([
      "GET /v1/messages?limit=1&since=2026-07-13T00%3A00%3A00.000Z",
      "GET /v1/messages?limit=1&cursor=next-page&since=2026-07-13T00%3A00%3A00.000Z",
    ]);
  });

  it("rejects a changed received-time bound while resuming an inventory cursor", async () => {
    const serve = compactCursorServe(new Map([
      ["", {
        messages: [v1("newer", { received_at: "2026-07-13T12:00:00.000Z" })],
        nextCursor: "older-page",
      }],
      ["older-page", {
        messages: [v1("older", { received_at: "2026-07-13T11:00:00.000Z" })],
        nextCursor: null,
      }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    const first = await ds.listInsertionsSince({
      receivedSince: "2026-07-13T00:00:00.000Z",
      limit: 1,
    });
    await expect(ds.listInsertionsSince({
      receivedSince: "2026-07-14T00:00:00.000Z",
      cursor: first.cursor ?? undefined,
      limit: 1,
    })).rejects.toThrow(/receivedSince.*cursor|cursor.*receivedSince/i);

    expect(serve.requests).toEqual([
      "GET /v1/messages?limit=1&since=2026-07-13T00%3A00%3A00.000Z",
    ]);
  });

  it("accepts a raw pre-envelope server cursor and wraps later continuation", async () => {
    const serve = compactCursorServe(new Map([
      ["raw-server-cursor", {
        messages: [v1("middle", { received_at: "2026-07-13T11:00:00.000Z" })],
        nextCursor: "next-server-cursor",
      }],
      ["next-server-cursor", {
        messages: [v1("oldest", { received_at: "2026-07-13T10:00:00.000Z" })],
        nextCursor: null,
      }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    const first = await ds.listInsertionsSince({
      receivedSince: "2026-07-13T00:00:00.000Z",
      cursor: "raw-server-cursor",
      limit: 1,
    });
    const second = await ds.listInsertionsSince({
      receivedSince: "2026-07-13T00:00:00.000Z",
      cursor: first.cursor ?? undefined,
      limit: 1,
    });

    expect(first.insertions.map((message) => message.id)).toEqual(["middle"]);
    expect(first.cursor).not.toBe("next-server-cursor");
    expect(second.insertions.map((message) => message.id)).toEqual(["oldest"]);
    expect(serve.requests).toEqual([
      "GET /v1/messages?limit=1&cursor=raw-server-cursor&since=2026-07-13T00%3A00%3A00.000Z",
      "GET /v1/messages?limit=1&cursor=next-server-cursor&since=2026-07-13T00%3A00%3A00.000Z",
    ]);
  });

  it("fails closed when a raw cursor returns a full page without next_cursor", async () => {
    const serve = compactCursorServe(new Map([
      ["raw-server-cursor", {
        messages: [v1("middle", { received_at: "2026-07-13T11:00:00.000Z" })],
        nextCursor: undefined,
      }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    await expect(ds.listInsertionsSince({
      receivedSince: "2026-07-13T00:00:00.000Z",
      cursor: "raw-server-cursor",
      limit: 1,
    })).rejects.toThrow(/raw cursor pagination returned a full page without next_cursor/);
    expect(serve.requests).toEqual([
      "GET /v1/messages?limit=1&cursor=raw-server-cursor&since=2026-07-13T00%3A00%3A00.000Z",
    ]);
  });

  it("accepts an empty raw cursor terminal page without a continuation cursor", async () => {
    const serve = compactCursorServe(new Map([
      ["raw-server-cursor", {
        messages: [],
        nextCursor: undefined,
      }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    const result = await ds.listInsertionsSince({
      receivedSince: "2026-07-13T00:00:00.000Z",
      cursor: "raw-server-cursor",
      limit: 1,
    });

    expect(result).toEqual({
      semantics: "insert_only",
      insertions: [],
      cursor: null,
    });
    expect(serve.requests).toEqual([
      "GET /v1/messages?limit=1&cursor=raw-server-cursor&since=2026-07-13T00%3A00%3A00.000Z",
    ]);
  });

  it("preserves numeric legacy-offset continuation from a numeric cursor", async () => {
    const serve = legacyOffsetServe([
      v1("newest", { received_at: "2026-07-20T00:00:00.000Z" }),
      v1("middle", { received_at: "2026-07-19T00:00:00.000Z" }),
      v1("oldest", { received_at: "2026-07-18T00:00:00.000Z" }),
    ]);
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });
    const cursor = encodedChangesCursor(2, {
      version: 2,
      serverCursor: null,
      cycleAnchor: null,
      cyclePower: 1,
      cycleLength: 0,
      pageCount: 0,
      offset: 1,
      since: null,
    });

    const first = await ds.listInsertionsSince({ cursor, limit: 1 });
    const second = await ds.listInsertionsSince({ cursor: first.cursor ?? undefined, limit: 1 });
    const third = await ds.listInsertionsSince({ cursor: second.cursor ?? undefined, limit: 1 });

    expect(first.insertions.map((insertion) => insertion.id)).toEqual(["middle"]);
    expect(second.insertions.map((insertion) => insertion.id)).toEqual(["oldest"]);
    expect(third.insertions).toEqual([]);
    expect(first.cursor).not.toBeNull();
    expect(second.cursor).not.toBeNull();
    expect(third.cursor).toBeNull();
    expect(serve.requests.filter((request) => request.startsWith("GET /v1/messages?"))).toEqual([
      "GET /v1/messages?limit=1&offset=1",
      "GET /v1/messages?limit=1&offset=2",
      "GET /v1/messages?limit=1&offset=3",
    ]);
  });

  it("resumes a bounded legacy v1 envelope and emits no compatibility truncation", async () => {
    const serve = compactCursorServe(new Map([
      ["legacy-server-cursor", {
        messages: [v1("legacy-envelope-row", {
          received_at: "2026-07-13T11:00:00.000Z",
        })],
        nextCursor: null,
      }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });
    const cursor = encodedChangesCursor(1, {
      version: 1,
      serverCursor: "legacy-server-cursor",
      seenServerCursors: ["legacy-server-cursor"],
      offset: 1,
      since: "2026-07-13T00:00:00.000Z",
      watermark: "2026-07-13T12:00:00.000Z",
    });

    const result = await ds.listInsertionsSince({ cursor, limit: 1 });

    expect(result.insertions.map((message) => message.id)).toEqual(["legacy-envelope-row"]);
    expect(result.cursor).toBeNull();
    expect(serve.requests).toEqual([
      "GET /v1/messages?limit=1&cursor=legacy-server-cursor&since=2026-07-13T00%3A00%3A00.000Z",
    ]);
  });

  it("keeps exact insertion cursors bounded and does not reject unique cursors at the old Bloom collision", async () => {
    const uniqueCursors = legacyBloomCollisionSequence();
    const cursorPositions = new Map(uniqueCursors.map((cursor, index) => [cursor, index + 1]));
    const requests: string[] = [];
    const fetchImpl: SelfHostedFetch = async (url) => {
      const u = new URL(url);
      requests.push(`${u.pathname}${u.search}`);
      const rawCursor = u.searchParams.get("cursor");
      const page = rawCursor ? cursorPositions.get(rawCursor)! : 0;
      const nextCursor = uniqueCursors[page] ?? null;
      return {
        status: 200,
        async text() {
          return JSON.stringify({
            messages: [v1(`bounded-${page}`, {
              received_at: new Date(Date.parse("2026-07-20T00:00:00.000Z") - page * 1000).toISOString(),
            })],
            next_cursor: nextCursor,
          });
        },
      };
    };
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl,
    });

    let cursor: string | undefined;
    const lengths: number[] = [];
    for (let page = 0; page < uniqueCursors.length; page++) {
      const result = await ds.listInsertionsSince({ cursor, limit: 1 });
      cursor = result.cursor ?? undefined;
      expect(cursor).toEqual(expect.any(String));
      lengths.push(cursor!.length);
    }

    expect(requests).toHaveLength(uniqueCursors.length);
    expect(new Set(uniqueCursors).size).toBe(uniqueCursors.length);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(8192);
  });

  it("detects an exact server cursor cycle across separate insertion-page calls", async () => {
    const serve = compactCursorServe(new Map([
      ["", {
        messages: [v1("first", { received_at: "2026-07-13T12:00:00.000Z" })],
        nextCursor: "cursor-a",
      }],
      ["cursor-a", {
        messages: [v1("second", { received_at: "2026-07-13T11:00:00.000Z" })],
        nextCursor: "cursor-b",
      }],
      ["cursor-b", {
        messages: [v1("duplicate-first", { received_at: "2026-07-13T12:00:00.000Z" })],
        nextCursor: "cursor-a",
      }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    const first = await ds.listInsertionsSince({ limit: 1 });
    const second = await ds.listInsertionsSince({ cursor: first.cursor ?? undefined, limit: 1 });
    const third = await ds.listInsertionsSince({ cursor: second.cursor ?? undefined, limit: 1 });
    await expect(ds.listInsertionsSince({ cursor: third.cursor ?? undefined, limit: 1 }))
      .rejects.toThrow(/cursor repeated|did not advance/i);

    expect(first.insertions.map((message) => message.id)).toEqual(["first"]);
    expect(second.insertions.map((message) => message.id)).toEqual(["second"]);
    expect(third.insertions.map((message) => message.id)).toEqual(["duplicate-first"]);
    expect(serve.requests).toEqual([
      "GET /v1/messages?limit=1",
      "GET /v1/messages?limit=1&cursor=cursor-a",
      "GET /v1/messages?limit=1&cursor=cursor-b",
      "GET /v1/messages?limit=1&cursor=cursor-a",
    ]);
  });

  it("rejects a malformed versioned insertion cursor before contacting the server", async () => {
    const serve = compactCursorServe(new Map());
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    await expect(ds.listInsertionsSince({
      cursor: "emails-self-hosted:v1:not-base64-json",
      limit: 1,
    })).rejects.toThrow(/malformed changes cursor envelope/i);
    expect(serve.requests).toEqual([]);
  });

  it("rejects oversized and schema-expanded insertion cursors before contacting the server", async () => {
    const serve = compactCursorServe(new Map([
      ["server-cursor", { messages: [], nextCursor: null }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });
    const baseEnvelope = {
      version: 1,
      serverCursor: "server-cursor",
      seenServerCursors: ["server-cursor"],
      offset: 1,
      since: null,
      watermark: null,
    };
    const schemaExpanded = encodedChangesCursor(1, {
      ...baseEnvelope,
      attackerControlled: true,
    });
    const oversized = encodedChangesCursor(1, {
      ...baseEnvelope,
      seenServerCursors: Array.from(
        { length: 2_000 },
        (_, index) => `attacker-cursor-${index}`,
      ),
    });
    const currentEnvelope = {
      version: 2,
      serverCursor: null,
      cycleAnchor: null,
      cyclePower: 1,
      cycleLength: 0,
      pageCount: 1,
      offset: 1,
      since: null,
    };
    const currentSchemaExpanded = encodedChangesCursor(2, {
      ...currentEnvelope,
      attackerControlled: true,
    });
    const currentOversized = encodedChangesCursor(2, {
      ...currentEnvelope,
      cycleAnchor: "A".repeat(7_000),
    });
    const currentPageCountOverflow = encodedChangesCursor(2, {
      ...currentEnvelope,
      pageCount: 100_001,
    });

    await expect(ds.listInsertionsSince({ cursor: schemaExpanded, limit: 1 }))
      .rejects.toThrow(/malformed changes cursor envelope/i);
    await expect(ds.listInsertionsSince({ cursor: oversized, limit: 1 }))
      .rejects.toThrow(/malformed changes cursor envelope/i);
    await expect(ds.listInsertionsSince({ cursor: currentSchemaExpanded, limit: 1 }))
      .rejects.toThrow(/malformed changes cursor envelope/i);
    await expect(ds.listInsertionsSince({ cursor: currentOversized, limit: 1 }))
      .rejects.toThrow(/malformed changes cursor envelope/i);
    await expect(ds.listInsertionsSince({ cursor: currentPageCountOverflow, limit: 1 }))
      .rejects.toThrow(/malformed changes cursor envelope/i);
    expect(serve.requests).toEqual([]);
  });

  it("fails explicitly instead of truncating when the insertion cursor page limit is exhausted", async () => {
    const requests: string[] = [];
    const fetchImpl: SelfHostedFetch = async (url) => {
      requests.push(new URL(url).pathname + new URL(url).search);
      return {
        status: 200,
        async text() {
          return JSON.stringify({
            messages: [v1("page-limit-row")],
          });
        },
      };
    };
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl,
    });
    const cursor = encodedChangesCursor(2, {
      version: 2,
      serverCursor: null,
      cycleAnchor: null,
      cyclePower: 1,
      cycleLength: 0,
      pageCount: 100_000,
      offset: 1,
      since: null,
    });

    await expect(ds.listInsertionsSince({ cursor, limit: 1 }))
      .rejects.toThrow(/pagination exceeded.*100000-page safety limit/i);
    expect(requests).toEqual(["/v1/messages?limit=1&offset=1"]);
  });

  it("propagates malformed caller cursors as server failures", async () => {
    const serve = compactCursorServe(new Map([
      ["", { messages: [], nextCursor: null }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    await expect(ds.listInsertionsSince({ cursor: "not-a-server-cursor", limit: 1 }))
      .rejects.toThrow(/HTTP 400/);
    expect(serve.requests).toEqual([
      "GET /v1/messages?limit=1&cursor=not-a-server-cursor",
    ]);
  });

  it("allows a stale server to terminate a short page without next_cursor", async () => {
    const serve = compactCursorServe(new Map([
      ["", { messages: [v1("only")], nextCursor: undefined }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    expect((await ds.listMailbox("inbox", { limit: 2 })).map((message) => message.id)).toEqual(["only"]);
  });

  it("returns an opaque legacy-offset continuation when next_cursor is omitted on a full insertion page", async () => {
    const serve = legacyOffsetServe([
      v1("newer", { received_at: "2026-07-13T12:00:00.000Z" }),
      v1("older", { received_at: "2026-07-13T11:00:00.000Z" }),
    ]);
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    const first = await ds.listInsertionsSince({ limit: 1 });
    const second = await ds.listInsertionsSince({ cursor: first.cursor ?? undefined, limit: 1 });
    const third = await ds.listInsertionsSince({
      cursor: second.cursor ?? undefined,
      limit: 1,
    });

    expect(first.insertions.map((message) => message.id)).toEqual(["newer"]);
    expect(first.cursor).toEqual(expect.any(String));
    expect(second.insertions.map((message) => message.id)).toEqual(["older"]);
    expect(second.cursor).toEqual(expect.any(String));
    expect(third.insertions).toEqual([]);
    expect(third.cursor).toBeNull();
    expect(serve.requests.filter((request) => request.startsWith("GET /v1/messages?"))).toEqual([
      "GET /v1/messages?limit=1",
      "GET /v1/messages?limit=1&offset=1",
      "GET /v1/messages?limit=1&offset=2",
    ]);
  });

  it("fails closed when the server returns a malformed pagination cursor", async () => {
    const serve = compactCursorServe(new Map([
      ["", { messages: [v1("1", { labels: ["audit"] })], nextCursor: { not: "opaque-string" } }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    await expect(ds.listLabelSummaries()).rejects.toThrow(/next_cursor/i);
  });

  it("fails closed when the server returns a blank opaque pagination cursor", async () => {
    const serve = compactCursorServe(new Map([
      ["", { messages: [v1("1", { labels: ["audit"] })], nextCursor: " " }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    await expect(ds.listLabelSummaries()).rejects.toThrow(/next_cursor/i);
  });

  it("fails closed when a server cursor does not advance", async () => {
    const serve = compactCursorServe(new Map([
      ["", { messages: [v1("1", { labels: ["audit"] })], nextCursor: "stuck" }],
      ["stuck", { messages: [v1("2", { labels: ["audit"] })], nextCursor: "stuck" }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    await expect(ds.listLabelSummaries()).rejects.toThrow(/cursor.*advance|repeated.*cursor/i);
    expect(serve.requests).toHaveLength(2);
  });

  it("detects a multi-page cursor cycle before clear performs any deletion", async () => {
    const serve = compactCursorServe(new Map([
      ["", { messages: [v1("first")], nextCursor: "cursor-a" }],
      ["cursor-a", { messages: [v1("second")], nextCursor: "cursor-b" }],
      ["cursor-b", { messages: [v1("cycle")], nextCursor: "cursor-a" }],
    ]));
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: serve.fetchImpl,
    });

    await expect(ds.clear({ mailbox: "inbox" })).rejects.toThrow(/cursor.*advance|repeated.*cursor/i);
    expect(serve.deleted).toEqual([]);
    expect(serve.requests.filter((request) => request.startsWith("DELETE "))).toEqual([]);
  });

  it("separates sent (outbound) from inbox", async () => {
    const { ds } = make([v1("2"), v1("5", { direction: "outbound" })]);
    expect((await ds.listMailbox("inbox")).map((m) => m.id)).toEqual(["2"]);
    const sent = await ds.listMailbox("sent");
    expect(sent.map((m) => m.id)).toEqual(["5"]);
    expect(sent[0]!.kind).toBe("sent");
  });

  it("keeps starred self-hosted mailbox semantics aligned with local received folders", async () => {
    const { ds, serve } = make([
      v1("1", { is_starred: true }),
      v1("2", { is_starred: true, direction: "outbound" }),
      v1("3", { is_starred: true, labels: ["archived"] }),
      v1("4", { is_starred: true, labels: ["spam"] }),
      v1("5", { is_starred: true, labels: ["trash"] }),
    ]);

    expect((await ds.listMailbox("starred")).map((m) => m.id)).toEqual(["1"]);
    expect((await ds.mailboxCounts()).starred).toBe(1);
    expect(serve.requests.filter((request) => request.startsWith("GET /v1/messages?"))).toEqual([
      "GET /v1/messages?limit=200&direction=inbound",
    ]);
  });

  it("keeps archived self-hosted mailbox lists aligned with server count semantics", async () => {
    const { ds } = make([
      v1("1", { labels: ["archived"] }),
      v1("2", { labels: ["archived", "spam"] }),
      v1("3", { labels: ["archived", "trash"] }),
      v1("4", { labels: ["archived"], direction: "outbound" }),
      v1("5", { labels: ["spam"] }),
      v1("6", { labels: ["trash"] }),
    ]);

    expect((await ds.listMailbox("archived")).map((m) => m.id)).toEqual(["1"]);
    expect((await ds.listMailbox("spam")).map((m) => m.id).sort()).toEqual(["2", "5"]);
    expect((await ds.listMailbox("trash")).map((m) => m.id).sort()).toEqual(["3", "6"]);
    expect(await ds.mailboxCounts()).toMatchObject({ archived: 1, spam: 2, trash: 2, sent: 1 });
  });

  it("computes mailbox counts across folders", async () => {
    const { ds, serve } = make([v1("2"), v1("3", { is_read: true }), v1("5", { is_starred: true })]);
    const counts = await ds.mailboxCounts();
    expect(counts.inbox).toBe(3);
    expect(counts.unread).toBe(2);
    expect(counts.starred).toBe(1);
    expect(serve.requests).toEqual(["GET /v1/messages/counts"]);
  });

  it("uses source-filtered reads for mailbox counts instead of a global scan", async () => {
    const { ds, serve } = make([
      v1("in", { to_addrs: ["target@example.com"] }),
      v1("sent-from", { direction: "outbound", from_addr: "target@example.com", to_addrs: ["client@example.com"] }),
      v1("sent-to", { direction: "outbound", from_addr: "me@example.com", to_addrs: ["target@example.com"] }),
      v1("sent-self", { direction: "outbound", from_addr: "target@example.com", to_addrs: ["target@example.com"] }),
      v1("other", { to_addrs: ["other@example.com"] }),
    ]);

    const counts = await ds.mailboxCounts({ source: { address: "target@example.com" } });

    expect(counts).toMatchObject({ inbox: 1, sent: 3 });
    expect(serve.requests.filter((request) => request.startsWith("GET /v1/messages?"))).toEqual([
      "GET /v1/messages?limit=500&to=target%40example.com",
      "GET /v1/messages?limit=500&from=target%40example.com",
    ]);
  });

  it("reports self-hosted source totals as received mail, not global sent+received totals", async () => {
    const { ds } = make([
      v1("1"),
      v1("2", { labels: ["archived"] }),
      v1("3", { direction: "outbound" }),
    ]);

    const sources = await ds.listMailboxSources();
    expect(sources[0]).toMatchObject({
      id: "self_hosted",
      total: 2,
      counts: { inbox: 1, archived: 1, sent: 1 },
    });
  });

  it("resolves a full id verbatim with NO request", async () => {
    const full = "31f40200-dc2c-48ba-a348-ed7d4414381e";
    const { ds, serve } = make([v1("2"), { ...v1("9"), id: full }]);
    expect(await ds.resolveId(full)).toBe(full);
    expect(await ds.resolveId(`legacy-inbound:${full}`)).toBe(`legacy-inbound:${full}`);
    // A full id never touches the network.
    expect(serve.requests).toEqual([]);
  });

  it("resolves a unique prefix with ONE server GET and NEVER scans the inbox", async () => {
    const full = "31f40200-dc2c-48ba-a348-ed7d4414381e";
    // Many rows so a scanAll() (the old behavior) would be obvious as a page fetch.
    const rows = Array.from({ length: 40 }, (_, i) => v1(String(i + 10)));
    const { ds, serve } = make([...rows, { ...v1("9"), id: full }]);
    expect(await ds.resolveId("31f40200")).toBe(full);
    // Exactly one GET, and it is the by-id prefix lookup — no `?limit=…&offset=…`
    // list page was ever fetched (the whole-inbox scan is gone).
    expect(serve.requests).toEqual(["GET /v1/messages/31f40200"]);
    expect(serve.requests.some((r) => r.startsWith("GET /v1/messages?"))).toBe(false);
  });

  it("resolveId of an unknown prefix does ONE GET and hands back the input (clean 404)", async () => {
    const { ds, serve } = make([v1("2"), v1("5")]);
    expect(await ds.resolveId("deadbeef")).toBe("deadbeef");
    expect(serve.requests).toEqual(["GET /v1/messages/deadbeef"]);
  });

  it("resolveId throws a clear error when a prefix is ambiguous (server 409)", async () => {
    const { ds } = make([{ ...v1("2"), id: "abc11111" }, { ...v1("5"), id: "abc22222" }]);
    await expect(ds.resolveId("abc")).rejects.toThrow(/Ambiguous email id prefix/);
  });

  it("getMessageWithBody fetches the message AND body in a SINGLE round-trip", async () => {
    const { ds, serve } = make([v1("5", { body_text: "hello world", cc_addrs: ["cc@x.com"] })]);
    const result = await ds.getMessageWithBody("5");
    expect(result?.msg.subject).toBe("subject 5");
    expect(result?.body.text).toBe("hello world");
    expect(result?.body.cc).toBe("cc@x.com");
    // One and only one row read — not getMessage()+getMessageBody() (two).
    expect(serve.requests).toEqual(["GET /v1/messages/5"]);
  });

  it("getMessageWithBody resolves a short id prefix and returns null on no match", async () => {
    const full = "aa11bb22-cc33-dd44-ee55-ff6600112233";
    const { ds } = make([{ ...v1("9"), id: full, body_text: "prefixed body" }]);
    const hit = await ds.getMessageWithBody("aa11bb22");
    expect(hit?.msg.id).toBe(full);
    expect(hit?.body.text).toBe("prefixed body");
    expect(await ds.getMessageWithBody("nomatch0")).toBeNull();
  });

  it("reads provider-prefixed full ids directly without a resolving scan", async () => {
    const prefixed = "legacy-inbound:31f40200-dc2c-48ba-a348-ed7d4414381e";
    const { ds, serve } = make([{ ...v1("9"), id: prefixed, subject: "prefixed direct" }]);

    expect((await ds.getMessage(prefixed))?.subject).toBe("prefixed direct");
    expect(serve.requests).toEqual([
      "GET /v1/messages/legacy-inbound%3A31f40200-dc2c-48ba-a348-ed7d4414381e",
    ]);
  });

  it("gets a message + body by id", async () => {
    const { ds } = make([v1("5", { body_text: "hello world", cc_addrs: ["cc@x.com"] })]);
    const msg = await ds.getMessage("5");
    expect(msg?.subject).toBe("subject 5");
    const body = await ds.getMessageBody(msg!);
    expect(body?.text).toBe("hello world");
    expect(body?.cc).toBe("cc@x.com");
  });

  it("sends via POST /messages/send and deletes via DELETE", async () => {
    const { ds, serve } = make([]);
    const res = await ds.send({ to: "a@x.com, b@x.com", from: "me@hasna.com", subject: "hi", body: "yo", markdown: false });
    expect(res.id).toBe("posted-1");
    expect(serve.posted).toHaveLength(1);
    expect((serve.posted[0] as { to: string[] }).to).toEqual(["a@x.com", "b@x.com"]);
    await ds.deleteMessage("posted-1");
    expect(serve.deleted).toContain("posted-1");
  });

  it("returns verification candidates scoped to the recipient address", async () => {
    const { ds, serve } = make([
      v1("2", { to_addrs: ["andrei@hasna.com"], subject: "code 123456" }),
      v1("3", { to_addrs: ["other@hasna.com"], subject: "nope" }),
    ]);
    const cands = await ds.verificationCandidates("andrei@hasna.com");
    expect(cands.map((c) => c.id)).toEqual(["2"]);
    expect(serve.requests).toContain("GET /v1/messages?limit=50&direction=inbound&to=andrei%40hasna.com");
  });

  it("pushes verification sender and subject filters to the self-hosted server", async () => {
    const { ds, serve } = make([
      v1("2", { from_addr: "ChatGPT <noreply@tm.openai.com>", to_addrs: ["andrei@hasna.com"], subject: "Your ChatGPT code", body_text: "code 123456" }),
      v1("3", { from_addr: "Other <nope@example.com>", to_addrs: ["andrei@hasna.com"], subject: "Your ChatGPT code", body_text: "code 999999" }),
    ]);
    const latest = await ds.findLatest("andrei@hasna.com", { from: "openai", subject: "ChatGPT" });
    expect(latest?.email.id).toBe("2");
    expect(serve.requests).toContain("GET /v1/messages?limit=50&direction=inbound&to=andrei%40hasna.com&from=openai&subject=ChatGPT");
  });

  it("fetches message detail for verification bodies when list rows are lean", async () => {
    const { ds, serve } = make([
      v1("2", { from_addr: "ChatGPT <noreply@tm.openai.com>", to_addrs: ["andrei@hasna.com"], subject: "Your ChatGPT code", body_text: "code 123456", body_html: "<p>code 123456</p>" }),
    ], { leanList: true });

    const latest = await ds.findLatest("andrei@hasna.com", { from: "openai", subject: "ChatGPT" });

    expect(latest?.code).toBe("123456");
    expect(serve.requests).toContain("GET /v1/messages?limit=50&direction=inbound&to=andrei%40hasna.com&from=openai&subject=ChatGPT");
    expect(serve.requests).toContain("GET /v1/messages/2");
  });

  it("locally verifies verification filters when a stale server ignores them", async () => {
    const { ds, serve } = make([
      v1("newer-wrong-subject", { from_addr: "ChatGPT <noreply@tm.openai.com>", to_addrs: ["andrei@hasna.com"], subject: "Marketing", body_text: "code 999999", received_at: "2026-07-13T12:00:00.000Z" }),
      v1("right", { from_addr: "ChatGPT <noreply@tm.openai.com>", to_addrs: ["andrei@hasna.com"], subject: "Your ChatGPT code", body_text: "code 123456", received_at: "2026-07-13T11:00:00.000Z" }),
      v1("wrong-to", { from_addr: "ChatGPT <noreply@tm.openai.com>", to_addrs: ["other@hasna.com"], subject: "Your ChatGPT code", body_text: "code 111111", received_at: "2026-07-13T10:00:00.000Z" }),
    ], { ignoreListFilters: true });

    const latest = await ds.findLatest("andrei@hasna.com", { from: "openai", subject: "ChatGPT" });

    expect(latest?.email.id).toBe("right");
    expect(latest?.code).toBe("123456");
    expect(serve.requests).toContain("GET /v1/messages?limit=50&direction=inbound&to=andrei%40hasna.com&from=openai&subject=ChatGPT");
  });

  it("persists mailbox mutations through the self-hosted serve", async () => {
    const { ds, serve } = make([v1("2")]);
    await ds.setRead("2", true);
    await ds.setStarred("2", true);
    expect(await ds.addLabel("2", "x")).toContain("x");
    await ds.setArchived("2", true);
    expect(serve.rows.get("2")).toMatchObject({ is_read: true, is_starred: true });
    expect(serve.rows.get("2")?.["labels"]).toEqual(expect.arrayContaining(["x", "archived"]));
    expect(await ds.removeLabel("2", "x")).not.toContain("x");
  });

  it("keeps catalog-safe label and mark-read operations idempotent without destructive calls", async () => {
    const originalAttachments = [{ filename: "invoice.txt", content_type: "text/plain", size: 5 }];
    const { ds, serve } = make([v1("safe", { attachments: originalAttachments })]);
    await ds.addLabel("safe", "catalog/action-required");
    await ds.addLabel("safe", "catalog/action-required");
    await ds.setRead("safe", true);
    await ds.setRead("safe", true);

    expect(serve.rows.get("safe")?.["labels"]).toEqual(["catalog/action-required"]);
    expect(serve.rows.get("safe")?.["is_read"]).toBe(true);
    expect(serve.rows.get("safe")?.["attachments"]).toEqual(originalAttachments);
    expect(serve.requests.some((request) => request.startsWith("DELETE "))).toBe(false);
    expect(serve.requests.some((request) => /archive|trash|spam|remove/i.test(request))).toBe(false);
  });

  it("supports explicit-id bulk mutations and rejects scheduled sends honestly", async () => {
    const { ds, serve } = make([v1("2"), v1("3")]);
    const result = await ds.bulk({ action: "read", ids: ["2", "3"] });
    expect(result).toMatchObject({ affected: 2, matched: 2 });
    expect(serve.rows.get("2")?.["is_read"]).toBe(true);
    expect(serve.rows.get("3")?.["is_read"]).toBe(true);
    await expect(ds.send({
      to: "a@example.com",
      from: "me@example.com",
      subject: "later",
      body: "body",
      scheduledAt: "2030-01-01T00:00:00.000Z",
    })).rejects.toThrow(/Scheduled send is not supported/);
    expect(serve.posted).toHaveLength(0);
  });

  it("keeps self-hosted attachment access metadata-only without local writes", async () => {
    const home = mkdtempSync(join(tmpdir(), "emails-attachment-test-"));
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const id = "..%2F..%2Foperator-secret";
      const { ds, serve } = make([v1(id, {
        attachments: [{ filename: "../../secret.txt", content_type: "text/plain", size: 5 }],
        _attachment_contents: [Buffer.from("hello").toString("base64")],
      })]);
      const msg = await ds.getMessage(id);
      const body = await ds.getMessageBody(msg!);
      const paths = await ds.getAttachmentPaths(id);
      expect(body?.attachments).toEqual([{ filename: "../../secret.txt", content_type: "text/plain", size: 5 }]);
      expect(paths).toEqual([{ filename: "../../secret.txt", content_type: "text/plain", size: 5 }]);
      expect(paths[0]!.local_path).toBeUndefined();
      expect(paths[0]!.s3_url).toBeUndefined();
      expect(serve.requests.some((request) => request.includes("/attachments/"))).toBe(false);
      expect(existsSync(join(home, ".hasna"))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("downloads one exact attachment through the typed boundary without writing locally", async () => {
    const id = "attachment-message";
    const { ds, serve } = make([v1(id, {
      attachments: [{ filename: "invoice.txt", content_type: "text/plain", size: 5 }],
      _attachment_contents: ["aGVsbG8="],
    })]);
    const content = await ds.getAttachmentContent(id, 0, { maxBytes: 16 });
    expect(content).toMatchObject({
      state: "available",
      index: 0,
      filename: "invoice.txt",
      content_type: "text/plain",
      bytes: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
    expect(serve.requests).toContain(`GET /v1/messages/${id}/attachments/0?max_bytes=16`);
  });

  it("returns an explicit metadata-only state and rejects malformed stored payloads", async () => {
    const { ds } = make([
      v1("metadata", { attachments: [{ filename: "invoice.pdf", content_type: "application/pdf", size: 12 }] }),
      v1("legacy-null", {
        attachments: [{
          filename: "legacy.pdf",
          content_type: "application/pdf",
          size: null,
          content_base64: "must-not-leak",
          diagnostic: "must-not-leak",
        }],
      }),
      v1("malformed", {
        attachments: [{ filename: "bad.bin", content_type: "application/octet-stream", size: 3 }],
        _attachment_contents: ["%%%="],
      }),
    ]);
    expect(await ds.getAttachmentContent("metadata", 0, { maxBytes: 1024 })).toEqual({
      state: "content_unavailable",
      index: 0,
      filename: "invoice.pdf",
      content_type: "application/pdf",
      bytes: 12,
    });
    const legacy = await ds.getAttachmentContent("legacy-null", 0, { maxBytes: 1024 });
    expect(legacy).toEqual({
      state: "content_unavailable",
      index: 0,
      filename: "legacy.pdf",
      content_type: "application/pdf",
      bytes: null,
    });
    expect(JSON.stringify(legacy)).not.toContain("must-not-leak");
    await expect(ds.getAttachmentContent("malformed", 0, { maxBytes: 1024 })).rejects.toThrow(/base64/i);
    expect(await ds.getAttachmentContent("metadata", 9, { maxBytes: 1024 })).toEqual({ state: "not_found", index: 9 });
  });

  it("refuses redirects before reading a response body or allowing fetch to forward the bearer header", async () => {
    let observedRedirect: RequestInit["redirect"];
    let bodyReads = 0;
    let requests = 0;
    const redirectingFetch: SelfHostedFetch = async (_url, init) => {
      requests++;
      observedRedirect = init.redirect;
      return {
        status: 302,
        async text() {
          bodyReads++;
          return JSON.stringify({ location: "https://attacker.example/collect" });
        },
      };
    };
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "redirect-regression-key",
      fetchImpl: redirectingFetch,
    });

    await expect(ds.listMailbox("inbox")).rejects.toThrow(/redirect.*refused/i);
    expect(observedRedirect).toBe("manual");
    expect(requests).toBe(1);
    expect(bodyReads).toBe(0);
  });

  it("makes zero cross-origin requests when native fetch receives a redirect", async () => {
    let targetRequests = 0;
    let targetAuthorization: string | null = null;
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        targetRequests++;
        targetAuthorization = request.headers.get("authorization");
        return Response.json({ messages: [] });
      },
    });
    const redirector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${target.port}/collect` },
        });
      },
    });
    try {
      const ds = new SelfHostedMailDataSource({
        baseUrl: `http://127.0.0.1:${redirector.port}/v1`,
        apiKey: "native-redirect-regression-key",
      });
      await expect(ds.listMailbox("inbox")).rejects.toThrow(/redirect.*refused/i);
      expect(targetRequests).toBe(0);
      expect(targetAuthorization).toBeNull();
    } finally {
      redirector.stop(true);
      target.stop(true);
    }
  });

  it("fails fast and loud (never hangs) when the serve stalls past the timeout", async () => {
    // A fetch that respects the AbortSignal, resolving only when aborted — models
    // a hung endpoint. With a tiny timeout the read must REJECT, never hang, and
    // never resolve to an empty list with a success exit.
    const hangingFetch: SelfHostedFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      }) as unknown as ReturnType<SelfHostedFetch>;
    const ds = new SelfHostedMailDataSource({
      baseUrl: "https://emails.example/v1",
      apiKey: "test-key",
      fetchImpl: hangingFetch,
      timeoutMs: 25,
    });
    const started = Date.now();
    await expect(ds.listMailbox("inbox")).rejects.toThrow(/timed out after 25ms/);
    // Well under any external 2-minute wall.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("resolveMailDataSource — self-hosted seam selection", () => {
  it("selects self_hosted only from explicit mode, URL, and key", () => {
    process.env["EMAILS_MODE"] = "self_hosted";
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "k";
    resetSelfHostedConfigCache();
    resetMailDataSource();
    const ds = resolveMailDataSource();
    expect(ds.constructor.name).toBe("SelfHostedMailDataSource");
    expect(ds.mode).toBe("self_hosted");
    expect(resolveSelfHostedMailDataSource()).toBeInstanceOf(SelfHostedMailDataSource);
  });

  it("does not construct a self-hosted client while local mode is selected", () => {
    process.env["EMAILS_MODE"] = "local";
    resetSelfHostedConfigCache();
    resetMailDataSource();
    expect(resolveSelfHostedMailDataSource()).toBeNull();
  });
});
