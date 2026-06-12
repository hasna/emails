/** Presentation helpers for the mail TUI. Pure + unit-tested. */
import { marked } from "marked";

export interface MessageBodyLike {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  date: string;
  text: string | null;
  html: string | null;
  flags?: string[];
  attachments?: Array<{ filename: string; content_type: string; size: number; location?: string }>;
}

export interface RenderedBodyLine {
  text: string;
  kind: "body" | "list" | "quote" | "code" | "heading" | "muted";
}

export function truncate(value: string, width: number): string {
  if (width <= 1) return value.slice(0, Math.max(0, width));
  return value.length > width ? value.slice(0, width - 1) + "…" : value;
}

export function pad(value: string, width: number): string {
  return truncate(value, width).padEnd(width);
}

/** Bare email from a "Name <a@b>" string. */
export function bareAddress(value: string): string {
  const m = value.match(/<([^>]+)>/);
  return (m ? m[1]! : value).trim();
}

/** Display name (or the address) from a "Name <a@b>" string. */
export function senderName(value: string): string {
  const m = value.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  return (m ? m[1]!.trim() : bareAddress(value)) || value;
}

/** Compact relative time: 34s, 5m, 3h, 2d, then a date. */
export function relativeTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, nowMs - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return iso.slice(0, 10);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso.slice(0, 16);
  return t.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Wrap a body into lines no wider than `width`, preserving paragraph breaks. */
export function wrapText(text: string, width: number, maxLines: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    if (rawLine.trim() === "") { out.push(""); if (out.length >= maxLines) break; continue; }
    let line = rawLine;
    while (line.length > width) {
      let cut = line.lastIndexOf(" ", width);
      if (cut <= 0) cut = width;
      out.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
      if (out.length >= maxLines) break;
    }
    if (out.length >= maxLines) break;
    out.push(line);
    if (out.length >= maxLines) break;
  }
  return out.slice(0, maxLines);
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    const key = name.toLowerCase();
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    return named[key] ?? entity;
  });
}

function tidyText(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .trim();
}

export function htmlToReadableText(html: string): string {
  const withoutNoise = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "");

  const withLinks = withoutNoise.replace(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_match, _quote: string, href: string, label: string) => {
    const text = decodeHtmlEntities(label.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    const url = decodeHtmlEntities(href).trim();
    if (!url || !text || text === url) return text || url;
    return `${text} (${url})`;
  });

  const readable = withLinks
    .replace(/<blockquote\b[^>]*>\s*<p\b[^>]*>/gi, "\n| ")
    .replace(/<\/p>\s*<\/blockquote>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|table|tr|pre|blockquote)>/gi, "\n")
    .replace(/<(h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<blockquote\b[^>]*>/gi, "\n| ")
    .replace(/<[^>]+>/g, " ");

  return tidyText(decodeHtmlEntities(readable));
}

function looksLikeMarkdown(value: string): boolean {
  return /^\s{0,3}#{1,6}\s+\S/m.test(value)
    || /^\s{0,3}(?:[-*+]|\d+\.)\s+\S/m.test(value)
    || /^\s{0,3}>\s+\S/m.test(value)
    || /```|~~~/.test(value)
    || /`[^`\n]+`/.test(value)
    || /\[[^\]\n]+\]\([^)]+\)/.test(value)
    || /(?:\*\*|__)[^\n]+(?:\*\*|__)/.test(value);
}

export function markdownToReadableText(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string;
  return htmlToReadableText(html);
}

export function readableMessageText(text: string | null | undefined, html: string | null | undefined): string {
  const plain = text?.trim();
  if (plain) return looksLikeMarkdown(plain) ? markdownToReadableText(plain) : tidyText(plain);
  const rendered = html?.trim() ? htmlToReadableText(html) : "";
  return rendered || "(no text content)";
}

function classifyBodyLine(value: string): RenderedBodyLine["kind"] {
  const line = value.trimStart();
  if (!line) return "body";
  if (/^[-*+]\s+\S/.test(line) || /^\d+\.\s+\S/.test(line)) return "list";
  if (line.startsWith("| ")) return "quote";
  if (/^(from|to|cc|subject|date):\s/i.test(line)) return "muted";
  return "body";
}

export function renderReadableBodyLines(text: string | null | undefined, html: string | null | undefined, width: number, maxLines: number): RenderedBodyLine[] {
  const body = readableMessageText(text, html);
  return wrapText(body, width, maxLines).map((textLine) => ({
    text: textLine,
    kind: classifyBodyLine(textLine),
  }));
}

export function formatMessageBodyForCopy(body: MessageBodyLike): string {
  return readableMessageText(body.text, body.html);
}

export function formatMessageForCopy(body: MessageBodyLike): string {
  const rows = [
    `Subject: ${body.subject}`,
    `From: ${body.from}`,
    `To: ${body.to}`,
  ];
  if (body.cc) rows.push(`Cc: ${body.cc}`);
  rows.push(`Date: ${body.date}`);
  if (body.flags?.length) rows.push(`Flags: ${body.flags.join(", ")}`);
  if (body.attachments?.length) {
    rows.push(`Attachments: ${body.attachments.map((attachment) => attachment.filename).join(", ")}`);
  }
  rows.push("", formatMessageBodyForCopy(body));
  return rows.join("\n").trimEnd();
}
