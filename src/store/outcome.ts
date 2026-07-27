// The refusal vocabulary of the store seam.
//
// This is a DELIBERATE COPY of the field names in `OutboundPolicyDecision`
// (src/server/self-hosted/store.ts), which already gets this right: a discriminated
// union whose refusal arm carries a machine-readable `code`, a human `message`, and
// the HTTP `status` the API layer should answer with. Reusing those exact names is
// the point — the send path and the store seam then converge on one refusal shape
// instead of growing two, and `evaluateOutboundPolicy`'s decision can be widened
// into an `Outcome` later with no field renaming and no adapter.
//
// Why a union and not exceptions: a refusal is a NORMAL, expected answer here (an
// unsupported capability, a scope violation, an exhausted quota), and the caller has
// to be able to see the code without string-matching an error message. Genuine
// faults — a broken connection, malformed stored data — still throw.

/**
 * HTTP status codes a refusal may carry, kept to the set the API layer actually
 * answers with. A literal union, not `number`: a refusal that cannot decide between
 * 403 and 404 has not been thought through, and an open `number` lets a 200 be
 * smuggled into a refusal.
 *
 * 403 forbidden · 404 not found · 409 conflict · 422 unprocessable ·
 * 429 rate limited · 501 not implemented (the capability refusal, see capabilities.ts)
 */
export type RefusalStatus = 403 | 404 | 409 | 422 | 429 | 501;

/**
 * Machine-readable refusal codes. `snake_case`, matching `OutboundPolicyCode`.
 *
 * This list holds the codes the seam itself needs. Domain-specific codes (the
 * outbound-policy set: `sender_unverified`, `recipient_suppressed`,
 * `warming_limit_exceeded`, …) join it as each family is migrated; they are already
 * spelled this way, so they append rather than convert.
 */
export type RefusalCode =
  /**
   * The store cannot perform this operation at all — the declared capability is
   * false. The ONLY legal answer in that case; see capabilities.ts.
   */
  | "capability_unavailable"
  /** The named row does not exist within the caller's scope. */
  | "not_found"
  /** An ambiguous id prefix matched more than one row. */
  | "ambiguous_id"
  /** The operation would read or write outside the caller's tenant scope. */
  | "scope_violation"
  /** The input is well-formed but unacceptable (bad enum, out-of-range limit). */
  | "invalid_input"
  /** The write conflicts with existing state (uniqueness, idempotency fence). */
  | "conflict"
  /** A caller-supplied precondition (version, expected value) no longer holds. */
  | "precondition_failed"
  /** A quota or rate limit is exhausted. */
  | "quota_exceeded";

/**
 * A refusal. Field-for-field the shape of `OutboundPolicyDecision`'s rejection arm,
 * with `allowed: false` generalized to `ok: false` because this union also carries a
 * value on the success side.
 */
export interface Refusal {
  ok: false;
  code: RefusalCode;
  message: string;
  status: RefusalStatus;
}

/** A success carrying the operation's value. `void` operations use `Outcome<null>`. */
export interface Success<TValue> {
  ok: true;
  value: TValue;
}

/**
 * Every fallible store operation returns this. The discriminant is `ok`, so a caller
 * that forgets to check it cannot reach `.value` — `tsc` rejects the access on the
 * un-narrowed union. That is the property that makes "return an empty array instead
 * of admitting you cannot do this" a compile error rather than a code-review catch.
 */
export type Outcome<TValue> = Success<TValue> | Refusal;
