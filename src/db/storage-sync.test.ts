import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "./database.js";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import { storeInboundEmail } from "./inbound.js";
import { createDomain, updateDomain, updateDomainReadiness } from "./domains.js";
import { createMailbox } from "./mailboxes.js";
import { createMailMessage, upsertMailboxMessageState } from "./messages.js";
import { listProviders } from "./providers.js";
import { createMailboxSource } from "./sources.js";
import type { PgAdapterAsync } from "./remote-storage.js";
import {
  REMOTE_RECONCILE_LOCK_KEY,
  STORAGE_DATABASE_ENV,
  STORAGE_MODE_ENV,
  getRemoteSyncMetaAll,
  getStorageDatabaseEnv,
  getStorageDatabaseEnvName,
  getStorageMode,
  getStoragePullMarkerPath,
  getStorageStatus,
  localDatabaseHasCommittedPull,
  parseStorageTables,
  prepareLocalMigrationDedupePlan,
  pullTablesFromRemote,
  pullTable,
  pushTable,
  readStoragePullMarker,
  reconcileRemoteDerivedState,
  recordRemoteSyncMeta,
  recordStoragePullMarker,
  runStorageMigrations,
  storageSync,
} from "./storage-sync.js";
import { MAILERY_MODE_ENV_KEYS } from "../lib/mode.js";

type Row = Record<string, unknown>;

const STORAGE_ENV = [
  ...STORAGE_DATABASE_ENV,
  ...STORAGE_MODE_ENV,
  ...MAILERY_MODE_ENV_KEYS,
] as const;

class FakeRemote {
  allCalls: Array<{ sql: string; params: unknown[] }> = [];
  runCalls: Array<{ sql: string; params: unknown[] }> = [];

  constructor(
    private readonly rowsByTable: Record<string, Row[]> = {},
    private readonly migrationRows: Row[] = [],
  ) {}

  async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
    this.allCalls.push({ sql, params });
    if (sql.includes("FROM _migrations")) return this.migrationRows;
    if (sql.includes("information_schema.columns")) return [];
    const table = sql.match(/FROM "([^"]+)"/)?.[1] ?? "";
    const limit = Number(params[0] ?? this.rowsByTable[table]?.length ?? 0);
    const offset = Number(params[1] ?? 0);
    return (this.rowsByTable[table] ?? []).slice(offset, offset + limit);
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    this.runCalls.push({ sql, params });
    return { changes: 1 };
  }

  async close(): Promise<void> {}
}

class ThrowingRemote extends FakeRemote {
  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    this.runCalls.push({ sql, params });
    throw new Error("remote write failed");
  }
}

class FailingReadRemote extends FakeRemote {
  async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
    if (sql.includes('FROM "owners"')) {
      this.allCalls.push({ sql, params });
      throw new Error("remote read failed");
    }
    return super.all(sql, ...params);
  }
}

class StatefulRemote extends FakeRemote {
  private readonly rows = new Map<string, Row[]>();

  async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
    this.allCalls.push({ sql, params });
    if (sql.includes("FROM _migrations")) return [];
    if (sql.includes("information_schema.columns")) return [];
    const table = sql.match(/FROM "([^"]+)"/)?.[1];
    if (!table) return [];
    const limit = Number(params[0] ?? this.rows.get(table)?.length ?? 0);
    const offset = Number(params[1] ?? 0);
    return (this.rows.get(table) ?? []).slice(offset, offset + limit);
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    this.runCalls.push({ sql, params });
    const match = sql.match(/INSERT INTO "([^"]+)" \(([^)]+)\)\s+VALUES/i);
    if (!match) return { changes: 1 };
    const table = match[1]!;
    const columns = match[2]!
      .split(",")
      .map((column) => column.trim().replace(/^"|"$/g, ""));
    const primaryKey = table === "mailbox_message_state"
      ? ["mailbox_id", "mail_message_id"]
      : table === "inbound_recipients" || table === "inbound_labels"
        ? ["inbound_email_id", table === "inbound_recipients" ? "address" : "label"]
        : table === "_emails_sync_meta"
          ? ["table_name", "direction"]
        : ["id"];
    const tableRows = this.rows.get(table) ?? [];
    for (let offset = 0; offset < params.length; offset += columns.length) {
      const values = params.slice(offset, offset + columns.length);
      const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
      const key = primaryKey.map((column) => String(row[column] ?? "")).join("\0");
      const existingIndex = tableRows.findIndex((candidate) => (
        primaryKey.map((column) => String(candidate[column] ?? "")).join("\0") === key
      ));
      if (existingIndex >= 0) tableRows[existingIndex] = { ...tableRows[existingIndex], ...row };
      else tableRows.push(row);
    }
    this.rows.set(table, tableRows);
    return { changes: Math.trunc(params.length / Math.max(1, columns.length)) };
  }

  setRows(table: string, rows: Row[]): void {
    this.rows.set(table, rows.map((row) => ({ ...row })));
  }
}

class DedupeRemote extends FakeRemote {
  constructor(
    private readonly remoteInboundRows: Row[],
    private readonly remoteStateRows: Row[],
  ) {
    super();
  }

  async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
    if (sql.includes("FROM inbound_emails") && sql.includes("(provider_id, message_id)")) {
      return this.remoteInboundRows.filter((row) => hasTuple(params, row.provider_id, row.message_id));
    }
    if (sql.includes("FROM mailbox_message_state") && sql.includes("(source_id, source_dedupe_key)")) {
      return this.remoteStateRows.filter((row) => hasTuple(params, row.source_id, row.source_dedupe_key));
    }
    return super.all(sql, ...params);
  }
}

function hasTuple(params: unknown[], left: unknown, right: unknown): boolean {
  for (let index = 0; index < params.length; index += 2) {
    if (params[index] === left && params[index + 1] === right) return true;
  }
  return false;
}

interface ReconcileSessionOptions {
  locked?: boolean;
  staleLabels?: number;
  failOnDelete?: boolean;
}

class ReconcileSessionRemote {
  sessionCalls: Array<{ sql: string; params: unknown[] }> = [];
  sessionReleased = false;
  private remainingStale: number;

  constructor(private readonly options: ReconcileSessionOptions = {}) {
    this.remainingStale = options.staleLabels ?? 0;
  }

  async withSession<T>(
    fn: (session: {
      run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
      all(sql: string, ...params: unknown[]): Promise<unknown[]>;
    }) => Promise<T>,
  ): Promise<T> {
    try {
      return await fn({
        all: async (sql: string, ...params: unknown[]) => {
          this.sessionCalls.push({ sql, params });
          if (sql.includes("pg_try_advisory_lock")) return [{ locked: this.options.locked ?? true }];
          return [];
        },
        run: async (sql: string, ...params: unknown[]) => {
          this.sessionCalls.push({ sql, params });
          if (sql.includes("DELETE FROM inbound_labels")) {
            if (this.options.failOnDelete) throw new Error("reconcile delete failed");
            const limit = Number(params[0] ?? 0);
            const changes = Math.min(limit, this.remainingStale);
            this.remainingStale -= changes;
            return { changes };
          }
          return { changes: 0 };
        },
      });
    } finally {
      this.sessionReleased = true;
    }
  }
}

function providerRow(id: string, name: string): Row {
  return {
    id,
    name,
    type: "resend",
    api_key: null,
    region: null,
    access_key: null,
    secret_key: null,
    active: 1,
    created_at: `2026-01-01T00:00:0${id}.000Z`,
    updated_at: `2026-01-01T00:00:0${id}.000Z`,
  };
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  for (const key of STORAGE_ENV) delete process.env[key];
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  for (const key of STORAGE_ENV) delete process.env[key];
});

describe("emails storage sync configuration", () => {
  it("keeps migration SQL lazy until migrations run", () => {
    const source = readFileSync(`${import.meta.dir}/storage-sync.ts`, "utf8");
    expect(source).not.toMatch(/^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']\.\/pg-migrations\.js["'];/m);
    expect(source).toContain('await import("./pg-migrations.js")');
    expect(source).toContain("read_at = NULLIF(inbound.read_at, '')::TIMESTAMPTZ");
  });

  it("prefers canonical storage database env over fallback", () => {
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://canonical";
    process.env["EMAILS_DATABASE_URL"] = "postgres://fallback";

    expect(getStorageDatabaseEnv()).toEqual({
      name: "HASNA_EMAILS_DATABASE_URL",
    });
    expect(getStorageDatabaseEnvName()).toBe("HASNA_EMAILS_DATABASE_URL");
    expect(getStorageStatus()).toMatchObject({
      configured: true,
      activeEnv: "HASNA_EMAILS_DATABASE_URL",
      mode: "remote",
      sourceOfTruth: "postgres",
      localCache: "runtime-cache",
      maileryMode: "self_hosted",
      maileryModeLabel: "Self-hosted",
      service: "emails",
      canonical: {
        cluster: null,
        database: null,
        runtimePath: null,
        env: "HASNA_EMAILS_DATABASE_URL",
        fallbackEnv: "EMAILS_DATABASE_URL",
      },
    });
  });

  it("uses fallback storage database env when canonical env is absent", () => {
    process.env["EMAILS_DATABASE_URL"] = "postgres://fallback";

    expect(getStorageDatabaseEnv()).toEqual({
      name: "EMAILS_DATABASE_URL",
    });
    expect(getStorageDatabaseEnvName()).toBe("EMAILS_DATABASE_URL");
  });

  it("resolves storage mode from storage envs", () => {
    process.env["MAILERY_MODE"] = "local";
    expect(getStorageMode()).toBe("local");

    process.env["MAILERY_MODE"] = "self_hosted";
    process.env["EMAILS_DATABASE_URL"] = "postgres://remote";
    expect(getStorageMode()).toBe("remote");

    process.env["HASNA_EMAILS_STORAGE_MODE"] = "remote";
    const status = getStorageStatus();
    expect(status.mode).toBe("remote");
    expect(status.sourceOfTruth).toBe("postgres");
    expect(status.localCache).toBe("runtime-cache");
    expect(status.maileryMode).toBe("self_hosted");
    expect(status.maileryModeWarning).toBeNull();
  });

  it("parses and validates storage table filters", () => {
    expect(parseStorageTables(["providers", "domains"])).toEqual(["providers", "domains"]);
    expect(parseStorageTables([
      "inbound_recipients",
      "inbound_labels",
      "mailboxes",
      "mailbox_sources",
      "mail_folders",
      "mail_messages",
      "mailbox_message_state",
      "email_agent_settings",
      "email_agent_runs",
      "email_digests",
    ])).toEqual([
      "inbound_recipients",
      "inbound_labels",
      "mailboxes",
      "mailbox_sources",
      "mail_folders",
      "mail_messages",
      "mailbox_message_state",
      "email_agent_settings",
      "email_agent_runs",
      "email_digests",
    ]);
    expect(() => parseStorageTables(["providers", "missing"])).toThrow("Unknown emails sync table(s): missing");
  });

  it("pushes canonical messages before inbound rows that reference them", () => {
    const tables = parseStorageTables();

    expect(tables.indexOf("mail_messages")).toBeLessThan(tables.indexOf("inbound_emails"));
    expect(tables.indexOf("inbound_emails")).toBeLessThan(tables.indexOf("inbound_recipients"));
    expect(tables.indexOf("inbound_emails")).toBeLessThan(tables.indexOf("inbound_labels"));
  });

  it("builds migration filters for inbound and mailbox-state rows that already exist remotely", async () => {
    const db = getDatabase();
    db.run(
      `INSERT INTO providers (id, name, type, active, created_at, updated_at)
       VALUES ('provider-1', 'Local source', 'ses', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    const duplicateInbound = storeInboundEmail({
      provider_id: "provider-1",
      message_id: "provider-message-duplicate",
      in_reply_to_email_id: null,
      raw_s3_url: "s3://fixture-bucket/inbound/provider-message-duplicate",
      from_address: "sender@example.com",
      to_addresses: ["agent@example.com"],
      cc_addresses: [],
      subject: "Already remote",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 64,
      received_at: "2026-07-01T12:00:00.000Z",
    }, db);
    const stateDuplicate = storeInboundEmail({
      provider_id: "provider-1",
      message_id: "provider-message-state-duplicate",
      in_reply_to_email_id: null,
      raw_s3_url: "s3://fixture-bucket/inbound/provider-message-state-duplicate",
      from_address: "sender@example.com",
      to_addresses: ["agent@example.com"],
      cc_addresses: [],
      subject: "State already remote",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 64,
      received_at: "2026-07-01T12:01:00.000Z",
    }, db);
    const stateRow = db
      .query("SELECT id, source_id, source_dedupe_key FROM mailbox_message_state WHERE mail_message_id = ?")
      .get(`msg:inbound:${stateDuplicate.id}`) as Row;
    const remote = new DedupeRemote(
      [{
        id: "remote-inbound-1",
        provider_id: "provider-1",
        message_id: "provider-message-duplicate",
        mail_message_id: "msg:inbound:remote-inbound-1",
      }],
      [{
        id: "remote-state-1",
        source_id: stateRow.source_id,
        source_dedupe_key: stateRow.source_dedupe_key,
      }],
    );

    const plan = await prepareLocalMigrationDedupePlan(remote as unknown as PgAdapterAsync, db);

    expect(plan).toMatchObject({
      skippedInboundEmails: 1,
      skippedMailMessages: 1,
      skippedMailboxMessageStates: 1,
    });
    expect(await pushTable(db, remote as unknown as PgAdapterAsync, "inbound_emails", {
      batchSize: 10,
      filter: plan.rowFilters.inbound_emails,
    })).toMatchObject({ table: "inbound_emails", rowsRead: 1, rowsWritten: 1, errors: [] });
    expect(await pushTable(db, remote as unknown as PgAdapterAsync, "inbound_recipients", {
      batchSize: 10,
      filter: plan.rowFilters.inbound_recipients,
    })).toMatchObject({ table: "inbound_recipients", rowsRead: 1, rowsWritten: 1, errors: [] });
    expect(await pushTable(db, remote as unknown as PgAdapterAsync, "mail_messages", {
      batchSize: 10,
      filter: plan.rowFilters.mail_messages,
    })).toMatchObject({ table: "mail_messages", rowsRead: 1, rowsWritten: 1, errors: [] });
    expect(await pushTable(db, remote as unknown as PgAdapterAsync, "mailbox_message_state", {
      batchSize: 10,
      filter: plan.rowFilters.mailbox_message_state,
    })).toMatchObject({ table: "mailbox_message_state", rowsRead: 0, rowsWritten: 0, errors: [] });
    expect(duplicateInbound.id).not.toBe(stateDuplicate.id);
  });

  it("reconciles remote-derived labels and canonical mailbox state after storage sync", () => {
    const source = readFileSync(`${import.meta.dir}/storage-sync.ts`, "utf8");

    expect(source).toContain("rebuildInboundLabelState");
    expect(source).toContain("reconcileMailboxMessageState");
    expect(source).toContain("DELETE FROM inbound_labels");
    expect(source).toContain("UPDATE mailbox_message_state state");
    // Incident hardening: single-flight advisory lock, ctid-batched cleanup,
    // and a reconcile-scoped statement timeout on the remote path.
    expect(source).toContain("pg_try_advisory_lock");
    expect(source).toContain("pg_advisory_unlock");
    expect(source).toContain("ctid IN (");
    expect(source).toContain("SET statement_timeout");
    // Reconcile is best-effort: a failed cleanup run must not fail the push.
    expect(source).toContain("remote derived-state reconcile failed (will retry on next push)");
  });

  it("requires explicit force for pull-then-push sync", async () => {
    await expect(storageSync()).rejects.toThrow("can overwrite local rows");
  });

  it("does not push after pull errors during forced sync", async () => {
    let pushed = false;

    await expect(storageSync(
      { force: true },
      {
        pull: async () => [{ table: "providers", rowsRead: 0, rowsWritten: 0, errors: ["pull failed"] }],
        push: async () => {
          pushed = true;
          return [];
        },
      },
    )).rejects.toThrow("push was not run");

    expect(pushed).toBe(false);
  });

  it("rolls back local pull writes when a later table fails", async () => {
    const remote = new FailingReadRemote({
      providers: [providerRow("1", "Remote 1")],
    });

    const results = await pullTablesFromRemote(
      remote as unknown as PgAdapterAsync,
      getDatabase(),
      { tables: ["providers", "owners"], batchSize: 2 },
    );

    expect(results[0]).toMatchObject({ table: "providers", rowsWritten: 1, errors: [] });
    expect(results[1]).toMatchObject({ table: "owners", errors: ["remote read failed"] });
    expect(listProviders()).toEqual([]);
  });

  it("rebuilds stale pulled inbound label rows from inbound_emails.label_ids_json", async () => {
    const remote = new FakeRemote({
      inbound_emails: [{
        id: "inbound-1",
        provider_id: null,
        message_id: "remote-message-1",
        in_reply_to_email_id: null,
        provider_thread_id: null,
        thread_id: null,
        provider_history_id: null,
        provider_internal_date: null,
        label_ids_json: "[]",
        raw_s3_url: null,
        metadata_s3_url: null,
        from_address: "sender@example.com",
        to_addresses: "[\"me@example.com\"]",
        cc_addresses: "[]",
        subject: "Remote pull",
        text_body: "body",
        html_body: null,
        attachments_json: "[]",
        attachment_paths: "[]",
        headers_json: "{}",
        raw_size: 1,
        is_read: 0,
        read_at: null,
        is_archived: 0,
        is_starred: 0,
        is_sent: 0,
        is_spam: 0,
        is_trash: 0,
        received_at: "2026-01-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
        mail_message_id: "msg:inbound:inbound-1",
      }],
      inbound_labels: [{ inbound_email_id: "inbound-1", label: "spam" }],
    });

    const results = await pullTablesFromRemote(
      remote as unknown as PgAdapterAsync,
      getDatabase(),
      { tables: ["inbound_emails", "inbound_labels"], batchSize: 2 },
    );

    expect(results.every((result) => result.errors.length === 0)).toBe(true);
    expect(getDatabase().query("SELECT * FROM inbound_labels").all()).toEqual([]);
    expect(getDatabase().query("SELECT is_spam, is_trash FROM inbound_emails WHERE id = 'inbound-1'").get()).toEqual({ is_spam: 0, is_trash: 0 });
    expect(getDatabase().query("SELECT is_spam, is_trash, folder_id FROM mailbox_message_state WHERE mail_message_id = 'msg:inbound:inbound-1'").get()).toMatchObject({
      is_spam: 0,
      is_trash: 0,
      folder_id: "folder:mbx:me@example.com:inbox",
    });
  });
});

describe("storage table sync batching", () => {
  it("skips PostgreSQL migrations that are already recorded", async () => {
    const remote = new FakeRemote({}, Array.from({ length: 37 }, (_, index) => ({ id: index + 1 })));

    await runStorageMigrations(remote as unknown as PgAdapterAsync);

    const sql = remote.runCalls.map((call) => call.sql).join("\n");
    expect(sql).not.toContain("INSERT INTO inbound_labels");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS feedback");
  });

  it("runs the attachment path repair migration on drifted PostgreSQL schemas", async () => {
    const remote = new FakeRemote({}, Array.from({ length: 44 }, (_, index) => ({ id: index + 1 })));

    await runStorageMigrations(remote as unknown as PgAdapterAsync);

    const sql = remote.runCalls.map((call) => call.sql).join("\n");
    expect(sql).toContain("ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS attachment_paths");
    expect(sql).toContain("INSERT INTO _migrations (id) VALUES (45)");
  });

  it("pushes local rows in bounded batches", async () => {
    const localRows = ["1", "2", "3", "4", "5"].map((id) => providerRow(id, `Provider ${id}`));
    const dataReads: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      query: (sql: string) => ({
        get: () => sql.includes("sqlite_master") ? { name: "providers" } : null,
        all: (...args: unknown[]) => {
          dataReads.push({ sql, args });
          const limit = Number(args[0]);
          const offset = Number(args[1]);
          return localRows.slice(offset, offset + limit);
        },
      }),
    } as unknown as Database;
    const remote = new FakeRemote();

    const result = await pushTable(db, remote as unknown as PgAdapterAsync, "providers", { batchSize: 2 });

    expect(result).toMatchObject({ table: "providers", rowsRead: 5, rowsWritten: 5, errors: [] });
    expect(dataReads.map((call) => call.args)).toEqual([[2, 0], [2, 2], [2, 4]]);
    expect(dataReads.every((call) => call.sql.includes("LIMIT ? OFFSET ?"))).toBe(true);
    expect(remote.runCalls).toHaveLength(3);
    const columnCount = Object.keys(localRows[0]!).length;
    expect(remote.runCalls.map((call) => call.params.length)).toEqual([columnCount * 2, columnCount * 2, columnCount]);
    expect(remote.runCalls[0]!.sql).toContain(`VALUES (${Array.from({ length: columnCount }, () => "?").join(", ")}), (${Array.from({ length: columnCount }, () => "?").join(", ")})`);
  });

  it("pushes only rows matching a parameterized row filter", async () => {
    const localRows = ["1", "2", "3"].map((id) => providerRow(id, `Provider ${id}`));
    const dataReads: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      query: (sql: string) => ({
        get: () => sql.includes("sqlite_master") ? { name: "providers" } : null,
        all: (...args: unknown[]) => {
          dataReads.push({ sql, args });
          const filtered = localRows.filter((row) => row.name === args[0]);
          const limit = Number(args[1]);
          const offset = Number(args[2]);
          return filtered.slice(offset, offset + limit);
        },
      }),
    } as unknown as Database;
    const remote = new FakeRemote();

    const result = await pushTable(db, remote as unknown as PgAdapterAsync, "providers", {
      batchSize: 2,
      filter: { where: "name = ?", params: ["Provider 2"] },
    });

    expect(result).toMatchObject({ table: "providers", rowsRead: 1, rowsWritten: 1, errors: [] });
    expect(dataReads).toHaveLength(1);
    expect(dataReads[0]!.sql).toContain("WHERE name = ?");
    expect(dataReads[0]!.args).toEqual(["Provider 2", 2, 0]);
    expect(remote.runCalls).toHaveLength(1);
    expect(remote.runCalls[0]!.params[0]).toBe("2");
  });

  it("pushes inbound email rows as a lean index because mail_messages owns bodies", async () => {
    const localRows = [{
      id: "inbound-lean",
      provider_id: null,
      message_id: "<lean@example.com>",
      from_address: "sender@example.com",
      to_addresses: "[\"ops@example.com\"]",
      cc_addresses: "[]",
      subject: "Lean inbound",
      text_body: "large body should live in mail_messages",
      html_body: "<p>large html should live in mail_messages</p>",
      attachments_json: "[]",
      attachment_paths: "[]",
      headers_json: "{\"Message-ID\":\"<lean@example.com>\"}",
      raw_size: 123,
      received_at: "2026-07-01T12:00:00.000Z",
      created_at: "2026-07-01T12:00:00.000Z",
      mail_message_id: "msg:inbound:inbound-lean",
    }];
    const db = {
      query: (sql: string) => ({
        get: () => sql.includes("sqlite_master") ? { name: "inbound_emails" } : null,
        all: (...args: unknown[]) => localRows.slice(Number(args[1]), Number(args[1]) + Number(args[0])),
      }),
    } as unknown as Database;
    const remote = new FakeRemote();

    const result = await pushTable(db, remote as unknown as PgAdapterAsync, "inbound_emails", { batchSize: 1 });

    expect(result).toMatchObject({ table: "inbound_emails", rowsRead: 1, rowsWritten: 1, errors: [] });
    expect(remote.runCalls[0]!.sql).not.toContain("text_body");
    expect(remote.runCalls[0]!.sql).not.toContain("html_body");
    expect(remote.runCalls[0]!.sql).not.toContain("headers_json");
    expect(remote.runCalls[0]!.params).not.toContain("large body should live in mail_messages");
  });

  it("returns per-table push errors for CLI aggregation", async () => {
    const db = {
      query: (sql: string) => ({
        get: () => sql.includes("sqlite_master") ? { name: "providers" } : null,
        all: () => [providerRow("1", "Provider 1")],
      }),
    } as unknown as Database;
    const remote = new ThrowingRemote();

    const result = await pushTable(db, remote as unknown as PgAdapterAsync, "providers", { batchSize: 2 });

    expect(result.table).toBe("providers");
    expect(result.errors).toEqual(["remote write failed"]);
  });

  it("pulls remote rows in bounded batches and preserves SQLite upsert behavior", async () => {
    const remote = new FakeRemote({
      providers: ["1", "2", "3"].map((id) => providerRow(id, `Remote ${id}`)),
    });

    const result = await pullTable(remote as unknown as PgAdapterAsync, getDatabase(), "providers", { batchSize: 2 });

    expect(result).toMatchObject({ table: "providers", rowsRead: 3, rowsWritten: 3, errors: [] });
    const dataCalls = remote.allCalls.filter((call) => call.sql.includes('FROM "providers"'));
    expect(dataCalls.map((call) => call.params)).toEqual([[2, 0], [2, 2]]);
    expect(dataCalls.every((call) => call.sql.includes("LIMIT ? OFFSET ?"))).toBe(true);
    expect(listProviders().map((provider) => provider.name).sort()).toEqual(["Remote 1", "Remote 2", "Remote 3"]);
  });

  it("replace pulls delete stale local rows that are missing from the remote source of truth", async () => {
    getDatabase().run(
      `INSERT INTO providers (id, name, type, active, created_at, updated_at)
       VALUES ('local-stale', 'Local stale', 'resend', 1, datetime('now'), datetime('now'))`,
    );
    const remote = new FakeRemote({
      providers: [providerRow("1", "Remote 1")],
    });

    const result = await pullTablesFromRemote(
      remote as unknown as PgAdapterAsync,
      getDatabase(),
      { tables: ["providers"], batchSize: 2, replace: true },
    );

    expect(result).toEqual([{ table: "providers", rowsRead: 1, rowsWritten: 1, errors: [] }]);
    expect(listProviders().map((provider) => provider.name)).toEqual(["Remote 1"]);
  });

  it("round-trips mail rows through a disposable Postgres fixture and replaces stale cache state", async () => {
    const db = getDatabase();
    const remote = new StatefulRemote();
    db.run(
      `INSERT INTO providers (id, name, type, active, created_at, updated_at)
       VALUES ('provider-1', 'Local source', 'ses', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    const stored = storeInboundEmail({
      provider_id: "provider-1",
      message_id: "s3://fixture-bucket/inbound/msg-1",
      in_reply_to_email_id: null,
      raw_s3_url: "s3://fixture-bucket/inbound/msg-1",
      from_address: "sender@example.com",
      to_addresses: ["agent@example.com"],
      cc_addresses: [],
      subject: "Remote authoritative subject",
      text_body: "remote body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 128,
      received_at: "2026-07-01T12:00:00.000Z",
    }, db);

    expect(await pushTable(db, remote as unknown as PgAdapterAsync, "providers", { batchSize: 1 }))
      .toMatchObject({ table: "providers", rowsRead: 1, rowsWritten: 1, errors: [] });
    expect(await pushTable(db, remote as unknown as PgAdapterAsync, "inbound_emails", { batchSize: 1 }))
      .toMatchObject({ table: "inbound_emails", rowsRead: 1, rowsWritten: 1, errors: [] });

    db.run("UPDATE inbound_emails SET subject = 'Stale local subject', is_archived = 1 WHERE id = ?", [stored.id]);

    const results = await pullTablesFromRemote(
      remote as unknown as PgAdapterAsync,
      db,
      { tables: ["inbound_emails"], batchSize: 1, replace: true },
    );

    expect(results).toEqual([
      { table: "inbound_emails", rowsRead: 1, rowsWritten: 1, errors: [] },
    ]);
    expect(db.query("SELECT subject, is_archived FROM inbound_emails WHERE id = ?").get(stored.id)).toEqual({
      subject: "Remote authoritative subject",
      is_archived: 0,
    });
  });

  it("round-trips domain, mailbox, message, and sync metadata through remote source-of-truth storage", async () => {
    const db = getDatabase();
    const remote = new StatefulRemote();
    db.run(
      `INSERT INTO providers (id, name, type, active, created_at, updated_at)
       VALUES ('provider-1', 'Self-hosted SES', 'ses', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    const domain = createDomain("provider-1", "example.com", db);
    updateDomain(domain.id, { dkim_status: "verified", spf_status: "verified", dmarc_status: "pending" }, db);
    updateDomainReadiness(domain.id, {
      source_of_truth: "postgres",
      ownership_status: "verified",
      inbound_status: "ready",
      outbound_status: "ready",
    }, db);
    const mailbox = createMailbox({ address: "ops@example.com", display_name: "Ops" }, db);
    const source = createMailboxSource({
      mailbox_id: mailbox.id,
      provider_id: "provider-1",
      type: "ses_s3",
      name: "Self-hosted S3",
      external_mailbox: "ops@example.com",
    }, db);
    const message = createMailMessage({
      subject: "Remote authoritative message",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      text_body: "body from source of truth",
      raw_s3_url: "s3://mailery-inbound/example/message.eml",
      received_at: "2026-07-01T12:00:00.000Z",
    }, db);
    const state = upsertMailboxMessageState({
      mailbox_id: mailbox.id,
      mail_message_id: message.id,
      source_id: source.id,
      source_dedupe_key: "ses-s3:message-1",
      is_read: false,
      received_at: "2026-07-01T12:00:00.000Z",
    }, db);

    const pushed = [];
    for (const table of ["providers", "domains", "mailboxes", "mail_folders", "mailbox_sources", "mail_messages", "mailbox_message_state"] as const) {
      pushed.push(await pushTable(db, remote as unknown as PgAdapterAsync, table, { batchSize: 2 }));
    }
    await recordRemoteSyncMeta(remote as unknown as PgAdapterAsync, "push", pushed);

    db.run("UPDATE domains SET outbound_status = 'disabled' WHERE id = ?", [domain.id]);
    db.run("UPDATE mailboxes SET display_name = 'Local stale cache' WHERE id = ?", [mailbox.id]);
    db.run("UPDATE mail_messages SET subject = 'Local stale message' WHERE id = ?", [message.id]);
    db.run("UPDATE mailbox_message_state SET is_read = 1 WHERE id = ?", [state.id]);

    const pulled = await pullTablesFromRemote(
      remote as unknown as PgAdapterAsync,
      db,
      { tables: ["domains", "mailboxes", "mail_folders", "mailbox_sources", "mail_messages", "mailbox_message_state"], batchSize: 2, replace: true },
    );

    expect(pulled.every((result) => result.errors.length === 0)).toBe(true);
    expect(db.query("SELECT source_of_truth, ownership_status, inbound_status, outbound_status FROM domains WHERE id = ?").get(domain.id)).toEqual({
      source_of_truth: "postgres",
      ownership_status: "verified",
      inbound_status: "ready",
      outbound_status: "ready",
    });
    expect(db.query("SELECT display_name FROM mailboxes WHERE id = ?").get(mailbox.id)).toEqual({ display_name: "Ops" });
    expect(db.query("SELECT subject FROM mail_messages WHERE id = ?").get(message.id)).toEqual({ subject: "Remote authoritative message" });
    expect(db.query("SELECT is_read FROM mailbox_message_state WHERE id = ?").get(state.id)).toEqual({ is_read: 0 });

    const remoteMeta = await getRemoteSyncMetaAll(remote as unknown as PgAdapterAsync);
    expect(remoteMeta).toEqual(expect.arrayContaining([
      expect.objectContaining({ table_name: "domains", direction: "push" }),
      expect.objectContaining({ table_name: "domains", direction: "pull" }),
      expect.objectContaining({ table_name: "mailboxes", direction: "pull" }),
      expect.objectContaining({ table_name: "mail_messages", direction: "pull" }),
      expect.objectContaining({ table_name: "mailbox_message_state", direction: "pull" }),
    ]));
    expect(db.query("SELECT table_name, direction FROM _emails_sync_meta WHERE table_name IN ('domains', 'mailboxes', 'mail_messages', 'mailbox_message_state') ORDER BY table_name, direction").all()).toEqual([
      { table_name: "domains", direction: "pull" },
      { table_name: "mail_messages", direction: "pull" },
      { table_name: "mailbox_message_state", direction: "pull" },
      { table_name: "mailboxes", direction: "pull" },
    ]);
  });

  it("treats remote tombstones as authoritative for disposable self-hosted mail caches", async () => {
    const db = getDatabase();
    const remote = new StatefulRemote();
    db.run(
      `INSERT INTO providers (id, name, type, active, created_at, updated_at)
       VALUES ('provider-1', 'Local source', 'ses', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    const stored = storeInboundEmail({
      provider_id: "provider-1",
      message_id: "s3://fixture-bucket/inbound/tombstoned",
      in_reply_to_email_id: null,
      raw_s3_url: "s3://fixture-bucket/inbound/tombstoned",
      from_address: "sender@example.com",
      to_addresses: ["agent@example.com"],
      cc_addresses: [],
      subject: "Tombstoned locally",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 64,
      received_at: "2026-07-01T12:00:00.000Z",
    }, db);
    remote.setRows("inbound_emails", []);
    remote.setRows("mailbox_message_state", []);

    const results = await pullTablesFromRemote(
      remote as unknown as PgAdapterAsync,
      db,
      { tables: ["inbound_emails", "mailbox_message_state"], batchSize: 1, replace: true },
    );

    expect(results).toEqual([
      { table: "inbound_emails", rowsRead: 0, rowsWritten: 0, errors: [] },
      { table: "mailbox_message_state", rowsRead: 0, rowsWritten: 0, errors: [] },
    ]);
    expect(db.query("SELECT id FROM inbound_emails WHERE id = ?").get(stored.id)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM mailbox_message_state WHERE mail_message_id = ?").get(`msg:inbound:${stored.id}`)).toEqual({ count: 0 });
  });
});

describe("remote derived-state reconcile hardening", () => {
  const sqlOf = (remote: ReconcileSessionRemote): string[] => remote.sessionCalls.map((call) => call.sql);

  it("skips the reconcile entirely when another instance holds the advisory lock", async () => {
    const remote = new ReconcileSessionRemote({ locked: false, staleLabels: 10 });

    const result = await reconcileRemoteDerivedState(remote as unknown as PgAdapterAsync);

    expect(result).toEqual({ skipped: true, staleLabelBatches: 0, staleLabelsDeleted: 0, reachedBatchCap: false });
    expect(remote.sessionCalls).toHaveLength(1);
    expect(remote.sessionCalls[0]!.sql).toContain(`pg_try_advisory_lock(${REMOTE_RECONCILE_LOCK_KEY})`);
    const sql = sqlOf(remote).join("\n");
    expect(sql).not.toContain("DELETE FROM inbound_labels");
    expect(sql).not.toContain("UPDATE mailbox_message_state");
    // Never release an advisory lock this instance does not own.
    expect(sql).not.toContain("pg_advisory_unlock");
    expect(remote.sessionReleased).toBe(true);
  });

  it("deletes stale labels in bounded ctid batches until the cleanup drains", async () => {
    const remote = new ReconcileSessionRemote({ staleLabels: 12 });

    const result = await reconcileRemoteDerivedState(remote as unknown as PgAdapterAsync, { labelDeleteBatchSize: 5 });

    expect(result).toEqual({ skipped: false, staleLabelBatches: 3, staleLabelsDeleted: 12, reachedBatchCap: false });
    const deletes = remote.sessionCalls.filter((call) => call.sql.includes("DELETE FROM inbound_labels"));
    expect(deletes).toHaveLength(3);
    expect(deletes.every((call) => call.sql.includes("ctid IN (") && call.sql.includes("LIMIT ?"))).toBe(true);
    expect(deletes.map((call) => call.params)).toEqual([[5], [5], [5]]);
    const sql = sqlOf(remote);
    expect(sql[0]).toContain("pg_try_advisory_lock");
    expect(sql[1]).toContain("SET statement_timeout");
    const combined = sql.join("\n");
    expect(combined).toContain("INSERT INTO inbound_labels");
    expect(combined).toContain("UPDATE inbound_emails");
    expect(combined).toContain("UPDATE mailbox_message_state state");
    expect(combined).toContain("IS DISTINCT FROM");
    expect(sql[sql.length - 2]).toContain("RESET statement_timeout");
    expect(sql[sql.length - 1]).toContain(`pg_advisory_unlock(${REMOTE_RECONCILE_LOCK_KEY})`);
  });

  it("stops batched label cleanup at the safety cap and leaves the rest to the next run", async () => {
    const remote = new ReconcileSessionRemote({ staleLabels: 100 });

    const result = await reconcileRemoteDerivedState(remote as unknown as PgAdapterAsync, {
      labelDeleteBatchSize: 5,
      maxLabelDeleteBatches: 3,
    });

    expect(result).toEqual({ skipped: false, staleLabelBatches: 3, staleLabelsDeleted: 15, reachedBatchCap: true });
    const deletes = remote.sessionCalls.filter((call) => call.sql.includes("DELETE FROM inbound_labels"));
    expect(deletes).toHaveLength(3);
    const sql = sqlOf(remote).join("\n");
    // A capped run still reconciles missing labels and flags, and still releases the lock.
    expect(sql).toContain("INSERT INTO inbound_labels");
    expect(sql).toContain("UPDATE mailbox_message_state state");
    expect(sql).toContain(`pg_advisory_unlock(${REMOTE_RECONCILE_LOCK_KEY})`);
  });

  it("releases the advisory lock and resets the timeout when a reconcile statement fails", async () => {
    const remote = new ReconcileSessionRemote({ staleLabels: 1, failOnDelete: true });

    await expect(reconcileRemoteDerivedState(remote as unknown as PgAdapterAsync)).rejects.toThrow("reconcile delete failed");

    const sql = sqlOf(remote).join("\n");
    expect(sql).toContain("RESET statement_timeout");
    expect(sql).toContain(`pg_advisory_unlock(${REMOTE_RECONCILE_LOCK_KEY})`);
    expect(remote.sessionReleased).toBe(true);
  });
});

describe("storage pull marker", () => {
  const markerTempDirs: string[] = [];

  afterEach(() => {
    for (const dir of markerTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a pull marker next to a persistent database path", () => {
    const dir = mkdtempSync(join(tmpdir(), "mailery-pull-marker-"));
    markerTempDirs.push(dir);
    const dbPath = join(dir, "emails.db");

    expect(getStoragePullMarkerPath(dbPath)).toBe(`${dbPath}.last-pull.json`);
    recordStoragePullMarker(["providers", "emails"], dbPath);

    const marker = readStoragePullMarker(dbPath);
    expect(marker?.tables).toEqual(["providers", "emails"]);
    expect(Number.isFinite(Date.parse(marker?.pulledAt ?? ""))).toBe(true);
  });

  it("skips marker writes and reads for in-memory database paths", () => {
    recordStoragePullMarker(["providers"], ":memory:");
    expect(readStoragePullMarker(":memory:")).toBeNull();
    expect(existsSync(getStoragePullMarkerPath(":memory:"))).toBe(false);
  });

  it("returns null for corrupt or invalid markers", () => {
    const dir = mkdtempSync(join(tmpdir(), "mailery-pull-marker-invalid-"));
    markerTempDirs.push(dir);
    const dbPath = join(dir, "emails.db");
    const markerPath = getStoragePullMarkerPath(dbPath);

    writeFileSync(markerPath, "{not json");
    expect(readStoragePullMarker(dbPath)).toBeNull();

    writeFileSync(markerPath, JSON.stringify({ pulledAt: "not-a-date", tables: [] }));
    expect(readStoragePullMarker(dbPath)).toBeNull();

    writeFileSync(markerPath, JSON.stringify({ tables: ["providers"] }));
    expect(readStoragePullMarker(dbPath)).toBeNull();
  });

  it("records a marker with an explicit pulledAt timestamp", () => {
    const dir = mkdtempSync(join(tmpdir(), "mailery-pull-marker-anchor-"));
    markerTempDirs.push(dir);
    const dbPath = join(dir, "emails.db");
    const anchorMs = Date.now() - 120_000;

    recordStoragePullMarker(["providers"], dbPath, anchorMs);

    const marker = readStoragePullMarker(dbPath);
    expect(marker?.pulledAt).toBe(new Date(anchorMs).toISOString());
  });

  it("detects committed pull evidence only in databases that recorded a pull", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mailery-pull-evidence-"));
    markerTempDirs.push(dir);
    const missingPath = join(dir, "missing.db");
    const garbagePath = join(dir, "garbage.db");
    const pulledPath = join(dir, "pulled.db");
    writeFileSync(garbagePath, "not a sqlite database");

    expect(localDatabaseHasCommittedPull(":memory:")).toBe(false);
    expect(localDatabaseHasCommittedPull(missingPath)).toBe(false);
    expect(localDatabaseHasCommittedPull(garbagePath)).toBe(false);

    const previousEmailsDbPath = process.env["EMAILS_DB_PATH"];
    const previousHasnaEmailsDbPath = process.env["HASNA_EMAILS_DB_PATH"];
    try {
      process.env["EMAILS_DB_PATH"] = pulledPath;
      process.env["HASNA_EMAILS_DB_PATH"] = pulledPath;
      resetDatabase();
      const db = getDatabase();
      const remote = new FakeRemote({ providers: [] });
      const results = await pullTablesFromRemote(remote as unknown as PgAdapterAsync, db, { tables: ["providers"] });
      expect(results.every((result) => result.errors.length === 0)).toBe(true);
      closeDatabase();

      expect(localDatabaseHasCommittedPull(pulledPath)).toBe(true);
    } finally {
      closeDatabase();
      if (previousEmailsDbPath === undefined) delete process.env["EMAILS_DB_PATH"];
      else process.env["EMAILS_DB_PATH"] = previousEmailsDbPath;
      if (previousHasnaEmailsDbPath === undefined) delete process.env["HASNA_EMAILS_DB_PATH"];
      else process.env["HASNA_EMAILS_DB_PATH"] = previousHasnaEmailsDbPath;
      resetDatabase();
    }
  });
});
