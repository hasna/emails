import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { resolveCloudflareAuth, type CloudflareAuth } from "./cloudflare-auth.js";
import { getEmailsMode } from "./mode.js";
import { isSensitiveKey } from "./redaction.js";

/**
 * This machine's emails data directory, resolved WITHOUT opening (or hardening)
 * the SQLite database.
 *
 * Both local and self-hosted client paths share the config/credentials file that
 * lives here (Cloudflare/SES tokens, inbound bucket + mail-source registry, and
 * provider defaults), and so do the on-disk logs the CLI tails. `getDataDir()`
 * in src/db/database.ts resolves the same directory but additionally enforces
 * SQLite parent-directory ownership/mode rules and creates it — correct before a
 * database open, wrong for a read that never touches one.
 */
export function getEmailsDataDir(): string {
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  return join(home, ".hasna", "emails");
}
function getConfigDir(): string { return getEmailsDataDir(); }
function getConfigPath(): string { return join(getConfigDir(), "config.json"); }
const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;

export interface EmailsConfig {
  default_provider?: string;
  [key: string]: unknown;
}

export const CANONICAL_OPEN_EMAILS_S3_BUCKET: string | null = null;
export const CANONICAL_OPEN_EMAILS_S3_REGION = "us-east-1";
export const CANONICAL_OPEN_EMAILS_SECRETS_BASE: string | null = null;
export const CANONICAL_OPEN_EMAILS_SECRET_PATHS = {
  env: null,
  aws: null,
  s3: null,
  rds: null,
} as const;
export const CANONICAL_OPEN_EMAILS_RDS_CLUSTER: string | null = null;
export const CANONICAL_OPEN_EMAILS_RDS_DATABASE: string | null = null;
export const CANONICAL_OPEN_EMAILS_RDS_SECRET_PATH = CANONICAL_OPEN_EMAILS_SECRET_PATHS.rds;

export interface CanonicalOpenEmailsRdsConfig {
  cluster: string | null;
  database: string | null;
  runtimePath: string | null;
  env: "HASNA_EMAILS_DATABASE_URL";
  fallbackEnv: "EMAILS_DATABASE_URL";
}

export function getCanonicalOpenEmailsRdsConfig(): CanonicalOpenEmailsRdsConfig {
  return {
    cluster: CANONICAL_OPEN_EMAILS_RDS_CLUSTER,
    database: CANONICAL_OPEN_EMAILS_RDS_DATABASE,
    runtimePath: CANONICAL_OPEN_EMAILS_RDS_SECRET_PATH,
    env: "HASNA_EMAILS_DATABASE_URL",
    fallbackEnv: "EMAILS_DATABASE_URL",
  };
}

interface ConfigCacheEntry {
  path: string;
  mtimeMs: number;
  size: number;
  config: EmailsConfig;
}

let configCache: ConfigCacheEntry | null = null;

function cloneConfig(config: EmailsConfig): EmailsConfig {
  try {
    return JSON.parse(JSON.stringify(config)) as EmailsConfig;
  } catch {
    return { ...config };
  }
}

function chmodBestEffort(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort only: config read/write should still work on filesystems that
    // do not support POSIX modes, but normal local installs get hardened.
  }
}

function ensureConfigDir(): string {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE });
  chmodBestEffort(dir, CONFIG_DIR_MODE);
  return dir;
}

function ensureConfigFileMode(path = getConfigPath()): void {
  if (existsSync(path)) chmodBestEffort(path, CONFIG_FILE_MODE);
}

export function loadConfig(): EmailsConfig {
  ensureConfigDir();
  const path = getConfigPath();
  if (!existsSync(path)) {
    if (configCache?.path === path) configCache = null;
    return {};
  }
  ensureConfigFileMode(path);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    if (configCache?.path === path) configCache = null;
    return {};
  }
  if (configCache?.path === path && configCache.mtimeMs === stats.mtimeMs && configCache.size === stats.size) {
    return cloneConfig(configCache.config);
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const config = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as EmailsConfig) : {};
    configCache = { path, mtimeMs: stats.mtimeMs, size: stats.size, config: cloneConfig(config) };
    return cloneConfig(config);
  } catch {
    configCache = { path, mtimeMs: stats.mtimeMs, size: stats.size, config: {} };
    return {};
  }
}

export function saveConfig(config: EmailsConfig): void {
  ensureConfigDir();
  const path = getConfigPath();
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: CONFIG_FILE_MODE });
  ensureConfigFileMode(path);
  const stats = statSync(path);
  configCache = { path, mtimeMs: stats.mtimeMs, size: stats.size, config: cloneConfig(config) };
}

export function getConfigValue(key: string): unknown {
  return loadConfig()[key];
}

export function setConfigValue(key: string, value: unknown): void {
  const config = loadConfig();
  config[key] = value;
  saveConfig(config);
}

// ─── Agent-writable config allowlist ──────────────────────────────────────────

/**
 * The ONLY config keys an untrusted agent surface (the MCP `set_config` tool)
 * may write.
 *
 * `setConfigValue` itself stays unrestricted: it is the operator/library path,
 * and the whole config file is deliberately writable by whoever owns the
 * machine. The gate belongs at the agent boundary, because that surface is
 * driven by model output. Without it, `set_config`'s bare `key: z.string()`
 * accepted anything in the file, and `saveConfig` re-seeds the in-process cache
 * so a write took effect immediately — most sharply for `emails_mode`, which
 * decides whether the process talks to local SQLite or the operator's
 * self-hosted API, mid-session.
 *
 * Deliberately EXCLUDED, and why:
 *   - `emails_mode` (+ the `mode`/`storage_mode`/`mailery_mode` migration
 *     trip-wires in lib/mode.ts): switches the datastore the process reads and
 *     writes. Mode is an operator decision, made once, out of band.
 *   - every credential/secret key (`cloudflare_api_token`, `cloudflare_api_key`,
 *     `resend_api_key`, the `*_webhook_secret` keys, …): an agent that can write
 *     a credential can point an integration at infrastructure it controls. Also
 *     enforced structurally below via `isSensitiveKey`.
 *   - `inbound_s3_buckets`: a structured list owned by `addInboundBucket`, which
 *     merges and de-duplicates entries. A raw overwrite corrupts it.
 *   - `inbound_realtime_*`: daemon runtime state, not operator configuration.
 *   - the S3 and AWS WIRING keys — `attachment_storage`, `attachment_s3_*`,
 *     `inbound_s3_bucket`/`_prefix`/`_region`/`_profile`, `ses_aws_profile`.
 *     These name where mail and attachments come FROM and go TO, so they are
 *     data-flow decisions an operator makes at provisioning time, not settings:
 *       * `attachment_storage: "s3"` + `attachment_s3_bucket` makes the next
 *         inbound sync PUT every attachment into a caller-named bucket under the
 *         operator's ambient AWS credentials — an exfiltration sink.
 *       * `inbound_s3_bucket` is folded into the list the background pullers walk
 *         (`getInboundBuckets`), so one write makes the TUI auto-pull loop and the
 *         operator's own `inbox sync-s3` ingest forged mail from a caller-named
 *         bucket indefinitely, with no further tool call to notice.
 *       * `attachment_storage: "none"` silently discards every inbound
 *         attachment — agent-triggered data loss.
 *     The equivalent one-shot operations remain available as explicit, logged
 *     tool calls (`sync_s3_inbox` takes its own bucket/prefix/region), which is
 *     the auditable shape; what is refused is making them the durable default.
 *   - `cloudflare_account_id`: inert without a token, but it is DNS wiring by the
 *     same rule.
 *
 * What remains is genuinely "settings": two alert thresholds, and two
 * provider-selection keys that can only name provider rows that already exist
 * (MCP's own `add_provider`/`update_provider` are the tools that create those,
 * and they are unaffected by this allowlist).
 */
export const AGENT_WRITABLE_CONFIG_KEYS = [
  "bounce-alert-threshold",
  "complaint-alert-threshold",
  "default_provider",
  "failover-providers",
] as const;

export type AgentWritableConfigKey = (typeof AGENT_WRITABLE_CONFIG_KEYS)[number];

const AGENT_WRITABLE_CONFIG_KEY_SET: ReadonlySet<string> = new Set(AGENT_WRITABLE_CONFIG_KEYS);

/**
 * Whether an agent surface may write `key`. Exact match on the trimmed name — a
 * near-miss spelling would write a key nothing reads while still mutating the
 * operator's config file, so it is refused too. `isSensitiveKey` is applied on
 * top so a credential key can never become writable by being added to the list
 * above.
 */
export function isAgentWritableConfigKey(key: string): boolean {
  const normalized = key.trim();
  if (!AGENT_WRITABLE_CONFIG_KEY_SET.has(normalized)) return false;
  return !isSensitiveKey(normalized);
}

/** Refusal message naming what IS permitted, so the caller can self-correct. */
export function agentConfigKeyRefusal(key: string): string {
  return `Config key "${key}" is not writable through this tool. Permitted keys: `
    + `${[...AGENT_WRITABLE_CONFIG_KEYS].join(", ")}. `
    + `Mode selection (emails_mode), credential keys, and the S3/AWS data-flow keys `
    + `are excluded on purpose. An operator sets those out of band — via the `
    + `EMAILS_* environment variables, or by editing ~/.hasna/emails/config.json `
    + `directly (this build registers no "emails config" command).`;
}

/**
 * Per-key value validation.
 *
 * An allowlisted KEY with an arbitrary VALUE is still a way to break the
 * install: the tool takes `value: z.string()`, JSON-parses it, and writes
 * whatever falls out. `failover-providers` is `String()`-split by
 * `getFailoverProviderIds`, so a JSON object there becomes garbage provider ids
 * that only fail later, at send time.
 */
function validateAgentConfigValue(key: AgentWritableConfigKey, value: unknown): string | null {
  switch (key) {
    case "bounce-alert-threshold":
    case "complaint-alert-threshold": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) && n >= 0
        ? null
        : `${key} must be a non-negative number.`;
    }
    case "default_provider":
      return typeof value === "string" && value.trim() !== ""
        ? null
        : `${key} must be a non-empty provider id.`;
    case "failover-providers": {
      // Stored as the comma-separated string `getFailoverProviderIds` splits.
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "")) return null;
      return typeof value === "string" && value.trim() !== ""
        ? null
        : `${key} must be a comma-separated list of provider ids.`;
    }
  }
}

/**
 * Write a config value on behalf of an agent surface. Throws on any key outside
 * the allowlist, or any value the key cannot hold, instead of writing it.
 */
export function setAgentConfigValue(key: string, value: unknown): void {
  if (!isAgentWritableConfigKey(key)) throw new Error(agentConfigKeyRefusal(key));
  const normalized = key.trim() as AgentWritableConfigKey;
  const invalid = validateAgentConfigValue(normalized, value);
  if (invalid) throw new Error(invalid);
  setConfigValue(normalized, Array.isArray(value) ? value.join(",") : value);
}

export function getDefaultProviderId(): string | undefined {
  return loadConfig().default_provider as string | undefined;
}

export function getFailoverProviderIds(): string[] {
  const val = loadConfig()["failover-providers"];
  if (!val) return [];
  return String(val).split(",").map(s => s.trim()).filter(Boolean);
}

// ─── Inbound Attachment Config ────────────────────────────────────────────────

export type AttachmentStorage = "local" | "s3" | "none";

export interface InboundAttachmentStorageConfig {
  /** Where to store attachment files: local fs, S3, or skip. Default: "local" */
  attachment_storage: AttachmentStorage;
  /** S3 bucket name (required when attachment_storage = "s3") */
  s3_bucket?: string;
  /** S3 key prefix (default: "emails") */
  s3_prefix?: string;
  /** S3 region (default: us-east-1) */
  s3_region?: string;
}

/**
 * Default inbound mailbox store (SES receipt rules -> S3). Resolved from config,
 * env, then a local default. Production operators should configure this
 * explicitly for their own AWS account.
 */
export function getInboundConfig(): { bucket?: string; region: string; prefix?: string; profile?: string } {
  const config = loadConfig();
  return {
    bucket: (config["inbound_s3_bucket"] as string | undefined) ?? process.env["EMAILS_INBOUND_S3_BUCKET"],
    region: (config["inbound_s3_region"] as string | undefined) ?? process.env["AWS_REGION"] ?? "us-east-1",
    prefix: config["inbound_s3_prefix"] as string | undefined,
    profile: getSesProfile(),
  };
}

/** An inbound S3 bucket + the SES provider whose creds reach it (buckets can be
 *  in different AWS accounts, so each carries its own provider). */
export interface InboundBucket { bucket: string; region: string; providerId?: string }

/**
 * All inbound S3 buckets to sync — domains can span multiple AWS accounts (one
 * bucket each), so the watcher/auto-pull iterates every one. Includes the legacy
 * single `inbound_s3_bucket` for back-compat, de-duplicated (list entries, which
 * carry a providerId, win over the legacy single).
 */
export function getInboundBuckets(): InboundBucket[] {
  const config = loadConfig();
  const list = Array.isArray(config["inbound_s3_buckets"]) ? config["inbound_s3_buckets"] as InboundBucket[] : [];
  const single = config["inbound_s3_bucket"] as string | undefined;
  const region = (config["inbound_s3_region"] as string | undefined) ?? process.env["AWS_REGION"] ?? "us-east-1";
  const all = [...list];
  if (single && !all.some((b) => b.bucket === single)) all.push({ bucket: single, region });
  const seen = new Set<string>();
  return all.filter((b) => b.bucket && !seen.has(b.bucket) && seen.add(b.bucket));
}

/** Register an inbound bucket so it's included in syncs (idempotent; fills in
 *  the providerId if a prior entry lacked one). */
export function addInboundBucket(bucket: string, region: string, providerId?: string): void {
  const config = loadConfig();
  const list = Array.isArray(config["inbound_s3_buckets"]) ? config["inbound_s3_buckets"] as InboundBucket[] : [];
  const existing = list.find((b) => b.bucket === bucket);
  if (existing) { existing.region = region; if (providerId) existing.providerId = providerId; }
  else list.push({ bucket, region, providerId });
  config["inbound_s3_buckets"] = list;
  saveConfig(config);
}

/**
 * AWS profile to use for SES + inbound S3 operations so the operator does not
 * pass --profile every time.
 */
function getSesProfile(): string | undefined {
  const config = loadConfig();
  return (config["ses_aws_profile"] as string | undefined)
    ?? (config["inbound_s3_profile"] as string | undefined)
    ?? process.env["EMAILS_SES_AWS_PROFILE"]
    ?? undefined;
}

export function getCloudflareToken(): string | undefined {
  const fromConfig = loadConfig()["cloudflare_api_token"] as string | undefined;
  return fromConfig || process.env["CLOUDFLARE_API_TOKEN"] || undefined;
}

/**
 * Resolve Cloudflare auth (scoped token OR global key + email) from the emails
 * config file or standard env vars. Returns
 * undefined when nothing is configured.
 */
export function getCloudflareAuth(): CloudflareAuth | undefined {
  const config = loadConfig();
  return resolveCloudflareAuth({
    configToken: config["cloudflare_api_token"] as string | undefined,
    configApiKey: config["cloudflare_api_key"] as string | undefined,
    configEmail: config["cloudflare_email"] as string | undefined,
  });
}

export function getInboundAttachmentStorageConfig(): InboundAttachmentStorageConfig {
  const config = loadConfig();
  const configuredStorage = config["attachment_storage"] as AttachmentStorage | undefined;
  const configuredBucket = config["attachment_s3_bucket"] as string | undefined;
  const inboundBucket = (config["inbound_s3_bucket"] as string | undefined)
    ?? process.env["EMAILS_INBOUND_S3_BUCKET"];
  // Mode-based (no self_hosted/remote/hybrid or *_DATABASE_URL env heuristic).
  //   local  -> attachments live on the local filesystem by default.
  //   self_hosted -> the server owns attachments; the thin client never keeps them on the
  //             local filesystem — it uses S3 when a bucket is configured, else none
  //             (an explicit "local"/"s3" is coerced to that safe pair).
  const selfHosted = getEmailsMode() === "self_hosted";
  const selfHostedStorage: AttachmentStorage = configuredBucket || inboundBucket ? "s3" : "none";
  const effectiveStorage = selfHosted
    ? (configuredStorage === "local" || configuredStorage === "s3" ? selfHostedStorage : configuredStorage)
    : configuredStorage;
  return {
    attachment_storage: effectiveStorage ?? (selfHosted ? selfHostedStorage : "local"),
    s3_bucket: configuredBucket ?? (selfHosted ? inboundBucket : undefined),
    s3_prefix: (config["attachment_s3_prefix"] as string | undefined)
      ?? "emails",
    s3_region: (config["attachment_s3_region"] as string | undefined)
      ?? "us-east-1",
  };
}
