// Opaque keyset cursors.
//
// The `keysetPagination` capability is a claim about a TOTAL SORT ORDER, not
// about the presence of a `cursor` parameter: an interrupted scan must resume at
// exactly the next row, never re-emitting and never skipping one. Both cursors
// below pin every component of their order, which is what makes that true —
// `(sort_ts, id)` for messages and `(sort_ts, message_id, attachment_index)` for
// the attachment inventory, matching the strongest arm's orders exactly.
//
// Cursors are OPAQUE: callers receive `next_cursor` and hand it back. A
// malformed or truncated one is rejected rather than coerced, because a cursor
// that silently decodes to "start from the beginning" turns a resumed scan into
// a duplicate one.

const CURSOR_ALPHABET = /^[A-Za-z0-9_-]+$/;
const MAX_CURSOR_CHARS = 2048;

export interface MessageCursor {
  v: 1;
  ts: string;
  id: string;
}

export interface AttachmentCursor {
  v: 1;
  ts: string;
  id: string;
  idx: number;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Decode to a plain object, or null when the token is not one we minted. */
function decode(cursor: string): Record<string, unknown> | null {
  if (!cursor || cursor.length > MAX_CURSOR_CHARS || !CURSOR_ALPHABET.test(cursor)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  // base64url is not injective over arbitrary input; re-encoding proves the token
  // is exactly what we emitted rather than something that merely decodes.
  if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) return null;
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function encodeMessageCursor(ts: string, id: string): string {
  return encode({ v: 1, ts, id });
}

export function decodeMessageCursor(cursor: string): MessageCursor | null {
  const value = decode(cursor);
  if (!value || value["v"] !== 1) return null;
  if (typeof value["ts"] !== "string" || typeof value["id"] !== "string") return null;
  return { v: 1, ts: value["ts"], id: value["id"] };
}

export function encodeAttachmentCursor(ts: string, id: string, idx: number): string {
  return encode({ v: 1, ts, id, idx });
}

export function decodeAttachmentCursor(cursor: string): AttachmentCursor | null {
  const value = decode(cursor);
  if (!value || value["v"] !== 1) return null;
  if (typeof value["ts"] !== "string" || typeof value["id"] !== "string") return null;
  if (typeof value["idx"] !== "number" || !Number.isSafeInteger(value["idx"]) || value["idx"] < 0) return null;
  return { v: 1, ts: value["ts"], id: value["id"], idx: value["idx"] };
}
