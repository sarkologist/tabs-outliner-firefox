import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import type { OutlineNode, OutlineState } from "../model/types.js";
import { createFaultyStorage } from "../test/faulty-storage.test-support.js";
import { HISTORY_KEY, loadHistory } from "./storage.js";
import { indexedDbKvStore } from "./indexed-db-kv-store.js";
import { storageLocalKvStore, type KeyValueStore } from "./key-value-store.js";
import {
  STATE_V4_MANIFEST_A_KEY,
  STATE_V4_NODE_SHARD_PREFIX,
  copyStateV4Shards,
  deleteAllStateV4ShardKeys,
  loadStateV4,
  outlineStateV4Snapshot,
  stateV4NodeShardKey,
  sweepOrphanedV4Shards
} from "./storage-v4.js";

function sampleState(count = 12): OutlineState {
  const nodes: Record<string, OutlineNode> = {};
  const rootIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `tab:${index}`;
    nodes[id] = {
      id,
      kind: "tab",
      status: "closed",
      childIds: [],
      title: `Tab ${index}`,
      collapsed: false,
      createdAt: 1,
      updatedAt: 1
    };
    rootIds.push(id);
  }
  return { version: 1, rootIds, nodes };
}

function splitV4Items(setItems: Record<string, unknown>): {
  shardItems: Record<string, unknown>;
  localItems: Record<string, unknown>;
} {
  const shardItems: Record<string, unknown> = {};
  const localItems: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(setItems)) {
    if (key.startsWith(STATE_V4_NODE_SHARD_PREFIX)) {
      shardItems[key] = value;
    } else {
      localItems[key] = value;
    }
  }
  return { shardItems, localItems };
}

// Write a v4 snapshot the way the coordinator does with an external shard store: shards in the
// shard store, manifest on storage.local.
async function writeV4Split(
  api: WebExtensionBrowser,
  shardStore: KeyValueStore,
  state: OutlineState,
  previous?: Parameters<typeof outlineStateV4Snapshot>[1]["previous"]
): Promise<ReturnType<typeof outlineStateV4Snapshot>> {
  const snapshot = outlineStateV4Snapshot(state, {
    epoch: 1,
    journalSeqIncluded: 0,
    savedAt: 1,
    ...(previous ? { previous } : {})
  });
  const { shardItems, localItems } = splitV4Items(snapshot.setItems);
  await shardStore.set(shardItems);
  await api.storage.local.set(localItems);
  return snapshot;
}

describe("storage-v4 with shards on IndexedDB", () => {
  it("loads shards from the shard store and the manifest from storage.local", async () => {
    const local = createFaultyStorage();
    const idb = indexedDbKvStore("v4-idb-load", "kv");
    const state = sampleState();
    await writeV4Split(local.api, idb, state);

    // No shards on storage.local -- only the manifest pointer.
    expect(Object.keys(local.snapshot()).some((key) => key.startsWith(STATE_V4_NODE_SHARD_PREFIX))).toBe(false);
    expect(local.snapshot()[STATE_V4_MANIFEST_A_KEY]).toBeDefined();

    const loaded = await loadStateV4(local.api, idb);
    expect(loaded?.recovery).toBe("r0");
    expect(Object.keys(loaded?.state.nodes ?? {}).sort()).toEqual(Object.keys(state.nodes).sort());
  });

  it("copyStateV4Shards relocates the referenced shards so a load from the destination succeeds", async () => {
    const local = createFaultyStorage();
    const state = sampleState();
    const snapshot = outlineStateV4Snapshot(state, { epoch: 1, journalSeqIncluded: 0, savedAt: 1 });
    await local.api.storage.local.set(snapshot.setItems); // fully on storage.local (legacy layout)

    const idb = indexedDbKvStore("v4-idb-copy", "kv");
    const copied = await copyStateV4Shards(storageLocalKvStore(local.api), idb, [snapshot.manifest]);
    expect(copied).toBeGreaterThan(0);

    const loaded = await loadStateV4(local.api, idb);
    expect(loaded?.recovery).toBe("r0");
    expect(Object.keys(loaded?.state.nodes ?? {})).toHaveLength(12);
  });

  it("deleteAllStateV4ShardKeys removes only the shard keys, leaving the manifest", async () => {
    const local = createFaultyStorage();
    const snapshot = outlineStateV4Snapshot(sampleState(), { epoch: 1, journalSeqIncluded: 0, savedAt: 1 });
    await local.api.storage.local.set(snapshot.setItems);

    const removed = await deleteAllStateV4ShardKeys(storageLocalKvStore(local.api));
    expect(removed).toBeGreaterThan(0);
    expect(local.snapshot()[STATE_V4_MANIFEST_A_KEY]).toBeDefined();
    expect(Object.keys(local.snapshot()).some((key) => key.startsWith(STATE_V4_NODE_SHARD_PREFIX))).toBe(false);
  });

  it("loadHistory re-checks the store after a double-miss (migration race safety)", async () => {
    const local = createFaultyStorage(); // storage.local has no history (migration removed it)
    let storeGets = 0;
    const emptyStore: KeyValueStore = {
      get: async () => {
        storeGets += 1;
        return {};
      },
      set: async () => undefined,
      remove: async () => undefined
    };
    await loadHistory(local.api, undefined, emptyStore);
    // store read once up front, storage.local once, then the store re-checked = 2 store reads.
    expect(storeGets).toBe(2);
  });

  it("loadHistory falls back to storage.local when the store has no history", async () => {
    const local = createFaultyStorage();
    await local.api.storage.local.set({ [HISTORY_KEY]: { version: 1, undoStack: [], redoStack: [] } });
    const idb = indexedDbKvStore("history-fallback", "kv");
    const loaded = await loadHistory(local.api, undefined, idb);
    expect(loaded).toEqual({ version: 1, undoStack: [], redoStack: [] });
  });

  it("sweepOrphanedV4Shards removes an unreferenced shard generation from the shard store", async () => {
    const local = createFaultyStorage();
    const idb = indexedDbKvStore("v4-idb-sweep", "kv");
    await writeV4Split(local.api, idb, sampleState());

    // Plant a shard key at a generation no manifest references.
    await idb.set({
      [stateV4NodeShardKey(0, 999)]: { version: 4, shardIndex: 0, generation: 999, nodes: [] }
    });
    const result = await sweepOrphanedV4Shards(local.api, idb);
    expect(result.removed).toBe(1);
    // The live store still loads after the sweep.
    expect((await loadStateV4(local.api, idb))?.recovery).toBe("r0");
  });
});
