# Bookmark RAG Manager — User Manual

This guide explains how to install, configure, index, and query your bookmarks with the extension.

---

## 1) Install & Open

1. Build or download the extension.
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the `dist/` folder
5. Open the extension side panel from the toolbar icon

---

## 2) Configure (Options Page)

Open **Options** (link at top right of the side panel).

### Embeddings (Index)
- **Base URL**: provider root (example: `https://integrate.api.nvidia.com/v1`)
- **API key**: your embedding key
- **Embedding model**: example `nvidia/nv-embedqa-e5-v5`
- **Embeddings path**: default `v1/embeddings`
- **Chunk size / overlap**: how text is split before embedding
- **Max page text (chars)**: default `1000`
- **Embeddings timeout (seconds)**: default `60`
- **Embeddings timeout retries**: default `2`

### Q&A (LLM)
- **API style**: default `Responses`
- **Base URL / API key / Model**
- **Paths**: default `v1/responses`, `v1/chat/completions`, `v1/completions`
- **Reasoning effort**: `high` by default
- **Prompt template**: default already assumes bookmark search

### Tools
You can:
- **Export** settings (clipboard)
- **Import** settings (paste JSON)
- **Download JSON**
- **Upload JSON**

---

## 3) Index Bookmarks

Open the side panel and choose:

### ✅ Full index
Indexes **all bookmarks** and replaces the local RAG database.

### ✅ Incremental
Only indexes bookmarks that are **new or changed**.

### ✅ Test (100)
Indexes only the **first 100 bookmarks** (for quick testing).

> A confirmation dialog appears before each operation.

---

## 4) Ask Questions

Type a question in the **Ask** box.

Example:
```
Where is the article about GPU inference benchmarks?
```

The extension will:
1. Embed your question
2. Retrieve matching bookmark chunks locally
3. Send the grounded prompt to your Q&A model

### Answer behavior
- Links in the answer are **clickable**
- Reference list below is **numbered**

---

## 5) Common Problems

### “No local RAG index found”
You need to run **Full index** or **Test (100)** first to build the local RAG database.

### “Batch X/Y failed: Embeddings request timed out”
Your embeddings provider is too slow for the configured timeout. Increase:
- **Embeddings timeout (seconds)**
- **Embeddings timeout retries**

### “User aborted”
This is a browser abort (timeout or service worker suspension). Increase timeout/retries.

### CORS errors while indexing
Some domains (Chrome Web Store, tools.google.com) block extension fetches. The extension
skips those automatically.

---

## 6) Tips

- Use **Test (100)** first to validate config quickly.
- Keep chunk size moderate (e.g. 3000) for faster embeddings.
- If you update many bookmarks, run **Incremental** regularly.
