import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.local.js";
import { getSandboxCount } from "../db/sandbox.local.js";
import { storeInboundEmail } from "../db/inbound.local.js";
import { resetMailDataSource, resolveMailDataSource, SqliteMailDataSource } from "./mail-data-source.js";

beforeEach(() => {
  process.env["EMAILS_MODE"] = "local";
  process.env["EMAILS_DB_PATH"] = ":memory:";
  delete process.env["EMAILS_SELF_HOSTED_URL"];
  delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
  resetDatabase();
  resetMailDataSource();
});

afterEach(() => {
  closeDatabase();
  resetDatabase();
  resetMailDataSource();
  delete process.env["EMAILS_MODE"];
  delete process.env["EMAILS_DB_PATH"];
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

  it("finds verification codes from the local recipient index", async () => {
    const stored = seedInbound();
    const found = await resolveMailDataSource().findLatest("ops@example.test");
    expect(found).toMatchObject({ code: "123456", email: { id: stored.id } });
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
    expect(getSandboxCount(provider.id)).toBe(1);
  });
});
