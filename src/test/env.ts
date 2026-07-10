import { resetCloudConfigCache } from "../db/cloud-store.js";

export const EMAILS_TEST_ENV_KEYS = [
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "HASNA_EMAILS_MODE",
  "EMAILS_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_API_URL",
  "HASNA_EMAILS_API_KEY",
  "EMAILS_API_URL",
  "EMAILS_API_KEY",
] as const;

export function clearEmailsTestEnv(): void {
  for (const key of EMAILS_TEST_ENV_KEYS) delete process.env[key];
  resetCloudConfigCache();
}
