// The group MEMBERSHIP ledger: the join table beside the `groups` rows the store
// seam already declares.
//
// WHY THIS MODULE EXISTS, AND WHY IT IS NOT PART OF `src/store/`. The seam
// (src/store/email-store.ts) declares ONE repository for the groups family, over the
// group rows themselves — and a recipient group is two tables: the group and its
// members (`group_members` locally, `/v1/group-members` through an Emails API). Both
// physical stores hold both: the local database has carried `group_members` since
// migration 6, and the service registers the `/v1` resource with the same columns
// (src/server/self-hosted/resources.ts). What is missing is only the DECLARATION —
// and `src/store/` is under audit and byte-identical in this change, so the
// declaration cannot be added there yet.
//
// THE SEAM WIDENING, DESCRIBED AND NOT MADE: `groupMembers` belongs on `EmailStore`
// as one more uniform `ResourceRepository<ResourceRow>` family, exactly like `groups`
// itself, with an entry in the seam guard's family mapping. When `src/store/`
// unfreezes, moving this property onto the interface deletes this module's probe and
// turns a missing implementation into a `tsc` error, which is the seam's own
// standard. Until then this interface is the single declaration site, both concrete
// stores implement it (src/store-sqlite/index.ts, src/store-http/index.ts), and the
// probe below is how a consumer reaches it without branching on WHICH store it holds.
//
// ONE IDENTITY WRINKLE THE SEQUENCE PRECEDENT DOES NOT HAVE. The local table's
// natural key is composite (group_id, email), so the generic SQLite path addresses
// its rows by `rowid` and projects that; the service could not serve composite-key
// CRUD and mints a TEXT `id` instead (plus a UNIQUE(group_id, email) that preserves
// the natural key). So a membership row's addressable identity arrives under `id`
// from one store and under `rowid` from the other — a fact about the ROW, not about
// the store, which is why the consumer reads whichever the row itself carries
// (src/db/groups.ts, `memberIdentityOf`) and neither this module nor that one ever
// asks what kind of store answered.
//
// WHY A PROBE AND NOT A CAST. The published surface accepts any `EmailStore`, and a
// caller-supplied store is under no obligation to carry properties the interface does
// not declare. A cast would hand such a store's `undefined` to the first read and
// fail as a `TypeError` three frames later; the probe answers null so the caller can
// refuse BY NAME (which table is missing, and that both shipped stores carry it). The
// probe is STRUCTURAL — it asks whether the repository is present and complete, never
// what kind of store it is looking at: `descriptor.kind` is not read here, and must
// not be (src/store/descriptor.ts).

import type { EmailStore } from "./store/email-store.js";
import type { ResourceRow } from "./store/records.js";
import type { ResourceRepository } from "./store/repositories.js";

/**
 * The membership family of the groups domain.
 *
 * The seam's own uniform resource shape, so the eventual move onto `EmailStore` is a
 * declaration change and not a behaviour change.
 */
export interface GroupMembership {
  /** `group_members` locally; `/v1/group-members` through an Emails API. */
  readonly groupMembers: ResourceRepository<ResourceRow>;
}

/** A store that carries the membership ledger — what both shipped constructors return. */
export type GroupCapableEmailStore = EmailStore & GroupMembership;

/** Every method a `ResourceRepository` declares; the probe requires all of them. */
const RESOURCE_REPOSITORY_METHODS = ["list", "get", "create", "update", "remove"] as const;

function isResourceRepository(value: unknown): value is ResourceRepository<ResourceRow> {
  if (typeof value !== "object" || value === null) return false;
  return RESOURCE_REPOSITORY_METHODS.every(
    (method) => typeof (value as Record<string, unknown>)[method] === "function",
  );
}

/**
 * The membership ledger a store carries, or null when it carries none.
 *
 * ALL-OR-NOTHING on purpose: a repository missing one of its five methods is a
 * half-implementation, and treating it as present would fail at the first absent
 * call instead of at the boundary. Null here means the CALLER decides what a missing
 * ledger means — the groups family refuses by name rather than presenting a group
 * with no members as one that truly has none.
 */
export function groupMembershipOf(store: EmailStore): GroupMembership | null {
  const candidate = store as Partial<GroupMembership>;
  if (!isResourceRepository(candidate.groupMembers)) return null;
  return { groupMembers: candidate.groupMembers };
}
