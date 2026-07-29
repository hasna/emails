import { listEmails } from "../db/emails.js";
import { listEvents } from "../db/events.js";
import type { EventType } from "../types/index.js";

export const EXPORT_DEFAULT_LIMIT = 1000;
export const EXPORT_MAX_LIMIT = 10000;

export interface EmailExportFilters {
  provider_id?: string;
  from_address?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface EventExportFilters {
  provider_id?: string;
  type?: EventType;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

function boundedPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.trunc(value));
}

function nonNegativeInt(value: number | undefined): number {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}

function normalizeEmailFilters(filters: EmailExportFilters): EmailExportFilters {
  return {
    ...filters,
    limit: boundedPositiveInt(filters.limit, EXPORT_DEFAULT_LIMIT, EXPORT_MAX_LIMIT),
    offset: nonNegativeInt(filters.offset),
  };
}

function normalizeEventFilters(filters: EventExportFilters): EventExportFilters {
  return {
    ...filters,
    limit: boundedPositiveInt(filters.limit, EXPORT_DEFAULT_LIMIT, EXPORT_MAX_LIMIT),
    offset: nonNegativeInt(filters.offset),
  };
}

function csvCell(value: unknown): string {
  const text = Array.isArray(value) ? JSON.stringify(value) : String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function exportEmailsCsv(filters: EmailExportFilters): Promise<string> {
  const emails = await listEmails(normalizeEmailFilters(filters));
  const header = "id,from,to,subject,status,sent_at";
  const rows = emails.map(e =>
    [e.id, e.from_address, e.to_addresses, e.subject, e.status, e.sent_at].map(csvCell).join(",")
  );
  return [header, ...rows].join("\n");
}

export async function exportEmailsJson(filters: EmailExportFilters): Promise<string> {
  return JSON.stringify(await listEmails(normalizeEmailFilters(filters)), null, 2);
}

// ASYNC now, like their email siblings above: the collapsed events family reads
// through the store seam and every seam operation is a promise. An empty export is
// an HONEST empty here — `listEvents` throws on a refused, faulted or incomplete
// enumeration rather than returning a short set — so "[]" from these functions means
// the filtered set is genuinely empty. (That the CLI prints the bare "[]" with no
// provenance line is a presentation gap in the CLI layer, not a truth gap here.)
export async function exportEventsCsv(filters: EventExportFilters): Promise<string> {
  const events = await listEvents(normalizeEventFilters(filters));
  const header = "id,email_id,type,recipient,occurred_at";
  const rows = events.map(e => [e.id, e.email_id || "", e.type, e.recipient || "", e.occurred_at].map(csvCell).join(","));
  return [header, ...rows].join("\n");
}

export async function exportEventsJson(filters: EventExportFilters): Promise<string> {
  return JSON.stringify(await listEvents(normalizeEventFilters(filters)), null, 2);
}
