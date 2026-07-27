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

// The store seam's contract (src/store/). TYPES ONLY — `export type` is erased, so
// this adds no runtime export, no bundled code and no behaviour; it publishes the
// interface the two store implementations will satisfy, on the surface where the
// storage contract belongs.
//
// This re-export is also what makes the seam REACHABLE for
// src/entrypoint-reachability.test.ts. That guard exists because unreachable modules
// rot while their own unit tests stay green, and a declared-but-unimported seam is
// exactly that shape. Adding eight entries to its allowlist would have been exempting
// the guard rather than satisfying it, so the seam is attached to a shipped entrypoint
// instead. The repository and record types reach consumers through `EmailStore`.
export type {
  CapabilityKey,
  EmailStore,
  Outcome,
  Refusal,
  RefusalCode,
  RefusalStatus,
  StoreCapabilities,
  StoreDescriptor,
  Success,
} from "./store/index.js";
