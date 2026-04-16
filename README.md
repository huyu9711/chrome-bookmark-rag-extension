# Bookmark RAG Manager (Chrome extension)

Bookmark RAG Manager is a Manifest V3 Chrome extension that indexes your bookmarks locally and lets you ask
questions against that index using an OpenAI‑compatible embeddings API and an LLM endpoint (NVIDIA `v1/responses`
by default).

## Highlights

- **Local RAG**: embeddings are stored in IndexedDB and retrieved client‑side.
- **OpenAI‑compatible APIs**: works with NVIDIA NIM, OpenAI, vLLM, LiteLLM, etc.
- **Configurable indexing**: chunk size, overlap, max page text length, timeouts, retries.
- **Safe indexing**: skip FTP / chrome:// and CORS‑blocked domains (Chrome Web Store).
- **Usable UX**: test index, confirmation dialogs, clickable answer links, numbered citations.

## Quick Start

```bash
cd chrome-bookmark-rag-extension
npm install
npm run build
```

Load `dist/` via **Chrome → Extensions → Load unpacked**.

## Usage

### 1) Configure
Open **Options** from the side panel.

**Embeddings (Index)**
- Base URL + API key + model
- Embeddings path (default `v1/embeddings`)
- Chunk size / overlap (default `3000` / `50`)
- Max page text (chars) (default `1000`)
- Embeddings timeout (seconds) (default `60`)
- Embeddings timeout retries (default `2`)

**Q&A**
- API style: `responses` (default), `chat`, `completions`
- Base URL + API key + model
- Paths (default `v1/responses`, `v1/chat/completions`, `v1/completions`)
- Reasoning effort (responses only)
- Prompt template (default bookmark‑search prompt)

**Settings Tools**
- Export / Import (clipboard)
- Download / Upload (JSON file)

### 2) Index
Use the side panel:

- **Full index**: re‑indexes all bookmarks (replaces local RAG DB)
- **Incremental**: only new/changed bookmarks
- **Test (100)**: first 100 bookmarks for quick validation

### 3) Ask
Type a question. The extension embeds the query, retrieves top‑K chunks, and sends a grounded prompt to your LLM.

Links in the answer are clickable; citations are numbered.

## Default Prompt

The default Q&A prompt is:

```
You are helping me find my bookmarks of {{question}}.
In the answer, make the source as a url of the bookmark you found.
```

You can edit it in Options. Supported placeholders: `{{context}}`, `{{question}}`, `{{query}}`.

## Dev Mock Server

```bash
npm run mock-server
```

Use:
- RAG base: `http://127.0.0.1:8787/v1`
- Embeddings path: `embeddings`
- QA base: `http://127.0.0.1:8787/v1`
- Chat path: `chat/completions`

## Permissions

- `bookmarks`, `storage`, `sidePanel`, `tabs`
- `http://*/*`, `https://*/*` (fetch bookmark pages)

## Security

API keys are stored in `chrome.storage.local` on your machine only.
