// Self-hosted-ONLY mail architecture. The former local-SQLite mail architecture
// (ensureMailArchitecture, rebuildInboundCanonicalState, backfillLegacyS3RawUrls,
// the mail_messages/mailbox_message_state tables, migration triggers, FK cascades,
// canonical dedupe) lived entirely in the deleted src/db/database.ts and is GONE.
//
// The whole original file — every test drove getDatabase()/new Database(":memory:")
// with raw SQL, PRAGMA table_info, sqlite_master trigger/index inspection, and the
// canonical-state rebuild — covered deleted local behavior and is DELETED.
//
// What survives as REAL client behavior over /v1 (and is exercised here against the
// out-of-process /v1 stub, see src/test-support/v1-stub.ts):
//   - mailbox projection reads (getMailbox / getMailboxByAddress / listMailboxes)
//   - a single canonical message read (getMailMessage) mapped from /v1/messages
//   - mailbox source provenance CRUD (createMailboxSource / getMailboxSource /
//     listMailboxSources) with the provider snapshot captured client-side
//   - the server-owned provisioning stubs failing loud (rule 6)

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { createProvider } from "./providers.js";
import {
  createMailFolder,
  createMailbox,
  ensureDefaultMailFolders,
  getMailbox,
  getMailboxByAddress,
  getMailboxFolderByRole,
  listMailFolders,
  listMailboxes,
} from "./mailboxes.js";
import { createMailboxSource, getMailboxSource, listMailboxSources } from "./sources.js";
import {
  createMailMessage,
  getMailMessage,
  listMailboxMessageStates,
  upsertMailboxMessageState,
} from "./messages.js";

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

describe("mail architecture — /v1 projection reads", () => {
  it("reads the /v1 mailbox projection, mapped and sorted by address", async () => {
    await stub.seed({
      mailboxes: [
        { id: "mbx:b", address: "b@example.com", display_name: "B", status: "active", created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" },
        { id: "mbx:a", address: "a@example.com", display_name: "A", status: "active", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
      ],
    });

    expect(listMailboxes().map((mb) => mb.address)).toEqual(["a@example.com", "b@example.com"]);
    expect(getMailbox("mbx:a")?.display_name).toBe("A");
    expect(getMailboxByAddress("a@example.com")?.id).toBe("mbx:a");
    expect(getMailbox("missing")).toBeNull();
  });

  it("reads a single canonical message mapped from /v1/messages", async () => {
    await stub.seed({
      messages: [
        {
          id: "msg-1",
          direction: "inbound",
          message_id: "<rfc-1@example.net>",
          subject: "Hello",
          from_addr: "sender@example.net",
          to_addrs: ["ops@example.com"],
          body_text: "text body",
          received_at: "2026-02-01T00:00:00.000Z",
          created_at: "2026-02-01T00:00:00.000Z",
          updated_at: "2026-02-01T00:00:00.000Z",
        },
      ],
    });

    const message = getMailMessage("msg-1")!;
    expect(message.subject).toBe("Hello");
    expect(message.rfc_message_id).toBe("<rfc-1@example.net>");
    expect(message.from_address).toBe("sender@example.net");
    expect(message.to_addresses).toEqual(["ops@example.com"]);
    expect(message.text_body).toBe("text body");
    expect(message.received_at).toBe("2026-02-01T00:00:00.000Z");
    expect(message.sent_at).toBeNull();
    expect(getMailMessage("missing")).toBeNull();
  });
});

describe("mail architecture — mailbox source provenance", () => {
  it("records a mailbox source with a captured provider snapshot", () => {
    const ses = createProvider({ name: "SES inbound", type: "ses", region: "us-east-1" });
    const active = createMailboxSource({
      mailbox_id: "mbx:ops",
      provider_id: ses.id,
      type: "ses_s3",
      name: "SES S3 inbound",
      external_mailbox: "ops@example.com",
      status: "active",
      settings: { bucket: "emails-test-bucket", prefix: "inbound/example.com/" },
    });
    const legacy = createMailboxSource({
      mailbox_id: "mbx:ops",
      type: "legacy_inbound",
      name: "Legacy import",
      external_mailbox: "ops@example.com",
      status: "legacy",
    });

    expect(active.provider_snapshot).toMatchObject({ id: ses.id, name: "SES inbound", type: "ses" });
    expect(active.settings).toEqual({ bucket: "emails-test-bucket", prefix: "inbound/example.com/" });
    expect(getMailboxSource(active.id)?.type).toBe("ses_s3");

    // Sorted by status, then type, then created_at (active before legacy).
    const sources = listMailboxSources("mbx:ops");
    expect(sources.map((s) => [s.id, s.type, s.status])).toEqual([
      [active.id, "ses_s3", "active"],
      [legacy.id, "legacy_inbound", "legacy"],
    ]);
    // Other mailboxes do not see these sources.
    expect(listMailboxSources("mbx:other")).toEqual([]);
  });
});

describe("mail architecture — server-owned provisioning fails loud", () => {
  it("stubs mailbox/folder/message-state writes that the server owns", () => {
    // DELETED (server-owned): the mail_messages/mailbox_message_state canonical
    // architecture, folder provisioning, S3 backfill, and migration triggers were
    // all LOCAL SQLite behavior. Those write/provision paths now fail loud.
    expect(() => createMailbox({ address: "ops@example.com" })).toThrow(/not available in the self-hosted client/i);
    expect(() => ensureDefaultMailFolders("mbx:ops")).toThrow(/not available in the self-hosted client/i);
    expect(() => createMailFolder({ mailbox_id: "mbx:ops", role: "inbox", name: "INBOX", path: "INBOX" })).toThrow(
      /not available in the self-hosted client/i,
    );
    expect(() => getMailboxFolderByRole("mbx:ops", "inbox")).toThrow(/not available in the self-hosted client/i);
    expect(() => listMailFolders("mbx:ops")).toThrow(/not available in the self-hosted client/i);
    expect(() => createMailMessage({ subject: "x", received_at: "2026-03-01T00:00:00.000Z" })).toThrow(
      /not available in the self-hosted client/i,
    );
    expect(() =>
      upsertMailboxMessageState({
        mailbox_id: "mbx:ops",
        mail_message_id: "msg-1",
        folder_id: "folder-1",
        source_id: "src-1",
        source_dedupe_key: "k",
        received_at: "2026-03-01T00:00:00.000Z",
      }),
    ).toThrow(/not available in the self-hosted client/i);
    expect(() => listMailboxMessageStates("mbx:ops")).toThrow(/not available in the self-hosted client/i);
  });
});
