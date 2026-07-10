import { join } from "node:path";
import { EventsClient, type EmitOptions, type EmitResult, type EventInput } from "@hasna/events";
import { getDataDir } from "../db/database.js";

export const EMAILS_EVENT_SOURCE = "emails";
export const EMAILS_EVENT_SCHEMA_VERSION = "emails.v1";
/** Historical values remain readable during the rename cutover. New writes use Emails only. */
export const LEGACY_MAILERY_EVENT_SOURCE = "mailery";
export const LEGACY_MAILERY_EVENT_SCHEMA_VERSION = "mailery.v1";

export function isEmailsEventSource(value: string): boolean {
  return value === EMAILS_EVENT_SOURCE || value === LEGACY_MAILERY_EVENT_SOURCE;
}

export function normalizeEmailsEventType(value: string): string {
  return value.startsWith("mailery.") ? `emails.${value.slice("mailery.".length)}` : value;
}

export type EmailsEventType =
  | "emails.inbound.received"
  | "emails.inbound.sync.requested"
  | "emails.inbound.attachment.saved"
  | "emails.agent.classified"
  | "emails.action.planned"
  | "emails.action.applied"
  | "emails.quarantine.created"
  | "emails.delivery.event.received"
  | "emails.webhook.delivery.failed";

export interface EmailsEventInput<TData extends Record<string, unknown> = Record<string, unknown>>
  extends Omit<EventInput<TData>, "source" | "schemaVersion"> {
  type: EmailsEventType;
}

export function getEmailsEventsDataDir(): string {
  return join(getDataDir(), "events");
}

export function createEmailsEventsClient(): EventsClient {
  return new EventsClient({ dataDir: getEmailsEventsDataDir() });
}

export async function emitEmailsEvent<TData extends Record<string, unknown>>(
  input: EmailsEventInput<TData>,
  options: EmitOptions = {},
): Promise<EmitResult<TData>> {
  const client = createEmailsEventsClient();
  return client.emit({
    ...input,
    source: EMAILS_EVENT_SOURCE,
    schemaVersion: EMAILS_EVENT_SCHEMA_VERSION,
  }, {
    deliver: options.deliver ?? true,
    dedupe: options.dedupe ?? true,
    redactSensitiveData: options.redactSensitiveData ?? true,
  });
}

export function emitEmailsEventBestEffort<TData extends Record<string, unknown>>(
  input: EmailsEventInput<TData>,
  options: EmitOptions = {},
): void {
  void emitEmailsEvent(input, options).catch(() => {
    // Workflow events should never break email ingestion or mailbox actions.
  });
}

export function inboundReceivedEventData(input: {
  emailId: string;
  providerId?: string | null;
  source: "resend" | "ses-s3" | "smtp" | "manual";
  messageId?: string | null;
  fromAddress?: string | null;
  toAddresses?: string[];
  ccAddresses?: string[];
  subject?: string | null;
  receivedAt?: string | null;
  rawS3Url?: string | null;
  attachmentCount?: number;
}): Record<string, unknown> {
  return {
    email_id: input.emailId,
    provider_id: input.providerId ?? null,
    source: input.source,
    message_id: input.messageId ?? null,
    from_address: input.fromAddress ?? null,
    to_addresses: input.toAddresses ?? [],
    cc_addresses: input.ccAddresses ?? [],
    subject: input.subject ?? "",
    received_at: input.receivedAt ?? null,
    raw_s3_url: input.rawS3Url ?? null,
    attachment_count: input.attachmentCount ?? 0,
  };
}
