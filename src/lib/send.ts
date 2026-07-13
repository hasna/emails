import type { Provider, SendEmailOptions } from "../types/index.js";

export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 10;

export interface SendResult {
  messageId: string;
  providerId: string;
  usedFailover: boolean;
}

// ── pure attachment validation (no I/O) ──────────────────────────────────────

export function getAttachmentDecodedSize(content: string): number {
  return Buffer.from(content, "base64").byteLength;
}

export function validateSendAttachments(attachments: SendEmailOptions["attachments"]): void {
  if (!attachments || attachments.length === 0) return;
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`Too many attachments: ${attachments.length} (max ${MAX_ATTACHMENT_COUNT})`);
  }
  for (const attachment of attachments) {
    const size = getAttachmentDecodedSize(attachment.content);
    if (size > MAX_ATTACHMENT_SIZE_BYTES) {
      throw new Error(`Attachment "${attachment.filename}" is too large: ${(size / 1024 / 1024).toFixed(1)}MB (max 25MB)`);
    }
  }
}

// ── outbound send (server-side in the self-hosted client) ────────────────────
//
// Sending in the self-hosted client goes through the authenticated `/v1` send
// endpoint via `resolveMailDataSource().send(...)`. The local provider-adapter
// send path (failover across locally-configured providers, local send-key auth,
// local address-sendability + domain-outbound-readiness + warming-rate guards)
// does not exist client-side. These entrypoints preserve their signatures and
// fail loud.

export function assertWarmingLimit(_opts: SendEmailOptions): void {
  throw new Error(
    "assertWarmingLimit is not available in the self-hosted client; warming rate limits are enforced on the self-hosted server.",
  );
}

export function assertDomainOutboundReady(provider: Provider, _opts: SendEmailOptions): void {
  throw new Error(
    `Self-hosted sends must use the authenticated Emails /v1 send endpoint for ${provider.name} (${provider.id}); outbound readiness is enforced on the self-hosted server.`,
  );
}

export async function sendWithFailover(
  _primaryProviderId: string,
  _opts: SendEmailOptions,
): Promise<SendResult> {
  throw new Error(
    "sendWithFailover is not available in the self-hosted client; send through resolveMailDataSource().send(...), which posts to the authenticated /v1 send endpoint.",
  );
}
