// HttpEmailStore — a client of an Emails `/v1` API, behind the seam.
//
// The second and LAST implementation of `EmailStore`. There is no client-side
// Postgres store and there will not be one: Postgres is this service's internal
// storage and is reached only through the routes below, never as a client transport.
//
// ASSEMBLED FROM TYPED OBJECT LITERALS, exactly as the SQLite store is — no base
// class, no `implements`, no defaults merged at runtime, and nothing borrowed from the
// other implementation. A method the seam gains and this store forgets is a `tsc`
// error at the assignment in `createHttpEmailStore`, not an inherited stub that
// answers a call nobody wrote.
//
// EVERYTHING IS ASYNC AND EVERYTHING IS `fetch`. This store is the reason the seam
// requires it. Its predecessor shelled out to `curl` through `spawnSync` to make a
// network call look blocking, and that pretence is what made the old arm structurally
// unable to be honest. Nothing here imports that module; it dies with this refactor.
//
// NO CONSUMER READS THIS YET, by design — the same position the SQLite store is in.
// It is exported from `@hasna/emails/storage` so it is reachable from a shipped
// entrypoint (an unimported module rots while its own tests stay green), and its only
// callers are its own test and the shared conformance suite.

import type { StoreCapabilities } from "../store/capabilities.js";
import type { StoreDescriptor } from "../store/descriptor.js";
import type { EmailStore } from "../store/email-store.js";
import { createAttachmentRepairRepository, createSendIntentsRepository } from "./ledger.js";
import {
  createEmailContentRepository,
  createInboundRepository,
  createMessagesRepository,
  createThreadsRepository,
} from "./messages.js";
import { HTTP_STORE_KIND } from "./outcome.js";
import {
  createAddressLifecycleRepository,
  createAddressesRepository,
  createDomainsRepository,
  createProvisioningRepository,
} from "./registry.js";
import { createResourceGateways, createResourceRepository, type ResourceGateway } from "./resources.js";
import { RESOURCE_PATHS } from "./routes.js";
import { createSendKeysRepository } from "./send-keys.js";
import { createTransport, toV1BaseUrl, type FetchImplementation } from "./wire.js";

/**
 * What this store can do, and — for everything it cannot — the missing route, stated
 * against the service's own router rather than against convenience.
 *
 *   keysetPagination  TRUE   `GET /v1/messages` and `GET /v1/attachments` are cursor
 *                            routes that return `next_cursor`, so a resumed scan
 *                            re-enters at exactly the next row.
 *   attachmentContent TRUE   `GET /v1/messages/{id}/attachments/{index}` answers the
 *                            three-state lookup — bytes, metadata-without-bytes
 *                            (409 `attachment_content_unavailable`), or absent — and
 *                            `POST /v1/attachments/batch` reports per-row availability.
 *   rawMessage        TRUE   `GET /v1/messages/{id}/raw`.
 *   mailRollups       TRUE   `GET /v1/messages/threads` and `GET /v1/mailboxes`.
 *   sendIntentLedger  FALSE  `reserveSendIntent` has NO route: nothing records an
 *                            intent except `POST /v1/messages/send`, which reserves
 *                            AND dispatches in one operation. Claim, complete, fail,
 *                            mark-uncertain, re-arm are internal to that path too. A
 *                            ledger that can be read but not written is not a ledger.
 *   outboundPolicy    FALSE  `evaluateOutboundPolicy` and `getAddressSendability` have
 *                            NO routes; policy is evaluated only inside the send path
 *                            and never exposed as a probe.
 *   attachmentRepair  FALSE  the three ENTRY operations have NO routes; repair entries
 *                            are claimed only inside the service's page processor, so
 *                            no client can hold the lease the rewrite happens under.
 *
 * See ledger.ts for the argument against wiring the readable halves of the two false
 * ledger families, which is the mistake this table is most exposed to.
 */
export const HTTP_STORE_CAPABILITIES: StoreCapabilities = Object.freeze({
  keysetPagination: true,
  attachmentContent: true,
  rawMessage: true,
  mailRollups: true,
  sendIntentLedger: false,
  outboundPolicy: false,
  attachmentRepair: false,
});

/**
 * One seam operation that `/v1` cannot serve, and the route that would serve it.
 *
 * THIS LIST IS A DELIVERABLE, not documentation. It is the scope of what a later phase
 * has to build server-side before this store can stop refusing, and it is exported —
 * and pinned by a test — so it cannot quietly shrink by a capability being flipped to
 * true without a route appearing.
 *
 * `capability` is null for the entries that are NOT capability-shaped — the seam declares
 * those operations ungated, so there is no capability to declare false and no refusal to
 * hide behind. Every remaining null entry is therefore SERVED, by composing routes that
 * do exist; what is missing is a cheaper or more atomic verb, and each entry says which.
 *
 * That was not always true. The list used to open with one null entry that was not served
 * at all — see the note above the table — and closing it is what made "ungated means
 * implemented" hold for every operation on this store rather than for most of them.
 */
export interface MissingRoute {
  /** The seam operations that need it. */
  operations: string[];
  /** The capability that is declared false because of it, or null. */
  capability: string | null;
  /** The route that would serve it. */
  wanted: string;
  /** What the store does today. */
  today: string;
}

// CLOSED, and recorded here because a deleted entry is invisible in review:
// `createMessage` / `upsertMessage` used to head this list. `POST /v1/messages` answers
// 409 for anything not inbound and `POST /v1/messages/send` dispatches real mail, so
// there was NO WAY to record an outbound message without sending it — and because the
// seam leaves those two operations ungated, there was no capability to declare false and
// therefore no legal refusal either. That entry was the only one in this list with no
// honest answer available. `POST /v1/messages/record` now serves both operations in
// either direction; `POST /v1/messages` keeps its 409 unchanged.
export const HTTP_STORE_MISSING_ROUTES: readonly MissingRoute[] = Object.freeze([
  {
    operations: [
      "lookupSendIntent",
      "reserveSendIntent",
      "claimSendIntent",
      "completeSendIntent",
      "markSendFailed",
      "cancelSendIntent",
      "listUncertainSendIntents",
      "markSendUncertain",
      "rearmFailedSendIntent",
      "reconcileUncertainSendIntent",
    ],
    capability: "sendIntentLedger",
    wanted:
      "POST /v1/messages/send-intents/reserve, .../{id}/claim, .../{id}/complete, .../{id}/fail, " +
      ".../{id}/uncertain, .../{id}/rearm",
    today:
      "the four readable routes (lookup, cancel, reconcile, uncertain) exist; every WRITE that " +
      "advances the ledger is internal to POST /v1/messages/send. Capability false, all ten refuse " +
      "(markSendBlocked and evaluateOutboundPolicy are the other two of the family's twelve, and are " +
      "gated on outboundPolicy instead — see the next entry).",
  },
  {
    operations: ["evaluateOutboundPolicy", "getAddressSendability", "markSendBlocked", "isOwnerAuthorizedFrom"],
    capability: "outboundPolicy",
    wanted: "POST /v1/outbound-policy/evaluate, GET /v1/addresses/{id}/sendability",
    today:
      "evaluateOutboundPolicy and getAddressSendability genuinely have NO route — policy is " +
      "evaluated only inside POST /v1/messages/send and never exposed as a probe. A prior client " +
      "answered getAddressSendability from the address row with sent_today: 0 — a fabricated " +
      "number for a question about quota. isOwnerAuthorizedFrom is the exception worth stating " +
      "precisely, because an earlier version of this note got it wrong: POST /v1/send-keys/verify " +
      "DOES answer an `authorized` field, so a route exists — but it answers only for a TOKEN it " +
      "is handed, and this operation is asked about an OWNER ID. Serving it would mean minting a " +
      "durable send key to answer a read-only question, which is a worse trade than refusing. " +
      "The capability is all-or-nothing, so all four refuse.",
  },
  {
    operations: [
      "createOrGetAttachmentRepairRun",
      "getAttachmentRepairRun",
      "listPendingAttachmentRepairEntries",
      "claimAttachmentRepairEntry",
      "recordAttachmentRepairEntryOutcome",
    ],
    capability: "attachmentRepair",
    wanted:
      "GET /v1/attachments/repairs/{id}/entries, POST /v1/attachments/repairs/{id}/entries/{entryId}/claim, " +
      "POST /v1/attachments/repairs/{id}/entries/{entryId}/outcome",
    today:
      "run create/resume/get exist but take a manifest body the seam's operation does not carry; the " +
      "three ENTRY operations have no routes, so no client can hold the repair lease. Capability " +
      "false, all five refuse.",
  },
  {
    operations: ["getDomainByName"],
    capability: null,
    wanted: "GET /v1/domains?domain=<name>",
    today:
      "COMPOSED, correctly but expensively: GET /v1/domains accepts no filters, so this pages the " +
      "whole domain list at 500 rows a request and matches client-side. O(domains) per lookup.",
  },
  {
    operations: ["clearInboundEmails"],
    capability: null,
    wanted: "DELETE /v1/messages?domain=<name>&direction=inbound",
    today:
      "COMPOSED: there is no bulk delete, so the scoped list is drained and each row deleted " +
      "individually. Not atomic — a concurrent write during the sweep is not covered by it.",
  },
  {
    operations: ["revokeSendKey"],
    capability: null,
    wanted: "POST /v1/send-keys/{id}/revoke",
    today:
      "COMPOSED as PATCH /v1/send-keys/{id} stamping revoked_at, so the revocation instant comes " +
      "from THIS CLIENT'S CLOCK rather than the service's. Under skew a revocation audit reads a " +
      "client's time as the server's.",
  },
  {
    operations: ["suspendAddress", "activateAddress", "setAddressQuota"],
    capability: null,
    wanted: "POST /v1/addresses/{id}/suspend, .../activate, PUT /v1/addresses/{id}/quota",
    today:
      "COMPOSED as PATCH /v1/addresses/{id} with the field each operation names. The write is real " +
      "and the service's own row is returned; only a dedicated verb is missing. Lowest-priority entry.",
  },
  {
    operations: ["resolveMessageId"],
    capability: null,
    wanted: "GET /v1/messages/{idOrPrefix}/resolve",
    today:
      "COMPOSED: prefix resolution happens INSIDE each by-id route but is not exposed, so this reads " +
      "the whole message to learn its id. Correct, and heavier than the question deserves.",
  },
  {
    operations: ["contacts.create", "contacts.update", "and every other uniform family write"],
    capability: null,
    wanted: "a 400 from POST/PATCH /v1/<resource> when the body names a column the resource lacks",
    today:
      "the generic route IGNORES an unknown body key and answers 201, so the write is accepted with " +
      "the field dropped. This store reads GET /v1/openapi.json — generated from the same resource " +
      "registry the router dispatches on — and refuses the write itself. Correct, but it costs a " +
      "request and it validates against the contract rather than against the table.",
  },
]);

export interface HttpEmailStoreOptions {
  /**
   * The service origin, with or without a trailing `/v1`.
   *
   * Not read from the environment here. A store takes its configuration from its
   * caller so a test can point it at a fixture without setting a process-wide variable,
   * and so nothing in this directory reads a deployment mode.
   */
  baseUrl: string;
  /** An API key or a session token. Sent as a bearer credential and never logged. */
  credential: string;
  /** Injectable `fetch`, for tests and for callers with their own agent. */
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
  /** Diagnostics text. Defaults to the credential-free origin. */
  detail?: string;
}

/**
 * Diagnostics identity. `kind` is `"api"`, and branching on it is forbidden — see
 * descriptor.ts. `detail` carries the ORIGIN ONLY: `toV1BaseUrl` strips userinfo, the
 * query string and the fragment, because this string is the one most likely to reach a
 * log and the credential travels beside it on every request.
 */
export function httpStoreDescriptor(baseUrl: string, detail?: string): StoreDescriptor {
  const { safeBase } = toV1BaseUrl(baseUrl);
  return Object.freeze({
    kind: HTTP_STORE_KIND,
    detail: detail ?? `Emails API at ${safeBase}`,
  });
}

/** Look a gateway up by family, failing loudly rather than handing back undefined. */
function gateway(gateways: Record<string, ResourceGateway>, family: string): ResourceGateway {
  const found = gateways[family];
  if (!found) throw new Error(`no /v1 resource path is wired for the ${family} family`);
  return found;
}

export function createHttpEmailStore(options: HttpEmailStoreOptions): EmailStore {
  const transport = createTransport({
    baseUrl: options.baseUrl,
    credential: options.credential,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const gateways = createResourceGateways(transport, RESOURCE_PATHS);

  return {
    descriptor: httpStoreDescriptor(options.baseUrl, options.detail),
    capabilities: HTTP_STORE_CAPABILITIES,

    domains: createDomainsRepository(transport),
    addresses: createAddressesRepository(transport),
    addressLifecycle: createAddressLifecycleRepository(transport),
    provisioning: createProvisioningRepository(transport, gateway(gateways, "provisioning")),
    messages: createMessagesRepository(transport),
    emailContent: createEmailContentRepository(transport),
    inbound: createInboundRepository(transport),
    threads: createThreadsRepository(transport),
    sandbox: createResourceRepository(gateway(gateways, "sandbox")),
    emailDigests: createResourceRepository(gateway(gateways, "emailDigests")),
    scheduled: createResourceRepository(gateway(gateways, "scheduled")),
    events: createResourceRepository(gateway(gateways, "events")),
    webhookReceipts: createResourceRepository(gateway(gateways, "webhookReceipts")),
    contacts: createResourceRepository(gateway(gateways, "contacts")),
    groups: createResourceRepository(gateway(gateways, "groups")),
    sequences: createResourceRepository(gateway(gateways, "sequences")),
    templates: createResourceRepository(gateway(gateways, "templates")),
    owners: createResourceRepository(gateway(gateways, "owners")),
    providers: createResourceRepository(gateway(gateways, "providers")),
    sendKeys: createSendKeysRepository(transport),
    aliases: createResourceRepository(gateway(gateways, "aliases")),
    forwarding: createResourceRepository(gateway(gateways, "forwarding")),
    warming: createResourceRepository(gateway(gateways, "warming")),

    sendIntents: createSendIntentsRepository(),
    attachmentRepair: createAttachmentRepairRepository(),
  };
}
