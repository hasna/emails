// Pure inbound-MIME normalizer shared by the local S3 sync and the self_hosted
// ingest worker.
//
// Takes a raw RFC822 message (as fetched from the SES→S3 archive) and produces
// the exact field shape the self_hosted message store expects for an *inbound* row,
// mirroring the mapping the historical backfill used (`src/lib/s3-sync.ts`):
//   - from_addr  = the full From header text ("Name <addr>")
//   - to/cc      = the parsed address list (bare addresses)
//   - received_at = the message Date header (ISO), when present
//   - headers    = a flat { lowercased-name: value } object
//   - attachments = metadata plus base64 bytes for authenticated retrieval
//
// This module is dependency-free apart from a lazily-imported `mailparser`, so
// it is safe to import from the server bundle without dragging in the SQLite
// data layer.

type MailparserSdk = typeof import("mailparser");
let mailparserPromise: Promise<MailparserSdk> | undefined;
function loadMailparser(): Promise<MailparserSdk> {
  mailparserPromise ??= import("mailparser");
  return mailparserPromise;
}

export interface InboundAttachmentMeta {
  filename: string;
  content_type: string;
  size: number;
  /** Base64 content persisted by self-hosted Postgres for authenticated retrieval. */
  content_base64: string;
}

export interface NormalizedInboundEmail {
  /** Full From header text, e.g. `"Acme" <no-reply@acme.com>`. */
  from_addr: string;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string;
  body_text: string | null;
  body_html: string | null;
  /** Flat header map (lowercased names) — includes the RFC `message-id`. */
  headers: Record<string, string>;
  /** RFC Message-ID with angle brackets stripped, or null. */
  rfc_message_id: string | null;
  /** RFC In-Reply-To with angle brackets stripped, or null. */
  in_reply_to: string | null;
  /** Original receipt time from the Date header (ISO 8601), or null. */
  received_at: string | null;
  attachments: InboundAttachmentMeta[];
}

/** Flatten mailparser's header Map (or object) to a plain string map. */
export function flattenHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries: Iterable<[string, unknown]> =
    headers instanceof Map ? headers.entries() : Object.entries(headers as Record<string, unknown>);
  for (const [k, v] of entries) {
    out[k] =
      typeof v === "string" ? v
      : Array.isArray(v) ? v.map(String).join(" ")
      : v && typeof v === "object" && "text" in (v as Record<string, unknown>)
        ? String((v as Record<string, unknown>).text)
        : String(v);
  }
  return out;
}

function stripAngles(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = String(value).replace(/[<>]/g, "").trim();
  return trimmed || null;
}

interface AddressLike {
  value?: Array<{ address?: string | null }>;
}

function addressList(field: unknown): string[] {
  if (!field) return [];
  const arr = Array.isArray(field) ? field : [field];
  return arr
    .flatMap((a) => (a as AddressLike).value?.map((v) => v.address ?? "") ?? [])
    .filter((a): a is string => Boolean(a));
}

/**
 * Parse a raw RFC822 email into the normalized inbound shape. Robust to real-
 * world multipart/nested/encoded mail via `mailparser`.
 */
export async function parseInboundMime(raw: string | Buffer | Uint8Array): Promise<NormalizedInboundEmail> {
  const { simpleParser } = await loadMailparser();
  const parsed = await simpleParser(raw as Buffer);

  const from = parsed.from as { text?: string; value?: Array<{ address?: string | null }> } | undefined;
  const from_addr =
    typeof from?.text === "string" && from.text.trim()
      ? from.text.trim()
      : from?.value?.[0]?.address ?? "";

  const headers = flattenHeaders(parsed.headers);
  const attachments: InboundAttachmentMeta[] = (parsed.attachments ?? []).map((a) => ({
    filename: a.filename ?? "attachment",
    content_type: a.contentType ?? "application/octet-stream",
    size: typeof a.size === "number" ? a.size : 0,
    content_base64: Buffer.from(a.content).toString("base64"),
  }));

  return {
    from_addr,
    to_addrs: addressList(parsed.to),
    cc_addrs: addressList(parsed.cc),
    subject: parsed.subject ?? "",
    body_text: parsed.text ?? null,
    body_html: typeof parsed.html === "string" ? parsed.html : null,
    headers,
    rfc_message_id: stripAngles(parsed.messageId ?? headers["message-id"] ?? null),
    in_reply_to: stripAngles(parsed.inReplyTo ?? headers["in-reply-to"] ?? null),
    received_at: parsed.date instanceof Date ? parsed.date.toISOString() : null,
    attachments,
  };
}
