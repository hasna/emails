// ONE S3 inbox sync. There is no arm to pick, and nothing here reads a deployment word.
//
// WHAT THIS FILE USED TO BE. `s3-sync.ts` was a 20-line facade that built a dispatch helper,
// read the process-wide deployment word, and handed each of five exports to one of two
// siblings:
//
//   * `s3-sync.local.ts` (767 lines) — the full SES → S3 → `inbound_emails` pipeline, plus
//     the S3 source registry;
//   * `s3-sync.remote.ts` (233 lines) — the SAME source registry, copied, and a `syncS3Inbox`
//     that threw.
//
// Both arms are gone. What replaces them is shaped by one measurement that the fan-in count
// does not show: FOUR OF THE FIVE EXPORTS NEVER TOUCHED A DATABASE AT ALL, and the two arms'
// implementations of them were character-for-character identical.
//
// ─── THE FIRST THING A READER MUST KNOW: FOUR EXPORTS ARE CONFIG, NOT STORAGE ──────────
//
// `listS3Sources`, `listLiveS3Sources`, `registerS3Source` and `retireS3Source` read and write
// a `mail_sources` array in the local CONFIG FILE (`loadConfig`/`saveConfig`). No SQL, no
// HTTP, no store, in either deleted arm. So they are NOT migrated onto the store seam and
// they do NOT become asynchronous:
//
//   * INVENTING A SEAM CALL FOR THEM WOULD BE A FABRICATION. The seam has no mail-source
//     repository, because a mail source is not a row this product stores anywhere — it is
//     operator configuration, like a bucket name.
//   * MAKING THEM `async` WOULD BE A BREAK WITH NOTHING BEHIND IT. Every one of their call
//     sites uses the value synchronously (`.map`, `.filter`, `.length`, a spread), so
//     widening the return to a Promise would force an `await` at each one to buy nothing —
//     and a forgotten one would read a truthy Promise as a populated source list, which is
//     the exact failure class this programme exists to remove. A signature is widened when
//     the work behind it became asynchronous. Theirs did not.
//
// `syncS3Inbox` was ALREADY `async` in BOTH deleted arms, so it does not change shape either.
// The net effect is that NO CONSUMER SIGNATURE CHANGES in this collapse. That is a measured
// property of this family and not a general rule for the programme.
//
// ─── THE DEFECT THIS COLLAPSE HAD TO FIX BEFORE IT COULD BE CORRECT ───────────────────
//
// THE DEDUP FENCE MOVES, AND MOVING IT NAIVELY WOULD HAVE DUPLICATED EVERY MESSAGE ALREADY
// INGESTED. The deleted local arm deduplicated by SELECTing `raw_s3_url` — a column the seam
// does not expose and deliberately never will (`src/store-sqlite/index.ts` declares
// `rawMessage` false precisely because `raw_s3_url` names an object the store cannot read).
// The seam's fence is `upsertMessage`'s `source_id`, which is a NEWLY ADDED, NULLABLE column
// (`src/db/database.ts`, `ensureSchema`) with no backfill. Every object synced before this
// change therefore has `raw_s3_url` set and `source_id` NULL — so a fence keyed on `source_id`
// would have matched NOTHING and re-inserted the whole mailbox as duplicates on the next
// `emails inbox pull-s3`. The backfill that closes it lives next to the column it fills
// (`ensureSchema`, `backfillS3SourceIdsFromRawUrls`), runs on every database open, is
// idempotent, and is dedup-safe against the partial unique index. The API-configured store
// needs no equivalent: the deleted remote arm THREW, so no installation has ever ingested an
// S3 object through it and there are no rows there to fence against.
//
// ─── WHAT IS A STORE OPERATION HERE, AND WHAT IS NOT ──────────────────────────────────
//
// Sorted deliberately, because the interesting half of this migration is the second list.
//
// STORE OPERATIONS, now one seam call each:
//   * dedup + insert, previously a `SELECT raw_s3_url … IN (…)` followed by an INSERT, is now
//     ONE `upsertMessage` fenced on `source_id`. This is strictly stronger than what it
//     replaces: the read-and-then-write was racy (two concurrent syncs of one bucket both saw
//     "absent" and both inserted), and `inserted` is now the STORE'S answer to
//     synced-vs-skipped rather than a guess made from a prior read.
//   * provider validation, previously `resolvePartialId(db, "providers", …)`, is now a
//     `providers.get` fast path with a bounded, page-by-page `providers.list` fallback for an
//     abbreviated id.
//
// NOT STORE OPERATIONS, and they stay exactly where they were:
//   * listing and downloading S3 objects, and parsing RFC 2822 (`@aws-sdk/client-s3`,
//     `mailparser`). A bucket is not a store.
//   * writing attachment PAYLOAD BYTES to the local filesystem or to an S3 bucket. Bytes on a
//     disk are a filesystem concern; `attachmentContent` is declared FALSE by the SQLite store
//     for exactly this reason — it has never held payload bytes.
//   * the `mail_sources` registry and the last-synced-key note, both config file.
//
// NO SEAM OPERATION EXISTS — stated, not worked around. Each is a widening this PR describes
// and deliberately does not make.
//
// WHERE EACH ONE IS REPORTED, and the split is deliberate. The FIRST is a fact about what THIS
// CALLER asked for, so it travels per run in `S3SyncResult.unrecorded` and every user-facing
// formatter prints it. The other two are true of every ingest on every installation until the
// seam widens — a static property of the product, not per-run news — so they are recorded HERE
// and nowhere else. An earlier version put all three in the per-run channel; adversarial review
// then found four of six consumers dropping the field, and the honest reading of that was that a
// constant does not belong in a per-run channel, not that the constant needed plumbing six ways.
//   * PROVIDER PROVENANCE. `inbound_emails.provider_id` is a real column with its own index,
//     and NO seam shape has a provider field — not `MessageInput`, not `MessageRecord`, not
//     `MessageStatusPatch`. So `--provider` is still VALIDATED (an unknown id still refuses,
//     exactly as before) and then cannot be recorded. The deleted arm's `tagExistingS3Provider`
//     back-fill of that column on already-present rows goes with it.
//   * THREAD LINKAGE. `thread_id` and `in_reply_to_email_id` are not on any seam shape.
//     `MessageInput.in_reply_to` is NOT them: it carries the RFC `In-Reply-To` HEADER value
//     and the SQLite store folds it into `headers_json`, so using it to hold a local row id
//     would put a fabricated value in a header. The deleted arm's threading step was
//     best-effort (a bare `try {} catch {}`) and needed a `Database` handle to run at all.
//   * RAW OBJECT SIZE. `inbound_emails.raw_size` is hard-coded to `0` by the seam's insert
//     (`insertUnifiedMessage`) and absent from its update set, so the S3 object's byte count
//     has no home.
//
// ─── ONE ABSENCE THAT WAS FIXED RATHER THAN REPORTED, AND WHY THAT IS DIFFERENT ────────
//
// ATTACHMENT PATHS ARE PRESERVED, and this is the one place where the honest answer was to
// repair a reader instead of reporting a loss. `inbound_emails.attachment_paths` is
// UNREACHABLE through the seam by construction — `insertUnifiedMessage` writes the literal
// `'[]'` into it and `updateValues` never names it — so the pointer to freshly written bytes
// had nowhere to go. Reporting that as an absence would have left this family writing files to
// disk and then losing their addresses, which is worse than either recording them or not
// writing them.
//
// The fix does not widen the seam and does not fabricate anything. `MessageInput.attachments`
// is declared `unknown[]` — deliberately opaque — and maps straight onto `attachments_json`.
// So the FULL attachment record, path included, is written there, and
// `mergeAttachmentDetails` (src/lib/attachment-actions.ts, already shared and already
// mode-free) learned to read a location off an attachment entry that carries its own. That
// fallback fires ONLY when no separate `attachment_paths` entry matched, so every row written
// before this change is read exactly as it was.
//
// ─── WHAT THIS FILE DELIBERATELY DOES NOT DO ──────────────────────────────────────────
//
//  1. It never asks WHICH store it holds and never reads a deployment word. Selection is
//     `createConfiguredEmailStore()`'s job and follows storage configuration alone.
//  2. It never answers an empty list, a zero count or a silent no-op in place of an operation
//     the store refused. A refusal RAISES, carrying the store's own code and status.
//  3. It puts no message content in any error or diagnostic — no body, no header value, no
//     attachment payload. Every message below names an operation and, at most, an id, a
//     bucket and an object key.
//  4. It does not touch `src/store/`, the dispatch layer, or another family's mode guard.
//     `getInboundAttachmentStorageConfig()` still reads the deployment word INSIDE
//     `src/lib/config.ts`; that reference belongs to that module's own collapse, and this file
//     adds none of its own.
//
// SES stores inbound objects under RANDOM keys, so a key-ordered cursor would silently skip a
// later-arriving object whose key sorts earlier. The prefix is therefore paged in full and the
// fence does the deduplication — unchanged from the deleted arm, and the reason it is spelled
// out here too is that it is the one property of this pipeline a reader is most likely to
// "optimise" away.

import type { S3Client } from "@aws-sdk/client-s3";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../db/database.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Refusal } from "../store/outcome.js";
import type { ResourceRow } from "../store/records.js";
import { loadConfig, saveConfig, getInboundAttachmentStorageConfig } from "./config.js";
import { emitEmailsEventBestEffort, inboundReceivedEventData } from "./emails-events.js";
import { s3ObjectUrl } from "./s3-object.js";

const MAIL_SOURCES_CONFIG_KEY = "mail_sources";

export type MailSourceStatus = "live" | "import" | "legacy" | "retired";

/**
 * What a sync run may be asked to do.
 *
 * THE ONE FIELD THAT CHANGED, and it is the two deleted arms' only type divergence. The local
 * arm carried `db?: Database` and the remote arm did not — and because the facade re-exported
 * the LOCAL arm's types (`export type * from "./s3-sync.local.js"`), the local, wider copy was
 * the published one and the remote arm's narrower copy was invisible. The field was DEAD: no
 * call site in the repository, including the tests, ever passed it. It is replaced by `store`,
 * the seam injectable every collapsed family takes, which is the same role (let a test supply
 * the backing storage) expressed against the thing this file now talks to.
 */
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
  /**
   * Injected only by tests. There is exactly one production path and it is
   * `createConfiguredEmailStore()`.
   */
  store?: EmailStore;
}

export interface S3SyncResult {
  synced: number;
  skipped: number;
  attachments_saved: number;
  errors: string[];
  last_key?: string;
  /**
   * Provenance THE CALLER ASKED FOR that this installation's store has no field to hold.
   *
   * NOT an error list and not a warning list: every entry describes messages that WERE
   * ingested, minus a fact the caller supplied and no store behind this package can keep. It
   * exists because the alternative — accepting `--provider` and dropping it — reports a write
   * that did not happen, and a caller cannot see the difference. Empty on a run that lost
   * nothing, and empty on a run that ingested nothing.
   *
   * SCOPED TO CALLER-SUPPLIED FACTS ON PURPOSE, and the first version of this field was not.
   * It also carried the thread-linkage and raw-object-size absences — which are TRUE, but true
   * of every ingest on every installation, forever, until the seam widens. That is not per-run
   * news; it is a static property of the product, and emitting it per run means every consumer
   * has to plumb a constant. Adversarial review found four of six consumers dropping the field
   * for exactly that reason, and the honest fix was to stop putting a constant in a per-run
   * channel rather than to plumb it six ways. The static absences are documented in this file's
   * header, where architectural absences belong.
   *
   * WHO PRINTS IT, stated precisely rather than claimed universally, because the first version
   * of this comment claimed "every formatter" and that was false. Printed by `inbox sync-s3`
   * (text and `--json`), `inbox watch`, `domain inbound`, the TUI autopull, and the
   * `sync_s3_inbox` MCP tool (which serialises the whole result). NOT printed by
   * `src/server/routes/inbound-webhook.ts`: its response is a fixed wire contract with no human
   * reader, consumed by SES, and the note would be identical on every single delivery.
   */
  unrecorded: string[];
}

type S3Sdk = typeof import("@aws-sdk/client-s3");
type MailparserSdk = typeof import("mailparser");
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

/**
 * An attachment as it is recorded on the message.
 *
 * The metadata the deleted arm put in `attachments_json` PLUS the location it put in the
 * unreachable `attachment_paths` column — see the header. `index` is the position in the
 * message's attachment array and is the stable download id.
 */
export interface RecordedAttachment {
  index: number;
  filename: string;
  content_type: string;
  size: number;
  local_path?: string;
  s3_url?: string;
}

let s3SdkPromise: Promise<S3Sdk> | undefined;
let mailparserPromise: Promise<MailparserSdk> | undefined;

function loadS3Sdk(): Promise<S3Sdk> {
  s3SdkPromise ??= import("@aws-sdk/client-s3");
  return s3SdkPromise;
}

function loadMailparser(): Promise<MailparserSdk> {
  mailparserPromise ??= import("mailparser");
  return mailparserPromise;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The refusal, thrown.
 *
 * Names the OPERATION and carries the store's own code, status and text. It names no setting
 * and no command — a refusal that tells the caller which variable to set is a refusal
 * documenting its own bypass — and it carries no message content.
 */
function storeRefusal(what: string, refusal: Refusal): Error {
  return new Error(
    `This installation's store cannot ${what} (${refusal.code}, ${refusal.status}): ${refusal.message}`,
  );
}

/**
 * The store this run writes through.
 *
 * Resolved per call, so a configuration error belongs to the sync that needed a store rather
 * than to whoever imported this module first.
 */
function storeFor(store: EmailStore | undefined): EmailStore {
  return store ?? createConfiguredEmailStore();
}

// ---- the S3 source registry: config file, no store ---------------------------

function normalizePrefix(prefix: string | null | undefined): string | undefined {
  const value = String(prefix ?? "").trim();
  return value.length > 0 ? value : undefined;
}

function normalizeObjectKey(key: string | null | undefined): string | undefined {
  const value = String(key ?? "").trim().replace(/^\/+/, "");
  return value.length > 0 ? value : undefined;
}

function normalizeExactObjectKeys(keys: string[] | undefined, prefix: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keys ?? []) {
    const key = normalizeObjectKey(raw);
    if (!key) continue;
    if (prefix && !key.startsWith(prefix)) {
      throw new Error(`S3 object key ${key} is outside configured prefix ${prefix}`);
    }
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
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

function sameS3Endpoint(
  source: Pick<S3MailSource, "bucket" | "prefix">,
  bucket: string,
  prefix?: string,
): boolean {
  return source.bucket === bucket && normalizePrefix(source.prefix) === normalizePrefix(prefix);
}

function prefixContains(parent: string | undefined, child: string | undefined): boolean {
  const normalizedParent = normalizePrefix(parent) ?? "";
  const normalizedChild = normalizePrefix(child) ?? "";
  return normalizedChild.length > normalizedParent.length && normalizedChild.startsWith(normalizedParent);
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

/**
 * The configured S3 mail sources.
 *
 * SYNCHRONOUS AND STORE-FREE, and that is a finding rather than an omission — see the header.
 * Both deleted arms implemented this identically against the config file.
 */
export function listS3Sources(): S3MailSource[] {
  return readConfiguredSources()
    .map(parseConfiguredS3Source)
    .filter((source): source is S3MailSource => !!source);
}

/** The subset of {@link listS3Sources} that live sync is enabled for. Config file. */
export function listLiveS3Sources(): S3MailSource[] {
  return listS3Sources().filter(sourceIsLive);
}

/** Register or update an S3 mail source. Config file; dedupes on id, then on bucket+prefix. */
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

/** Retire an S3 mail source so live sync stops selecting it. Config file. */
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

function resolveS3SourceForSync(opts: S3SyncOptions): S3SyncOptions {
  const sources = listS3Sources();
  const prefix = normalizePrefix(opts.prefix);
  const requestedSourceId = typeof opts.sourceId === "string" && opts.sourceId.trim() ? opts.sourceId.trim() : undefined;
  const source = requestedSourceId
    ? findUniqueS3Source(sources, requestedSourceId)
    : opts.bucket
      ? sources.find((candidate) => sameS3Endpoint(candidate, opts.bucket!, prefix))
      : undefined;
  if (requestedSourceId && !source) throw new Error(`S3 source not found: ${requestedSourceId}`);
  if (source && !sourceIsLive(source) && !opts.forceSource) {
    throw new Error(`S3 source ${source.id} is ${source.status}${source.live_sync_enabled ? "" : " with live sync disabled"}; S3 sync is blocked.`);
  }
  if (opts.bucket && !requestedSourceId && !opts.forceSource) {
    const bucketSources = sources.filter((candidate) => candidate.bucket === opts.bucket);
    const coveredChildSources = bucketSources.filter((candidate) => prefixContains(prefix, candidate.prefix));
    if (coveredChildSources.length > 0) {
      throw new Error(`S3 bucket ${opts.bucket} has configured source prefixes under ${prefix ?? "<root>"}; choose a source with --source or an exact --prefix before syncing.`);
    }
  }
  if (!source && opts.bucket && !opts.forceSource) {
    const bucketSources = sources.filter((candidate) => candidate.bucket === opts.bucket);
    if (bucketSources.length > 0 && !bucketSources.some(sourceIsLive)) {
      throw new Error(`S3 bucket ${opts.bucket} only has retired or disabled sources; S3 sync is blocked.`);
    }
  }
  if (!source) return { ...opts, prefix };
  return {
    ...opts,
    bucket: source.bucket,
    prefix: source.prefix,
    region: opts.region ?? source.region,
    providerId: opts.providerId ?? source.provider_id,
  };
}

// ---- provider validation over the seam --------------------------------------

/** One page of the provider scan. Small enough that a typical install ends in one page. */
const PROVIDER_SCAN_PAGE = 200;

/**
 * The most providers an abbreviated-id scan will enumerate before REFUSING to answer.
 *
 * A bound is required and a bound alone is not enough: hitting it means the scan could not
 * see the whole set, so it cannot prove either that a prefix is unknown or that it is
 * unique. Answering "not found" there would refuse a real provider, and answering the first
 * match would silently pick one of several. So the bound RAISES.
 */
const PROVIDER_SCAN_MAX = 20_000;

function rowId(row: ResourceRow): string | null {
  const value = row["id"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolve a possibly-abbreviated provider id to a full one, or raise.
 *
 * Replaces `resolvePartialId(db, "providers", …)`. The guard it preserves is the reason the
 * deleted arm had it at all: `inbound_emails.provider_id` is a foreign key, and a short id
 * used to fail deep in the insert with `FOREIGN KEY constraint failed`.
 *
 * THE FULL-ID PATH COSTS ONE READ. `get` answers immediately for the full id every production
 * caller passes; the scan is paid only when it finds nothing.
 *
 * THE SCAN TERMINATES ON AN EMPTY PAGE, NOT ON A SHORT ONE, and advances by rows RECEIVED. A
 * store is free to return fewer rows than asked for — a clamped limit, a filtered page — and
 * treating that as end-of-table stops the scan early and reports a real provider as unknown.
 */
async function resolveProviderId(store: EmailStore, ref: string): Promise<string> {
  const direct = await store.providers.get(ref);
  if (!direct.ok) throw storeRefusal(`look up provider ${ref}`, direct);
  if (direct.value !== null) {
    const id = rowId(direct.value);
    if (id !== null) return id;
  }

  const matches: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await store.providers.list({ limit: PROVIDER_SCAN_PAGE, offset });
    if (!page.ok) throw storeRefusal(`list providers to resolve ${ref}`, page);
    if (page.value.length === 0) break;
    for (const row of page.value) {
      const id = rowId(row);
      if (id !== null && id.startsWith(ref) && !matches.includes(id)) matches.push(id);
    }
    offset += page.value.length;
    if (offset >= PROVIDER_SCAN_MAX) {
      throw new Error(
        `Could not resolve provider ${ref}: this installation has more than ${PROVIDER_SCAN_MAX} ` +
          "providers, so a prefix cannot be proved unique. Pass the full provider id.",
      );
    }
  }

  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`Ambiguous provider id "${ref}"; pass the full id. Matches: ${matches.join(", ")}`);
  }
  throw new Error(`Provider not found: ${ref}`);
}

// ---- S3 and filesystem: not store operations --------------------------------

async function makeS3Client(opts: S3SyncOptions): Promise<{ s3: S3Client; s3Sdk: S3Sdk }> {
  const s3Sdk = await loadS3Sdk();
  const { S3Client } = s3Sdk;
  const region = opts.region || process.env["AWS_REGION"] || "us-east-1";
  const credentials = opts.accessKeyId && opts.secretAccessKey
    ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
    : undefined;
  return { s3: new S3Client({ region, credentials }), s3Sdk };
}

function setLastSyncedKey(bucket: string, prefix: string, lastKey: string): void {
  const config = loadConfig();
  const key = `s3_sync_last_key_${bucket}_${prefix.replace(/\//g, "_")}`;
  config[key] = lastKey;
  saveConfig(config);
}

function getAttachmentDir(emailId: string): string {
  const dir = join(getDataDir(), "attachments", emailId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MAX_ATTACHMENT_STORAGE_LEAF_BYTES = 240;

interface AttachmentStoragePlan {
  index: number;
  filename: string;
  content_type: string;
  size: number;
  content: Buffer;
  storageLeaf: string;
}

function truncateUtf8(value: string, byteLimit: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > byteLimit) break;
    output += character;
    bytes += next;
  }
  return output;
}

function legacySanitizeAttachmentFilename(filename: string): string {
  return filename.replace(/[/\\?%*:|"<>]/g, "_");
}

function attachmentStorageLeaf(index: number, filename: string): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("attachment index must be a non-negative integer");
  const prefix = `${String(index).padStart(6, "0")}-`;
  let sanitized = legacySanitizeAttachmentFilename(filename)
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim();
  if (!sanitized || sanitized === "." || sanitized === "..") sanitized = "attachment";
  const budget = MAX_ATTACHMENT_STORAGE_LEAF_BYTES - Buffer.byteLength(prefix, "utf8");
  return `${prefix}${truncateUtf8(sanitized, budget) || "attachment"}`;
}

function buildAttachmentStoragePlans(
  attachments: ReadonlyArray<{
    filename?: string;
    contentType?: string;
    size?: number;
    content: Buffer;
  }>,
): AttachmentStoragePlan[] {
  return attachments.map((attachment, index) => {
    const filename = attachment.filename ?? `attachment_${index + 1}`;
    return {
      index,
      filename,
      content_type: attachment.contentType ?? "application/octet-stream",
      size: attachment.size ?? 0,
      content: attachment.content,
      storageLeaf: attachmentStorageLeaf(index, filename),
    };
  });
}

function attachmentS3Key(prefix: string | undefined, emailId: string, storageLeaf: string): string {
  const root = (prefix?.trim() || "emails").replace(/\/+$/, "");
  return `${root}/${emailId}/${storageLeaf}`;
}

function storeLocalAttachment(plan: AttachmentStoragePlan, outputDir: string): RecordedAttachment {
  const filePath = join(outputDir, plan.storageLeaf);
  writeFileSync(filePath, plan.content);
  return {
    index: plan.index,
    filename: plan.filename,
    content_type: plan.content_type,
    size: plan.size,
    local_path: filePath,
  };
}

/** Metadata only — an attachment whose bytes this installation does not keep. */
function attachmentMetadataOnly(plan: AttachmentStoragePlan): RecordedAttachment {
  return {
    index: plan.index,
    filename: plan.filename,
    content_type: plan.content_type,
    size: plan.size,
  };
}

/** @internal Pure/local seams for deterministic attachment-storage tests. */
export const s3SyncLocalTestBoundary = {
  attachmentS3Key,
  buildAttachmentStoragePlans,
  storeLocalAttachment,
};

async function listObjectPage(
  s3: S3Client,
  s3Sdk: S3Sdk,
  bucket: string,
  prefix: string,
  continuationToken?: string,
): Promise<{ objects: { key: string; size: number; lastModified?: Date }[]; nextContinuationToken?: string }> {
  const { ListObjectsV2Command } = s3Sdk;
  // NOTE: SES inbound stores objects under RANDOM keys, so a key-ordered cursor
  // (StartAfter: lastKey) silently skips any later-arriving object whose key
  // sorts before the last-synced key. We therefore page the full prefix and
  // rely on the store's own source_id fence before downloading bodies.
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: 1000,
    ContinuationToken: continuationToken,
  }));
  const objects: { key: string; size: number; lastModified?: Date }[] = [];
  for (const obj of res.Contents ?? []) {
    if (obj.Key && obj.Key !== prefix) {
      objects.push({ key: obj.Key, size: obj.Size ?? 0, lastModified: obj.LastModified });
    }
  }
  return {
    objects,
    nextContinuationToken: res.IsTruncated ? res.NextContinuationToken : undefined,
  };
}

/**
 * Download and parse a raw RFC 2822 email from S3.
 */
async function fetchAndParseEmail(s3: S3Client, s3Sdk: S3Sdk, bucket: string, key: string) {
  const { GetObjectCommand } = s3Sdk;
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`Empty S3 object: ${key}`);

  // Stream to buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const rawEmail = Buffer.concat(chunks);

  const { simpleParser } = await loadMailparser();
  return simpleParser(rawEmail);
}

/**
 * Flatten mailparser headers (a Map, or object) into a plain string record.
 * Object.entries(Map) is empty, so a Map must be iterated explicitly.
 */
function flattenHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries: Iterable<[string, unknown]> =
    headers instanceof Map ? headers.entries() : Object.entries(headers as Record<string, unknown>);
  for (const [k, v] of entries) {
    out[k] =
      typeof v === "string" ? v
      : Array.isArray(v) ? v.map(String).join(" ")
      : (v && typeof v === "object" && "text" in (v as Record<string, unknown>)) ? String((v as Record<string, unknown>).text)
      : String(v);
  }
  return out;
}

// ---- one object, through the seam -------------------------------------------

/**
 * Ingest one S3 object.
 *
 * TWO SEAM WRITES, NOT ONE, AND THE ORDER IS THE POINT. The FIRST `upsertMessage` is the
 * FENCE: it is what decides synced-vs-skipped, atomically, and it must happen before any
 * byte is written so that a re-run of an already-ingested object does not rewrite its
 * attachments. Only when that write reports `inserted` do the payload bytes go to disk or to
 * S3 — and only then is a SECOND upsert, on the same `source_id`, used to record where they
 * went. The second write is idempotent by construction and touches only `attachments`
 * (`updateValues` writes exactly the columns the input carries, which is why a replay does
 * not reset the read flag, the star, the labels or `received_at`).
 *
 * @returns whether this object was newly ingested
 */
async function processS3Object(
  store: EmailStore,
  s3: S3Client,
  s3Sdk: S3Sdk,
  syncConfig: ReturnType<typeof getInboundAttachmentStorageConfig>,
  bucket: string,
  obj: { key: string; size: number },
  result: S3SyncResult,
): Promise<boolean> {
  const rawS3Url = s3ObjectUrl(bucket, obj.key);
  const parsed = await fetchAndParseEmail(s3, s3Sdk, bucket, obj.key);
  const attachmentPlans = buildAttachmentStoragePlans(parsed.attachments ?? []);

  const fromAddr = typeof parsed.from?.text === "string"
    ? parsed.from.text
    : parsed.from?.value?.[0]?.address ?? "";
  const toAddrs = parsed.to
    ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).flatMap((a) =>
        a.value?.map((v) => v.address ?? "") ?? [])
    : [];
  const ccAddrs = parsed.cc
    ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]).flatMap((a) =>
        a.value?.map((v) => v.address ?? "") ?? [])
    : [];

  const headerObj = flattenHeaders(parsed.headers);
  const subject = parsed.subject ?? "(no subject)";
  const receivedAt = (parsed.date ?? new Date()).toISOString();
  // Metadata only on the fencing write. The bytes do not exist yet, so a location recorded
  // here would name a file this run has not created.
  const metadataOnly = attachmentPlans.map(attachmentMetadataOnly);

  const fenced = await store.messages.upsertMessage({
    direction: "inbound",
    // `source_id` IS the fence. `message_id` keeps the same value the deleted arm wrote
    // there, so nothing that read the S3 URL off a message lost it.
    source_id: rawS3Url,
    message_id: rawS3Url,
    from_addr: fromAddr,
    to_addrs: toAddrs,
    cc_addrs: ccAddrs,
    subject,
    body_text: parsed.text ?? null,
    body_html: typeof parsed.html === "string" ? parsed.html : null,
    attachments: metadataOnly,
    headers: headerObj,
    received_at: receivedAt,
  });
  if (!fenced.ok) throw storeRefusal(`record the message from ${rawS3Url}`, fenced);

  // ALREADY INGESTED. Not an error and not a write — the deleted arm's equivalent branch
  // additionally back-filled `provider_id` here, and that column has no seam field (see the
  // header), so the back-fill is gone rather than faked.
  if (!fenced.value.inserted) {
    result.skipped++;
    result.last_key = obj.key;
    return false;
  }

  const stored = fenced.value.record;

  emitEmailsEventBestEffort({
    type: "emails.inbound.received",
    subject: stored.id,
    severity: "notice",
    dedupeKey: `emails:inbound:received:${stored.id}`,
    message: `Inbound email received from SES/S3`,
    data: inboundReceivedEventData({
      emailId: stored.id,
      providerId: null,
      source: "ses-s3",
      messageId: rawS3Url,
      fromAddress: fromAddr,
      toAddresses: toAddrs,
      ccAddresses: ccAddrs,
      subject,
      receivedAt: stored.received_at ?? receivedAt,
      rawS3Url,
      attachmentCount: metadataOnly.length,
    }),
    metadata: {
      bucket,
      object_key: obj.key,
    },
  });

  result.synced++;
  result.last_key = obj.key;

  if (attachmentPlans.length === 0 || syncConfig.attachment_storage === "none") return true;

  const recorded: RecordedAttachment[] = [];
  let wroteAny = false;
  for (const attachment of attachmentPlans) {
    if (syncConfig.attachment_storage === "s3") {
      if (!syncConfig.s3_bucket) {
        result.errors.push(`S3 upload ${attachment.storageLeaf}: attachment_s3_bucket is required when attachment_storage=s3`);
        recorded.push(attachmentMetadataOnly(attachment));
        continue;
      }
      try {
        const { S3Client: S3C, PutObjectCommand } = await loadS3Sdk();
        const client = new S3C({ region: syncConfig.s3_region ?? "us-east-1" });
        const s3Key = attachmentS3Key(syncConfig.s3_prefix, stored.id, attachment.storageLeaf);
        await client.send(new PutObjectCommand({
          Bucket: syncConfig.s3_bucket,
          Key: s3Key,
          Body: attachment.content,
          ContentType: attachment.content_type,
        }));
        const uri = `s3://${syncConfig.s3_bucket}/${s3Key}`;
        recorded.push({
          index: attachment.index,
          filename: attachment.filename,
          content_type: attachment.content_type,
          size: attachment.size,
          s3_url: uri,
        });
        wroteAny = true;
        emitEmailsEventBestEffort({
          type: "emails.inbound.attachment.saved",
          subject: stored.id,
          severity: "info",
          dedupeKey: `emails:inbound:attachment:${stored.id}:${attachment.storageLeaf}`,
          message: "Inbound attachment stored",
          data: {
            email_id: stored.id,
            filename: attachment.filename,
            storage_leaf: attachment.storageLeaf,
            content_type: attachment.content_type,
            size: attachment.size,
            storage: "s3",
            uri,
          },
        });
      } catch (e) {
        result.errors.push(`S3 upload ${attachment.storageLeaf}: ${String(e)}`);
        recorded.push(attachmentMetadataOnly(attachment));
        continue;
      }
    } else if (syncConfig.attachment_storage === "local") {
      const outputDir = getAttachmentDir(stored.id);
      const path = storeLocalAttachment(attachment, outputDir);
      recorded.push(path);
      wroteAny = true;
      emitEmailsEventBestEffort({
        type: "emails.inbound.attachment.saved",
        subject: stored.id,
        severity: "info",
        dedupeKey: `emails:inbound:attachment:${stored.id}:${attachment.storageLeaf}`,
        message: "Inbound attachment stored",
        data: {
          email_id: stored.id,
          filename: attachment.filename,
          storage_leaf: attachment.storageLeaf,
          content_type: attachment.content_type,
          size: attachment.size,
          storage: "local",
          uri: path.local_path,
        },
      });
    } else {
      recorded.push(attachmentMetadataOnly(attachment));
      continue;
    }
    result.attachments_saved++;
  }

  // Only when a location actually exists. A second write that carried nothing new would be
  // an UPDATE with no information in it.
  if (wroteAny) {
    const decorated = await store.messages.upsertMessage({
      source_id: rawS3Url,
      from_addr: fromAddr,
      to_addrs: toAddrs,
      attachments: recorded,
    });
    // A REFUSAL HERE RAISES rather than being pushed onto `errors`. The bytes are on disk and
    // the row does not point at them, which is a state the caller must not read as a clean
    // run — and `synced` has already been counted, so a swallowed refusal would report a
    // complete ingestion of a message whose attachments are unreachable.
    if (!decorated.ok) throw storeRefusal(`record attachment locations for ${stored.id}`, decorated);
  }

  return true;
}

/**
 * Poll an S3 prefix (or an exact key list) and ingest what is not already stored.
 *
 * ALREADY ASYNCHRONOUS IN BOTH DELETED ARMS, so this signature is unchanged and every call
 * site's `await` is the one it already had.
 */
export async function syncS3Inbox(opts: S3SyncOptions): Promise<S3SyncResult> {
  opts = resolveS3SourceForSync(opts);
  const bucket = opts.bucket;
  if (!bucket) throw new Error("No S3 bucket: pass bucket or sourceId");
  const store = storeFor(opts.store);
  const { s3, s3Sdk } = await makeS3Client(opts);
  const prefix = opts.prefix ?? "";
  const requestedLimit = Math.trunc(opts.limit ?? 100);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 100;

  const result: S3SyncResult = { synced: 0, skipped: 0, attachments_saved: 0, errors: [], unrecorded: [] };

  // VALIDATED UP FRONT, REPORTED AT THE END. An unknown provider still refuses the whole run
  // before a single object is downloaded, exactly as it did before — the guard is the useful
  // half — but no store behind this package has a provider field on a message, so the resolved
  // id cannot be written. Saying so is the difference between this and accepting the flag and
  // dropping it.
  const validatedProviderId = opts.providerId
    ? await resolveProviderId(store, opts.providerId)
    : null;

  const syncConfig = getInboundAttachmentStorageConfig();
  const exactKeys = normalizeExactObjectKeys(opts.keys, prefix);

  /**
   * Name the CALLER-SUPPLIED provenance the ingested messages could not carry.
   *
   * TWO GATES, and both matter. A run that stored no message lost nothing, and a note on every
   * empty poll is noise that trains a reader to skip the field — the same silence an unreported
   * loss produces, arrived at from the other side. And only a fact the CALLER supplied belongs
   * here: the thread-linkage and raw-size absences are static properties of the product rather
   * than per-run news, and live in this file's header. See `S3SyncResult.unrecorded`.
   */
  const noteUnrecorded = (): void => {
    if (result.synced === 0) return;
    if (validatedProviderId === null) return;
    result.unrecorded.push(
      `provider ${validatedProviderId} was not recorded on the ${result.synced} ingested ` +
        "message(s): no store behind this package has a provider field on a message",
    );
  };

  if (exactKeys.length > 0) {
    let attempted = 0;
    for (const key of exactKeys) {
      if (attempted >= limit) break;
      attempted++;
      try {
        await processS3Object(store, s3, s3Sdk, syncConfig, bucket, { key, size: 0 }, result);
      } catch (e) {
        result.errors.push(`${key}: ${String(e)}`);
      }
    }
    if (result.last_key) setLastSyncedKey(bucket, prefix, result.last_key);
    noteUnrecorded();
    return result;
  }

  let continuationToken: string | undefined;
  let attemptedNewObjects = 0;
  do {
    let page: Awaited<ReturnType<typeof listObjectPage>>;
    try {
      page = await listObjectPage(s3, s3Sdk, bucket, prefix, continuationToken);
    } catch (e) {
      result.errors.push(`Failed to list S3 objects: ${String(e)}`);
      noteUnrecorded();
      return result;
    }

    for (const obj of page.objects) {
      if (attemptedNewObjects >= limit) break;
      let ingested: boolean;
      try {
        ingested = await processS3Object(store, s3, s3Sdk, syncConfig, bucket, obj, result);
      } catch (e) {
        result.errors.push(`${obj.key}: ${String(e)}`);
        continue;
      }
      // THE LIMIT COUNTS NEW OBJECTS, NOT OBJECTS SEEN — unchanged from the deleted arm, and
      // it is what lets a bounded run make progress through a prefix that is mostly already
      // ingested instead of spending its budget re-reading the same first N keys.
      if (ingested) attemptedNewObjects++;
    }

    if (attemptedNewObjects >= limit) break;
    continuationToken = page.nextContinuationToken;
  } while (continuationToken);

  // Persist last synced key
  if (result.last_key) {
    setLastSyncedKey(bucket, prefix, result.last_key);
  }

  noteUnrecorded();
  return result;
}
