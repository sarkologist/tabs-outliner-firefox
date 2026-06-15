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
export function indexedDbKvStore(dbName: string, storeName: string): KeyValueStore {
  let dbPromise: Promise<IDBDatabase> | undefined;

  function openDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
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
      }).catch((error) => {
        // Let a transient open failure be retried on the next call rather than poisoning the store.
        dbPromise = undefined;
        throw error;
      });
    }
    return dbPromise;
  }

  async function get(keys: string | string[] | null = null): Promise<Record<string, unknown>> {
    const db = await openDb();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
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
    });
  }

  async function set(items: Record<string, unknown>): Promise<void> {
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      for (const [key, value] of Object.entries(items)) {
        store.put(value, key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("indexedDB write transaction aborted"));
    });
  }

  async function remove(keys: string | string[]): Promise<void> {
    const db = await openDb();
    const keyList = typeof keys === "string" ? [keys] : keys;
    if (keyList.length === 0) {
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      for (const key of keyList) {
        store.delete(key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("indexedDB delete transaction aborted"));
    });
  }

  return { get, set, remove };
}
