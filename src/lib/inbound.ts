export interface ParsedEmail {
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  text_body: string | null;
  html_body: string | null;
  headers: Record<string, string>;
  message_id: string | null;
}

/**
 * Parse a raw MIME email string into ParsedEmail fields.
 * Handles multipart/alternative and simple text/html emails.
 */
export function parseMimeEmail(raw: string): ParsedEmail {
  const headers: Record<string, string> = {};
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  // Parse headers (until blank line)
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === "") {
      i++;
      break;
    }
    // Handle folded headers (continuation lines start with whitespace)
    if ((line.startsWith(" ") || line.startsWith("\t")) && Object.keys(headers).length > 0) {
      const lastKey = Object.keys(headers).pop()!;
      headers[lastKey] = (headers[lastKey] ?? "") + " " + line.trim();
    } else {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim().toLowerCase();
        const value = line.slice(colonIdx + 1).trim();
        headers[key] = value;
      }
    }
    i++;
  }

  const body = lines.slice(i).join("\n");

  const from_address = parseAddress(headers["from"] ?? "");
  const to_addresses = parseAddressList(headers["to"] ?? "");
  const cc_addresses = parseAddressList(headers["cc"] ?? "");
  const subject = decodeHeader(headers["subject"] ?? "");
  const message_id = headers["message-id"]?.replace(/[<>]/g, "").trim() ?? null;

  const contentType = headers["content-type"] ?? "text/plain";

  let text_body: string | null = null;
  let html_body: string | null = null;

  if (contentType.includes("multipart/")) {
    const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1]!;
      const parts = splitMultipart(body, boundary);
      for (const part of parts) {
        const { headers: partHeaders, body: partBody } = parsePart(part);
        const partContentType = partHeaders["content-type"] ?? "text/plain";
        const encoding = (partHeaders["content-transfer-encoding"] ?? "").toLowerCase();
        const decoded = decodeBody(partBody, encoding);
        if (partContentType.includes("text/html") && !html_body) {
          html_body = decoded;
        } else if (partContentType.includes("text/plain") && !text_body) {
          text_body = decoded;
        }
      }
    }
  } else {
    const encoding = (headers["content-transfer-encoding"] ?? "").toLowerCase();
    const decoded = decodeBody(body, encoding);
    if (contentType.includes("text/html")) {
      html_body = decoded;
    } else {
      text_body = decoded;
    }
  }

  return {
    from_address,
    to_addresses,
    cc_addresses,
    subject,
    text_body,
    html_body,
    headers,
    message_id,
  };
}

function parseAddress(addr: string): string {
  if (!addr) return "";
  // "Display Name <email@example.com>" → "email@example.com"
  const match = addr.match(/<([^>]+)>/);
  return match ? match[1]!.trim() : addr.trim();
}

function parseAddressList(addrs: string): string[] {
  if (!addrs) return [];
  return addrs.split(",").map(a => parseAddress(a.trim())).filter(Boolean);
}

function decodeHeader(value: string): string {
  // Decode RFC 2047 encoded words: =?charset?encoding?text?=
  return value.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_full, __charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === "B") {
        return Buffer.from(text, "base64").toString("utf-8");
      } else {
        // Q encoding
        const decoded = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m: string, hex: string) =>
          String.fromCharCode(parseInt(hex, 16)),
        );
        return decoded;
      }
    } catch {
      return text;
    }
  });
}

function decodeBody(body: string, encoding: string): string {
  if (encoding === "base64") {
    try {
      return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf-8");
    } catch {
      return body;
    }
  }
  if (encoding === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return body;
}

function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const parts: string[] = [];
  const segments = body.split(new RegExp(`^--${escapeRegex(boundary)}(?:--)?\\s*$`, "m"));
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg && seg.trim() && !seg.startsWith("--")) {
      parts.push(seg.trim());
    }
  }
  if (parts.length === 0) {
    // Fallback: manual split
    const lines = body.split("\n");
    let current: string[] = [];
    for (const line of lines) {
      if (line.startsWith(delimiter)) {
        if (current.length > 0) parts.push(current.join("\n"));
        current = [];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) parts.push(current.join("\n"));
  }
  return parts;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePart(part: string): { headers: Record<string, string>; body: string } {
  const lines = part.replace(/\r\n/g, "\n").split("\n");
  const headers: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === "") {
      i++;
      break;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      headers[key] = value;
    }
    i++;
  }
  return { headers, body: lines.slice(i).join("\n") };
}

/**
 * Parse Resend inbound webhook payload.
 * Resend sends inbound emails with a structured JSON payload.
 */
export function parseResendInbound(body: Record<string, unknown>): ParsedEmail {
  const headers: Record<string, string> = {};
  if (body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)) {
    for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
      headers[k.toLowerCase()] = String(v);
    }
  }

  const from_address = parseAddress(String(body.from ?? body.sender ?? ""));
  const to_raw = body.to ?? body.recipient ?? "";
  const to_addresses = Array.isArray(to_raw)
    ? (to_raw as string[]).map(a => parseAddress(a))
    : [parseAddress(String(to_raw))];

  const cc_raw = body.cc ?? "";
  const cc_addresses = Array.isArray(cc_raw)
    ? (cc_raw as string[]).map(a => parseAddress(a))
    : cc_raw ? [parseAddress(String(cc_raw))] : [];

  return {
    from_address,
    to_addresses: to_addresses.filter(Boolean),
    cc_addresses: cc_addresses.filter(Boolean),
    subject: String(body.subject ?? ""),
    text_body: body.text ? String(body.text) : null,
    html_body: body.html ? String(body.html) : null,
    headers,
    message_id: body.message_id ? String(body.message_id) : (headers["message-id"]?.replace(/[<>]/g, "").trim() ?? null),
  };
}

/**
 * Parse Mailgun inbound webhook payload.
 * Mailgun sends form-encoded data; by the time it reaches here it's been parsed into an object.
 */
export function parseMailgunInbound(body: Record<string, unknown>): ParsedEmail {
  const headers: Record<string, string> = {};

  // Mailgun sends raw headers as a string in "message-headers" field (JSON array of [name, value] pairs)
  if (body["message-headers"] && typeof body["message-headers"] === "string") {
    try {
      const rawHeaders = JSON.parse(body["message-headers"] as string) as [string, string][];
      for (const [name, value] of rawHeaders) {
        headers[name.toLowerCase()] = value;
      }
    } catch {
      // Ignore parse errors
    }
  }

  const from_address = parseAddress(String(body.from ?? body.sender ?? ""));
  const to_raw = String(body.recipient ?? body.To ?? body.to ?? "");
  const to_addresses = to_raw.split(",").map(a => parseAddress(a.trim())).filter(Boolean);

  const cc_raw = String(body.Cc ?? body.cc ?? "");
  const cc_addresses = cc_raw ? cc_raw.split(",").map(a => parseAddress(a.trim())).filter(Boolean) : [];

  return {
    from_address,
    to_addresses,
    cc_addresses,
    subject: String(body.subject ?? body.Subject ?? ""),
    text_body: body["body-plain"] ? String(body["body-plain"]) : (body.text ? String(body.text) : null),
    html_body: body["body-html"] ? String(body["body-html"]) : (body.html ? String(body.html) : null),
    headers,
    message_id: body["Message-Id"]
      ? String(body["Message-Id"]).replace(/[<>]/g, "").trim()
      : (headers["message-id"]?.replace(/[<>]/g, "").trim() ?? null),
  };
}

interface SmtpServer {
  stop(): void;
}

/**
 * Minimal SMTP receiver. It accepted DATA commands, parsed the raw MIME message
 * (using the pure parser above), and stored the result into the local
 * `inbound_emails` SQLite table. In the self-hosted client there is no local
 * inbound store — the operator's server runs inbound receipt/ingestion — so this
 * stub preserves the signature and fails loud. The MIME/webhook parsers above
 * remain exported for reuse.
 */
export function createSmtpServer(_port: number, _providerId?: string): SmtpServer {
  throw new Error(
    "createSmtpServer is not available in the self-hosted client; inbound SMTP receipt and ingestion run on the self-hosted server.",
  );
}
