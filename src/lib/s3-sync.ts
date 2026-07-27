// The S3 mail-source registry, collapsed to ONE implementation. The S3 INGESTION is still
// mode-routed, and that split is deliberate.
//
// ─── READ THIS FIRST: THIS FAMILY IS PARTIALLY COLLAPSED ──────────────────────────────
//
// Four of the five exports below are now one implementation with no arm to pick. The fifth,
// `syncS3Inbox`, is STILL DISPATCHED to `s3-sync.local.ts` / `s3-sync.remote.ts`, and both arm
// modules remain in the tree. So a reduced `routedCallExpressions` count must NOT be read as this
// family being done: `twoArmFamilies` and `remoteArmModules` still count it, correctly.
//
// WHY THE SPLIT. The four registry exports and the ingestion are not the same kind of code, and
// measuring them said so:
//
//   * `listS3Sources`, `listLiveS3Sources`, `registerS3Source` and `retireS3Source` NEVER TOUCHED
//     A DATABASE in either arm. They read and write a `mail_sources` array in the local CONFIG
//     FILE (`loadConfig` / `saveConfig`), and the two arms' implementations of them were
//     character-for-character identical. There was nothing for the deployment word to decide, so
//     collapsing them deletes a duplicated copy and a dispatch that never had a choice to make.
//   * `syncS3Inbox` is a real ingestion pipeline whose migration onto the store seam loses five
//     things the seam has no field or operation for. One of them is a DATA-SAFETY regression:
//     `inbound_emails.provider_id` would be left NULL on every ingested row, and
//     `PROVIDER_DELETE_GUARD_SQL` (src/db/database.ts) relies on that column to abort a provider
//     DELETE while inbound mail still references it. With NULLs the guard stops firing and the
//     DELETE succeeds. That is not a regression worth shipping to bank a counter, so the ingestion
//     is sequenced after `src/db/inbound` collapses; the other four escalations are recorded as
//     its acceptance criteria on the phase task.
//
// So this module deliberately does the SMALLER, SAFER half completely, and leaves the harder half
// visibly un-collapsed rather than half-collapsed.
//
// ─── WHY THE FOUR ARE NOT ASYNC, WHICH IS THE OTHER MEASURED FINDING ──────────────────
//
// Every other family in this programme widened its exports to `Promise` because the seam is async.
// These four do not, because they make NO SEAM CALL:
//
//   * INVENTING A SEAM CALL FOR THEM WOULD BE A FABRICATION. The seam has no mail-source
//     repository, because a mail source is not a row this product stores anywhere — it is operator
//     configuration, like a bucket name.
//   * MAKING THEM `async` WOULD BE A BREAK WITH NOTHING BEHIND IT. All 13 of their production call
//     sites use the value synchronously, and two cannot be fixed with a local `await` at all:
//     `src/lib/domain-inbound-evidence.ts` uses `listLiveS3Sources()` as a DEFAULT PARAMETER of an
//     exported synchronous function, and `src/cli/tui/data.local.ts` calls `listS3Sources()` inside
//     the exported synchronous `listMailboxSources`. A forgotten `await` on a source list reads a
//     truthy Promise as a populated list, which is the exact failure class this programme exists to
//     remove. A signature is widened when the work behind it became asynchronous. Theirs did not.
//
// A negative control in the suite beside this file asserts all four still return non-Promises, so a
// later edit that quietly makes one `async` goes red instead of silently poisoning those 13.
//
// ─── THE TYPES STILL COME FROM THE LOCAL ARM, AND THAT IS UNCHANGED ───────────────────
//
// `export type * from "./s3-sync.local.js"` is kept exactly as it was. It is how the weaker arm
// became the contract — a star re-export makes one implementation's shapes authoritative silently —
// and it is not fixed here because the shapes it publishes that MATTER (`S3SyncOptions`,
// `S3SyncResult`) belong to `syncS3Inbox`, the half that is not collapsing yet.
//
// The one type divergence between the two arms, measured and reported rather than fixed: the local
// arm's `S3SyncOptions` carries `db?: Database` and the remote arm's does not. Because the facade
// re-exports the LOCAL arm's types, the wider local copy is the published contract and the remote
// arm's narrower copy is invisible to every consumer. The field is DEAD — no call site in the
// repository, including the tests, has ever passed it. Replacing it with the seam's injectable
// belongs with the ingestion, whose signature it is; doing it here would change a published type
// while both implementations behind it still take a `Database`.

import { getEmailsMode } from "./mode.js";
import { loadConfig, saveConfig } from "./config.js";
// `export type *` re-exports but creates NO local binding, so the shapes these four functions
// are written against are imported explicitly as well. Both arms still declare them; the arms'
// copies go with the ingestion, and until then the local arm remains the single declaration site
// this module reads from rather than a second one appearing here.
import type {
  MailSourceStatus,
  RegisterS3SourceInput,
  S3MailSource,
  S3SyncOptions,
  S3SyncResult,
} from "./s3-sync.local.js";

export type * from "./s3-sync.local.js";

const MAIL_SOURCES_CONFIG_KEY = "mail_sources";

type RawMailSource = Record<string, unknown>;

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

/**
 * The configured S3 mail sources.
 *
 * SYNCHRONOUS AND STORE-FREE, and that is a measurement rather than an omission — see the header.
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

/**
 * S3 → mailbox ingestion, STILL MODE-ROUTED. See the header for why this one export did not
 * collapse with the other four, and the phase task for the five acceptance criteria its migration
 * has to satisfy.
 *
 * Written as a plain `async` function with a DYNAMIC import rather than through the deleted
 * `routed()` helper, for two reasons that are not stylistic. That helper existed to dispatch FIVE
 * exports through one indirection and there is now one; and it typed its result off the local arm's
 * namespace, which required a static `import * as local` — a module-eval-time load of the entire
 * SQLite ingestion path, and of `@aws-sdk/client-s3` behind it, for any consumer that only wanted
 * to list configured sources. Both arms were already `async` here, so the dynamic import costs
 * nothing and the exported signature is unchanged.
 */
export async function syncS3Inbox(opts: S3SyncOptions): Promise<S3SyncResult> {
  const implementation = getEmailsMode() === "self_hosted"
    ? await import("./s3-sync.remote.js")
    : await import("./s3-sync.local.js");
  return implementation.syncS3Inbox(opts);
}
