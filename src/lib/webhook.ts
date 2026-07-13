export {
  parseResendWebhook,
  parseSesWebhook,
  verifyResendSignature,
  verifySnsStructure,
} from "./webhook-events.js";
export type { WebhookEvent } from "./webhook-events.js";

// The webhook receiver validates Resend/SES(SNS) callbacks and persists the
// resulting delivery events into the local SQLite `events` table. In the
// self-hosted client there is no local event store — the operator's server runs
// the durable webhook receiver — so this stub fails loud while preserving the
// signature. The pure payload parsers/verifiers above remain exported for reuse.
export function createWebhookServer(
  _port: number,
  _providerId?: string,
  _webhookSecret?: string,
  _deps: { verifySns?: (body: Record<string, unknown>) => Promise<boolean> } = {},
): never {
  throw new Error(
    "createWebhookServer is not available in the self-hosted client; the durable provider webhook receiver runs on the self-hosted server.",
  );
}
