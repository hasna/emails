/** Public deployment-mode and local SQLite entry point for @hasna/emails/storage. */
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
  resolveEmailsModeSelection,
} from "./lib/mode.js";

export type {
  EmailsMode,
  EmailsModeLabel,
  EmailsModeResolution,
  EmailsModeSource,
} from "./lib/mode.js";

export {
  closeDatabase,
  databaseFileExists,
  getDatabase,
  getDatabasePath,
  isDatabaseOpen,
  listPartialIdMatches,
  resetDatabase,
  resolvePartialId,
  resolvePartialIdOrThrow,
  runInTransaction,
} from "./db/database.js";
export type { Database } from "./db/database.js";
