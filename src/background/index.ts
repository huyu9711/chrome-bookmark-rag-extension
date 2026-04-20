import { embedQueryText, postEmbeddingsBatch, postQuery } from "../lib/api";
import {
  clearLocalRagVectors,
  deleteLocalRagVectorsByBookmarkIds,
  loadAllLocalRagVectors,
  putLocalRagVectors,
} from "../lib/local-rag-db";
import {
  fetchBookmarkText,
  flattenBookmarks,
  hashContent,
  type FlatBookmark,
} from "../lib/bookmarks";
import { loadIndexState, loadSettings, saveIndexState } from "../lib/storage";
import type {
  BgRequest,
  BgResponse,
  BookmarkItem,
  Citation,
  IndexResponseBody,
  IndexStateMap,
  LocalRagVectorRecord,
} from "../lib/types";

/** One bookmark per /v1/embeddings call — gateways often sum tokens across input[] (batching caused ContextWindowExceeded on 8k models). */
const EMBEDDING_BATCH_SIZE = 1;
const TEST_INDEX_LIMIT = 100;
const FETCH_CONCURRENCY = 4;
const RAG_TOP_K = 6;
const MAX_CONTEXT_CHARS_PER_HIT = 1200;
const LOCAL_VECTOR_WRITE_TIMEOUT_MS = 20_000;

interface UploadBatchesResult {
  indexed: number;
  error?: string;
  uploadedBookmarkIds: Set<string>;
  skippedTimeoutBatches: number;
}

interface IndexRunControl {
  requestSkipCurrent: boolean;
  abortCurrentEmbedding?: () => void;
}

let activeIndexRun: IndexRunControl | null = null;
const keepAlivePorts = new Set<chrome.runtime.Port>();

function broadcast(msg: BgResponse) {
  chrome.runtime.sendMessage(msg).catch(() => {
    /* no receiver */
  });
}

async function poolMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

async function bookmarkToItem(
  settings: Awaited<ReturnType<typeof loadSettings>>,
  bm: FlatBookmark,
  index: number,
  total: number
): Promise<BookmarkItem> {
  const { text, ok, error } = await fetchBookmarkText(bm.url, settings.ragTextMaxChars);
  broadcast({
    type: "INDEX_PROGRESS",
    phase: "fetch",
    current: index + 1,
    total,
    detail: ok ? bm.url.slice(0, 100) : `${bm.url.slice(0, 80)} (${error || "failed"})`,
  });
  return {
    bookmarkId: bm.id,
    title: bm.title,
    url: bm.url,
    text: ok ? text : `[Could not fetch: ${error || "unknown"}]`,
  };
}

async function buildAllItems(
  settings: Awaited<ReturnType<typeof loadSettings>>,
  flat: FlatBookmark[]
): Promise<BookmarkItem[]> {
  const total = flat.length;
  return poolMap(flat, FETCH_CONCURRENCY, (bm, i) => bookmarkToItem(settings, bm, i, total));
}

function toLocalRagRecords(batchResult: IndexResponseBody): LocalRagVectorRecord[] {
  const now = Date.now();
  const vectors = batchResult.vectors || [];
  return vectors.map((v) => ({
    id: `${v.bookmarkId}:${v.chunkIndex}`,
    bookmarkId: v.bookmarkId,
    title: v.title,
    url: v.url,
    chunkText: v.chunkText,
    chunkIndex: v.chunkIndex,
    chunkTotal: v.chunkTotal,
    embedding: v.embedding,
    updatedAt: now,
  }));
}

function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!Number.isFinite(denom) || denom <= 0) return -1;
  return dot / denom;
}

function uniqueCitations(records: LocalRagVectorRecord[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const r of records) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ title: r.title || r.url, url: r.url });
  }
  return out;
}

function buildRagPrompt(
  settings: Awaited<ReturnType<typeof loadSettings>>,
  query: string,
  hits: LocalRagVectorRecord[]
): string {
  const context = hits
    .map((h, i) => {
      const chunk = h.chunkText.slice(0, MAX_CONTEXT_CHARS_PER_HIT);
      return `[${i + 1}] ${h.title || "(untitled)"}\nURL: ${h.url}\n${chunk}`;
    })
    .join("\n\n");

  const template = (settings.qaPromptTemplate || "").trim();
  if (!template) {
    return `Context:\n${context}\n\nQuestion:\n${query}`;
  }

  const hasContextToken = template.includes("{{context}}");
  const hasQuestionToken = template.includes("{{question}}") || template.includes("{{query}}");
  let out = template
    .replaceAll("{{context}}", context)
    .replaceAll("{{question}}", query)
    .replaceAll("{{query}}", query);
  if (!hasContextToken) out += `\n\nContext:\n${context}`;
  if (!hasQuestionToken) out += `\n\nQuestion:\n${query}`;
  return out;
}

function isManualSkipError(reason: string): boolean {
  return /aborted by user/i.test(reason);
}

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function answerQueryWithLocalRag(
  settings: Awaited<ReturnType<typeof loadSettings>>,
  query: string
) {
  const vectors = await loadAllLocalRagVectors();
  if (vectors.length === 0) {
    return {
      answer: "",
      citations: [],
      error: "No local RAG index found. Run Full index or Test (100) first.",
    };
  }

  const queryEmbedding = await embedQueryText(settings, query);
  if (!queryEmbedding.embedding) {
    return {
      answer: "",
      citations: [],
      error: queryEmbedding.error || "Failed to embed query for retrieval.",
    };
  }
  const queryVec = queryEmbedding.embedding;

  const scored = vectors
    .map((rec) => ({ rec, score: cosineSimilarity(queryVec, rec.embedding) }))
    .filter((x) => Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, RAG_TOP_K)
    .map((x) => x.rec);

  if (scored.length === 0) {
    return {
      answer: "",
      citations: [],
      error: "No relevant indexed bookmark chunks found for this question.",
    };
  }

  const ragPrompt = buildRagPrompt(settings, query, scored);
  const llm = await postQuery(settings, ragPrompt);
  return {
    answer: llm.answer,
    citations: uniqueCitations(scored),
    error: llm.error,
  };
}

async function uploadBatches(
  settings: Awaited<ReturnType<typeof loadSettings>>,
  items: BookmarkItem[],
  onBatchSuccess: ((batch: BookmarkItem[], result: IndexResponseBody) => Promise<void>) | undefined,
  runControl: IndexRunControl
): Promise<UploadBatchesResult> {
  const batches: BookmarkItem[][] = [];
  for (let i = 0; i < items.length; i += EMBEDDING_BATCH_SIZE) {
    batches.push(items.slice(i, i + EMBEDDING_BATCH_SIZE));
  }

  if (batches.length === 0) {
    return {
      indexed: 0,
      uploadedBookmarkIds: new Set<string>(),
      skippedTimeoutBatches: 0,
    };
  }

  let totalIndexed = 0;
  let skippedTimeoutBatches = 0;
  const uploadedBookmarkIds = new Set<string>();
  for (let b = 0; b < batches.length; b++) {
    const batchStartMs = Date.now();
    if (runControl.requestSkipCurrent) {
      runControl.requestSkipCurrent = false;
      broadcast({
        type: "INDEX_PROGRESS",
        phase: "upload",
        current: b + 1,
        total: batches.length,
        detail: `Batch ${b + 1}/${batches.length} skipped by user before request start.`,
      });
      continue;
    }
    broadcast({
      type: "INDEX_PROGRESS",
      phase: "upload",
      current: b + 1,
      total: batches.length,
      detail: `Embeddings batch ${b + 1}/${batches.length} started`,
    });
    const attemptAbort = new AbortController();
    runControl.abortCurrentEmbedding = () => attemptAbort.abort();
    const r = await postEmbeddingsBatch(settings, batches[b], { signal: attemptAbort.signal });
    runControl.abortCurrentEmbedding = undefined;

    if (r.ok) {
      if (onBatchSuccess) {
        try {
          await withTimeout(
            onBatchSuccess(batches[b], r),
            LOCAL_VECTOR_WRITE_TIMEOUT_MS,
            "Local vector write"
          );
        } catch (e) {
          skippedTimeoutBatches += 1;
          const reason = e instanceof Error ? e.message : String(e);
          broadcast({
            type: "INDEX_PROGRESS",
            phase: "upload",
            current: b + 1,
            total: batches.length,
            detail: `Batch ${b + 1}/${batches.length} skipped: ${reason} (elapsed ${formatElapsed(
              Date.now() - batchStartMs
            )}).`,
          });
          continue;
        }
      }
      totalIndexed += r.indexed;
      for (const item of batches[b]) {
        uploadedBookmarkIds.add(item.bookmarkId);
      }
      broadcast({
        type: "INDEX_PROGRESS",
        phase: "upload",
        current: b + 1,
        total: batches.length,
        detail: `Batch ${b + 1}/${batches.length} done in ${formatElapsed(
          Date.now() - batchStartMs
        )}.`,
      });
      continue;
    }

    const reason = r.error || "unknown embeddings upload error";
    skippedTimeoutBatches += 1;
    if (isManualSkipError(reason) || runControl.requestSkipCurrent) {
      runControl.requestSkipCurrent = false;
      broadcast({
        type: "INDEX_PROGRESS",
        phase: "upload",
        current: b + 1,
        total: batches.length,
        detail: `Batch ${b + 1}/${batches.length} skipped by user after ${formatElapsed(
          Date.now() - batchStartMs
        )}.`,
      });
      continue;
    }
    broadcast({
      type: "INDEX_PROGRESS",
      phase: "upload",
      current: b + 1,
      total: batches.length,
      detail: `Batch ${b + 1}/${batches.length} skipped: ${reason} (elapsed ${formatElapsed(
        Date.now() - batchStartMs
      )}).`,
    });
  }
  if (skippedTimeoutBatches > 0) {
    broadcast({
      type: "INDEX_PROGRESS",
      phase: "upload",
      current: batches.length,
      total: batches.length,
      detail: `Skipped ${skippedTimeoutBatches} batch(es) due to timeout/abort; indexing continued.`,
    });
  }
  runControl.abortCurrentEmbedding = undefined;
  return { indexed: totalIndexed, uploadedBookmarkIds, skippedTimeoutBatches };
}

async function runFullIndex(): Promise<void> {
  const runControl: IndexRunControl = { requestSkipCurrent: false };
  activeIndexRun = runControl;
  try {
    const settings = await loadSettings();
    if (!settings.ragBaseUrl.trim()) {
      broadcast({ type: "INDEX_DONE", ok: false, indexed: 0, error: "Set RAG base URL in Options." });
      return;
    }
    const tree = await chrome.bookmarks.getTree();
    const flat = flattenBookmarks(tree);
    broadcast({
      type: "INDEX_PROGRESS",
      phase: "fetch",
      current: 0,
      total: flat.length,
      detail: "Fetching pages…",
    });
    const items = await buildAllItems(settings, flat);
    await clearLocalRagVectors();
    const { indexed, error, uploadedBookmarkIds } = await uploadBatches(
      settings,
      items,
      async (batch, result) => {
        // Full index clears the local store before upload; only insert vectors here.
        await putLocalRagVectors(toLocalRagRecords(result));
      },
      runControl
    );
    if (error) {
      broadcast({ type: "INDEX_DONE", ok: false, indexed, error });
      return;
    }
    const state: IndexStateMap = {};
    for (let i = 0; i < flat.length; i++) {
      const bm = flat[i];
      if (!uploadedBookmarkIds.has(bm.id)) continue;
      const item = items[i];
      const text = item?.text || "";
      const contentHash = await hashContent(bm.url, bm.title, text);
      state[bm.id] = {
        url: bm.url,
        title: bm.title,
        contentHash,
        lastIndexedAt: Date.now(),
      };
    }
    await saveIndexState(state);
    broadcast({ type: "INDEX_DONE", ok: true, indexed });
  } catch (e) {
    broadcast({
      type: "INDEX_DONE",
      ok: false,
      indexed: 0,
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    if (activeIndexRun === runControl) activeIndexRun = null;
  }
}

async function runTestIndex(limit = TEST_INDEX_LIMIT): Promise<void> {
  const runControl: IndexRunControl = { requestSkipCurrent: false };
  activeIndexRun = runControl;
  try {
    const settings = await loadSettings();
    if (!settings.ragBaseUrl.trim()) {
      broadcast({ type: "INDEX_DONE", ok: false, indexed: 0, error: "Set RAG base URL in Options." });
      return;
    }
    const tree = await chrome.bookmarks.getTree();
    const all = flattenBookmarks(tree);
    const flat = all.slice(0, limit);
    broadcast({
      type: "INDEX_PROGRESS",
      phase: "fetch",
      current: 0,
      total: flat.length,
      detail: `Test mode: first ${flat.length} of ${all.length} bookmarks…`,
    });
    const items = await buildAllItems(settings, flat);
    await clearLocalRagVectors();
    const { indexed, error } = await uploadBatches(
      settings,
      items,
      async (_batch, result) => {
        await putLocalRagVectors(toLocalRagRecords(result));
      },
      runControl
    );
    if (error) {
      broadcast({ type: "INDEX_DONE", ok: false, indexed, error });
      return;
    }
    // Test run intentionally avoids updating incremental index state.
    broadcast({ type: "INDEX_DONE", ok: true, indexed });
  } catch (e) {
    broadcast({
      type: "INDEX_DONE",
      ok: false,
      indexed: 0,
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    if (activeIndexRun === runControl) activeIndexRun = null;
  }
}

async function runIncrementalIndex(): Promise<void> {
  const runControl: IndexRunControl = { requestSkipCurrent: false };
  activeIndexRun = runControl;
  try {
    const settings = await loadSettings();
    if (!settings.ragBaseUrl.trim()) {
      broadcast({ type: "INDEX_DONE", ok: false, indexed: 0, error: "Set RAG base URL in Options." });
      return;
    }
    const tree = await chrome.bookmarks.getTree();
    const flat = flattenBookmarks(tree);
    const prev = await loadIndexState();
    const currentIds = new Set(flat.map((f) => f.id));
    const removedBookmarkIds = Object.keys(prev).filter((id) => !currentIds.has(id));

    const toUpload: FlatBookmark[] = [];
    for (const bm of flat) {
      const old = prev[bm.id];
      if (!old || old.url !== bm.url) {
        toUpload.push(bm);
      }
    }

    broadcast({
      type: "INDEX_PROGRESS",
      phase: "fetch",
      current: 0,
      total: Math.max(1, toUpload.length),
      detail: "Incremental: new/changed URLs only…",
    });

    const items =
      toUpload.length === 0
        ? []
        : await poolMap(toUpload, FETCH_CONCURRENCY, (bm, i) =>
            bookmarkToItem(settings, bm, i, toUpload.length)
          );

    await deleteLocalRagVectorsByBookmarkIds(removedBookmarkIds);
    // Delete changed bookmark vectors once up-front; per-batch callback only inserts.
    await deleteLocalRagVectorsByBookmarkIds(toUpload.map((bm) => bm.id));
    const { indexed, error, uploadedBookmarkIds } = await uploadBatches(
      settings,
      items,
      async (_batch, result) => {
        await putLocalRagVectors(toLocalRagRecords(result));
      },
      runControl
    );
    if (error) {
      broadcast({ type: "INDEX_DONE", ok: false, indexed, error });
      return;
    }

    const state: IndexStateMap = { ...prev };
    for (const id of removedBookmarkIds) {
      delete state[id];
    }
    for (const bm of flat) {
      const old = prev[bm.id];
      if (!old || old.url !== bm.url) {
        if (!uploadedBookmarkIds.has(bm.id)) continue;
        const item = items.find((it) => it.bookmarkId === bm.id);
        const text = item?.text || "";
        const contentHash = await hashContent(bm.url, bm.title, text);
        state[bm.id] = {
          url: bm.url,
          title: bm.title,
          contentHash,
          lastIndexedAt: Date.now(),
        };
      }
    }

    await saveIndexState(state);
    broadcast({ type: "INDEX_DONE", ok: true, indexed });
  } catch (e) {
    broadcast({
      type: "INDEX_DONE",
      ok: false,
      indexed: 0,
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    if (activeIndexRun === runControl) activeIndexRun = null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch?.(() => {});
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "index-keepalive") return;
  keepAlivePorts.add(port);
  port.onMessage.addListener(() => {
    /* keepalive ping */
  });
  const cleanup = () => keepAlivePorts.delete(port);
  port.onDisconnect.addListener(cleanup);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-side-panel") return;
  chrome.windows.getCurrent((w) => {
    if (w.id != null) {
      chrome.sidePanel?.open?.({ windowId: w.id });
    }
  });
});

chrome.runtime.onMessage.addListener(
  (msg: BgRequest, _s, sendResponse: (r: BgResponse) => void) => {
    if (msg.type === "GET_SETTINGS") {
      loadSettings().then((settings) => {
        sendResponse({ type: "SETTINGS", settings });
      });
      return true;
    }
    if (msg.type === "QUERY") {
      (async () => {
        try {
          const settings = await loadSettings();
          if (!settings.qaBaseUrl.trim()) {
            sendResponse({
              type: "QUERY_DONE",
              ok: false,
              error: "Set Q&A base URL in Options.",
            });
            return;
          }
          const r = await answerQueryWithLocalRag(settings, msg.query);
          if (r.error && !r.answer) {
            sendResponse({ type: "QUERY_DONE", ok: false, error: r.error });
            return;
          }
          sendResponse({
            type: "QUERY_DONE",
            ok: true,
            answer: r.answer,
            citations: r.citations || [],
          });
        } catch (e) {
          sendResponse({
            type: "QUERY_DONE",
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
      return true;
    }
    if (msg.type === "INDEX_SKIP_CURRENT") {
      sendResponse({ type: "ACK" });
      if (!activeIndexRun) {
        // If worker restarted, clear panel busy state and ask user to restart indexing.
        broadcast({
          type: "INDEX_DONE",
          ok: false,
          indexed: 0,
          error:
            "No active indexing run in background (worker was likely restarted). Please run Incremental to continue.",
        });
        return true;
      }
      activeIndexRun.requestSkipCurrent = true;
      activeIndexRun.abortCurrentEmbedding?.();
      broadcast({
        type: "INDEX_PROGRESS",
        phase: "upload",
        current: 0,
        total: 0,
        detail: "Skip requested: aborting current embedding batch.",
      });
      return true;
    }
    if (msg.type === "INDEX_FULL") {
      sendResponse({ type: "ACK" });
      runFullIndex();
      return true;
    }
    if (msg.type === "INDEX_TEST") {
      sendResponse({ type: "ACK" });
      runTestIndex();
      return true;
    }
    if (msg.type === "INDEX_INCREMENTAL") {
      sendResponse({ type: "ACK" });
      runIncrementalIndex();
      return true;
    }
    return false;
  }
);
