import {
  selfHostedResource,
  selfHostedListQuery,
  selfHostedPage,
  cbool,
  cnum,
  ciso,
  cstr,
  cstrOrNull,
  type SelfHostedPageOptions,
} from "./self-hosted-resource.js";

const CONTACT_RESOURCE = "contacts";

export interface Contact {
  id: string;
  email: string;
  name: string | null;
  send_count: number;
  bounce_count: number;
  complaint_count: number;
  last_sent_at: string | null;
  suppressed: boolean;
  created_at: string;
  updated_at: string;
}

/** Map a self-hosted API contact entity to the local Contact shape. */
function apiToContact(e: Record<string, unknown>): Contact {
  const updatedAt = ciso(e["updated_at"]);
  return {
    id: cstr(e["id"]),
    email: cstr(e["email"]),
    name: cstrOrNull(e["name"]),
    send_count: cnum(e["send_count"]),
    bounce_count: cnum(e["bounce_count"]),
    complaint_count: cnum(e["complaint_count"]),
    last_sent_at: cstrOrNull(e["last_sent_at"]),
    suppressed: cbool(e["suppressed"]),
    created_at: ciso(e["created_at"], updatedAt),
    updated_at: updatedAt,
  };
}

type ContactStore = ReturnType<typeof selfHostedResource>;

/**
 * Find a single contact by exact email. Passes an `email` filter (honored
 * server-side when supported) and also filters in-memory so it stays correct
 * against a server that ignores unknown query params.
 */
function findContactByEmail(store: ContactStore, email: string): Contact | null {
  const rows = store.list({ email, limit: 500 }).map(apiToContact);
  return rows.find((c) => c.email === email) ?? null;
}

export function upsertContact(email: string): Contact {
  const store = selfHostedResource(CONTACT_RESOURCE);
  const existing = findContactByEmail(store, email);
  if (existing) return existing;
  return apiToContact(store.create({
    email,
    name: null,
    send_count: 0,
    bounce_count: 0,
    complaint_count: 0,
    last_sent_at: null,
    suppressed: false,
  }));
}

export function getContact(email: string): Contact | null {
  return findContactByEmail(selfHostedResource(CONTACT_RESOURCE), email);
}

export interface ListContactOptions extends SelfHostedPageOptions {
  suppressed?: boolean;
}

export function listContacts(opts?: ListContactOptions): Contact[] {
  const store = selfHostedResource(CONTACT_RESOURCE);
  const { query, limit, offset } = selfHostedListQuery(opts);
  if (opts?.suppressed !== undefined) query["suppressed"] = opts.suppressed;
  let rows = store.list(query).map(apiToContact);
  if (opts?.suppressed !== undefined) rows = rows.filter((c) => c.suppressed === opts.suppressed);
  rows.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  return selfHostedPage(rows, limit, offset);
}

function setContactSuppressed(store: ContactStore, email: string, suppressed: boolean): void {
  const existing = findContactByEmail(store, email) ?? upsertContact(email);
  store.update(existing.id, { suppressed });
}

export function suppressContact(email: string): void {
  setContactSuppressed(selfHostedResource(CONTACT_RESOURCE), email, true);
}

export function unsuppressContact(email: string): void {
  setContactSuppressed(selfHostedResource(CONTACT_RESOURCE), email, false);
}

// Send/bounce/complaint counters are derived server-side from message activity;
// the self-hosted client never mirrors these writes.
export function incrementSendCount(_email: string): void {}

export function incrementSendCounts(_emails: Iterable<string>): void {}

export function incrementBounceCount(_email: string): void {}

export function incrementBounceCounts(_emails: Iterable<string>): void {}

export function incrementComplaintCount(_email: string): void {}

export function incrementComplaintCounts(_emails: Iterable<string>): void {}

export function isContactSuppressed(email: string): boolean {
  return findContactByEmail(selfHostedResource(CONTACT_RESOURCE), email)?.suppressed === true;
}

export function getSuppressedEmailSet(emails: Iterable<string>): Set<string> {
  const uniqueEmails = Array.from(new Set(emails));
  const suppressed = new Set<string>();
  if (uniqueEmails.length === 0) return suppressed;
  const store = selfHostedResource(CONTACT_RESOURCE);
  for (const email of uniqueEmails) {
    const contact = findContactByEmail(store, email);
    if (contact?.suppressed) suppressed.add(contact.email);
  }
  return suppressed;
}
