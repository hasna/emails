import { Database as SqliteDatabase } from "bun:sqlite";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Database } from "./database.js";
import { getDatabase, getDatabasePath, rebuildInboundLabelState, reconcileMailboxMessageState } from "./database.js";
import type { PgAdapterAsync } from "./remote-storage.js";
import { getCanonicalOpenEmailsRdsConfig, type CanonicalOpenEmailsRdsConfig } from "../lib/config.js";
import {
  LEGACY_STORAGE_MODE_ENV,
  LEGACY_STORAGE_MODE_FALLBACK_ENV,
  resolveMaileryMode,
  type MaileryMode,
  type MaileryModeLabel,
  type MaileryModeSource,
} from "../lib/mode.js";

export const STORAGE_TABLES = [
  "providers",
  "owners",
  "domains",
  "addresses",
  "emails",
  "mail_messages",
  "inbound_emails",
  "inbound_recipients",
  "inbound_labels",
  "mailboxes",
  "mailbox_sources",
  "mail_folders",
  "mailbox_message_state",
  "events",
  "templates",
  "contacts",
  "scheduled_emails",
  "groups",
  "group_members",
  "email_content",
  "sandbox_emails",
  "sequences",
  "sequence_steps",
  "sequence_enrollments",
  "warming_schedules",
  "gmail_sync_state",
  "aliases",
  "send_keys",
  "forwarding_rules",
  "forwarding_deliveries",
  "address_ownership_events",
  "provisioning_events",
  "email_triage",
  "email_agent_settings",
  "email_agent_runs",
  "email_digests",
  "feedback",
] as const;
export const EMAILS_STORAGE_TABLES = STORAGE_TABLES;

export type StorageTable = (typeof STORAGE_TABLES)[number];
type Row = Record<string, unknown>;
type StorageTableFilterParam = string | number | bigint | boolean | null | Uint8Array;
export const STORAGE_SYNC_BATCH_SIZE = 500;
const POSTGRES_UPSERT_PARAM_BUDGET = 30_000;
const REMOTE_PUSH_OMIT_COLUMNS: Partial<Record<StorageTable, Set<string>>> = {
  inbound_emails: new Set(["text_body", "html_body", "headers_json"]),
};

const PRIMARY_KEYS: Record<StorageTable, string[]> = {
  providers: ["id"],
  owners: ["id"],
  domains: ["id"],
  addresses: ["id"],
  emails: ["id"],
  inbound_emails: ["id"],
  inbound_recipients: ["inbound_email_id", "address"],
  inbound_labels: ["inbound_email_id", "label"],
  mailboxes: ["id"],
  mailbox_sources: ["id"],
  mail_folders: ["id"],
  mail_messages: ["id"],
  mailbox_message_state: ["mailbox_id", "mail_message_id"],
  events: ["id"],
  templates: ["id"],
  contacts: ["id"],
  scheduled_emails: ["id"],
  groups: ["id"],
  group_members: ["group_id", "email"],
  email_content: ["email_id"],
  sandbox_emails: ["id"],
  sequences: ["id"],
  sequence_steps: ["id"],
  sequence_enrollments: ["id"],
  warming_schedules: ["id"],
  gmail_sync_state: ["provider_id"],
  aliases: ["id"],
  send_keys: ["id"],
  forwarding_rules: ["id"],
  forwarding_deliveries: ["id"],
  address_ownership_events: ["id"],
  provisioning_events: ["id"],
  email_triage: ["id"],
  email_agent_settings: ["agent_key"],
  email_agent_runs: ["id"],
  email_digests: ["id"],
  feedback: ["id"],
};

export interface SyncResult {
  table: string;
  rowsRead: number;
  rowsWritten: number;
  errors: string[];
}

export interface SyncMeta {
  table_name: string;
  last_synced_at: string | null;
  direction: "push" | "pull";
}

export interface StorageTableFilter {
  where: string;
  params?: StorageTableFilterParam[];
}

export interface StorageSyncOptions {
  tables?: string[];
  batchSize?: number;
  force?: boolean;
  replace?: boolean;
  rowFilters?: Partial<Record<StorageTable, StorageTableFilter>>;
}

export interface LocalMigrationDedupePlan {
  rowFilters: Partial<Record<StorageTable, StorageTableFilter>>;
  skippedInboundEmails: number;
  skippedMailMessages: number;
  skippedMailboxMessageStates: number;
}

export interface StorageSyncHooks {
  pull?: (options?: StorageSyncOptions) => Promise<SyncResult[]>;
  push?: (options?: StorageSyncOptions) => Promise<SyncResult[]>;
}

export type StorageMode = "local" | "hybrid" | "remote";

export interface StorageEnv {
  name: string;
}

export interface StorageStatus {
  configured: boolean;
  mode: StorageMode;
  sourceOfTruth: "local" | "postgres";
  localCache: "source" | "explicit-sync" | "runtime-cache";
  maileryMode: MaileryMode;
  maileryModeLabel: MaileryModeLabel;
  maileryModeSource: MaileryModeSource;
  maileryModeWarning: string | null;
  env: typeof STORAGE_DATABASE_ENV;
  modeEnv: typeof STORAGE_MODE_ENV;
  activeEnv: string | null;
  canonical: CanonicalOpenEmailsRdsConfig;
  service: "emails";
  tables: readonly StorageTable[];
  sync: SyncMeta[];
}

export interface StorageStatusOptions {
  includeSyncMeta?: boolean;
}

export const EMAILS_STORAGE_ENV = "HASNA_EMAILS_DATABASE_URL";
export const EMAILS_STORAGE_FALLBACK_ENV = "EMAILS_DATABASE_URL";
export const EMAILS_STORAGE_MODE_ENV = LEGACY_STORAGE_MODE_ENV;
export const EMAILS_STORAGE_MODE_FALLBACK_ENV = LEGACY_STORAGE_MODE_FALLBACK_ENV;
export const STORAGE_DATABASE_ENV = [EMAILS_STORAGE_ENV, EMAILS_STORAGE_FALLBACK_ENV] as const;
export const STORAGE_MODE_ENV = [EMAILS_STORAGE_MODE_ENV, EMAILS_STORAGE_MODE_FALLBACK_ENV] as const;

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function getStorageDatabaseEnv(): StorageEnv | null {
  const name = getStorageDatabaseEnvName();
  return name ? { name } : null;
}

export function getStorageDatabaseEnvName(): (typeof STORAGE_DATABASE_ENV)[number] | null {
  for (const name of STORAGE_DATABASE_ENV) {
    if (readEnv(name)) return name;
  }
  return null;
}

export function getStorageDatabaseUrl(): string | null {
  const env = getStorageDatabaseEnv();
  return env ? readEnv(env.name) : null;
}

function normalizeStorageMode(value: string): StorageMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "local" || normalized === "hybrid" || normalized === "remote") return normalized;
  throw new Error(`Unknown emails storage mode: ${value}`);
}

export function getStorageMode(): StorageMode {
  for (const env of STORAGE_MODE_ENV) {
    const value = readEnv(env);
    if (value) return normalizeStorageMode(value);
  }
  return resolveMaileryMode().mode === "self_hosted" ? "remote" : "local";
}

export function getStorageStatus(options: StorageStatusOptions = {}): StorageStatus {
  const activeEnv = getStorageDatabaseEnv();
  const maileryMode = resolveMaileryMode();
  const mode = getStorageMode();
  return {
    configured: Boolean(activeEnv),
    mode,
    sourceOfTruth: mode === "remote" ? "postgres" : "local",
    localCache: mode === "remote" ? "runtime-cache" : mode === "hybrid" ? "explicit-sync" : "source",
    maileryMode: maileryMode.mode,
    maileryModeLabel: maileryMode.label,
    maileryModeSource: maileryMode.source,
    maileryModeWarning: maileryMode.warning,
    env: STORAGE_DATABASE_ENV,
    modeEnv: STORAGE_MODE_ENV,
    activeEnv: activeEnv?.name ?? null,
    canonical: getCanonicalOpenEmailsRdsConfig(),
    service: "emails",
    tables: STORAGE_TABLES,
    sync: options.includeSyncMeta ? getSyncMetaAll() : [],
  };
}

export async function getStoragePg(): Promise<PgAdapterAsync> {
  const url = getStorageDatabaseUrl();
  if (!url) {
    throw new Error("Missing HASNA_EMAILS_DATABASE_URL or EMAILS_DATABASE_URL");
  }
  const { PgAdapterAsync } = await import("./remote-storage.js");
  return new PgAdapterAsync(url);
}

export async function runStorageMigrations(remote: PgAdapterAsync): Promise<void> {
  const { PG_MIGRATIONS } = await import("./pg-migrations.js");
  await remote.run("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  const [baseMigration, ...remaining] = PG_MIGRATIONS;
  if (baseMigration) await remote.run(baseMigration);
  const appliedRows = await remote.all("SELECT id FROM _migrations");
  const applied = new Set(appliedRows.map((row) => Number((row as { id?: unknown }).id)).filter(Number.isFinite));
  for (const sql of remaining) {
    const id = migrationId(sql);
    if (id !== null && applied.has(id)) continue;
    await remote.run(sql);
    if (id !== null) applied.add(id);
  }
}

function migrationId(sql: string): number | null {
  const match = sql.match(/INSERT\s+INTO\s+_migrations\s*\(\s*id\s*\)\s*VALUES\s*\(\s*(\d+)\s*\)/i);
  return match ? Number(match[1]) : null;
}

export async function storagePush(options?: StorageSyncOptions): Promise<SyncResult[]> {
  const remote = await getStoragePg();
  const db = getDatabase();
  try {
    await runStorageMigrations(remote);
    const results: SyncResult[] = [];
    for (const table of parseStorageTables(options?.tables)) {
      results.push(await pushTable(db, remote, table, {
        batchSize: options?.batchSize,
        filter: options?.rowFilters?.[table],
      }));
    }
    try {
      await reconcileRemoteDerivedState(remote);
    } catch (error) {
      // Derived-state reconcile is best-effort, idempotent cleanup. The pushed
      // rows are already committed, so a reconcile failure (e.g. statement
      // timeout on a very large table) must not fail the push; the next push
      // picks the cleanup back up where the committed batches left off.
      console.error(`emails storage push: remote derived-state reconcile failed (will retry on next push): ${error instanceof Error ? error.message : String(error)}`);
    }
    await recordRemoteSyncMeta(remote, "push", results);
    recordSyncMeta(db, "push", results);
    return results;
  } finally {
    await remote.close();
  }
}

export async function prepareLocalMigrationDedupePlan(
  remote: PgAdapterAsync,
  db: Database = getDatabase(),
): Promise<LocalMigrationDedupePlan> {
  createMigrationDedupeTempTables(db);

  const inboundCandidates = sqliteTableExists(db, "inbound_emails")
    ? db.query<Row, []>(`
        SELECT id,
               provider_id,
               message_id,
               COALESCE(NULLIF(mail_message_id, ''), 'msg:inbound:' || id) AS mail_message_id
          FROM inbound_emails
         WHERE provider_id IS NOT NULL
           AND provider_id != ''
           AND message_id IS NOT NULL
           AND message_id != ''
      `).all()
    : [];

  const remoteInboundByNaturalKey = new Map<string, Row>();
  for (const batch of chunks(inboundCandidates, 250)) {
    const placeholders = batch.map(() => "(?, ?)").join(", ");
    const params = batch.flatMap((row) => [row.provider_id, row.message_id]);
    const rows = await remote.all(
      `SELECT id,
              provider_id,
              message_id,
              COALESCE(NULLIF(mail_message_id, ''), 'msg:inbound:' || id) AS mail_message_id
         FROM inbound_emails
        WHERE (provider_id, message_id) IN (${placeholders})`,
      ...params,
    ) as Row[];
    for (const row of rows) {
      remoteInboundByNaturalKey.set(naturalKey(row.provider_id, row.message_id), row);
    }
  }

  const skipInbound = db.prepare(`
    INSERT OR IGNORE INTO ${quoteIdent(MIGRATION_SKIP_INBOUND_TABLE)} (id, mail_message_id, remote_id, remote_mail_message_id)
    VALUES (?, ?, ?, ?)
  `);
  for (const row of inboundCandidates) {
    const remoteRow = remoteInboundByNaturalKey.get(naturalKey(row.provider_id, row.message_id));
    if (!remoteRow) continue;
    const localId = String(row.id ?? "");
    const remoteId = String(remoteRow.id ?? "");
    if (!localId || !remoteId || localId === remoteId) continue;
    skipInbound.run(localId, stringOrNull(row.mail_message_id), remoteId, stringOrNull(remoteRow.mail_message_id));
  }

  const stateCandidates = sqliteTableExists(db, "mailbox_message_state")
    ? db.query<Row, []>(`
        SELECT id, source_id, source_dedupe_key
          FROM mailbox_message_state
         WHERE source_id IS NOT NULL
           AND source_id != ''
           AND source_dedupe_key IS NOT NULL
           AND source_dedupe_key != ''
      `).all()
    : [];

  const remoteStateByNaturalKey = new Map<string, Row>();
  for (const batch of chunks(stateCandidates, 250)) {
    const placeholders = batch.map(() => "(?, ?)").join(", ");
    const params = batch.flatMap((row) => [row.source_id, row.source_dedupe_key]);
    const rows = await remote.all(
      `SELECT id, source_id, source_dedupe_key
         FROM mailbox_message_state
        WHERE (source_id, source_dedupe_key) IN (${placeholders})`,
      ...params,
    ) as Row[];
    for (const row of rows) {
      remoteStateByNaturalKey.set(naturalKey(row.source_id, row.source_dedupe_key), row);
    }
  }

  const skipState = db.prepare(`
    INSERT OR IGNORE INTO ${quoteIdent(MIGRATION_SKIP_MAILBOX_STATE_TABLE)} (id, remote_id)
    VALUES (?, ?)
  `);
  for (const row of stateCandidates) {
    const remoteRow = remoteStateByNaturalKey.get(naturalKey(row.source_id, row.source_dedupe_key));
    if (!remoteRow) continue;
    const localId = String(row.id ?? "");
    const remoteId = String(remoteRow.id ?? "");
    if (!localId || !remoteId || localId === remoteId) continue;
    skipState.run(localId, remoteId);
  }

  const skippedInboundEmails = countTempRows(db, MIGRATION_SKIP_INBOUND_TABLE);
  const skippedMailMessages = countTempRowsWhere(db, MIGRATION_SKIP_INBOUND_TABLE, "mail_message_id IS NOT NULL AND mail_message_id != ''");
  const skippedMailboxMessageStates = countTempRows(db, MIGRATION_SKIP_MAILBOX_STATE_TABLE);

  return {
    rowFilters: migrationDedupeRowFilters(),
    skippedInboundEmails,
    skippedMailMessages,
    skippedMailboxMessageStates,
  };
}

export interface StoragePullMarker {
  pulledAt: string;
  tables: string[];
}

function isPersistentDbPath(path: string): boolean {
  return Boolean(path) && path !== ":memory:" && !path.startsWith("file::memory:");
}

export function getStoragePullMarkerPath(dbPath: string = getDatabasePath()): string {
  return `${dbPath}.last-pull.json`;
}

export function recordStoragePullMarker(
  tables: readonly string[],
  dbPath: string = getDatabasePath(),
  pulledAtMs: number = Date.now(),
): void {
  if (!isPersistentDbPath(dbPath)) return;
  const markerPath = getStoragePullMarkerPath(dbPath);
  const tempPath = `${markerPath}.${process.pid}.tmp`;
  try {
    const marker: StoragePullMarker = { pulledAt: new Date(pulledAtMs).toISOString(), tables: [...tables] };
    writeFileSync(tempPath, `${JSON.stringify(marker, null, 2)}\n`);
    renameSync(tempPath, markerPath);
  } catch (error) {
    process.stderr.write(`[mailery storage] failed to write pull marker ${markerPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    try {
      rmSync(tempPath, { force: true });
    } catch {}
  }
}

/**
 * True when the local database file contains committed pull sync metadata,
 * i.e. it was provably populated by a successful pull from remote storage.
 * A schema-initialized but never-pulled cache (e.g. left behind by a failed
 * pull) returns false.
 */
export function localDatabaseHasCommittedPull(dbPath: string = getDatabasePath()): boolean {
  if (!isPersistentDbPath(dbPath) || !existsSync(dbPath)) return false;
  let db: SqliteDatabase | null = null;
  try {
    db = new SqliteDatabase(dbPath, { readonly: true });
    const tableExists = db
      .query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = '_emails_sync_meta' LIMIT 1")
      .get();
    if (!tableExists) return false;
    return Boolean(db.query("SELECT 1 AS ok FROM _emails_sync_meta WHERE direction = 'pull' LIMIT 1").get());
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export function readStoragePullMarker(dbPath: string = getDatabasePath()): StoragePullMarker | null {
  if (!isPersistentDbPath(dbPath)) return null;
  const markerPath = getStoragePullMarkerPath(dbPath);
  if (!existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<StoragePullMarker> | null;
    const pulledAt = typeof parsed?.pulledAt === "string" ? parsed.pulledAt : null;
    if (!pulledAt || !Number.isFinite(Date.parse(pulledAt))) return null;
    const tables = Array.isArray(parsed?.tables)
      ? parsed.tables.filter((table): table is string => typeof table === "string")
      : [];
    return { pulledAt, tables };
  } catch {
    return null;
  }
}

export async function storagePull(options?: StorageSyncOptions): Promise<SyncResult[]> {
  const remote = await getStoragePg();
  const db = getDatabase();
  try {
    await runStorageMigrations(remote);
    const results = await pullTablesFromRemote(remote, db, options);
    if (!options?.tables && results.every((result) => result.errors.length === 0)) {
      recordStoragePullMarker(STORAGE_TABLES);
    }
    return results;
  } finally {
    await remote.close();
  }
}

let localStorageTransactionCounter = 0;

function beginLocalStorageTransaction(db: Database): string {
  const savepoint = `emails_storage_sync_${++localStorageTransactionCounter}`;
  db.exec(`SAVEPOINT ${quoteIdent(savepoint)}`);
  return savepoint;
}

function releaseLocalStorageTransaction(db: Database, savepoint: string): void {
  db.exec(`RELEASE ${quoteIdent(savepoint)}`);
}

function rollbackLocalStorageTransaction(db: Database, savepoint: string): void {
  try {
    db.exec(`ROLLBACK TO ${quoteIdent(savepoint)}`);
  } finally {
    db.exec(`RELEASE ${quoteIdent(savepoint)}`);
  }
}

export async function pullTablesFromRemote(remote: PgAdapterAsync, db: Database, options?: StorageSyncOptions): Promise<SyncResult[]> {
  const savepoint = beginLocalStorageTransaction(db);
  let finished = false;
  try {
    const results: SyncResult[] = [];
    const tables = parseStorageTables(options?.tables);
    if (options?.replace) {
      for (const table of [...tables].reverse()) {
        if (sqliteTableExists(db, table)) db.run(`DELETE FROM ${quoteIdent(table)}`);
      }
    }
    for (const table of tables) {
      results.push(await pullTable(remote, db, table, { batchSize: options?.batchSize }));
    }
    const failures = results.filter((result) => result.errors.length > 0);
    if (failures.length > 0) {
      rollbackLocalStorageTransaction(db, savepoint);
      finished = true;
      return results;
    }
    reconcileLocalDerivedState(db);
    await recordRemoteSyncMeta(remote, "pull", results);
    recordSyncMeta(db, "pull", results);
    releaseLocalStorageTransaction(db, savepoint);
    finished = true;
    return results;
  } finally {
    if (!finished) rollbackLocalStorageTransaction(db, savepoint);
  }
}

function reconcileLocalDerivedState(db: Database): void {
  rebuildInboundLabelState(db);
  reconcileMailboxMessageState(db);
}

/**
 * Advisory-lock key for the remote derived-state reconcile. Documented literal
 * constant: the ASCII bytes of "mailery1" read as a big-endian signed int64
 * (0x6d61696c65727931 = 7881696737154464049), so the key is stable across
 * versions and clearly namespaced to Mailery. Every Mailery process (CLI push,
 * MCP daemon, self-hosted runtime) funnels the reconcile through
 * pg_try_advisory_lock on this key; whoever loses the race skips the run.
 *
 * Deployment caveat: advisory locks are backend-session-scoped, so the lock is
 * only reliable on direct Postgres connections (or session-mode pooling). A
 * transaction-mode pooler (pgbouncer transaction pooling, multiplexing RDS
 * Proxy) can route each statement to a different backend, which would strand
 * the lock and make every future reconcile skip until that backend recycles.
 */
export const REMOTE_RECONCILE_LOCK_KEY = 0x6d61696c65727931n;
/** Per-statement timeout for reconcile work so pathological plans self-terminate. */
export const REMOTE_RECONCILE_STATEMENT_TIMEOUT_MS = 180_000;
/** Stale-label rows removed per DELETE batch (each batch is its own short transaction). */
export const REMOTE_RECONCILE_LABEL_DELETE_BATCH_SIZE = 5_000;
/** Hard safety cap on DELETE batches per run (~1M rows); the next run continues the cleanup. */
export const REMOTE_RECONCILE_MAX_LABEL_DELETE_BATCHES = 200;

export interface RemoteReconcileResult {
  /** True when another instance held the advisory lock and this run did nothing. */
  skipped: boolean;
  staleLabelBatches: number;
  staleLabelsDeleted: number;
  /** True when the batch cap stopped the cleanup early; remaining rows are handled by the next run. */
  reachedBatchCap: boolean;
}

export interface RemoteReconcileOptions {
  labelDeleteBatchSize?: number;
  maxLabelDeleteBatches?: number;
}

function isPgTrue(value: unknown): boolean {
  return value === true || value === 1 || value === "t" || value === "true" || value === "1";
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || value === null || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

/**
 * Rebuilds remote derived state (inbound_labels, spam/trash flags, mailbox
 * message state) after a push. This is best-effort, idempotent cleanup:
 * skipping a run (because another instance holds the advisory lock) or
 * stopping at the batch cap is safe — the next push converges the state.
 *
 * Incident hardening (2026-07-03 RDS outage):
 * - Single-flight via pg_try_advisory_lock so N concurrent MCP instances
 *   cannot pile up in a lock convoy on the same full-table cleanup.
 * - The stale-label DELETE runs in bounded ctid batches instead of one
 *   multi-hour full-table transaction.
 * - statement_timeout is set on the pinned session (and reset before the
 *   connection returns to the pool) so no reconcile statement can hold row
 *   locks for hours even with a pathological plan.
 */
export async function reconcileRemoteDerivedState(
  remote: PgAdapterAsync,
  options?: RemoteReconcileOptions,
): Promise<RemoteReconcileResult> {
  const batchSize = normalizePositiveInt(options?.labelDeleteBatchSize, REMOTE_RECONCILE_LABEL_DELETE_BATCH_SIZE);
  const maxBatches = normalizePositiveInt(options?.maxLabelDeleteBatches, REMOTE_RECONCILE_MAX_LABEL_DELETE_BATCHES);
  return remote.withSession(async (session) => {
    const lockRows = await session.all(
      `SELECT pg_try_advisory_lock(${REMOTE_RECONCILE_LOCK_KEY}) AS locked`,
    ) as Array<{ locked?: unknown }>;
    if (!isPgTrue(lockRows[0]?.locked)) {
      return { skipped: true, staleLabelBatches: 0, staleLabelsDeleted: 0, reachedBatchCap: false };
    }
    let result: RemoteReconcileResult;
    try {
      await session.run(`SET statement_timeout TO ${REMOTE_RECONCILE_STATEMENT_TIMEOUT_MS}`);

      let staleLabelBatches = 0;
      let staleLabelsDeleted = 0;
      let reachedBatchCap = false;
      for (;;) {
        const { changes } = await session.run(`
          DELETE FROM inbound_labels
           WHERE ctid IN (
             SELECT label.ctid
               FROM inbound_labels label
              WHERE NOT EXISTS (
                SELECT 1
                  FROM inbound_emails inbound,
                       mailery_jsonb_array_text(inbound.label_ids_json) AS value
                 WHERE inbound.id = label.inbound_email_id
                   AND trim(value) != ''
                   AND left(regexp_replace(lower(trim(value)), '\\s+', '-', 'g'), 64) = label.label
              )
              LIMIT ?
           )
        `, batchSize);
        staleLabelBatches += 1;
        staleLabelsDeleted += changes;
        if (changes < batchSize) break;
        if (staleLabelBatches >= maxBatches) {
          reachedBatchCap = true;
          break;
        }
      }

      await session.run(`
        INSERT INTO inbound_labels (inbound_email_id, label)
        SELECT inbound.id, left(regexp_replace(lower(trim(value)), '\\s+', '-', 'g'), 64)
          FROM inbound_emails inbound,
               mailery_jsonb_array_text(inbound.label_ids_json) AS value
         WHERE inbound.label_ids_json IS NOT NULL
           AND trim(value) != ''
        ON CONFLICT DO NOTHING
      `);

      await session.run(`
        UPDATE inbound_emails
           SET is_spam = CASE WHEN EXISTS (
                 SELECT 1 FROM inbound_labels
                  WHERE inbound_email_id = inbound_emails.id
                    AND label = 'spam'
               ) THEN 1 ELSE 0 END,
               is_trash = CASE WHEN EXISTS (
                 SELECT 1 FROM inbound_labels
                  WHERE inbound_email_id = inbound_emails.id
                    AND label = 'trash'
               ) THEN 1 ELSE 0 END
         WHERE is_spam IS DISTINCT FROM CASE WHEN EXISTS (
                 SELECT 1 FROM inbound_labels
                  WHERE inbound_email_id = inbound_emails.id
                    AND label = 'spam'
               ) THEN 1 ELSE 0 END
            OR is_trash IS DISTINCT FROM CASE WHEN EXISTS (
                 SELECT 1 FROM inbound_labels
                  WHERE inbound_email_id = inbound_emails.id
                    AND label = 'trash'
               ) THEN 1 ELSE 0 END
      `);

      await session.run(`
        UPDATE mailbox_message_state state
           SET labels_json = inbound.label_ids_json,
               is_read = inbound.is_read,
               read_at = NULLIF(inbound.read_at, '')::TIMESTAMPTZ,
               is_archived = inbound.is_archived,
               is_starred = inbound.is_starred,
               is_spam = inbound.is_spam,
               is_trash = inbound.is_trash,
               folder_id = 'folder:' || state.mailbox_id || ':' ||
                 CASE
                   WHEN COALESCE(inbound.is_sent, 0) = 1 THEN 'sent'
                   WHEN COALESCE(inbound.is_trash, 0) = 1 THEN 'trash'
                   WHEN COALESCE(inbound.is_spam, 0) = 1 THEN 'spam'
                   WHEN COALESCE(inbound.is_archived, 0) = 1 THEN 'archive'
                   ELSE 'inbox'
                 END,
               updated_at = NOW()
          FROM inbound_emails inbound
         WHERE state.mail_message_id = COALESCE(inbound.mail_message_id, 'msg:inbound:' || inbound.id)
           AND (
                state.labels_json IS DISTINCT FROM inbound.label_ids_json
             OR state.is_read IS DISTINCT FROM inbound.is_read
             OR state.read_at IS DISTINCT FROM NULLIF(inbound.read_at, '')::TIMESTAMPTZ
             OR state.is_archived IS DISTINCT FROM inbound.is_archived
             OR state.is_starred IS DISTINCT FROM inbound.is_starred
             OR state.is_spam IS DISTINCT FROM inbound.is_spam
             OR state.is_trash IS DISTINCT FROM inbound.is_trash
             OR state.folder_id IS DISTINCT FROM 'folder:' || state.mailbox_id || ':' ||
                 CASE
                   WHEN COALESCE(inbound.is_sent, 0) = 1 THEN 'sent'
                   WHEN COALESCE(inbound.is_trash, 0) = 1 THEN 'trash'
                   WHEN COALESCE(inbound.is_spam, 0) = 1 THEN 'spam'
                   WHEN COALESCE(inbound.is_archived, 0) = 1 THEN 'archive'
                   ELSE 'inbox'
                 END
           )
      `);

      result = { skipped: false, staleLabelBatches, staleLabelsDeleted, reachedBatchCap };
    } catch (error) {
      // Best-effort cleanup that must never mask the root-cause error. The
      // rethrow below makes withSession destroy this pooled connection, so a
      // failed RESET cannot leak the timeout into the pool, and a failed
      // unlock is released server-side when the backend session ends.
      try {
        await session.run("RESET statement_timeout");
      } catch { /* connection is destroyed below */ }
      try {
        await session.run(`SELECT pg_advisory_unlock(${REMOTE_RECONCILE_LOCK_KEY})`);
      } catch { /* released at disconnect */ }
      throw error;
    }
    // Success path: cleanup failures here are real errors — silently returning
    // the connection to the pool with a leaked statement_timeout or a held
    // advisory lock is worse than failing the reconcile (the thrown error
    // makes withSession destroy the connection, releasing both server-side).
    await session.run("RESET statement_timeout");
    await session.run(`SELECT pg_advisory_unlock(${REMOTE_RECONCILE_LOCK_KEY})`);
    return result;
  });
}

export async function storageSync(options?: StorageSyncOptions, hooks: StorageSyncHooks = {}): Promise<{ pull: SyncResult[]; push: SyncResult[] }> {
  if (!options?.force) {
    throw new Error("storage sync runs pull then push and can overwrite local rows with remote values. Re-run with --force after reviewing conflicts, or run storage pull/storage push explicitly.");
  }
  const pull = await (hooks.pull ?? storagePull)(options);
  const failures = pull.filter((result) => result.errors.length > 0);
  if (failures.length > 0) {
    throw new Error(`Storage sync stopped after pull errors; push was not run. ${failures.map((result) => `${result.table}: ${result.errors.join("; ")}`).join(" | ")}`);
  }
  const push = await (hooks.push ?? storagePush)(options);
  return { pull, push };
}

export function getSyncMetaAll(): SyncMeta[] {
  const db = getDatabase();
  ensureSyncMetaTable(db);
  return db.query<SyncMeta, []>("SELECT table_name, last_synced_at, direction FROM _emails_sync_meta ORDER BY table_name, direction").all();
}

export async function getRemoteSyncMetaAll(remote: PgAdapterAsync): Promise<SyncMeta[]> {
  await ensureRemoteSyncMetaTable(remote);
  const rows = await remote.all(`
    SELECT table_name, last_synced_at, direction
      FROM "_emails_sync_meta"
     ORDER BY table_name, direction
  `) as Array<{ table_name?: unknown; last_synced_at?: unknown; direction?: unknown }>;
  return rows.flatMap((row) => {
    const tableName = String(row.table_name ?? "");
    const direction = row.direction === "push" || row.direction === "pull" ? row.direction : null;
    if (!tableName || !direction) return [];
    return [{
      table_name: tableName,
      last_synced_at: row.last_synced_at == null ? null : String(row.last_synced_at),
      direction,
    }];
  });
}

export function parseStorageTables(tables?: string[]): StorageTable[] {
  if (!tables || tables.length === 0) return [...STORAGE_TABLES];
  const allowed = new Set<string>(STORAGE_TABLES);
  const requested = tables.map((table) => table.trim()).filter(Boolean);
  const invalid = requested.filter((table) => !allowed.has(table));
  if (invalid.length > 0) throw new Error(`Unknown emails sync table(s): ${invalid.join(", ")}`);
  return requested as StorageTable[];
}

export const resolveTables = parseStorageTables;

export async function pushTable(
  db: Database,
  remote: PgAdapterAsync,
  table: StorageTable,
  options?: { batchSize?: number; filter?: StorageTableFilter },
): Promise<SyncResult> {
  const result: SyncResult = { table, rowsRead: 0, rowsWritten: 0, errors: [] };
  try {
    if (!sqliteTableExists(db, table)) return result;
    const remoteColumns = await getRemoteColumns(remote, table);
    const batchSize = normalizeBatchSize(options?.batchSize);
    const filter = normalizeStorageTableFilter(options?.filter);
    const whereSql = filter ? ` WHERE ${filter.where}` : "";
    for (let offset = 0; ; offset += batchSize) {
      const params = [...(filter?.params ?? []), batchSize, offset];
      const rows = db
        .query<Row, StorageTableFilterParam[]>(`SELECT * FROM ${quoteIdent(table)}${whereSql} ORDER BY ${orderByPrimaryKey(table)} LIMIT ? OFFSET ?`)
        .all(...params);
      result.rowsRead += rows.length;
      if (rows.length === 0) break;
      const columns = filterRemotePushColumns(table, filterRemoteColumns(remoteColumns, Object.keys(rows[0]!)));
      result.rowsWritten += await upsertPg(remote, table, columns, rows, remoteColumns);
      if (rows.length < batchSize) break;
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}

function normalizeStorageTableFilter(filter: StorageTableFilter | undefined): StorageTableFilter | null {
  if (!filter) return null;
  const where = filter.where.trim();
  if (!where) return null;
  if (/[;]/.test(where) || /--|\/\*/.test(where)) {
    throw new Error("Storage table filters must be a single parameterized SQL predicate.");
  }
  return { where, params: filter.params ?? [] };
}

const MIGRATION_SKIP_INBOUND_TABLE = "_mailery_migration_skip_inbound_ids";
const MIGRATION_SKIP_MAILBOX_STATE_TABLE = "_mailery_migration_skip_mailbox_state_ids";

function createMigrationDedupeTempTables(db: Database): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS ${quoteIdent(MIGRATION_SKIP_INBOUND_TABLE)} (
      id TEXT PRIMARY KEY,
      mail_message_id TEXT,
      remote_id TEXT,
      remote_mail_message_id TEXT
    );
    DELETE FROM ${quoteIdent(MIGRATION_SKIP_INBOUND_TABLE)};

    CREATE TEMP TABLE IF NOT EXISTS ${quoteIdent(MIGRATION_SKIP_MAILBOX_STATE_TABLE)} (
      id TEXT PRIMARY KEY,
      remote_id TEXT
    );
    DELETE FROM ${quoteIdent(MIGRATION_SKIP_MAILBOX_STATE_TABLE)};
  `);
}

function migrationDedupeRowFilters(): LocalMigrationDedupePlan["rowFilters"] {
  const skippedInbound = quoteIdent(MIGRATION_SKIP_INBOUND_TABLE);
  const skippedState = quoteIdent(MIGRATION_SKIP_MAILBOX_STATE_TABLE);
  return {
    inbound_emails: {
      where: `id NOT IN (SELECT id FROM ${skippedInbound})`,
    },
    inbound_recipients: {
      where: `inbound_email_id NOT IN (SELECT id FROM ${skippedInbound})`,
    },
    inbound_labels: {
      where: `inbound_email_id NOT IN (SELECT id FROM ${skippedInbound})`,
    },
    mail_messages: {
      where: `id NOT IN (SELECT mail_message_id FROM ${skippedInbound} WHERE mail_message_id IS NOT NULL AND mail_message_id != '')`,
    },
    mailbox_message_state: {
      where: `mail_message_id NOT IN (SELECT mail_message_id FROM ${skippedInbound} WHERE mail_message_id IS NOT NULL AND mail_message_id != '') AND id NOT IN (SELECT id FROM ${skippedState})`,
    },
    email_triage: {
      where: `inbound_email_id IS NULL OR inbound_email_id NOT IN (SELECT id FROM ${skippedInbound})`,
    },
  };
}

function countTempRows(db: Database, table: string): number {
  return countTempRowsWhere(db, table, "1 = 1");
}

function countTempRowsWhere(db: Database, table: string, where: string): number {
  const row = db.query(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)} WHERE ${where}`).get() as { count?: unknown } | null;
  const count = Number(row?.count ?? 0);
  return Number.isFinite(count) ? count : 0;
}

function chunks<T>(rows: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) batches.push(rows.slice(offset, offset + size));
  return batches;
}

function naturalKey(left: unknown, right: unknown): string {
  return `${String(left ?? "")}\0${String(right ?? "")}`;
}

function stringOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text ? text : null;
}

export async function pullTable(remote: PgAdapterAsync, db: Database, table: StorageTable, options?: { batchSize?: number }): Promise<SyncResult> {
  const result: SyncResult = { table, rowsRead: 0, rowsWritten: 0, errors: [] };
  try {
    if (!sqliteTableExists(db, table)) return result;
    const batchSize = normalizeBatchSize(options?.batchSize);
    for (let offset = 0; ; offset += batchSize) {
      const rows = await remote.all(
        `SELECT * FROM ${quoteIdent(table)} ORDER BY ${orderByPrimaryKey(table)} LIMIT ? OFFSET ?`,
        batchSize,
        offset,
      ) as Row[];
      result.rowsRead += rows.length;
      if (rows.length === 0) break;
      const columns = filterLocalColumns(db, table, Object.keys(rows[0]!));
      result.rowsWritten += upsertSqlite(db, table, columns, rows);
      if (rows.length < batchSize) break;
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined || value === null) return STORAGE_SYNC_BATCH_SIZE;
  return Number.isFinite(value) ? Math.max(1, Math.min(5000, Math.trunc(value))) : STORAGE_SYNC_BATCH_SIZE;
}

function orderByPrimaryKey(table: StorageTable): string {
  return PRIMARY_KEYS[table].map(quoteIdent).join(", ");
}

async function getRemoteColumns(remote: PgAdapterAsync, table: string): Promise<Map<string, string>> {
  const rows = await remote.all(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?",
    table,
  ) as Array<{ column_name: string; data_type: string }>;
  return new Map(rows.map((row) => [row.column_name, row.data_type]));
}

function filterRemoteColumns(remoteColumns: Map<string, string>, columns: string[]): string[] {
  return remoteColumns.size === 0 ? columns : columns.filter((column) => remoteColumns.has(column));
}

function filterRemotePushColumns(table: StorageTable, columns: string[]): string[] {
  const omitted = REMOTE_PUSH_OMIT_COLUMNS[table];
  if (!omitted) return columns;
  return columns.filter((column) => !omitted.has(column));
}

function filterLocalColumns(db: Database, table: string, columns: string[]): string[] {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${quoteIdent(table)})`).all();
  const allowed = new Set(rows.map((row) => row.name));
  return columns.filter((column) => allowed.has(column));
}

async function upsertPg(remote: PgAdapterAsync, table: StorageTable, columns: string[], rows: Row[], remoteColumns: Map<string, string>): Promise<number> {
  if (columns.length === 0) return 0;
  const primaryKeys = PRIMARY_KEYS[table];
  const columnList = columns.map(quoteIdent).join(", ");
  const keyList = primaryKeys.map(quoteIdent).join(", ");
  const updateColumns = columns.filter((column) => !primaryKeys.includes(column));
  const fallbackKey = primaryKeys[0]!;
  const setClause = updateColumns.length > 0
    ? updateColumns.map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`).join(", ")
    : `${quoteIdent(fallbackKey)} = EXCLUDED.${quoteIdent(fallbackKey)}`;
  const maxRowsPerStatement = Math.max(1, Math.floor(POSTGRES_UPSERT_PARAM_BUDGET / columns.length));
  let written = 0;
  for (let offset = 0; offset < rows.length; offset += maxRowsPerStatement) {
    const batch = rows.slice(offset, offset + maxRowsPerStatement);
    const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
    const placeholders = batch.map(() => rowPlaceholder).join(", ");
    const params = batch.flatMap((row) => columns.map((column) => coerceForPg(row[column], remoteColumns.get(column))));
    await remote.run(
      `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES ${placeholders} ON CONFLICT (${keyList}) DO UPDATE SET ${setClause}`,
      ...params,
    );
    written += batch.length;
  }
  return written;
}

function upsertSqlite(db: Database, table: StorageTable, columns: string[], rows: Row[]): number {
  if (columns.length === 0) return 0;
  const primaryKeys = PRIMARY_KEYS[table];
  const columnList = columns.map(quoteIdent).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const keyList = primaryKeys.map(quoteIdent).join(", ");
  const updateColumns = columns.filter((column) => !primaryKeys.includes(column));
  const fallbackKey = primaryKeys[0]!;
  const setClause = updateColumns.length > 0
    ? updateColumns.map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`).join(", ")
    : `${quoteIdent(fallbackKey)} = excluded.${quoteIdent(fallbackKey)}`;
  const statement = db.prepare(`INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${placeholders}) ON CONFLICT (${keyList}) DO UPDATE SET ${setClause}`);
  for (const row of rows) statement.run(...columns.map((column) => coerceForSqlite(row[column])));
  return rows.length;
}

function recordSyncMeta(db: Database, direction: "push" | "pull", results: SyncResult[]): void {
  ensureSyncMetaTable(db);
  const timestamp = new Date().toISOString();
  const statement = db.prepare(
    "INSERT INTO _emails_sync_meta (table_name, last_synced_at, direction) VALUES (?, ?, ?) ON CONFLICT(table_name, direction) DO UPDATE SET last_synced_at = excluded.last_synced_at",
  );
  for (const result of results) {
    if (result.errors.length > 0) continue;
    statement.run(result.table, timestamp, direction);
  }
}

function ensureSyncMetaTable(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS _emails_sync_meta (table_name TEXT NOT NULL, last_synced_at TEXT, direction TEXT NOT NULL CHECK(direction IN ('push', 'pull')), PRIMARY KEY (table_name, direction))");
}

async function ensureRemoteSyncMetaTable(remote: PgAdapterAsync): Promise<void> {
  await remote.run(`
    CREATE TABLE IF NOT EXISTS "_emails_sync_meta" (
      table_name TEXT NOT NULL,
      last_synced_at TIMESTAMPTZ,
      direction TEXT NOT NULL CHECK(direction IN ('push', 'pull')),
      PRIMARY KEY (table_name, direction)
    )
  `);
}

export async function recordRemoteSyncMeta(remote: PgAdapterAsync, direction: "push" | "pull", results: SyncResult[]): Promise<void> {
  await ensureRemoteSyncMetaTable(remote);
  const timestamp = new Date().toISOString();
  for (const result of results) {
    if (result.errors.length > 0) continue;
    await remote.run(
      `INSERT INTO "_emails_sync_meta" (table_name, last_synced_at, direction)
       VALUES (?, ?, ?)
       ON CONFLICT (table_name, direction)
       DO UPDATE SET last_synced_at = EXCLUDED.last_synced_at`,
      result.table,
      timestamp,
      direction,
    );
  }
}

function sqliteTableExists(db: Database, table: string): boolean {
  return Boolean(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table));
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function coerceForPg(value: unknown, dataType?: string): unknown {
  if (value === undefined || value === null) return null;
  if (dataType === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function coerceForSqlite(value: unknown): string | number | bigint | boolean | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
