import type { Attachment } from "../types/index.js";
import { now, uuid } from "./runtime.js";
import { safeLimit, safeOffset } from "./pagination.js";
import { selfHostedResource, carray, cobj, cstrArray, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const SANDBOX_RESOURCE = "sandbox-emails";

export interface SandboxEmail {
  id: string;
  provider_id: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  reply_to: string | null;
  subject: string;
  html: string | null;
  text_body: string | null;
  attachments: Attachment[];
  headers: Record<string, string>;
  created_at: string;
}

export type SandboxEmailSummary = Omit<SandboxEmail, "html" | "text_body" | "headers">;

function apiToSandbox(e: Record<string, unknown>): SandboxEmail {
  return {
    id: cstr(e["id"]),
    provider_id: cstr(e["provider_id"]),
    from_address: cstr(e["from_address"]),
    to_addresses: cstrArray(e["to_addresses"]),
    cc_addresses: cstrArray(e["cc_addresses"]),
    bcc_addresses: cstrArray(e["bcc_addresses"]),
    reply_to: cstrOrNull(e["reply_to"]),
    subject: cstr(e["subject"]),
    html: cstrOrNull(e["html"]),
    text_body: cstrOrNull(e["text_body"]),
    attachments: carray(e["attachments"] ?? e["attachments_json"]) as Attachment[],
    headers: cobj(e["headers"] ?? e["headers_json"]) as Record<string, string>,
    created_at: ciso(e["created_at"]),
  };
}

function toSandboxSummary(email: SandboxEmail): SandboxEmailSummary {
  const { html: _html, text_body: _text, headers: _headers, ...summary } = email;
  return summary;
}

export interface StoreSandboxEmailInput {
  provider_id: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  reply_to: string | null;
  subject: string;
  html: string | null;
  text_body: string | null;
  attachments: Attachment[];
  headers: Record<string, string>;
}

export function storeSandboxEmail(input: StoreSandboxEmailInput): SandboxEmail {
  const id = uuid();
  const created = selfHostedResource(SANDBOX_RESOURCE).create({
    id,
    provider_id: input.provider_id,
    from_address: input.from_address,
    to_addresses: input.to_addresses,
    cc_addresses: input.cc_addresses,
    bcc_addresses: input.bcc_addresses,
    reply_to: input.reply_to,
    subject: input.subject,
    html: input.html,
    text_body: input.text_body,
    attachments_json: JSON.stringify(input.attachments),
    headers_json: JSON.stringify(input.headers),
    created_at: now(),
  });
  return apiToSandbox(created);
}

function listSandbox(providerId: string | undefined, limit: number, offset: number): SandboxEmail[] {
  const normalizedLimit = safeLimit(limit);
  const off = safeOffset(offset);
  let rows = selfHostedResource(SANDBOX_RESOURCE).list({ limit: 1000 }).map(apiToSandbox);
  if (providerId) rows = rows.filter((e) => e.provider_id === providerId);
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return rows.slice(off, off + normalizedLimit);
}

export function listSandboxEmails(providerId?: string, limit = 50, offset = 0): SandboxEmail[] {
  return listSandbox(providerId, limit, offset);
}

export function listSandboxEmailSummaries(providerId?: string, limit = 50, offset = 0): SandboxEmailSummary[] {
  return listSandbox(providerId, limit, offset).map(toSandboxSummary);
}

export function getSandboxEmail(id: string): SandboxEmail | null {
  const record = selfHostedResource(SANDBOX_RESOURCE).get(id);
  return record ? apiToSandbox(record) : null;
}

export function clearSandboxEmails(providerId?: string): number {
  const store = selfHostedResource(SANDBOX_RESOURCE);
  const rows = store.list({ limit: 1000 }).map(apiToSandbox).filter((e) => (providerId ? e.provider_id === providerId : true));
  let count = 0;
  for (const e of rows) if (store.del(e.id)) count++;
  return count;
}

export function getSandboxCount(providerId?: string): number {
  return selfHostedResource(SANDBOX_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToSandbox)
    .filter((e) => (providerId ? e.provider_id === providerId : true)).length;
}
