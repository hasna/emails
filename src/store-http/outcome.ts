// Outcome construction for the HTTP store.
//
// Two answers, exactly as in the SQLite store: a success carrying the value, or a
// typed refusal. There is no third helper returning a bare value.
//
// WHAT MAKES THIS MODULE DIFFERENT from its SQLite twin is that the refusals here
// are TRANSLATED rather than constructed: the API has already decided, and this
// module maps its answer onto the seam's vocabulary. Two rules govern that map and
// they are the substance of the file.
//
// RULE 1 — A REFUSAL IS THE API DECLINING THE OPERATION. Not the transport
// failing, not the credential being wrong, not the server breaking. Those are
// genuine faults: a caller can do nothing per-operation about a 401 or a 500, and
// folding them into a refusal would make a MISCONFIGURED store indistinguishable
// from a store that legitimately declines — every operation answering "I cannot",
// invisibly, which is the exact failure class this seam exists to remove. So 401,
// 403-with-no-tenant, 405, 5xx and every network error THROW.
//
// RULE 2 — 404 IS NOT ONE ANSWER. Whether "there is no such row" is a refusal or a
// value is decided by the OPERATION'S DECLARED RETURN TYPE on the seam, not by
// taste:
//
//   Outcome<X | null>    absence is a VALUE -> ok(null)      (getDomain, updateAddress)
//   Outcome<boolean>     absence is a VALUE -> ok(false)     (deleteDomain, remove)
//   Outcome<{ id }>      absence is a REFUSAL -> not_found   (resolveMessageId)
//   Outcome<X>           absence is a REFUSAL -> not_found   (createDomain, mintSendKey)
//
// That is why `absent()` exists as a separate helper from `refusalForStatus()`:
// the call site names which of the two it is, and the choice is checkable against
// repositories.ts by eye.

import { capabilityRefusal, type CapabilityKey } from "../store/capabilities.js";
import type { Outcome, Refusal, RefusalCode, RefusalStatus } from "../store/outcome.js";

/** `StoreDescriptor.kind` for this implementation. Diagnostics only. */
export const HTTP_STORE_KIND = "api";

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
 * false, naming the capability so the conformance harness can tell a specific
 * refusal from a hard-coded blob.
 */
export function unavailable(capability: CapabilityKey): Refusal {
  return capabilityRefusal(capability, HTTP_STORE_KIND);
}

/**
 * A fault, not a refusal. Thrown rather than returned — see RULE 1 above.
 *
 * Carries no request body and no header: a thrown error is the thing most likely
 * to reach a log, and the credential travels in a header on every call.
 *
 * THE ONE CLASS IN THIS DIRECTORY, and it is deliberately not the construct the seam
 * guard forbids. That rule bans a BASE CLASS FOR A REPOSITORY — a parent whose default
 * method body can answer a call the child never implemented — because that is what
 * turns a missing method into an inherited no-op instead of a `tsc` error. Every
 * repository here is still a plain typed object literal with no parent and no supplied
 * body. This is an error type: it declares no store operation, nothing implements it,
 * and subclassing `Error` is how the rest of the repository spells a typed fault (see
 * the eight in src/server/self-hosted/store.ts). `src/store-sqlite/` has no classes
 * because it needs none — it lets database errors propagate unwrapped — whereas a
 * transport has to distinguish "the API declined" from "the call never landed", and
 * `instanceof` is what lets a caller and a test do that without matching on a string.
 */
export class EmailsApiFault extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "EmailsApiFault";
    this.status = status;
  }
}

/**
 * The API's own error text, if it sent any.
 *
 * The self-hosted service answers with a FLAT `{ error, reason?, code? }` — not the
 * nested `{ error: { code, message } }` shape a reader might assume — so this reads
 * the flat form and falls back to the status when the body is not that shape at all
 * (an HTML error page from a proxy in front of the service, most likely).
 */
export function apiErrorText(status: number, body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const fields = body as { error?: unknown; reason?: unknown; code?: unknown };
    const error = typeof fields.error === "string" && fields.error.length > 0 ? fields.error : null;
    const discriminator =
      typeof fields.reason === "string" ? fields.reason : typeof fields.code === "string" ? fields.code : null;
    if (error) return discriminator ? `${error} (${discriminator})` : error;
  }
  return `the API answered ${status}`;
}

/** The API's flat `reason`/`code` discriminator, when it sent one. */
export function apiErrorReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const fields = body as { reason?: unknown; code?: unknown };
  if (typeof fields.reason === "string") return fields.reason;
  if (typeof fields.code === "string") return fields.code;
  return null;
}

/**
 * Map a NON-2xx API status onto the seam's refusal vocabulary, or throw when the
 * status is a fault rather than a decision (RULE 1).
 *
 * The status set is not a guess: it is the uniform set the service documents and
 * answers with (src/server/self-hosted/service.ts:1979-2000 and the parity block in
 * openapi.ts). 400 and 413 map to `invalid_input`/422 because `RefusalStatus` has no
 * 400 — deliberately, per outcome.ts: a refusal that cannot decide between two
 * statuses has not been thought through, and the seam's answer for "well-formed but
 * unacceptable input" is 422.
 */
export function refusalForStatus(status: number, body: unknown, what: string): Refusal {
  const detail = `${what}: ${apiErrorText(status, body)}`;
  const reason = apiErrorReason(body);
  switch (status) {
    case 400:
    case 413:
    case 422:
      return invalidInput(detail);
    case 403:
      // NOT EVERY 403 IS A DECISION ABOUT THIS REQUEST, and an earlier version of this
      // arm treated them all as refusals — which broke RULE 1 in the one way that hurts
      // most. A credential with no tenant mapping answers 403 `no_tenant` on EVERY data
      // route (src/server/self-hosted/auth/service.ts, and there is an integration test
      // pinning it), so a store built with such a key refused every operation it was ever
      // asked to perform, uniformly, with a plausible-looking typed refusal. That is
      // precisely the misconfigured-store-indistinguishable-from-a-declining-one failure
      // the top of this file says must never happen. Adversarial review caught it.
      //
      // The split is whether the answer is a property of the CREDENTIAL or of the
      // REQUEST. `no_tenant`, `apikey_required` and `session_required` are properties of
      // the credential: they do not vary by operation, no caller can act on them per
      // call, and the remedy is to configure the store differently — faults.
      // `operator_required`, `insufficient_scope`, `forbidden` and `email_not_allowed` DO
      // vary by operation (ordinary writes succeed on a key that cannot mint a send key
      // or reassign ownership), so they are genuine authority decisions about this
      // request, and `scope_violation` is what the seam names them.
      if (reason === "no_tenant" || reason === "apikey_required" || reason === "session_required") {
        throw new EmailsApiFault(status, detail);
      }
      return refuse("scope_violation", 403, detail);
    case 404:
      return notFound(detail);
    case 409:
      // The service distinguishes an ambiguous id prefix from every other conflict
      // through its flat `reason`, and the seam has a separate code for it because a
      // caller has to tell "no such message" from "your prefix matched several".
      return reason === "ambiguous_id" ? ambiguousId(detail) : conflict(detail);
    case 429:
      return refuse("quota_exceeded", 429, detail);
    default:
      // 401 (credential), 405 (this client called a route with the wrong verb), 5xx
      // (the service broke) and anything unrecognised. None of these is the API
      // declining the operation, so none of them may become a refusal.
      throw new EmailsApiFault(status, detail);
  }
}
