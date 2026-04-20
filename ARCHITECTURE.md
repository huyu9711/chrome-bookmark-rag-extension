# Architecture Spec — Bookmark RAG Manager (Chrome MV3 Extension)

## 1) Goals & Requirements (Final State)
- Index Chrome bookmarks into a local RAG store (IndexedDB) and use it for Q&A.
- Fetch page content for each bookmark with configurable text length (default 1000 chars).
- Include bookmark title in the indexed content.
- Provide chunking with overlap for embedding (configurable).
- Use OpenAI-compatible embeddings API; NVIDIA v1/responses for Q&A by default.
- Skip to next batch on embeddings timeout/error; no retries.
- Configurable timeouts for embeddings (default 60s).
- Avoid CORS-blocked domains and non-HTTP(S) URLs (skip Chrome Web Store + FTP).
- Provide Test Index (100) for quick validation.
- Q&A answer should have clickable links; citations should be numbered.
- Add a configurable Q&A prompt template (default is bookmark-search oriented).
- Options page should support Export/Import + Download/Upload settings.
- Add confirmation dialogs before index operations.

## 2) High-Level Architecture
MV3 extension with:
- Background service worker (single bundled `background.js`)
- Side panel UI (indexing + Q&A)
- Options page (config & tools)
- Local RAG DB in IndexedDB

## 3) Core Components

### A) Background Service Worker
File: `src/background/index.ts`

Responsibilities:
- Fetch and index bookmarks (full / incremental / test).
- Store embeddings in local IndexedDB.
- Build retrieval prompt and call LLM for Q&A.
- Maintain incremental index state in `chrome.storage.local`.

Key constants:
- `EMBEDDING_BATCH_SIZE = 1`
- `RAG_TOP_K = 6`
- `MAX_CONTEXT_CHARS_PER_HIT = 1200`

Features:
- Full / Incremental / Test index flows.
- Retry & backoff when embeddings timeout.
- Timeout handling with skip-and-continue.
- Confirmation dialogs before index actions (side panel).
- Local RAG retrieval for Q&A.

### B) Embeddings + Q&A API Client
File: `src/lib/api.ts`

Responsibilities:
- POST to `/v1/embeddings` with `encoding_format: "float"`.
- Parse embeddings into numeric vectors.
- Provide query embeddings for retrieval.
- Q&A via `v1/responses` by default, with optional chat/completions fallback.

Timeouts:
- Embeddings timeout configurable (default 60s).
- Q&A test timeout fixed at 15s.

### C) Local RAG Store
File: `src/lib/local-rag-db.ts`

Storage:
- IndexedDB database `bookmark-rag-local-db`
- Object store: `vectors`

Stores:
- Embedding vectors
- Chunk text
- Bookmark metadata (title/url)
- Chunk indices

Supports:
- Clear all vectors
- Upsert vectors
- Delete by bookmark ID
- Load all vectors

### D) Bookmark Fetching + Text Normalization
Files: `src/lib/bookmarks.ts`, `src/lib/text.ts`

Behavior:
- Fetch bookmark URL (HTML or plain).
- Convert HTML to indexed plain text.
- Limit by line count (legacy) and max chars (new).
- Truncate to configured `ragTextMaxChars` (default 1000).
- Skip:
  - `chrome://`, `chrome-extension://`, `file://`, etc.
  - CORS-blocked domains: `chrome.google.com`, `tools.google.com`, `chromewebstore.google.com`
  - Non-HTTP(S) (e.g. FTP).

### E) Side Panel UI
File: `src/sidepanel/main.ts`

Features:
- Buttons: Full / Incremental / Test (100)
- Confirmation dialogs before indexing
- Index logs with progress
- Q&A input + answer area
- Clickable links in answers (plain URL + Markdown)
- Numbered citations list

### F) Options UI
Files: `src/options/index.html`, `src/options/main.ts`

Settings include:
- Embeddings:
  - Base URL, API key, model, path
  - Chunk size + overlap
  - Max page text chars
  - Embeddings timeout (seconds)
- Q&A:
  - API style (responses/chat/completions)
  - Base URL, key, model, paths
  - Reasoning effort
  - Prompt template (default bookmark-search prompt)

Tools:
- Export settings (clipboard)
- Import settings (paste JSON)
- Download JSON
- Upload JSON

## 4) Data Flow

### Indexing (Full / Incremental / Test)
1. Read settings from `chrome.storage.local`.
2. Flatten bookmarks.
3. Fetch page text (limited by `ragTextMaxChars`).
4. Chunk + embed (batch size 1).
5. Store vectors in IndexedDB.
6. Update index state in `chrome.storage.local`.

Error handling:
- If an embeddings batch fails (timeout/error), skip it and continue with next batch.

### Q&A
1. Embed query text.
2. Cosine similarity against local vectors.
3. Take top-K (default 6).
4. Build prompt using configurable template.
5. Call Q&A API.
6. Return answer + numbered citations.

## 5) Configuration (Defaults)
Stored in `DEFAULT_SETTINGS` (`src/lib/types.ts`):

- `ragChunkSize = 3000`
- `ragChunkOverlap = 50`
- `ragTextMaxChars = 1000`
- `ragEmbeddingsTimeoutMs = 60000`
- `ragEmbeddingsRetryMax = 2`
- `qaPromptTemplate` includes default bookmark-search prompt

## 6) Error Handling Strategy
- Embeddings timeout / abort:
  - Skip current batch and continue
- Non-timeout errors:
  - Stop indexing and surface error
- No local RAG DB:
  - Q&A returns explicit error, instructs to index first

## 7) Security & Storage
- API keys stored only in `chrome.storage.local`.
- Vectors stored locally in IndexedDB.
- No external database used by default.

## 8) Known Limitations
- Local RAG vector search is brute-force (linear scan).
- Service worker lifecycle may still interrupt long index runs.
- Embeddings timeout limits should be tuned for provider latency.

## 9) Key Files Index
- `src/background/index.ts` — orchestration, indexing, Q&A, skip-on-error flow
- `src/lib/api.ts` — embeddings + Q&A HTTP client
- `src/lib/local-rag-db.ts` — IndexedDB RAG store
- `src/lib/bookmarks.ts` — fetch + skip rules
- `src/lib/text.ts` — text extraction + truncation
- `src/options/*` — settings & import/export
- `src/sidepanel/*` — UI for index + Q&A
