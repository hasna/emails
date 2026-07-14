// Email content (html/text/headers) storage — self-hosted-ONLY.
//
// The local `email_content` table is gone; a sent email's body lives on the
// operator's `/v1/messages/<id>` record (body_text / body_html / headers). Reads
// map that record onto the EmailContent shape; writes PATCH those fields.

import { selfHostedResource, cstrOrNull, cobj } from "./self-hosted-resource.js";

const MESSAGE_RESOURCE = "messages";

export interface EmailContent {
  email_id: string;
  html: string | null;
  text_body: string | null;
  headers: Record<string, string>;
}

/**
 * Persist a sent email's rendered body onto its `/v1/messages` record. Threads
 * and delivery are server-owned; this only mirrors the body/header projection.
 */
export function storeEmailContent(
  emailId: string,
  content: { html?: string; text?: string; headers?: Record<string, string> },
): void {
  selfHostedResource(MESSAGE_RESOURCE).update(emailId, {
    body_html: content.html ?? null,
    body_text: content.text ?? null,
    headers: content.headers ?? {},
  });
}

export function getEmailContent(emailId: string): EmailContent | null {
  const rec = selfHostedResource(MESSAGE_RESOURCE).get(emailId);
  if (!rec) return null;
  return {
    email_id: emailId,
    html: cstrOrNull(rec["body_html"] ?? rec["html"]),
    text_body: cstrOrNull(rec["body_text"] ?? rec["text"]),
    headers: cobj(rec["headers"]) as Record<string, string>,
  };
}
