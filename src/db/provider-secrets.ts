import type { Database } from "bun:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { databasePathFor } from "./database-context.js";

export const PROVIDER_SECRET_FIELDS = [
  "api_key",
  "access_key",
  "secret_key",
  "oauth_client_id",
  "oauth_client_secret",
  "oauth_refresh_token",
  "oauth_access_token",
  "oauth_token_expiry",
] as const;

export type ProviderSecretField = (typeof PROVIDER_SECRET_FIELDS)[number];
export type ProviderSecrets = Record<ProviderSecretField, string | null>;

const EMPTY_PROVIDER_SECRETS: ProviderSecrets = {
  api_key: null,
  access_key: null,
  secret_key: null,
  oauth_client_id: null,
  oauth_client_secret: null,
  oauth_refresh_token: null,
  oauth_access_token: null,
  oauth_token_expiry: null,
};

const INLINE_ROOT_KEY_ENV = "EMAILS_PROVIDER_SECRETS_KEY";
const ROOT_KEYRING_FILE_ENVS = [
  "EMAILS_PROVIDER_SECRETS_KEY_FILE",
  "EMAILS_PROVIDER_SECRETS_KEY_PATH",
] as const;
const KEYRING_VERSION = 1;
const ENVELOPE_VERSION = 1;

interface RootKeyringFile {
  version: 1;
  active_key_id: string;
  keys: Record<string, string>;
}

interface RootKeyring {
  source: "environment" | "file" | "memory";
  path: string | null;
  activeKeyId: string;
  keys: Map<string, Buffer>;
}

interface ProviderSecretRow {
  provider_id: string;
  envelope_version: number;
  ciphertext: string;
  cipher_iv: string;
  cipher_tag: string;
  wrapped_key: string;
  wrap_iv: string;
  wrap_tag: string;
  root_key_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface EncryptedProviderSecrets {
  envelope_version: number;
  ciphertext: string;
  cipher_iv: string;
  cipher_tag: string;
  wrapped_key: string;
  wrap_iv: string;
  wrap_tag: string;
  root_key_id: string;
  revision: number;
}

const memoryKeyrings = new WeakMap<Database, RootKeyring>();
let migrationSavepoint = 0;

export class ProviderSecretsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSecretsUnavailableError";
  }
}

function errorMessage(message: string): ProviderSecretsUnavailableError {
  return new ProviderSecretsUnavailableError(
    `${message} Provider credentials remain locked; no provider operation was attempted.`,
  );
}

function keyId(key: Buffer): string {
  return `epk_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function parseRootKey(raw: string): Buffer {
  const trimmed = raw.trim();
  let key: Buffer;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) key = Buffer.from(trimmed, "hex");
  else {
    try {
      key = Buffer.from(trimmed, "base64");
    } catch {
      throw errorMessage(`${INLINE_ROOT_KEY_ENV} is not a valid 32-byte key.`);
    }
  }
  if (key.byteLength !== 32) {
    key.fill(0);
    throw errorMessage(`${INLINE_ROOT_KEY_ENV} must decode to exactly 32 bytes.`);
  }
  return key;
}

function configuredKeyringPath(env: NodeJS.ProcessEnv): string | null {
  for (const name of ROOT_KEYRING_FILE_ENVS) {
    const value = env[name]?.trim();
    if (value) return resolve(value);
  }
  return null;
}

export function defaultProviderSecretsKeyringPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env["XDG_CONFIG_HOME"]?.trim()
    ? join(resolve(env["XDG_CONFIG_HOME"]!.trim()), "open-emails-secrets")
    : join(homedir(), ".hasna", "secrets");
  return join(base, "open-emails-provider-credentials.keyring.json");
}

function ensurePrivateDirectory(path: string): void {
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw errorMessage(`Refusing provider-secret keyring directory at ${path}: expected a real directory.`);
  }
  if (process.platform !== "win32") {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && stats.uid !== uid) {
      throw errorMessage(`Refusing provider-secret keyring directory at ${path}: it has a foreign owner.`);
    }
    if (!existed) chmodSync(path, 0o700);
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw errorMessage(`Refusing provider-secret keyring directory at ${path}: permissions must be 0700.`);
    }
  }
}

function readKeyringFile(path: string): RootKeyringFile {
  let fd: number | null = null;
  try {
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
    fd = openSync(path, flags);
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error("not a regular file");
    if (process.platform !== "win32") {
      const uid = typeof process.getuid === "function" ? process.getuid() : null;
      if (uid !== null && stats.uid !== uid) throw new Error("foreign owner");
      if ((stats.mode & 0o077) !== 0) throw new Error("permissions are not 0600");
    }
    const parsed = JSON.parse(readFileSync(fd, "utf8")) as Partial<RootKeyringFile>;
    if (parsed.version !== KEYRING_VERSION || typeof parsed.active_key_id !== "string" || !parsed.keys || typeof parsed.keys !== "object") {
      throw new Error("unsupported keyring format");
    }
    return parsed as RootKeyringFile;
  } catch {
    throw errorMessage(`Could not unlock the provider-secret keyring at ${path}.`);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function writeKeyringFile(path: string, keyring: RootKeyringFile): void {
  ensurePrivateDirectory(dirname(path));
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let fd: number | null = null;
  try {
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
    fd = openSync(temp, flags, 0o600);
    const body = `${JSON.stringify(keyring)}\n`;
    writeSync(fd, body, undefined, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (process.platform !== "win32") chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch {
    throw errorMessage(`Could not persist the provider-secret keyring at ${path}.`);
  } finally {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(temp); } catch {}
  }
}

function decodeKeyring(file: RootKeyringFile, path: string | null): RootKeyring {
  const keys = new Map<string, Buffer>();
  for (const [id, encoded] of Object.entries(file.keys)) {
    const key = Buffer.from(encoded, "base64");
    if (key.byteLength !== 32 || keyId(key) !== id) {
      key.fill(0);
      throw errorMessage(`Provider-secret keyring ${path ?? "entry"} is corrupt.`);
    }
    keys.set(id, key);
  }
  if (!keys.has(file.active_key_id)) {
    throw errorMessage(`Provider-secret keyring ${path ?? "entry"} has no active root key.`);
  }
  return {
    source: "file",
    path,
    activeKeyId: file.active_key_id,
    keys,
  };
}

function encodeKeyring(keyring: RootKeyring): RootKeyringFile {
  return {
    version: KEYRING_VERSION,
    active_key_id: keyring.activeKeyId,
    keys: Object.fromEntries([...keyring.keys].map(([id, key]) => [id, key.toString("base64")])),
  };
}

function createFileKeyring(path: string): RootKeyring {
  const key = randomBytes(32);
  const id = keyId(key);
  const keyring: RootKeyring = {
    source: "file",
    path,
    activeKeyId: id,
    keys: new Map([[id, key]]),
  };
  writeKeyringFile(path, encodeKeyring(keyring));
  return keyring;
}

function rootKeyring(db: Database, create: boolean, env: NodeJS.ProcessEnv = process.env): RootKeyring {
  const inline = env[INLINE_ROOT_KEY_ENV]?.trim();
  if (inline) {
    const key = parseRootKey(inline);
    const id = keyId(key);
    return { source: "environment", path: null, activeKeyId: id, keys: new Map([[id, key]]) };
  }

  const dbPath = databasePathFor(db);
  if (dbPath === ":memory:" || dbPath === null) {
    const existing = memoryKeyrings.get(db);
    if (existing) return existing;
    if (!create) throw errorMessage("The ephemeral provider-secret keyring is unavailable.");
    const key = randomBytes(32);
    const id = keyId(key);
    const created: RootKeyring = { source: "memory", path: null, activeKeyId: id, keys: new Map([[id, key]]) };
    memoryKeyrings.set(db, created);
    return created;
  }

  const path = configuredKeyringPath(env) ?? defaultProviderSecretsKeyringPath(env);
  if (!existsSync(path)) {
    if (!create) {
      throw errorMessage(
        `Provider-secret root keys are unavailable. Rebind the restored database with ${ROOT_KEYRING_FILE_ENVS[0]} or ${INLINE_ROOT_KEY_ENV}.`,
      );
    }
    return createFileKeyring(path);
  }
  return decodeKeyring(readKeyringFile(path), path);
}

function aad(providerId: string, revision: number, purpose: "payload" | "dek"): Buffer {
  return Buffer.from(`open-emails/provider-secrets/v${ENVELOPE_VERSION}/${providerId}/${revision}/${purpose}`, "utf8");
}

function encryptAesGcm(plaintext: Buffer, key: Buffer, associatedData: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decryptAesGcm(ciphertext: Buffer, key: Buffer, iv: Buffer, tag: Buffer, associatedData: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(associatedData);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function normalizeSecrets(input: Partial<ProviderSecrets>): ProviderSecrets {
  const normalized = { ...EMPTY_PROVIDER_SECRETS };
  for (const field of PROVIDER_SECRET_FIELDS) {
    const value = input[field];
    normalized[field] = typeof value === "string" && value.length > 0 ? value : null;
  }
  return normalized;
}

function hasSecrets(secrets: ProviderSecrets): boolean {
  return PROVIDER_SECRET_FIELDS.some((field) => secrets[field] !== null);
}

function encryptSecrets(providerId: string, secrets: ProviderSecrets, revision: number, keyring: RootKeyring): EncryptedProviderSecrets {
  const rootKey = keyring.keys.get(keyring.activeKeyId);
  if (!rootKey) throw errorMessage("The active provider-secret root key is unavailable.");
  const dataKey = randomBytes(32);
  const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
  try {
    const payload = encryptAesGcm(plaintext, dataKey, aad(providerId, revision, "payload"));
    const wrapped = encryptAesGcm(dataKey, rootKey, aad(providerId, revision, "dek"));
    return {
      envelope_version: ENVELOPE_VERSION,
      ciphertext: payload.ciphertext.toString("base64"),
      cipher_iv: payload.iv.toString("base64"),
      cipher_tag: payload.tag.toString("base64"),
      wrapped_key: wrapped.ciphertext.toString("base64"),
      wrap_iv: wrapped.iv.toString("base64"),
      wrap_tag: wrapped.tag.toString("base64"),
      root_key_id: keyring.activeKeyId,
      revision,
    };
  } finally {
    dataKey.fill(0);
    plaintext.fill(0);
  }
}

function unwrapDataKey(row: ProviderSecretRow, keyring: RootKeyring): Buffer {
  const rootKey = keyring.keys.get(row.root_key_id);
  if (!rootKey) {
    throw errorMessage(`Provider-secret root key ${row.root_key_id} is unavailable. Rebind the original keyring before recovery.`);
  }
  try {
    return decryptAesGcm(
      Buffer.from(row.wrapped_key, "base64"),
      rootKey,
      Buffer.from(row.wrap_iv, "base64"),
      Buffer.from(row.wrap_tag, "base64"),
      aad(row.provider_id, row.revision, "dek"),
    );
  } catch {
    throw errorMessage(`Provider credentials for ${row.provider_id} could not be unwrapped.`);
  }
}

function decryptSecrets(row: ProviderSecretRow, keyring: RootKeyring): ProviderSecrets {
  if (row.envelope_version !== ENVELOPE_VERSION) {
    throw errorMessage(`Provider credentials for ${row.provider_id} use an unsupported envelope version.`);
  }
  const dataKey = unwrapDataKey(row, keyring);
  let plaintext: Buffer | null = null;
  try {
    plaintext = decryptAesGcm(
      Buffer.from(row.ciphertext, "base64"),
      dataKey,
      Buffer.from(row.cipher_iv, "base64"),
      Buffer.from(row.cipher_tag, "base64"),
      aad(row.provider_id, row.revision, "payload"),
    );
    const parsed = JSON.parse(plaintext.toString("utf8")) as Partial<ProviderSecrets>;
    return normalizeSecrets(parsed);
  } catch {
    throw errorMessage(`Provider credentials for ${row.provider_id} could not be decrypted.`);
  } finally {
    dataKey.fill(0);
    plaintext?.fill(0);
  }
}

export function ensureProviderSecretsSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_secrets (
      provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
      envelope_version INTEGER NOT NULL,
      ciphertext TEXT NOT NULL,
      cipher_iv TEXT NOT NULL,
      cipher_tag TEXT NOT NULL,
      wrapped_key TEXT NOT NULL,
      wrap_iv TEXT NOT NULL,
      wrap_tag TEXT NOT NULL,
      root_key_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_provider_secrets_root_key ON provider_secrets(root_key_id);
  `);
}

function secretRow(providerId: string, db: Database): ProviderSecretRow | null {
  return db.query("SELECT * FROM provider_secrets WHERE provider_id = ?").get(providerId) as ProviderSecretRow | null;
}

function putEncrypted(providerId: string, encrypted: EncryptedProviderSecrets, db: Database, timestamp: string): void {
  db.run(
    `INSERT INTO provider_secrets (
       provider_id, envelope_version, ciphertext, cipher_iv, cipher_tag,
       wrapped_key, wrap_iv, wrap_tag, root_key_id, revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id) DO UPDATE SET
       envelope_version = excluded.envelope_version,
       ciphertext = excluded.ciphertext,
       cipher_iv = excluded.cipher_iv,
       cipher_tag = excluded.cipher_tag,
       wrapped_key = excluded.wrapped_key,
       wrap_iv = excluded.wrap_iv,
       wrap_tag = excluded.wrap_tag,
       root_key_id = excluded.root_key_id,
       revision = excluded.revision,
       updated_at = excluded.updated_at`,
    [
      providerId,
      encrypted.envelope_version,
      encrypted.ciphertext,
      encrypted.cipher_iv,
      encrypted.cipher_tag,
      encrypted.wrapped_key,
      encrypted.wrap_iv,
      encrypted.wrap_tag,
      encrypted.root_key_id,
      encrypted.revision,
      timestamp,
      timestamp,
    ],
  );
}

export function getProviderSecrets(providerId: string, db: Database): ProviderSecrets {
  ensureProviderSecretsSchema(db);
  const row = secretRow(providerId, db);
  if (!row) return { ...EMPTY_PROVIDER_SECRETS };
  return decryptSecrets(row, rootKeyring(db, false));
}

export function storeProviderSecrets(providerId: string, input: Partial<ProviderSecrets>, db: Database): void {
  ensureProviderSecretsSchema(db);
  const normalized = normalizeSecrets(input);
  if (!hasSecrets(normalized)) {
    db.run("DELETE FROM provider_secrets WHERE provider_id = ?", [providerId]);
    return;
  }
  const previous = secretRow(providerId, db);
  const revision = (previous?.revision ?? 0) + 1;
  const encrypted = encryptSecrets(providerId, normalized, revision, rootKeyring(db, true));
  putEncrypted(providerId, encrypted, db, new Date().toISOString());
}

export function updateProviderSecrets(providerId: string, updates: Partial<ProviderSecrets>, db: Database): void {
  const current = getProviderSecrets(providerId, db);
  for (const field of PROVIDER_SECRET_FIELDS) {
    if (updates[field] !== undefined) current[field] = updates[field] || null;
  }
  storeProviderSecrets(providerId, current, db);
}

function legacyRows(db: Database): Array<{ id: string } & ProviderSecrets> {
  return db.query(
    `SELECT id, ${PROVIDER_SECRET_FIELDS.join(", ")}
       FROM providers
      WHERE ${PROVIDER_SECRET_FIELDS.map((field) => `${field} IS NOT NULL AND ${field} != ''`).join(" OR ")}`,
  ).all() as Array<{ id: string } & ProviderSecrets>;
}

/**
 * Move every legacy plaintext provider credential into an encrypted envelope.
 * The envelope write, plaintext clearing and migration sentinel share one
 * savepoint, including when database.ts has to run migrations unbatched.
 */
export function migratePlaintextProviderSecrets(db: Database): number {
  ensureProviderSecretsSchema(db);
  const savepoint = `provider_secret_migration_${++migrationSavepoint}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  let migrated = 0;
  try {
    const rows = legacyRows(db);
    const keyring = rows.length > 0 ? rootKeyring(db, true) : null;
    for (const row of rows) {
      const secrets = normalizeSecrets(row);
      const existing = secretRow(row.id, db);
      // A previously completed encrypted write always wins over leftover
      // plaintext from an interrupted pre-release build; never roll it back to
      // an older credential generation.
      if (!existing) {
        const encrypted = encryptSecrets(row.id, secrets, 1, keyring!);
        putEncrypted(row.id, encrypted, db, new Date().toISOString());
      }
      db.run(
        `UPDATE providers SET ${PROVIDER_SECRET_FIELDS.map((field) => `${field} = NULL`).join(", ")} WHERE id = ?`,
        [row.id],
      );
      migrated += 1;
    }
    db.run("INSERT OR IGNORE INTO _migrations (id) VALUES (49)");
    db.exec(`RELEASE ${savepoint}`);
    return migrated;
  } catch (error) {
    try { db.exec(`ROLLBACK TO ${savepoint}`); } finally { db.exec(`RELEASE ${savepoint}`); }
    throw error;
  }
}

export function assertProviderSecretRootKeysAvailable(db: Database): void {
  ensureProviderSecretsSchema(db);
  const ids = (db.query("SELECT DISTINCT root_key_id FROM provider_secrets").all() as Array<{ root_key_id: string }>)
    .map((row) => row.root_key_id);
  if (ids.length === 0) return;
  const keyring = rootKeyring(db, false);
  for (const id of ids) {
    if (!keyring.keys.has(id)) {
      throw errorMessage(`Provider-secret root key ${id} is unavailable. Rebind the original keyring before startup.`);
    }
  }
}

function rewrapRows(db: Database, keyring: RootKeyring): number {
  const active = keyring.keys.get(keyring.activeKeyId);
  if (!active) throw errorMessage("The active provider-secret root key is unavailable.");
  const rows = db.query("SELECT * FROM provider_secrets WHERE root_key_id != ?").all(keyring.activeKeyId) as ProviderSecretRow[];
  const savepoint = `provider_secret_rewrap_${++migrationSavepoint}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    for (const row of rows) {
      const dataKey = unwrapDataKey(row, keyring);
      try {
        const wrapped = encryptAesGcm(dataKey, active, aad(row.provider_id, row.revision, "dek"));
        db.run(
          `UPDATE provider_secrets
              SET wrapped_key = ?, wrap_iv = ?, wrap_tag = ?, root_key_id = ?, updated_at = ?
            WHERE provider_id = ? AND revision = ?`,
          [
            wrapped.ciphertext.toString("base64"),
            wrapped.iv.toString("base64"),
            wrapped.tag.toString("base64"),
            keyring.activeKeyId,
            new Date().toISOString(),
            row.provider_id,
            row.revision,
          ],
        );
      } finally {
        dataKey.fill(0);
      }
    }
    db.exec(`RELEASE ${savepoint}`);
    return rows.length;
  } catch (error) {
    try { db.exec(`ROLLBACK TO ${savepoint}`); } finally { db.exec(`RELEASE ${savepoint}`); }
    throw error;
  }
}

export function rewrapProviderSecrets(db: Database): number {
  const keyring = rootKeyring(db, false);
  return rewrapRows(db, keyring);
}

/**
 * Stage a fresh non-database root key, rewrap every DEK, then make it active.
 * The old key remains available for in-flight work and crash recovery until an
 * explicit revoke confirms that no envelope references it.
 */
export function rotateProviderSecretsRootKey(db: Database): { previousKeyId: string; activeKeyId: string; rewrapped: number } {
  const keyring = rootKeyring(db, true);
  if (keyring.source !== "file" || !keyring.path) {
    throw errorMessage("Root-key rotation requires a file-backed keyring; an inline or ephemeral key is active.");
  }
  const previousKeyId = keyring.activeKeyId;
  const next = randomBytes(32);
  const activeKeyId = keyId(next);
  keyring.keys.set(activeKeyId, next);

  // Stage first. A crash here leaves an unused recovery key, not an unreadable DB.
  writeKeyringFile(keyring.path, encodeKeyring(keyring));
  keyring.activeKeyId = activeKeyId;
  const rewrapped = rewrapRows(db, keyring);
  writeKeyringFile(keyring.path, encodeKeyring(keyring));
  return { previousKeyId, activeKeyId, rewrapped };
}

export function revokeProviderSecretsRootKey(key: string, db: Database): void {
  const keyring = rootKeyring(db, false);
  if (keyring.source !== "file" || !keyring.path) {
    throw errorMessage("Root-key revocation requires a file-backed keyring.");
  }
  if (key === keyring.activeKeyId) throw errorMessage("The active provider-secret root key cannot be revoked.");
  const referenced = db.query("SELECT 1 AS present FROM provider_secrets WHERE root_key_id = ? LIMIT 1").get(key);
  if (referenced) throw errorMessage(`Provider-secret root key ${key} is still referenced; rewrap before revocation.`);
  if (!keyring.keys.delete(key)) throw errorMessage(`Provider-secret root key ${key} does not exist.`);
  writeKeyringFile(keyring.path, encodeKeyring(keyring));
}

export function providerSecretsKeyStatus(db: Database): {
  source: RootKeyring["source"] | "uninitialized";
  activeKeyId: string | null;
  availableKeyIds: string[];
  referencedKeyIds: string[];
} {
  ensureProviderSecretsSchema(db);
  const referencedKeyIds = (db.query("SELECT DISTINCT root_key_id FROM provider_secrets ORDER BY root_key_id").all() as Array<{ root_key_id: string }>)
    .map((row) => row.root_key_id);
  if (referencedKeyIds.length === 0) {
    try {
      const keyring = rootKeyring(db, false);
      return { source: keyring.source, activeKeyId: keyring.activeKeyId, availableKeyIds: [...keyring.keys.keys()].sort(), referencedKeyIds };
    } catch {
      return { source: "uninitialized", activeKeyId: null, availableKeyIds: [], referencedKeyIds };
    }
  }
  const keyring = rootKeyring(db, false);
  return {
    source: keyring.source,
    activeKeyId: keyring.activeKeyId,
    availableKeyIds: [...keyring.keys.keys()].sort(),
    referencedKeyIds,
  };
}
