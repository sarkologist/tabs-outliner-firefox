import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import type { NodeId, OutlineNode } from "../model/types.js";
import { createFaultyStorage } from "../test/faulty-storage.test-support.js";
import { indexedDbKvStore } from "./indexed-db-kv-store.js";
import { storageLocalKvStore } from "./key-value-store.js";
import {
  JOURNAL_META_KEY,
  JOURNAL_SLOT_PREFIX,
  createOutlineJournal,
  migrateJournalStore
} from "./outline-journal.js";

function makeNode(id: NodeId, overrides: Partial<OutlineNode> = {}): OutlineNode {
  return {
    id,
    kind: "tab",
    status: "closed",
    childIds: [],
    title: id,
    collapsed: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  };
}

describe("outline journal on IndexedDB (the production substrate)", () => {
  it("round-trips appended entries across a reopen", async () => {
    const journal = createOutlineJournal(indexedDbKvStore("journal-idb-roundtrip", "kv"), {
      epoch: 1,
      now: () => 1000
    });
    await journal.init();
    await journal.append([
      { kind: "command", label: "rename", delta: { updatedNodes: [makeNode("tab:1")] } },
      { kind: "command", label: "close", delta: { deletedNodeIds: ["tab:2"] } }
    ]);

    // A fresh handle on the same database = a background restart.
    const reopened = createOutlineJournal(indexedDbKvStore("journal-idb-roundtrip", "kv"), {
      epoch: 2
    });
    const init = await reopened.init();

    expect(init.entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(init.entries[0]?.delta?.updatedNodes?.[0]?.id).toBe("tab:1");
    expect(init.entries[1]?.delta?.deletedNodeIds).toEqual(["tab:2"]);
  });

  it("migrateJournalStore moves a storage.local journal onto IndexedDB, preserves entries+epoch, drops the source", async () => {
    const local = createFaultyStorage();
    const localStore = storageLocalKvStore(local.api);
    const seeded = createOutlineJournal(localStore, { epoch: 5, now: () => 1000 });
    await seeded.init();
    await seeded.append([
      { kind: "command", label: "close", delta: { deletedNodeIds: ["tab:9"] } }
    ]);
    expect(local.snapshot()[JOURNAL_META_KEY]).toBeDefined();
    expect(Object.keys(local.snapshot()).some((key) => key.startsWith(JOURNAL_SLOT_PREFIX))).toBe(
      true
    );

    const idb = indexedDbKvStore("journal-idb-migrate", "kv");
    expect(await migrateJournalStore(localStore, idb)).toBe(true);

    // Source fully drained.
    expect(local.snapshot()[JOURNAL_META_KEY]).toBeUndefined();
    expect(Object.keys(local.snapshot()).some((key) => key.startsWith(JOURNAL_SLOT_PREFIX))).toBe(
      false
    );

    // Destination recovers the entry; epoch continues (prior 5 -> next session 6) the way the
    // coordinator computes it from the migrated meta.
    const idbMeta = (await idb.get(JOURNAL_META_KEY))[JOURNAL_META_KEY] as
      | { epoch?: number }
      | undefined;
    expect(idbMeta?.epoch).toBe(5);
    const journal = createOutlineJournal(idb, { epoch: 6 });
    const init = await journal.init();
    expect(init.entries.map((entry) => entry.seq)).toEqual([1]);
    expect(init.entries[0]?.delta?.deletedNodeIds).toEqual(["tab:9"]);

    // Idempotent: once the destination is authoritative, a second migration is a no-op.
    expect(await migrateJournalStore(localStore, idb)).toBe(false);
  });

  it("migrateJournalStore leaves the source intact when the destination write fails", async () => {
    const local = createFaultyStorage();
    const localStore = storageLocalKvStore(local.api);
    const seeded = createOutlineJournal(localStore, { epoch: 5, now: () => 1000 });
    await seeded.init();
    await seeded.append([
      { kind: "command", label: "close", delta: { deletedNodeIds: ["tab:9"] } }
    ]);
    const before = local.snapshot();

    // A destination whose copy write fails (e.g. an IndexedDB transaction abort): migration must
    // propagate and NOT drop the source, so the journal stays recoverable and the next run retries.
    const failingDestination = {
      get: async () => ({}),
      set: async () => {
        throw new Error("indexedDB write failed");
      },
      remove: async () => undefined
    };
    await expect(migrateJournalStore(localStore, failingDestination)).rejects.toThrow(
      "indexedDB write failed"
    );
    expect(local.snapshot()).toEqual(before);
  });

  it("migrateJournalStore is a no-op when the source has no journal", async () => {
    const local = createFaultyStorage();
    const idb = indexedDbKvStore("journal-idb-noop", "kv");
    expect(await migrateJournalStore(storageLocalKvStore(local.api), idb)).toBe(false);
    expect(await idb.get(JOURNAL_META_KEY)).toEqual({ [JOURNAL_META_KEY]: undefined });
  });

  it("migrateJournalStore does not clobber an already-migrated destination", async () => {
    // Destination already has a newer journal; a leftover source must not overwrite it.
    const local = createFaultyStorage();
    const localStore = storageLocalKvStore(local.api);
    const stale = createOutlineJournal(localStore, { epoch: 1, now: () => 1000 });
    await stale.init();
    await stale.append([
      { kind: "command", label: "rename", delta: { updatedNodes: [makeNode("tab:old")] } }
    ]);

    const idb = indexedDbKvStore("journal-idb-authoritative", "kv");
    const current = createOutlineJournal(idb, { epoch: 9, now: () => 2000 });
    await current.init();
    await current.append([
      { kind: "command", label: "rename", delta: { updatedNodes: [makeNode("tab:new")] } }
    ]);

    expect(await migrateJournalStore(localStore, idb)).toBe(false);
    const init = await createOutlineJournal(idb, { epoch: 10 }).init();
    expect(init.entries[0]?.delta?.updatedNodes?.[0]?.id).toBe("tab:new");
  });
});
