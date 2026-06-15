import type { KeyValueStore } from "./key-value-store.js";

// A KeyValueStore backed by an extension-owned IndexedDB database (one out-of-line-keyed object
// store). Unlike Firefox's legacy `storage.local` JSON backend -- which re-serializes and rewrites
// the WHOLE area on every `set` (so even a 1 KB write is O(total store)) -- an IndexedDB put is
// O(payload) and a multi-key write is a single atomic transaction. The journal/snapshot algorithm
// is unchanged; only the substrate moves. See docs/storage-rearchitecture/04-STORAGE-WRITE-COST.md.
//
// The KeyValueStore contract mirrors the `storage.local` subset the journal uses: `get` of a
// string / array / null(=all), `set` of a record, `remove` of a string / array. Missing keys come
// back `undefined` (the journal's validators treat that as "absent"), matching the in-memory mock.
// A wedged IndexedDB operation (a stuck `onblocked`, an OS-level disk stall, or a corrupt database
// that hangs rather than erroring) would otherwise never settle. Since these stores sit on the
// startup-critical path, bound every op: on timeout it rejects so the caller's fallback runs
// (journal -> journal-less; shards -> storage.local authoritative). Generous enough not to trip on
// a genuinely slow disk (the legacy storage.local backend was seen up to ~6.7 s for a 1 KB write).
const IDB_OPERATION_TIMEOUT_MS = 30000;

function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`indexedDB ${label} timed out after ${IDB_OPERATION_TIMEOUT_MS}ms`));
    }, IDB_OPERATION_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function indexedDbKvStore(dbName: string, storeName: string): KeyValueStore {
  let dbPromise: Promise<IDBDatabase> | undefined;

  function openDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = withTimeout(new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error(`indexedDB.open(${dbName}) failed`));
        request.onblocked = () => reject(new Error(`indexedDB.open(${dbName}) blocked`));
      }), `open(${dbName})`).catch((error) => {
        // Let a transient open failure (or timeout) be retried on the next call rather than
        // poisoning the store with a permanently-rejected cached promise.
        dbPromise = undefined;
        throw error;
      });
    }
    return dbPromise;
  }

  async function get(keys: string | string[] | null = null): Promise<Record<string, unknown>> {
    const db = await openDb();
    return withTimeout(new Promise<Record<string, unknown>>((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const result: Record<string, unknown> = {};
      if (keys === null) {
        const keyRequest = store.getAllKeys();
        const valueRequest = store.getAll();
        tx.oncomplete = () => {
          const storedKeys = keyRequest.result;
          const storedValues = valueRequest.result;
          storedKeys.forEach((key, index) => {
            result[String(key)] = storedValues[index];
          });
          resolve(result);
        };
      } else {
        const keyList = typeof keys === "string" ? [keys] : keys;
        for (const key of keyList) {
          const request = store.get(key);
          request.onsuccess = () => {
            result[key] = request.result;
          };
        }
        tx.oncomplete = () => resolve(result);
      }
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("indexedDB read transaction aborted"));
    }), "get");
  }

  async function set(items: Record<string, unknown>): Promise<void> {
    const db = await openDb();
    return withTimeout(new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      for (const [key, value] of Object.entries(items)) {
        store.put(value, key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("indexedDB write transaction aborted"));
    }), "set");
  }

  async function remove(keys: string | string[]): Promise<void> {
    const db = await openDb();
    const keyList = typeof keys === "string" ? [keys] : keys;
    if (keyList.length === 0) {
      return;
    }
    return withTimeout(new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      for (const key of keyList) {
        store.delete(key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("indexedDB delete transaction aborted"));
    }), "remove");
  }

  return { get, set, remove };
}
