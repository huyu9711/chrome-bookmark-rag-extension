# Bookmark RAG Manager (Chrome extension)

Manifest V3 extension that:

- **Indexes bookmarks** by fetching each page (first 50 lines of text), then calling **OpenAI-compatible** **`POST …/v1/embeddings`** (configurable path) and storing chunk vectors in a local IndexedDB RAG store.
- **Q&A (default)** uses local vector retrieval (top-k chunks) to build context, then calls **`POST …/v1/responses`** with the grounded prompt. **Reasoning effort** is configurable in Options (`none` omits the `reasoning` field). Alternatives: **Chat completions** or **Text completions** only.
- **Embeddings** requests include **`encoding_format: "float"`** (required by some NVIDIA / LiteLLM gateways).
- Works with **NVIDIA NIM / inference APIs**, OpenAI, vLLM, and other OpenAI-compatible gateways — **no custom `/query` or `/index/*` routes**.

## Configure

- **Base URL**: provider root only, e.g. `https://integrate.api.nvidia.com/v1`.  
  If the host already includes `/v1`, set paths to `embeddings` and `chat/completions` instead of `v1/embeddings` and `v1/chat/completions`.
- **Paths** (optional): defaults `v1/embeddings` and `v1/chat/completions`.
- **Embedding chunking** (optional): configure `chunk size` and `chunk overlap` in Options (defaults: `3000` / `50`).
- **Models**: use the model IDs your provider expects (e.g. `nvidia/nv-embedqa-e5-v5`, `meta/llama-3.1-8b-instruct`).

**Note:** Standard embeddings APIs do not store a vector database by themselves. This extension now stores vectors locally in IndexedDB and performs retrieval client-side before Q&A.

## Build

```bash
cd chrome-bookmark-rag-extension
npm install
npm run build
```

Load `dist/` via **Chrome → Extensions → Load unpacked**.

## Dev mock

```bash
npm run mock-server
```

Use **RAG base** `http://127.0.0.1:8787/v1`, **embeddings path** `embeddings`, **QA base** `http://127.0.0.1:8787/v1`, **chat path** `chat/completions`.

## Permissions

- `bookmarks`, `storage`, `sidePanel`, `tabs`
- `http://*/*`, `https://*/*` (fetch bookmark pages)

## Security

API keys are stored in `chrome.storage.local` only on the local machine.
