export type EmailLinkSource = "html" | "markdown" | "text";

export interface ExtractEmailLinksInput {
  text?: string | null;
  html?: string | null;
  includeNonWeb?: boolean;
  max?: number;
}

export interface ExtractedEmailLink {
  url: string;
  normalized_url: string;
  text: string | null;
  source: EmailLinkSource;
  occurrences: number;
}

export interface DetectedEmailLinkSpan {
  start: number;
  end: number;
  text: string;
  url: string;
  normalized_url: string;
}

const DEFAULT_MAX_LINKS = 200;
const MAX_SCAN_CHARS = 1_000_000;
const MAX_CODE_POINT = 0x10ffff;

function capScan(value: string): string {
  return value.length <= MAX_SCAN_CHARS ? value : value.slice(0, MAX_SCAN_CHARS);
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
      return Number.isFinite(code) && code >= 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : entity;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : entity;
    }
    return named[key] ?? entity;
  });
}

function htmlText(value: string): string {
  return decodeHtmlEntities(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCandidate(value: string): string {
  let out = decodeHtmlEntities(value)
    .trim()
    .replace(/^["'(<\[]+/, "")
    .replace(/[>"'\]]+$/g, "");
  while (/[),.;:!?]+$/.test(out)) {
    const last = out.at(-1);
    if (last === ")" && (out.match(/\(/g)?.length ?? 0) >= (out.match(/\)/g)?.length ?? 0)) break;
    out = out.slice(0, -1);
  }
  return out;
}

function normalizeUrl(value: string, includeNonWeb: boolean): { url: string; normalized: string } | null {
  let cleaned = cleanCandidate(value);
  if (!cleaned || cleaned.startsWith("#")) return null;
  if (/^www\./i.test(cleaned)) cleaned = `https://${cleaned}`;
  if (/^(javascript|data|file|cid|blob):/i.test(cleaned)) return null;

  try {
    const parsed = new URL(cleaned);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:" && !(includeNonWeb && (protocol === "mailto:" || protocol === "tel:"))) {
      return null;
    }
    if (protocol === "http:" || protocol === "https:") {
      parsed.protocol = protocol;
      parsed.hostname = parsed.hostname.toLowerCase();
      return { url: cleaned, normalized: parsed.toString() };
    }
    return { url: cleaned, normalized: `${protocol}${parsed.pathname.toLowerCase()}${parsed.search}` };
  } catch {
    return null;
  }
}

export function extractEmailLinks(input: ExtractEmailLinksInput): ExtractedEmailLink[] {
  const max = Math.max(1, Math.trunc(input.max ?? DEFAULT_MAX_LINKS));
  const includeNonWeb = input.includeNonWeb === true;
  const byUrl = new Map<string, ExtractedEmailLink & { index: number }>();
  let index = 0;

  const add = (candidate: string, text: string | null, source: EmailLinkSource) => {
    const normalized = normalizeUrl(candidate, includeNonWeb);
    if (!normalized) return;
    if (byUrl.size >= max && !byUrl.has(normalized.normalized)) return;
    const existing = byUrl.get(normalized.normalized);
    if (existing) {
      existing.occurrences += 1;
      if (!existing.text && text) existing.text = text;
      return;
    }
    byUrl.set(normalized.normalized, {
      url: normalized.url,
      normalized_url: normalized.normalized,
      text: text?.trim() || null,
      source,
      occurrences: 1,
      index: index++,
    });
  };

  const html = input.html ? capScan(input.html) : "";
  if (html) {
    const anchorRe = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    for (const match of html.matchAll(anchorRe)) {
      const href = match[1] ?? match[2] ?? match[3] ?? "";
      const label = htmlText(match[4] ?? "");
      add(href, label, "html");
    }
    scanText(htmlText(html), "text", add);
  }

  const text = input.text ? capScan(input.text) : "";
  if (text) scanMarkdownAndText(text, add);

  return [...byUrl.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ index: _index, ...link }) => link);
}

function scanMarkdownAndText(
  text: string,
  add: (candidate: string, label: string | null, source: EmailLinkSource) => void,
): void {
  const ranges: Array<[number, number]> = [];
  for (const match of markdownLinks(text)) {
    add(match.url, match.label, "markdown");
    ranges.push([match.start, match.end]);
  }
  scanText(maskRanges(text, ranges), "text", add);
}

function markdownLinks(text: string): Array<{ start: number; end: number; label: string; url: string }> {
  const matches: Array<{ start: number; end: number; label: string; url: string }> = [];
  let searchAt = 0;
  while (searchAt < text.length) {
    const start = text.indexOf("[", searchAt);
    if (start < 0) break;
    const labelEnd = text.indexOf("](", start + 1);
    if (labelEnd < 0) break;
    const label = text.slice(start + 1, labelEnd);
    if (label.length === 0 || label.length > 300 || label.includes("\n")) {
      searchAt = start + 1;
      continue;
    }

    const urlStart = labelEnd + 2;
    let urlEnd = -1;
    let depth = 0;
    for (let i = urlStart; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\") {
        i++;
        continue;
      }
      if (/\s/.test(ch ?? "")) break;
      if (ch === "(") {
        depth++;
        continue;
      }
      if (ch === ")") {
        if (depth === 0) {
          urlEnd = i;
          break;
        }
        depth--;
      }
    }

    if (urlEnd < 0) {
      searchAt = start + 1;
      continue;
    }

    const url = text.slice(urlStart, urlEnd);
    if (url) matches.push({ start, end: urlEnd + 1, label, url });
    searchAt = urlEnd + 1;
  }
  return matches;
}

function maskRanges(text: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return text;
  const chars = text.split("");
  for (const [start, end] of ranges) {
    for (let i = start; i < end && i < chars.length; i++) chars[i] = " ";
  }
  return chars.join("");
}

function scanText(
  text: string,
  source: EmailLinkSource,
  add: (candidate: string, label: string | null, source: EmailLinkSource) => void,
): void {
  const linkRe = /\b(?:(?:https?:\/\/|www\.)[^\s<>"'`]+|(?:mailto:|tel:)[^\s<>"'`]+)/gi;
  for (const match of text.matchAll(linkRe)) add(match[0], null, source);
}

export function detectEmailLinkSpans(text: string, options?: { includeNonWeb?: boolean; max?: number }): DetectedEmailLinkSpan[] {
  const max = Math.max(1, Math.trunc(options?.max ?? DEFAULT_MAX_LINKS));
  const includeNonWeb = options?.includeNonWeb === true;
  const spans: DetectedEmailLinkSpan[] = [];
  const linkRe = /\b(?:(?:https?:\/\/|www\.)[^\s<>"'`]+|(?:mailto:|tel:)[^\s<>"'`]+)/gi;
  for (const match of text.matchAll(linkRe)) {
    if (spans.length >= max) break;
    const raw = match[0] ?? "";
    const matchStart = match.index ?? 0;
    const visible = cleanCandidate(raw);
    if (!visible) continue;
    const normalized = normalizeUrl(raw, includeNonWeb);
    if (!normalized) continue;
    const offset = raw.indexOf(visible);
    const start = matchStart + Math.max(0, offset);
    const end = start + visible.length;
    spans.push({
      start,
      end,
      text: visible,
      url: normalized.url,
      normalized_url: normalized.normalized,
    });
  }
  return spans;
}

export function formatEmailLinks(links: ExtractedEmailLink[]): string {
  if (links.length === 0) return "No links found.";
  const rows = [`Links (${links.length})`];
  for (const [idx, link] of links.entries()) {
    rows.push(`${idx + 1}. ${link.url}`);
    const details = [
      link.text ? `text: ${link.text}` : null,
      link.source !== "text" ? `source: ${link.source}` : null,
      link.occurrences > 1 ? `seen ${link.occurrences}x` : null,
    ].filter(Boolean);
    if (details.length) rows.push(`   ${details.join(" · ")}`);
  }
  return rows.join("\n");
}
