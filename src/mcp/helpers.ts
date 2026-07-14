/**
 * Shared utilities for MCP tool modules.
 */

import { resolveResourceIdOrThrow } from "../db/self-hosted-store.js";
import { getDatabase, resolvePartialIdOrThrow } from "../db/database.js";
import { getEmailsMode } from "../lib/mode.js";
import {
  ProviderNotFoundError,
  DomainNotFoundError,
  AddressNotFoundError,
  EmailNotFoundError,
} from "../types/index.js";

export function formatError(error: unknown): string {
  if (error instanceof ProviderNotFoundError) return `Provider not found: ${error.providerId}`;
  if (error instanceof DomainNotFoundError) return `Domain not found: ${error.domainId}`;
  if (error instanceof AddressNotFoundError) return `Address not found: ${error.addressId}`;
  if (error instanceof EmailNotFoundError) return `Email not found: ${error.emailId}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

// The historical SQL table names callers pass, mapped to the operator's `/v1`
// resource path. Ids resolve against the self-hosted API — this client has no
// local database.
const RESOLVE_ID_RESOURCE: Record<string, string> = {
  emails: "messages",
  scheduled_emails: "scheduled",
  send_keys: "send-keys",
};

export function resolveId(table: string, partialId: string): string {
  if (getEmailsMode() === "local") {
    return resolvePartialIdOrThrow(getDatabase(), table, partialId);
  }
  const resource = RESOLVE_ID_RESOURCE[table] ?? table;
  return resolveResourceIdOrThrow(resource, partialId);
}

export { ProviderNotFoundError, DomainNotFoundError, AddressNotFoundError, EmailNotFoundError };
