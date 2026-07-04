// Public `@hasna/mailery/storage` entry.
//
// The self-hosted PostgreSQL/S3 mirror surface (remote-storage, storage-sync,
// self-hosted-runtime) has been removed: the client has exactly two modes,
// `local` (SQLite) and `cloud` (API client, URL-configurable). This entry now
// only re-exports the still-public Mailery mode helpers.
export {
  HASNA_EMAILS_MODE_ENV,
  LEGACY_STORAGE_MODE_ENV,
  LEGACY_STORAGE_MODE_FALLBACK_ENV,
  MAILERY_MODE_CONFIG_KEY,
  MAILERY_MODE_ENV,
  MAILERY_MODE_ENV_KEYS,
  getMaileryMode,
  labelForMaileryMode,
  normalizeMaileryMode,
  resolveMaileryMode,
} from "./lib/mode.js";
export type {
  MaileryMode,
  MaileryModeLabel,
  MaileryModeResolution,
  MaileryModeSource,
} from "./lib/mode.js";
