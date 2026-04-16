import type { LocalRagVectorRecord } from "./types";

const DB_NAME = "bookmark-rag-local-db";
const DB_VERSION = 1;
const STORE_VECTORS = "vectors";
const INDEX_BOOKMARK_ID = "bookmarkId";

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
  });
}

async function openDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_VECTORS)) {
        const store = db.createObjectStore(STORE_VECTORS, { keyPath: "id" });
        store.createIndex(INDEX_BOOKMARK_ID, INDEX_BOOKMARK_ID, { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB"));
  });
}

export async function clearLocalRagVectors(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_VECTORS, "readwrite");
    tx.objectStore(STORE_VECTORS).clear();
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export async function putLocalRagVectors(records: LocalRagVectorRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_VECTORS, "readwrite");
    const store = tx.objectStore(STORE_VECTORS);
    for (const rec of records) {
      store.put(rec);
    }
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export async function deleteLocalRagVectorsByBookmarkIds(bookmarkIds: string[]): Promise<void> {
  if (bookmarkIds.length === 0) return;
  const db = await openDb();
  try {
    const target = new Set(bookmarkIds);
    const tx = db.transaction(STORE_VECTORS, "readwrite");
    const store = tx.objectStore(STORE_VECTORS);
    await new Promise<void>((resolve, reject) => {
      const req = store.openCursor();
      req.onerror = () => reject(req.error || new Error("Failed to open delete cursor"));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        const row = cursor.value as { bookmarkId?: string };
        if (row.bookmarkId && target.has(row.bookmarkId)) {
          cursor.delete();
        }
        cursor.continue();
      };
    });
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export async function loadAllLocalRagVectors(): Promise<LocalRagVectorRecord[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_VECTORS, "readonly");
    const store = tx.objectStore(STORE_VECTORS);
    const all = await requestToPromise(store.getAll());
    await transactionDone(tx);
    return all;
  } finally {
    db.close();
  }
}
