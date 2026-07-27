import { Database } from "bun:sqlite";
// Re-export so all db/lib modules import Database from here instead of bun:sqlite
export type { Database };
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { sqlEmailAddress, sqlEmailDomain } from "./email-address-sql.js";

function isInMemoryDb(path: string): boolean {
  return path === ":memory:";
}

type FileStats = NonNullable<ReturnType<typeof lstatSync>>;

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function lstatIfExists(path: string): FileStats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function currentUid(): number | null {
  if (process.platform === "win32" || typeof process.getuid !== "function") return null;
  return process.getuid();
}

function assertOwned(stats: FileStats, path: string, kind: string): void {
  const uid = currentUid();
  if (uid !== null && stats.uid !== uid) {
    throw new Error(`Refusing ${kind} at ${path}: it is owned by uid ${stats.uid}, not the current uid ${uid}`);
  }
}

function assertSameFile(expected: FileStats, actual: FileStats, path: string): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new Error(`Refusing filesystem race at ${path}: the path changed during validation`);
  }
}

function directoryChain(path: string): string[] {
  const chain: string[] = [];
  let current = resolve(path);
  while (true) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain.reverse();
}

/**
 * Resolve the existing portion of a POSIX pathname exactly once, then keep
 * all missing descendants beneath that canonical directory. This accepts
 * stable system aliases such as macOS /var -> /private/var without using the
 * alias again during creation, validation, or SQLite open.
 */
function canonicalizeFromExistingAncestor(path: string): string {
  const resolvedPath = resolve(path);
  if (process.platform === "win32") return resolvedPath;

  const missingComponents: string[] = [];
  let existingAncestor = resolvedPath;
  while (lstatIfExists(existingAncestor) === null) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingComponents.push(basename(existingAncestor));
    existingAncestor = parent;
  }

  const canonicalAncestor = realpathSync(existingAncestor);
  return missingComponents.length === 0
    ? canonicalAncestor
    : join(canonicalAncestor, ...missingComponents.reverse());
}

function canonicalizeDatabasePath(path: string): string {
  const resolvedPath = resolve(path);
  if (process.platform === "win32") return resolvedPath;

  // Do not realpath the database artifact itself: it must remain visible to
  // the O_NOFOLLOW/non-regular-file checks below.
  return join(canonicalizeFromExistingAncestor(dirname(resolvedPath)), basename(resolvedPath));
}

function assertStableDirectory(stats: FileStats, path: string, kind: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const fdStats = fstatSync(fd);
    if (!fdStats.isDirectory()) {
      throw new Error(`Refusing ${kind} at ${path}: expected a directory`);
    }
    assertSameFile(stats, fdStats, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`Refusing ${kind} at ${path}: symbolic links are not allowed`, { cause: error });
    }
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Validate every pathname component before SQLite opens a custom path. The
 * direct parent must belong to this uid and must not be writable by another
 * uid. Every ancestor must be root-owned or current-user-owned; shared-writable
 * ancestors are allowed only at a trusted sticky boundary such as /tmp.
 */
function ensureSecureDirectoryChain(path: string, directCreateMode: number): void {
  if (process.platform === "win32") {
    mkdirSync(path, { recursive: true });
    return;
  }

  const uid = currentUid();
  const chain = directoryChain(path);
  for (let index = 0; index < chain.length; index += 1) {
    const component = chain[index]!;
    const isDirect = index === chain.length - 1;
    let stats = lstatIfExists(component);
    let created = false;

    if (!stats) {
      try {
        mkdirSync(component, { mode: isDirect ? directCreateMode : 0o700 });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stats = lstatSync(component);
    }

    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing SQLite directory at ${component}: symbolic links are not allowed`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Refusing SQLite directory at ${component}: expected a directory`);
    }
    assertStableDirectory(stats, component, "SQLite directory");

    if (created) {
      assertOwned(stats, component, "SQLite directory");
      let fd: number | null = null;
      try {
        fd = openSync(component, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        fchmodSync(fd, isDirect ? directCreateMode : 0o700);
        const hardened = fstatSync(fd);
        assertOwned(hardened, component, "SQLite directory");
        assertSameFile(stats, hardened, component);
      } finally {
        if (fd !== null) closeSync(fd);
      }
      stats = lstatSync(component);
    }

    const mode = Number(stats.mode) & 0o7777;
    const statsUid = Number(stats.uid);
    const writableByOthers = (mode & 0o022) !== 0;
    const sticky = (mode & 0o1000) !== 0;
    const trustedOwner = uid === null || statsUid === uid || statsUid === 0;

    if (isDirect) {
      assertOwned(stats, component, "SQLite parent directory");
      if (writableByOthers) {
        throw new Error(`Refusing unsafe SQLite parent directory at ${component}: group/world-writable directories are not allowed`);
      }
    } else if (writableByOthers && (!sticky || !trustedOwner)) {
      throw new Error(`Refusing unsafe SQLite ancestor directory at ${component}: shared-writable ancestors must be trusted sticky directories`);
    }

    // Mode bits are mutable by the owner. A non-root foreign owner can make an
    // apparently read-only ancestor writable after validation and replace the
    // next pathname component, so ownership alone makes the ancestor unsafe.
    if (!isDirect && uid !== null && statsUid !== uid && statsUid !== 0) {
      throw new Error(`Refusing unsafe SQLite ancestor directory at ${component}: it is owned by foreign uid ${statsUid}`);
    }
  }
}

function ensureSharedOwnedDirectory(path: string): void {
  ensureSecureDirectoryChain(path, 0o755);
}

function ensurePrivateOwnedDirectory(path: string): void {
  if (process.platform === "win32") {
    mkdirSync(path, { recursive: true });
    return;
  }

  if (!lstatIfExists(path)) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  const pathStats = lstatSync(path);
  if (pathStats.isSymbolicLink()) {
    throw new Error(`Refusing app data directory at ${path}: symbolic links are not allowed`);
  }
  if (!pathStats.isDirectory()) {
    throw new Error(`Refusing app data directory at ${path}: expected a directory`);
  }
  assertOwned(pathStats, path, "app data directory");

  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const fdStats = fstatSync(fd);
    if (!fdStats.isDirectory()) {
      throw new Error(`Refusing app data directory at ${path}: expected a directory`);
    }
    assertOwned(fdStats, path, "app data directory");
    assertSameFile(pathStats, fdStats, path);
    fchmodSync(fd, 0o700);
  } finally {
    if (fd !== null) closeSync(fd);
  }

  const hardenedStats = lstatSync(path);
  if (hardenedStats.isSymbolicLink() || !hardenedStats.isDirectory()) {
    throw new Error(`Refusing app data directory at ${path}: it changed during validation`);
  }
  assertOwned(hardenedStats, path, "app data directory");
  assertSameFile(pathStats, hardenedStats, path);
  if ((hardenedStats.mode & 0o777) !== 0o700) {
    throw new Error(`Could not protect app data directory at ${path} with mode 0700`);
  }
}

function validateArtifactStats(stats: FileStats, path: string): void {
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing SQLite artifact at ${path}: symbolic links are not allowed`);
  }
  if (!stats.isFile()) {
    throw new Error(`Refusing SQLite artifact at ${path}: expected a regular file`);
  }
  assertOwned(stats, path, "SQLite artifact");
}

function ensurePrivateDatabaseArtifact(path: string, create: boolean): boolean {
  if (process.platform === "win32") return lstatIfExists(path) !== null;

  const initialStats = lstatIfExists(path);
  if (!initialStats && !create) return false;
  if (initialStats) validateArtifactStats(initialStats, path);

  let fd: number | null = null;
  let fdStats: FileStats;
  try {
    fd = openSync(
      path,
      constants.O_RDWR
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK
        | (create ? constants.O_CREAT : 0),
      0o600,
    );
    fdStats = fstatSync(fd);
    validateArtifactStats(fdStats, path);
    if (initialStats) assertSameFile(initialStats, fdStats, path);
    fchmodSync(fd, 0o600);
    fdStats = fstatSync(fd);
    validateArtifactStats(fdStats, path);
    if ((fdStats.mode & 0o777) !== 0o600) {
      throw new Error(`Could not protect SQLite artifact at ${path} with mode 0600`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new Error(`Refusing SQLite artifact at ${path}: symbolic links are not allowed`, { cause: error });
    }
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }

  const finalStats = lstatSync(path);
  validateArtifactStats(finalStats, path);
  assertSameFile(fdStats!, finalStats, path);
  if ((finalStats.mode & 0o777) !== 0o600) {
    throw new Error(`Could not protect SQLite artifact at ${path} with mode 0600`);
  }
  return true;
}

function migrateLegacyDirectory(oldDir: string, newDir: string): void {
  for (const file of readdirSync(oldDir)) {
    const oldPath = join(oldDir, file);
    const oldStats = lstatSync(oldPath);
    if (oldStats.isSymbolicLink()) {
      throw new Error(`Refusing legacy data at ${oldPath}: symbolic links are not allowed`);
    }
    if (!oldStats.isFile()) continue;

    ensurePrivateDatabaseArtifact(oldPath, false);
    const newPath = join(newDir, file);
    const destinationFd = openSync(
      newPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(destinationFd);
    copyFileSync(oldPath, newPath);
    ensurePrivateDatabaseArtifact(newPath, false);
  }
}

export function getDataDir(): string {
  const home = process.env["HOME"] || process.env["USERPROFILE"] || homedir();

  if (process.platform === "win32") {
    const hasnaDir = join(home, ".hasna");
    const newDir = join(hasnaDir, "emails");
    const oldDir = join(home, ".emails");
    // Keep Windows behavior non-breaking; POSIX ownership and mode bits do not
    // have the same security meaning there.
    if (existsSync(oldDir) && !existsSync(newDir)) {
      mkdirSync(newDir, { recursive: true });
      for (const file of readdirSync(oldDir)) {
        const oldPath = join(oldDir, file);
        if (statSync(oldPath).isFile()) {
          copyFileSync(oldPath, join(newDir, file));
        }
      }
    }
    mkdirSync(newDir, { recursive: true });
    return newDir;
  }

  // HOME may itself traverse a stable system alias. Canonicalize only HOME;
  // .hasna and emails stay appended and therefore cannot be symlinked.
  const canonicalHome = canonicalizeFromExistingAncestor(home);
  const hasnaDir = join(canonicalHome, ".hasna");
  const newDir = join(hasnaDir, "emails");
  const oldDir = join(canonicalHome, ".emails");

  ensureSharedOwnedDirectory(hasnaDir);
  const shouldInspectLegacy = lstatIfExists(newDir) === null;
  const oldStats = shouldInspectLegacy ? lstatIfExists(oldDir) : null;
  ensurePrivateOwnedDirectory(newDir);
  if (oldStats) {
    ensurePrivateOwnedDirectory(oldDir);
    migrateLegacyDirectory(oldDir, newDir);
  }

  return newDir;
}

function getDbPath(): string {
  // 1. Environment variable override (new)
  if (process.env["HASNA_EMAILS_DB_PATH"]) {
    const path = process.env["HASNA_EMAILS_DB_PATH"];
    return isInMemoryDb(path) || process.platform === "win32"
      ? path
      : canonicalizeDatabasePath(path);
  }
  // 2. Environment variable override (backward compat, used for tests)
  if (process.env["EMAILS_DB_PATH"]) {
    const path = process.env["EMAILS_DB_PATH"];
    return isInMemoryDb(path) || process.platform === "win32"
      ? path
      : canonicalizeDatabasePath(path);
  }
  // 3. Default: ~/.hasna/emails/emails.db
  return join(getDataDir(), "emails.db");
}

export function getDatabasePath(): string {
  return getDbPath();
}

export function databaseFileExists(): boolean {
  const path = getDbPath();
  return isInMemoryDb(path) || existsSync(path);
}

export function isDatabaseOpen(): boolean {
  return _db !== null;
}

function ensureDir(filePath: string): void {
  if (isInMemoryDb(filePath)) return;
  const dir = dirname(resolve(filePath));
  ensureSecureDirectoryChain(dir, 0o700);
}

const DATABASE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

function ensurePrivateDatabaseArtifacts(filePath: string, createDatabase: boolean): void {
  if (isInMemoryDb(filePath) || process.platform === "win32") return;
  ensurePrivateDatabaseArtifact(filePath, createDatabase);
  for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
    ensurePrivateDatabaseArtifact(`${filePath}${suffix}`, false);
  }
}

function normalizedRecipientSql(valueSql: string): string {
  const value = `CAST(${valueSql} AS TEXT)`;
  return `LOWER(TRIM(CASE
    WHEN instr(${value}, '<') > 0 AND instr(${value}, '>') > instr(${value}, '<')
      THEN substr(${value}, instr(${value}, '<') + 1, instr(${value}, '>') - instr(${value}, '<') - 1)
    ELSE ${value}
  END))`;
}

function inboundRecipientInsertSql(idSql: string, toAddressesSql: string): string {
  return `INSERT OR IGNORE INTO inbound_recipients (inbound_email_id, address, domain)
    SELECT ${idSql}, normalized.address, substr(normalized.address, instr(normalized.address, '@') + 1)
      FROM (
        SELECT ${normalizedRecipientSql("j.value")} AS address
          FROM json_each(CASE WHEN json_valid(${toAddressesSql}) THEN ${toAddressesSql} ELSE '[]' END) AS j
      ) normalized
     WHERE instr(normalized.address, '@') > 1
       AND instr(substr(normalized.address, instr(normalized.address, '@') + 1), '.') > 0
       AND normalized.address NOT LIKE '% %'
       AND normalized.address NOT LIKE '%<%'
       AND normalized.address NOT LIKE '%>%'`;
}

function inboundRecipientBackfillSql(): string {
  return `INSERT OR IGNORE INTO inbound_recipients (inbound_email_id, address, domain)
    SELECT normalized.inbound_email_id, normalized.address, substr(normalized.address, instr(normalized.address, '@') + 1)
      FROM (
        SELECT e.id AS inbound_email_id, ${normalizedRecipientSql("j.value")} AS address
          FROM inbound_emails e,
               json_each(CASE WHEN json_valid(e.to_addresses) THEN e.to_addresses ELSE '[]' END) AS j
      ) normalized
     WHERE instr(normalized.address, '@') > 1
       AND instr(substr(normalized.address, instr(normalized.address, '@') + 1), '.') > 0
       AND normalized.address NOT LIKE '% %'
       AND normalized.address NOT LIKE '%<%'
       AND normalized.address NOT LIKE '%>%'`;
}

const INBOUND_RECIPIENTS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS inbound_recipients (
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    domain TEXT NOT NULL,
    PRIMARY KEY (inbound_email_id, address)
  );
  CREATE INDEX IF NOT EXISTS idx_inbound_recipients_address ON inbound_recipients(address, inbound_email_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_recipients_domain ON inbound_recipients(domain, inbound_email_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_recipients_email ON inbound_recipients(inbound_email_id);
`;

const INBOUND_RECIPIENTS_BACKFILL_SQL = `
  ${inboundRecipientBackfillSql()};
`;

const INBOUND_RECIPIENTS_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS trg_inbound_recipients_insert
  AFTER INSERT ON inbound_emails
  BEGIN
    ${inboundRecipientInsertSql("NEW.id", "NEW.to_addresses")};
  END;

  CREATE TRIGGER IF NOT EXISTS trg_inbound_recipients_update_to
  AFTER UPDATE OF to_addresses ON inbound_emails
  BEGIN
    DELETE FROM inbound_recipients WHERE inbound_email_id = NEW.id;
    ${inboundRecipientInsertSql("NEW.id", "NEW.to_addresses")};
  END;

  CREATE TRIGGER IF NOT EXISTS trg_inbound_recipients_delete
  AFTER DELETE ON inbound_emails
  BEGIN
    DELETE FROM inbound_recipients WHERE inbound_email_id = OLD.id;
  END;
`;

function normalizedLabelSql(valueSql: string): string {
  let value = `LOWER(TRIM(CAST(${valueSql} AS TEXT)))`;
  for (const whitespace of ["char(9)", "char(10)", "char(11)", "char(12)", "char(13)"]) {
    value = `REPLACE(${value}, ${whitespace}, ' ')`;
  }
  for (let i = 0; i < 8; i += 1) {
    value = `REPLACE(${value}, '  ', ' ')`;
  }
  return `SUBSTR(REPLACE(${value}, ' ', '-'), 1, 64)`;
}

function inboundLabelInsertSql(idSql: string, labelIdsSql: string): string {
  return `INSERT OR IGNORE INTO inbound_labels (inbound_email_id, label)
    SELECT ${idSql}, normalized.label
      FROM (
        SELECT ${normalizedLabelSql("j.value")} AS label
          FROM json_each(CASE WHEN json_valid(${labelIdsSql}) THEN ${labelIdsSql} ELSE '[]' END) AS j
      ) normalized
     WHERE normalized.label != ''`;
}

function inboundLabelFlagUpdateSql(idSql: string): string {
  return `UPDATE inbound_emails
     SET is_spam = CASE WHEN EXISTS (
           SELECT 1 FROM inbound_labels
            WHERE inbound_email_id = ${idSql}
              AND label = 'spam'
         ) THEN 1 ELSE 0 END,
         is_trash = CASE WHEN EXISTS (
           SELECT 1 FROM inbound_labels
            WHERE inbound_email_id = ${idSql}
              AND label = 'trash'
         ) THEN 1 ELSE 0 END
   WHERE id = ${idSql}`;
}

function inboundLabelsBackfillSql(): string {
  return `INSERT OR IGNORE INTO inbound_labels (inbound_email_id, label)
    SELECT normalized.inbound_email_id, normalized.label
      FROM (
        SELECT e.id AS inbound_email_id, ${normalizedLabelSql("j.value")} AS label
          FROM inbound_emails e,
               json_each(CASE WHEN json_valid(e.label_ids_json) THEN e.label_ids_json ELSE '[]' END) AS j
      ) normalized
     WHERE normalized.label != ''`;
}

const INBOUND_LABELS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS inbound_labels (
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    PRIMARY KEY (inbound_email_id, label)
  );
  CREATE INDEX IF NOT EXISTS idx_inbound_labels_label ON inbound_labels(label, inbound_email_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_labels_email ON inbound_labels(inbound_email_id);
`;

const INBOUND_LABELS_BACKFILL_SQL = `
  ${inboundLabelsBackfillSql()};
`;

const INBOUND_LABELS_FLAG_BACKFILL_SQL = `
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
         ) THEN 1 ELSE 0 END;
`;

const INBOUND_LABELS_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS trg_inbound_labels_insert
  AFTER INSERT ON inbound_emails
  BEGIN
    ${inboundLabelInsertSql("NEW.id", "NEW.label_ids_json")};
    ${inboundLabelFlagUpdateSql("NEW.id")};
  END;

  CREATE TRIGGER IF NOT EXISTS trg_inbound_labels_update_labels
  AFTER UPDATE OF label_ids_json ON inbound_emails
  BEGIN
    DELETE FROM inbound_labels WHERE inbound_email_id = NEW.id;
    ${inboundLabelInsertSql("NEW.id", "NEW.label_ids_json")};
    ${inboundLabelFlagUpdateSql("NEW.id")};
  END;

  CREATE TRIGGER IF NOT EXISTS trg_inbound_labels_delete
  AFTER DELETE ON inbound_emails
  BEGIN
    DELETE FROM inbound_labels WHERE inbound_email_id = OLD.id;
  END;
`;

function mailSourceTypeSql(providerTypeSql: string, rawS3Sql: string, metadataS3Sql: string, messageIdSql: string): string {
  return `CASE
    WHEN ${providerTypeSql} = 'ses' AND (${rawS3Sql} IS NOT NULL OR ${metadataS3Sql} IS NOT NULL OR COALESCE(${messageIdSql}, '') LIKE 'inbound/%') THEN 'ses_s3'
    WHEN ${providerTypeSql} = 'ses' THEN 'ses'
    WHEN ${providerTypeSql} = 'resend' THEN 'resend'
    WHEN ${providerTypeSql} = 'sandbox' THEN 'sandbox'
    ELSE 'legacy_inbound'
  END`;
}

// Inbound mail whose `to` header has no parseable recipient is attributed to a
// synthetic mailbox. `local.mailery` was that identity under the previous product
// name; it is RETIRED. Migration 46 renamed it, but `ensureMailArchitecture` drops
// and re-creates the inbound trigger on every `getDatabase()` call, so the
// pre-rename literal embedded in that trigger re-minted the retired mailbox on the
// very next open — splitting recipient-less mail across two mailboxes forever and
// keeping a retired product identity permanently live. Single definition site so
// the trigger, the backfill and the rename bridge cannot drift apart again.
const LEGACY_INBOUND_ADDRESS = "legacy-inbound@local.emails";
const LEGACY_INBOUND_MAILBOX_ID = `mbx:${LEGACY_INBOUND_ADDRESS}`;
const RETIRED_LEGACY_INBOUND_ADDRESS = "legacy-inbound@local.mailery";
const RETIRED_LEGACY_INBOUND_MAILBOX_ID = `mbx:${RETIRED_LEGACY_INBOUND_ADDRESS}`;

function mailboxRecipientRowsSql(idSql: string, toAddressesSql: string): string {
  const addressSql = normalizedRecipientSql("j.value");
  return `SELECT ${idSql} AS inbound_email_id,
                 normalized.address AS address,
                 'mbx:' || normalized.address AS mailbox_id
            FROM (
              SELECT ${addressSql} AS address
                FROM json_each(CASE WHEN json_valid(${toAddressesSql}) THEN ${toAddressesSql} ELSE '[]' END) AS j
            ) normalized
           WHERE instr(normalized.address, '@') > 1
             AND instr(substr(normalized.address, instr(normalized.address, '@') + 1), '.') > 0
             AND normalized.address NOT LIKE '% %'
             AND normalized.address NOT LIKE '%<%'
             AND normalized.address NOT LIKE '%>%'
          UNION ALL
          SELECT ${idSql} AS inbound_email_id,
                 '${LEGACY_INBOUND_ADDRESS}' AS address,
                 '${LEGACY_INBOUND_MAILBOX_ID}' AS mailbox_id
           WHERE NOT EXISTS (
             SELECT 1
               FROM (
                 SELECT ${addressSql} AS address
                   FROM json_each(CASE WHEN json_valid(${toAddressesSql}) THEN ${toAddressesSql} ELSE '[]' END) AS j
               ) valid
              WHERE instr(valid.address, '@') > 1
                AND instr(substr(valid.address, instr(valid.address, '@') + 1), '.') > 0
                AND valid.address NOT LIKE '% %'
                AND valid.address NOT LIKE '%<%'
                AND valid.address NOT LIKE '%>%'
           )`;
}

// `mailboxes` and `mailbox_sources` are the two canonical tables that are still
// live: `trg_providers_preserve_mail_history` reads `mailbox_sources` to refuse
// deleting a provider that has source history, and `mailbox_sources.mailbox_id`
// is a foreign key into `mailboxes`, so with `PRAGMA foreign_keys = ON` a missing
// `mailboxes` row makes the source insert — and therefore the inbound INSERT that
// fires it — fail. `mail_messages` survives because the inbound-delete trigger
// below reads it; nothing populates it any more.
const MAIL_ARCHITECTURE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS mailboxes (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    display_name TEXT,
    owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(address)
  );

  CREATE TABLE IF NOT EXISTS mailbox_sources (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    type TEXT NOT NULL CHECK(type IN ('ses','ses_s3','resend','sandbox','legacy_inbound','manual')),
    name TEXT NOT NULL,
    external_account_id TEXT,
    external_mailbox TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','legacy')),
    settings_json TEXT NOT NULL DEFAULT '{}',
    provider_snapshot_json TEXT NOT NULL DEFAULT '{}',
    last_synced_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(mailbox_id, provider_id, type, external_mailbox)
  );

  CREATE TABLE IF NOT EXISTS mail_messages (
    id TEXT PRIMARY KEY,
    rfc_message_id TEXT,
    subject TEXT NOT NULL DEFAULT '',
    from_address TEXT,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    bcc_addresses TEXT NOT NULL DEFAULT '[]',
    text_body TEXT,
    html_body TEXT,
    headers_json TEXT NOT NULL DEFAULT '{}',
    attachments_json TEXT NOT NULL DEFAULT '[]',
    raw_s3_url TEXT,
    metadata_s3_url TEXT,
    raw_size INTEGER NOT NULL DEFAULT 0,
    sent_at TEXT,
    received_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_mailboxes_address ON mailboxes(address);
  CREATE INDEX IF NOT EXISTS idx_mailboxes_owner ON mailboxes(owner_id);
  CREATE INDEX IF NOT EXISTS idx_mailbox_sources_mailbox ON mailbox_sources(mailbox_id, status);
  CREATE INDEX IF NOT EXISTS idx_mailbox_sources_provider ON mailbox_sources(provider_id);
  CREATE INDEX IF NOT EXISTS idx_mail_messages_rfc_message_id ON mail_messages(rfc_message_id) WHERE rfc_message_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_mail_messages_received ON mail_messages(received_at);
`;

// `inbound_emails.mail_message_id` stays because the inbound-delete trigger reads
// it to locate the canonical row a historical database may still hold. Nothing
// writes it any more, so the COALESCE fallback in that trigger carries new rows.
const MAIL_ARCHITECTURE_COLUMNS_SQL = `
  ALTER TABLE inbound_emails ADD COLUMN mail_message_id TEXT REFERENCES mail_messages(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_inbound_mail_message ON inbound_emails(mail_message_id);
`;

const MAIL_ARCHITECTURE_COLUMN_STATEMENTS = [
  "ALTER TABLE inbound_emails ADD COLUMN mail_message_id TEXT REFERENCES mail_messages(id) ON DELETE SET NULL",
  "CREATE INDEX IF NOT EXISTS idx_inbound_mail_message ON inbound_emails(mail_message_id)",
] as const;

function ensureMailArchitectureColumns(db: Database): void {
  for (const statement of MAIL_ARCHITECTURE_COLUMN_STATEMENTS) {
    safeExec(db, statement);
  }
}

const MAIL_ARCHITECTURE_BACKFILL_SQL = `
  INSERT OR IGNORE INTO mailboxes (id, address, display_name, status, created_at, updated_at)
  SELECT 'mbx:' || recipient.address,
         recipient.address,
         recipient.address,
         'active',
         MIN(inbound.created_at),
         datetime('now')
    FROM inbound_recipients recipient
    JOIN inbound_emails inbound ON inbound.id = recipient.inbound_email_id
   GROUP BY recipient.address;

  INSERT OR IGNORE INTO mailboxes (id, address, display_name, status, created_at, updated_at)
  SELECT '${LEGACY_INBOUND_MAILBOX_ID}',
         '${LEGACY_INBOUND_ADDRESS}',
         'Legacy inbound',
         'active',
         COALESCE(MIN(inbound.created_at), datetime('now')),
         datetime('now')
    FROM inbound_emails inbound
   WHERE NOT EXISTS (
     SELECT 1 FROM inbound_recipients recipient WHERE recipient.inbound_email_id = inbound.id
   )
  HAVING COUNT(*) > 0;

  WITH recipient_rows AS (
    SELECT inbound.id AS inbound_email_id,
           recipient.address AS address,
           'mbx:' || recipient.address AS mailbox_id
      FROM inbound_emails inbound
      JOIN inbound_recipients recipient ON recipient.inbound_email_id = inbound.id
    UNION ALL
    SELECT inbound.id,
           '${LEGACY_INBOUND_ADDRESS}',
           '${LEGACY_INBOUND_MAILBOX_ID}'
      FROM inbound_emails inbound
     WHERE NOT EXISTS (
       SELECT 1 FROM inbound_recipients recipient WHERE recipient.inbound_email_id = inbound.id
     )
  ),
  source_rows AS (
    SELECT DISTINCT
           recipient_rows.mailbox_id,
           CASE WHEN provider.id IS NULL THEN NULL ELSE inbound.provider_id END AS provider_id,
           ${mailSourceTypeSql("provider.type", "inbound.raw_s3_url", "inbound.metadata_s3_url", "inbound.message_id")} AS source_type,
           provider.name AS provider_name,
           provider.type AS provider_type,
           provider.region AS provider_region,
           provider.active AS provider_active,
           provider.created_at AS provider_created_at,
           provider.updated_at AS provider_updated_at
      FROM recipient_rows
      JOIN inbound_emails inbound ON inbound.id = recipient_rows.inbound_email_id
      LEFT JOIN providers provider ON provider.id = inbound.provider_id
  )
  INSERT OR IGNORE INTO mailbox_sources (
    id, mailbox_id, provider_id, type, name, external_mailbox, status,
    settings_json, provider_snapshot_json, created_at, updated_at
  )
  SELECT 'msrc:' || mailbox_id || ':' || COALESCE(provider_id, 'none') || ':' || source_type,
         mailbox_id,
         provider_id,
         source_type,
         COALESCE(provider_name || ' ' || source_type, 'Legacy inbound'),
         substr(mailbox_id, 5),
         CASE WHEN source_type = 'legacy_inbound' THEN 'legacy' ELSE 'active' END,
         '{}',
         CASE WHEN provider_id IS NULL THEN '{}' ELSE json_object(
           'id', provider_id,
           'name', provider_name,
           'type', provider_type,
           'region', provider_region,
           'active', provider_active,
           'created_at', provider_created_at,
           'updated_at', provider_updated_at
         ) END,
         datetime('now'),
         datetime('now')
    FROM source_rows;

`;

// Canonical maintenance narrowed to the two tables that still have a reader:
// `mailboxes` (the foreign-key parent) and `mailbox_sources` (read by
// `trg_providers_preserve_mail_history`). The canonical message body, folder and
// per-mailbox state writes this trigger used to perform had no reader at all.
const MAIL_ARCHITECTURE_INBOUND_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER trg_mail_architecture_inbound_insert
  AFTER INSERT ON inbound_emails
  BEGIN
    INSERT OR IGNORE INTO mailboxes (id, address, display_name, status, created_at, updated_at)
    SELECT mailbox_id, address, address, 'active', NEW.created_at, datetime('now')
      FROM (${mailboxRecipientRowsSql("NEW.id", "NEW.to_addresses")});

    INSERT OR IGNORE INTO mailbox_sources (
      id, mailbox_id, provider_id, type, name, external_mailbox, status,
      settings_json, provider_snapshot_json, created_at, updated_at
    )
    SELECT 'msrc:' || recipients.mailbox_id || ':' || COALESCE(provider.id, 'none') || ':' ||
             ${mailSourceTypeSql("provider.type", "NEW.raw_s3_url", "NEW.metadata_s3_url", "NEW.message_id")},
           recipients.mailbox_id,
           CASE WHEN provider.id IS NULL THEN NULL ELSE NEW.provider_id END,
           ${mailSourceTypeSql("provider.type", "NEW.raw_s3_url", "NEW.metadata_s3_url", "NEW.message_id")},
           COALESCE(provider.name || ' ' || ${mailSourceTypeSql("provider.type", "NEW.raw_s3_url", "NEW.metadata_s3_url", "NEW.message_id")}, 'Legacy inbound'),
           recipients.address,
           CASE WHEN provider.id IS NULL THEN 'legacy' ELSE 'active' END,
           '{}',
           CASE WHEN provider.id IS NULL THEN '{}' ELSE json_object(
             'id', provider.id,
             'name', provider.name,
             'type', provider.type,
             'region', provider.region,
             'active', provider.active,
             'created_at', provider.created_at,
             'updated_at', provider.updated_at
           ) END,
           datetime('now'),
           datetime('now')
      FROM (${mailboxRecipientRowsSql("NEW.id", "NEW.to_addresses")}) recipients
      LEFT JOIN providers provider ON provider.id = NEW.provider_id;
  END;
`;

const MAIL_ARCHITECTURE_INBOUND_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER trg_mail_architecture_inbound_delete
  AFTER DELETE ON inbound_emails
  BEGIN
    DELETE FROM mail_messages
     WHERE id = COALESCE(OLD.mail_message_id, 'msg:inbound:' || OLD.id)
       AND NOT EXISTS (
             SELECT 1
               FROM inbound_emails inbound
              WHERE COALESCE(inbound.mail_message_id, 'msg:inbound:' || inbound.id) = COALESCE(OLD.mail_message_id, 'msg:inbound:' || OLD.id)
              LIMIT 1
           );
  END;
`;

const RETIRED_LEGACY_INBOUND_BRIDGE_SQL = `
  INSERT OR IGNORE INTO mailboxes (id, address, display_name, owner_id, status, created_at, updated_at)
  SELECT '${LEGACY_INBOUND_MAILBOX_ID}', '${LEGACY_INBOUND_ADDRESS}',
         COALESCE(display_name, 'Legacy inbound'), owner_id, status, created_at, datetime('now')
    FROM mailboxes
   WHERE id = '${RETIRED_LEGACY_INBOUND_MAILBOX_ID}';

  -- Drop only sources whose re-keyed identity already exists: the same
  -- provenance recorded twice, once under each name. Everything else is
  -- re-pointed, never deleted.
  DELETE FROM mailbox_sources
   WHERE mailbox_id = '${RETIRED_LEGACY_INBOUND_MAILBOX_ID}'
     AND EXISTS (
       SELECT 1
         FROM mailbox_sources other
        WHERE other.id = replace(mailbox_sources.id,
                                 '${RETIRED_LEGACY_INBOUND_ADDRESS}',
                                 '${LEGACY_INBOUND_ADDRESS}')
     );

  -- The retired address is embedded in the source id and in external_mailbox,
  -- not just in mailbox_id, so all three have to move together.
  UPDATE mailbox_sources
     SET id = replace(id, '${RETIRED_LEGACY_INBOUND_ADDRESS}', '${LEGACY_INBOUND_ADDRESS}'),
         mailbox_id = '${LEGACY_INBOUND_MAILBOX_ID}',
         external_mailbox = '${LEGACY_INBOUND_ADDRESS}',
         updated_at = datetime('now')
   WHERE mailbox_id = '${RETIRED_LEGACY_INBOUND_MAILBOX_ID}';

  -- mailbox_sources.mailbox_id cascades on delete, so the retired mailbox is
  -- only removed once nothing is still attributed to it. Leaving the row behind
  -- is recoverable; cascading away source history is not.
  DELETE FROM mailboxes
   WHERE id = '${RETIRED_LEGACY_INBOUND_MAILBOX_ID}'
     AND NOT EXISTS (
       SELECT 1 FROM mailbox_sources
        WHERE mailbox_id = '${RETIRED_LEGACY_INBOUND_MAILBOX_ID}'
     );
`;

const S3_MESSAGE_ID_RAW_URL_BACKFILL_SQL = `
  UPDATE inbound_emails
     SET raw_s3_url = message_id
   WHERE (raw_s3_url IS NULL OR raw_s3_url = '')
     AND message_id LIKE 's3://%';
`;

const PROVIDER_DELETE_GUARD_SQL = `
  CREATE TRIGGER trg_providers_preserve_mail_history
  BEFORE DELETE ON providers
  WHEN EXISTS (SELECT 1 FROM mailbox_sources WHERE provider_id = OLD.id LIMIT 1)
    OR EXISTS (SELECT 1 FROM inbound_emails WHERE provider_id = OLD.id LIMIT 1)
    OR EXISTS (SELECT 1 FROM emails WHERE provider_id = OLD.id LIMIT 1)
    OR EXISTS (SELECT 1 FROM events WHERE provider_id = OLD.id LIMIT 1)
    OR EXISTS (SELECT 1 FROM sandbox_emails WHERE provider_id = OLD.id LIMIT 1)
  BEGIN
    SELECT RAISE(ABORT, 'Cannot delete provider with mail/source history; deactivate it instead');
  END;
`;

function safeExec(db: Database, sql: string): void {
  try { db.exec(sql); } catch {}
}

function tableExists(db: Database, tableName: string): boolean {
  try {
    const row = db
      .query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) as { ok: number } | null;
    return !!row;
  } catch {
    return false;
  }
}

function migrationRecorded(db: Database, id: number): boolean {
  try {
    const row = db.query("SELECT 1 AS ok FROM _migrations WHERE id = ? LIMIT 1").get(id) as { ok: number } | null;
    return !!row;
  } catch {
    return false;
  }
}

function ensureInboundRecipients(db: Database): void {
  const tableExisted = tableExists(db, "inbound_recipients");
  safeExec(db, INBOUND_RECIPIENTS_SCHEMA_SQL);
  if (!migrationRecorded(db, 31) || !tableExisted) {
    safeExec(db, INBOUND_RECIPIENTS_BACKFILL_SQL);
  }
  safeExec(db, INBOUND_RECIPIENTS_TRIGGERS_SQL);
  if (tableExists(db, "inbound_recipients")) {
    safeExec(db, "INSERT OR IGNORE INTO _migrations (id) VALUES (31)");
  }
}

function ensureInboundLabels(db: Database): void {
  const tableExisted = tableExists(db, "inbound_labels");
  safeExec(db, "ALTER TABLE inbound_emails ADD COLUMN is_spam INTEGER NOT NULL DEFAULT 0");
  safeExec(db, "ALTER TABLE inbound_emails ADD COLUMN is_trash INTEGER NOT NULL DEFAULT 0");
  safeExec(db, INBOUND_LABELS_SCHEMA_SQL);
  if (!migrationRecorded(db, 36) || !tableExisted) {
    safeExec(db, INBOUND_LABELS_BACKFILL_SQL);
    safeExec(db, INBOUND_LABELS_FLAG_BACKFILL_SQL);
  }
  safeExec(db, INBOUND_LABELS_TRIGGERS_SQL);
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_sent_arch_spam_trash_recv ON inbound_emails(is_sent, is_archived, is_spam, is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_sent_read_arch_spam_trash_recv ON inbound_emails(is_sent, is_read, is_archived, is_spam, is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_sent_star_arch_spam_trash_recv ON inbound_emails(is_sent, is_starred, is_archived, is_spam, is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_arch_spam_trash_recv ON inbound_emails(is_archived, is_spam, is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_spam_recv ON inbound_emails(is_spam, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_trash_recv ON inbound_emails(is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_sent_spam_recv ON inbound_emails(is_sent, is_spam, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_sent_trash_recv ON inbound_emails(is_sent, is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_arch_spam_trash_recv ON inbound_emails(provider_id, is_sent, is_archived, is_spam, is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_read_arch_spam_trash_recv ON inbound_emails(provider_id, is_sent, is_read, is_archived, is_spam, is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_star_arch_spam_trash_recv ON inbound_emails(provider_id, is_sent, is_starred, is_archived, is_spam, is_trash, received_at)");
  if (tableExists(db, "inbound_labels")) {
    safeExec(db, "INSERT OR IGNORE INTO _migrations (id) VALUES (36)");
  }
}

export function ensureMailArchitecture(db: Database): void {
  // The migration-40 sentinel is keyed on `mailbox_sources`, the canonical table
  // that survives. Keying it on a dropped table would leave the backfill
  // permanently un-recorded and re-run it on every single open.
  const tableExisted = tableExists(db, "mailbox_sources");
  safeExec(db, MAIL_ARCHITECTURE_SCHEMA_SQL);
  ensureMailArchitectureColumns(db);
  if (!migrationRecorded(db, 40) || !tableExisted) {
    db.exec(MAIL_ARCHITECTURE_BACKFILL_SQL);
  }
  safeExec(db, "DROP TRIGGER IF EXISTS trg_mail_architecture_inbound_insert");
  safeExec(db, MAIL_ARCHITECTURE_INBOUND_INSERT_TRIGGER_SQL);
  safeExec(db, "DROP TRIGGER IF EXISTS trg_mail_architecture_inbound_delete");
  // Firing a trigger whose body names a missing table raises at DELETE time, not
  // at CREATE time, so installing this unconditionally would break inbound
  // deletes on a database that never had the canonical message table.
  if (tableExists(db, "mail_messages")) {
    safeExec(db, MAIL_ARCHITECTURE_INBOUND_DELETE_TRIGGER_SQL);
  }
  safeExec(db, "DROP TRIGGER IF EXISTS trg_providers_preserve_mail_history");
  safeExec(db, PROVIDER_DELETE_GUARD_SQL);
  if (tableExists(db, "mailbox_sources")) {
    safeExec(db, "INSERT OR IGNORE INTO _migrations (id) VALUES (40)");
  }
}

/**
 * Re-derive the canonical `mailboxes` / `mailbox_sources` rows that
 * `trg_providers_preserve_mail_history` reads, after an ingestion pass rewrote
 * inbound provenance.
 */
export function rebuildInboundCanonicalState(db?: Database): void {
  const d = db || getDatabase();
  ensureMailArchitecture(d);
  d.exec(MAIL_ARCHITECTURE_BACKFILL_SQL);
}

export interface LegacyS3RawUrlSource {
  bucket: string;
  providerId?: string | null;
}

function runS3MessageIdRawUrlBackfill(db: Database): void {
  for (const statement of S3_MESSAGE_ID_RAW_URL_BACKFILL_SQL.split(";")) {
    const sql = statement.trim();
    if (!sql) continue;
    db.query(sql).run();
  }
}

export function backfillLegacyS3RawUrls(sources: LegacyS3RawUrlSource[], db?: Database): number {
  const d = db || getDatabase();
  runS3MessageIdRawUrlBackfill(d);

  let updated = 0;
  const seen = new Set<string>();
  for (const source of sources) {
    const bucket = source.bucket.trim();
    const providerId = source.providerId?.trim();
    if (!bucket || !providerId) continue;
    const key = `${bucket}\0${providerId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const before = d
      .query(
        `SELECT COUNT(*) AS count
           FROM inbound_emails
          WHERE provider_id = ?
            AND (raw_s3_url IS NULL OR raw_s3_url = '')
            AND message_id IS NOT NULL
            AND message_id != ''
            AND message_id NOT LIKE 's3://%'`,
      )
      .get(providerId) as { count: number } | null;

    d.query(
      `UPDATE inbound_emails
          SET raw_s3_url = 's3://' || ? || '/' || message_id
        WHERE provider_id = ?
          AND (raw_s3_url IS NULL OR raw_s3_url = '')
          AND message_id IS NOT NULL
          AND message_id != ''
          AND message_id NOT LIKE 's3://%'`,
    ).run(bucket, providerId);
    updated += before?.count ?? 0;
  }

  runS3MessageIdRawUrlBackfill(d);
  return updated;
}

const MIGRATIONS = [
  // Migration 1: Initial schema
  `
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('resend', 'ses')),
    api_key TEXT,
    region TEXT,
    access_key TEXT,
    secret_key TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Note: type CHECK constraint only covers resend/ses for migration 1; sandbox support is added later.

  CREATE TABLE IF NOT EXISTS domains (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    dkim_status TEXT NOT NULL DEFAULT 'pending' CHECK(dkim_status IN ('pending','verified','failed')),
    spf_status TEXT NOT NULL DEFAULT 'pending' CHECK(spf_status IN ('pending','verified','failed')),
    dmarc_status TEXT NOT NULL DEFAULT 'pending' CHECK(dmarc_status IN ('pending','verified','failed')),
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider_id, domain)
  );

  CREATE TABLE IF NOT EXISTS addresses (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    display_name TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider_id, email)
  );

  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    provider_message_id TEXT,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    bcc_addresses TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('sent','delivered','bounced','complained','failed')),
    has_attachments INTEGER NOT NULL DEFAULT 0,
    attachment_count INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '{}',
    sent_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    email_id TEXT REFERENCES emails(id) ON DELETE SET NULL,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    provider_event_id TEXT,
    type TEXT NOT NULL CHECK(type IN ('delivered','bounced','complained','opened','clicked','unsubscribed')),
    recipient TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_domains_provider ON domains(provider_id);
  CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain);
  CREATE INDEX IF NOT EXISTS idx_domains_domain_nocase ON domains(domain COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_domains_provider_domain_nocase ON domains(provider_id, domain COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_addresses_provider ON addresses(provider_id);
  CREATE INDEX IF NOT EXISTS idx_addresses_email ON addresses(email);
  CREATE INDEX IF NOT EXISTS idx_addresses_email_nocase ON addresses(email COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_emails_provider ON emails(provider_id);
  CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
  CREATE INDEX IF NOT EXISTS idx_emails_sent_at ON emails(sent_at);
  CREATE INDEX IF NOT EXISTS idx_emails_from ON emails(from_address);
  CREATE INDEX IF NOT EXISTS idx_events_email ON events(email_id);
  CREATE INDEX IF NOT EXISTS idx_events_provider ON events(provider_id);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_events_provider_event ON events(provider_id, provider_event_id) WHERE provider_event_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO _migrations (id) VALUES (1);
  `,

  // Migration 2: Add historical OAuth columns retained for old local databases.
  `
  ALTER TABLE providers ADD COLUMN oauth_client_id TEXT;
  ALTER TABLE providers ADD COLUMN oauth_client_secret TEXT;
  ALTER TABLE providers ADD COLUMN oauth_refresh_token TEXT;
  ALTER TABLE providers ADD COLUMN oauth_access_token TEXT;
  ALTER TABLE providers ADD COLUMN oauth_token_expiry TEXT;
  INSERT OR IGNORE INTO _migrations (id) VALUES (2);
  `,

  // Migration 3: Templates table
  `
  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    subject_template TEXT NOT NULL,
    html_template TEXT,
    text_template TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_templates_name ON templates(name);
  INSERT OR IGNORE INTO _migrations (id) VALUES (3);
  `,

  // Migration 4: Contacts table
  `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    send_count INTEGER NOT NULL DEFAULT 0,
    bounce_count INTEGER NOT NULL DEFAULT 0,
    complaint_count INTEGER NOT NULL DEFAULT 0,
    last_sent_at TEXT,
    suppressed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
  CREATE INDEX IF NOT EXISTS idx_contacts_suppressed ON contacts(suppressed);
  INSERT OR IGNORE INTO _migrations (id) VALUES (4);
  `,

  // Migration 5: Scheduled emails table
  `
  CREATE TABLE IF NOT EXISTS scheduled_emails (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    bcc_addresses TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT,
    subject TEXT NOT NULL,
    html TEXT,
    text_body TEXT,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    template_name TEXT,
    template_vars TEXT,
    scheduled_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','cancelled','failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_emails(status);
  CREATE INDEX IF NOT EXISTS idx_scheduled_at ON scheduled_emails(scheduled_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (5);
  `,

  // Migration 6: Groups and group_members tables
  `
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_groups_name ON groups(name);

  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT,
    vars TEXT NOT NULL DEFAULT '{}',
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, email)
  );
  CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (6);
  `,

  // Migration 7: Email content table
  `
  CREATE TABLE IF NOT EXISTS email_content (
    email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
    html TEXT,
    text_body TEXT,
    headers_json TEXT NOT NULL DEFAULT '{}'
  );
  INSERT OR IGNORE INTO _migrations (id) VALUES (7);
  `,

  // Migration 8: Recreate providers table to expand type CHECK constraint to include sandbox
  `
  CREATE TABLE IF NOT EXISTS providers_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('resend', 'ses', 'sandbox')),
    api_key TEXT,
    region TEXT,
    access_key TEXT,
    secret_key TEXT,
    oauth_client_id TEXT,
    oauth_client_secret TEXT,
    oauth_refresh_token TEXT,
    oauth_access_token TEXT,
    oauth_token_expiry TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO providers_new SELECT id, name, type, api_key, region, access_key, secret_key,
    oauth_client_id, oauth_client_secret, oauth_refresh_token, oauth_access_token, oauth_token_expiry,
    active, created_at, updated_at FROM providers WHERE type IN ('resend', 'ses', 'sandbox');
  DROP TABLE providers;
  ALTER TABLE providers_new RENAME TO providers;
  INSERT OR IGNORE INTO _migrations (id) VALUES (8);
  `,

  // Migration 9: Sandbox emails table
  `
  CREATE TABLE IF NOT EXISTS sandbox_emails (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    bcc_addresses TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT,
    subject TEXT NOT NULL,
    html TEXT,
    text_body TEXT,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    headers_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sandbox_provider ON sandbox_emails(provider_id);
  CREATE INDEX IF NOT EXISTS idx_sandbox_created ON sandbox_emails(created_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (9);
  `,

  // Migration 10: Add idempotency_key to emails table for dedup on retry
  `
  ALTER TABLE emails ADD COLUMN idempotency_key TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_idempotency ON emails(idempotency_key) WHERE idempotency_key IS NOT NULL;
  INSERT OR IGNORE INTO _migrations (id) VALUES (10);
  `,

  // Migration 11: Inbound emails table
  `
  CREATE TABLE IF NOT EXISTS inbound_emails (
    id TEXT PRIMARY KEY,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    message_id TEXT,
    provider_thread_id TEXT,
    provider_history_id TEXT,
    provider_internal_date TEXT,
    label_ids_json TEXT NOT NULL DEFAULT '[]',
    raw_s3_url TEXT,
    metadata_s3_url TEXT,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL DEFAULT '',
    text_body TEXT,
    html_body TEXT,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    headers_json TEXT NOT NULL DEFAULT '{}',
    raw_size INTEGER DEFAULT 0,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_inbound_from ON inbound_emails(from_address);
  CREATE INDEX IF NOT EXISTS idx_inbound_received ON inbound_emails(received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_provider ON inbound_emails(provider_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (11);
  `,

  // Migration 12: Sequences, sequence_steps, sequence_enrollments tables
  `
  CREATE TABLE IF NOT EXISTS sequences (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'archived')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sequences_name ON sequences(name);

  CREATE TABLE IF NOT EXISTS sequence_steps (
    id TEXT PRIMARY KEY,
    sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    step_number INTEGER NOT NULL,
    delay_hours INTEGER NOT NULL DEFAULT 24,
    template_name TEXT NOT NULL,
    from_address TEXT,
    subject_override TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(sequence_id, step_number)
  );
  CREATE INDEX IF NOT EXISTS idx_steps_sequence ON sequence_steps(sequence_id);

  CREATE TABLE IF NOT EXISTS sequence_enrollments (
    id TEXT PRIMARY KEY,
    sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    contact_email TEXT NOT NULL,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    current_step INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'cancelled')),
    enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
    next_send_at TEXT,
    completed_at TEXT,
    UNIQUE(sequence_id, contact_email)
  );
  CREATE INDEX IF NOT EXISTS idx_enrollments_sequence ON sequence_enrollments(sequence_id);
  CREATE INDEX IF NOT EXISTS idx_enrollments_email ON sequence_enrollments(contact_email);
  CREATE INDEX IF NOT EXISTS idx_enrollments_next_send ON sequence_enrollments(next_send_at);
  CREATE INDEX IF NOT EXISTS idx_enrollments_status ON sequence_enrollments(status);
  INSERT OR IGNORE INTO _migrations (id) VALUES (12);
  `,

  // Migration 13: Warming schedules table
  `
  CREATE TABLE IF NOT EXISTS warming_schedules (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    target_daily_volume INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_warming_domain ON warming_schedules(domain);
  CREATE INDEX IF NOT EXISTS idx_warming_status ON warming_schedules(status);
  INSERT OR IGNORE INTO _migrations (id) VALUES (13);
  `,

  // Migration 14: Reply tracking — link inbound emails back to sent emails
  `
  ALTER TABLE inbound_emails ADD COLUMN in_reply_to_email_id TEXT REFERENCES emails(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_inbound_reply_to ON inbound_emails(in_reply_to_email_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (14);
  `,

  // Migration 15: Dedup index on inbound_emails(provider_id, message_id)
  `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_provider_message ON inbound_emails(provider_id, message_id)
    WHERE provider_id IS NOT NULL AND message_id IS NOT NULL;
  INSERT OR IGNORE INTO _migrations (id) VALUES (15);
  `,

  // Migration 16: stored triage table — stores classification, priority, summary, sentiment, draft replies
  `
  CREATE TABLE IF NOT EXISTS email_triage (
    id TEXT PRIMARY KEY,
    email_id TEXT REFERENCES emails(id) ON DELETE CASCADE,
    inbound_email_id TEXT REFERENCES inbound_emails(id) ON DELETE CASCADE,
    label TEXT NOT NULL CHECK(label IN ('action-required','fyi','urgent','follow-up','spam','newsletter','transactional')),
    priority INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 5),
    summary TEXT,
    sentiment TEXT CHECK(sentiment IN ('positive','negative','neutral')),
    draft_reply TEXT,
    confidence REAL DEFAULT 0.0,
    model TEXT,
    triaged_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_triage_email ON email_triage(email_id);
  CREATE INDEX IF NOT EXISTS idx_triage_inbound ON email_triage(inbound_email_id);
  CREATE INDEX IF NOT EXISTS idx_triage_label ON email_triage(label);
  CREATE INDEX IF NOT EXISTS idx_triage_priority ON email_triage(priority);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_email_unique ON email_triage(email_id) WHERE email_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_inbound_unique ON email_triage(inbound_email_id) WHERE inbound_email_id IS NOT NULL;
  INSERT OR IGNORE INTO _migrations (id) VALUES (16);
  `,

  // Migration 17: attachment_paths — store local/S3 paths for downloaded attachments
  `
  ALTER TABLE inbound_emails ADD COLUMN attachment_paths TEXT NOT NULL DEFAULT '[]';
  INSERT OR IGNORE INTO _migrations (id) VALUES (17);
  `,

  // Migration 18: Provider metadata and S3 object references
  `
  ALTER TABLE inbound_emails ADD COLUMN provider_thread_id TEXT;
  ALTER TABLE inbound_emails ADD COLUMN provider_history_id TEXT;
  ALTER TABLE inbound_emails ADD COLUMN provider_internal_date TEXT;
  ALTER TABLE inbound_emails ADD COLUMN label_ids_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE inbound_emails ADD COLUMN raw_s3_url TEXT;
  ALTER TABLE inbound_emails ADD COLUMN metadata_s3_url TEXT;
  CREATE INDEX IF NOT EXISTS idx_inbound_thread ON inbound_emails(provider_thread_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_history ON inbound_emails(provider_history_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (18);
  `,

  // Migration 19: automated provisioning — domain/address lifecycle fields +
  // append-only provisioning_events audit. DNS is always Cloudflare.
  `
  ALTER TABLE domains ADD COLUMN provisioning_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE domains ADD COLUMN purchase_provider TEXT;
  ALTER TABLE domains ADD COLUMN dns_provider TEXT NOT NULL DEFAULT 'cloudflare';
  ALTER TABLE domains ADD COLUMN send_provider TEXT;
  ALTER TABLE domains ADD COLUMN cf_zone_id TEXT;
  ALTER TABLE domains ADD COLUMN registrar TEXT;
  ALTER TABLE domains ADD COLUMN nameservers_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE domains ADD COLUMN mail_from_domain TEXT;
  ALTER TABLE domains ADD COLUMN last_error TEXT;
  ALTER TABLE domains ADD COLUMN next_check_at TEXT;

  ALTER TABLE addresses ADD COLUMN domain_id TEXT;
  ALTER TABLE addresses ADD COLUMN receive_strategy TEXT;
  ALTER TABLE addresses ADD COLUMN forward_to TEXT;
  ALTER TABLE addresses ADD COLUMN routing_rule_id TEXT;
  ALTER TABLE addresses ADD COLUMN provisioning_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE addresses ADD COLUMN last_validated_at TEXT;
  ALTER TABLE addresses ADD COLUMN last_error TEXT;
  ALTER TABLE addresses ADD COLUMN next_check_at TEXT;

  CREATE TABLE IF NOT EXISTS provisioning_events (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('domain','address')),
    entity_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_provevents_entity ON provisioning_events(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_domains_provstatus ON domains(provisioning_status);
  CREATE INDEX IF NOT EXISTS idx_addresses_provstatus ON addresses(provisioning_status);
  CREATE INDEX IF NOT EXISTS idx_addresses_domain ON addresses(domain_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (19);
  `,

  // Migration 20: ownership — owners (human|agent) + address ownership/administration.
  `
  CREATE TABLE IF NOT EXISTS owners (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('human','agent')),
    name TEXT NOT NULL,
    contact_email TEXT,
    external_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_owners_type ON owners(type);
  CREATE INDEX IF NOT EXISTS idx_owners_name ON owners(name);
  CREATE INDEX IF NOT EXISTS idx_owners_external_id ON owners(external_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_owners_external_id_unique ON owners(external_id) WHERE external_id IS NOT NULL;
  ALTER TABLE addresses ADD COLUMN owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL;
  ALTER TABLE addresses ADD COLUMN administrator_id TEXT REFERENCES owners(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_addresses_owner ON addresses(owner_id);
  CREATE INDEX IF NOT EXISTS idx_addresses_admin ON addresses(administrator_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (20);
  `,

  // Migration 21: threading — RFC Message-ID, thread_id, In-Reply-To, References.
  `
  ALTER TABLE emails ADD COLUMN message_id TEXT;
  ALTER TABLE emails ADD COLUMN thread_id TEXT;
  ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
  ALTER TABLE emails ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE inbound_emails ADD COLUMN thread_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id);
  CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_threadid ON inbound_emails(thread_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (21);
  `,

  // Migration 22: address lifecycle — status + per-address daily send quota.
  `
  ALTER TABLE addresses ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE addresses ADD COLUMN daily_quota INTEGER;
  CREATE INDEX IF NOT EXISTS idx_addresses_status ON addresses(status);
  INSERT OR IGNORE INTO _migrations (id) VALUES (22);
  `,

  // Migration 23: local read-state / archive / star for inbound mail.
  `
  ALTER TABLE inbound_emails ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE inbound_emails ADD COLUMN read_at TEXT;
  ALTER TABLE inbound_emails ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE inbound_emails ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_inbound_is_read ON inbound_emails(is_read);
  CREATE INDEX IF NOT EXISTS idx_inbound_is_archived ON inbound_emails(is_archived);
  INSERT OR IGNORE INTO _migrations (id) VALUES (23);
  `,

  // Migration 24: per-domain aliases + catch-all. An alias maps a recipient
  // local-part to a target address; a catch-all (local_part = '*') maps every
  // unmatched recipient on a domain. Unique per (domain, local_part).
  `
  CREATE TABLE IF NOT EXISTS aliases (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    local_part TEXT NOT NULL,
    target_address TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(domain, local_part)
  );
  CREATE INDEX IF NOT EXISTS idx_aliases_domain ON aliases(domain);
  INSERT OR IGNORE INTO _migrations (id) VALUES (24);
  `,

  // Migration 25: scoped send keys — an API/MCP credential bound to one owner.
  // A key authorizes sending only from addresses that owner owns or administers.
  `
  CREATE TABLE IF NOT EXISTS send_keys (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_send_keys_owner ON send_keys(owner_id);
  CREATE INDEX IF NOT EXISTS idx_send_keys_hash ON send_keys(key_hash);
  INSERT OR IGNORE INTO _migrations (id) VALUES (25);
  `,

  // Migration 26: composite indexes so the mailbox list queries
  // (WHERE is_archived/is_read/is_starred ORDER BY received_at) seek+walk an
  // index instead of sorting the whole table — critical on large inboxes.
  `
  CREATE INDEX IF NOT EXISTS idx_inbound_arch_recv ON inbound_emails(is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_read_arch_recv ON inbound_emails(is_read, is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_star_arch_recv ON inbound_emails(is_starred, is_archived, received_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (26);
  `,

  // Migration 27: aliases.protected — flags an alias that can't be deleted
  // (the default global catch-all that catches mail for every domain).
  `
  ALTER TABLE aliases ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;
  INSERT OR IGNORE INTO _migrations (id) VALUES (27);
  `,

  // Migration 28: denormalized is_sent flag on inbound_emails. Imported sent
  // mail can be labelled SENT; this indexed flag lets Sent and received folders
  // be plain indexed seeks (no JSON label scanning).
  `
  ALTER TABLE inbound_emails ADD COLUMN is_sent INTEGER NOT NULL DEFAULT 0;
  UPDATE inbound_emails
     SET is_sent = 1
   WHERE json_valid(label_ids_json)
     AND EXISTS (
       SELECT 1 FROM json_each(label_ids_json)
        WHERE LOWER(value) = 'sent'
     );
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_arch_recv ON inbound_emails(is_sent, is_archived, received_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (28);
  `,

  // Migration 29: address ownership audit log.
  `
  CREATE TABLE IF NOT EXISTS address_ownership_events (
    id TEXT PRIMARY KEY,
    address_id TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK(action IN ('assign','transfer','unassign')),
    previous_owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    previous_administrator_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    administrator_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    actor TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_addrownevents_address ON address_ownership_events(address_id, created_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (29);
  `,

  // Migration 30: hot-path composite indexes for bounded list views.
  // These match the query shapes used by Emails UI, MCP list/export tools, and
  // diagnostics: equality filters first, then the timestamp used for ordering.
  `
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_read_arch_recv ON inbound_emails(is_sent, is_read, is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_star_arch_recv ON inbound_emails(is_sent, is_starred, is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_arch_recv ON inbound_emails(provider_id, is_sent, is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_read_arch_recv ON inbound_emails(provider_id, is_sent, is_read, is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_star_arch_recv ON inbound_emails(provider_id, is_sent, is_starred, is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_emails_provider_sent ON emails(provider_id, sent_at);
  CREATE INDEX IF NOT EXISTS idx_emails_status_sent ON emails(status, sent_at);
  CREATE INDEX IF NOT EXISTS idx_emails_provider_status_sent ON emails(provider_id, status, sent_at);
  CREATE INDEX IF NOT EXISTS idx_emails_from_sent ON emails(from_address, sent_at);
  CREATE INDEX IF NOT EXISTS idx_events_provider_occurred ON events(provider_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_events_type_occurred ON events(type, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_events_provider_type_occurred ON events(provider_id, type, occurred_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (30);
  `,

  // Migration 31: denormalized recipient index for inbound mail. This avoids
  // json_each(to_addresses) scans on every inbox source/filter/count refresh.
  `
  ${INBOUND_RECIPIENTS_SCHEMA_SQL}
  ${INBOUND_RECIPIENTS_BACKFILL_SQL}
  ${INBOUND_RECIPIENTS_TRIGGERS_SQL}
  INSERT OR IGNORE INTO _migrations (id) VALUES (31);
  `,

  // Migration 32: standalone inbound message-id index for S3 object dedupe.
  // Provider dedupe is keyed by provider_id first; S3 sync probes by message_id
  // alone, so it needs its own indexed seek to avoid full scans.
  `
  CREATE INDEX IF NOT EXISTS idx_inbound_message_id ON inbound_emails(message_id)
    WHERE message_id IS NOT NULL;
  INSERT OR IGNORE INTO _migrations (id) VALUES (32);
  `,

  // Migration 33: scheduler due-enrollment composite index.
  `
  CREATE INDEX IF NOT EXISTS idx_enrollments_due ON sequence_enrollments(status, next_send_at, id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (33);
  `,

  // Migration 34: scheduler due-email composite index.
  `
  CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_emails(status, scheduled_at, id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (34);
  `,

  // Migration 35: expression indexes for display-name sender filters.
  // These match sqlEmailAddress/sqlEmailDomain so exact sender and warming
  // domain filters stay indexed even when stored From values include names.
  `
  CREATE INDEX IF NOT EXISTS idx_emails_sender_canonical_sent ON emails(${sqlEmailAddress("from_address")}, sent_at);
  CREATE INDEX IF NOT EXISTS idx_emails_sender_domain_sent ON emails(${sqlEmailDomain("from_address")}, sent_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sender_canonical_recv ON inbound_emails(is_sent, is_archived, ${sqlEmailAddress("from_address")}, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sender_domain_recv ON inbound_emails(is_sent, is_archived, ${sqlEmailDomain("from_address")}, received_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (35);
  `,

  // Migration 36: normalized labels plus hot spam/trash flags for Emails UI.
  // Folder counts/listing must not json_each(label_ids_json) on large stores.
  `
  ALTER TABLE inbound_emails ADD COLUMN is_spam INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE inbound_emails ADD COLUMN is_trash INTEGER NOT NULL DEFAULT 0;
  ${INBOUND_LABELS_SCHEMA_SQL}
  ${INBOUND_LABELS_BACKFILL_SQL}
  ${INBOUND_LABELS_FLAG_BACKFILL_SQL}
  ${INBOUND_LABELS_TRIGGERS_SQL}
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_arch_spam_trash_recv ON inbound_emails(is_sent, is_archived, is_spam, is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_read_arch_spam_trash_recv ON inbound_emails(is_sent, is_read, is_archived, is_spam, is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_star_arch_spam_trash_recv ON inbound_emails(is_sent, is_starred, is_archived, is_spam, is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_arch_spam_trash_recv ON inbound_emails(is_archived, is_spam, is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_spam_recv ON inbound_emails(is_spam, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_trash_recv ON inbound_emails(is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_spam_recv ON inbound_emails(is_sent, is_spam, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_trash_recv ON inbound_emails(is_sent, is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_arch_spam_trash_recv ON inbound_emails(provider_id, is_sent, is_archived, is_spam, is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_read_arch_spam_trash_recv ON inbound_emails(provider_id, is_sent, is_read, is_archived, is_spam, is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_star_arch_spam_trash_recv ON inbound_emails(provider_id, is_sent, is_starred, is_archived, is_spam, is_trash, received_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (36);
  `,

  // Migration 37: re-normalize inbound label index after whitespace/truncation
  // normalization was made consistent with app-side label filters.
  `
  DELETE FROM inbound_labels;
  ${INBOUND_LABELS_BACKFILL_SQL}
  ${INBOUND_LABELS_FLAG_BACKFILL_SQL}
  INSERT OR IGNORE INTO _migrations (id) VALUES (37);
  `,

  // Migration 38: persistent Emails email agents and per-email run ledger.
  `
  CREATE TABLE IF NOT EXISTS email_agent_settings (
    agent_key TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    always_on INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL DEFAULT 'external' CHECK(provider IN ('external')),
    model TEXT,
    apply_labels INTEGER NOT NULL DEFAULT 1,
    use_network_tools INTEGER NOT NULL DEFAULT 1,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS email_agent_runs (
    id TEXT PRIMARY KEY,
    agent_key TEXT NOT NULL,
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK(provider IN ('external')),
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ok','error','skipped')),
    category TEXT,
    labels_json TEXT NOT NULL DEFAULT '[]',
    priority INTEGER CHECK(priority BETWEEN 1 AND 5),
    confidence REAL,
    risk_score INTEGER CHECK(risk_score BETWEEN 0 AND 100),
    summary TEXT,
    reasoning TEXT,
    tool_calls_json TEXT NOT NULL DEFAULT '[]',
    output_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(agent_key, inbound_email_id)
  );
  CREATE INDEX IF NOT EXISTS idx_email_agent_runs_agent_status ON email_agent_runs(agent_key, status, completed_at);
  CREATE INDEX IF NOT EXISTS idx_email_agent_runs_inbound ON email_agent_runs(inbound_email_id);
  CREATE INDEX IF NOT EXISTS idx_email_agent_runs_completed ON email_agent_runs(completed_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (38);
  `,

  // Migration 39: persisted inbound digest snapshots for dashboard/TUI/CLI.
  `
  CREATE TABLE IF NOT EXISTS email_digests (
    id TEXT PRIMARY KEY,
    period TEXT NOT NULL CHECK(period IN ('today','yesterday','last7','month')),
    since TEXT NOT NULL,
    until TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('local','external')),
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ok','error')),
    message_count INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    highlights_json TEXT NOT NULL DEFAULT '[]',
    action_items_json TEXT NOT NULL DEFAULT '[]',
    important_email_ids_json TEXT NOT NULL DEFAULT '[]',
    label_counts_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_email_digests_period_completed ON email_digests(period, status, completed_at);
  CREATE INDEX IF NOT EXISTS idx_email_digests_window ON email_digests(period, since, until);
  INSERT OR IGNORE INTO _migrations (id) VALUES (39);
  `,

  // Migration 40: Provider/Source/Mailbox/Folder architecture. This keeps
  // inbound_emails as a compatibility read surface while backfilling canonical
  // mail messages and per-mailbox state for every recipient.
  `
  ${MAIL_ARCHITECTURE_SCHEMA_SQL}
  ${MAIL_ARCHITECTURE_COLUMNS_SQL}
  ${MAIL_ARCHITECTURE_BACKFILL_SQL}
  ${MAIL_ARCHITECTURE_INBOUND_INSERT_TRIGGER_SQL}
  ${PROVIDER_DELETE_GUARD_SQL}
  INSERT OR IGNORE INTO _migrations (id) VALUES (40);
  `,

  // Migration 41: reconciled canonical per-mailbox state after local
  // read/archive/star mutations. `mailbox_message_state` had no reader and is
  // dropped by migration 47, so the body is now a ledger entry only. Databases
  // that already recorded 41 never replay it, so this is not a behaviour change
  // for them.
  `
  INSERT OR IGNORE INTO _migrations (id) VALUES (41);
  `,

  // Migration 42: re-ran the same reconciliation for reserved label mutations.
  // Retired with migration 41, above.
  `
  INSERT OR IGNORE INTO _migrations (id) VALUES (42);
  `,

  // Migration 43: preserve already bucket-qualified S3 provenance in
  // canonical messages before exact S3 source filters/dedupe rely on raw_s3_url.
  `
  ${S3_MESSAGE_ID_RAW_URL_BACKFILL_SQL}
  INSERT OR IGNORE INTO _migrations (id) VALUES (43);
  `,

  // Migration 44: rebuild inbound-derived canonical mailbox/source rows with
  // sanitized provider IDs and install canonical cleanup for deleted inbound rows.
  `
  DROP TRIGGER IF EXISTS trg_mail_architecture_inbound_insert;
  ${MAIL_ARCHITECTURE_INBOUND_INSERT_TRIGGER_SQL}
  DROP TRIGGER IF EXISTS trg_mail_architecture_inbound_delete;
  ${MAIL_ARCHITECTURE_INBOUND_DELETE_TRIGGER_SQL}
  ${MAIL_ARCHITECTURE_BACKFILL_SQL}
  INSERT OR IGNORE INTO _migrations (id) VALUES (44);
  `,

  // Migration 45: per-domain readiness lifecycle and provider/DNS snapshots.
  `
  ALTER TABLE domains ADD COLUMN domain_type TEXT NOT NULL DEFAULT 'self_hosted' CHECK(domain_type IN ('system','tenant','self_hosted','local_only'));
  ALTER TABLE domains ADD COLUMN source_of_truth TEXT NOT NULL DEFAULT 'local' CHECK(source_of_truth IN ('local','postgres','cloud'));
  ALTER TABLE domains ADD COLUMN ownership_status TEXT NOT NULL DEFAULT 'pending' CHECK(ownership_status IN ('pending','verified','failed'));
  ALTER TABLE domains ADD COLUMN inbound_status TEXT NOT NULL DEFAULT 'pending' CHECK(inbound_status IN ('pending','ready','disabled','failed'));
  ALTER TABLE domains ADD COLUMN outbound_status TEXT NOT NULL DEFAULT 'pending' CHECK(outbound_status IN ('pending','ready','disabled','failed'));
  ALTER TABLE domains ADD COLUMN monitoring_status TEXT NOT NULL DEFAULT 'none' CHECK(monitoring_status IN ('none','monitoring','clean','risky'));
  ALTER TABLE domains ADD COLUMN dns_records_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE domains ADD COLUMN provider_metadata_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE domains ADD COLUMN last_dns_check_at TEXT;
  ALTER TABLE domains ADD COLUMN last_inbound_check_at TEXT;
  ALTER TABLE domains ADD COLUMN last_outbound_check_at TEXT;
  ALTER TABLE domains ADD COLUMN last_monitored_at TEXT;
  ALTER TABLE domains ADD COLUMN restricted_at TEXT;
  ALTER TABLE domains ADD COLUMN suspended_at TEXT;
  CREATE INDEX IF NOT EXISTS idx_domains_type ON domains(domain_type);
  CREATE INDEX IF NOT EXISTS idx_domains_source_truth ON domains(source_of_truth);
  CREATE INDEX IF NOT EXISTS idx_domains_readiness ON domains(ownership_status, inbound_status, outbound_status);
  INSERT OR IGNORE INTO _migrations (id) VALUES (45);
  `,

  // Migration 46: additive Emails rename bridge. The `mail_folders`,
  // `mailbox_message_state` and `inbound_emails.primary_mailbox_id` legs were
  // dropped with the write-only tables they renamed (migration 47) — a database
  // that already recorded 46 never replays this body, and one that has not yet
  // reached it drops those tables moments later.
  `
  ${RETIRED_LEGACY_INBOUND_BRIDGE_SQL}

  UPDATE domains SET domain_type = 'self_hosted' WHERE domain_type = 'tenant';
  UPDATE domains SET source_of_truth = 'postgres' WHERE source_of_truth = 'cloud';

  CREATE TABLE IF NOT EXISTS webhook_receipts (
    provider TEXT NOT NULL,
    event_id TEXT NOT NULL,
    resource_id TEXT,
    completed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider, event_id)
  );
  INSERT OR IGNORE INTO _migrations (id) VALUES (46);
  `,

  // Migration 47: drop the two canonical tables that were written by triggers and
  // read by nothing. Both were derived entirely from `inbound_emails`, so no mail
  // is lost: bodies live in `inbound_emails` (and, for historical rows, in
  // `mail_messages`, which survives for the inbound-delete trigger). `mailboxes`
  // and `mailbox_sources` also survive — `trg_providers_preserve_mail_history`
  // reads the latter to refuse deleting a provider that still has history.
  // `mailbox_message_state` goes first: it holds the foreign key into
  // `mail_folders`.
  `
  DROP TABLE IF EXISTS mailbox_message_state;
  DROP TABLE IF EXISTS mail_folders;
  INSERT OR IGNORE INTO _migrations (id) VALUES (47);
  `,

  // Migration 48: re-run the rename bridge. Migration 46 already retired
  // `local.mailery`, but the inbound trigger re-minted it on the next
  // `getDatabase()` call, so any database released between the two carries the
  // retired identity again. The trigger no longer knows the retired literal, so
  // this pass is terminal rather than a truce.
  `
  ${RETIRED_LEGACY_INBOUND_BRIDGE_SQL}
  INSERT OR IGNORE INTO _migrations (id) VALUES (48);
  `,
];

let _db: Database | null = null;

export function getDatabase(dbPath?: string): Database {
  if (_db) return _db;

  const requestedPath = dbPath || getDbPath();
  // Use the same normalized pathname for validation, private pre-creation,
  // and SQLite so lexical `..` segments cannot reintroduce an unchecked path.
  const path = isInMemoryDb(requestedPath)
    ? requestedPath
    : process.platform === "win32"
      ? resolve(requestedPath)
      // getDbPath already returns the one-time canonical POSIX path. An
      // explicit argument has not crossed that boundary yet.
      : dbPath
        ? canonicalizeDatabasePath(requestedPath)
        : requestedPath;
  ensureDir(path);
  ensurePrivateDatabaseArtifacts(path, true);

  const db = new Database(path);
  try {
    // busy_timeout FIRST. Converting a fresh database to WAL takes an exclusive
    // lock, so when several processes open the same new database at once — which
    // is exactly what the CLI does, one short-lived process per invocation —
    // whichever loses the race fails immediately with SQLITE_BUSY unless a busy
    // handler is already installed. Setting it afterwards is too late for the
    // statement most likely to contend.
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");

    runMigrations(db);
    ensurePrivateDatabaseArtifacts(path, false);

    _db = db;
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function applyMigrations(db: Database): void {
  try {
    const result = db.query("SELECT MAX(id) as max_id FROM _migrations").get() as { max_id: number | null } | null;
    const currentLevel = result?.max_id ?? 0;

    for (let i = currentLevel; i < MIGRATIONS.length; i++) {
      try {
        db.exec(MIGRATIONS[i]!);
      } catch {
        // Migration partially failed — ensureSchema will fix gaps
      }
    }
  } catch {
    for (const migration of MIGRATIONS) {
      try {
        db.exec(migration);
      } catch {
        // Partial failure handled by ensureSchema
      }
    }
  }
}

// Initialising a cold database applies ~200 migration statements plus ~140
// idempotent schema probes. Left unbatched, SQLite commits — and fsyncs — each
// one separately, which cost ~900ms on a local NVMe and several seconds on the
// slower disks CI runners get; that latency, not the assertions, is what made
// the file-backed database and live-CLI tests time out under load.
//
// Batching the whole sequence into one transaction turns those hundreds of
// commits into a single one. It is purely a commit-boundary change: every
// statement still runs in the same order, the per-statement `try`/`catch`
// tolerance is preserved, and durability settings are untouched (no
// `synchronous` downgrade), so an interrupted open still cannot observe a
// half-applied schema. `runInTransaction` uses SAVEPOINTs, so callers nest
// safely inside this transaction.
function runMigrations(db: Database): void {
  // BEGIN IMMEDIATE, never a bare BEGIN. A deferred BEGIN takes only a WAL read
  // snapshot on the first statement below — `SELECT MAX(id) FROM _migrations` —
  // and each DDL then has to upgrade that read transaction to a write one. If
  // any other connection commits in between, the upgrade fails with
  // SQLITE_BUSY_SNAPSHOT, and SQLite deliberately does NOT invoke the busy
  // handler for it, so `busy_timeout` cannot absorb it. Because every statement
  // here tolerates its own failure, the entire pass would be skipped while the
  // now-read-only COMMIT still succeeded: the caller would be handed a silently
  // un-migrated database, which is far worse than a slow one. Taking the write
  // lock up front makes that race impossible — no other connection can commit
  // while we hold it, and failure to acquire it surfaces as ordinary
  // SQLITE_BUSY, which `busy_timeout` does absorb.
  let batched = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    batched = true;
  } catch {
    // Either a caller already owns a transaction, or the write lock could not be
    // taken. Apply unbatched, which is exactly the pre-batching behaviour.
  }

  if (!batched) {
    applyMigrations(db);
    ensureSchema(db);
    return;
  }

  try {
    applyMigrations(db);
    ensureSchema(db);
    db.exec("COMMIT");
  } catch {
    // The batch could not be committed. Discard it and rebuild one statement at
    // a time. The reapply is level-based on purpose: replaying from zero would
    // re-run migration 8, whose table-rebuild is destructive against data that
    // is already migrated.
    //
    // Residual, for the error classes where SQLite ends the transaction itself
    // (SQLITE_FULL, SQLITE_IOERR): statements after that point run in autocommit
    // and durably record their sentinels, so `MAX(id)` can advance past a
    // migration whose DDL was rolled back, and the level-based reapply will not
    // revisit it. `ensureSchema` below is the designed backstop for exactly that
    // gap, and it runs on every open.
    try {
      db.exec("ROLLBACK");
    } catch {
      // No transaction left to roll back.
    }
    applyMigrations(db);
    ensureSchema(db);
  }
}

function ensureSchema(db: Database): void {
  // Ensure OAuth columns exist (idempotent — ALTER TABLE fails gracefully if column already exists)
  const ensureColumn = (sql: string) => {
    try { db.exec(sql); } catch {}
  };
  ensureColumn("ALTER TABLE providers ADD COLUMN oauth_client_id TEXT");
  ensureColumn("ALTER TABLE providers ADD COLUMN oauth_client_secret TEXT");
  ensureColumn("ALTER TABLE providers ADD COLUMN oauth_refresh_token TEXT");
  ensureColumn("ALTER TABLE providers ADD COLUMN oauth_access_token TEXT");
  ensureColumn("ALTER TABLE providers ADD COLUMN oauth_token_expiry TEXT");

  // Migration 19 (idempotent guarantee): provisioning fields for automated
  // domain/address provisioning. ALTER ADD COLUMN has no IF NOT EXISTS, so these
  // run individually and tolerate "duplicate column" on already-migrated DBs.
  ensureColumn("ALTER TABLE domains ADD COLUMN provisioning_status TEXT NOT NULL DEFAULT 'none'");
  ensureColumn("ALTER TABLE domains ADD COLUMN purchase_provider TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN dns_provider TEXT NOT NULL DEFAULT 'cloudflare'");
  ensureColumn("ALTER TABLE domains ADD COLUMN send_provider TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN cf_zone_id TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN registrar TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN nameservers_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("ALTER TABLE domains ADD COLUMN mail_from_domain TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN last_error TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN next_check_at TEXT");

  // Migration 45 idempotent guarantee: per-domain readiness lifecycle.
  ensureColumn("ALTER TABLE domains ADD COLUMN domain_type TEXT NOT NULL DEFAULT 'self_hosted'");
  ensureColumn("ALTER TABLE domains ADD COLUMN source_of_truth TEXT NOT NULL DEFAULT 'local'");
  ensureColumn("ALTER TABLE domains ADD COLUMN ownership_status TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn("ALTER TABLE domains ADD COLUMN inbound_status TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn("ALTER TABLE domains ADD COLUMN outbound_status TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn("ALTER TABLE domains ADD COLUMN monitoring_status TEXT NOT NULL DEFAULT 'none'");
  ensureColumn("ALTER TABLE domains ADD COLUMN dns_records_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("ALTER TABLE domains ADD COLUMN provider_metadata_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("ALTER TABLE domains ADD COLUMN last_dns_check_at TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN last_inbound_check_at TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN last_outbound_check_at TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN last_monitored_at TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN restricted_at TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN suspended_at TEXT");

  ensureColumn("ALTER TABLE addresses ADD COLUMN domain_id TEXT");
  ensureColumn("ALTER TABLE addresses ADD COLUMN receive_strategy TEXT");
  ensureColumn("ALTER TABLE addresses ADD COLUMN forward_to TEXT");
  ensureColumn("ALTER TABLE addresses ADD COLUMN routing_rule_id TEXT");
  ensureColumn("ALTER TABLE addresses ADD COLUMN provisioning_status TEXT NOT NULL DEFAULT 'none'");
  ensureColumn("ALTER TABLE addresses ADD COLUMN last_validated_at TEXT");
  ensureColumn("ALTER TABLE addresses ADD COLUMN last_error TEXT");
  ensureColumn("ALTER TABLE addresses ADD COLUMN next_check_at TEXT");

  const ensureProvTable = (sql: string) => { try { db.exec(sql); } catch {} };
  ensureProvTable(`CREATE TABLE IF NOT EXISTS webhook_receipts (
    provider TEXT NOT NULL,
    event_id TEXT NOT NULL,
    resource_id TEXT,
    completed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider, event_id)
  )`);
  ensureProvTable(`CREATE TABLE IF NOT EXISTS provisioning_events (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_provevents_entity ON provisioning_events(entity_type, entity_id)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_domains_provstatus ON domains(provisioning_status)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_addresses_provstatus ON addresses(provisioning_status)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_addresses_domain ON addresses(domain_id)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_domains_type ON domains(domain_type)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_domains_source_truth ON domains(source_of_truth)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_domains_readiness ON domains(ownership_status, inbound_status, outbound_status)");

  // Migration 20 idempotent guarantee: owners + address ownership.
  ensureProvTable(`CREATE TABLE IF NOT EXISTS owners (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    contact_email TEXT,
    external_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_owners_type ON owners(type)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_owners_external_id ON owners(external_id)");
  ensureProvTable("CREATE UNIQUE INDEX IF NOT EXISTS idx_owners_external_id_unique ON owners(external_id) WHERE external_id IS NOT NULL");
  ensureColumn("ALTER TABLE addresses ADD COLUMN owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL");
  ensureColumn("ALTER TABLE addresses ADD COLUMN administrator_id TEXT REFERENCES owners(id) ON DELETE SET NULL");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_addresses_owner ON addresses(owner_id)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_addresses_admin ON addresses(administrator_id)");

  // Migration 21 idempotent guarantee: threading columns.
  ensureColumn("ALTER TABLE emails ADD COLUMN message_id TEXT");
  ensureColumn("ALTER TABLE emails ADD COLUMN thread_id TEXT");
  ensureColumn("ALTER TABLE emails ADD COLUMN in_reply_to TEXT");
  ensureColumn("ALTER TABLE emails ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN thread_id TEXT");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_threadid ON inbound_emails(thread_id)");

  // Migration 22 idempotent guarantee: address lifecycle columns.
  ensureColumn("ALTER TABLE addresses ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  ensureColumn("ALTER TABLE addresses ADD COLUMN daily_quota INTEGER");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_addresses_status ON addresses(status)");

  // Migration 23 idempotent guarantee: inbound local read-state / archive / star.
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN read_at TEXT");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_is_read ON inbound_emails(is_read)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_is_archived ON inbound_emails(is_archived)");

  // Migration 24 idempotent guarantee: aliases / catch-all.
  ensureProvTable(`CREATE TABLE IF NOT EXISTS aliases (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    local_part TEXT NOT NULL,
    target_address TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(domain, local_part)
  )`);
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_aliases_domain ON aliases(domain)");

  // Migration 36 idempotent guarantee: app-level inbound forwarding rules.
  ensureProvTable(`CREATE TABLE IF NOT EXISTS forwarding_rules (
    id TEXT PRIMARY KEY,
    source_address TEXT NOT NULL,
    target_address TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'app-copy' CHECK(mode IN ('app-copy')),
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    from_address TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_address, target_address, mode)
  )`);
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_forwarding_rules_source ON forwarding_rules(source_address, enabled)");
  ensureProvTable(`CREATE TABLE IF NOT EXISTS forwarding_deliveries (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL REFERENCES forwarding_rules(id) ON DELETE CASCADE,
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    sent_email_id TEXT REFERENCES emails(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK(status IN ('sent','failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(rule_id, inbound_email_id)
  )`);
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_forwarding_deliveries_rule ON forwarding_deliveries(rule_id, created_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_forwarding_deliveries_inbound ON forwarding_deliveries(inbound_email_id)");

  // Migration 25 idempotent guarantee: scoped send keys.
  ensureProvTable(`CREATE TABLE IF NOT EXISTS send_keys (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at TEXT
  )`);
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_send_keys_owner ON send_keys(owner_id)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_send_keys_hash ON send_keys(key_hash)");

  // Migration 26 idempotent guarantee: composite mailbox-list indexes.
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_arch_recv ON inbound_emails(is_archived, received_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_read_arch_recv ON inbound_emails(is_read, is_archived, received_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_star_arch_recv ON inbound_emails(is_starred, is_archived, received_at)");
  ensureColumn("ALTER TABLE aliases ADD COLUMN protected INTEGER NOT NULL DEFAULT 0");
  // The default, protected global catch-all (all domains) — never deletable, so
  // mail to any of our domains is never dropped. Empty target = keep, no rewrite.
  ensureProvTable("INSERT OR IGNORE INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at) VALUES ('global-catch-all', '*', '*', '', 1, datetime('now'), datetime('now'))");
  // Migration 28 idempotent guarantee: is_sent flag + index.
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN is_sent INTEGER NOT NULL DEFAULT 0");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_sent_arch_recv ON inbound_emails(is_sent, is_archived, received_at)");

  // Migration 29 idempotent guarantee: ownership audit log.
  ensureProvTable(`CREATE TABLE IF NOT EXISTS address_ownership_events (
    id TEXT PRIMARY KEY,
    address_id TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    previous_owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    previous_administrator_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    administrator_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    actor TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_addrownevents_address ON address_ownership_events(address_id, created_at)");

  // Migration 30 idempotent guarantee: composite indexes for list/export/stat hot paths.
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_sent_read_arch_recv ON inbound_emails(is_sent, is_read, is_archived, received_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_sent_star_arch_recv ON inbound_emails(is_sent, is_starred, is_archived, received_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_arch_recv ON inbound_emails(provider_id, is_sent, is_archived, received_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_read_arch_recv ON inbound_emails(provider_id, is_sent, is_read, is_archived, received_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_star_arch_recv ON inbound_emails(provider_id, is_sent, is_starred, is_archived, received_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_emails_provider_sent ON emails(provider_id, sent_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_emails_status_sent ON emails(status, sent_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_emails_provider_status_sent ON emails(provider_id, status, sent_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_emails_from_sent ON emails(from_address, sent_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_events_provider_occurred ON events(provider_id, occurred_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_events_type_occurred ON events(type, occurred_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_events_provider_type_occurred ON events(provider_id, type, occurred_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_message_id ON inbound_emails(message_id) WHERE message_id IS NOT NULL");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_enrollments_due ON sequence_enrollments(status, next_send_at, id)");

  // Migration 35 idempotent guarantee: expression indexes for display-name
  // sender filters in sent mail and imported sent mail.
  ensureProvTable(`CREATE INDEX IF NOT EXISTS idx_emails_sender_canonical_sent ON emails(${sqlEmailAddress("from_address")}, sent_at)`);
  ensureProvTable(`CREATE INDEX IF NOT EXISTS idx_emails_sender_domain_sent ON emails(${sqlEmailDomain("from_address")}, sent_at)`);
  ensureProvTable(`CREATE INDEX IF NOT EXISTS idx_inbound_sender_canonical_recv ON inbound_emails(is_sent, is_archived, ${sqlEmailAddress("from_address")}, received_at)`);
  ensureProvTable(`CREATE INDEX IF NOT EXISTS idx_inbound_sender_domain_recv ON inbound_emails(is_sent, is_archived, ${sqlEmailDomain("from_address")}, received_at)`);

  const ensureIndex = (sql: string) => {
    try { db.exec(sql); } catch {}
  };

  ensureIndex("CREATE INDEX IF NOT EXISTS idx_domains_provider ON domains(provider_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_domains_domain_nocase ON domains(domain COLLATE NOCASE)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_domains_provider_domain_nocase ON domains(provider_id, domain COLLATE NOCASE)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_addresses_provider ON addresses(provider_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_addresses_email ON addresses(email)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_addresses_email_nocase ON addresses(email COLLATE NOCASE)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_emails_provider ON emails(provider_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_emails_sent_at ON emails(sent_at)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_emails_from ON emails(from_address)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_events_email ON events(email_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_events_provider ON events(provider_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at)");
  ensureIndex("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_provider_event ON events(provider_id, provider_event_id) WHERE provider_event_id IS NOT NULL");

  // Ensure templates table exists
  const ensureTable = (sql: string) => {
    try { db.exec(sql); } catch {}
  };
  ensureTable(`CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    subject_template TEXT NOT NULL,
    html_template TEXT,
    text_template TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_templates_name ON templates(name)");

  // Ensure contacts table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    send_count INTEGER NOT NULL DEFAULT 0,
    bounce_count INTEGER NOT NULL DEFAULT 0,
    complaint_count INTEGER NOT NULL DEFAULT 0,
    last_sent_at TEXT,
    suppressed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_contacts_suppressed ON contacts(suppressed)");

  // Ensure scheduled_emails table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS scheduled_emails (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    bcc_addresses TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT,
    subject TEXT NOT NULL,
    html TEXT,
    text_body TEXT,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    template_name TEXT,
    template_vars TEXT,
    scheduled_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','cancelled','failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_emails(status)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_scheduled_at ON scheduled_emails(scheduled_at)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_emails(status, scheduled_at, id)");

  // Ensure groups table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_groups_name ON groups(name)");

  // Ensure group_members table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT,
    vars TEXT NOT NULL DEFAULT '{}',
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, email)
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id)");

  // Ensure email_content table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS email_content (
    email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
    html TEXT,
    text_body TEXT,
    headers_json TEXT NOT NULL DEFAULT '{}'
  )`);

  // Ensure sandbox_emails table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS sandbox_emails (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    bcc_addresses TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT,
    subject TEXT NOT NULL,
    html TEXT,
    text_body TEXT,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    headers_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_sandbox_provider ON sandbox_emails(provider_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_sandbox_created ON sandbox_emails(created_at)");

  // Ensure inbound_emails table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS inbound_emails (
    id TEXT PRIMARY KEY,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    message_id TEXT,
    provider_thread_id TEXT,
    provider_history_id TEXT,
    provider_internal_date TEXT,
    label_ids_json TEXT NOT NULL DEFAULT '[]',
    raw_s3_url TEXT,
    metadata_s3_url TEXT,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL DEFAULT '',
    text_body TEXT,
    html_body TEXT,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    headers_json TEXT NOT NULL DEFAULT '{}',
    raw_size INTEGER DEFAULT 0,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_inbound_from ON inbound_emails(from_address)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_inbound_received ON inbound_emails(received_at)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_inbound_provider ON inbound_emails(provider_id)");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN in_reply_to_email_id TEXT REFERENCES emails(id) ON DELETE SET NULL");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_inbound_reply_to ON inbound_emails(in_reply_to_email_id)");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN provider_thread_id TEXT");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN provider_history_id TEXT");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN provider_internal_date TEXT");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN label_ids_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN raw_s3_url TEXT");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN metadata_s3_url TEXT");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_inbound_thread ON inbound_emails(provider_thread_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_inbound_history ON inbound_emails(provider_history_id)");
  ensureInboundRecipients(db);
  ensureInboundLabels(db);

  // Ensure sequences tables exist
  ensureTable(`CREATE TABLE IF NOT EXISTS sequences (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'archived')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_sequences_name ON sequences(name)");

  ensureTable(`CREATE TABLE IF NOT EXISTS sequence_steps (
    id TEXT PRIMARY KEY,
    sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    step_number INTEGER NOT NULL,
    delay_hours INTEGER NOT NULL DEFAULT 24,
    template_name TEXT NOT NULL,
    from_address TEXT,
    subject_override TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(sequence_id, step_number)
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_steps_sequence ON sequence_steps(sequence_id)");

  ensureTable(`CREATE TABLE IF NOT EXISTS sequence_enrollments (
    id TEXT PRIMARY KEY,
    sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    contact_email TEXT NOT NULL,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    current_step INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'cancelled')),
    enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
    next_send_at TEXT,
    completed_at TEXT,
    UNIQUE(sequence_id, contact_email)
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_enrollments_sequence ON sequence_enrollments(sequence_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_enrollments_email ON sequence_enrollments(contact_email)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_enrollments_next_send ON sequence_enrollments(next_send_at)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_enrollments_status ON sequence_enrollments(status)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_enrollments_due ON sequence_enrollments(status, next_send_at, id)");

  // Ensure warming_schedules table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS warming_schedules (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    target_daily_volume INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_warming_domain ON warming_schedules(domain)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_warming_status ON warming_schedules(status)");

  ensureMailArchitecture(db);

  // Dedup index on inbound_emails for provider imports
  ensureIndex(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_provider_message ON inbound_emails(provider_id, message_id)
    WHERE provider_id IS NOT NULL AND message_id IS NOT NULL`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_inbound_message_id ON inbound_emails(message_id) WHERE message_id IS NOT NULL");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN attachment_paths TEXT NOT NULL DEFAULT '[]'");

  // The five columns the store seam (src/store/) requires and these two tables never
  // had. All nullable and additive, so an already-populated database is unchanged and
  // every existing reader — each of which selects named columns or maps a fixed row
  // shape — is unaffected.
  //
  //   * inbound_emails.status / .provider_message_id — writable through the seam's
  //     updateMessageStatus. Without them a status patch would have to be accepted and
  //     silently dropped, which is the plausible-wrong-answer failure the seam removes.
  //   * inbound_emails.source_id — the stable upstream id upsertMessage keys on. The
  //     FENCE is upsertMessage's own BEGIN IMMEDIATE read-then-write, which serialises
  //     writers whether or not this index exists; the partial unique index below is a
  //     backstop against a duplicate arriving by any other path. Said precisely because
  //     `ensureIndex` tolerates its own failure, so a claim that the index IS the fence
  //     would be a claim this file cannot keep.
  //   * inbound_emails.updated_at — the table only ever stamped created_at; the record
  //     shape needs a real mtime, and readers COALESCE back to created_at for legacy rows.
  //   * domains.notes — the seam's DomainRecord carries free-text notes (the strongest
  //     arm has the column) and every other field of that record already has a home here.
  //
  // DELIBERATELY NOT A MIGRATIONS ENTRY, and this is the interesting part. Additive
  // columns already land here rather than in the array (`attachment_paths`, `thread_id`,
  // the provider_* columns), and there is a second, sharper reason: `applyMigrations`
  // replays from `MAX(_migrations.id)`, so a new sentinel RAISES that level for every
  // database. The retired-identity regression suite seeds "a database that has not yet
  // reached migration 48" by deleting the 48 sentinel, which only works while 48 is the
  // highest — a 49th entry silently stops the rename bridge replaying and takes that
  // guard with it. `ensureSchema` runs unconditionally on every open, so these columns
  // are guaranteed without moving the replay level at all.
  //
  // `inbound_emails` is misnamed: since migration 36 added `is_sent` it has held BOTH
  // directions, and it is the only mail table here with folder state and labels. That is
  // why it, and not the provider-scoped `emails` sent-ledger, is where the seam's single
  // message family writes.
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN status TEXT");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN provider_message_id TEXT");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN source_id TEXT");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN updated_at TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN notes TEXT");
  ensureIndex(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_source_id ON inbound_emails(source_id)
    WHERE source_id IS NOT NULL`);

  // Ensure email_triage table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS email_triage (
    id TEXT PRIMARY KEY,
    email_id TEXT REFERENCES emails(id) ON DELETE CASCADE,
    inbound_email_id TEXT REFERENCES inbound_emails(id) ON DELETE CASCADE,
    label TEXT NOT NULL CHECK(label IN ('action-required','fyi','urgent','follow-up','spam','newsletter','transactional')),
    priority INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 5),
    summary TEXT,
    sentiment TEXT CHECK(sentiment IN ('positive','negative','neutral')),
    draft_reply TEXT,
    confidence REAL DEFAULT 0.0,
    model TEXT,
    triaged_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_triage_email ON email_triage(email_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_triage_inbound ON email_triage(inbound_email_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_triage_label ON email_triage(label)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_triage_priority ON email_triage(priority)");
  ensureIndex("CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_email_unique ON email_triage(email_id) WHERE email_id IS NOT NULL");
  ensureIndex("CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_inbound_unique ON email_triage(inbound_email_id) WHERE inbound_email_id IS NOT NULL");

  ensureTable(`CREATE TABLE IF NOT EXISTS email_agent_settings (
    agent_key TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    always_on INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL DEFAULT 'external' CHECK(provider IN ('external')),
    model TEXT,
    apply_labels INTEGER NOT NULL DEFAULT 1,
    use_network_tools INTEGER NOT NULL DEFAULT 1,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureTable(`CREATE TABLE IF NOT EXISTS email_agent_runs (
    id TEXT PRIMARY KEY,
    agent_key TEXT NOT NULL,
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK(provider IN ('external')),
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ok','error','skipped')),
    category TEXT,
    labels_json TEXT NOT NULL DEFAULT '[]',
    priority INTEGER CHECK(priority BETWEEN 1 AND 5),
    confidence REAL,
    risk_score INTEGER CHECK(risk_score BETWEEN 0 AND 100),
    summary TEXT,
    reasoning TEXT,
    tool_calls_json TEXT NOT NULL DEFAULT '[]',
    output_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(agent_key, inbound_email_id)
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_email_agent_runs_agent_status ON email_agent_runs(agent_key, status, completed_at)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_email_agent_runs_inbound ON email_agent_runs(inbound_email_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_email_agent_runs_completed ON email_agent_runs(completed_at)");

  ensureTable(`CREATE TABLE IF NOT EXISTS email_digests (
    id TEXT PRIMARY KEY,
    period TEXT NOT NULL CHECK(period IN ('today','yesterday','last7','month')),
    since TEXT NOT NULL,
    until TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('local','external')),
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ok','error')),
    message_count INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    highlights_json TEXT NOT NULL DEFAULT '[]',
    action_items_json TEXT NOT NULL DEFAULT '[]',
    important_email_ids_json TEXT NOT NULL DEFAULT '[]',
    label_counts_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_email_digests_period_completed ON email_digests(period, status, completed_at)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_email_digests_window ON email_digests(period, since, until)");

  ensureTable(`CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  ensureTable(`CREATE TABLE IF NOT EXISTS forwarding_rules (
    id TEXT PRIMARY KEY,
    source_address TEXT NOT NULL,
    target_address TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'app-copy' CHECK(mode IN ('app-copy')),
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    from_address TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_address, target_address, mode)
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_forwarding_rules_source ON forwarding_rules(source_address, enabled)");
  ensureTable(`CREATE TABLE IF NOT EXISTS forwarding_deliveries (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL REFERENCES forwarding_rules(id) ON DELETE CASCADE,
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    sent_email_id TEXT REFERENCES emails(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK(status IN ('sent','failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(rule_id, inbound_email_id)
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_forwarding_deliveries_rule ON forwarding_deliveries(rule_id, created_at)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_forwarding_deliveries_inbound ON forwarding_deliveries(inbound_email_id)");
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function resetDatabase(): void {
  _db = null;
}

let transactionCounter = 0;

export function runInTransaction<T>(db: Database, fn: () => T): T {
  const savepoint = `emails_tx_${++transactionCounter}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO ${savepoint}`);
    } finally {
      db.exec(`RELEASE ${savepoint}`);
    }
    throw error;
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}

// The `table` name is interpolated into SQL, so it must never be caller-derived.
// All call sites pass a literal; this allowlist makes that a hard guarantee.
const RESOLVABLE_TABLES = new Set([
  "providers", "domains", "addresses", "emails", "inbound_emails", "sandbox_emails",
  "templates", "contacts", "groups", "scheduled_emails", "sequences", "owners", "events",
  "aliases", "send_keys", "forwarding_rules", "forwarding_deliveries",
  "mailboxes", "mailbox_sources", "mail_messages",
]);

export function resolvePartialId(db: Database, table: string, partialId: string): string | null {
  if (!RESOLVABLE_TABLES.has(table)) {
    throw new Error(`resolvePartialId: refusing unknown table '${table}'`);
  }

  if (partialId.length >= 36) {
    const row = db.query(`SELECT id FROM ${table} WHERE id = ?`).get(partialId) as { id: string } | null;
    return row?.id ?? null;
  }

  const rows = db.query(`SELECT id FROM ${table} WHERE id LIKE ? LIMIT ?`).all(`${partialId}%`, 2) as { id: string }[];
  if (rows.length === 1) {
    return rows[0]!.id;
  }
  return null;
}

export function listPartialIdMatches(db: Database, table: string, partialId: string, limit = 6): string[] {
  if (!RESOLVABLE_TABLES.has(table)) {
    throw new Error(`resolvePartialId: refusing unknown table '${table}'`);
  }
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 6;

  const rows = db
    .query(`SELECT id FROM ${table} WHERE id LIKE ? LIMIT ?`)
    .all(`${partialId}%`, safeLimit) as { id: string }[];
  return rows.map((row) => row.id);
}

export function resolvePartialIdOrThrow(db: Database, table: string, partialId: string): string {
  const value = partialId.trim();
  if (!value) throw new Error(`Missing ID for table '${table}'.`);

  const id = resolvePartialId(db, table, value);
  if (id) return id;

  const matches = listPartialIdMatches(db, table, value, 6);
  if (matches.length === 0) {
    throw new Error(`Could not resolve ID '${value}' in table '${table}'.`);
  }

  const preview = matches.slice(0, 5).join(", ");
  const count = matches.length >= 6 ? "at least 6" : String(matches.length);
  const extra = matches.length >= 6 ? " (showing first 5)" : "";
  throw new Error(
    `Ambiguous ID '${value}' in table '${table}' (${count} matches${extra}): ${preview}. Use a longer prefix or full ID.`,
  );
}
