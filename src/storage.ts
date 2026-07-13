/** Public deployment-mode entry point for @hasnaxyz/emails/storage. */
export {
  EMAILS_MODE_CONFIG_KEY,
  EMAILS_MODE_ENV,
  EMAILS_MODE_ENV_KEYS,
  HASNA_EMAILS_MODE_ENV,
  assertNoLegacyHostedEnvironment,
  getEmailsMode,
  labelForEmailsMode,
  normalizeEmailsMode,
  resolveEmailsMode,
} from "./lib/mode.js";

export type {
  EmailsMode,
  EmailsModeLabel,
  EmailsModeResolution,
  EmailsModeSource,
} from "./lib/mode.js";
