import { join } from "node:path";
import { EventsClient, type EmitOptions, type EmitResult, type EventInput } from "@hasna/events";
import { getDataDir } from "../db/database.js";

export const MAILERY_EVENT_SOURCE = "mailery";
export const MAILERY_EVENT_SCHEMA_VERSION = "mailery.v1";

export type MaileryEventType =
  | "mailery.inbound.received"
  | "mailery.inbound.sync.requested"
  | "mailery.inbound.attachment.saved"
  | "mailery.agent.classified"
  | "mailery.action.planned"
  | "mailery.action.applied"
  | "mailery.quarantine.created"
  | "mailery.delivery.event.received"
  | "mailery.webhook.delivery.failed";

export interface MaileryEventInput<TData extends Record<string, unknown> = Record<string, unknown>>
  extends Omit<EventInput<TData>, "source" | "schemaVersion"> {
  type: MaileryEventType;
}

export function getMaileryEventsDataDir(): string {
  return join(getDataDir(), "events");
}

export function createMaileryEventsClient(): EventsClient {
  return new EventsClient({ dataDir: getMaileryEventsDataDir() });
}

export async function emitMaileryEvent<TData extends Record<string, unknown>>(
  input: MaileryEventInput<TData>,
  options: EmitOptions = {},
): Promise<EmitResult<TData>> {
  const client = createMaileryEventsClient();
  return client.emit({
    ...input,
    source: MAILERY_EVENT_SOURCE,
    schemaVersion: MAILERY_EVENT_SCHEMA_VERSION,
  }, {
    deliver: options.deliver ?? true,
    dedupe: options.dedupe ?? true,
    redactSensitiveData: options.redactSensitiveData ?? true,
  });
}

export function emitMaileryEventBestEffort<TData extends Record<string, unknown>>(
  input: MaileryEventInput<TData>,
  options: EmitOptions = {},
): void {
  void emitMaileryEvent(input, options).catch(() => {
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
