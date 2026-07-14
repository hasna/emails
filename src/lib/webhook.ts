import * as local from "./webhook.local.js";
import * as remote from "./webhook.remote.js";
import { getEmailsMode } from "./mode.js";

export {
  parseResendWebhook,
  parseSesWebhook,
  verifyResendSignature,
  verifySnsStructure,
} from "./webhook-events.js";
export type { WebhookEvent } from "./webhook-events.js";

export const createWebhookServer: typeof local.createWebhookServer = (...args) =>
  (getEmailsMode() === "self_hosted" ? remote.createWebhookServer : local.createWebhookServer)(...args);
