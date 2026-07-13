/**
 * Address lifecycle — suspend / activate an address and enforce a per-address
 * daily send quota. An address that is `suspended` cannot send (and is excluded
 * from delivery); a `daily_quota` caps the number of sends per UTC day.
 *
 * Self-hosted-ONLY: status/quota transitions PATCH /v1/addresses/<id> via the
 * addresses repo. The per-address daily send ledger (`emails`) is not part of
 * the /v1 address model, so send counts resolve to 0 client-side (the server is
 * authoritative for send accounting).
 */
import type { AddressStatus, EmailAddress } from "../types/index.js";
import { AddressNotFoundError } from "../types/index.js";
import { apiToAddress, selfHostedAddresses, findAddressesByEmail } from "./addresses.js";
import { canonicalSender } from "../lib/email-address.js";

function setStatus(id: string, status: AddressStatus): EmailAddress {
  const store = selfHostedAddresses();
  if (!store.get(id)) throw new AddressNotFoundError(id);
  return apiToAddress(store.update(id, { status }));
}

export function suspendAddress(id: string): EmailAddress {
  return setStatus(id, "suspended");
}

export function activateAddress(id: string): EmailAddress {
  return setStatus(id, "active");
}

/** Set (or clear, with null) the per-address daily send quota. */
export function setAddressQuota(id: string, quota: number | null): EmailAddress {
  if (quota !== null && (!Number.isInteger(quota) || quota < 0)) {
    throw new Error(`Invalid daily quota: ${quota} (must be a non-negative integer or null)`);
  }
  const store = selfHostedAddresses();
  if (!store.get(id)) throw new AddressNotFoundError(id);
  return apiToAddress(store.update(id, { daily_quota: quota }));
}

/** Count emails sent from `email` so far during the current UTC day. */
export function countSendsToday(_email: string): number {
  // The per-address daily send ledger (`emails`) is not part of the /v1 address
  // model; the server owns send accounting, so the client reports 0.
  return 0;
}

/** Count today's sends for many addresses with one grouped query. */
export function countSendsTodayByAddress(emails: Iterable<string>): Map<string, number> {
  const normalized = [...new Set(
    [...emails]
      .map((email) => canonicalSender(email) ?? email.trim().toLowerCase())
      .filter(Boolean),
  )];
  // Zeroed counts without a local ledger to count against (see countSendsToday).
  return new Map(normalized.map((email) => [email, 0]));
}

export interface Sendability {
  sendable: boolean;
  reason?: string;
}

/**
 * Whether `email` is allowed to send right now. Unregistered addresses are
 * unrestricted (sendable); a registered address is blocked if suspended or if
 * it has reached its daily quota.
 */
export function getAddressSendability(email: string): Sendability {
  const normalizedEmail = canonicalSender(email) ?? email.trim().toLowerCase();

  const matches = findAddressesByEmail(normalizedEmail);
  if (matches.length === 0) return { sendable: true };
  // A suspended record (any provider) takes precedence over an active one.
  const record = matches.find((a) => a.status === "suspended") ?? matches[0]!;
  if ((record.status ?? "active") === "suspended") {
    return { sendable: false, reason: `Address ${normalizedEmail} is suspended` };
  }
  if (record.daily_quota !== null) {
    const used = countSendsToday(normalizedEmail);
    if (used >= record.daily_quota) {
      return { sendable: false, reason: `Address ${normalizedEmail} reached its daily quota (${used}/${record.daily_quota})` };
    }
  }
  return { sendable: true };
}
