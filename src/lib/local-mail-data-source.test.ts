import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.local.js";
import { getSandboxCount } from "../db/sandbox.js";
import { storeInboundEmail } from "../db/inbound.local.js";
import { resetMailDataSource, resolveMailDataSource, SqliteMailDataSource } from "./mail-data-source.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}
function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

const attachmentDirs: string[] = [];

function clearMailModeEnv(): void {
  for (const key of [
    "EMAILS_MODE",
    "MAILERY_MODE",
    "HASNA_EMAILS_MODE",
    "HASNA_MAILERY_MODE",
    "EMAILS_SELF_HOSTED_URL",
    "MAILERY_SELF_HOSTED_URL",
    "HASNA_EMAILS_SELF_HOSTED_URL",
    "HASNA_MAILERY_SELF_HOSTED_URL",
    "EMAILS_SELF_HOSTED_API_KEY",
    "MAILERY_SELF_HOSTED_API_KEY",
    "HASNA_EMAILS_SELF_HOSTED_API_KEY",
    "HASNA_MAILERY_SELF_HOSTED_API_KEY",
    "EMAILS_API_KEY",
    "MAILERY_API_KEY",
    "HASNA_EMAILS_API_KEY",
    "HASNA_MAILERY_API_KEY",
    "EMAILS_CLIENT_ENV_SECRET",
    "MAILERY_CLIENT_ENV_SECRET",
  ]) {
    delete process.env[key];
  }
}

beforeEach(() => {
  captureInheritedProcessEnv();
  clearMailModeEnv();
  process.env["EMAILS_MODE"] = "local";
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  resetMailDataSource();
});

afterEach(() => {
  closeDatabase();
  resetDatabase();
  resetMailDataSource();
  clearMailModeEnv();
  delete process.env["EMAILS_DB_PATH"];
  for (const dir of attachmentDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  restoreInheritedProcessEnv();
});

function seedInbound() {
  return storeInboundEmail({
    provider_id: null,
    message_id: "<local-source@example.test>",
    in_reply_to_email_id: null,
    from_address: "sender@example.test",
    to_addresses: ["ops@example.test"],
    cc_addresses: [],
    subject: "Local source contract",
    text_body: "Your verification code is 123456",
    html_body: null,
    attachments: [],
    attachment_paths: [],
    headers: { "Message-ID": "<local-source@example.test>" },
    raw_size: 32,
    received_at: "2026-07-14T10:00:00.000Z",
  });
}

function seedInsertion(subject: string, receivedAt: string) {
  return storeInboundEmail({
    provider_id: null,
    message_id: `<${subject}-${crypto.randomUUID()}@example.test>`,
    in_reply_to_email_id: null,
    from_address: "sender@example.test",
    to_addresses: ["ops@example.test"],
    cc_addresses: [],
    subject,
    text_body: subject,
    html_body: null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: subject.length,
    received_at: receivedAt,
  });
}

function seedAttachmentInbound(
  attachments: Array<{ filename: string; content_type: string; size: number }>,
  attachmentPaths: Array<{
    index?: number;
    filename: string;
    content_type: string;
    size: number;
    local_path?: string;
    s3_url?: string;
  }>,
) {
  return storeInboundEmail({
    provider_id: null,
    message_id: `<attachment-${crypto.randomUUID()}@example.test>`,
    in_reply_to_email_id: null,
    from_address: "sender@example.test",
    to_addresses: ["ops@example.test"],
    cc_addresses: [],
    subject: "Attachment mapping contract",
    text_body: "attached",
    html_body: null,
    attachments,
    attachment_paths: attachmentPaths,
    headers: {},
    raw_size: 32,
    received_at: "2026-07-14T10:00:00.000Z",
  });
}

function attachmentFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "emails-local-attachment-"));
  attachmentDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

describe("SqliteMailDataSource", () => {
  it("is selected by explicit local mode and by the safe default", () => {
    expect(resolveMailDataSource()).toBeInstanceOf(SqliteMailDataSource);
    resetMailDataSource();
    delete process.env["EMAILS_MODE"];
    expect(resolveMailDataSource()).toBeInstanceOf(SqliteMailDataSource);
  });

  it("reads bodies and persists mailbox mutations in SQLite", async () => {
    const stored = seedInbound();
    const source = resolveMailDataSource();

    expect((await source.listMailbox("inbox")).map((row) => row.id)).toEqual([stored.id]);
    const detail = await source.getMessageWithBody(stored.id);
    expect(detail?.body.text).toContain("123456");

    await source.setRead(stored.id, true);
    await source.setStarred(stored.id, true);
    await source.addLabel(stored.id, "Action Required");
    const updated = await source.getMessage(stored.id);
    expect(updated).toMatchObject({ is_read: true, is_starred: true });
    expect(updated?.labels).toContain("Action Required");
  });

  it("rejects inherited object keys as bulk actions", async () => {
    const stored = seedInbound();
    const source = resolveMailDataSource();

    await expect(source.bulk({ action: "constructor", ids: [stored.id] }))
      .rejects.toThrow("unsupported local bulk action 'constructor'");
    expect((await source.getMessage(stored.id))?.is_read).toBe(false);
  });

  it("finds verification codes from the local recipient index", async () => {
    const stored = seedInbound();
    const found = await resolveMailDataSource().findLatest("ops@example.test");
    expect(found).toMatchObject({ code: "123456", email: { id: stored.id } });
  });

  it("paginates the insert-only seam deterministically without returning a terminal cursor early", async () => {
    const receivedAt = "2026-07-20T10:00:00.000Z";
    const rows = [
      seedInsertion("insert-a", receivedAt),
      seedInsertion("insert-b", receivedAt),
      seedInsertion("insert-c", "2026-07-19T10:00:00.000Z"),
    ];
    const expectedIds = rows
      .slice()
      .sort((left, right) =>
        right.received_at.localeCompare(left.received_at)
        || right.id.localeCompare(left.id))
      .map((row) => row.id);
    const source = resolveMailDataSource();

    const first = await source.listInsertionsSince({ limit: 1 });
    expect(first.cursor).not.toBeNull();
    const second = await source.listInsertionsSince({ limit: 1, cursor: first.cursor! });
    expect(second.cursor).not.toBeNull();
    const third = await source.listInsertionsSince({ limit: 1, cursor: second.cursor! });
    expect(third.cursor).toBeNull();

    expect([
      first.insertions[0]?.id,
      second.insertions[0]?.id,
      third.insertions[0]?.id,
    ]).toEqual(expectedIds);
    expect(new Set([first.cursor, second.cursor]).size).toBe(2);
  });

  it("rejects malformed or query-mismatched insertion cursors instead of restarting or cycling", async () => {
    seedInsertion("insert-cursor", "2026-07-20T10:00:00.000Z");
    const source = resolveMailDataSource();
    const first = await source.listInsertionsSince({
      receivedSince: "2026-07-01T00:00:00.000Z",
      limit: 1,
    });

    await expect(source.listInsertionsSince({ cursor: "not-a-cursor", limit: 1 }))
      .rejects.toThrow(/cursor/i);
    if (first.cursor) {
      await expect(source.listInsertionsSince({
        receivedSince: "2026-07-02T00:00:00.000Z",
        cursor: first.cursor,
        limit: 1,
      })).rejects.toThrow(/cursor/i);
    }
  });

  it("keeps a descending insertion walk monotonic when a newer row arrives between pages", async () => {
    seedInsertion("original-new", "2026-07-20T10:00:00.000Z");
    seedInsertion("original-old", "2026-07-19T10:00:00.000Z");
    const source = resolveMailDataSource();
    const first = await source.listInsertionsSince({ limit: 1 });
    expect(first.cursor).not.toBeNull();

    const insertedLater = seedInsertion("arrived-after-page-one", "2026-07-21T10:00:00.000Z");
    const second = await source.listInsertionsSince({ limit: 10, cursor: first.cursor! });

    expect(second.insertions.map((row) => row.subject)).toEqual(["original-old"]);
    expect(second.insertions.some((row) => row.id === insertedLater.id)).toBe(false);
    expect(second.cursor).toBeNull();
  });

  it("resolves a sanitized original filename through its indexed local path", async () => {
    const path = attachmentFile("000000-invoice_.pdf", "first");
    const stored = seedAttachmentInbound(
      [{ filename: "invoice?.pdf", content_type: "application/pdf", size: 5 }],
      [{ index: 0, filename: "invoice?.pdf", content_type: "application/pdf", size: 5, local_path: path }],
    );

    const content = await resolveMailDataSource().getAttachmentContent(stored.id, 0);
    expect(content).toMatchObject({
      state: "available",
      index: 0,
      filename: "invoice?.pdf",
      bytes: 5,
    });
    if (content.state !== "available") throw new Error("indexed fixture must be available");
    expect(Buffer.from(content.data).toString("utf8")).toBe("first");
  });

  it("fails closed when indexed paths are duplicated or no longer match metadata order", async () => {
    const firstPath = attachmentFile("000000-first.txt", "first");
    const secondPath = attachmentFile("000001-second.txt", "second");
    const reordered = seedAttachmentInbound(
      [
        { filename: "first.txt", content_type: "text/plain", size: 5 },
        { filename: "second.txt", content_type: "text/plain", size: 6 },
      ],
      [
        { index: 0, filename: "second.txt", content_type: "text/plain", size: 6, local_path: secondPath },
        { index: 1, filename: "first.txt", content_type: "text/plain", size: 5, local_path: firstPath },
      ],
    );
    expect(await resolveMailDataSource().getAttachmentContent(reordered.id, 0))
      .toMatchObject({ state: "content_unavailable", index: 0 });

    const duplicateIndex = seedAttachmentInbound(
      [{ filename: "first.txt", content_type: "text/plain", size: 5 }],
      [
        { index: 0, filename: "first.txt", content_type: "text/plain", size: 5, local_path: firstPath },
        { index: 0, filename: "first.txt", content_type: "text/plain", size: 5, local_path: secondPath },
      ],
    );
    expect(await resolveMailDataSource().getAttachmentContent(duplicateIndex.id, 0))
      .toMatchObject({ state: "content_unavailable", index: 0 });
  });

  it("supports a unique legacy sanitized basename but rejects ambiguous legacy duplicates", async () => {
    const legacyPath = attachmentFile("invoice_.pdf", "first");
    const unique = seedAttachmentInbound(
      [{ filename: "invoice?.pdf", content_type: "application/pdf", size: 5 }],
      [{ filename: "invoice_.pdf", content_type: "application/pdf", size: 5, local_path: legacyPath }],
    );
    const content = await resolveMailDataSource().getAttachmentContent(unique.id, 0);
    expect(content).toMatchObject({ state: "available", filename: "invoice?.pdf", bytes: 5 });

    const secondPath = attachmentFile("duplicate-2.txt", "other");
    const ambiguous = seedAttachmentInbound(
      [
        { filename: "duplicate.txt", content_type: "text/plain", size: 5 },
        { filename: "duplicate.txt", content_type: "text/plain", size: 5 },
      ],
      [
        { filename: "duplicate.txt", content_type: "text/plain", size: 5, local_path: legacyPath },
        { filename: "duplicate.txt", content_type: "text/plain", size: 5, local_path: secondPath },
      ],
    );
    expect(await resolveMailDataSource().getAttachmentContent(ambiguous.id, 0))
      .toMatchObject({ state: "content_unavailable", index: 0 });
  });

  it("sends through a local sandbox provider and records the sent ledger", async () => {
    const provider = createProvider({ name: "local-sandbox", type: "sandbox" });
    const result = await resolveMailDataSource().send({
      providerId: provider.id,
      from: "ops@example.test",
      to: "recipient@example.test",
      subject: "Local sandbox send",
      body: "hello from SQLite",
      markdown: false,
    });
    expect(result.id).toBeTruthy();
    expect(result.messageId).toBeTruthy();
    expect(await getSandboxCount(provider.id)).toBe(1);
  });
});
