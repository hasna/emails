// Auth transactional email (email confirmation, password reset, invites).
//
// Design ref: Addendum A2. Confirmation/reset/invite mails are sent through the
// app's EXISTING outbound path — `SelfHostedSender` (sender.ts). Which AWS
// account that path reaches is an OPERATOR/deployment decision, not something
// this module (or any code here) can assert: sender.ts signs with
// EMAILS_SES_ACCESS_KEY_ID/EMAILS_SES_SECRET_ACCESS_KEY when they are present in
// the server environment, and otherwise with the deployment IAM role of
// whatever account the process runs in. There is no cross-account assume-role
// anywhere in this codebase.
//
// (A previous version of this comment claimed the sender "already targets" a
// specific SES account via the deployment role. It did not, and operators
// trusted it — hence the explicit correction.)
//
// Only the From identity is auth-specific: `EMAILS_AUTH_FROM` is REQUIRED and
// must name an address verified in whichever provider account the sender actually
// signs into. This package ships no default identity — one would only be sendable
// by whoever published the build. Region comes from EMAILS_AWS_REGION (falling
// back to AWS_REGION).
//
// Every send here is BEST-EFFORT and NEVER throws (design A2 + M7): signup/reset
// must not fail on a transient SES error — the token is already persisted and a
// resend is offered. Tokens are NEVER logged (M7); on failure we log only a
// secret-free reason.

import type { SelfHostedSender } from "../sender.js";

export interface AuthMailerConfig {
  /**
   * From identity — a sender address verified in the operator's OWN provider
   * account (the SES/Resend account `sender.ts` signs into). This package pins no
   * address and no account: there is no default identity to inherit.
   */
  from: string;
  /** Absolute base URL the client hits to verify email / reset password. */
  verifyUrlBase: string;
  resetUrlBase: string;
  inviteUrlBase: string;
  /** Product name shown in the email copy. */
  productName: string;
}

const EMAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Build the mailer config from the environment. `EMAILS_AUTH_FROM` is REQUIRED and
 * must be a sender identity verified in the operator's own provider account —
 * there is no default, because a default would be an address only the publisher
 * of the build can actually send from. The link bases default to the public base
 * URL + the verify/reset endpoints; `EMAILS_AUTH_VERIFY_URL_BASE` /
 * `EMAILS_AUTH_RESET_URL_BASE` override them for a hosted UI.
 */
export function buildAuthMailerConfig(env: NodeJS.ProcessEnv = process.env): AuthMailerConfig {
  const from = env["EMAILS_AUTH_FROM"]?.trim();
  if (!from) {
    throw new Error("Emails auth mailer requires EMAILS_AUTH_FROM (a verified sender identity).");
  }
  if (!EMAIL_ADDRESS_RE.test(from)) {
    throw new Error("EMAILS_AUTH_FROM must be a valid email address.");
  }
  const publicBase = (env["EMAILS_PUBLIC_BASE_URL"]?.trim() || "").replace(/\/+$/, "");
  const verifyUrlBase =
    env["EMAILS_AUTH_VERIFY_URL_BASE"]?.trim() ||
    (publicBase ? `${publicBase}/v1/auth/verify-email` : "");
  const resetUrlBase =
    env["EMAILS_AUTH_RESET_URL_BASE"]?.trim() ||
    (publicBase ? `${publicBase}/v1/auth/password/reset` : "");
  const inviteUrlBase =
    env["EMAILS_AUTH_INVITE_URL_BASE"]?.trim() ||
    (publicBase ? `${publicBase}/v1/invites/accept` : "");
  const productName = env["EMAILS_AUTH_PRODUCT_NAME"]?.trim() || "Hasna Emails";
  return { from, verifyUrlBase, resetUrlBase, inviteUrlBase, productName };
}

function appendToken(base: string, token: string): string {
  if (!base) return `?token=${encodeURIComponent(token)}`;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}token=${encodeURIComponent(token)}`;
}

export interface SendResult {
  sent: boolean;
  reason?: string;
}

async function bestEffortSend(
  sender: SelfHostedSender,
  input: { from: string; to: string; subject: string; text: string; html: string },
): Promise<SendResult> {
  try {
    await sender.send({
      provider_id: `self-hosted-${sender.provider}`,
      from: input.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    return { sent: true };
  } catch (error) {
    // Never log the token/link; only a secret-free reason (M7).
    return { sent: false, reason: error instanceof Error ? error.name : "send_failed" };
  }
}

export async function sendVerificationEmail(
  sender: SelfHostedSender,
  config: AuthMailerConfig,
  to: string,
  token: string,
): Promise<SendResult> {
  const link = appendToken(config.verifyUrlBase, token);
  return bestEffortSend(sender, {
    from: config.from,
    to,
    subject: `Confirm your ${config.productName} email`,
    text: `Welcome to ${config.productName}.\n\nConfirm your email address to activate your account:\n${link}\n\nThis link expires soon. If you did not sign up, ignore this message.`,
    html: `<p>Welcome to ${config.productName}.</p><p>Confirm your email address to activate your account:</p><p><a href="${link}">Confirm email</a></p><p>This link expires soon. If you did not sign up, ignore this message.</p>`,
  });
}

export async function sendPasswordResetEmail(
  sender: SelfHostedSender,
  config: AuthMailerConfig,
  to: string,
  token: string,
): Promise<SendResult> {
  const link = appendToken(config.resetUrlBase, token);
  return bestEffortSend(sender, {
    from: config.from,
    to,
    subject: `Reset your ${config.productName} password`,
    text: `A password reset was requested for your ${config.productName} account.\n\nReset it here:\n${link}\n\nThis link expires soon. If you did not request this, ignore this message.`,
    html: `<p>A password reset was requested for your ${config.productName} account.</p><p><a href="${link}">Reset your password</a></p><p>This link expires soon. If you did not request this, ignore this message.</p>`,
  });
}

export async function sendInvitationEmail(
  sender: SelfHostedSender,
  config: AuthMailerConfig,
  to: string,
  token: string,
  tenantName: string,
): Promise<SendResult> {
  const link = appendToken(config.inviteUrlBase, token);
  return bestEffortSend(sender, {
    from: config.from,
    to,
    subject: `You've been invited to ${tenantName} on ${config.productName}`,
    text: `You've been invited to join ${tenantName} on ${config.productName}.\n\nAccept the invitation:\n${link}\n\nThis invite expires soon.`,
    html: `<p>You've been invited to join <strong>${tenantName}</strong> on ${config.productName}.</p><p><a href="${link}">Accept invitation</a></p><p>This invite expires soon.</p>`,
  });
}
