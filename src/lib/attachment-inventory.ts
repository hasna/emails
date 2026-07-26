export const DEFAULT_ATTACHMENT_INVENTORY_LIMIT = 100;
export const MAX_ATTACHMENT_INVENTORY_LIMIT = 500;

export type AttachmentInventoryDirection = "inbound" | "outbound";

export interface AttachmentInventoryQueryInput {
  limit?: unknown;
  cursor?: unknown;
  direction?: unknown;
  since?: unknown;
}

export interface AttachmentInventoryQuery {
  limit: number;
  cursor?: string;
  direction?: AttachmentInventoryDirection;
  since?: string;
}

export interface SafeAttachmentInventoryItem {
  message_id: string;
  attachment_index: number;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  content_available: boolean;
  direction: AttachmentInventoryDirection | null;
  received_at: string | null;
}

export interface SafeAttachmentInventoryPage {
  items: SafeAttachmentInventoryItem[];
  next_cursor: string | null;
}

function attachmentInventoryLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_ATTACHMENT_INVENTORY_LIMIT;
  const text = typeof value === "string" ? value : String(value);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(`limit must be an integer between 1 and ${MAX_ATTACHMENT_INVENTORY_LIMIT}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_ATTACHMENT_INVENTORY_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_ATTACHMENT_INVENTORY_LIMIT}`);
  }
  return parsed;
}

function attachmentInventoryCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("cursor must be a non-empty opaque string");
  }
  return value;
}

function attachmentInventoryDirection(value: unknown): AttachmentInventoryDirection | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("direction must be inbound or outbound");
  const normalized = value.trim().toLowerCase();
  if (normalized !== "inbound" && normalized !== "outbound") {
    throw new Error("direction must be inbound or outbound");
  }
  return normalized;
}

function attachmentInventorySince(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("since must be a valid date");
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`since must be a valid date: ${value}`);
  return new Date(time).toISOString();
}

export function normalizeAttachmentInventoryQuery(input: AttachmentInventoryQueryInput = {}): AttachmentInventoryQuery {
  return {
    limit: attachmentInventoryLimit(input.limit),
    cursor: attachmentInventoryCursor(input.cursor),
    direction: attachmentInventoryDirection(input.direction),
    since: attachmentInventorySince(input.since),
  };
}

function selfHostedClientBaseUrl(v1BaseUrl: string): string {
  const url = new URL(v1BaseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? path.slice(0, -3) || "/" : path || "/";
  return url.toString().replace(/\/+$/, "");
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableAttachmentSize(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw new Error("self-hosted attachment inventory returned an invalid size_bytes");
  }
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error("self-hosted attachment inventory returned an invalid size_bytes");
}

function safeAttachmentInventoryItem(value: unknown): SafeAttachmentInventoryItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("self-hosted attachment inventory returned a malformed item");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw["message_id"] !== "string" || raw["message_id"].length === 0) {
    throw new Error("self-hosted attachment inventory returned an item without message_id");
  }
  if (!Number.isSafeInteger(raw["attachment_index"]) || Number(raw["attachment_index"]) < 0) {
    throw new Error("self-hosted attachment inventory returned an invalid attachment_index");
  }
  if (typeof raw["content_available"] !== "boolean") {
    throw new Error("self-hosted attachment inventory returned an invalid content_available");
  }
  const rawDirection = raw["direction"];
  const direction =
    rawDirection === "inbound" || rawDirection === "outbound"
      ? rawDirection
      : null;
  const item: SafeAttachmentInventoryItem = {
    message_id: raw["message_id"],
    attachment_index: Number(raw["attachment_index"]),
    filename: nullableString(raw["filename"]),
    content_type: nullableString(raw["content_type"]),
    size_bytes: nullableAttachmentSize(raw["size_bytes"]),
    sha256: nullableString(raw["sha256"]),
    content_available: raw["content_available"],
    direction,
    received_at: nullableString(raw["received_at"]),
  };
  return item;
}

function safeAttachmentInventoryPage(value: unknown): SafeAttachmentInventoryPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("self-hosted attachment inventory returned a malformed page");
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw["items"])) {
    throw new Error("self-hosted attachment inventory returned a page without items");
  }
  const nextCursor = raw["next_cursor"];
  if (
    nextCursor !== null
    && (typeof nextCursor !== "string" || nextCursor.trim().length === 0)
  ) {
    throw new Error("self-hosted attachment inventory returned a malformed next_cursor");
  }
  return {
    items: raw["items"].map(safeAttachmentInventoryItem),
    next_cursor: nextCursor,
  };
}

export async function listSelfHostedAttachments(
  input: AttachmentInventoryQueryInput = {},
): Promise<SafeAttachmentInventoryPage> {
  const query = normalizeAttachmentInventoryQuery(input);
  const [{ resolveSelfHostedConfig }, { resolveEmailsModeSelection }, { EmailsSelfHostClient }] = await Promise.all([
    import("../db/self-hosted-store.js"),
    import("./mode.js"),
    import("../selfhost.js"),
  ]);
  const selectedMode = resolveEmailsModeSelection().mode;
  if (selectedMode !== "self_hosted") {
    throw new Error("attachment inventory is available only in self_hosted mode");
  }
  const config = resolveSelfHostedConfig(process.env, { selectedMode });
  const client = new EmailsSelfHostClient({
    baseUrl: selfHostedClientBaseUrl(config.baseUrl),
    bearerToken: config.credential,
  });
  return safeAttachmentInventoryPage(await client.listAttachments(query));
}
