// Attachment caps, stated once per mode so a prediction cannot drift from the
// code that enforces it.
//
// `emails send --dry-run` exists to PREDICT what a real send will do. It used to
// print the self-hosted caps and "scheduling is not available" in BOTH modes,
// with no mode branch — so in local mode the one command whose entire purpose is
// prediction predicted the wrong limits and a failure that would not happen.
// These constants are imported by the predictor (src/cli/commands/send.ts) AND by
// the enforcer (src/server/self-hosted/service.ts).

export interface SendAttachmentLimits {
  maxFiles: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
}

/**
 * Enforced by the self-hosted JSON send route (`POST /v1/messages/send`).
 *
 * These are DOCUMENT-SIZED on purpose: 512KiB could not carry a scanned page,
 * so the route refused ordinary notarised paperwork. The ceiling above them is
 * the provider's, not ours — see `SES_MAX_MESSAGE_BYTES` and
 * `mimeEncodedUpperBound`.
 *
 * The per-file cap MUST stay at or below the local path's own 25MiB ceiling
 * (`MAX_ATTACHMENT_SIZE_BYTES` in `send.local.ts`), or that layer would reject
 * sends this route had just accepted.
 */
export const SELF_HOSTED_SEND_ATTACHMENT_LIMITS: SendAttachmentLimits = {
  maxFiles: 5,
  maxBytesPerFile: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
};

/**
 * Enforced locally before handing a message to a provider (Resend/SES accept
 * 25MB, and the CLI caps the file count itself).
 */
export const LOCAL_SEND_ATTACHMENT_LIMITS: SendAttachmentLimits = {
  maxFiles: 10,
  maxBytesPerFile: 25 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
};

/**
 * Bytes needed to base64-encode `rawBytes`: 4 characters per 3 input bytes,
 * final group padded.
 *
 * This is the conversion that made the old caps look arbitrary. Attachments
 * travel base64-encoded inside the JSON send body, so every raw cap below is
 * spent against the body budget at 4/3 its size.
 */
export function base64EncodedBytes(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

/**
 * Room reserved in the send body for everything that is not attachment content:
 * addresses, subject, filenames, content types, JSON structure, and a text or
 * HTML body.
 */
export const SEND_ENVELOPE_HEADROOM_BYTES = 2 * 1024 * 1024;

/**
 * The JSON request-body budget the send route needs in order for `limits` to be
 * reachable at all.
 *
 * DERIVED, never hand-typed. The previous 768KiB total cap was exactly
 * `base64EncodedBytes(768KiB) === 1MiB`, the route's body cap — so the two
 * numbers were coupled in fact and independent in code, and raising one alone
 * silently accomplished nothing. Deriving the body budget from the attachment
 * cap makes that drift impossible.
 */
export function requiredSendJsonBodyBytes(limits: SendAttachmentLimits): number {
  return base64EncodedBytes(limits.maxTotalBytes) + SEND_ENVELOPE_HEADROOM_BYTES;
}

/**
 * Amazon SES maximum message size, measured AFTER base64 encoding. Not
 * adjustable.
 *
 * 40MB is the SESv2/SMTP figure, and `src/providers/ses.ts` sends through
 * SESv2 `SendEmailCommand` with raw content. The v1 API's limit is 10MB; do not
 * mix them up if that provider path ever changes.
 */
export const SES_MAX_MESSAGE_BYTES = 40_000_000;

/**
 * Upper bound on the encoded MIME message a full-size `limits` set produces,
 * for comparison against `SES_MAX_MESSAGE_BYTES`.
 *
 * MIME wraps base64 at 76 characters per line plus CRLF, so the encoded payload
 * costs a further 78/76 on top of the 4/3 expansion.
 */
export function mimeEncodedUpperBound(limits: SendAttachmentLimits): number {
  const encoded = base64EncodedBytes(limits.maxTotalBytes);
  return Math.ceil((encoded * 78) / 76) + SEND_ENVELOPE_HEADROOM_BYTES;
}

/**
 * Renders a cap for an operator-facing message.
 *
 * Exported so the send route's rejection text is DERIVED from the constant it
 * enforces. Those strings previously read "512KiB" and "768KiB" as literals, so
 * raising the caps would have left the route refusing at one size while telling
 * the operator another.
 */
export function humanLimitBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${Math.round(bytes / 1024)}KiB`;
}

export function describeSendAttachmentLimits(limits: SendAttachmentLimits): string {
  return `${limits.maxFiles} files, ${humanLimitBytes(limits.maxBytesPerFile)} each, `
    + `${humanLimitBytes(limits.maxTotalBytes)} total`;
}
