// SqliteEmailStore — the local, default, on-disk store, behind the seam.
//
// This is one of the only two implementations of `EmailStore` there will ever be
// (the other is a client of an Emails API). It is assembled from plain object
// literals typed against the seam's interfaces: no base class, no `implements`,
// no defaults merged in at runtime. That is not stylistic. Because every
// repository is a typed object literal, a method the seam gains and this store
// forgets is a `tsc` error at the assignment below — not an inherited stub that
// answers a call nobody wrote.
//
// NO CONSUMER READS THIS YET, by design. The store is exported from
// `@hasna/emails/storage` so it is reachable from a shipped entrypoint (an
// unimported module rots while its own tests stay green), and its only caller
// today is its own test suite plus the shared conformance suite. Rewiring the
// repositories onto it is the next change, not this one.
//
// CAPABILITIES ARE DECLARED HONESTLY, WHICH MEANS MOSTLY FALSE — see the table
// below. Each `false` is a real asymmetry between this database and the
// tenant-scoped Postgres store, and each one turns a family of operations into a
// typed refusal. That is the entire point: an operation that cannot say "I
// cannot" answers with plausible wrong data instead, and this store has 25
// operations that would otherwise have to.

import { getDatabase, type Database } from "../db/database.js";
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
import { SQLITE_STORE_KIND } from "./outcome.js";
import {
  createAddressLifecycleRepository,
  createAddressesRepository,
  createDomainsRepository,
  createProvisioningRepository,
} from "./registry.js";
import { RESOURCE_TABLES, createResourceRepository } from "./resources.js";
import { createSendKeysRepository } from "./send-keys.js";

/**
 * What this store can do, and — for everything it cannot — the reason, stated
 * against the schema rather than against convenience.
 *
 *   keysetPagination  TRUE   messages and attachments page over a total
 *                            (sort_ts, id[, attachment_index]) order, so a
 *                            resumed scan re-enters at exactly the next row.
 *   mailRollups       TRUE   thread rollups group on the same normalised subject
 *                            key the server uses; mailbox rollups roll up the
 *                            registered addresses.
 *   rawMessage        FALSE  nothing here stores RFC 5322 bytes. `raw_s3_url`
 *                            points at an object this store cannot read.
 *   attachmentContent FALSE  attachment METADATA and file paths are stored;
 *                            payload bytes never are. The capability is explicit
 *                            that metadata alone is not it.
 *   sendIntentLedger  FALSE  no reserve/claim/complete state, no lease, no
 *                            tombstone, no reconciliation record.
 *   outboundPolicy    FALSE  no policy model: no sender-readiness definition, no
 *                            send-key requirement, no suppression or warming
 *                            enforcement.
 *   attachmentRepair  FALSE  no run/entry ledger and no lease — and no stored
 *                            payload bytes to repair.
 *
 * Frozen because a capability set that can be mutated after construction is a
 * capability set a caller can talk itself into.
 */
export const SQLITE_STORE_CAPABILITIES: StoreCapabilities = Object.freeze({
  keysetPagination: true,
  attachmentContent: false,
  rawMessage: false,
  sendIntentLedger: false,
  outboundPolicy: false,
  mailRollups: true,
  attachmentRepair: false,
});

/**
 * Diagnostics identity. `kind` is `string` on the seam so nothing can branch on
 * it, and `detail` must be safe to print — a database PATH is, a credential
 * would not be, and this store has no credentials to leak.
 */
export function sqliteStoreDescriptor(detail: string): StoreDescriptor {
  return { kind: SQLITE_STORE_KIND, detail };
}

export interface SqliteEmailStoreOptions {
  /**
   * An open database. Defaults to the process-wide one from `getDatabase()`,
   * which is what a shipped caller wants; tests hand in their own.
   */
  database?: Database;
  /** Human-readable location for `descriptor.detail`. Never a credential. */
  detail?: string;
}

/**
 * Build the store.
 *
 * The return type is `EmailStore`, so every repository below is checked against
 * its interface at this assignment. There is deliberately no partial variant of
 * this function and no way to construct a store with a repository missing.
 */
export function createSqliteEmailStore(options: SqliteEmailStoreOptions = {}): EmailStore {
  const db = options.database ?? getDatabase();
  const capabilities = SQLITE_STORE_CAPABILITIES;
  const resource = (family: keyof typeof RESOURCE_TABLES) =>
    createResourceRepository(db, RESOURCE_TABLES[family]);

  return {
    descriptor: sqliteStoreDescriptor(options.detail ?? "SQLite database"),
    capabilities,

    domains: createDomainsRepository(db),
    addresses: createAddressesRepository(db),
    addressLifecycle: createAddressLifecycleRepository(db),
    provisioning: createProvisioningRepository(db),

    messages: createMessagesRepository(db, capabilities),
    emailContent: createEmailContentRepository(db, capabilities),
    inbound: createInboundRepository(db, capabilities),
    threads: createThreadsRepository(db, capabilities),

    sandbox: resource("sandbox"),
    emailDigests: resource("emailDigests"),
    scheduled: resource("scheduled"),
    events: resource("events"),
    webhookReceipts: resource("webhookReceipts"),
    contacts: resource("contacts"),
    groups: resource("groups"),
    sequences: resource("sequences"),
    templates: resource("templates"),
    owners: resource("owners"),
    providers: resource("providers"),
    aliases: resource("aliases"),
    forwarding: resource("forwarding"),
    warming: resource("warming"),

    sendKeys: createSendKeysRepository(db),

    // The two the strongest arm has and `src/db/*` never did. Both refuse, in
    // full, one method at a time — see ledger.ts for why that is written out
    // rather than generated.
    sendIntents: createSendIntentsRepository(),
    attachmentRepair: createAttachmentRepairRepository(),
  };
}
