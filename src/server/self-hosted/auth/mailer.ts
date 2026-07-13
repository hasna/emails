// Auth transactional email (email confirmation, password reset, invites).
//
// Design ref: Addendum A2. Confirmation/reset/invite mails are sent through the
// app's EXISTING outbound path — `SelfHostedSender` (sender.ts) — which already
// targets the hasna-studio-alumia SES account (AWS account 638389534677, where the
// app's SES sending identities live), using the deployment IAM role and
// EMAILS_AWS_REGION. We reuse that path rather than provisioning new credentials;
// only the From identity is auth-specific (`EMAILS_AUTH_FROM`, a hasna-verified
// address such as noreply@hasna.studio). If a deployment needs an explicit
// account/region for these, thread it via EMAILS_AWS_REGION on the sender.
//
// The server runs in xyz-infra and sends via alumia SES cross-account; that is the
// operator's SES setup, transparent to this module (it only calls sender.send()).
//
// Every send here is BEST-EFFORT and NEVER throws (design A2 + M7): signup/reset
// must not fail on a transient SES error — the token is already persisted and a
// resend is offered. Tokens are NEVER logged (M7); on failure we log only a
// secret-free reason.

import type { SelfHostedSender } from "../sender.js";

export interface AuthMailerConfig {
  /** From identity — a hasna-verified SES address (alumia account). */
  from: string;
  /** Absolute base URL the client hits to verify email / reset password. */
  verifyUrlBase: string;
  resetUrlBase: string;
  inviteUrlBase: string;
  /** Product name shown in the email copy. */
  productName: string;
}

const DEFAULT_AUTH_FROM = "noreply@hasna.studio";

/**
 * Build the mailer config from the environment. `EMAILS_AUTH_FROM` defaults to a
 * hasna.studio identity in the alumia SES account. The link bases default to the
 * public base URL + the verify/reset endpoints; `EMAILS_AUTH_VERIFY_URL_BASE` /
 * `EMAILS_AUTH_RESET_URL_BASE` override them for a hosted UI.
 */
export function buildAuthMailerConfig(env: NodeJS.ProcessEnv = process.env): AuthMailerConfig {
  const from = env["EMAILS_AUTH_FROM"]?.trim() || DEFAULT_AUTH_FROM;
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
