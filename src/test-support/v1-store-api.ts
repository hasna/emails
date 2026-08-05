// A `/v1` HTTP service for testing an Emails API CLIENT, backed by the store seam.
//
// WHY THIS EXISTS AND WHY IT IS NOT `v1-stub.ts`.
//
// `src/test-support/v1-stub.ts` is the out-of-process `/v1` stub the CLI, MCP and auth
// tests drive. It was the first thing checked, and it was not extended, for two
// reasons. Its in-memory model answers resource CRUD and auth well but has no mail
// semantics at all — no upsert on `source_id`, no keyset cursor, no folder predicates,
// no thread or mailbox rollups, no attachment inventory, no label merge — so making it
// serve this suite would have meant writing a THIRD implementation of message storage
// inside a test fixture, duplicating semantics the seam says exist exactly twice. And
// about twenty test files depend on its current behaviour, so changing its message
// handling would put unrelated suites at risk to serve this one.
//
// So this fixture stores NOTHING. It is a translation layer: HTTP in, `EmailStore`
// out. Every row it serves comes from a real store, which means a client that
// mis-maps a field, drops one, or misreads an envelope FAILS here rather than being
// handed its own mistake back. A fixture that kept its own dictionary would echo
// whatever it was given and prove nothing about the mapping — the exact weakness that
// makes "the client passes against its own mock" worthless as evidence.
//
// THE ROUTE CONTRACT IS THE REAL ONE. Paths, methods, envelopes (`{ domains: [...] }`
// / `{ domain: row }` for the bespoke families, `{ items: [...] }` plus a BARE row for
// the generic ones), status codes (201 on insert, 200 on an upsert match, 404
// `{error:"<name> not found"}`, 409 with a flat `reason`) and the flat
// `{ error, reason?, code? }` error body are all taken from
// src/server/self-hosted/service.ts. `src/store-http/routes.test.ts` checks the routes
// this fixture and the client agree on against the service's OWN OpenAPI document, so
// the contract is pinned to the server rather than to this file.
//
// WHERE THIS FIXTURE DIVERGES FROM THE REAL SERVICE — the complete list, because a
// fixture's divergences are exactly what its green result does not cover. Both were found
// by adversarial review rather than disclosed up front, which is the reason the list is
// stated as a list.
//
// The divergence that used to head this list is GONE, and the way it went is worth
// recording. `POST /v1/messages` here USED TO accept an outbound message while the real
// service answered 409 for anything not inbound — so four conformance cases passed against
// this fixture and would have failed against `/v1` (36 / 8 / 4 rather than 40 / 8 / 0).
// The fixture was modelling a route the service did not have. That route now exists
// (`POST /v1/messages/record`), this fixture serves it, and `POST /v1/messages` here
// answers the same 409 the service does — so the divergence was closed by building the
// missing surface, not by relaxing the fixture. `src/server/self-hosted/store-conformance.integration.test.ts`
// runs the same suite against the REAL service over HTTP, which is the check that keeps
// this list honest from now on.
//
// 1. NO ROLE MODEL. This fixture authenticates one bearer key and grants it everything.
//    The real service gates three routes this store writes through behind a tenant
//    owner/admin or an operator key: `POST /v1/send-keys/mint`, `PATCH /v1/send-keys/{id}`
//    (`writeRequiresOperator` on the send-keys spec) and `PATCH /v1/addresses/{id}` when
//    the body carries ownership fields. With a plain `emails:write` credential those
//    answer 403, so `mintSendKey`, `revokeSendKey` and `applyAddressOwnership` would
//    refuse — and the two ungated conformance cases that drive them would go red. The
//    client's 403 mapping is unit-tested directly instead; this fixture is not evidence
//    for those three operations, and the live integration run supplies an operator key so
//    that it is.
//
// 2. GONE, closed the same way as the headline divergence — by making the fixture match
//    the service rather than by relaxing anything. `PATCH /v1/send-keys/{id}` used to
//    IGNORE the `revoked_at` value it was sent, revoking with the backing store's own
//    clock; the real service persists the client's timestamp VERBATIM (`revoked_at` is a
//    writable column on the generic path), including stamping a second instant over a
//    key already revoked. That made the whole client-clock class — the weakness
//    send-keys.ts documents at length — unobservable here: the backing SQLite arm writes
//    `WHERE revoked_at IS NULL`, so a client that re-PATCHed on every repeat revoke
//    still read back a stable instant and looked idempotent. The fixture now persists
//    the client's value the way the service does. Because the seam deliberately has no
//    verbatim write for this column (`revokeSendKey(id)` takes no instant), the value
//    lives in a per-fixture response overlay over the send-keys routes — the ONE
//    narrowly scoped exception to "this fixture stores nothing", carrying exactly the
//    column whose service behaviour the seam cannot reproduce, so that a client which
//    stops guarding repeat revokes FAILS here instead of being handed idempotence it
//    does not have.

import { emailsSelfHostedOpenApi } from "../server/self-hosted/openapi.js";
import { SELF_HOSTED_RESOURCES } from "../server/self-hosted/resources.js";
// The service's OWN list, imported rather than copied: a second literal here could drift
// out of step with the route it claims to model, and this fixture's whole value is that
// its contract is the server's.
import { SEND_LEDGER_FIELDS } from "../server/self-hosted/service.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome } from "../store/outcome.js";
import type {
  AddressPatch,
  ListMessagesOptions,
  MessageFolder,
  MessageRecord,
  MessageStatusPatch,
  ResourceInput,
} from "../store/records.js";
import { MESSAGE_FOLDERS } from "../store/records.js";
import type { ResourceRepository } from "../store/repositories.js";
import { addressOwnershipLedgerOf } from "../store-address-ownership-ledger.js";
import { groupMembershipOf } from "../store-group-membership.js";
import { sequenceSubledgerOf } from "../store-sequence-subledger.js";

export interface V1StoreApi {
  /** Origin only, no trailing `/v1` — the shape `HttpEmailStoreOptions.baseUrl` takes. */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Requests served, so a test can assert a client did not chatter. */
  readonly requestCount: () => number;
  stop(): void;
}

export interface V1StoreApiOptions {
  /** The store every route reads and writes. */
  store: EmailStore;
  apiKey?: string;
}

const DEFAULT_API_KEY = "hasna_emails_store_api_fixture_key";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Translate a store refusal into the status the service would have answered with.
 *
 * The seam's refusal already carries a status, and for the codes that map cleanly it is
 * the service's own. `invalid_input`/422 becomes a 400 because that is what the service
 * sends for a rejected body, which is the direction a client has to be able to read.
 */
function refusalResponse(refusal: { code: string; message: string; status: number }): Response {
  if (refusal.code === "invalid_input") return json(400, { error: refusal.message });
  if (refusal.code === "ambiguous_id") {
    return json(409, { error: "ambiguous message id prefix", reason: "ambiguous_id" });
  }
  if (refusal.code === "capability_unavailable") {
    // The store behind this fixture cannot do it. Not a client error — surfaced as a
    // fault so a test sees the fixture's own limit rather than a plausible empty answer.
    return json(503, { error: refusal.message, reason: "fixture_store_capability" });
  }
  return json(refusal.status, { error: refusal.message, reason: refusal.code });
}

/** Unwrap an outcome, or hand back the response the service would have sent. */
function settled<TValue>(outcome: Outcome<TValue>): { value: TValue } | { response: Response } {
  if (!outcome.ok) return { response: refusalResponse(outcome) };
  return { value: outcome.value };
}

function notFound(name: string): Response {
  return json(404, { error: `${name} not found` });
}

/**
 * The message projection the service publishes: `idempotency_key` and
 * `send_payload_hash` removed, and NOTHING ELSE.
 *
 * Field-for-field `publicMessage` in src/server/self-hosted/service.ts, which destructures
 * exactly those two keys away and returns the rest untouched.
 *
 * An earlier version of this function ALSO re-projected each attachment — stripping
 * `content_base64` and adding a derived `content_available` — with a comment claiming the
 * service did the same. It does not. That was an undocumented divergence with a false
 * provenance note, in a fixture whose whole claim is that the route contract is the real
 * one, and adversarial review caught it. Nothing depended on it: the attachment route
 * serves bytes from the unprojected record either way, and `POST /v1/attachments/batch` is
 * where per-attachment availability is reported.
 */
function publicMessage(record: MessageRecord): Record<string, unknown> {
  const projected: Record<string, unknown> = { ...record };
  delete projected["idempotency_key"];
  delete projected["send_payload_hash"];
  return projected;
}

function stringParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Repeatable `domain`, lowercased and `@`-stripped, as the service reads it. */
function domainsParam(url: URL): string[] | undefined {
  const values = url.searchParams.getAll("domain");
  if (values.length === 0) return undefined;
  return values.flatMap((value) => value.split(",")).map((value) => value.replace(/^@/, "").trim().toLowerCase());
}

function isFolder(value: string): value is MessageFolder {
  return (MESSAGE_FOLDERS as readonly string[]).includes(value);
}

function messagesOptions(url: URL): ListMessagesOptions | Response {
  const folder = stringParam(url, "folder");
  if (folder !== undefined && !isFolder(folder)) {
    return json(400, { error: `folder must be one of ${MESSAGE_FOLDERS.join(", ")}` });
  }
  const direction = stringParam(url, "direction");
  const since = stringParam(url, "since");
  const options: ListMessagesOptions = {};
  const limit = intParam(url, "limit");
  if (limit !== undefined) options.limit = limit;
  const offset = intParam(url, "offset");
  if (offset !== undefined) options.offset = offset;
  const cursor = stringParam(url, "cursor");
  if (cursor !== undefined) options.cursor = cursor;
  if (direction === "inbound" || direction === "outbound") options.direction = direction;
  for (const [key, value] of [
    ["to", stringParam(url, "to")],
    ["from", stringParam(url, "from")],
    ["subject", stringParam(url, "subject")],
    ["search", stringParam(url, "search") ?? stringParam(url, "q")],
  ] as const) {
    if (value !== undefined) (options as Record<string, unknown>)[key] = value;
  }
  if (since !== undefined) options.since = since;
  const domains = domainsParam(url);
  if (domains !== undefined) options.domains = domains;
  if (folder !== undefined) options.folder = folder;
  return options;
}

/** Compose RFC 5322 bytes from a stored record — what the service reconstructs. */
function rawMime(record: MessageRecord): string {
  const headers: string[] = [
    `From: ${record.from_addr}`,
    `To: ${record.to_addrs.join(", ")}`,
  ];
  if (record.cc_addrs.length > 0) headers.push(`Cc: ${record.cc_addrs.join(", ")}`);
  if (record.subject !== null) headers.push(`Subject: ${record.subject}`);
  if (record.message_id !== null) headers.push(`Message-ID: ${record.message_id}`);
  if (record.in_reply_to !== null) headers.push(`In-Reply-To: ${record.in_reply_to}`);
  if (record.received_at !== null) headers.push(`Date: ${record.received_at}`);
  for (const [name, value] of Object.entries(record.headers)) headers.push(`${name}: ${String(value)}`);
  headers.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8");
  return `${headers.join("\r\n")}\r\n\r\n${record.body_text ?? ""}`;
}

/** The writable columns of one generic resource, from the service's own registry. */
function resourceColumns(path: string): Set<string> | null {
  const spec = SELF_HOSTED_RESOURCES.find((resource) => resource.path === path);
  if (!spec) return null;
  return new Set(spec.columns.map((column) => column.name));
}

/**
 * Keep only the columns the resource declares.
 *
 * FAITHFUL TO THE SERVICE ON PURPOSE, and it matters more than it looks: the real
 * generic route IGNORES an unknown body key and answers 201 with the field dropped. So
 * this fixture drops it too. If it instead refused, a client that had stopped
 * validating unknown columns would still see a refusal come back and its conformance
 * case would pass — the guard would be testing the fixture instead of the client.
 */
function keepDeclared(body: Record<string, unknown>, columns: Set<string>): ResourceInput {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (columns.has(key)) filtered[key] = value;
  }
  return filtered;
}

interface RouteContext {
  store: EmailStore;
  url: URL;
  method: string;
  body: Record<string, unknown>;
  /**
   * `send_keys.revoked_at` as the CLIENT wrote it, per key id — divergence note 2 in
   * the header. The service persists this column verbatim through its generic write
   * path and the seam has no verbatim write for it, so the fixture keeps the client's
   * value here and lays it over every send-keys answer.
   */
  sendKeyRevocations: Map<string, string>;
}

function familyFor(store: EmailStore, path: string): ResourceRepository<Record<string, unknown>> | null {
  // The sequence sub-ledger and the group membership ledger are carried by both
  // shipped stores but not declared on the seam yet, so they are probed rather than
  // read — a backing store without them simply does not serve those paths, which is
  // what the real service does for an unregistered resource.
  const subledger = sequenceSubledgerOf(store);
  const membership = groupMembershipOf(store);
  const ownershipLedger = addressOwnershipLedgerOf(store);
  const families: Record<string, ResourceRepository<Record<string, unknown>>> = {
    contacts: store.contacts,
    groups: store.groups,
    ...(membership === null ? {} : { "group-members": membership.groupMembers }),
    owners: store.owners,
    ...(ownershipLedger === null
      ? {}
      : { "address-ownership-events": ownershipLedger.addressOwnershipEvents }),
    providers: store.providers,
    templates: store.templates,
    sequences: store.sequences,
    ...(subledger === null
      ? {}
      : {
          "sequence-steps": subledger.sequenceSteps,
          "sequence-enrollments": subledger.sequenceEnrollments,
        }),
    scheduled: store.scheduled,
    aliases: store.aliases,
    forwarding: store.forwarding,
    warming: store.warming,
    events: store.events,
    "email-digests": store.emailDigests,
    "webhook-receipts": store.webhookReceipts,
    "sandbox-emails": store.sandbox,
  };
  return families[path] ?? null;
}

async function handleGenericResource(context: RouteContext, path: string, id: string | null): Promise<Response | null> {
  const columns = resourceColumns(path);
  if (columns === null) return null;
  const { store, url, method, body } = context;

  // `provisioning` and `send-keys` are served by their own repositories rather than by
  // a uniform family, because that is where the seam puts those operations.
  if (path === "provisioning") {
    if (method === "GET" && id === null) {
      // `offset` IS FORWARDED. It used to be dropped here (and on `send-keys` below) while
      // every other list route forwarded it, so a client paging this route received page one
      // over and over: an enumeration that pages to an empty page never terminates, and an
      // honest one reports "796 duplicates across 200 pages" for a table holding four rows.
      // The service this fixture stands in for honours it, so dropping it here made the
      // fixture WEAKER than production in a way no test could see.
      const listed = settled(await store.provisioning.listProvisioningEvents({
        limit: intParam(url, "limit") ?? 500,
        ...(intParam(url, "offset") === undefined ? {} : { offset: intParam(url, "offset") }),
      }));
      return "response" in listed ? listed.response : json(200, { items: listed.value });
    }
    if (method === "POST" && id === null) {
      const created = settled(await store.provisioning.recordProvisioningEvent(keepDeclared(body, columns)));
      return "response" in created ? created.response : json(201, created.value);
    }
    return json(405, { error: "method not allowed" });
  }

  if (path === "send-keys") {
    // The client-written `revoked_at`, laid over the backing store's row — see the
    // header's divergence note 2 for why this one column is fixture-held.
    const overlay = context.sendKeyRevocations;
    const withClientRevocation = (row: unknown): unknown => {
      if (typeof row !== "object" || row === null) return row;
      const record = row as Record<string, unknown>;
      const instant = overlay.get(String(record["id"]));
      return instant === undefined ? record : { ...record, revoked_at: instant };
    };
    if (method === "GET" && id === null) {
      const listed = settled(await store.sendKeys.listSendKeys({
        limit: intParam(url, "limit") ?? 500,
        ...(intParam(url, "offset") === undefined ? {} : { offset: intParam(url, "offset") }),
      }));
      return "response" in listed
        ? listed.response
        : json(200, { items: listed.value.map(withClientRevocation) });
    }
    if (method === "GET" && id !== null) {
      const read = settled(await store.sendKeys.getSendKey(id));
      if ("response" in read) return read.response;
      return read.value === null ? notFound("send-keys") : json(200, withClientRevocation(read.value));
    }
    if ((method === "PATCH" || method === "PUT") && id !== null) {
      // The generic path writes the `revoked_at` column; the seam expresses that write
      // as `revokeSendKey`, so a body naming it is served by that operation — with the
      // client's own instant persisted VERBATIM over the store's stamp, repeat writes
      // included, exactly as the service's generic updater applies it.
      if (!("revoked_at" in body)) return json(400, { error: "send-keys accepts no such update" });
      const revoked = settled(await store.sendKeys.revokeSendKey(id));
      if ("response" in revoked) return revoked.response;
      if (revoked.value === null) return notFound("send-keys");
      if (typeof body["revoked_at"] === "string") overlay.set(id, body["revoked_at"]);
      return json(200, withClientRevocation(revoked.value));
    }
    return json(405, { error: "method not allowed" });
  }

  const family = familyFor(store, path);
  if (family === null) return null;

  if (method === "GET" && id === null) {
    const filters: Record<string, string> = {};
    const spec = SELF_HOSTED_RESOURCES.find((resource) => resource.path === path);
    for (const filter of spec?.filters ?? []) {
      const value = url.searchParams.get(filter);
      if (value !== null) filters[filter] = value;
    }
    const listed = settled(
      await family.list({
        ...(intParam(url, "limit") === undefined ? {} : { limit: intParam(url, "limit") }),
        ...(intParam(url, "offset") === undefined ? {} : { offset: intParam(url, "offset") }),
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
      }),
    );
    return "response" in listed ? listed.response : json(200, { items: listed.value });
  }
  if (method === "POST" && id === null) {
    const created = settled(await family.create(keepDeclared(body, columns)));
    return "response" in created ? created.response : json(201, created.value);
  }
  if (method === "GET" && id !== null) {
    const read = settled(await family.get(id));
    if ("response" in read) return read.response;
    return read.value === null ? notFound(path) : json(200, read.value);
  }
  if ((method === "PATCH" || method === "PUT") && id !== null) {
    const updated = settled(await family.update(id, keepDeclared(body, columns)));
    if ("response" in updated) return updated.response;
    return updated.value === null ? notFound(path) : json(200, updated.value);
  }
  if (method === "DELETE" && id !== null) {
    const removed = settled(await family.remove(id));
    if ("response" in removed) return removed.response;
    return removed.value ? json(200, { deleted: true, id }) : notFound(path);
  }
  return json(405, { error: "method not allowed" });
}

const DOMAIN_PROVISIONING_FIELDS = [
  "provisioning_status",
  "purchase_provider",
  "dns_provider",
  "send_provider",
  "cf_zone_id",
  "registrar",
  "nameservers_json",
  "mail_from_domain",
  "last_error",
  "next_check_at",
];

const ADDRESS_PROVISIONING_FIELDS = [
  "domain_id",
  "receive_strategy",
  "forward_to",
  "routing_rule_id",
  "provisioning_status",
  "last_validated_at",
  "last_error",
  "next_check_at",
];

function subset(body: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in body) picked[field] = body[field];
  }
  return picked;
}

async function handleDomains(context: RouteContext, id: string | null): Promise<Response> {
  const { store, url, method, body } = context;
  if (id === null) {
    if (method === "GET") {
      const listed = settled(
        await store.domains.listDomains({
          ...(intParam(url, "limit") === undefined ? {} : { limit: intParam(url, "limit") }),
          ...(intParam(url, "offset") === undefined ? {} : { offset: intParam(url, "offset") }),
        }),
      );
      return "response" in listed ? listed.response : json(200, { domains: listed.value });
    }
    if (method === "POST") {
      const name = body["domain"];
      if (typeof name !== "string" || name.trim() === "") return json(400, { error: "domain is required" });
      const created = settled(
        await store.domains.createDomain({
          domain: name,
          ...(body["status"] === undefined ? {} : { status: String(body["status"]) }),
          ...(body["provider"] === undefined ? {} : { provider: body["provider"] as string | null }),
          ...(typeof body["verified"] === "boolean" ? { verified: body["verified"] } : {}),
          ...(body["notes"] === undefined ? {} : { notes: body["notes"] as string | null }),
        }),
      );
      return "response" in created ? created.response : json(201, { domain: created.value });
    }
    return json(405, { error: "method not allowed" });
  }
  if (method === "GET") {
    const read = settled(await store.domains.getDomain(id));
    if ("response" in read) return read.response;
    return read.value === null ? notFound("domain") : json(200, { domain: read.value });
  }
  if (method === "PATCH" || method === "PUT") {
    const core = {
      ...(body["status"] === undefined ? {} : { status: String(body["status"]) }),
      ...(body["provider"] === undefined ? {} : { provider: body["provider"] as string | null }),
      ...(typeof body["verified"] === "boolean" ? { verified: body["verified"] } : {}),
      ...(body["notes"] === undefined ? {} : { notes: body["notes"] as string | null }),
    };
    // A PATCH carrying only provisioning fields must not be turned into an empty core
    // update — the service applies the two independently, and an empty patch is not a
    // question this store should be asked.
    const patched = settled(
      Object.keys(core).length > 0
        ? await store.domains.updateDomain(id, core)
        : await store.domains.getDomain(id),
    );
    if ("response" in patched) return patched.response;
    if (patched.value === null) return notFound("domain");
    // Provisioning fields ride on the same PATCH, exactly as the service applies them.
    const provisioning = subset(body, DOMAIN_PROVISIONING_FIELDS);
    if (Object.keys(provisioning).length > 0) {
      const applied = settled(await store.provisioning.applyDomainProvisioning(id, provisioning));
      if ("response" in applied) return applied.response;
      if (applied.value !== null) return json(200, { domain: applied.value });
    }
    return json(200, { domain: patched.value });
  }
  if (method === "DELETE") {
    const removed = settled(await store.domains.deleteDomain(id));
    if ("response" in removed) return removed.response;
    return removed.value ? json(200, { deleted: true, id }) : notFound("domain");
  }
  return json(405, { error: "method not allowed" });
}

async function handleAddresses(context: RouteContext, id: string | null): Promise<Response> {
  const { store, url, method, body } = context;
  if (id === null) {
    if (method === "GET") {
      const listed = settled(
        await store.addresses.listAddresses({
          ...(intParam(url, "limit") === undefined ? {} : { limit: intParam(url, "limit") }),
          ...(intParam(url, "offset") === undefined ? {} : { offset: intParam(url, "offset") }),
        }),
      );
      return "response" in listed ? listed.response : json(200, { addresses: listed.value });
    }
    if (method === "POST") {
      const email = body["email"];
      if (typeof email !== "string" || !email.includes("@")) {
        return json(400, { error: "a valid email is required" });
      }
      const quota = body["daily_quota"];
      if (quota !== undefined && quota !== null && (!Number.isInteger(quota) || (quota as number) < 0)) {
        return json(400, { error: "daily_quota must be a non-negative integer or null" });
      }
      const created = settled(
        await store.addresses.createAddress({
          email,
          ...(body["display_name"] === undefined ? {} : { display_name: body["display_name"] as string | null }),
          ...(body["status"] === undefined ? {} : { status: String(body["status"]) }),
          ...(typeof body["verified"] === "boolean" ? { verified: body["verified"] } : {}),
          ...(quota === undefined ? {} : { daily_quota: quota as number | null }),
        }),
      );
      return "response" in created ? created.response : json(201, { address: created.value });
    }
    return json(405, { error: "method not allowed" });
  }
  if (method === "GET") {
    const read = settled(await store.addresses.getAddress(id));
    if ("response" in read) return read.response;
    return read.value === null ? notFound("address") : json(200, { address: read.value });
  }
  if (method === "PATCH" || method === "PUT") {
    // The service validates the quota BEFORE any write, so a refused request leaves no
    // partial update behind. A negative quota is a 400 here for the same reason.
    const quotaProvided = "daily_quota" in body;
    const quota = body["daily_quota"];
    if (quotaProvided && quota !== null && (!Number.isInteger(quota) || (quota as number) < 0)) {
      return json(400, { error: "daily_quota must be a non-negative integer or null" });
    }
    const patch: AddressPatch = {
      ...(body["display_name"] === undefined ? {} : { display_name: body["display_name"] as string | null }),
      ...(body["status"] === undefined ? {} : { status: String(body["status"]) }),
      ...(typeof body["verified"] === "boolean" ? { verified: body["verified"] } : {}),
      ...(quotaProvided ? { dailyQuotaSet: true, daily_quota: (quota ?? null) as number | null } : {}),
    };
    // As with domains: a PATCH carrying only provisioning or ownership fields is not an
    // empty core update.
    let current = settled(
      Object.keys(patch).length > 0
        ? await store.addresses.updateAddress(id, patch)
        : await store.addresses.getAddress(id),
    );
    if ("response" in current) return current.response;
    if (current.value === null) return notFound("address");
    const provisioning = subset(body, ADDRESS_PROVISIONING_FIELDS);
    if (Object.keys(provisioning).length > 0) {
      const applied = settled(await store.provisioning.applyAddressProvisioning(id, provisioning));
      if ("response" in applied) return applied.response;
      if (applied.value !== null) current = { value: applied.value };
    }
    const ownership = subset(body, ["owner_id", "administrator_id"]);
    if (Object.keys(ownership).length > 0) {
      const applied = settled(await store.addressLifecycle.applyAddressOwnership(id, ownership));
      if ("response" in applied) return applied.response;
      if (applied.value !== null) current = { value: applied.value };
    }
    return json(200, { address: current.value });
  }
  if (method === "DELETE") {
    const removed = settled(await store.addresses.deleteAddress(id));
    if ("response" in removed) return removed.response;
    return removed.value ? json(200, { deleted: true, id }) : notFound("address");
  }
  return json(405, { error: "method not allowed" });
}

async function handleMessageCollection(context: RouteContext): Promise<Response> {
  const { store, url, method } = context;
  if (method === "GET") {
    const options = messagesOptions(url);
    if (options instanceof Response) return options;
    const page = settled(await store.messages.listMessages(options));
    if ("response" in page) return page.response;
    return json(200, {
      messages: page.value.items,
      next_cursor: page.value.next_cursor,
    });
  }
  if (method !== "POST") return json(405, { error: "method not allowed" });

  const parsed = messageWriteInput(context.body);
  if ("response" in parsed) return parsed.response;
  // THE INBOUND-ONLY GUARD, as the service enforces it (service.ts). This fixture used
  // to accept an outbound row here and that was its headline divergence; recording one
  // now goes to `/v1/messages/record`, exactly as it does against the real service.
  if (parsed.input.direction !== "inbound") {
    return json(409, { error: "outbound messages must be sent through POST /v1/messages/send" });
  }
  return writeMessage(store, parsed.input);
}

/**
 * `POST /v1/messages/record` — persist a row in either direction, transmit nothing.
 *
 * The four send-ledger fields are refused with the service's own 400 and `reason`, so a
 * client that stopped refusing them locally is caught here rather than silently served.
 */
async function handleMessageRecord(context: RouteContext): Promise<Response> {
  if (context.method !== "POST") return json(405, { error: "method not allowed" });
  const ledgerFields = SEND_LEDGER_FIELDS.filter((field) => field in context.body);
  if (ledgerFields.length > 0) {
    return json(400, {
      error: `${ledgerFields.join(", ")} may only be written by POST /v1/messages/send`,
      reason: "send_ledger_field",
    });
  }
  const parsed = messageWriteInput(context.body);
  if ("response" in parsed) return parsed.response;
  return writeMessage(context.store, parsed.input);
}

/** With a source_id the write is an UPSERT: 201 on insert, 200 when it matched. */
async function writeMessage(store: EmailStore, input: MessageWrite): Promise<Response> {
  if (input.source_id !== undefined) {
    const upserted = settled(await store.messages.upsertMessage(input));
    if ("response" in upserted) return upserted.response;
    return json(upserted.value.inserted ? 201 : 200, { message: publicMessage(upserted.value.record) });
  }
  const created = settled(await store.messages.createMessage(input));
  return "response" in created ? created.response : json(201, { message: publicMessage(created.value) });
}

type MessageWrite = Parameters<EmailStore["messages"]["createMessage"]>[0];

/**
 * One body parser for both write routes, as the service has one — and coercing the way
 * the service coerces, which took three attempts to get right.
 *
 * The three corrections adversarial review found, each of which had made this fixture
 * disagree with `/v1` on an input the conformance cases do not send:
 *
 *  1. `direction` IS LEFT UNSTATED when the body does not state it and carries no inbound
 *     signal. Defaulting it to the literal `"outbound"` here meant a replay of
 *     `{from, to, source_id}` onto an existing INBOUND row flipped it to outbound, while
 *     the service omits `direction` from its conflict-time SET list and preserves it.
 *     That is a divergence on the exact operation the conditional upsert is about, so a
 *     green run here would have certified the opposite of the fix. The `!== "inbound"`
 *     guard on the import route still works: `undefined` is not `"inbound"`.
 *  2. `to` is TRIMMED before the emptiness test, as `service.ts` trims it. Without that,
 *     `to: "   "` was a 201 here storing a whitespace recipient and a 400 there.
 *  3. an EMPTY `source_id` is not a fence. Left as `""` the service stores it, and the
 *     partial unique index makes the second such write a 500.
 */
function messageWriteInput(body: Record<string, unknown>): { input: MessageWrite } | { response: Response } {
  const from = body["from"] ?? body["from_addr"];
  if (from === undefined || String(from).trim() === "") return { response: json(400, { error: "from is required" }) };
  const rawTo = body["to"] ?? body["to_addrs"];
  const to = Array.isArray(rawTo)
    ? rawTo.map((entry) => String(entry))
    : typeof rawTo === "string" && rawTo.trim() !== ""
      ? [rawTo.trim()]
      : [];
  if (to.length === 0) return { response: json(400, { error: "to is required" }) };

  const receivedAt = body["received_at"];
  const directionRaw = body["direction"] === undefined ? undefined : String(body["direction"]);
  if (directionRaw !== undefined && directionRaw !== "inbound" && directionRaw !== "outbound") {
    return { response: json(400, { error: "direction must be one of inbound, outbound" }) };
  }
  const direction = directionRaw ?? (receivedAt || body["message_id"] || body["in_reply_to"] ? "inbound" : undefined);
  const sourceId = body["source_id"] === undefined ? undefined : String(body["source_id"]) || undefined;

  const input = {
    from_addr: String(from).trim(),
    to_addrs: to,
    ...(direction === undefined ? {} : { direction }),
    ...(body["cc"] === undefined && body["cc_addrs"] === undefined
      ? {}
      : { cc_addrs: (body["cc"] ?? body["cc_addrs"]) as string[] }),
    ...(body["subject"] === undefined ? {} : { subject: body["subject"] as string | null }),
    ...(body["text"] === undefined && body["body_text"] === undefined
      ? {}
      : { body_text: (body["text"] ?? body["body_text"]) as string | null }),
    ...(body["html"] === undefined && body["body_html"] === undefined
      ? {}
      : { body_html: (body["html"] ?? body["body_html"]) as string | null }),
    ...(body["status"] === undefined ? {} : { status: String(body["status"]) }),
    ...(body["provider_message_id"] === undefined
      ? {}
      : { provider_message_id: body["provider_message_id"] as string | null }),
    ...(body["message_id"] === undefined ? {} : { message_id: body["message_id"] as string | null }),
    ...(body["in_reply_to"] === undefined ? {} : { in_reply_to: body["in_reply_to"] as string | null }),
    ...(receivedAt === undefined ? {} : { received_at: receivedAt as string | null }),
    ...(typeof body["is_read"] === "boolean" ? { is_read: body["is_read"] } : {}),
    ...(typeof body["is_starred"] === "boolean" ? { is_starred: body["is_starred"] } : {}),
    ...(body["labels"] === undefined ? {} : { labels: body["labels"] as string[] }),
    ...(body["headers"] === undefined ? {} : { headers: body["headers"] as Record<string, unknown> }),
    ...(body["attachments"] === undefined ? {} : { attachments: body["attachments"] as unknown[] }),
    ...(sourceId === undefined ? {} : { source_id: sourceId }),
  };
  return { input };
}

async function handleMessageById(context: RouteContext, id: string): Promise<Response> {
  const { store, method, body } = context;
  if (method === "GET") {
    // Prefix resolution happens inside the by-id routes, as it does on the service.
    const resolved = await store.messages.resolveMessageId(id);
    if (!resolved.ok) {
      return resolved.code === "ambiguous_id"
        ? json(409, { error: "ambiguous message id prefix", reason: "ambiguous_id" })
        : notFound("message");
    }
    const read = settled(await store.messages.getMessage(resolved.value.id));
    if ("response" in read) return read.response;
    return read.value === null ? notFound("message") : json(200, { message: publicMessage(read.value) });
  }
  if (method === "PATCH" || method === "PUT") {
    const patch: MessageStatusPatch = {
      ...(body["status"] === undefined ? {} : { status: String(body["status"]) }),
      ...(body["provider_message_id"] === undefined
        ? {}
        : { provider_message_id: body["provider_message_id"] as string | null }),
      ...(typeof body["is_read"] === "boolean" ? { is_read: body["is_read"] } : {}),
      ...(typeof body["is_starred"] === "boolean" ? { is_starred: body["is_starred"] } : {}),
      ...(typeof body["archived"] === "boolean" ? { archived: body["archived"] } : {}),
      ...(body["add_label"] === undefined ? {} : { add_label: String(body["add_label"]) }),
      ...(body["remove_label"] === undefined ? {} : { remove_label: String(body["remove_label"]) }),
    };
    const patched = settled(await store.messages.updateMessageStatus(id, patch));
    if ("response" in patched) return patched.response;
    return patched.value === null ? notFound("message") : json(200, { message: publicMessage(patched.value) });
  }
  if (method === "DELETE") {
    const removed = settled(await store.messages.deleteMessage(id));
    if ("response" in removed) return removed.response;
    return removed.value ? json(200, { deleted: true, id }) : notFound("message");
  }
  return json(405, { error: "method not allowed" });
}

/**
 * Attachment bytes, served from the UNPROJECTED record.
 *
 * The three states are the service's: 200 with the payload, 409
 * `attachment_content_unavailable` when metadata exists without bytes, 404 when the
 * message or the index does not exist. This route does NOT resolve an id prefix, also
 * matching the service.
 */
async function handleAttachmentBytes(context: RouteContext, id: string, index: number): Promise<Response> {
  const read = settled(await context.store.messages.getMessage(id));
  if ("response" in read) return read.response;
  if (read.value === null) return json(404, { error: "message not found", code: "message_not_found" });
  const element = read.value.attachments[index];
  if (element === undefined || typeof element !== "object" || element === null) {
    return json(404, { error: "attachment not found", code: "attachment_not_found" });
  }
  const attachment = element as Record<string, unknown>;
  const filename = typeof attachment["filename"] === "string" ? attachment["filename"] : "";
  const contentType = typeof attachment["content_type"] === "string" ? attachment["content_type"] : "";
  const size = typeof attachment["size"] === "number" ? attachment["size"] : null;
  const content = attachment["content_base64"];
  if (typeof content !== "string") {
    return json(409, {
      error: "attachment content is not stored",
      code: "attachment_content_unavailable",
      attachment: { filename, content_type: contentType, size },
    });
  }
  return json(200, {
    attachment: { filename, content_type: contentType, size: size ?? content.length, content_base64: content },
  });
}

/** Per-message attachment metadata, derived from the records the store holds. */
async function handleAttachmentBatch(context: RouteContext): Promise<Response> {
  const ids = context.body["message_ids"];
  if (!Array.isArray(ids) || ids.length === 0) {
    return json(400, { error: "message_ids is required", code: "empty_message_ids" });
  }
  if (ids.length > 200) {
    return json(400, { error: "too many message ids", code: "batch_too_large", max_batch_size: 200 });
  }
  const byMessageId: Record<string, unknown[]> = {};
  const unknownIds: string[] = [];
  for (const raw of ids) {
    const id = String(raw);
    const read = settled(await context.store.messages.getMessage(id));
    if ("response" in read) return read.response;
    if (read.value === null) {
      unknownIds.push(id);
      continue;
    }
    byMessageId[id] = read.value.attachments.map((element, index) => {
      const attachment = (typeof element === "object" && element !== null ? element : {}) as Record<string, unknown>;
      const size = attachment["size"];
      return {
        attachment_index: index,
        filename: typeof attachment["filename"] === "string" ? attachment["filename"] : null,
        content_type: typeof attachment["content_type"] === "string" ? attachment["content_type"] : null,
        size_bytes: typeof size === "number" ? size : null,
        sha256: typeof attachment["sha256"] === "string" ? attachment["sha256"] : null,
        content_available: typeof attachment["content_base64"] === "string",
      };
    });
  }
  return json(200, { by_message_id: byMessageId, unknown_ids: unknownIds, max_batch_size: 200 });
}

async function route(context: RouteContext): Promise<Response> {
  const { store, url, method } = context;
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/v1/openapi.json") {
    // The REAL document, so a client validating against the published contract is
    // validating against the service's own generated schema.
    return json(200, emailsSelfHostedOpenApi);
  }

  if (path === "/v1/messages") return handleMessageCollection(context);
  // Before the `/v1/messages/{id}` matcher below, as it is on the service — otherwise
  // "record" is read as an abbreviated message id.
  if (path === "/v1/messages/record") return handleMessageRecord(context);
  if (path === "/v1/messages/counts") {
    if (method !== "GET") return json(405, { error: "method not allowed" });
    const domains = domainsParam(url);
    const counts = settled(await store.messages.messageCounts(domains ? { domains } : undefined));
    return "response" in counts ? counts.response : json(200, { counts: counts.value });
  }
  if (path === "/v1/messages/threads") {
    if (method !== "GET") return json(405, { error: "method not allowed" });
    const threads = settled(
      await store.threads.listThreads({
        ...(intParam(url, "limit") === undefined ? {} : { limit: intParam(url, "limit") }),
        ...(intParam(url, "offset") === undefined ? {} : { offset: intParam(url, "offset") }),
      }),
    );
    return "response" in threads ? threads.response : json(200, { threads: threads.value });
  }
  if (path === "/v1/mailboxes") {
    if (method !== "GET") return json(405, { error: "method not allowed" });
    const rollup = settled(await store.threads.listMailboxes());
    return "response" in rollup
      ? rollup.response
      : json(200, { mailboxes: rollup.value.mailboxes, counts: rollup.value.counts });
  }
  if (path === "/v1/attachments") {
    if (method !== "GET") return json(405, { error: "method not allowed" });
    const direction = stringParam(url, "direction");
    if (direction !== undefined && direction !== "inbound" && direction !== "outbound") {
      return json(400, { error: "direction must be inbound or outbound", code: "invalid_direction" });
    }
    const inventory = settled(
      await store.emailContent.listAttachments({
        ...(intParam(url, "limit") === undefined ? {} : { limit: intParam(url, "limit") }),
        ...(stringParam(url, "cursor") === undefined ? {} : { cursor: stringParam(url, "cursor") }),
        ...(direction === undefined ? {} : { direction }),
        ...(stringParam(url, "since") === undefined ? {} : { since: stringParam(url, "since") }),
      }),
    );
    return "response" in inventory
      ? inventory.response
      : json(200, { items: inventory.value.items, next_cursor: inventory.value.next_cursor });
  }
  if (path === "/v1/attachments/batch") {
    if (method !== "POST") return json(405, { error: "method not allowed" });
    return handleAttachmentBatch(context);
  }
  if (path === "/v1/send-keys/mint") {
    if (method !== "POST") return json(405, { error: "method not allowed" });
    const ownerId = context.body["owner_id"];
    if (typeof ownerId !== "string" || ownerId === "") return json(400, { error: "owner_id is required" });
    const minted = settled(
      await store.sendKeys.mintSendKey({
        owner_id: ownerId,
        ...(context.body["label"] === undefined ? {} : { label: context.body["label"] as string | null }),
      }),
    );
    // Unwrapped `{ token, key }`, as the service answers.
    return "response" in minted ? minted.response : json(201, { token: minted.value.token, key: minted.value.key });
  }
  if (path === "/v1/send-keys/verify") {
    if (method !== "POST") return json(405, { error: "method not allowed" });
    const token = context.body["token"];
    if (typeof token !== "string" || token === "") return json(400, { error: "token is required" });
    const verified = settled(await store.sendKeys.verifySendKey(token));
    if ("response" in verified) return verified.response;
    if (verified.value === null) return json(200, { valid: false, authorized: false, key: null });
    return json(200, { valid: true, authorized: false, key: verified.value });
  }

  const rawMatch = /^\/v1\/messages\/([^/]+)\/raw$/.exec(path);
  if (rawMatch) {
    if (method !== "GET") return json(405, { error: "method not allowed" });
    const resolved = await store.messages.resolveMessageId(decodeURIComponent(rawMatch[1] as string));
    if (!resolved.ok) {
      return resolved.code === "ambiguous_id"
        ? json(409, { error: "ambiguous message id prefix", reason: "ambiguous_id" })
        : notFound("message");
    }
    const read = settled(await store.messages.getMessage(resolved.value.id));
    if ("response" in read) return read.response;
    if (read.value === null) return notFound("message");
    // Unwrapped `{ raw, message_id }`, as the service answers.
    return json(200, { raw: rawMime(read.value), message_id: read.value.message_id });
  }

  const attachmentMatch = /^\/v1\/messages\/([^/]+)\/attachments\/(\d+)$/.exec(path);
  if (attachmentMatch) {
    if (method !== "GET") return json(405, { error: "method not allowed" });
    return handleAttachmentBytes(
      context,
      decodeURIComponent(attachmentMatch[1] as string),
      Number(attachmentMatch[2]),
    );
  }

  const messageMatch = /^\/v1\/messages\/([^/]+)$/.exec(path);
  if (messageMatch) return handleMessageById(context, decodeURIComponent(messageMatch[1] as string));

  if (path === "/v1/domains") return handleDomains(context, null);
  const domainMatch = /^\/v1\/domains\/([^/]+)$/.exec(path);
  if (domainMatch) return handleDomains(context, decodeURIComponent(domainMatch[1] as string));

  if (path === "/v1/addresses") return handleAddresses(context, null);
  const addressMatch = /^\/v1\/addresses\/([^/]+)$/.exec(path);
  if (addressMatch) return handleAddresses(context, decodeURIComponent(addressMatch[1] as string));

  const generic = /^\/v1\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (generic) {
    const handled = await handleGenericResource(
      context,
      generic[1] as string,
      generic[2] === undefined ? null : decodeURIComponent(generic[2]),
    );
    if (handled) return handled;
  }

  return json(404, { error: "not found" });
}

/**
 * Start the service on an OS-assigned loopback port.
 *
 * In-process rather than spawned: the store it serves lives in this process, and a
 * subprocess would need its own copy — which would put the fixture back in the business
 * of storing things.
 */
export function startV1StoreApi(options: V1StoreApiOptions): V1StoreApi {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  let served = 0;
  // Per-fixture, not per-request: the client-written revocation instant has to survive
  // across calls to be readable back, exactly as the service's column does.
  const sendKeyRevocations = new Map<string, string>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request: Request): Promise<Response> {
      served += 1;
      const url = new URL(request.url);
      // Auth on every route but the published contract, which the service also serves
      // unauthenticated.
      if (url.pathname !== "/v1/openapi.json") {
        const header = request.headers.get("authorization") ?? "";
        const bearer = /^Bearer\s+(.+)$/i.exec(header);
        if (!bearer || bearer[1] !== apiKey) {
          return json(401, { error: "authentication required", reason: "missing_token" });
        }
      }
      let body: Record<string, unknown> = {};
      if (request.method !== "GET" && request.method !== "DELETE") {
        const text = await request.text();
        if (text.length > 0) {
          try {
            const parsed = JSON.parse(text) as unknown;
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              return json(400, { error: "invalid request body: expected an object" });
            }
            body = parsed as Record<string, unknown>;
          } catch (error) {
            return json(400, { error: `invalid request body: ${(error as Error).message}` });
          }
        }
      }
      try {
        return await route({ store: options.store, url, method: request.method, body, sendKeyRevocations });
      } catch (error) {
        // A THROW from the store is a fault, and the service answers 500 for one. It is
        // reported rather than swallowed so a broken fixture is not read as a refusal.
        return json(500, { error: `internal error: ${(error as Error).message}` });
      }
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiKey,
    requestCount: () => served,
    stop(): void {
      server.stop(true);
    },
  };
}
