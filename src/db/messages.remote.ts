// Mail messages / mailbox-message-state repository — self-hosted-ONLY.
//
// A single message READ maps onto the operator's `/v1/messages/<id>` record.
// The normalized local mail architecture (mail_messages content rows split from
// per-mailbox mailbox_message_state) has NO `/v1` equivalent — that projection is
// owned by the self-hosted server — so createMailMessage and the message-state
// functions are stubbed per the self-hosted contract (rule 6) and listed in the
// refactor summary.

import type {
  CreateMailMessageInput,
  MailMessage,
  MailboxMessageState,
  UpsertMailboxMessageStateInput,
} from "../types/index.js";
import {
  selfHostedResource,
  carray,
  cnum,
  cobj,
  cstr,
  cstrArray,
  cstrOrNull,
  ciso,
} from "./self-hosted-resource.js";

const MESSAGE_RESOURCE = "messages";

/** Map a `/v1/messages` row onto the local MailMessage content shape. */
function apiToMailMessage(e: Record<string, unknown>): MailMessage {
  const outbound = cstr(e["direction"]).toLowerCase() === "outbound";
  const at = cstrOrNull(e["received_at"]);
  const updatedAt = ciso(e["updated_at"]);
  return {
    id: cstr(e["id"]),
    rfc_message_id: cstrOrNull(e["message_id"]),
    subject: cstr(e["subject"]),
    from_address: cstrOrNull(e["from_addr"]),
    to_addresses: cstrArray(e["to_addrs"]),
    cc_addresses: cstrArray(e["cc_addrs"]),
    bcc_addresses: cstrArray(e["bcc_addrs"]),
    text_body: cstrOrNull(e["body_text"]),
    html_body: cstrOrNull(e["body_html"]),
    headers: cobj(e["headers"]),
    attachments: carray(e["attachments"]),
    raw_s3_url: null,
    metadata_s3_url: null,
    raw_size: cnum(e["raw_size"]),
    sent_at: outbound ? at : null,
    received_at: outbound ? null : at,
    created_at: ciso(e["created_at"], updatedAt),
    updated_at: updatedAt,
  };
}

export function createMailMessage(_input: CreateMailMessageInput): MailMessage {
  throw new Error(
    "createMailMessage is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

export function getMailMessage(id: string): MailMessage | null {
  const row = selfHostedResource(MESSAGE_RESOURCE).get(id);
  return row ? apiToMailMessage(row) : null;
}

export function upsertMailboxMessageState(_input: UpsertMailboxMessageStateInput): MailboxMessageState {
  throw new Error(
    "upsertMailboxMessageState is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

export function getMailboxMessageState(_id: string): MailboxMessageState | null {
  throw new Error(
    "getMailboxMessageState is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

export function listMailboxMessageStates(_mailboxId: string): MailboxMessageState[] {
  throw new Error(
    "listMailboxMessageStates is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}
