import { getAdapter } from "../../providers/index.js";
import type { Provider, SendEmailOptions } from "../../types/index.js";

export type SelfHostedSendProvider = "ses" | "resend";

export interface SelfHostedSender {
  readonly provider: SelfHostedSendProvider;
  send(input: SendEmailOptions): Promise<string>;
}

function providerRecord(type: SelfHostedSendProvider, env: NodeJS.ProcessEnv): Provider {
  const now = new Date().toISOString();
  const apiKey = type === "resend" ? env["RESEND_API_KEY"]?.trim() ?? null : null;
  if (type === "resend" && !apiKey) {
    throw new Error("EMAILS_SEND_PROVIDER=resend requires RESEND_API_KEY.");
  }
  return {
    id: `self-hosted-${type}`,
    name: `Self-hosted ${type.toUpperCase()}`,
    type,
    api_key: apiKey,
    region: type === "ses" ? env["EMAILS_AWS_REGION"]?.trim() ?? env["AWS_REGION"]?.trim() ?? null : null,
    access_key: null,
    secret_key: null,
    oauth_client_id: null,
    oauth_client_secret: null,
    oauth_refresh_token: null,
    oauth_access_token: null,
    oauth_token_expiry: null,
    active: true,
    created_at: now,
    updated_at: now,
  };
}

export function buildSelfHostedSender(env: NodeJS.ProcessEnv = process.env): SelfHostedSender {
  const raw = env["EMAILS_SEND_PROVIDER"]?.trim().toLowerCase();
  if (raw !== "ses" && raw !== "resend") {
    throw new Error(
      "Emails self-hosted sending requires EMAILS_SEND_PROVIDER=ses or EMAILS_SEND_PROVIDER=resend. " +
        "SES uses the deployment IAM role; Resend additionally requires RESEND_API_KEY.",
    );
  }
  const provider = providerRecord(raw, env);
  const adapter = getAdapter(provider);
  return {
    provider: raw,
    send: (input) => adapter.sendEmail(input),
  };
}
