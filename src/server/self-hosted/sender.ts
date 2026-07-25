import { getAdapter } from "../../providers/index.js";
import type { Provider, SendEmailOptions } from "../../types/index.js";

export type SelfHostedSendProvider = "ses" | "resend";

export interface SelfHostedSender {
  readonly provider: SelfHostedSendProvider;
  send(input: SendEmailOptions): Promise<string>;
}

/**
 * What a thrown provider error PROVES about the send.
 *
 * `rejected`  — the provider answered with a 4xx-class client error: it REFUSED
 *               the request, so nothing was sent. This outcome is definitive
 *               and safe to retry (after fixing the cause). The canonical case
 *               is SES sandbox `MessageRejected` ("Email address is not
 *               verified…") for any unverified/external recipient — the exact
 *               error the 2026-07-25 incident swallowed into a generic 502.
 * `uncertain` — anything else (network failure, provider 5xx, unknown shape):
 *               the request may have reached the provider, so the send may or
 *               may not have happened and reconciliation is required.
 */
export type ProviderSendErrorOutcome = {
  kind: "rejected" | "uncertain";
  /** The provider SDK's error name (e.g. `MessageRejected`), for logs/response. */
  providerErrorName: string;
  /** The provider's own message, capped so a response cannot be flooded. */
  detail: string;
  /** The provider HTTP status when one was received; undefined for network errors. */
  httpStatus?: number;
};

const PROVIDER_ERROR_DETAIL_MAX_CHARS = 600;

/** Read a numeric HTTP status from the shapes real provider SDKs throw. */
function providerHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  // AWS SDK v3: err.$metadata.httpStatusCode
  const metadata = record["$metadata"];
  if (metadata && typeof metadata === "object") {
    const code = (metadata as Record<string, unknown>)["httpStatusCode"];
    if (typeof code === "number" && Number.isInteger(code)) return code;
  }
  // Resend/fetch-style SDKs: err.statusCode / err.status
  for (const key of ["statusCode", "status"]) {
    const code = record[key];
    if (typeof code === "number" && Number.isInteger(code)) return code;
  }
  return undefined;
}

/**
 * Classify an error thrown by a provider `send`. Deliberately conservative:
 * only a received 4xx response proves "nothing was sent"; everything else
 * stays uncertain. Never throws.
 */
export function classifyProviderSendError(error: unknown): ProviderSendErrorOutcome {
  const providerErrorName = error instanceof Error && error.name ? error.name : "UnknownProviderError";
  const rawDetail = error instanceof Error ? error.message : String(error ?? "unknown provider error");
  const detail = rawDetail.slice(0, PROVIDER_ERROR_DETAIL_MAX_CHARS);
  const httpStatus = providerHttpStatus(error);
  const fault = error && typeof error === "object" ? (error as Record<string, unknown>)["$fault"] : undefined;
  const rejected = httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && fault !== "server";
  return {
    kind: rejected ? "rejected" : "uncertain",
    providerErrorName,
    detail,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  };
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
