/**
 * Data layer for the Emails UI (`emails ui`) — self-hosted-ONLY.
 *
 * Presents a unified mail view over the operator's `/v1` API. This module stays
 * SYNCHRONOUS (the TUI and CLI import it without awaiting): all reads route
 * through the curl-backed synchronous self-hosted store (selfHostedStoreFor) and
 * the already-/v1-routed repositories (domains, addresses, providers). The
 * shared mail DTOs + pure helpers live in ../../lib/mail-types.js and are
 * re-exported here for back-compat with existing importers.
 *
 * The `/v1` message model has NO thread_id column (threads are server-derived by
 * normalized subject) and no provider/source dimension on a message, so
 * conversation grouping is by subject and source scoping is limited to
 * address/domain. Reads that cannot be mapped cleanly degrade to empty results /
 * zero counts rather than throwing, so the TUI never crashes.
 */
import { uuid } from "../../db/runtime.js";
import { selfHostedStoreFor, type SelfHostedResourceStore } from "../../db/self-hosted-store.js";
import { cbool, cnum, cobj, cstr, cstrArray, cstrOrNull, carray } from "../../db/self-hosted-resource.js";
import {
  setInboundReadFlag, setInboundArchivedFlag, setInboundStarredFlag,
  addInboundLabelSummary, removeInboundLabelSummary,
} from "../../db/inbound.js";
import { listDomains } from "../../db/domains.js";
import { findAddressesByEmail, listAddresses } from "../../db/addresses.js";
import { getLatestActiveProviderId } from "../../db/providers.js";
import { getInboundBuckets, loadConfig, saveConfig } from "../../lib/config.js";
import { assessDomainReadiness } from "../../lib/domain-readiness.js";
import { resolveEmailsMode } from "../../lib/mode.js";
import { listS3Sources } from "../../lib/s3-sync.js";
import { normalizeThemeMode, type TuiThemeMode } from "./theme.js";
import {
  type AttachmentInfo,
  type ComposeInput,
  type ConversationBodyOptions,
  type LabelSummary,
  type ListLabelSummaryOptions,
  type ListMailboxSourcesOptions,
  type Mailbox,
  type MailboxCounts,
  type MailboxListOptions,
  type MailboxSource,
  type MailboxSourceSummary,
  type MailboxStatusOptions,
  type MailboxStatusSummary,
  type MessageBody,
  type TuiMessage,
  type TuiThreadBody,
  type TuiThreadMessage,
  COMMON_LABELS,
  MAILBOXES,
  emptyMailboxCounts,
  fallbackMessageSummary,
  mailboxLabel,
  nonNegativeInt,
  normalizeIsoDate,
  normalizeMailbox,
  positiveInt,
  renderMarkdown,
  snippetOf,
  threadItemToMessage,
} from "../../lib/mail-types.js";

// Re-export the shared mail vocabulary (DTOs + pure helpers) for existing
// importers of ../../cli/tui/data.js.
export * from "../../lib/mail-types.js";

const MESSAGE_RESOURCE = "messages";

// Bounded, TTL-cached full scan. One scan serves list/counts/status/labels/
// conversation within a short window; mutations invalidate it.
const SELF_HOSTED_MAIL_PAGE = 500;
const SELF_HOSTED_MAIL_SCAN_CAP = 5000;
const SELF_HOSTED_MAIL_SCAN_TTL_MS = 4000;

let mailScanCache: { at: number; rows: Record<string, unknown>[] } | null = null;

function messagesStore(): SelfHostedResourceStore {
  return selfHostedStoreFor(MESSAGE_RESOURCE);
}

/** Full, bounded scan of the operator store. Degrades to [] if unreachable. */
function scanAllMessages(): Record<string, unknown>[] {
  const cached = mailScanCache;
  if (cached && Date.now() - cached.at < SELF_HOSTED_MAIL_SCAN_TTL_MS) return cached.rows;
  const rows: Record<string, unknown>[] = [];
  try {
    const store = messagesStore();
    for (let offset = 0; offset < SELF_HOSTED_MAIL_SCAN_CAP; offset += SELF_HOSTED_MAIL_PAGE) {
      const page = store.list({ limit: SELF_HOSTED_MAIL_PAGE, offset });
      rows.push(...page);
      if (page.length < SELF_HOSTED_MAIL_PAGE) break;
    }
  } catch {
    // A missing/unreachable serve yields an empty view rather than crashing the
    // TUI. Not cached, so the next read retries.
    return [];
  }
  mailScanCache = { at: Date.now(), rows };
  return rows;
}

function getMessageRow(id: string): Record<string, unknown> | null {
  try {
    return messagesStore().get(id);
  } catch {
    return null;
  }
}

function invalidateMailScan(): void {
  mailScanCache = null;
}

// ── /v1 message row helpers ────────────────────────────────────────────────

function bareEmail(value: string): string {
  const angled = value.match(/<([^>]+)>/);
  return (angled ? angled[1]! : value).trim().toLowerCase();
}

function v1Labels(row: Record<string, unknown>): string[] {
  return cstrArray(row["labels"]);
}

function v1IsOutbound(row: Record<string, unknown>): boolean {
  return cstr(row["direction"]).toLowerCase() === "outbound";
}

function v1HasLabel(row: Record<string, unknown>, name: string): boolean {
  return v1Labels(row).some((l) => l.trim().toLowerCase() === name);
}

function v1Date(row: Record<string, unknown>): string {
  return cstrOrNull(row["received_at"]) ?? cstrOrNull(row["created_at"]) ?? "";
}

// Drop the redundant system `unread` label on a read message (parity with the
// async self-hosted data source).
function visibleLabels(labels: string[], isRead: boolean): string[] {
  return isRead ? labels.filter((l) => l.trim().toLowerCase() !== "unread") : labels;
}

function v1AttachmentInfos(row: Record<string, unknown>): AttachmentInfo[] {
  return carray(row["attachments"]).map((attachment, index) => {
    const o = cobj(attachment);
    return {
      filename: cstr(o["filename"]) || `attachment-${index + 1}`,
      content_type: cstr(o["content_type"]) || "application/octet-stream",
      size: cnum(o["size"]),
    };
  });
}

function v1RowToTuiMessage(row: Record<string, unknown>): TuiMessage {
  const isRead = cbool(row["is_read"]);
  const outbound = v1IsOutbound(row);
  const labels = v1Labels(row);
  return {
    kind: outbound ? "sent" : "inbound",
    id: cstr(row["id"]),
    from: cstr(row["from_addr"]),
    to: cstrArray(row["to_addrs"]).join(", "),
    subject: cstr(row["subject"]) || "(no subject)",
    date: v1Date(row),
    is_read: outbound ? true : isRead,
    is_starred: cbool(row["is_starred"]),
    labels: visibleLabels(labels, isRead),
    snippet: snippetOf(cstrOrNull(row["snippet"]) ?? cstrOrNull(row["body_text"])),
    thread_id: null,
    provider_thread_id: null,
    attachments: v1AttachmentInfos(row).length,
    sentByMe: outbound || labels.some((l) => l.trim().toLowerCase() === "sent"),
  };
}

function v1RowToThreadMessage(row: Record<string, unknown>): TuiThreadMessage {
  return {
    kind: v1IsOutbound(row) ? "sent" : "received",
    storage: "inbound",
    id: cstr(row["id"]),
    from: cstr(row["from_addr"]),
    subject: cstr(row["subject"]) || "(no subject)",
    at: v1Date(row),
  };
}

// Which folder(s) a message belongs to (a message can count toward several).
function v1FolderMatch(row: Record<string, unknown>, folder: Mailbox): boolean {
  const outbound = v1IsOutbound(row);
  const archived = v1HasLabel(row, "archived");
  const spam = v1HasLabel(row, "spam") || cstr(row["status"]).toLowerCase() === "spam";
  const trash = v1HasLabel(row, "trash");
  switch (folder) {
    case "inbox": return !outbound && !archived && !spam && !trash;
    case "unread": return !outbound && !cbool(row["is_read"]) && !archived && !spam && !trash;
    case "starred": return !outbound && cbool(row["is_starred"]) && !archived && !spam && !trash;
    case "sent": return outbound;
    case "archived": return !outbound && archived && !spam && !trash;
    case "spam": return !outbound && spam;
    case "trash": return !outbound && trash;
    default: return false;
  }
}

// Source scoping over /v1 is limited to address/domain (a message carries no
// provider/s3/legacy provenance); those narrow to nothing.
function v1SourceMatch(row: Record<string, unknown>, source?: MailboxSource): boolean {
  if (!source) return true;
  if (source.unknown) return false;
  const address = source.address?.trim().toLowerCase();
  if (address) {
    const recipients = cstrArray(row["to_addrs"]).map(bareEmail);
    return recipients.includes(address) || bareEmail(cstr(row["from_addr"])) === address;
  }
  const domain = source.domain?.trim().toLowerCase();
  if (domain) {
    return cstrArray(row["to_addrs"]).map(bareEmail).some((r) => r.endsWith(`@${domain}`));
  }
  return false;
}

function v1SinceMatch(row: Record<string, unknown>, since?: string): boolean {
  if (!since) return true;
  const t = Date.parse(v1Date(row));
  return Number.isFinite(t) && t >= Date.parse(since);
}

function v1SearchMatch(row: Record<string, unknown>, query?: string): boolean {
  const q = query?.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    cstr(row["from_addr"]),
    cstrArray(row["to_addrs"]).join(" "),
    cstr(row["subject"]),
    cstr(row["body_text"]),
    cstr(row["snippet"]),
  ].join(" ").toLowerCase();
  return hay.includes(q);
}

function normalizeSubjectKey(subject: string): string {
  let s = subject;
  while (/^\s*(re|fwd|fw)\s*:/i.test(s)) s = s.replace(/^\s*(re|fwd|fw)\s*:\s*/i, "");
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// ── mode / config helpers (unchanged; read config, not the DB) ─────────────

function isSelfHostedTuiMode(): boolean {
  const explicitMode = process.env["EMAILS_MODE"]?.trim() || process.env["HASNA_EMAILS_MODE"]?.trim();
  if (explicitMode === "self_hosted") return true;
  if (explicitMode === "local") return false;
  if (!process.env["EMAILS_CLIENT_ENV_SECRET"]?.trim()) return false;
  try {
    return resolveEmailsMode().mode === "self_hosted";
  } catch (error) {
    throw error;
  }
}

function pageFromOptions(opts: { limit?: number; offset?: number } | undefined, fallbackLimit: number): { limit: number; offset: number } | undefined {
  if (!opts) return undefined;
  return {
    limit: positiveInt(opts.limit, fallbackLimit),
    offset: nonNegativeInt(opts.offset, 0),
  };
}

function extractEmail(value: unknown): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  const bracketed = raw.match(/<\s*([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)\s*>/);
  const email = bracketed?.[1] ?? raw;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

// ── source references (config/S3; no DB) ────────────────────────────────────

function normalizeSourceId(value: string | undefined): MailboxSource {
  const raw = value?.trim();
  if (!raw || raw === "all") return {};
  if (raw === "legacy") return { sourceId: "legacy", legacy: true };
  if (raw.startsWith("provider:")) return { sourceId: raw, providerId: raw.slice("provider:".length) };
  if (raw.startsWith("orphaned:")) return { sourceId: raw, providerId: raw.slice("orphaned:".length) };
  if (raw.startsWith("s3:")) {
    const bucket = decodeURIComponent(raw.slice("s3:".length));
    const configured = getInboundBuckets().find((candidate) => candidate.bucket === bucket);
    return { sourceId: raw, s3Bucket: bucket, providerId: configured?.providerId };
  }
  const s3Source = listS3Sources().find((candidate) => candidate.id === raw);
  if (s3Source) {
    return { sourceId: raw, s3Bucket: s3Source.bucket, s3Prefix: s3Source.prefix, providerId: s3Source.provider_id };
  }
  return { sourceId: raw, unknown: true };
}

function hasSourceFilter(source: MailboxSource | undefined): boolean {
  return !!(source?.sourceId || source?.providerId || source?.domain || source?.address || source?.s3Bucket || source?.s3Prefix || source?.legacy || source?.unknown);
}

export function mailboxSourceFromRef(input?: MailboxSource): MailboxSource | undefined {
  if (!input) return undefined;
  const fromId = normalizeSourceId(input.sourceId);
  const normalized: MailboxSource = {
    ...fromId,
    ...input,
    providerId: input.providerId ?? fromId.providerId,
    s3Bucket: input.s3Bucket ?? fromId.s3Bucket,
    s3Prefix: input.s3Prefix ?? fromId.s3Prefix,
    legacy: input.legacy ?? fromId.legacy,
  };
  if (!hasSourceFilter(normalized)) return undefined;
  return normalized;
}

// True when a source narrows the view but has no /v1-expressible scope
// (provider/s3/legacy/unknown) — such a source matches nothing.
function sourceMatchesNothing(source: MailboxSource | undefined): boolean {
  return !!source && !source.address && !source.domain;
}

// ── mailbox listing / counts ────────────────────────────────────────────────

export function listMailbox(mailbox: Mailbox, opts?: MailboxListOptions): TuiMessage[] {
  const selectedMailbox = normalizeMailbox(mailbox);
  const source = mailboxSourceFromRef(opts?.source);
  if (sourceMatchesNothing(source)) return [];
  const limit = positiveInt(opts?.limit, 200);
  const offset = nonNegativeInt(opts?.offset, 0);
  const since = normalizeIsoDate(opts?.since);
  const label = opts?.label?.trim().toLowerCase();
  const rows = scanAllMessages().filter((row) =>
    v1FolderMatch(row, selectedMailbox)
    && v1SourceMatch(row, source)
    && v1SinceMatch(row, since)
    && (!label || v1Labels(row).some((l) => l.trim().toLowerCase() === label))
    && v1SearchMatch(row, opts?.search),
  );
  rows.sort((a, b) => opts?.sort === "oldest" ? v1Date(a).localeCompare(v1Date(b)) : v1Date(b).localeCompare(v1Date(a)));
  return rows.slice(offset, offset + limit).map(v1RowToTuiMessage);
}

interface MailboxStats {
  counts: MailboxCounts;
  total: number;
  unread: number;
  latestReceivedAt: string | null;
}

function scanMailboxStats(source?: MailboxSource): MailboxStats {
  const counts = emptyMailboxCounts();
  if (sourceMatchesNothing(source)) return { counts, total: 0, unread: 0, latestReceivedAt: null };
  let latest: string | null = null;
  for (const row of scanAllMessages()) {
    if (!v1SourceMatch(row, source)) continue;
    for (const folder of MAILBOXES) {
      if (v1FolderMatch(row, folder)) counts[folder] += 1;
    }
    if (!v1IsOutbound(row)) {
      const d = v1Date(row);
      if (d && (latest === null || d > latest)) latest = d;
    }
  }
  const total = counts.inbox + counts.archived + counts.spam + counts.trash;
  return { counts, total, unread: counts.unread, latestReceivedAt: latest };
}

/** Folder counts. */
export function mailboxCounts(opts?: { source?: MailboxSource }): MailboxCounts {
  return scanMailboxStats(mailboxSourceFromRef(opts?.source)).counts;
}

export function listMailboxStatus(opts?: MailboxStatusOptions): MailboxStatusSummary {
  const counts = mailboxCounts({ source: opts?.source });
  return {
    counts,
    folders: MAILBOXES.map((folder) => ({
      id: folder,
      folder,
      label: mailboxLabel(folder),
      count: counts[folder],
    })),
  };
}

export function searchMailbox(query: string, opts?: Omit<MailboxListOptions, "search"> & { mailbox?: Mailbox }): TuiMessage[] {
  return listMailbox(opts?.mailbox ?? "inbox", { ...opts, search: query });
}

// The self-hosted serve is a single shared store — expose it as one source so
// `inbox sources` / status stay informative rather than empty.
export function listMailboxSources(opts?: ListMailboxSourcesOptions): MailboxSourceSummary[] {
  const stats = scanMailboxStats(undefined);
  const source: MailboxSourceSummary = {
    id: "all",
    label: "Self-hosted Emails",
    kind: "all",
    badges: ["self_hosted"],
    counts: stats.counts,
    total: stats.total,
    unread: stats.unread,
    latestReceivedAt: opts?.includeLatest === false ? null : stats.latestReceivedAt,
  };
  const q = opts?.search?.trim().toLowerCase();
  if (q) {
    const haystack = [source.id, source.label, source.kind, ...source.badges].join(" ").toLowerCase();
    if (!haystack.includes(q)) return [];
  }
  return [source].slice(0, positiveInt(opts?.limit, 100));
}

// ── message body / conversation ─────────────────────────────────────────────

export function getMessageBody(msg: TuiMessage): MessageBody | null {
  const row = getMessageRow(msg.id);
  if (!row) return null;
  const isRead = cbool(row["is_read"]);
  const labels = visibleLabels(v1Labels(row), isRead);
  const archived = v1HasLabel(row, "archived");
  const text = cstrOrNull(row["body_text"]);
  const html = cstrOrNull(row["body_html"]);
  const subject = cstr(row["subject"]) || "(no subject)";
  return {
    from: cstr(row["from_addr"]),
    to: cstrArray(row["to_addrs"]).join(", "),
    cc: cstrArray(row["cc_addrs"]).join(", "),
    subject,
    date: v1Date(row),
    text,
    html,
    summary: fallbackMessageSummary(subject, text, html),
    flags: [isRead ? "read" : "unread", cbool(row["is_starred"]) && "starred", archived && "archived", ...labels].filter(Boolean) as string[],
    attachments: v1AttachmentInfos(row),
  };
}

/** The conversation for a message, grouped by normalized subject (server model). */
export function getConversation(msg: TuiMessage): TuiThreadMessage[] {
  const row = getMessageRow(msg.id);
  if (!row) return [];
  const key = normalizeSubjectKey(cstr(row["subject"]));
  const byId = new Map<string, Record<string, unknown>>();
  for (const candidate of scanAllMessages()) {
    if (normalizeSubjectKey(cstr(candidate["subject"])) === key) byId.set(cstr(candidate["id"]), candidate);
  }
  byId.set(cstr(row["id"]), row);
  return [...byId.values()]
    .sort((a, b) => v1Date(a).localeCompare(v1Date(b)))
    .map(v1RowToThreadMessage);
}

export function getConversationBodies(msg: TuiMessage, opts?: ConversationBodyOptions): TuiThreadBody[] {
  const conversation = getConversation(msg);
  const allItems = conversation.length > 0
    ? conversation
    : [{
      kind: msg.sentByMe ? "sent" as const : "received" as const,
      storage: msg.kind === "sent" ? "email" as const : "inbound" as const,
      id: msg.id,
      from: msg.from,
      subject: msg.subject,
      at: msg.date,
    }];
  const limit = opts?.limit ? positiveInt(opts.limit, 100) : undefined;
  const items = limit && allItems.length > limit ? allItems.slice(-limit) : allItems;
  return items.map((item) => ({
    item,
    body: getMessageBody(threadItemToMessage(item, msg)),
  }));
}

// ── mutations (inbound only; sent messages are immutable) ──────────────────────

export function toggleStar(msg: TuiMessage): boolean {
  if (msg.kind !== "inbound") return msg.is_starred;
  invalidateMailScan();
  return setInboundStarredFlag(msg.id, !msg.is_starred);
}

export function toggleRead(msg: TuiMessage): boolean {
  if (msg.kind !== "inbound") return msg.is_read;
  invalidateMailScan();
  return setInboundReadFlag(msg.id, !msg.is_read);
}

export function markRead(msg: TuiMessage): void {
  if (msg.kind === "inbound" && !msg.is_read) {
    invalidateMailScan();
    setInboundReadFlag(msg.id, true);
  }
}

export function archiveMessage(msg: TuiMessage, archived = true): void {
  if (msg.kind === "inbound") {
    invalidateMailScan();
    setInboundArchivedFlag(msg.id, archived);
  }
}

export function toggleMessageLabel(msg: TuiMessage, label: string): string[] {
  if (msg.kind !== "inbound") return msg.labels;
  const normalized = normalizeLabelLocal(label);
  if (!normalized) return msg.labels;
  invalidateMailScan();
  const labels = new Set(msg.labels.map((item) => normalizeLabelLocal(item)).filter(Boolean));
  const next = labels.has(normalized)
    ? removeInboundLabelSummary(msg.id, normalized).label_ids
    : addInboundLabelSummary(msg.id, normalized).label_ids;
  return next.map(normalizeLabelLocal).filter(Boolean);
}

function normalizeLabelLocal(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 64);
}

// ── labels ──────────────────────────────────────────────────────────────────

export function listLabelSummaries(opts?: ListLabelSummaryOptions): LabelSummary[] {
  const counts = new Map<string, number>();
  for (const row of scanAllMessages()) {
    for (const raw of v1Labels(row)) {
      const name = raw.trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  for (const label of COMMON_LABELS) counts.set(label, counts.get(label) ?? 0);

  const commonRank = new Map<string, number>(COMMON_LABELS.map((label, index) => [label, index]));
  let labels = [...counts.entries()].map(([name, count]) => ({ name, count, popular: count > 0 }));
  const q = opts?.search?.trim().toLowerCase();
  if (q) labels = labels.filter((label) => label.name.includes(q));
  labels.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    const aRank = commonRank.get(a.name) ?? Number.MAX_SAFE_INTEGER;
    const bRank = commonRank.get(b.name) ?? Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return a.name.localeCompare(b.name);
  });
  return labels.slice(0, positiveInt(opts?.limit, 50));
}

// ── compose / reply ────────────────────────────────────────────────────────────

export function activeProviderId(): string | null {
  try {
    return getLatestActiveProviderId();
  } catch {
    return null;
  }
}

export function providerIdForSender(address: string): string | null {
  const normalized = extractEmail(address);
  if (!normalized) return null;
  try {
    const matches = findAddressesByEmail(normalized).filter((a) => (a.status ?? "active") === "active");
    return matches.find((a) => a.verified)?.provider_id ?? matches[0]?.provider_id ?? null;
  } catch {
    return null;
  }
}

/** Pick the best configured sender for a new TUI compose. */
export function defaultFromAddress(opts?: { source?: MailboxSource; fallback?: string }): string {
  if (opts?.source?.address) return opts.source.address;
  if (opts?.fallback) return opts.fallback;
  try {
    const domain = opts?.source?.domain?.toLowerCase();
    const candidates = listAddresses(undefined, { limit: 200 })
      .map((address) => extractEmail(address.email))
      .filter((address): address is string => !!address)
      .filter((address) => !domain || address.endsWith(`@${domain}`));
    return candidates[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * Send a composed/replied message via the operator's `/v1/messages/send`
 * endpoint. By default the body is treated as MARKDOWN and rendered to HTML.
 * Delivery and thread rollup are server-owned.
 */
export async function sendComposed(input: ComposeInput): Promise<{ id: string; messageId: string }> {
  const to = input.to.split(",").map((s) => s.trim()).filter(Boolean);
  if (to.length === 0) throw new Error("At least one recipient is required.");
  if (!input.from) throw new Error("A From address is required.");
  const useMd = input.markdown !== false && input.body.trim().length > 0;
  const html = useMd ? renderMarkdown(input.body) : undefined;
  const body: Record<string, unknown> = {
    from: input.from,
    to,
    subject: input.subject,
    text: input.body,
    ...(html ? { html } : {}),
    idempotency_key: uuid(),
  };
  invalidateMailScan();
  const created = selfHostedStoreFor("messages/send").create(body);
  const rec = (created["message"] && typeof created["message"] === "object")
    ? created["message"] as Record<string, unknown>
    : created;
  const id = cstr(rec["id"]);
  return { id, messageId: cstr(rec["message_id"]) || id };
}

export interface DomainSummary {
  domain: string;
  provider: string;
  addresses: number;
  inbox: number;
  unread: number;
  sent: number;
  archived: number;
  total: number;
  readiness: string;
}

export interface ListDomainSummaryOptions {
  limit?: number;
  offset?: number;
}

export function listDomainSummaries(opts?: ListDomainSummaryOptions): DomainSummary[] {
  const page = pageFromOptions(opts, 50);
  try {
    const domains = listDomains(undefined, page);
    const addresses = listAddresses(undefined, { limit: 1000 });
    const addressCountByDomain = new Map<string, number>();
    for (const item of addresses) {
      const address = extractEmail(item.email);
      const domain = address?.split("@")[1];
      if (!domain || (item.status ?? "active") !== "active") continue;
      addressCountByDomain.set(domain, (addressCountByDomain.get(domain) ?? 0) + 1);
    }
    const mode = resolveEmailsMode();
    return domains
      .map((domain) => {
        const key = domain.domain.toLowerCase();
        return {
          domain: domain.domain,
          provider: domain.provider_id || "self_hosted",
          addresses: addressCountByDomain.get(key) ?? 0,
          inbox: 0,
          unread: 0,
          sent: 0,
          archived: 0,
          total: 0,
          readiness: assessDomainReadiness(domain, null, {
            mode: mode.mode,
            source_of_truth: domain.source_of_truth,
            inbound_status: domain.inbound_status,
          }).state,
        };
      })
      .sort((a, b) => a.domain.localeCompare(b.domain));
  } catch {
    return [];
  }
}

// ── inbox address choices ──────────────────────────────────────────────────────

export interface InboxAddressChoice {
  id: string;
  label: string;
  address?: string;
  domain?: string;
  providerId?: string;
  provider?: string;
  receiveStatus?: string;
  configured: boolean;
  observed: boolean;
}

export const ALL_ADDRESSES: InboxAddressChoice = {
  id: "all",
  label: "All mailboxes",
  configured: false,
  observed: false,
};

export interface ListInboxAddressOptions {
  limit?: number;
  search?: string;
}

/** User-facing mailbox choices: all mailboxes plus the configured addresses. */
export function listInboxAddresses(opts?: ListInboxAddressOptions): InboxAddressChoice[] {
  try {
    const limit = opts ? positiveInt(opts.limit, 200) : 200;
    const q = opts?.search?.trim().toLowerCase();
    const choices = listAddresses(undefined, { limit: Math.max(limit, 200) })
      .filter((item) => (item.status ?? "active") === "active")
      .map((item): InboxAddressChoice | null => {
        const address = extractEmail(item.email);
        if (!address) return null;
        return {
          id: `a:${address}`,
          label: item.display_name ? `${item.display_name} <${address}>` : address,
          address,
          domain: address.split("@")[1],
          providerId: item.provider_id || undefined,
          provider: item.provider_id || undefined,
          receiveStatus: item.verified ? "ready" : "pending",
          configured: true,
          observed: false,
        };
      })
      .filter((item): item is InboxAddressChoice => item !== null)
      .filter((item) => !q || [item.address, item.label, item.domain].some((value) => String(value ?? "").toLowerCase().includes(q)))
      .slice(0, limit);
    return opts?.search?.trim() ? choices : [ALL_ADDRESSES, ...choices];
  } catch {
    return opts?.search?.trim() ? [] : [ALL_ADDRESSES];
  }
}

export function addressChoiceByAddress(address: string | null | undefined): InboxAddressChoice {
  const normalized = extractEmail(address);
  if (!normalized) return ALL_ADDRESSES;
  return listInboxAddresses({ search: normalized, limit: 20 })
    .find((choice) => choice.address?.toLowerCase() === normalized)
    ?? {
      id: `a:${normalized}`,
      label: normalized,
      address: normalized,
      domain: normalized.split("@")[1],
      configured: false,
      observed: false,
    };
}

// ── ingestion sources ─────────────────────────────────────────────────────────

export interface InboxSource { id: string; label: string; providerId?: string; domain?: string }

/** The selectable ingestion sources (a single shared self-hosted store). */
export function listSources(): InboxSource[] {
  return listMailboxSources().map((source) => ({
    id: source.id,
    label: source.badges.length ? `${source.label} [${source.badges.join(", ")}]` : source.label,
    providerId: source.providerId,
  }));
}

// ── settings (persisted to config.json) ────────────────────────────────────────

export interface TuiSettings {
  autoPull: boolean;
  dimRead: boolean;
  defaultMailbox: Mailbox;
  defaultAddress: string | null;
  defaultFrom: string | null;
  theme: TuiThemeMode;
}

const DEFAULT_TUI_SETTINGS: TuiSettings = {
  autoPull: false,
  dimRead: false,
  defaultMailbox: "inbox",
  defaultAddress: null,
  defaultFrom: null,
  theme: "light",
};

export function getSettings(): TuiSettings {
  if (isSelfHostedTuiMode()) return { ...DEFAULT_TUI_SETTINGS };
  const c = loadConfig();
  return {
    autoPull: c["tui_autopull"] === true,
    dimRead: c["tui_dim_read"] === true, // default false = high contrast
    defaultMailbox: normalizeMailbox(c["default_mailbox"]),
    defaultAddress: extractEmail(c["tui_default_address"]) ?? null,
    defaultFrom: extractEmail(c["tui_default_from"]) ?? null,
    theme: c["tui_theme"] == null ? "light" : normalizeThemeMode(c["tui_theme"]),
  };
}

export function setSetting<K extends keyof TuiSettings>(key: K, value: TuiSettings[K]): void {
  if (isSelfHostedTuiMode()) {
    throw new Error("TUI settings write local config and are disabled in self_hosted API-only mode.");
  }
  const c = loadConfig();
  const map: Record<keyof TuiSettings, string> = {
    autoPull: "tui_autopull",
    dimRead: "tui_dim_read",
    defaultMailbox: "default_mailbox",
    defaultAddress: "tui_default_address",
    defaultFrom: "tui_default_from",
    theme: "tui_theme",
  };
  c[map[key]] = value as never;
  saveConfig(c);
}
