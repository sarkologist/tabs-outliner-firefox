import { createBrowserAdapter } from "./browser-adapter.js";
import { createBackgroundController } from "./controller.js";
import { indexedDbKvStore } from "./indexed-db-kv-store.js";

const api = browser;
const adapter = createBrowserAdapter(api);

// Back the hot-path outline journal with an extension-owned IndexedDB store so journal appends
// stop paying storage.local's whole-store-rewrite cost (0.5-6.7 s per 1 KB write on a large
// profile). The journal migrates itself off storage.local on first run; everything else
// (manifests, shards, prefs, incident log) stays on storage.local for now.
// See docs/storage-rearchitecture/04-STORAGE-WRITE-COST.md section 6.
const journalStore = indexedDbKvStore("tabsOutliner", "kv");

createBackgroundController({ api, adapter, journalStore });
