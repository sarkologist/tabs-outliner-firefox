// A minimal key-value port: the exact subset of `storage.local` the v4 journal/snapshot modules
// use (get/set/remove). It is the seam for moving the bulk store (the hot-path journal first, the
// node shards later) off Firefox's whole-store-rewrite `storage.local` backend -- where even a 1 KB
// write costs O(total store) (seconds on a large profile) -- onto an extension-owned IndexedDB
// store where a put is O(payload), WITHOUT touching the journal/snapshot algorithm.
// See docs/storage-rearchitecture/04-STORAGE-WRITE-COST.md section 6.
export type KeyValueStore = {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

// Pass-through KeyValueStore backed by `chrome.storage.local` -- today's behavior, byte-for-byte.
// The journal/snapshot code calls only get/set/remove, so this is a faithful adapter, and every
// existing unit/fault mock that provides `storage.local` satisfies the port with no new mock.
export function storageLocalKvStore(api: WebExtensionBrowser): KeyValueStore {
  const local = api.storage.local;
  return {
    get: (keys = null) => local.get(keys),
    set: (items) => local.set(items),
    remove: (keys) => local.remove(keys)
  };
}
