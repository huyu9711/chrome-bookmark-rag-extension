import { isAbortError, timeoutSignal } from "./fetch-util";
import {
  DEFAULT_SETTINGS,
  type BookmarkItem,
  type ExtensionSettings,
  type IndexResponseBody,
  type QueryResponseBody,
  type RagChunkEmbedding,
} from "./types";

/** Max wait for Options-page RAG / Q&A test requests */
export const TEST_API_TIMEOUT_MS = 15_000;

/** Some gateways (NVIDIA / LiteLLM) reject null encoding_format — send explicitly. */
const EMBEDDING_EXTRA = { encoding_format: "float" as const };

function sanitizeChunkSize(v: number | undefined): number {
  if (!Number.isFinite(v)) return DEFAULT_SETTINGS.ragChunkSize;
  const n = Math.floor(Number(v));
  return Math.min(20_000, Math.max(200, n));
}

function sanitizeChunkOverlap(v: number | undefined, size: number): number {
  if (!Number.isFinite(v)) return Math.min(DEFAULT_SETTINGS.ragChunkOverlap, size - 1);
  const n = Math.floor(Number(v));
  return Math.min(size - 1, Math.max(0, n));
}

function sanitizeEmbeddingsTimeoutMs(v: number | undefined): number {
  if (!Number.isFinite(v)) return DEFAULT_SETTINGS.ragEmbeddingsTimeoutMs;
  const n = Math.floor(Number(v));
  return Math.min(300_000, Math.max(5_000, n));
}

function splitByCharChunks(text: string, chunkSize: number, chunkOverlap: number): string[] {
  if (!text) return [""];
  const stride = Math.max(1, chunkSize - chunkOverlap);
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += stride) {
    chunks.push(text.slice(start, start + chunkSize));
    if (start + chunkSize >= text.length) break;
  }
  return chunks;
}

export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.replace(/^\/+/, "");
  return `${b}/${p}`;
}

function pathOrDefault(value: string | undefined, fallback: string): string {
  const t = (value ?? "").trim();
  return t || fallback;
}

function ragEmbeddingsUrl(s: ExtensionSettings): string {
  return joinUrl(s.ragBaseUrl, pathOrDefault(s.ragEmbedPath, "v1/embeddings"));
}

function qaChatUrl(s: ExtensionSettings): string {
  return joinUrl(s.qaBaseUrl, pathOrDefault(s.qaChatPath, "v1/chat/completions"));
}

function qaCompletionsUrl(s: ExtensionSettings): string {
  return joinUrl(s.qaBaseUrl, pathOrDefault(s.qaCompletionsPath, "v1/completions"));
}

function qaResponsesUrl(s: ExtensionSettings): string {
  return joinUrl(s.qaBaseUrl, pathOrDefault(s.qaResponsesPath, "v1/responses"));
}

function formatHttpFailure(url: string, res: Response, body: string): string {
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 280);
  const reason = res.statusText ? ` ${res.statusText}` : "";
  return `HTTP ${res.status}${reason}${snippet ? ` — ${snippet}` : ""} — tried: ${url}`;
}

function headers(apiKey: string): HeadersInit {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey.trim()) {
    h.Authorization = `Bearer ${apiKey.trim()}`;
  }
  return h;
}

function openAiErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "error" in data) {
    const e = (data as { error?: { message?: string } | string }).error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && typeof e.message === "string") return e.message;
  }
  return fallback;
}

/** Chat completions or legacy completions text */
function parseAnswerFromResponse(data: unknown): string {
  const d = data as {
    choices?: Array<{
      message?: { content?: string };
      text?: string;
    }>;
  };
  const c0 = d?.choices?.[0];
  if (!c0) return "";
  if (typeof c0.message?.content === "string") return c0.message.content;
  if (typeof c0.text === "string") return c0.text;
  return "";
}

/**
 * NVIDIA / OpenAI Responses API style payloads: output blocks, output_text, etc.
 */
function parseTextFromResponsesApi(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;

  if (typeof d.output_text === "string") return d.output_text;
  if (typeof d.text === "string") return d.text;

  const out = d.output;
  if (Array.isArray(out)) {
    const parts: string[] = [];
    for (const block of out) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") parts.push(b.text);
      const content = b.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || typeof c !== "object") continue;
          const item = c as { type?: string; text?: string };
          if (typeof item.text === "string") parts.push(item.text);
        }
      }
    }
    if (parts.length) return parts.join("\n").trim();
  }

  const msg = d.message;
  if (msg && typeof msg === "object") {
    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string") return content;
  }

  return parseAnswerFromResponse(data);
}

function isNonChatModelError(message: string): boolean {
  const e = message.toLowerCase();
  return (
    e.includes("not a chat model") ||
    e.includes("did you mean to use v1/completions") ||
    e.includes("not supported in the v1/chat/completions")
  );
}

interface PreparedEmbeddingChunk {
  bookmarkId: string;
  title: string;
  url: string;
  chunkText: string;
  chunkIndex: number;
  chunkTotal: number;
  payload: string;
}

function itemsToEmbeddingChunks(
  settings: ExtensionSettings,
  items: BookmarkItem[]
): PreparedEmbeddingChunk[] {
  const chunkSize = sanitizeChunkSize(settings.ragChunkSize);
  const chunkOverlap = sanitizeChunkOverlap(settings.ragChunkOverlap, chunkSize);
  return items.flatMap((item) => {
    const chunks = splitByCharChunks(item.text, chunkSize, chunkOverlap);
    return chunks.map((chunk, i) => {
      const chunkText = item.title ? `${item.title}\n${chunk}` : chunk;
      return {
        bookmarkId: item.bookmarkId,
        title: item.title,
        url: item.url,
        chunkText,
        chunkIndex: i + 1,
        chunkTotal: chunks.length,
        payload: `[bookmarkId:${item.bookmarkId}][chunk:${i + 1}/${chunks.length}]\n${item.title}\n${item.url}\n${chunk}`,
      };
    });
  });
}

function parseEmbeddingVectors(data: unknown): number[][] | null {
  const arr = (data as { data?: Array<{ embedding?: unknown }> })?.data;
  if (!Array.isArray(arr)) return null;
  const vectors: number[][] = [];
  for (const row of arr) {
    const emb = row?.embedding;
    if (!Array.isArray(emb)) return null;
    const vec: number[] = [];
    for (const v of emb) {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) return null;
      vec.push(n);
    }
    vectors.push(vec);
  }
  return vectors;
}

async function requestEmbeddings(
  settings: ExtensionSettings,
  input: string[],
  timeoutMs: number
): Promise<{ ok: boolean; vectors: number[][]; error?: string }> {
  const url = ragEmbeddingsUrl(settings);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: headers(settings.ragApiKey),
      body: JSON.stringify({
        model: settings.ragModel,
        input,
        ...EMBEDDING_EXTRA,
      }),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (e) {
    if (isAbortError(e)) {
      return {
        ok: false,
        vectors: [],
        error: `Embeddings request timed out after ${timeoutMs / 1000}s`,
      };
    }
    return {
      ok: false,
      vectors: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      ok: false,
      vectors: [],
      error: `Invalid JSON: ${res.status} ${text.slice(0, 200)}`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      vectors: [],
      error: openAiErrorMessage(data, text.slice(0, 400)),
    };
  }
  const vectors = parseEmbeddingVectors(data);
  if (!vectors) {
    return {
      ok: false,
      vectors: [],
      error: "Embeddings response missing valid numeric vectors",
    };
  }
  return { ok: true, vectors };
}

export async function embedQueryText(
  settings: ExtensionSettings,
  text: string
): Promise<{ embedding?: number[]; error?: string }> {
  const timeoutMs = sanitizeEmbeddingsTimeoutMs(settings.ragEmbeddingsTimeoutMs);
  const r = await requestEmbeddings(settings, [text], timeoutMs);
  if (!r.ok) {
    return { error: r.error || "Query embedding request failed" };
  }
  const embedding = r.vectors[0];
  if (!embedding || embedding.length === 0) {
    return { error: "Query embedding was empty" };
  }
  return { embedding };
}

export async function postEmbeddingsBatch(
  settings: ExtensionSettings,
  items: BookmarkItem[]
): Promise<IndexResponseBody> {
  const chunks = itemsToEmbeddingChunks(settings, items);
  const input = chunks.map((c) => c.payload);
  const timeoutMs = sanitizeEmbeddingsTimeoutMs(settings.ragEmbeddingsTimeoutMs);
  const r = await requestEmbeddings(settings, input, timeoutMs);
  if (!r.ok) {
    return {
      ok: false,
      indexed: 0,
      error: r.error || "Embeddings upload failed",
    };
  }
  const vectors: RagChunkEmbedding[] = [];
  const n = Math.min(chunks.length, r.vectors.length);
  for (let i = 0; i < n; i++) {
    const c = chunks[i];
    vectors.push({
      bookmarkId: c.bookmarkId,
      title: c.title,
      url: c.url,
      chunkText: c.chunkText,
      chunkIndex: c.chunkIndex,
      chunkTotal: c.chunkTotal,
      embedding: r.vectors[i],
    });
  }
  return { ok: true, indexed: vectors.length, vectors };
}

function responsesRequestBody(settings: ExtensionSettings, input: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: settings.qaModel,
    input,
  };
  const effort = settings.qaReasoningEffort;
  if (effort && effort !== "none") {
    body.reasoning = { effort };
  }
  return body;
}

async function fetchResponsesApi(
  settings: ExtensionSettings,
  query: string
): Promise<QueryResponseBody> {
  const url = qaResponsesUrl(settings);
  const res = await fetch(url, {
    method: "POST",
    headers: headers(settings.qaApiKey),
    body: JSON.stringify(responsesRequestBody(settings, query)),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      answer: "",
      citations: [],
      error: `Invalid JSON: ${res.status} ${text.slice(0, 200)}`,
    };
  }
  if (!res.ok) {
    return {
      answer: "",
      citations: [],
      error: openAiErrorMessage(data, text.slice(0, 400)),
    };
  }
  const answer = parseTextFromResponsesApi(data);
  return { answer, citations: [] };
}

async function fetchChatCompletion(
  settings: ExtensionSettings,
  query: string
): Promise<QueryResponseBody> {
  const url = qaChatUrl(settings);
  const res = await fetch(url, {
    method: "POST",
    headers: headers(settings.qaApiKey),
    body: JSON.stringify({
      model: settings.qaModel,
      messages: [{ role: "user", content: query }],
      temperature: 0.2,
      max_tokens: 4096,
    }),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      answer: "",
      citations: [],
      error: `Invalid JSON: ${res.status} ${text.slice(0, 200)}`,
    };
  }
  if (!res.ok) {
    return {
      answer: "",
      citations: [],
      error: openAiErrorMessage(data, text.slice(0, 400)),
    };
  }
  const answer = parseAnswerFromResponse(data);
  return { answer, citations: [] };
}

async function fetchTextCompletion(
  settings: ExtensionSettings,
  query: string
): Promise<QueryResponseBody> {
  const url = qaCompletionsUrl(settings);
  const res = await fetch(url, {
    method: "POST",
    headers: headers(settings.qaApiKey),
    body: JSON.stringify({
      model: settings.qaModel,
      prompt: query,
      max_tokens: 4096,
      temperature: 0.2,
    }),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      answer: "",
      citations: [],
      error: `Invalid JSON: ${res.status} ${text.slice(0, 200)}`,
    };
  }
  if (!res.ok) {
    return {
      answer: "",
      citations: [],
      error: openAiErrorMessage(data, text.slice(0, 400)),
    };
  }
  const answer = parseAnswerFromResponse(data);
  return { answer, citations: [] };
}

/**
 * Default: NVIDIA v1/responses. Optional: chat/completions or v1/completions.
 */
export async function postQuery(settings: ExtensionSettings, query: string): Promise<QueryResponseBody> {
  if (settings.qaMode === "completions") {
    return fetchTextCompletion(settings, query);
  }
  if (settings.qaMode === "responses") {
    return fetchResponsesApi(settings, query);
  }
  const chat = await fetchChatCompletion(settings, query);
  if (chat.error && isNonChatModelError(chat.error)) {
    const comp = await fetchTextCompletion(settings, query);
    if (!comp.error || comp.answer) {
      return comp;
    }
    return {
      answer: "",
      citations: [],
      error: `${chat.error}\n\nAlso tried v1/completions: ${comp.error || "unknown"}`,
    };
  }
  return chat;
}

export async function testRagSettings(
  settings: ExtensionSettings
): Promise<{ ok: boolean; detail: string }> {
  if (!settings.ragBaseUrl.trim()) {
    return { ok: false, detail: "Set RAG (embeddings) base URL first." };
  }
  const url = ragEmbeddingsUrl(settings);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: headers(settings.ragApiKey),
      body: JSON.stringify({
        model: settings.ragModel,
        input: "ping",
        ...EMBEDDING_EXTRA,
      }),
      signal: timeoutSignal(TEST_API_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, detail: formatHttpFailure(url, res, text) };
    }
    if (!res.ok) {
      return {
        ok: false,
        detail: `${openAiErrorMessage(data, text.slice(0, 200))} — tried: ${url}`,
      };
    }
    const dims = (data as { data?: Array<{ embedding?: unknown }> })?.data?.[0]?.embedding;
    const dimHint = Array.isArray(dims) ? ` (dim=${dims.length})` : "";
    return { ok: true, detail: `OK — embeddings${dimHint} — ${url}` };
  } catch (e) {
    if (isAbortError(e)) {
      return { ok: false, detail: `Timed out after ${TEST_API_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function testResponsesFetch(settings: ExtensionSettings): Promise<{
  ok: boolean;
  detail: string;
  url: string;
}> {
  const url = qaResponsesUrl(settings);
  const res = await fetch(url, {
    method: "POST",
    headers: headers(settings.qaApiKey),
    body: JSON.stringify(responsesRequestBody(settings, "Reply with exactly: pong")),
    signal: timeoutSignal(TEST_API_TIMEOUT_MS),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, detail: formatHttpFailure(url, res, text), url };
  }
  if (!res.ok) {
    return {
      ok: false,
      detail: openAiErrorMessage(data, text.slice(0, 400)),
      url,
    };
  }
  const answer = parseTextFromResponsesApi(data);
  const preview = answer.replace(/\s+/g, " ").trim().slice(0, 80);
  return {
    ok: true,
    detail: `OK — ${preview || "(empty)"} — ${url}`,
    url,
  };
}

async function testChatFetch(settings: ExtensionSettings): Promise<{
  ok: boolean;
  detail: string;
  url: string;
}> {
  const url = qaChatUrl(settings);
  const res = await fetch(url, {
    method: "POST",
    headers: headers(settings.qaApiKey),
    body: JSON.stringify({
      model: settings.qaModel,
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
      max_tokens: 32,
      temperature: 0,
    }),
    signal: timeoutSignal(TEST_API_TIMEOUT_MS),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, detail: formatHttpFailure(url, res, text), url };
  }
  if (!res.ok) {
    return {
      ok: false,
      detail: openAiErrorMessage(data, text.slice(0, 400)),
      url,
    };
  }
  const answer = parseAnswerFromResponse(data);
  const preview = answer.replace(/\s+/g, " ").trim().slice(0, 80);
  return {
    ok: true,
    detail: `OK — ${preview || "(empty)"} — ${url}`,
    url,
  };
}

async function testCompletionsFetch(settings: ExtensionSettings): Promise<{
  ok: boolean;
  detail: string;
  url: string;
}> {
  const url = qaCompletionsUrl(settings);
  const res = await fetch(url, {
    method: "POST",
    headers: headers(settings.qaApiKey),
    body: JSON.stringify({
      model: settings.qaModel,
      prompt: "Reply with exactly: pong",
      max_tokens: 32,
      temperature: 0,
    }),
    signal: timeoutSignal(TEST_API_TIMEOUT_MS),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, detail: formatHttpFailure(url, res, text), url };
  }
  if (!res.ok) {
    return {
      ok: false,
      detail: openAiErrorMessage(data, text.slice(0, 400)),
      url,
    };
  }
  const answer = parseAnswerFromResponse(data);
  const preview = answer.replace(/\s+/g, " ").trim().slice(0, 80);
  return {
    ok: true,
    detail: `OK — ${preview || "(empty)"} — ${url}`,
    url,
  };
}

export async function testQaSettings(
  settings: ExtensionSettings
): Promise<{ ok: boolean; detail: string }> {
  if (!settings.qaBaseUrl.trim()) {
    return { ok: false, detail: "Set Q&A base URL first." };
  }
  try {
    if (settings.qaMode === "responses") {
      const r = await testResponsesFetch(settings);
      return { ok: r.ok, detail: r.detail };
    }
    if (settings.qaMode === "completions") {
      const r = await testCompletionsFetch(settings);
      return { ok: r.ok, detail: r.detail };
    }
    const chat = await testChatFetch(settings);
    if (chat.ok) {
      return { ok: true, detail: chat.detail };
    }
    if (isNonChatModelError(chat.detail)) {
      const comp = await testCompletionsFetch(settings);
      if (comp.ok) {
        return {
          ok: true,
          detail: `OK — model is not a chat model; used v1/completions instead. ${comp.detail}`,
        };
      }
      return {
        ok: false,
        detail: `${chat.detail} — tried: ${chat.url}\n\nFallback v1/completions: ${comp.detail} — tried: ${comp.url}`,
      };
    }
    return { ok: false, detail: `${chat.detail} — tried: ${chat.url}` };
  } catch (e) {
    if (isAbortError(e)) {
      return { ok: false, detail: `Timed out after ${TEST_API_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
