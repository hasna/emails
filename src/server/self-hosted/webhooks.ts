// Self-hosted mount of the provider webhook receivers.
//
// The receivers themselves (SNS signature verification, the topic/account
// allowlist, SubscribeURL host pinning, the Svix signature check, the SES and
// Resend parsers and the idempotency protocol) are shared verbatim with the local
// dashboard mount — see ../webhooks/receivers.ts. What this module supplies is
// the SELF-HOSTED destination: every write below goes through
// `EmailsSelfHostedStore.forTenant(...)`, i.e. the operator's own Postgres under
// Layer 1 tenant scoping plus the Layer 2 RLS backstop. Nothing here touches the
// local SQLite repositories.
//
// Without this mount the hosted deployment had NO webhook surface at all
// (service.ts returns null outside /v1, /health, /ready, /version), so Resend
// inbound mail and SES bounce/complaint outcomes stayed at the provider. There is
// no polling fallback: `SesProvider.pullEvents` returns [] unconditionally, and
// `pullEvents` has no server-side caller in any mode.
//
// Tenant selection is ENVELOPE-based, exactly as in the SQS ingest worker:
// inbound uses the trusted SES/Resend envelope recipients, and a delivery outcome
// uses the envelope SENDER (the operator's own verified sending domain, which is
// the tenant that owns the `inbound_domain_routes` claim for it). No payload
// field can nominate a tenant.

import { resourceSpecForPath } from "./resources.js";
import {
  ingestS3Object,
  parseInboundPrefixDomainMap,
  type InboundPrefixDomainMapping,
  type IngestDeps,
} from "./ingest-worker.js";
import type { EmailsSelfHostedStore, MessageInput, TenantScopedStore } from "./store.js";
import {
  receiveResendEvent,
  receiveSesNotification,
  type ConfiguredInboundSource,
  type DeliveryEventSink,
  type ResendInboundSink,
  type SesIngestRequest,
  type SesIngestResult,
  type WebhookReceiptLedger,
  type WebhookRouting,
} from "../webhooks/receivers.js";

const WEBHOOK_RECEIPTS_SPEC = resourceSpecForPath("webhook-receipts")!;
const EVENTS_SPEC = resourceSpecForPath("events")!;

/** Injected S3 reader so the mounted route is testable without AWS. */
export type FetchS3Object = (bucket: string, key: string) => Promise<Buffer>;

export interface SelfHostedWebhookDeps {
  store: EmailsSelfHostedStore;
  env?: NodeJS.ProcessEnv;
  /** Test/embedding seam; production falls back to the canonical S3 client. */
  fetchObject?: FetchS3Object;
  /** Test seam for the SNS certificate check. */
  verifySns?: (body: Record<string, unknown>) => Promise<boolean>;
  /** Test seam for SNS subscription confirmation. */
  fetchUrl?: (url: string) => Promise<unknown>;
  now?: () => string;
}

function env(deps: SelfHostedWebhookDeps): NodeJS.ProcessEnv {
  return deps.env ?? process.env;
}

/**
 * Resolve the tenant scopes an event belongs to from trusted envelope addresses.
 * `resolveInboundRecipients` is the ONE global address→tenant map (the
 * `inbound_domain_routes` claim, active tenants only); an address whose domain is
 * unclaimed resolves to nothing and the caller fails closed.
 */
async function resolveScopes(
  store: EmailsSelfHostedStore,
  routing: WebhookRouting,
): Promise<string[]> {
  if (routing.addresses.length === 0) return [];
  const resolution = await store.resolveInboundRecipients(routing.addresses);
  return resolution.groups.map((group) => group.tenantId);
}

/**
 * Tenant-scoped `webhook_receipts` ledger.
 *
 * The physical table is tenant-scoped and UNIQUE on
 * (tenant_id, provider, event_id), so the ledger is consulted per resolved
 * scope: an event counts as a duplicate only when EVERY scope it routes to has
 * already completed it, and it is recorded in every scope that was written. An
 * event with no resolvable scope has no row to write, so it is never
 * acknowledged — the provider retries and a later domain claim lets it land.
 */
export class SelfHostedWebhookReceiptLedger implements WebhookReceiptLedger {
  private readonly scopeCache = new Map<string, string[]>();

  constructor(private readonly store: EmailsSelfHostedStore) {}

  async scopesFor(routing: WebhookRouting): Promise<string[]> {
    const key = JSON.stringify(routing.addresses);
    const cached = this.scopeCache.get(key);
    if (cached) return cached;
    const resolved = await resolveScopes(this.store, routing);
    this.scopeCache.set(key, resolved);
    return resolved;
  }

  async find(
    provider: string,
    eventId: string,
    routing: WebhookRouting,
  ): Promise<{ resourceId: string | null } | null> {
    const scopes = await this.scopesFor(routing);
    if (scopes.length === 0) return null;
    let first: string | null = null;
    for (const tenantId of scopes) {
      const rows = await this.store.forTenant(tenantId).listResource(WEBHOOK_RECEIPTS_SPEC, {
        limit: 1,
        filters: { provider, event_id: eventId },
      });
      // Not yet complete in at least one destination scope → not a duplicate.
      if (rows.length === 0) return null;
      if (first === null) {
        const resourceId = rows[0]?.["resource_id"];
        first = typeof resourceId === "string" ? resourceId : null;
      }
    }
    return { resourceId: first };
  }

  async record(
    provider: string,
    eventId: string,
    resourceId: string | null,
    routing: WebhookRouting,
  ): Promise<void> {
    for (const tenantId of await this.scopesFor(routing)) {
      const scoped = this.store.forTenant(tenantId);
      const existing = await scoped.listResource(WEBHOOK_RECEIPTS_SPEC, {
        limit: 1,
        filters: { provider, event_id: eventId },
      });
      if (existing.length > 0) continue;
      // A concurrent redelivery can still lose the race against the
      // (tenant_id, provider, event_id) unique index. That surfaces as a 500 and
      // the provider retries, at which point the receipt is visible and the
      // replay is reported as a duplicate — never a second stored copy.
      await scoped.createResource(WEBHOOK_RECEIPTS_SPEC, {
        provider,
        event_id: eventId,
        resource_id: resourceId,
      });
    }
  }
}

/** Default production S3 reader for the mounted SES receiver. */
async function canonicalFetchObject(
  region: string,
  bucket: string,
  key: string,
): Promise<Buffer> {
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region });
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error(`empty S3 object ${bucket}/${key}`);
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * The operator-configured inbound source for a hosted deployment. This is the
 * SAME configuration the SQS ingest worker reads, so the push and pull paths can
 * never disagree about which bucket is canonical.
 */
export function selfHostedInboundSource(
  processEnv: NodeJS.ProcessEnv,
): ConfiguredInboundSource {
  return {
    bucket: processEnv["EMAILS_INGEST_S3_BUCKET"],
    prefix: processEnv["EMAILS_INGEST_S3_PREFIX"] || undefined,
    region: processEnv["AWS_REGION"] ?? "us-east-1",
  };
}

/**
 * Persist a delivery/engagement outcome into the tenant's `events` ledger.
 *
 * This is the UPSTREAM half of suppression: the outcome now lands in the
 * operator's Postgres, tenant-scoped, readable through GET /v1/events. The
 * downstream half — incrementing `contacts.bounce_count` /
 * `contacts.complaint_count` and setting `contacts.suppressed`, which is what
 * `evaluateOutboundPolicy` actually reads — is a separate, still-open defect and
 * is deliberately NOT done here.
 */
function selfHostedDeliveryEventSink(deps: SelfHostedWebhookDeps, ledger: SelfHostedWebhookReceiptLedger): DeliveryEventSink {
  return async (event, routing) => {
    const scopes = await ledger.scopesFor(routing);
    if (scopes.length === 0) return null;
    let firstId: string | null = null;
    for (const tenantId of scopes) {
      const scoped = deps.store.forTenant(tenantId);
      const emailId = event.provider_message_id
        ? await scoped.findMessageIdByKey(event.provider_message_id)
        : null;
      const row = await scoped.createResource(EVENTS_SPEC, {
        email_id: emailId,
        provider_event_id: event.provider_event_id,
        type: event.type,
        recipient: event.recipient ?? null,
        occurred_at: event.occurred_at,
        metadata: {
          ...(event.metadata ?? {}),
          ...(event.provider_message_id ? { provider_message_id: event.provider_message_id } : {}),
        },
      });
      const id = row["id"];
      if (firstId === null && typeof id === "string") firstId = id;
    }
    return firstId ? { id: firstId } : null;
  };
}

/** Persist inbound Resend mail into every routed tenant's `messages` table. */
function selfHostedResendInboundSink(deps: SelfHostedWebhookDeps, ledger: SelfHostedWebhookReceiptLedger): ResendInboundSink {
  return async (parsed, routing) => {
    const scopes = await ledger.scopesFor(routing);
    if (scopes.length === 0) return null;
    const resolution = await deps.store.resolveInboundRecipients(routing.addresses);
    let firstId: string | null = null;
    for (const group of resolution.groups) {
      const scoped: TenantScopedStore = deps.store.forTenant(group.tenantId);
      const input: MessageInput = {
        from_addr: parsed.from_address || "(unknown sender)",
        // Only the recipients this tenant actually owns are stored on its row.
        to_addrs: group.recipients,
        cc_addrs: parsed.cc_addresses,
        subject: parsed.subject || null,
        body_text: parsed.text_body,
        body_html: parsed.html_body,
        status: "received",
        direction: "inbound",
        message_id: parsed.provider_message_id || null,
        provider_message_id: parsed.provider_message_id || null,
        received_at: parsed.received_at,
        is_read: false,
        headers: parsed.headers,
        attachments: [],
        // Stable upstream identity so a replay upserts instead of duplicating,
        // independent of the receipt ledger.
        source_id: `resend:${parsed.provider_message_id}`,
      };
      const { record } = await scoped.upsertMessage(input);
      if (firstId === null) firstId = record.id;
    }
    return firstId ? { id: firstId } : null;
  };
}

/** SES ingest through the SAME S3→Postgres path the SQS worker uses. */
function selfHostedSesIngest(
  deps: SelfHostedWebhookDeps,
  prefixDomainMappings: readonly InboundPrefixDomainMapping[],
) {
  return async (request: SesIngestRequest): Promise<SesIngestResult> => {
    if (!request.objectKey) {
      return { synced: 0, ignored: "notification has no S3 object key" };
    }
    const region = request.region ?? env(deps)["AWS_REGION"] ?? "us-east-1";
    const ingestDeps: IngestDeps = {
      store: deps.store,
      fetchObject: deps.fetchObject ?? ((bucket, key) => canonicalFetchObject(region, bucket, key)),
      now: deps.now ?? (() => new Date().toISOString()),
      // The SAME deployment-owned routing evidence the SQS worker reads, so the
      // push and pull paths can never disagree about where a recipient-less
      // notification routes. An absent mapping still fails closed.
      prefixDomainMappings,
    };
    const result = await ingestS3Object(ingestDeps, request.bucket, request.objectKey, {
      recipients: request.recipients,
      timestamp: request.timestamp,
    });
    // An error is NOT acknowledged: throwing keeps the receipt unwritten so SNS
    // redelivers (and the durable copy stays in S3).
    if (result.status === "error") {
      throw new Error(result.error ?? "inbound ingest failed");
    }
    if (result.status === "quarantined") {
      return { synced: 0, ignored: result.reason ?? "quarantined" };
    }
    return {
      synced: result.inserted ? 1 : 0,
      resourceId: result.id ?? null,
    };
  };
}

/** Handle `POST /v1/webhooks/ses-inbound`. */
export async function handleSelfHostedSesWebhook(
  deps: SelfHostedWebhookDeps,
  req: Request,
): Promise<Response> {
  // A malformed routing map is a DEPLOYMENT fault, so it fails closed as 503
  // (retryable) rather than surfacing as a 4xx that tells the provider to stop
  // redelivering mail this deployment is temporarily unable to route.
  let prefixDomainMappings: readonly InboundPrefixDomainMapping[];
  try {
    prefixDomainMappings = parseInboundPrefixDomainMap(env(deps)["EMAILS_INGEST_PREFIX_DOMAIN_MAP"]);
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "inbound routing map is invalid" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
  const ledger = new SelfHostedWebhookReceiptLedger(deps.store);
  return receiveSesNotification(req, {
    ledger,
    env: env(deps),
    inboundSource: () => selfHostedInboundSource(env(deps)),
    ingest: selfHostedSesIngest(deps, prefixDomainMappings),
    recordDeliveryEvent: selfHostedDeliveryEventSink(deps, ledger),
    verifySns: deps.verifySns,
    fetchUrl: deps.fetchUrl,
    route: "/v1/webhooks/ses-inbound",
  });
}

/** Handle `POST /v1/webhooks/resend-inbound`. */
export function handleSelfHostedResendWebhook(deps: SelfHostedWebhookDeps, req: Request): Promise<Response> {
  const ledger = new SelfHostedWebhookReceiptLedger(deps.store);
  return receiveResendEvent(req, {
    ledger,
    // Fails closed with 503 when the operator has not configured a secret.
    webhookSecret: () => env(deps)["RESEND_WEBHOOK_SECRET"],
    storeInbound: selfHostedResendInboundSink(deps, ledger),
    recordDeliveryEvent: selfHostedDeliveryEventSink(deps, ledger),
  });
}
