/**
 * S3 inbox sync — SELF-HOSTED CLIENT.
 *
 * Historically this module polled an S3 bucket for raw SES-stored emails and
 * ingested them into the local `inbound_emails` SQLite table. In the self-hosted
 * client there is NO local inbound store: the operator's server owns the
 * SES → S3 → mailbox ingestion pipeline. `syncS3Inbox` is therefore a fail-loud
 * stub. The S3 *source registry* (list/register/retire) is pure client config
 * (a `mail_sources` array in the local config file) with no database dependency,
 * so those functions remain fully functional — other modules import
 * `listS3Sources`/`listLiveS3Sources` to describe configured ingestion sources.
 */

import { loadConfig, saveConfig } from "./config.js";

const MAIL_SOURCES_CONFIG_KEY = "mail_sources";

export type MailSourceStatus = "live" | "import" | "legacy" | "retired";

export interface S3SyncOptions {
  bucket?: string;
  prefix?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  providerId?: string;
  sourceId?: string;
  forceSource?: boolean;
  /** Exact S3 object keys to process without listing the whole prefix. */
  keys?: string[];
  /** Max objects to process per run */
  limit?: number;
}

export interface S3SyncResult {
  synced: number;
  skipped: number;
  attachments_saved: number;
  errors: string[];
  last_key?: string;
}

type RawMailSource = Record<string, unknown>;

export interface S3MailSource {
  id: string;
  type: "s3";
  name?: string;
  bucket: string;
  prefix?: string;
  region: string;
  provider_id?: string;
  status: MailSourceStatus;
  live_sync_enabled: boolean;
  created_at?: string;
  updated_at?: string;
  retired_at?: string | null;
}

export interface RegisterS3SourceInput {
  id?: string;
  bucket: string;
  prefix?: string;
  region?: string;
  providerId?: string;
  name?: string;
  status?: MailSourceStatus;
  liveSyncEnabled?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePrefix(prefix: string | null | undefined): string | undefined {
  const value = String(prefix ?? "").trim();
  return value.length > 0 ? value : undefined;
}

function normalizeStatus(status: unknown): MailSourceStatus {
  return status === "live" || status === "import" || status === "legacy" || status === "retired"
    ? status
    : "legacy";
}

function sourceId(type: "s3", bucket: string, prefix?: string): string {
  const suffix = [bucket, prefix]
    .map((part) => String(part ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-"))
    .filter(Boolean)
    .join("-");
  return `${type}-${suffix || "source"}`;
}

function readConfiguredSources(): RawMailSource[] {
  const raw = loadConfig()[MAIL_SOURCES_CONFIG_KEY];
  return Array.isArray(raw)
    ? raw.filter((item): item is RawMailSource => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function writeConfiguredSources(sources: RawMailSource[]): void {
  const config = loadConfig();
  config[MAIL_SOURCES_CONFIG_KEY] = sources;
  saveConfig(config);
}

function parseConfiguredS3Source(raw: RawMailSource): S3MailSource | null {
  if (raw["type"] !== "s3") return null;
  const bucket = typeof raw["bucket"] === "string" ? raw["bucket"].trim() : "";
  if (!bucket) return null;
  const status = normalizeStatus(raw["status"]);
  const region = typeof raw["region"] === "string" && raw["region"].trim() ? raw["region"].trim() : "us-east-1";
  const prefix = normalizePrefix(raw["prefix"] as string | undefined);
  return {
    id: typeof raw["id"] === "string" && raw["id"].trim() ? raw["id"].trim() : sourceId("s3", bucket, prefix),
    type: "s3",
    bucket,
    prefix,
    region,
    provider_id: typeof raw["provider_id"] === "string" ? raw["provider_id"] : undefined,
    name: typeof raw["name"] === "string" ? raw["name"] : undefined,
    status,
    live_sync_enabled: raw["live_sync_enabled"] == null ? status === "live" : raw["live_sync_enabled"] === true,
    created_at: typeof raw["created_at"] === "string" ? raw["created_at"] : undefined,
    updated_at: typeof raw["updated_at"] === "string" ? raw["updated_at"] : undefined,
    retired_at: typeof raw["retired_at"] === "string" ? raw["retired_at"] : null,
  };
}

function sourceIsLive(source: S3MailSource | null | undefined): boolean {
  return !!source && source.status === "live" && source.live_sync_enabled === true;
}

function findUniqueS3Source(
  sources: S3MailSource[],
  ref: string,
  extraExactMatch?: (source: S3MailSource) => boolean,
): S3MailSource | null {
  const exact = sources.filter((source) => source.id === ref || extraExactMatch?.(source));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    throw new Error(`Ambiguous S3 source; choose one with --source. Matches: ${exact.map((source) => source.id).join(", ")}`);
  }

  const prefixMatches = sources.filter((source) => source.id.startsWith(ref));
  if (prefixMatches.length === 1) return prefixMatches[0]!;
  if (prefixMatches.length > 1) {
    throw new Error(`Ambiguous S3 source prefix "${ref}"; choose one with --source. Matches: ${prefixMatches.map((source) => source.id).join(", ")}`);
  }

  return null;
}

export function listS3Sources(): S3MailSource[] {
  return readConfiguredSources()
    .map(parseConfiguredS3Source)
    .filter((source): source is S3MailSource => !!source);
}

export function listLiveS3Sources(): S3MailSource[] {
  return listS3Sources().filter(sourceIsLive);
}

export function registerS3Source(input: RegisterS3SourceInput): S3MailSource {
  const status = input.status ?? "live";
  const timestamp = nowIso();
  const prefix = normalizePrefix(input.prefix);
  const next: S3MailSource = {
    id: input.id ?? sourceId("s3", input.bucket, prefix),
    type: "s3",
    bucket: input.bucket,
    prefix,
    region: input.region ?? process.env["AWS_REGION"] ?? "us-east-1",
    provider_id: input.providerId,
    name: input.name,
    status,
    live_sync_enabled: input.liveSyncEnabled ?? status === "live",
    created_at: timestamp,
    updated_at: timestamp,
    retired_at: status === "retired" ? timestamp : null,
  };
  const sources = readConfiguredSources();
  const rawNext: RawMailSource = { ...next };
  const index = sources.findIndex((source) =>
    source["id"] === next.id ||
    (source["type"] === "s3" &&
      source["bucket"] === input.bucket &&
      normalizePrefix(source["prefix"] as string | undefined) === prefix));
  if (index >= 0) {
    const previous = sources[index]!;
    next.created_at = typeof previous["created_at"] === "string" ? previous["created_at"] : timestamp;
    sources[index] = { ...previous, ...rawNext, created_at: next.created_at };
  } else {
    sources.push(rawNext);
  }
  writeConfiguredSources(sources);
  return next;
}

export function retireS3Source(sourceIdOrBucket: string): S3MailSource {
  const sources = readConfiguredSources();
  const parsed = sources.map(parseConfiguredS3Source);
  const target = findUniqueS3Source(
    parsed.filter((source): source is S3MailSource => !!source),
    sourceIdOrBucket,
    (source) => source.bucket === sourceIdOrBucket,
  );
  const index = target ? parsed.findIndex((source) => source?.id === target.id) : -1;
  if (index < 0 || !parsed[index]) throw new Error(`S3 source not found: ${sourceIdOrBucket}`);
  const timestamp = nowIso();
  const retired = {
    ...sources[index]!,
    status: "retired",
    live_sync_enabled: false,
    retired_at: timestamp,
    updated_at: timestamp,
  };
  sources[index] = retired;
  writeConfiguredSources(sources);
  return parseConfiguredS3Source(retired)!;
}

/**
 * S3 → mailbox ingestion. In the self-hosted client this runs on the operator's
 * server (SES receipt rule → S3 → server ingestion → mailbox). The thin client
 * has no local `inbound_emails` store to write into, so this fails loud while
 * preserving its signature/return type.
 */
export async function syncS3Inbox(_opts: S3SyncOptions): Promise<S3SyncResult> {
  throw new Error(
    "syncS3Inbox is not available in the self-hosted client; S3 inbound ingestion runs on the self-hosted server.",
  );
}
