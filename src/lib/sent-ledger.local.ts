import type { Database } from "../db/database.js";
import type { Email, SendEmailOptions } from "../types/index.js";
import { createEmail } from "../db/emails.local.js";
import { storeEmailContent } from "../db/email-content.local.js";
import { setEmailThreading, type EmailThreading } from "../db/threads.local.js";

export async function createSentEmailLedger(
  providerId: string,
  opts: SendEmailOptions,
  providerMessageId?: string,
  db?: Database,
): Promise<Email> {
  return createEmail(providerId, opts, providerMessageId, db);
}

export async function storeSentEmailContent(
  emailId: string,
  content: { html?: string; text?: string; headers?: Record<string, string> },
  db?: Database,
): Promise<void> {
  storeEmailContent(emailId, content, db);
}

export async function setSentEmailThreading(
  emailId: string,
  threading: Partial<EmailThreading>,
  db?: Database,
): Promise<void> {
  setEmailThreading(emailId, threading, db);
}
