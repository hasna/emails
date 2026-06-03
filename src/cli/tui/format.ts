/** Presentation helpers for the mail TUI. Pure + unit-tested. */

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
