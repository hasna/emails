// What a store can actually do, declared up front.
//
// THE RULE, and it is the whole reason this file exists:
//
//   When a capability is FALSE there is EXACTLY ONE legal behaviour for every
//   operation that needs it — return the typed refusal built by
//   `capabilityRefusal()`. Not an empty array. Not a zero count. Not `null`. Not a
//   silent no-op. Not a thrown string. One answer, machine-readable, with a status.
//
// This is the mechanism that stops the interim states of the migration from becoming
// permanent stubs. The failure it prevents is not hypothetical: mode-routed repository
// functions today return plausible WRONG data — an empty list, a zero, a fabricated
// default — because the weaker arm was allowed to satisfy the contract by answering
// "nothing" instead of "I cannot" (a prior audit put it at 39 of 324 exported
// functions; 293 exports are mode-routed as of 5bb126e). An empty array is
// indistinguishable from a true empty result, so those bugs are invisible at the call
// site and stay invisible in review. A refusal is not.
//
// The capability set is deliberately small and every entry names a REAL asymmetry
// between the strongest implementation (the tenant-scoped Postgres store) and the
// on-disk SQLite database — not a hypothetical future one. A capability nobody can
// answer honestly is worse than no capability.

import type { Refusal } from "./outcome.js";

/**
 * SINGLE DEFINITION SITE for the capability names. `as const` so the type below is
 * derived from this array rather than declared beside it: adding a capability here
 * makes every store's declaration a `tsc` error until it decides, which is the point.
 */
// NOT A CAPABILITY: tenant scoping. It was one in an earlier draft, and that was a
// mistake worth recording. Scope is STRUCTURAL here — no signature in src/store/ takes
// a tenant id, so an unscoped call is unrepresentable rather than refusable — and there
// is no operation for a conformance case to exercise. Since the gate below requires a
// case per capability, declaring it would have forced a sham case whose only possible
// subject is an operation that cannot refuse. A property the type system already
// guarantees does not belong in a runtime capability set.
export const CAPABILITY_KEYS = [
  /**
   * Stable keyset (cursor) paging over messages and attachments, with a total sort
   * order, so an interrupted scan resumes at exactly the next row and never
   * re-emits or skips one. LIMIT/OFFSET over a non-total order is not this.
   */
  "keysetPagination",

  /**
   * Attachment payload bytes can be produced, and their absence is reported as
   * such rather than as an empty attachment. Metadata alone is NOT this capability:
   * legacy rows carry filename/content_type/size for messages whose bytes were
   * never stored.
   */
  "attachmentContent",

  /** Raw RFC 5322 bytes for a stored message can be produced. */
  "rawMessage",

  /**
   * The idempotency-fenced send ledger: reserve/claim/complete/fail, a durable
   * fence on the caller's idempotency key, and tombstones for cancellation. This
   * one requires transactions and advisory locks — a store without them cannot
   * fake it, and must not try.
   */
  "sendIntentLedger",

  /**
   * Outbound policy evaluation before a send: sender registration and readiness,
   * send-key scope, recipient suppression, per-address quota, warming limits.
   * A store that cannot evaluate policy must refuse the send, never allow it —
   * "no policy configured" and "policy passed" are different answers.
   */
  "outboundPolicy",

  /**
   * Attachment repair: provenance-bound, leased, ledgered re-fetch of payload bytes
   * from the original inbound object.
   */
  "attachmentRepair",

  /** Subject-rolled-up thread and per-mailbox folder rollups. */
  "mailRollups",
] as const;

/** One capability name. Derived from the array above — never declared twice. */
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/**
 * Every capability, declared explicitly. A mapped type over `CapabilityKey` with no
 * optional members: a store cannot stay silent about a capability, and a new
 * capability breaks the build at every store until each one answers. `Partial<>` here
 * would reintroduce exactly the "unset means whatever the caller assumes" hole this
 * declaration removes.
 */
export type StoreCapabilities = { readonly [K in CapabilityKey]: boolean };

/**
 * The ONE legal refusal for an unavailable capability. Every store calls this rather
 * than hand-rolling a refusal, so the code, status and message shape cannot drift and
 * the conformance suite can recognise the answer precisely.
 *
 * 501 rather than 403: the caller is permitted to ask, and asking a store that CAN do
 * this would succeed. Nothing about the request is wrong; the store is not equipped.
 *
 * @param capability the capability that is declared false
 * @param storeKind `StoreDescriptor.kind`, used ONLY to make the message actionable
 */
export function capabilityRefusal(capability: CapabilityKey, storeKind: string): Refusal {
  return {
    ok: false,
    code: "capability_unavailable",
    message: `the ${storeKind} store does not provide ${capability}`,
    status: 501,
  };
}

/**
 * Whether an outcome is the canonical capability refusal. Used by the conformance
 * suite to check that a false capability produced the ONE legal answer — and, just as
 * importantly, that it did not produce a success carrying an empty value.
 */
export function isCapabilityRefusal(value: unknown, capability?: CapabilityKey): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { ok?: unknown; code?: unknown; status?: unknown; message?: unknown };
  // `ok !== false` rejects a SUCCESS carrying an empty value, which is the exact
  // wrong answer this predicate exists to catch — not just a differently-coded refusal.
  if (candidate.ok !== false) return false;
  if (candidate.code !== "capability_unavailable" || candidate.status !== 501) return false;
  if (typeof candidate.message !== "string" || candidate.message.length === 0) return false;
  // When the caller knows WHICH capability was refused, the message must name it.
  // Without this, one hard-coded refusal blob answers for every capability a store
  // lacks, and the suite cannot tell a specific refusal from a blanket one.
  return capability === undefined || candidate.message.includes(capability);
}

/** The capability names a store declares as false. */
export function unavailableCapabilities(capabilities: StoreCapabilities): CapabilityKey[] {
  return CAPABILITY_KEYS.filter((key) => !capabilities[key]);
}
