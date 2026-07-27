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

/** Enforced by the self-hosted JSON send route (`POST /v1/messages/send`). */
export const SELF_HOSTED_SEND_ATTACHMENT_LIMITS: SendAttachmentLimits = {
  maxFiles: 5,
  maxBytesPerFile: 512 * 1024,
  maxTotalBytes: 768 * 1024,
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

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${Math.round(bytes / 1024)}KiB`;
}

export function describeSendAttachmentLimits(limits: SendAttachmentLimits): string {
  return `${limits.maxFiles} files, ${humanBytes(limits.maxBytesPerFile)} each, `
    + `${humanBytes(limits.maxTotalBytes)} total`;
}
