// The address-ownership audit LEDGER: the append-only event table beside the
// `owners` rows and the `addresses` ownership columns the store seam already
// declares.
//
// WHY THIS MODULE EXISTS, AND WHY IT IS NOT PART OF `src/store/`. The seam
// (src/store/email-store.ts) declares ONE repository for the owners family, over the
// owner rows themselves — and address ownership is three surfaces: the owner rows,
// the `owner_id`/`administrator_id` columns on the address (written through
// `addressLifecycle.applyAddressOwnership`), and the audit trail that records every
// assign/transfer/unassign (`address_ownership_events` locally, per migration 29;
// `/v1/address-ownership-events` through an Emails API). Both physical stores hold
// all three; what is missing is only the DECLARATION for the trail — and `src/store/`
// is under audit and byte-identical in this change, so the declaration cannot be
// added there yet.
//
// THE SEAM WIDENING, DESCRIBED AND NOT MADE: `addressOwnershipEvents` belongs on
// `EmailStore` as one more uniform `ResourceRepository<ResourceRow>` family, exactly
// like `owners` itself, with an entry in the seam guard's family mapping. When
// `src/store/` unfreezes, moving this property onto the interface deletes this
// module's probe and turns a missing implementation into a `tsc` error, which is the
// seam's own standard. Until then this interface is the single declaration site, both
// concrete stores implement it (src/store-sqlite/index.ts, src/store-http/index.ts),
// and the probe below is how a consumer reaches it without branching on WHICH store
// it holds.
//
// LEDGER SEMANTICS, STATED BECAUSE THE TYPE CANNOT SAY THEM. The trail is
// APPEND-ONLY: its one writer creates rows and reads them back; nothing updates or
// removes one, because an audit record that can be rewritten is not an audit record.
// The repository shape still carries `update` and `remove` — it is the seam's uniform
// resource shape, and inventing a narrower one here would put a second repository
// vocabulary beside the seam's — so the discipline lives in the consumer
// (src/db/owners.ts), which never calls either. The service enforces the half it can:
// writes to `/v1/address-ownership-events` are operator-gated, because the trail
// carries an `actor` column and a member who cannot reassign ownership must not be
// able to forge "reassigned by X" rows either.
//
// WHY A PROBE AND NOT A CAST. The published surface accepts any `EmailStore`, and a
// caller-supplied store is under no obligation to carry properties the interface does
// not declare. A cast would hand such a store's `undefined` to the first read and
// fail as a `TypeError` three frames later; the probe answers null so the caller can
// refuse BY NAME (which ledger is missing, and that both shipped stores carry it).
// The probe is STRUCTURAL — it asks whether the repository is present and complete,
// never what kind of store it is looking at: `descriptor.kind` is not read here, and
// must not be (src/store/descriptor.ts).

import type { EmailStore } from "./store/email-store.js";
import type { ResourceRow } from "./store/records.js";
import type { ResourceRepository } from "./store/repositories.js";

/**
 * The audit-trail family of the owners domain.
 *
 * The seam's own uniform resource shape, so the eventual move onto `EmailStore` is a
 * declaration change and not a behaviour change.
 */
export interface AddressOwnershipLedger {
  /** `address_ownership_events` locally; `/v1/address-ownership-events` through an Emails API. */
  readonly addressOwnershipEvents: ResourceRepository<ResourceRow>;
}

/** A store that carries the audit trail — what both shipped constructors return. */
export type OwnershipCapableEmailStore = EmailStore & AddressOwnershipLedger;

/** Every method a `ResourceRepository` declares; the probe requires all of them. */
const RESOURCE_REPOSITORY_METHODS = ["list", "get", "create", "update", "remove"] as const;

function isResourceRepository(value: unknown): value is ResourceRepository<ResourceRow> {
  if (typeof value !== "object" || value === null) return false;
  return RESOURCE_REPOSITORY_METHODS.every(
    (method) => typeof (value as Record<string, unknown>)[method] === "function",
  );
}

/**
 * The ownership audit ledger a store carries, or null when it carries none.
 *
 * ALL-OR-NOTHING on purpose: a repository missing one of its five methods is a
 * half-implementation, and treating it as present would fail at the first absent
 * call instead of at the boundary. Null here means the CALLER decides what a missing
 * ledger means — the owners family refuses the WRITE by name rather than performing
 * an ownership change it cannot record, and answers a HISTORY read with the refusal
 * rather than presenting "no ledger" as "no events".
 */
export function addressOwnershipLedgerOf(store: EmailStore): AddressOwnershipLedger | null {
  const candidate = store as Partial<AddressOwnershipLedger>;
  if (!isResourceRepository(candidate.addressOwnershipEvents)) return null;
  return { addressOwnershipEvents: candidate.addressOwnershipEvents };
}
