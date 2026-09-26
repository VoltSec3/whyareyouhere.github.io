import type { StoredSound } from "./types";

const DB_NAME = "cutitquik";
const DB_VERSION = 1;
const SOUNDS = "sounds";
const META = "meta";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SOUNDS)) {
        const store = db.createObjectStore(SOUNDS, { keyPath: "id" });
        store.createIndex("category", "category", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the local database"));
  });

  return dbPromise;
}

async function withStore<T>(
  name: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | null> {
  const db = await openDatabase();
  return new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const store = tx.objectStore(name);
    let result: T | null = null;

    const request = run(store);
    if (request) request.onsuccess = () => (result = request.result);

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error("Database transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Database transaction aborted"));
  });
}

export const soundStore = {
  async all(): Promise<StoredSound[]> {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction(SOUNDS, "readonly").objectStore(SOUNDS).getAll();
      request.onsuccess = () => resolve(request.result as StoredSound[]);
      request.onerror = () => reject(request.error ?? new Error("Could not read sounds"));
    });
  },

  async put(sound: StoredSound): Promise<void> {
    await withStore(SOUNDS, "readwrite", (store) => store.put(sound));
  },

  async remove(id: string): Promise<void> {
    await withStore(SOUNDS, "readwrite", (store) => store.delete(id));
  },

  async clear(): Promise<void> {
    await withStore(SOUNDS, "readwrite", (store) => store.clear());
  },
};

export type StoredNoise = {
  wav: ArrayBuffer;
  duration: number;
  createdAt: number;
};

export const metaStore = {
  async get<T>(key: string): Promise<T | null> {
    const db = await openDatabase();
    return new Promise<T | null>((resolve, reject) => {
      const request = db.transaction(META, "readonly").objectStore(META).get(key);
      request.onsuccess = () => resolve((request.result as { value: T } | undefined)?.value ?? null);
      request.onerror = () => reject(request.error ?? new Error("Could not read metadata"));
    });
  },

  async set<T>(key: string, value: T): Promise<void> {
    await withStore(META, "readwrite", (store) => store.put({ key, value }));
  },

  getNoise: () => metaStore.get<StoredNoise>("noise"),
  setNoise: (noise: StoredNoise) => metaStore.set<StoredNoise>("noise", noise),

  async clearNoise(): Promise<void> {
    await withStore(META, "readwrite", (store) => store.delete("noise"));
  },
};
