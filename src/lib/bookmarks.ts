import { isAbortError, timeoutSignal } from "./fetch-util";
import { hashText, htmlToIndexedPlainText, limitToFirstLines, limitToMaxChars, truncateBytes } from "./text";

/** Abort page fetch if it exceeds this (then continue with next bookmark). */
export const FETCH_PAGE_TIMEOUT_MS = 10_000;

export interface FlatBookmark {
  id: string;
  title: string;
  url: string;
}

const SKIP_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "edge://",
  "about:",
  "javascript:",
  "file://",
  "data:",
  "blob:",
];

/**
 * Some domains (e.g. Chrome Web Store) block extension-origin CORS fetches.
 * Skip them during indexing to avoid noisy, guaranteed failures.
 */
const SKIP_HOST_SUFFIXES = [
  "chrome.google.com",
  "tools.google.com",
  "chromewebstore.google.com",
];

export function shouldSkipUrl(url: string): boolean {
  const u = url.trim().toLowerCase();
  if (SKIP_PREFIXES.some((p) => u.startsWith(p))) {
    return true;
  }
  try {
    const parsed = new URL(u);
    // Fetch-based indexing only supports web pages over HTTP(S); skip FTP and other schemes.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return true;
    }
    const host = parsed.hostname.toLowerCase();
    return SKIP_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

export function flattenBookmarks(
  nodes: chrome.bookmarks.BookmarkTreeNode[]
): FlatBookmark[] {
  const out: FlatBookmark[] = [];
  function walk(n: chrome.bookmarks.BookmarkTreeNode) {
    if (n.url && !shouldSkipUrl(n.url)) {
      out.push({ id: n.id, title: n.title || "", url: n.url });
    }
    if (n.children) {
      n.children.forEach(walk);
    }
  }
  nodes.forEach(walk);
  return out;
}

export async function fetchBookmarkText(
  url: string,
  maxChars: number,
  _signal?: AbortSignal
): Promise<{ text: string; ok: boolean; error?: string }> {
  const timeout = timeoutSignal(FETCH_PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: timeout,
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (compatible; BookmarkRAGExtension/1.0; +https://localhost)",
      },
    });
    if (!res.ok) {
      return { text: "", ok: false, error: `HTTP ${res.status}` };
    }
    const ct = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml|text\/plain/i.test(ct) && !url.match(/\.html?$/i)) {
      const buf = await res.arrayBuffer();
      const slice = buf.byteLength > 50_000 ? buf.slice(0, 50_000) : buf;
      const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
      return { text: limitToMaxChars(limitToFirstLines(text), maxChars), ok: true };
    }
    const raw = await res.text();
    const truncated = truncateBytes(raw, 400_000);
    const text = htmlToIndexedPlainText(truncated);
    return { text: limitToMaxChars(text, maxChars), ok: true };
  } catch (e) {
    if (isAbortError(e)) {
      return { text: "", ok: false, error: `timeout after ${FETCH_PAGE_TIMEOUT_MS / 1000}s` };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { text: "", ok: false, error: msg };
  }
}

export async function hashContent(url: string, title: string, text: string): Promise<string> {
  return hashText(`${url}\n${title}\n${text}`);
}
