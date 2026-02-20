export type CacheEnvelope<T> = {
  locale: string;
  version: string;
  fetchedAt: number;
  data: T;
};

const DB_NAME = "mh-wilds-optimizer-cache";
const DB_VERSION = 1;
const STORE_NAME = "locale-cache";

function supportsIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase | null> {
  if (!supportsIndexedDb()) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function readCacheEnvelope<T>(locale: string): Promise<CacheEnvelope<T> | null> {
  const db = await openDb();
  if (!db) {
    return null;
  }

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(locale);
    request.onsuccess = () => {
      resolve((request.result as CacheEnvelope<T> | undefined) ?? null);
    };
    request.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
    tx.oncomplete = () => db.close();
  });
}

export async function writeCacheEnvelope<T>(locale: string, envelope: CacheEnvelope<T>): Promise<void> {
  const db = await openDb();
  if (!db) {
    return;
  }

  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(envelope, locale);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

export async function clearCacheEnvelope(locale: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    return;
  }

  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(locale);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

export const cacheStore = {
  read: readCacheEnvelope,
  write: writeCacheEnvelope,
  clear: clearCacheEnvelope,
};
