// The S3 inbox-sync family, against BOTH real stores.
//
// WHAT THIS FILE USED TO BE, and why the change is the point. The previous version imported
// `syncS3Inbox` from `./s3-sync.remote.js` and asserted that it THREW — two cases whose entire
// content was a self-hosted stub's refusal message. That behaviour is gone with the arm, and
// nothing about it was worth keeping: the ingestion it refused now runs against whichever store
// the installation configured. The five source-registry cases and the attachment-planning case
// are preserved verbatim, because they cover code that did not change.
//
// TWO REAL STORES, NOT A DICTIONARY. The mail-bearing cases run against a local SQLite store
// AND against `src/test-support/v1-store-api.ts` — the fixture that translates the service's own
// routes onto an `EmailStore` and stores nothing itself. `src/test-support/v1-stub.ts` is
// deliberately NOT used: its generic list ignores equality filters and its patch handler is a
// blind merge, so a client that mis-mapped a field would be handed its own mistake back. The
// upsert fence this family now depends on is exactly the semantic that stub does not have.
//
// THE S3 SIDE IS MOCKED; THE MIME SIDE IS NOT. `@aws-sdk/client-s3` goes through the shared
// process-global mock (see its header for why it must be shared), but `GetObject` answers with
// REAL RFC 2822 bytes and the real `mailparser` parses them. A parser fixture would only prove
// this file agrees with itself.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setS3SendHandler, resetS3SendHandler, type S3Command } from "../test-support/aws-s3-mock.js";
import {
  backfillS3SourceIdsFromRawUrls,
  closeDatabase,
  getDatabase,
  resetDatabase,
  uuid,
  type Database,
} from "../db/database.js";
import { startV1StoreApi, type V1StoreApi } from "../test-support/v1-store-api.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome } from "../store/outcome.js";
import type { MessageInput, MessageRecord, ResourceRow } from "../store/records.js";
import { mergeAttachmentDetails } from "./attachment-actions.js";
import {
  listLiveS3Sources,
  listS3Sources,
  registerS3Source,
  retireS3Source,
  s3SyncLocalTestBoundary,
  syncS3Inbox,
  type S3SyncResult,
} from "./s3-sync.js";

let originalHome: string | undefined;
let tmpHome = "";
let db: Database;
let api: V1StoreApi;
let INHERITED_ENV: NodeJS.ProcessEnv;

const BUCKET = "inbound-test-bucket";
const PREFIX = "inbound/example.test/";

/** A minimal, real RFC 2822 message. Parsed by the real `mailparser`. */
function rawEmail(options: { subject: string; from?: string; to?: string; body?: string }): string {
  return [
    `From: ${options.from ?? "sender@example.test"}`,
    `To: ${options.to ?? "inbox@example.test"}`,
    `Subject: ${options.subject}`,
    "Date: Mon, 06 Jul 2026 12:00:00 +0000",
    "Message-ID: <upstream-id@example.test>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    options.body ?? "hello from s3",
  ].join("\r\n");
}

/** Route the S3 mock at a fixed set of objects under {@link PREFIX}. */
function serveObjects(objects: Record<string, string>): { listCalls: number; getCalls: string[] } {
  const stats = { listCalls: 0, getCalls: [] as string[] };
  setS3SendHandler(async (cmd: S3Command) => {
    if (cmd.__type === "ListObjectsV2") {
      stats.listCalls++;
      return {
        Contents: Object.keys(objects).map((key) => ({ Key: key, Size: objects[key]!.length })),
        IsTruncated: false,
      };
    }
    if (cmd.__type === "GetObject") {
      const key = String(cmd.input["Key"]);
      stats.getCalls.push(key);
      const body = objects[key];
      if (body === undefined) throw new Error(`no such test object: ${key}`);
      return { Body: [Buffer.from(body, "utf8")] };
    }
    if (cmd.__type === "PutObject") return {};
    return {};
  });
  return stats;
}

beforeEach(() => {
  INHERITED_ENV = { ...process.env };
  originalHome = process.env["HOME"];
  tmpHome = mkdtempSync(join(tmpdir(), "emails-s3-source-"));
  process.env["HOME"] = tmpHome;
  // EXACTLY ONE store is configured for this file, and the key list comes from
  // `src/store-resolution.ts` rather than being re-spelled here. Both a database path and an
  // API configured together is a BOOT ERROR, not a precedence rule, so an inherited API
  // setting from a developer's shell would fail these cases for the wrong reason.
  for (const key of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS, ...DATABASE_PATH_SETTINGS]) {
    delete process.env[key];
  }
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  db = getDatabase();
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "v1 fixture" }) });
  resetS3SendHandler();
});

afterEach(() => {
  resetS3SendHandler();
  api.stop();
  closeDatabase();
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_ENV);
});

interface Harness {
  readonly name: string;
  store(): EmailStore;
}

const sqliteHarness: Harness = {
  name: "a local SQLite store",
  store: () => createSqliteEmailStore({ database: db, detail: "SQLite in-memory (s3-sync test)" }),
};

const httpHarness: Harness = {
  name: "a real HTTP store in front of the seam",
  store: () => createHttpEmailStore({ baseUrl: api.baseUrl, credential: api.apiKey }),
};

const HARNESSES: readonly Harness[] = [sqliteHarness, httpHarness];

// ─── the pipeline, through the seam ───────────────────────────────────────────

for (const harness of HARNESSES) {
  describe(`syncS3Inbox against ${harness.name}`, () => {
    it("ingests an S3 object and records it as a message", async () => {
      serveObjects({ [`${PREFIX}obj-a`]: rawEmail({ subject: "first from s3" }) });
      const store = harness.store();

      const result = await syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, store });

      expect(result.errors).toEqual([]);
      expect(result.synced).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.last_key).toBe(`${PREFIX}obj-a`);

      // Read back THROUGH THE STORE, not out of a fixture dictionary.
      const listed = await store.messages.listMessages({ direction: "inbound", limit: 50 });
      if (!listed.ok) throw new Error(`could not list: ${listed.message}`);
      const rows = listed.value.items.filter((row) => row.subject === "first from s3");
      expect(rows).toHaveLength(1);
      // THE S3 URL SURVIVES, in both of the fields the deleted arm put it in that the seam has.
      expect(rows[0]!.source_id).toBe(`s3://${BUCKET}/${PREFIX}obj-a`);
      expect(rows[0]!.message_id).toBe(`s3://${BUCKET}/${PREFIX}obj-a`);
      expect(rows[0]!.direction).toBe("inbound");
    });

    it("fences a re-run on source_id: the second pass skips and creates NO second row", async () => {
      serveObjects({ [`${PREFIX}obj-a`]: rawEmail({ subject: "fenced" }) });
      const store = harness.store();

      const first = await syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, store });
      expect(first.synced).toBe(1);

      const second = await syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, store });
      // THE POSITIVE CONTROL IS THE ROW COUNT, not just the counter. A `skipped: 1` with two
      // rows in the table would be the exact defect this fence exists to prevent, and the
      // counter alone cannot tell the two apart.
      expect(second.errors).toEqual([]);
      expect(second.skipped).toBe(1);
      expect(second.synced).toBe(0);

      const listed = await store.messages.listMessages({ direction: "inbound", limit: 50 });
      if (!listed.ok) throw new Error(`could not list: ${listed.message}`);
      expect(listed.value.items.filter((row) => row.subject === "fenced")).toHaveLength(1);
    });

    it("counts the LIMIT against new objects, so a mostly-ingested prefix still makes progress", async () => {
      serveObjects({
        [`${PREFIX}a`]: rawEmail({ subject: "a" }),
        [`${PREFIX}b`]: rawEmail({ subject: "b" }),
        [`${PREFIX}c`]: rawEmail({ subject: "c" }),
      });
      const store = harness.store();

      const first = await syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, limit: 1, store });
      expect(first.synced).toBe(1);

      // Two objects are already stored on the third run; a limit of 1 must still reach the one
      // that is NOT, rather than spending its budget on the two it has already seen.
      const second = await syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, limit: 1, store });
      expect(second.synced).toBe(1);
      const third = await syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, limit: 1, store });
      expect(third.synced).toBe(1);

      const listed = await store.messages.listMessages({ direction: "inbound", limit: 50 });
      if (!listed.ok) throw new Error(`could not list: ${listed.message}`);
      expect(listed.value.items.filter((row) => ["a", "b", "c"].includes(row.subject ?? ""))).toHaveLength(3);
    });

    it("names the provider it could NOT record, once, and only when something was ingested", async () => {
      const providerId = await seedProvider(harness.store(), "ses-main");
      serveObjects({ [`${PREFIX}obj-a`]: rawEmail({ subject: "with provider" }) });
      const store = harness.store();

      const ingested = await syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, providerId, store });
      expect(ingested.synced).toBe(1);
      // THE ABSENCE IS NAMED, not dropped. A run that accepted --provider and silently stored
      // nothing for it is indistinguishable at the call site from one that recorded it.
      expect(ingested.unrecorded.some((note) => note.includes(providerId))).toBe(true);
      expect(ingested.unrecorded.some((note) => note.includes("thread linkage"))).toBe(true);

      // GATED ON HAVING INGESTED SOMETHING. The second run stores nothing, so it lost nothing,
      // and a note on every empty poll is the noise that trains a reader to skip the field.
      const skipped = await syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, providerId, store });
      expect(skipped.synced).toBe(0);
      expect(skipped.unrecorded).toEqual([]);
    });

    it("refuses an unknown provider BEFORE downloading a single object", async () => {
      const stats = serveObjects({ [`${PREFIX}obj-a`]: rawEmail({ subject: "never read" }) });
      const store = harness.store();

      await expect(
        syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, providerId: "no-such-provider", store }),
      ).rejects.toThrow(/Provider not found: no-such-provider/);
      // The guard is worth nothing if it fires after the bytes are already paid for.
      expect(stats.getCalls).toEqual([]);
    });

    it("resolves an abbreviated provider id through the scan", async () => {
      const store = harness.store();
      // THE ID COMES FROM THE STORE. `providers.create` on the HTTP store REFUSES a
      // caller-supplied `id` — correctly, and by name: "/v1/providers has no column id, and the
      // write would have been accepted with that field silently dropped". So the abbreviation is
      // derived from whatever the store minted rather than chosen here. (The ambiguity case
      // cannot be built this way at all, and lives in the scan suite below where the page
      // contents are controlled directly.)
      const full = await seedProvider(store, "ses-alpha");
      serveObjects({ [`${PREFIX}obj-a`]: rawEmail({ subject: "abbreviated" }) });

      const abbreviated = full.slice(0, 8);
      expect(abbreviated.length).toBe(8);
      expect(abbreviated).not.toBe(full);

      const ok = await syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, providerId: abbreviated, store });
      expect(ok.synced).toBe(1);
      // Resolved to the FULL id, not echoed back as the abbreviation the caller passed.
      expect(ok.unrecorded.some((note) => note.includes(full))).toBe(true);
    });
  });
}

/** Create a provider through the store under test and return the id IT minted. */
async function seedProvider(store: EmailStore, name: string): Promise<string> {
  const created = await store.providers.create({ name, type: "ses", active: 1 });
  if (!created.ok) throw new Error(`could not seed a provider: ${created.message}`);
  const value = created.value["id"];
  if (typeof value !== "string" || value.length === 0) throw new Error("seeded provider has no id");
  return value;
}

// ─── the provider scan's paging contract ──────────────────────────────────────

describe("the abbreviated-provider scan", () => {
  /**
   * A store whose provider list returns FEWER rows than asked for on its first page and then
   * the rest — a legal answer (a clamped limit, a filtered page) that a scan terminating on a
   * SHORT page would read as end-of-table.
   */
  function shortPagingStore(base: EmailStore, rows: ResourceRow[]): EmailStore {
    return {
      ...base,
      providers: {
        ...base.providers,
        get: async (): Promise<Outcome<ResourceRow | null>> => ({ ok: true, value: null }),
        list: async (opts): Promise<Outcome<ResourceRow[]>> => {
          const offset = opts?.offset ?? 0;
          if (offset >= rows.length) return { ok: true, value: [] };
          // ONE row per call regardless of the requested limit.
          return { ok: true, value: [rows[offset]!] };
        },
      },
    };
  }

  it("terminates on an EMPTY page, not a short one, so a later provider is still found", async () => {
    serveObjects({ [`${PREFIX}obj-a`]: rawEmail({ subject: "short pages" }) });
    const base = createSqliteEmailStore({ database: db, detail: "short-paging base" });
    // The target sits LAST, so a scan that stopped at the first short page never sees it.
    const store = shortPagingStore(base, [
      { id: "zzz-1" },
      { id: "zzz-2" },
      { id: "target-9999" },
    ]);

    const result = await syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, providerId: "target-", store });
    expect(result.synced).toBe(1);
    expect(result.unrecorded.some((note) => note.includes("target-9999"))).toBe(true);
  });

  it("refuses an ambiguous prefix instead of picking the first match", async () => {
    serveObjects({ [`${PREFIX}obj-a`]: rawEmail({ subject: "ambiguous" }) });
    const base = createSqliteEmailStore({ database: db, detail: "ambiguous base" });
    // Two ids sharing a prefix. Neither store will mint such a pair on request — the HTTP store
    // refuses a caller-supplied id outright — so the pages are supplied directly.
    const store = shortPagingStore(base, [{ id: "abc11111-one" }, { id: "abc11111-two" }]);

    // PICKING ONE WOULD SHOW THE OPERATOR THE WRONG PROVIDER, and answering "not found" would
    // deny one that exists twice over.
    await expect(
      syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, providerId: "abc11111", store }),
    ).rejects.toThrow(/Ambiguous provider id "abc11111".*abc11111-one, abc11111-two/);
  });

  it("raises when the provider list refuses, instead of reporting the provider unknown", async () => {
    serveObjects({ [`${PREFIX}obj-a`]: rawEmail({ subject: "refused scan" }) });
    const base = createSqliteEmailStore({ database: db, detail: "refusing base" });
    const store: EmailStore = {
      ...base,
      providers: {
        ...base.providers,
        get: async (): Promise<Outcome<ResourceRow | null>> => ({ ok: true, value: null }),
        list: async (): Promise<Outcome<ResourceRow[]>> => ({
          ok: false,
          code: "capability_unavailable",
          message: "this fixture store declines to list providers",
          status: 501,
        }),
      },
    };

    // A REFUSAL IS NOT "NOT FOUND". Answering `Provider not found` here would tell the operator
    // to create a provider that already exists.
    await expect(
      syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, providerId: "abc", store }),
    ).rejects.toThrow(/cannot list providers to resolve abc \(capability_unavailable, 501\)/);
  });
});

// ─── the second write, and what happens when it refuses ───────────────────────

describe("attachment locations recorded through the seam", () => {
  it("records where the bytes went, on the attachment record", async () => {
    const withAttachment = [
      "From: sender@example.test",
      "To: inbox@example.test",
      "Subject: has an attachment",
      "Date: Mon, 06 Jul 2026 12:00:00 +0000",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "see attached",
      "--b1",
      'Content-Type: application/pdf; name="invoice.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="invoice.pdf"',
      "",
      Buffer.from("PDF-BYTES").toString("base64"),
      "--b1--",
      "",
    ].join("\r\n");
    serveObjects({ [`${PREFIX}att`]: withAttachment });
    const store = createSqliteEmailStore({ database: db, detail: "attachment recording" });

    const result = await syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, store });
    expect(result.errors).toEqual([]);
    expect(result.synced).toBe(1);
    expect(result.attachments_saved).toBe(1);

    const listed = await store.messages.listMessages({ direction: "inbound", limit: 50 });
    if (!listed.ok) throw new Error(`could not list: ${listed.message}`);
    const row = listed.value.items.find((item) => item.subject === "has an attachment");
    expect(row).toBeDefined();
    const full = await store.messages.getMessage(row!.id);
    if (!full.ok || full.value === null) throw new Error("could not re-read the message");
    const attachments = full.value.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!["filename"]).toBe("invoice.pdf");
    // THE LOCATION IS ON THE RECORD. `attachment_paths` is unreachable through the seam, so if
    // this is absent the bytes on disk are orphaned and nothing can find them.
    expect(typeof attachments[0]!["local_path"]).toBe("string");
    expect(readFileSync(String(attachments[0]!["local_path"]), "utf8")).toBe("PDF-BYTES");
  });

  it("RAISES when the location write refuses, rather than reporting a clean run", async () => {
    const withAttachment = [
      "From: sender@example.test",
      "To: inbox@example.test",
      "Subject: refused decoration",
      "Date: Mon, 06 Jul 2026 12:00:00 +0000",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain",
      "",
      "body",
      "--b1",
      'Content-Type: text/plain; name="note.txt"',
      'Content-Disposition: attachment; filename="note.txt"',
      "",
      "note",
      "--b1--",
      "",
    ].join("\r\n");
    serveObjects({ [`${PREFIX}att`]: withAttachment });
    const base = createSqliteEmailStore({ database: db, detail: "refusing second write" });

    // STATEFUL, and that is the point: the FIRST upsert must SUCCEED so the run reaches the
    // decoration write at all. A fixture that refused both would be caught by the first
    // refusal path and leave this one unasserted.
    let writes = 0;
    const store: EmailStore = {
      ...base,
      messages: {
        ...base.messages,
        upsertMessage: async (
          input: MessageInput,
        ): Promise<Outcome<{ record: MessageRecord; inserted: boolean }>> => {
          writes += 1;
          if (writes === 1) return base.messages.upsertMessage(input);
          return {
            ok: false,
            code: "conflict",
            message: "this fixture store declines the decoration write",
            status: 409,
          };
        },
      },
    };

    const result = await syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, store });
    // The refusal is caught by the per-object handler and lands in `errors` — it must NOT be
    // swallowed into a clean result, because the bytes are on disk and the row does not point
    // at them.
    expect(writes).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("record attachment locations");
    expect(result.errors[0]).toContain("conflict");
  });
});

// ─── the legacy fence adoption ────────────────────────────────────────────────

describe("adopting the old raw_s3_url dedup key as the seam fence", () => {
  function insertLegacyRow(id: string, rawS3Url: string | null, messageId: string, createdAt: string): void {
    db.run(
      `INSERT INTO inbound_emails (id, message_id, raw_s3_url, from_address, to_addresses, subject, created_at, received_at)
       VALUES (?, ?, ?, 'sender@example.test', '[]', 'legacy', ?, ?)`,
      [id, messageId, rawS3Url, createdAt, createdAt],
    );
    db.run("UPDATE inbound_emails SET source_id = NULL WHERE id = ?", [id]);
  }

  it("gives a legacy S3 row its raw_s3_url as source_id, so a re-sync SKIPS it", async () => {
    const key = `${PREFIX}legacy`;
    const url = `s3://${BUCKET}/${key}`;
    insertLegacyRow(uuid(), url, url, "2026-01-01T00:00:00.000Z");

    expect(backfillS3SourceIdsFromRawUrls(db)).toBe(1);

    serveObjects({ [key]: rawEmail({ subject: "should not be re-ingested" }) });
    const store = createSqliteEmailStore({ database: db, detail: "legacy fence" });
    const result = await syncS3Inbox({ bucket: BUCKET, prefix: PREFIX, store });

    // WITHOUT THE BACKFILL THIS IS `synced: 1` AND THE MAILBOX HAS TWO COPIES. That is the
    // regression this whole statement exists to prevent.
    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(1);
    const rows = db.query("SELECT COUNT(*) AS n FROM inbound_emails WHERE raw_s3_url = ?").get(url) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("claims a duplicated raw_s3_url for exactly ONE row instead of violating the unique index", () => {
    const url = `s3://${BUCKET}/${PREFIX}dupe`;
    insertLegacyRow("aaaa-earliest", url, url, "2026-01-01T00:00:00.000Z");
    insertLegacyRow("bbbb-later", url, url, "2026-02-01T00:00:00.000Z");

    // A bare `UPDATE … SET source_id = raw_s3_url` would abort on idx_inbound_source_id here.
    expect(backfillS3SourceIdsFromRawUrls(db)).toBe(1);

    const claimed = db
      .query("SELECT id FROM inbound_emails WHERE source_id = ?")
      .all(url) as Array<{ id: string }>;
    expect(claimed.map((row) => row.id)).toEqual(["aaaa-earliest"]);
  });

  it("leaves a non-S3 row alone: source_id means an upstream id, not any old message id", () => {
    insertLegacyRow(uuid(), null, "<plain-rfc-id@example.test>", "2026-01-01T00:00:00.000Z");
    insertLegacyRow(uuid(), "", "<another@example.test>", "2026-01-02T00:00:00.000Z");

    expect(backfillS3SourceIdsFromRawUrls(db)).toBe(0);
    const withSource = db
      .query("SELECT COUNT(*) AS n FROM inbound_emails WHERE source_id IS NOT NULL")
      .get() as { n: number };
    expect(withSource.n).toBe(0);
  });

  it("is idempotent: a second call changes nothing", () => {
    const url = `s3://${BUCKET}/${PREFIX}once`;
    insertLegacyRow(uuid(), url, url, "2026-01-01T00:00:00.000Z");
    expect(backfillS3SourceIdsFromRawUrls(db)).toBe(1);
    expect(backfillS3SourceIdsFromRawUrls(db)).toBe(0);
  });
});

// ─── the reader that makes the recorded location visible ──────────────────────

describe("mergeAttachmentDetails and a self-carrying location", () => {
  it("reads a location off the metadata entry when there is no separate path row", () => {
    const details = mergeAttachmentDetails(
      [{ filename: "invoice.pdf", content_type: "application/pdf", size: 9, local_path: "/tmp/x/invoice.pdf" }],
      [],
    );
    expect(details).toHaveLength(1);
    expect(details[0]!.location).toBe("/tmp/x/invoice.pdf");
    expect(details[0]!.location_type).toBe("local");
    expect(details[0]!.openable).toBe(true);
    expect(details[0]!.index).toBe(0);
  });

  it("prefers a separate path row over a self-carried one, so old rows read exactly as before", () => {
    const details = mergeAttachmentDetails(
      [{ filename: "invoice.pdf", content_type: "application/pdf", size: 9, local_path: "/tmp/self/invoice.pdf" }],
      [{ filename: "invoice.pdf", local_path: "/tmp/separate/invoice.pdf" }],
    );
    expect(details[0]!.location).toBe("/tmp/separate/invoice.pdf");
  });

  it("carries a self-declared s3 location, and marks it not openable", () => {
    const details = mergeAttachmentDetails(
      [{ filename: "a.bin", size: 1, s3_url: "s3://bucket/emails/id/000000-a.bin" }],
      [],
    );
    expect(details[0]!.location).toBe("s3://bucket/emails/id/000000-a.bin");
    expect(details[0]!.location_type).toBe("s3");
    expect(details[0]!.openable).toBe(false);
  });

  it("keeps the download index on the METADATA position when a nameless entry precedes", () => {
    const details = mergeAttachmentDetails(
      [
        { filename: "", size: 0 },
        { filename: "second.txt", size: 2, local_path: "/tmp/second.txt" },
      ],
      [],
    );
    // The nameless entry is skipped for display but still occupies index 0, so a self-carried
    // location must be looked up by the recorded index rather than by position in `details`.
    expect(details).toHaveLength(1);
    expect(details[0]!.index).toBe(1);
    expect(details[0]!.location).toBe("/tmp/second.txt");
  });

  it("adds no location when the metadata entry carries none", () => {
    const details = mergeAttachmentDetails([{ filename: "bare.txt", size: 3 }], []);
    expect(details[0]!.location).toBeUndefined();
    expect(details[0]!.openable).toBe(false);
  });
});

// ─── preserved verbatim: attachment storage planning ──────────────────────────

describe("local S3 attachment storage planning", () => {
  it("keeps colliding sanitized names in distinct indexed local paths and S3 keys", () => {
    const plans = s3SyncLocalTestBoundary.buildAttachmentStoragePlans([
      {
        filename: "invoice?.pdf",
        contentType: "application/pdf",
        size: 5,
        content: Buffer.from("first"),
      },
      {
        filename: "invoice*.pdf",
        contentType: "application/pdf",
        size: 6,
        content: Buffer.from("second"),
      },
    ]);

    expect(plans.map((plan) => plan.index)).toEqual([0, 1]);
    expect(plans.map((plan) => plan.filename)).toEqual(["invoice?.pdf", "invoice*.pdf"]);
    expect(new Set(plans.map((plan) => plan.storageLeaf)).size).toBe(2);
    expect(plans[0]!.storageLeaf).toStartWith("000000-");
    expect(plans[1]!.storageLeaf).toStartWith("000001-");
    expect(plans.every((plan) => Buffer.byteLength(plan.storageLeaf, "utf8") <= 240)).toBe(true);

    const outputDir = join(tmpHome, "stored-attachments");
    mkdirSync(outputDir, { recursive: true });
    const paths = plans.map((plan) => s3SyncLocalTestBoundary.storeLocalAttachment(plan, outputDir));
    expect(paths.map((path) => path.index)).toEqual([0, 1]);
    expect(paths.map((path) => path.filename)).toEqual(["invoice?.pdf", "invoice*.pdf"]);
    expect(new Set(paths.map((path) => path.local_path)).size).toBe(2);
    expect(readFileSync(paths[0]!.local_path!, "utf8")).toBe("first");
    expect(readFileSync(paths[1]!.local_path!, "utf8")).toBe("second");

    const keys = plans.map((plan) =>
      s3SyncLocalTestBoundary.attachmentS3Key("mail/", "message-id", plan.storageLeaf));
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((key) => key.startsWith("mail/message-id/"))).toBe(true);
  });
});

// ─── preserved verbatim: the source registry is config, not storage ───────────

describe("S3 source registry (client config)", () => {
  it("registers a source and lists it back", () => {
    const source = registerS3Source({
      bucket: "inbound-bucket",
      prefix: "inbound/example.com/",
      region: "eu-west-1",
      providerId: "prov-1",
      status: "live",
      liveSyncEnabled: true,
    });

    expect(source).toMatchObject({
      type: "s3",
      bucket: "inbound-bucket",
      prefix: "inbound/example.com/",
      region: "eu-west-1",
      provider_id: "prov-1",
      status: "live",
      live_sync_enabled: true,
    });

    const listed = listS3Sources();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ bucket: "inbound-bucket", status: "live" });
  });

  it("dedupes by bucket + prefix and preserves created_at on update", () => {
    const first = registerS3Source({ bucket: "b", prefix: "inbound/", providerId: "p1", status: "live" });
    const second = registerS3Source({ bucket: "b", prefix: "inbound/", providerId: "p2", status: "live" });

    const listed = listS3Sources();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.provider_id).toBe("p2");
    expect(second.created_at).toBe(first.created_at);
  });

  it("only surfaces live sources from listLiveS3Sources", () => {
    registerS3Source({ id: "s3-live", bucket: "live-bucket", prefix: "a/", providerId: "p1", status: "live", liveSyncEnabled: true });
    registerS3Source({ id: "s3-legacy", bucket: "legacy-bucket", prefix: "b/", providerId: "p1", status: "legacy" });

    const live = listLiveS3Sources();
    expect(live.map((s) => s.id)).toEqual(["s3-live"]);
  });

  it("retires a source so it drops out of the live set", () => {
    const source = registerS3Source({ id: "s3-retire", bucket: "retire-bucket", prefix: "inbound/", providerId: "p1", status: "live", liveSyncEnabled: true });
    expect(listLiveS3Sources().map((s) => s.id)).toEqual(["s3-retire"]);

    const retired = retireS3Source(source.id);
    expect(retired.status).toBe("retired");
    expect(retired.live_sync_enabled).toBe(false);
    expect(listLiveS3Sources()).toHaveLength(0);
    expect(listS3Sources().map((s) => s.status)).toEqual(["retired"]);
  });

  it("throws when retiring an unknown source", () => {
    expect(() => retireS3Source("does-not-exist")).toThrow(/S3 source not found/);
  });

  // NEGATIVE CONTROL on the shape of these four exports. The collapse's central claim is that
  // they make no seam call and therefore stay synchronous; a future edit that quietly made one
  // of them `async` would leave 13 production call sites reading a truthy Promise as a
  // populated source list, and every case above would still pass.
  it("keeps all four registry exports SYNCHRONOUS", () => {
    registerS3Source({ id: "s3-sync-shape", bucket: "shape-bucket", status: "live" });
    for (const value of [listS3Sources(), listLiveS3Sources(), retireS3Source("s3-sync-shape")]) {
      expect(value).not.toBeInstanceOf(Promise);
    }
    expect(registerS3Source({ bucket: "shape-bucket-2", status: "live" })).not.toBeInstanceOf(Promise);
  });
});
