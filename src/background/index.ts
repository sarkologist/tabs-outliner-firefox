import { createBrowserAdapter } from "./browser-adapter.js";
import { createBackgroundController } from "./controller.js";
import { indexedDbKvStore } from "./indexed-db-kv-store.js";

const api = browser;
const adapter = createBrowserAdapter(api);

// Back the bulk store -- the hot-path outline journal AND the node shards -- with an extension-
// owned IndexedDB store so writes stop paying storage.local's whole-store-rewrite cost (0.5-6.7 s
// per write on a large profile) and become O(payload). One store holds both (distinct key
// prefixes: outline:v4:journal: and outline:v4:nodes:). The journal and shards each migrate
// themselves off storage.local on first run (verify-before-delete for the shards); the manifest
// (a small pointer) stays on storage.local as the shadow-paging commit point, along with prefs,
// history, incident log, and the boot snapshot. See docs/storage-rearchitecture/04-STORAGE-WRITE-COST.md.
const idbStore = indexedDbKvStore("tabsOutliner", "kv");

createBackgroundController({ api, adapter, journalStore: idbStore, shardStore: idbStore });
