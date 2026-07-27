/**
 * S3 inbox sync — SELF-HOSTED CLIENT. One export, and it refuses.
 *
 * This module polled an S3 bucket for raw SES-stored emails once; in the self-hosted client there
 * is NO local inbound store, because the operator's server owns the SES → S3 → mailbox ingestion
 * pipeline. So `syncS3Inbox` is a fail-loud stub.
 *
 * WHAT USED TO BE HERE AND IS NOT ANY MORE: a second, character-for-character copy of the S3
 * SOURCE REGISTRY (list/live/register/retire) and of the five types it needs. That registry was
 * never storage — it is a `mail_sources` array in the local config file — so there was nothing for
 * the deployment word to decide between the two copies, and it has collapsed into `s3-sync.ts` as
 * one implementation. Only the ingestion half is still mode-routed, and only because migrating it
 * onto the store seam loses five things the seam has no field for; see the header of `s3-sync.ts`.
 *
 * `S3SyncOptions` and `S3SyncResult` are still declared in BOTH this file and `s3-sync.local.ts`,
 * and the local arm's copies are the published ones (`s3-sync.ts` re-exports them). That
 * duplication, and the one divergence inside it — the local arm's `db?: Database`, which no caller
 * has ever passed — belong to the ingestion's own collapse rather than to the registry's.
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
}

export interface S3SyncResult {
  synced: number;
  skipped: number;
  attachments_saved: number;
  errors: string[];
  last_key?: string;
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
