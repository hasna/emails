// Mailboxes / mail-folders repository — self-hosted-ONLY.
//
// Mailbox READS route to the operator's `/v1/mailboxes` projection
// ({id, address, display_name, status, total, unread}). Mailbox and folder
// PROVISIONING (createMailbox, the mail_folders architecture) is server-owned
// and has no `/v1` write surface on this client, so those functions are stubbed
// per the self-hosted contract (rule 6) and listed in the refactor summary.

import type {
  CreateMailFolderInput,
  CreateMailboxInput,
  MailFolder,
  Mailbox,
  MailboxStatus,
} from "../types/index.js";
import { selfHostedResource, cstr, cstrOrNull, ciso } from "./self-hosted-resource.js";

const MAILBOX_RESOURCE = "mailboxes";

function normalizeMailboxAddress(address: string): string {
  const normalized = address.trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalized)) {
    throw new Error(`Invalid mailbox address: ${address}`);
  }
  return normalized;
}

/** Map a `/v1/mailboxes` projection row onto the local Mailbox shape. */
function apiToMailbox(e: Record<string, unknown>): Mailbox {
  const updatedAt = ciso(e["updated_at"]);
  const status = (cstr(e["status"]) || "active") as MailboxStatus;
  return {
    id: cstr(e["id"]),
    address: cstr(e["address"]),
    display_name: cstrOrNull(e["display_name"]),
    owner_id: cstrOrNull(e["owner_id"]),
    status,
    created_at: ciso(e["created_at"], updatedAt),
    updated_at: updatedAt,
  };
}

export function ensureDefaultMailFolders(_mailboxId: string): MailFolder[] {
  throw new Error(
    "ensureDefaultMailFolders is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

export function createMailbox(_input: CreateMailboxInput): Mailbox {
  throw new Error(
    "createMailbox is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

export function getMailbox(id: string): Mailbox | null {
  const row = selfHostedResource(MAILBOX_RESOURCE).get(id);
  return row ? apiToMailbox(row) : null;
}

export function getMailboxByAddress(address: string): Mailbox | null {
  const target = normalizeMailboxAddress(address);
  const match = selfHostedResource(MAILBOX_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToMailbox)
    .find((mb) => mb.address.trim().toLowerCase() === target);
  return match ?? null;
}

export function listMailboxes(): Mailbox[] {
  return selfHostedResource(MAILBOX_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToMailbox)
    .sort((a, b) => a.address.localeCompare(b.address));
}

export function createMailFolder(_input: CreateMailFolderInput): MailFolder {
  throw new Error(
    "createMailFolder is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

export function getMailFolder(_id: string): MailFolder | null {
  throw new Error(
    "getMailFolder is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

export function getMailboxFolderByRole(_mailboxId: string, _role: MailFolder["role"]): MailFolder | null {
  throw new Error(
    "getMailboxFolderByRole is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

export function listMailFolders(_mailboxId: string): MailFolder[] {
  throw new Error(
    "listMailFolders is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}
