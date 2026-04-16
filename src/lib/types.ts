/** User-configurable settings (chrome.storage.local) */
export interface ExtensionSettings {
  /** Provider root, e.g. https://integrate.api.nvidia.com (no trailing /v1/chat/completions) */
  ragBaseUrl: string;
  ragApiKey: string;
  /** Embedding model id for OpenAI-compatible POST .../v1/embeddings */
  ragModel: string;
  /** Path under ragBaseUrl. Default: v1/embeddings */
  ragEmbedPath: string;
  /** Characters per embedding chunk. */
  ragChunkSize: number;
  /** Overlap characters between adjacent embedding chunks. */
  ragChunkOverlap: number;
  /** Max characters to keep from fetched page text. */
  ragTextMaxChars: number;
  /** Embeddings request timeout (milliseconds). */
  ragEmbeddingsTimeoutMs: number;
  /** Max retries for embeddings batch timeouts. */
  ragEmbeddingsRetryMax: number;
  /** Same idea as RAG — LLM provider root */
  qaBaseUrl: string;
  qaApiKey: string;
  /** Chat / completions model id */
  qaModel: string;
  /** Path when qaMode is chat. Default: v1/chat/completions */
  qaChatPath: string;
  /**
   * NVIDIA inference: POST v1/responses with { model, input, reasoning }.
   * Default: responses (see NVIDIA docs).
   */
  qaMode: "responses" | "chat" | "completions";
  /** Path when qaMode is responses. Default: v1/responses */
  qaResponsesPath: string;
  /** Path when qaMode is completions. Default: v1/completions */
  qaCompletionsPath: string;
  /** Sent as reasoning.effort for v1/responses; use "none" to omit reasoning */
  qaReasoningEffort: "none" | "low" | "medium" | "high";
  /**
   * Prompt template used for local-RAG grounded Q&A.
   * Supported placeholders: {{context}}, {{question}} (or {{query}}).
   */
  qaPromptTemplate: string;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  ragBaseUrl: "",
  ragApiKey: "",
  ragModel: "nvidia/nv-embedqa-e5-v5",
  ragEmbedPath: "v1/embeddings",
  ragChunkSize: 3000,
  ragChunkOverlap: 50,
  ragTextMaxChars: 1000,
  ragEmbeddingsTimeoutMs: 60_000,
  ragEmbeddingsRetryMax: 2,
  qaBaseUrl: "",
  qaApiKey: "",
  qaModel: "openai/openai/gpt-5.1-codex",
  qaChatPath: "v1/chat/completions",
  qaMode: "responses",
  qaResponsesPath: "v1/responses",
  qaCompletionsPath: "v1/completions",
  qaReasoningEffort: "high",
  qaPromptTemplate:
    "You are helping me find information from my bookmarks.\n" +
    "Answer only using the bookmark context below.\n" +
    "If the context is insufficient, say you cannot find the answer in indexed bookmarks.\n\n" +
    "Context:\n{{context}}\n\n" +
    "User question:\n{{question}}",
};

/** Per-bookmark index state for incremental updates */
export interface BookmarkIndexState {
  url: string;
  title: string;
  contentHash: string;
  lastIndexedAt: number;
}

export type IndexStateMap = Record<string, BookmarkIndexState>;

export interface BookmarkItem {
  bookmarkId: string;
  title: string;
  url: string;
  text: string;
}

export interface RagChunkEmbedding {
  bookmarkId: string;
  title: string;
  url: string;
  chunkText: string;
  chunkIndex: number;
  chunkTotal: number;
  embedding: number[];
}

export interface LocalRagVectorRecord {
  id: string;
  bookmarkId: string;
  title: string;
  url: string;
  chunkText: string;
  chunkIndex: number;
  chunkTotal: number;
  embedding: number[];
  updatedAt: number;
}

/** Messages: side panel <-> background */
export type BgRequest =
  | { type: "GET_SETTINGS" }
  | { type: "INDEX_FULL" }
  | { type: "INDEX_TEST" }
  | { type: "INDEX_INCREMENTAL" }
  | { type: "QUERY"; query: string };

export type BgResponse =
  | { type: "ACK" }
  | { type: "SETTINGS"; settings: ExtensionSettings }
  | { type: "INDEX_PROGRESS"; phase: string; current: number; total: number; detail?: string }
  | { type: "INDEX_DONE"; ok: boolean; indexed: number; error?: string }
  | { type: "QUERY_DONE"; ok: boolean; answer?: string; citations?: Citation[]; error?: string }
  | { type: "ERROR"; message: string };

export interface Citation {
  title: string;
  url: string;
}

/** Internal result shape for embedding batches */
export interface IndexResponseBody {
  ok: boolean;
  indexed: number;
  vectors?: RagChunkEmbedding[];
  error?: string;
}

export interface QueryResponseBody {
  answer: string;
  citations: Citation[];
  error?: string;
}
