// Every `/v1` route this store calls, in ONE table.
//
// WHY A TABLE AND NOT STRING LITERALS AT THE CALL SITES: this list is the store's
// claim about what the API offers, and a claim that lives in twenty template
// literals cannot be checked. Because it is one exported table, a test asserts every
// entry EXISTS with that method in the service's own OpenAPI document
// (`emailsSelfHostedOpenApi`), which is generated from the same resource registry
// the router dispatches on. So the route surface this client depends on is verified
// against the SERVER, not against the test fixture it happens to run under — the
// difference between evidence and circular reasoning.
//
// It is also the honest inverse of the capability declaration: a capability is TRUE
// here only because a route below backs it, and the routes that are ABSENT from this
// table are exactly the missing server surface listed in index.ts.
//
// PATH TEMPLATES ARE SPELLED THE WAY OPENAPI SPELLS THEM (`{id}`, `{index}`) so the
// comparison is a string equality rather than a translation nobody would re-derive.

/** An HTTP method this store issues. */
export type RouteMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface RouteUse {
  method: RouteMethod;
  /** OpenAPI-style path template, including the `/v1` prefix. */
  template: string;
  /** Which seam operations reach it, so an unused route is visible in review. */
  operations: string[];
}

/**
 * The uniform resource families this store exposes, mapped to their `/v1` path
 * segment.
 *
 * The seam names a family (`emailDigests`); the API names a path (`email-digests`);
 * `sandbox` is served at `sandbox-emails`, which no mechanical transformation of the
 * seam's name produces. This map is the ONLY place that correspondence is written
 * down, and the family list is checked against `EmailStore` by the store's test
 * rather than trusted.
 */
export const RESOURCE_PATHS: Readonly<Record<string, string>> = Object.freeze({
  contacts: "contacts",
  groups: "groups",
  /**
   * NOT a seam family either. The group membership ledger
   * (src/store-group-membership.ts) rides the same generic CRUD path over a resource
   * the service registers beside `groups`; `EmailStore` does not declare it yet, so —
   * like the sequence sub-ledger below — it is excluded from the family check.
   */
  groupMembers: "group-members",
  owners: "owners",
  /**
   * NOT a seam family either. The address-ownership audit ledger
   * (src/store-address-ownership-ledger.ts) rides the same generic CRUD path over a
   * resource the service registers beside `owners`; `EmailStore` does not declare it
   * yet, so — like the sequence sub-ledger below — it is excluded from the family
   * check.
   */
  addressOwnershipEvents: "address-ownership-events",
  providers: "providers",
  templates: "templates",
  sequences: "sequences",
  /**
   * NOT seam families either. The sequence sub-ledger
   * (src/store-sequence-subledger.ts) rides the same generic CRUD path over two
   * resources the service registers beside `sequences`; `EmailStore` does not declare
   * them yet, so — like `provisioning` — they are excluded from the family check.
   */
  sequenceSteps: "sequence-steps",
  sequenceEnrollments: "sequence-enrollments",
  scheduled: "scheduled",
  aliases: "aliases",
  forwarding: "forwarding",
  warming: "warming",
  events: "events",
  emailDigests: "email-digests",
  webhookReceipts: "webhook-receipts",
  sandbox: "sandbox-emails",
  /**
   * NOT a seam family. `provisioning` is the resource the provisioning-event log is
   * served through, and `ProvisioningRepository` reaches it for
   * `recordProvisioningEvent` / `listProvisioningEvents` while its other two
   * operations patch a domain or an address. Listed here because it is the same
   * generic CRUD path, and excluded from the family check for the same reason.
   */
  provisioning: "provisioning",
});

/** Entries in the path map that are NOT repositories on `EmailStore`. */
const NOT_SEAM_FAMILIES = new Set([
  "provisioning",
  "groupMembers",
  "sequenceSteps",
  "sequenceEnrollments",
  "addressOwnershipEvents",
]);

/** The families that are `ResourceRepository`s on `EmailStore`. */
export const RESOURCE_FAMILIES: readonly string[] = Object.freeze(
  Object.keys(RESOURCE_PATHS).filter((family) => !NOT_SEAM_FAMILIES.has(family)),
);

function resourceRoutes(): RouteUse[] {
  return Object.values(RESOURCE_PATHS).flatMap((path) => [
    { method: "GET" as const, template: `/v1/${path}`, operations: [`${path}.list`] },
    { method: "POST" as const, template: `/v1/${path}`, operations: [`${path}.create`] },
    { method: "GET" as const, template: `/v1/${path}/{id}`, operations: [`${path}.get`] },
    { method: "PATCH" as const, template: `/v1/${path}/{id}`, operations: [`${path}.update`] },
    { method: "DELETE" as const, template: `/v1/${path}/{id}`, operations: [`${path}.remove`] },
  ]);
}

export const ROUTES: readonly RouteUse[] = Object.freeze([
  // ---- domains -------------------------------------------------------------
  { method: "GET", template: "/v1/domains", operations: ["listDomains", "getDomainByName"] },
  { method: "POST", template: "/v1/domains", operations: ["createDomain"] },
  { method: "GET", template: "/v1/domains/{id}", operations: ["getDomain"] },
  {
    method: "PATCH",
    template: "/v1/domains/{id}",
    operations: ["updateDomain", "applyDomainProvisioning"],
  },
  { method: "DELETE", template: "/v1/domains/{id}", operations: ["deleteDomain"] },

  // ---- addresses -----------------------------------------------------------
  { method: "GET", template: "/v1/addresses", operations: ["listAddresses"] },
  { method: "POST", template: "/v1/addresses", operations: ["createAddress"] },
  { method: "GET", template: "/v1/addresses/{id}", operations: ["getAddress"] },
  {
    method: "PATCH",
    template: "/v1/addresses/{id}",
    operations: [
      "updateAddress",
      "suspendAddress",
      "activateAddress",
      "setAddressQuota",
      "applyAddressOwnership",
      "applyAddressProvisioning",
    ],
  },
  { method: "DELETE", template: "/v1/addresses/{id}", operations: ["deleteAddress"] },

  // ---- messages ------------------------------------------------------------
  {
    method: "GET",
    template: "/v1/messages",
    operations: ["listMessages", "listInbound", "clearInboundEmails"],
  },
  // NOT `POST /v1/messages`. That route imports INBOUND mail only — it answers 409 for
  // anything else, because an outbound row it created would have no provider invocation
  // behind it — so it cannot serve two operations the seam leaves UNGATED. The record
  // route is the one that persists a row in either direction and transmits nothing.
  { method: "POST", template: "/v1/messages/record", operations: ["createMessage", "upsertMessage"] },
  { method: "GET", template: "/v1/messages/{id}", operations: ["getMessage", "resolveMessageId"] },
  {
    method: "PATCH",
    template: "/v1/messages/{id}",
    operations: [
      "updateMessageStatus",
      "updateMessageContent",
      "setInboundRead",
      "setInboundStarred",
      "setInboundArchived",
      "addInboundLabel",
      "removeInboundLabel",
    ],
  },
  {
    method: "DELETE",
    template: "/v1/messages/{id}",
    operations: ["deleteMessage", "clearInboundEmails"],
  },
  { method: "GET", template: "/v1/messages/counts", operations: ["messageCounts", "getUnreadCount"] },
  { method: "GET", template: "/v1/messages/{id}/raw", operations: ["getMessageRaw"] },

  // ---- attachments ---------------------------------------------------------
  {
    method: "GET",
    template: "/v1/messages/{id}/attachments/{index}",
    operations: ["getMessageAttachment"],
  },
  { method: "GET", template: "/v1/attachments", operations: ["listAttachments"] },
  { method: "POST", template: "/v1/attachments/batch", operations: ["listAttachmentsForMessageIds"] },

  // ---- rollups -------------------------------------------------------------
  { method: "GET", template: "/v1/messages/threads", operations: ["listThreads"] },
  { method: "GET", template: "/v1/mailboxes", operations: ["listMailboxes"] },

  // ---- send keys -----------------------------------------------------------
  { method: "GET", template: "/v1/send-keys", operations: ["listSendKeys"] },
  { method: "GET", template: "/v1/send-keys/{id}", operations: ["getSendKey"] },
  { method: "PATCH", template: "/v1/send-keys/{id}", operations: ["revokeSendKey"] },
  { method: "POST", template: "/v1/send-keys/mint", operations: ["mintSendKey"] },
  { method: "POST", template: "/v1/send-keys/verify", operations: ["verifySendKey"] },

  // ---- the published contract ---------------------------------------------
  //
  // Read to learn each uniform family's writable columns, so a write naming a column
  // the resource does not have is REFUSED instead of silently dropped. The document
  // is generated from the server's own resource registry, which is what keeps this
  // from becoming a second copy of the column list.
  { method: "GET", template: "/v1/openapi.json", operations: ["resourceColumns"] },

  ...resourceRoutes(),
]);
