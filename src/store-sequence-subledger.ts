// The sequence SUB-LEDGER: steps and enrollments, beside the `sequences` rows the
// store seam already declares.
//
// WHY THIS MODULE EXISTS, AND WHY IT IS NOT PART OF `src/store/`. The seam
// (src/store/email-store.ts) declares ONE repository for the sequences family, over the
// `sequences` table — and a drip sequence is three tables: the sequence, its steps
// (`sequence_steps` / `/v1/sequence-steps`) and its enrollments
// (`sequence_enrollments` / `/v1/sequence-enrollments`). Both physical stores hold all
// three: the local database has carried the two sub-tables since migration 12, and the
// self-hosted service registers both `/v1` resources with the same columns
// (src/server/self-hosted/resources.ts). What is missing is only the DECLARATION — and
// `src/store/` is under audit and byte-identical in this change, so the declaration
// cannot be added there yet.
//
// THE SEAM WIDENING, DESCRIBED AND NOT MADE: `sequenceSteps` and `sequenceEnrollments`
// belong on `EmailStore` as two more uniform `ResourceRepository<ResourceRow>` families,
// exactly like `sequences` itself, with entries in the seam guard's family mapping. When
// `src/store/` unfreezes, moving these two properties onto the interface deletes this
// module's probe and turns a missing implementation into a `tsc` error, which is the
// seam's own standard. Until then this interface is the single declaration site, both
// concrete stores implement it (src/store-sqlite/index.ts, src/store-http/index.ts), and
// the probe below is how a consumer reaches it without branching on WHICH store it holds.
//
// WHY A PROBE AND NOT A CAST. The published surface accepts any `EmailStore`, and a
// caller-supplied store is under no obligation to carry properties the interface does not
// declare. A cast would hand such a store's `undefined` to the first read and fail as a
// `TypeError` three frames later; the probe answers null so the caller can refuse BY NAME
// (which tables are missing, and that both shipped stores carry them). The probe is
// STRUCTURAL — it asks whether the two repositories are present and complete, never what
// kind of store it is looking at: `descriptor.kind` is not read here, and must not be
// (src/store/descriptor.ts).

import type { EmailStore } from "./store/email-store.js";
import type { ResourceRow } from "./store/records.js";
import type { ResourceRepository } from "./store/repositories.js";

/**
 * The two sub-ledger families of the sequences domain.
 *
 * Both are the seam's own uniform resource shape, so the eventual move onto
 * `EmailStore` is a declaration change and not a behaviour change.
 */
export interface SequenceSubledger {
  /** `sequence_steps` locally; `/v1/sequence-steps` through an Emails API. */
  readonly sequenceSteps: ResourceRepository<ResourceRow>;
  /** `sequence_enrollments` locally; `/v1/sequence-enrollments` through an Emails API. */
  readonly sequenceEnrollments: ResourceRepository<ResourceRow>;
}

/** A store that carries the sub-ledger — what both shipped constructors return. */
export type SequenceCapableEmailStore = EmailStore & SequenceSubledger;

/** Every method a `ResourceRepository` declares; the probe requires all of them. */
const RESOURCE_REPOSITORY_METHODS = ["list", "get", "create", "update", "remove"] as const;

function isResourceRepository(value: unknown): value is ResourceRepository<ResourceRow> {
  if (typeof value !== "object" || value === null) return false;
  return RESOURCE_REPOSITORY_METHODS.every(
    (method) => typeof (value as Record<string, unknown>)[method] === "function",
  );
}

/**
 * The sub-ledger a store carries, or null when it carries none.
 *
 * ALL-OR-NOTHING on purpose: a store holding steps but not enrollments (or a
 * repository missing one of its five methods) is a half-implementation, and treating
 * it as present would fail at the first absent call instead of at the boundary. Null
 * here means the CALLER decides what a missing sub-ledger means — the sequences
 * family refuses by name rather than reading half a drip campaign.
 */
export function sequenceSubledgerOf(store: EmailStore): SequenceSubledger | null {
  const candidate = store as Partial<SequenceSubledger>;
  if (!isResourceRepository(candidate.sequenceSteps)) return null;
  if (!isResourceRepository(candidate.sequenceEnrollments)) return null;
  return { sequenceSteps: candidate.sequenceSteps, sequenceEnrollments: candidate.sequenceEnrollments };
}
