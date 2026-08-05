import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerS3Source,
  retireS3Source,
  listS3Sources,
  listLiveS3Sources,
} from "./s3-sync.js";
import { syncS3Inbox } from "./s3-sync.remote.js";
import { s3SyncLocalTestBoundary } from "./s3-sync.local.js";
import {
  backfillS3SourceIdsFromRawUrls,
  closeDatabase,
  getDatabase,
  resetDatabase,
  uuid,
  type Database,
} from "../db/database.js";

// S3 → mailbox ingestion (syncS3Inbox) is STILL MODE-ROUTED and runs on the self-hosted
// server: the thin client has no local inbound store to write into, so it is a loud stub.
// The S3 *source registry* (register/list/retire) is pure client config backed by the
// local config file with no database dependency, and it has COLLAPSED to one
// implementation in `s3-sync.ts` — the cases below now exercise that one implementation
// rather than whichever arm the deployment word picked.

let originalHome: string | undefined;
let tmpHome = "";
let db: Database;
let INHERITED_ENV: NodeJS.ProcessEnv;

beforeEach(() => {
  INHERITED_ENV = { ...process.env };
  originalHome = process.env["HOME"];
  tmpHome = mkdtempSync(join(tmpdir(), "emails-s3-source-"));
  process.env["HOME"] = tmpHome;
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  db = getDatabase();
});

afterEach(() => {
  closeDatabase();
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_ENV);
});

describe("syncS3Inbox (self-hosted stub)", () => {
  it("throws because S3 inbound ingestion runs on the self-hosted server", async () => {
    await expect(syncS3Inbox({ bucket: "test-bucket", providerId: "p1" })).rejects.toThrow(
      /syncS3Inbox is not available in the self-hosted client/,
    );
  });

  it("throws for a source-id driven sync too", async () => {
    await expect(syncS3Inbox({ sourceId: "s3-anything" })).rejects.toThrow(
      /S3 inbound ingestion runs on the self-hosted server/,
    );
  });
});

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

  // NEGATIVE CONTROL on the SHAPE of these four exports, and it is the reason the collapse could
  // leave them synchronous. The claim is that they make no store-seam call and therefore need no
  // `await`; a later edit that quietly made one `async` would leave 13 production synchronous call
  // sites reading a truthy Promise as a populated source list, and every case above would still
  // pass. Two of those sites cannot be repaired with a local `await` at all — `listLiveS3Sources()`
  // is a DEFAULT PARAMETER of an exported synchronous function in
  // src/lib/domain-inbound-evidence.ts, and `listS3Sources()` is called inside the exported
  // synchronous `listMailboxSources` in src/cli/tui/data.local.ts.
  it("keeps all four registry exports SYNCHRONOUS", () => {
    registerS3Source({ id: "s3-sync-shape", bucket: "shape-bucket", status: "live" });
    for (const value of [listS3Sources(), listLiveS3Sources(), retireS3Source("s3-sync-shape")]) {
      expect(value).not.toBeInstanceOf(Promise);
    }
    expect(registerS3Source({ bucket: "shape-bucket-2", status: "live" })).not.toBeInstanceOf(Promise);
  });
});

// ─── the legacy fence adoption ────────────────────────────────────────────────
//
// WHY THIS LIVES IN THIS FILE even though the statement is in `src/db/database.ts`: it exists ONLY
// to make the S3 ingestion's future migration onto the store seam safe, and it is meaningless
// except in terms of this family's dedup key. The seam fences on `upsertMessage`'s `source_id`; the
// ingestion has always deduplicated on `raw_s3_url`, a column the seam does not expose and
// deliberately never will (`src/store-sqlite/index.ts` declares `rawMessage` FALSE precisely
// because that column names an object the store cannot read). `inbound_emails.source_id` was added
// NULLABLE with no backfill, so on any database populated before that migration every S3-sourced
// row has `raw_s3_url` set and `source_id` NULL — a fence keyed on `source_id` would match NOTHING
// and re-insert the entire mailbox. Banking the repair now means the ingestion's collapse cannot
// ship that defect later.

describe("adopting the old raw_s3_url dedup key as the seam fence", () => {
  function insertLegacyRow(id: string, rawS3Url: string | null, messageId: string, createdAt: string): void {
    db.run(
      `INSERT INTO inbound_emails (id, message_id, raw_s3_url, from_address, to_addresses, subject, created_at, received_at)
       VALUES (?, ?, ?, 'sender@example.test', '[]', 'legacy', ?, ?)`,
      [id, messageId, rawS3Url, createdAt, createdAt],
    );
    db.run("UPDATE inbound_emails SET source_id = NULL WHERE id = ?", [id]);
  }

  it("gives a legacy S3 row its raw_s3_url as source_id", () => {
    const url = "s3://inbound-test-bucket/inbound/example.test/legacy";
    insertLegacyRow(uuid(), url, url, "2026-01-01T00:00:00.000Z");

    expect(backfillS3SourceIdsFromRawUrls(db)).toBe(1);
    const row = db.query("SELECT source_id FROM inbound_emails WHERE raw_s3_url = ?").get(url) as
      | { source_id: string | null }
      | null;
    // WITHOUT THIS the first fenced sync after the ingestion migrates matches nothing and stores a
    // second copy of every message already pulled from S3.
    expect(row?.source_id).toBe(url);
  });

  it("is wired into ensureSchema, so a database open repairs itself with no explicit call", () => {
    // THE END-TO-END CLAIM. Nothing in any sync path calls the repair, so if the `ensureSchema`
    // wiring were dropped every other case here would still pass while a real installation
    // duplicated its mailbox.
    const url = "s3://inbound-test-bucket/inbound/example.test/wired";

    // A FILE-BACKED database, not `:memory:`. Closing and re-opening an in-memory database
    // discards it, so the seeded row would vanish and this case would pass for the wrong reason —
    // which is exactly what its first version did.
    const dbFile = join(tmpHome, "wired.sqlite");
    closeDatabase();
    process.env["EMAILS_DB_PATH"] = dbFile;
    resetDatabase();
    db = getDatabase();
    db.run(
      `INSERT INTO inbound_emails (id, message_id, raw_s3_url, from_address, to_addresses, subject, created_at, received_at)
       VALUES (?, ?, ?, 'sender@example.test', '[]', 'legacy', ?, ?)`,
      [uuid(), url, url, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
    db.run("UPDATE inbound_emails SET source_id = NULL WHERE raw_s3_url = ?", [url]);
    expect(
      (db.query("SELECT source_id FROM inbound_emails WHERE raw_s3_url = ?").get(url) as { source_id: string | null })
        .source_id,
    ).toBeNull();

    closeDatabase();
    db = getDatabase();

    const row = db.query("SELECT source_id FROM inbound_emails WHERE raw_s3_url = ?").get(url) as
      | { source_id: string | null }
      | null;
    expect(row?.source_id).toBe(url);
  });

  it("claims a duplicated raw_s3_url for exactly ONE row instead of violating the unique index", () => {
    const url = "s3://inbound-test-bucket/inbound/example.test/dupe";
    insertLegacyRow("aaaa-earliest", url, url, "2026-01-01T00:00:00.000Z");
    insertLegacyRow("bbbb-later", url, url, "2026-02-01T00:00:00.000Z");

    // `raw_s3_url` is NOT uniquely indexed and duplicates exist in the wild, because the legacy
    // `backfillLegacyS3RawUrls` repair DERIVES the column from `message_id`. A bare
    // `UPDATE … SET source_id = raw_s3_url` would abort on idx_inbound_source_id here.
    expect(backfillS3SourceIdsFromRawUrls(db)).toBe(1);
    const claimed = db.query("SELECT id FROM inbound_emails WHERE source_id = ?").all(url) as Array<{ id: string }>;
    expect(claimed.map((row) => row.id)).toEqual(["aaaa-earliest"]);
  });

  it("survives a SECOND open when a raw_s3_url is duplicated, instead of aborting on the index", () => {
    // MUTATION TESTING FOUND THIS UNASSERTED, and the bug behind it is worse than a gap. On run one
    // the earliest row claims the URL. On run two the remaining duplicate is still a candidate and
    // the `earliest` subquery — which filters `source_id IS NULL` — now names IT, so without the
    // `NOT EXISTS` guard the statement tries to write a source_id that is already taken. And
    // `ensureSchema` runs on EVERY database open, so that is not a failed repair: it is a CLI that
    // cannot start.
    const url = "s3://inbound-test-bucket/inbound/example.test/twice";
    insertLegacyRow("dupe-a", url, url, "2026-01-01T00:00:00.000Z");
    insertLegacyRow("dupe-b", url, url, "2026-02-01T00:00:00.000Z");

    expect(backfillS3SourceIdsFromRawUrls(db)).toBe(1);
    expect(() => backfillS3SourceIdsFromRawUrls(db)).not.toThrow();
    expect(backfillS3SourceIdsFromRawUrls(db)).toBe(0);
    const rows = db.query("SELECT id, source_id FROM inbound_emails ORDER BY id").all() as Array<{
      id: string;
      source_id: string | null;
    }>;
    expect(rows).toEqual([
      { id: "dupe-a", source_id: url },
      { id: "dupe-b", source_id: null },
    ]);
  });

  it("is idempotent, and picks the SAME survivor across repeated runs", () => {
    const url = "s3://inbound-test-bucket/inbound/example.test/once";
    insertLegacyRow(uuid(), url, url, "2026-01-01T00:00:00.000Z");
    expect(backfillS3SourceIdsFromRawUrls(db)).toBe(1);
    expect(backfillS3SourceIdsFromRawUrls(db)).toBe(0);

    // DETERMINISM, ASSERTED RATHER THAN ASSUMED. The survivor is chosen by
    // `created_at ASC, id ASC`; with ten rows sharing a URL AND sharing `created_at` to the
    // millisecond — exactly what a tight ingestion loop produces — the tie-break on `id` is the
    // only thing keeping this from being a coin flip that passes most of the time. Inserted in
    // reverse id order so the assertion cannot pass by insertion accident.
    const shared = "s3://inbound-test-bucket/inbound/example.test/tied";
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `tied-${String(9 - i).padStart(3, "0")}`;
      ids.push(id);
      insertLegacyRow(id, shared, shared, "2026-03-01T00:00:00.000Z");
    }
    expect(backfillS3SourceIdsFromRawUrls(db)).toBe(1);
    const claimed = db.query("SELECT id FROM inbound_emails WHERE source_id = ?").all(shared) as Array<{ id: string }>;
    expect(claimed.map((row) => row.id)).toEqual([[...ids].sort()[0]]);
  });

  it("leaves a non-S3 row alone: source_id means an upstream id, not any old message id", () => {
    insertLegacyRow(uuid(), null, "<plain-rfc-id@example.test>", "2026-01-01T00:00:00.000Z");
    insertLegacyRow(uuid(), "", "<another@example.test>", "2026-01-02T00:00:00.000Z");

    expect(backfillS3SourceIdsFromRawUrls(db)).toBe(0);
    const withSource = db.query("SELECT COUNT(*) AS n FROM inbound_emails WHERE source_id IS NOT NULL").get() as {
      n: number;
    };
    expect(withSource.n).toBe(0);
  });

  it("scopes the UPDATE to s3:// itself, not only the pre-check that guards it", () => {
    // MUTATION TESTING FOUND THIS UNASSERTED. Widening the UPDATE's own predicate from
    // `LIKE 's3://%'` to `IS NOT NULL` left the suite green, because the case above supplies no row
    // that reaches the UPDATE at all — the pre-check's own `LIKE` short-circuits it. So this case
    // pairs a REAL S3 row (which opens the pre-check) with a non-S3 URL that is neither null nor
    // empty, and the non-S3 row must still be untouched.
    const s3Url = "s3://inbound-test-bucket/inbound/example.test/real";
    insertLegacyRow("row-s3", s3Url, s3Url, "2026-01-01T00:00:00.000Z");
    insertLegacyRow("row-http", "https://example.test/not-a-bucket-object", "<x@example.test>", "2026-01-02T00:00:00.000Z");

    expect(backfillS3SourceIdsFromRawUrls(db)).toBe(1);
    const rows = db.query("SELECT id, source_id FROM inbound_emails ORDER BY id").all() as Array<{
      id: string;
      source_id: string | null;
    }>;
    expect(rows).toEqual([
      { id: "row-http", source_id: null },
      { id: "row-s3", source_id: s3Url },
    ]);
  });

  // WHAT THIS CASE DOES AND DOES NOT PROVE, stated because the first version of it overclaimed. It
  // asserts that the supporting index EXISTS, that SQLite CHOOSES it for the repair's candidate
  // predicate, and that it is EMPTY on a mailbox whose inbound rows came from a non-S3 path — the
  // case the obvious `WHERE source_id IS NULL`-only index would have got wrong. It does NOT prove
  // the source performs the pre-check: the plan below is taken over SQL written here, so an
  // implementation that dropped the pre-check would still pass. That half is evidenced by the
  // timings in the PR body, not by this case.
  it("has an index SQLite chooses for the repair's candidate set, and it is empty for non-S3 rows", () => {
    const plan = db
      .query(
        `EXPLAIN QUERY PLAN SELECT 1 AS found FROM inbound_emails
          WHERE source_id IS NULL AND raw_s3_url LIKE 's3://%' LIMIT 1`,
      )
      .all() as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" | ")).toContain("idx_inbound_unfenced_s3");

    insertLegacyRow(uuid(), null, "<webhook@example.test>", "2026-01-01T00:00:00.000Z");
    const entries = db
      .query("SELECT COUNT(*) AS n FROM inbound_emails WHERE source_id IS NULL AND raw_s3_url IS NOT NULL")
      .get() as { n: number };
    expect(entries.n).toBe(0);
    expect(backfillS3SourceIdsFromRawUrls(db)).toBe(0);

    // A SCHEMA-SHAPE ASSERTION, LABELLED AS ONE. Mutation testing broadened the index to
    // `WHERE source_id IS NULL` and the suite stayed green — the mutant keeps the same NAME, so the
    // plan check above still matched it, and the row count above is a query rather than a read of
    // the index. Nothing observable at this layer distinguishes the two definitions; what does is a
    // TIMING (the broad form stays populated by every non-seam inbound write, which all leave
    // `source_id` NULL). So the predicate itself is pinned here, as evidence about the schema.
    const index = db
      .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_inbound_unfenced_s3'")
      .get() as { sql: string } | null;
    expect(index?.sql).toContain("source_id IS NULL");
    expect(index?.sql, "the index must be narrowed to the candidate set, not to every unfenced row")
      .toContain("raw_s3_url IS NOT NULL");
  });
});
