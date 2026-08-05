// Outcome construction for the SQLite store.
//
// Every operation on the seam returns `Outcome<T>`, so this module is where the
// two answers are built: a success carrying the value, or a typed refusal. There
// is deliberately no third helper that returns a bare value — an operation that
// cannot express "I cannot" is the bug the seam exists to remove.
//
// EXCEPTIONS ARE STILL EXCEPTIONS. A refusal is a normal, expected answer (an
// unavailable capability, a row that is not there, input the schema rejects). A
// genuine fault — a corrupt database file, a disk error, a bug in this module's
// SQL — must still throw, because a caller cannot do anything sensible with it
// and swallowing it into a refusal would make it invisible. `guard()` below is
// the exact boundary: it converts the constraint failures that are CALLER errors
// and rethrows everything else.

import { capabilityRefusal, type CapabilityKey } from "../store/capabilities.js";
import type { Outcome, Refusal, RefusalCode, RefusalStatus } from "../store/outcome.js";

/** `StoreDescriptor.kind` for this implementation. Diagnostics only. */
export const SQLITE_STORE_KIND = "sqlite";

export function ok<TValue>(value: TValue): Outcome<TValue> {
  return { ok: true, value };
}

export function refuse(code: RefusalCode, status: RefusalStatus, message: string): Refusal {
  return { ok: false, code, message, status };
}

export function notFound(message: string): Refusal {
  return refuse("not_found", 404, message);
}

export function invalidInput(message: string): Refusal {
  return refuse("invalid_input", 422, message);
}

export function conflict(message: string): Refusal {
  return refuse("conflict", 409, message);
}

export function ambiguousId(message: string): Refusal {
  return refuse("ambiguous_id", 409, message);
}

/**
 * The ONE legal answer for an operation whose capability this store declares
 * false. Never an empty array, never a zero, never a silent no-op — and never a
 * blanket refusal either: `capabilityRefusal` names the capability in the
 * message, which is what lets the conformance harness tell a specific refusal
 * from a hard-coded one.
 */
export function unavailable(capability: CapabilityKey): Refusal {
  return capabilityRefusal(capability, SQLITE_STORE_KIND);
}

/**
 * Constraint failures that are the CALLER's error, mapped onto refusal codes.
 * Anything else returns null and is rethrown by `guard()`.
 */
function refusalForDatabaseError(error: unknown): Refusal | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed/i.test(message)) {
    return conflict(`the write conflicts with an existing row (${message})`);
  }
  if (/NOT NULL constraint failed|CHECK constraint failed|FOREIGN KEY constraint failed|datatype mismatch/i.test(message)) {
    return invalidInput(`the database rejected this input (${message})`);
  }
  // `no such column` is deliberately NOT in that list. It means the schema is not
  // what this code was written against — an unmigrated database, or an ensureSchema
  // guarantee that silently failed. Reporting it as the caller's invalid input would
  // blame the caller for a fault they cannot fix and cannot see, so it throws.
  return null;
}

/**
 * Run a database operation, converting caller-caused constraint failures into
 * refusals and letting every other failure propagate.
 */
export function guard<TValue>(run: () => Outcome<TValue>): Outcome<TValue> {
  try {
    return run();
  } catch (error) {
    const refusal = refusalForDatabaseError(error);
    if (refusal) return refusal;
    throw error;
  }
}
