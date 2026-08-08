// What `emails send --dry-run` can HONESTLY predict, and what it cannot.
//
// THE DEFECT THIS EXISTS TO FIX. `--dry-run` was a pure client-side echo of the
// arguments. Tested three ways on a live deployment — from a verified sender, from
// an UNVERIFIED sender (a real send is refused with policy_denial
// `sender_unverified` before any provider is contacted), and from an address that
// does not exist in the system at all — it produced BYTE-IDENTICAL "Would send"
// output. No policy verdict, no sender check, no attachment-cap evaluation.
//
// A dry run that answers identically for a valid sender and a nonexistent one is
// worse than no dry run, because operators reasonably read it as a precheck and
// gate real work on it. It was used exactly that way before a batch of customs
// emails: it passed everything and proved nothing.
//
// THE RULE THIS MODULE FOLLOWS. Predict only from facts actually read, name the
// exact code the server would return, and state plainly what is NOT covered.
// Silence reads as a green light, and a confident-looking preview that has checked
// nothing is the failure mode being fixed — so this must never guess "ok".
//
// It deliberately does NOT re-implement evaluateOutboundPolicy
// (src/server/self-hosted/store.ts). That gate also weighs send-key authority,
// daily quota, warming schedules, domain readiness and recipient suppression
// against server-side state, and a second copy of a policy gate would drift from
// the one that enforces it — the exact class of bug that made the dry run wrong in
// the first place. What is reproduced here is only the part that can be READ
// truthfully from the address record over /v1/addresses, in the same ORDER the
// server evaluates it, so the reported code matches what a real send would hit.

import {
  describeSendAttachmentLimits,
  type SendAttachmentLimits,
} from "./send-attachment-limits.js";

/** The subset of an address record this preflight reads. */
export interface PreflightAddress {
  email: string;
  status: string;
  verified: boolean;
}

/**
 * Codes mirror `OutboundPolicyCode` in src/server/self-hosted/store.ts by name, so
 * a preview and the refusal an operator later sees in `headers.policy_denial` use
 * the same vocabulary.
 */
export type SenderPreflightCode =
  | "sender_not_registered"
  | "sender_inactive"
  | "sender_unverified"
  | "sender_checks_passed";

export interface SenderPreflight {
  code: SenderPreflightCode;
  /** True only when every check this preflight can perform passed. */
  ok: boolean;
  message: string;
}

/**
 * Evaluate the sender checks that are answerable from the address record.
 *
 * Order matches evaluateOutboundPolicy: registered -> active -> verified. A
 * `null` address means no record exists for that sender.
 */
export function evaluateSenderPreflight(
  from: string,
  address: PreflightAddress | null,
): SenderPreflight {
  if (!address) {
    return {
      code: "sender_not_registered",
      ok: false,
      message: `${from} is not a registered sender address on this deployment. `
        + "A real send is refused with policy_denial sender_not_registered, before any provider is contacted. "
        + "Add it with `emails address add <email> --provider <id>`.",
    };
  }
  if (address.status !== "active") {
    return {
      code: "sender_inactive",
      ok: false,
      message: `${address.email} is ${address.status}, not active. `
        + "A real send is refused with policy_denial sender_inactive. "
        + "Reactivate it with `emails address activate <id>`.",
    };
  }
  if (!address.verified) {
    return {
      code: "sender_unverified",
      ok: false,
      message: `${address.email} is not verified. `
        + "A real send is refused with policy_denial sender_unverified, before any provider is contacted — "
        + "the message is recorded as `blocked` and never leaves the server. "
        + `Fix it with \`emails address set-verified ${address.email}\`.`,
    };
  }
  return {
    code: "sender_checks_passed",
    ok: true,
    message: `${address.email} is registered, active and verified.`,
  };
}

export interface AttachmentCapFinding {
  rule: "file_count" | "bytes_per_file" | "total_bytes";
  detail: string;
}

/**
 * Evaluate the REAL files against the mode's caps.
 *
 * These caps were printed as prose next to the attachment count and never checked,
 * so a set that the self-hosted route refuses previewed as fine.
 * `readSendAttachments` only enforces the much larger local ceilings, so nothing
 * else caught it either. The exact numbers deliberately are not repeated here —
 * they live in `SELF_HOSTED_SEND_ATTACHMENT_LIMITS`, and a prose copy of them is
 * how the prediction drifted from the enforcement in the first place.
 *
 * `sizes` are decoded byte lengths, not base64 lengths — the caps are on content.
 */
export function evaluateAttachmentCaps(
  files: Array<{ filename: string; bytes: number }>,
  limits: SendAttachmentLimits,
): AttachmentCapFinding[] {
  const findings: AttachmentCapFinding[] = [];
  if (files.length > limits.maxFiles) {
    findings.push({
      rule: "file_count",
      detail: `${files.length} files exceeds the ${limits.maxFiles}-file cap`,
    });
  }
  for (const file of files) {
    if (file.bytes > limits.maxBytesPerFile) {
      findings.push({
        rule: "bytes_per_file",
        detail: `${file.filename} is ${humanBytes(file.bytes)}, over the ${humanBytes(limits.maxBytesPerFile)} per-file cap`,
      });
    }
  }
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > limits.maxTotalBytes) {
    findings.push({
      rule: "total_bytes",
      detail: `${humanBytes(total)} total exceeds the ${humanBytes(limits.maxTotalBytes)} cap`,
    });
  }
  return findings;
}

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KiB`;
  return `${bytes}B`;
}

/**
 * The disclaimer. It is not boilerplate: it is the difference between "this send
 * will succeed" and "these specific checks passed", and omitting it is what let a
 * green-looking preview stand in for a guarantee it never made.
 */
export function describeUncheckedSendPolicy(selfHosted: boolean): string {
  if (!selfHosted) {
    return "Local mode has no outbound policy gate; a real send depends on provider credentials and acceptance, "
      + "which this preview does not test.";
  }
  return "NOT checked here (server-side state this preview cannot read): send-key authority, daily quota, "
    + "warming limits, domain readiness, and provider acceptance. Passing these checks does not guarantee delivery.";
}

/** Cap summary for the preview line, so the numbers come from the enforcer. */
export function describeCapsForPreview(limits: SendAttachmentLimits): string {
  return describeSendAttachmentLimits(limits);
}
