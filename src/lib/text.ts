/** Max HTML bytes to parse (fetch still capped before extraction). */
const DEFAULT_MAX_BYTES = 400_000;

/** Only the first N lines of plain text are sent to the RAG index. */
export const INDEX_MAX_LINES = 50;

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Take the first `maxLines` lines (split on newlines); add ellipsis if truncated. */
export function limitToFirstLines(text: string, maxLines: number = INDEX_MAX_LINES): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return lines.join("\n").trimEnd();
  }
  return lines.slice(0, maxLines).join("\n") + "\n…";
}

/** Take the first `maxChars` characters; add ellipsis if truncated. */
export function limitToMaxChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "…";
}

/**
 * Convert HTML to plain text with line breaks preserved, then keep only the first INDEX_MAX_LINES lines.
 * Used for RAG indexing (not full page body).
 */
export function htmlToIndexedPlainText(html: string): string {
  let s = html;
  s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "\n");
  s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote|pre|table)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeBasicEntities(s);
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s.replace(/\r?\n\s*\r?\n/g, "\n");
  const trimmedLines = s
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join("\n");
  return limitToFirstLines(trimmedLines.trim(), INDEX_MAX_LINES);
}

export function truncateBytes(html: string, maxBytes = DEFAULT_MAX_BYTES): string {
  const enc = new TextEncoder();
  if (enc.encode(html).length <= maxBytes) return html;
  let low = 0;
  let high = html.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (enc.encode(html.slice(0, mid)).length <= maxBytes) low = mid + 1;
    else high = mid;
  }
  return html.slice(0, Math.max(0, low - 1));
}

export async function hashText(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
