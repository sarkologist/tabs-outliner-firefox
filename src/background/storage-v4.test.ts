import { describe, expect, it } from "vitest";

import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import { createFaultyStorage } from "../test/faulty-storage.test-support.js";
import {
  generatedTraceConfig,
  generatedTraceTimeoutMs
} from "../test/generated-traces.test-support.js";
import {
  createOutlineJournal,
  replayJournal,
  type OutlineJournalEntry,
  type OutlineJournalEntryKind
} from "./outline-journal.js";
import { outlineNodeShardIndex } from "./storage.js";
import {
  STATE_V4_MANIFEST_A_KEY,
  STATE_V4_MANIFEST_B_KEY,
  STATE_V4_NODE_SHARD_COUNT,
  loadStateV4,
  hasAnyStateV4Keys,
  outlineStateV4Snapshot,
  stateV4NodeShardKey,
  stateV4ShardIndexForNodeId,
  sweepOrphanedV4Shards,
  type StateV4Manifest,
  type StateV4ManifestSlot
} from "./storage-v4.js";

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

function makeTree(tabCount: number): OutlineState {
  const childIds = Array.from({ length: tabCount }, (_value, index) => `tab:${index + 1}`);
  return {
    version: 1,
    rootIds: ["window:10"],
    nodes: {
      "window:10": makeNode("window:10", { kind: "window", childIds: [...childIds] }),
      ...Object.fromEntries(
        childIds.map((id) => [
          id,
          makeNode(id, { parentId: "window:10", url: `https://example.test/${id}` })
        ])
      )
    }
  };
}

async function applySnapshot(
  faulty: ReturnType<typeof createFaultyStorage>,
  snapshot: ReturnType<typeof outlineStateV4Snapshot>
): Promise<void> {
  await faulty.api.storage.local.set(snapshot.setItems);
  if (snapshot.removeKeysAfterCommit.length > 0) {
    await faulty.api.storage.local.remove(snapshot.removeKeysAfterCommit);
  }
}

// Hand-build a store sharded at an arbitrary count (outlineStateV4Snapshot is bound to the current
// constant, so we cannot produce a legacy-count store through it). Used to exercise the 32 -> 256
// migration and its torn-write fallback window.
function oldCountStoreItems(
  state: OutlineState,
  shardCount: number,
  generation: number,
  slot: StateV4ManifestSlot
): { items: Record<string, unknown>; manifest: StateV4Manifest } {
  const items: Record<string, unknown> = {};
  const shardGenerations: number[] = [];
  const closedCount = Object.values(state.nodes).filter((node) => node.status === "closed").length;
  for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
    const nodes = Object.values(state.nodes)
      .filter((node) => outlineNodeShardIndex(node.id, shardCount) === shardIndex)
      .sort((left, right) => left.id.localeCompare(right.id));
    items[stateV4NodeShardKey(shardIndex, generation)] = {
      version: 4,
      shardIndex,
      generation,
      nodes
    };
    shardGenerations.push(generation);
  }
  const manifest: StateV4Manifest = {
    version: 4,
    generation,
    epoch: 0,
    journalSeqIncluded: 0,
    rootIds: [...state.rootIds],
    nodeCount: Object.keys(state.nodes).length,
    closedCount,
    shardGenerations,
    savedAt: generation
  };
  items[slot === "a" ? STATE_V4_MANIFEST_A_KEY : STATE_V4_MANIFEST_B_KEY] = manifest;
  return { items, manifest };
}

describe("outline state v4 storage", () => {
  it("round-trips a full write at generation 1 into slot a", async () => {
    const state = makeTree(300);
    const faulty = createFaultyStorage();
    const snapshot = outlineStateV4Snapshot(state, { epoch: 1, journalSeqIncluded: 0, savedAt: 5 });

    expect(snapshot.manifest.generation).toBe(1);
    expect(snapshot.slot).toBe("a");
    expect(Object.keys(snapshot.setItems)).toHaveLength(STATE_V4_NODE_SHARD_COUNT + 1);
    expect(snapshot.removeKeysAfterCommit).toEqual([]);
    expect(snapshot.manifest.nodeCount).toBe(301);

    await applySnapshot(faulty, snapshot);
    const loaded = await loadStateV4(faulty.api);

    expect(loaded?.recovery).toBe("r0");
    expect(loaded?.slot).toBe("a");
    expect(loaded?.journalSeqIncluded).toBe(0);
    expect(loaded?.repair).toBeUndefined();
    expect(loaded?.state).toEqual(state);
  });

  it("writes only dirty shards incrementally and lists old generations for removal", async () => {
    const state = makeTree(300);
    const faulty = createFaultyStorage();
    const full = outlineStateV4Snapshot(state, { epoch: 1, journalSeqIncluded: 0, savedAt: 5 });
    await applySnapshot(faulty, full);

    const next: OutlineState = {
      ...state,
      nodes: {
        ...state.nodes,
        "tab:7": { ...state.nodes["tab:7"]!, title: "Renamed" }
      }
    };
    const dirtyShard = stateV4ShardIndexForNodeId("tab:7");
    const incremental = outlineStateV4Snapshot(next, {
      epoch: 1,
      journalSeqIncluded: 9,
      savedAt: 6,
      previous: { manifest: full.manifest, slot: full.slot },
      dirtyShardIndexes: new Set([dirtyShard])
    });

    // Exactly one shard key plus the inactive manifest slot.
    expect(Object.keys(incremental.setItems)).toHaveLength(2);
    expect(incremental.setItems[stateV4NodeShardKey(dirtyShard, 2)]).toBeDefined();
    expect(incremental.slot).toBe("b");
    expect(incremental.manifest.generation).toBe(2);
    expect(incremental.manifest.shardGenerations[dirtyShard]).toBe(2);
    expect(
      incremental.manifest.shardGenerations.filter((generation) => generation === 1)
    ).toHaveLength(STATE_V4_NODE_SHARD_COUNT - 1);
    // The gen-1 shard is still referenced by the manifest left in slot a (the R1 fallback),
    // so nothing is collectable yet.
    expect(incremental.removeKeysAfterCommit).toEqual([]);

    await applySnapshot(faulty, incremental);
    const loaded = await loadStateV4(faulty.api);

    expect(loaded?.recovery).toBe("r0");
    expect(loaded?.slot).toBe("b");
    expect(loaded?.journalSeqIncluded).toBe(9);
    expect(loaded?.state).toEqual(next);
  });

  it("keeps the fallback slot loadable across a torn compaction and collects a generation only once unreferenced", async () => {
    const state = makeTree(60);
    const faulty = createFaultyStorage();
    const full = outlineStateV4Snapshot(state, { epoch: 1, journalSeqIncluded: 0, savedAt: 1 });
    await applySnapshot(faulty, full);

    const second: OutlineState = {
      ...state,
      nodes: { ...state.nodes, "tab:5": { ...state.nodes["tab:5"]!, title: "Second" } }
    };
    const dirtyShard = stateV4ShardIndexForNodeId("tab:5");
    const incremental = outlineStateV4Snapshot(second, {
      epoch: 1,
      journalSeqIncluded: 4,
      savedAt: 2,
      previous: { manifest: full.manifest, slot: full.slot },
      dirtyShardIndexes: new Set([dirtyShard])
    });
    await applySnapshot(faulty, incremental);

    const third: OutlineState = {
      ...second,
      nodes: { ...second.nodes, "tab:5": { ...second.nodes["tab:5"]!, title: "Third" } }
    };
    const thirdSnapshot = outlineStateV4Snapshot(third, {
      epoch: 1,
      journalSeqIncluded: 8,
      savedAt: 3,
      previous: { manifest: incremental.manifest, slot: incremental.slot },
      // This write evicts the gen-1 manifest from slot a, so gen-1's superseded shard
      // becomes collectable exactly now.
      collect: full.manifest,
      dirtyShardIndexes: new Set([dirtyShard])
    });
    expect(thirdSnapshot.slot).toBe("a");
    expect(thirdSnapshot.removeKeysAfterCommit).toEqual([stateV4NodeShardKey(dirtyShard, 1)]);

    // Crash mid-write of the third compaction: the manifest lands, its shard does not, and
    // the GC (modeling the post-resolve remove) still runs. The fallback slot b (gen 2)
    // must stay fully loadable -- the collected key belonged only to the evicted gen 1.
    const tornItems: Record<string, unknown> = {
      [thirdSnapshot.manifestKey]: thirdSnapshot.setItems[thirdSnapshot.manifestKey]
    };
    faulty.tearNextSet(1);
    await faulty.api.storage.local.set({ ...tornItems, ...thirdSnapshot.setItems });
    await faulty.api.storage.local.remove(thirdSnapshot.removeKeysAfterCommit);

    const loaded = await loadStateV4(faulty.api);

    expect(loaded?.recovery).toBe("r1");
    expect(loaded?.slot).toBe("b");
    expect(loaded?.journalSeqIncluded).toBe(4);
    expect(loaded?.state).toEqual(second);
  });

  it("falls back to the other manifest slot when the newest snapshot is torn (R1)", async () => {
    const state = makeTree(50);
    const faulty = createFaultyStorage();
    const full = outlineStateV4Snapshot(state, { epoch: 1, journalSeqIncluded: 3, savedAt: 5 });
    await applySnapshot(faulty, full);

    const next: OutlineState = {
      ...state,
      nodes: { ...state.nodes, "tab:1": { ...state.nodes["tab:1"]!, title: "Renamed" } }
    };
    const dirtyShard = stateV4ShardIndexForNodeId("tab:1");
    const incremental = outlineStateV4Snapshot(next, {
      epoch: 1,
      journalSeqIncluded: 8,
      savedAt: 6,
      previous: { manifest: full.manifest, slot: full.slot },
      dirtyShardIndexes: new Set([dirtyShard])
    });

    // Torn compaction: the manifest lands but the new-generation shard does not.
    const tornItems: Record<string, unknown> = {
      [incremental.manifestKey]: incremental.setItems[incremental.manifestKey]
    };
    faulty.tearNextSet(1);
    await faulty.api.storage.local.set({ ...tornItems, ...incremental.setItems });

    const loaded = await loadStateV4(faulty.api);

    expect(loaded?.recovery).toBe("r1");
    expect(loaded?.slot).toBe("a");
    // The older manifest's journalSeqIncluded governs replay, so the journaled rename is
    // recovered by the caller's replay rather than lost with the torn shard.
    expect(loaded?.journalSeqIncluded).toBe(3);
    expect(loaded?.state).toEqual(state);
  });

  it("salvages shards at their highest readable generation when both manifests are corrupt (R2)", async () => {
    const state = makeTree(60);
    const faulty = createFaultyStorage();
    const full = outlineStateV4Snapshot(state, { epoch: 1, journalSeqIncluded: 4, savedAt: 5 });
    await applySnapshot(faulty, full);

    await faulty.api.storage.local.set({
      [STATE_V4_MANIFEST_A_KEY]: { not: "a manifest" },
      [STATE_V4_MANIFEST_B_KEY]: 42
    });

    const loaded = await loadStateV4(faulty.api);

    expect(loaded?.recovery).toBe("r2");
    // No parseable manifest -> replay the whole journal (idempotent overwrite).
    expect(loaded?.journalSeqIncluded).toBe(0);
    expect(Object.keys(loaded!.state.nodes)).toHaveLength(61);
    // Roots are re-derived by structural repair.
    expect(loaded?.state.rootIds).toEqual(["window:10"]);
    expect(loaded?.state.nodes["tab:33"]?.parentId).toBe("window:10");
  });

  it("returns undefined when no v4 keys exist at all", async () => {
    const faulty = createFaultyStorage({ "outlineState:v3:manifest": { version: 3 } });

    await expect(loadStateV4(faulty.api)).resolves.toBeUndefined();
    await expect(hasAnyStateV4Keys(faulty.api)).resolves.toBe(false);
  });

  it("rejects a manifest whose shard generations do not match the stored shards", async () => {
    const state = makeTree(40);
    const faulty = createFaultyStorage();
    const full = outlineStateV4Snapshot(state, { epoch: 1, journalSeqIncluded: 0, savedAt: 5 });
    await applySnapshot(faulty, full);

    // Claim shard 0 was written at generation 9 (it was not): R0 fails, no other slot,
    // salvage still recovers every node from the generation-1 shards.
    const forged: StateV4Manifest = {
      ...full.manifest,
      generation: 9,
      shardGenerations: full.manifest.shardGenerations.map((generation, index) =>
        index === 0 ? 9 : generation
      )
    };
    await faulty.api.storage.local.set({ [STATE_V4_MANIFEST_A_KEY]: forged });

    const loaded = await loadStateV4(faulty.api);

    expect(loaded?.recovery).toBe("r2");
    expect(Object.keys(loaded!.state.nodes)).toHaveLength(41);
  });

  it(
    "keeps generated compactions, journal replays, crashes, and restarts loadable as the exact model state",
    async () => {
      // The storage-fault soak lane (docs/storage-rearchitecture 03-WORKFLOW-FIXES W-4.2):
      // pnpm test:soak scales this to more seeds and longer runs via GENERATED_TRACE_* env.
      const config = generatedTraceConfig({
        defaultSeedCount: 4,
        defaultSteps: 60,
        soakSeedCount: 16,
        soakSteps: 400
      });
      for (const seed of config.seeds) {
        const random = seededRandom(seed);
        const faulty = createFaultyStorage();
        const journal = createOutlineJournal(faulty.api.storage.local, {
          epoch: 1,
          now: () => 1000
        });
        await journal.init();

        // In-memory model of what a correct store must reproduce after any restart.
        // Bound the size by the seed (mod 16) so any random soak base seed yields a
        // small tree; raw `seed * 3` overflowed JS max array length for large seeds.
        let model = makeTree(20 + (seed % 16) * 3);
        let entries: OutlineJournalEntry[] = [];
        let nextNodeNumber = 1000;
        let rootWindowNumber = 100;
        const journalKinds: OutlineJournalEntryKind[] = [
          "command",
          "runtimeEvent",
          "historyReplay",
          "recovery"
        ];
        let seq = 0;
        let active: { manifest: StateV4Manifest; slot: StateV4ManifestSlot } | undefined;
        let evictable: StateV4Manifest | undefined;
        let _includedSeq = 0;
        let dirty = new Set<number>();
        let fullCompactionNeeded = true;

        const journalAppend = async (
          delta: {
            updatedNodes?: OutlineNode[];
            deletedNodeIds?: NodeId[];
            rootIds?: NodeId[];
          },
          kind: OutlineJournalEntryKind = "command"
        ): Promise<void> => {
          seq += 1;
          const entry: OutlineJournalEntry = { seq, epoch: 1, at: 1000, kind, delta };
          await journal.append([{ kind, delta }]);
          entries.push(entry);
          for (const node of delta.updatedNodes ?? []) {
            dirty.add(stateV4ShardIndexForNodeId(node.id));
          }
          for (const id of delta.deletedNodeIds ?? []) {
            dirty.add(stateV4ShardIndexForNodeId(id));
          }
        };

        const compact = async (mode: "ok" | "fail" | "crash"): Promise<"survived" | "crashed"> => {
          const snapshot = outlineStateV4Snapshot(model, {
            epoch: 1,
            journalSeqIncluded: seq,
            savedAt: seq,
            ...(active && !fullCompactionNeeded
              ? { previous: active, dirtyShardIndexes: dirty }
              : active
                ? { previous: active }
                : {}),
            ...(active && evictable ? { collect: evictable } : {})
          });
          if (mode === "fail") {
            faulty.failNextSet();
            await expect(faulty.api.storage.local.set(snapshot.setItems)).rejects.toThrow();
            // Observed failure: keep the old manifest and force a full rewrite next time.
            fullCompactionNeeded = true;
            return "survived";
          }
          if (mode === "crash") {
            // Torn-but-resolved write, then the post-commit GC runs (as production does on any
            // resolved set), then process death. The GC must never delete keys the surviving
            // fallback manifest still references.
            faulty.tearNextSet(1 + Math.floor(random() * Object.keys(snapshot.setItems).length));
            await faulty.api.storage.local.set(snapshot.setItems);
            if (snapshot.removeKeysAfterCommit.length > 0) {
              await faulty.api.storage.local.remove(snapshot.removeKeysAfterCommit);
            }
            return "crashed";
          }
          await applySnapshot(faulty, snapshot);
          await journal.prune(seq);
          entries = entries.filter((entry) => entry.seq > seq);
          evictable = active?.manifest;
          active = { manifest: snapshot.manifest, slot: snapshot.slot };
          _includedSeq = seq;
          dirty = new Set();
          fullCompactionNeeded = false;
          return "survived";
        };

        const restart = async (): Promise<void> => {
          const loaded = await loadStateV4(faulty.api);
          expect(loaded, `seed ${seed}: store must load after restart`).toBeDefined();
          const reopened = createOutlineJournal(faulty.api.storage.local, {
            epoch: 2,
            now: () => 2000
          });
          const init = await reopened.init();
          const replayable = init.entries.filter((entry) => entry.seq > loaded!.journalSeqIncluded);
          const recovered = replayJournal(loaded!.state, replayable);
          expect(recovered, `seed ${seed}: restart must reproduce the model`).toEqual(model);
          // Continue the run from the recovered position.
          active = { manifest: loaded!.manifest, slot: loaded!.slot };
          evictable = undefined;
          _includedSeq = loaded!.journalSeqIncluded;
          seq = Math.max(seq, init.headSeq);
          fullCompactionNeeded = true;
          dirty = new Set();
        };

        await compact("ok");

        for (let step = 0; step < config.steps; step += 1) {
          const roll = random();
          if (roll < 0.45) {
            // Mutate the model and journal the delta. Mix single-node edits with multi-shard bulk
            // edits (a whole window subtree at once) and root-set churn so the incremental
            // compaction path sees large dirty sets and rootIds changes, and rotate the journal
            // entry kind so all four kinds round-trip through storage + replay.
            const w10 = model.nodes["window:10"]!;
            const action = random();
            const kind = journalKinds[Math.floor(random() * journalKinds.length)]!;
            const addUnderPrimary = async (): Promise<void> => {
              nextNodeNumber += 1;
              const id = `tab:${nextNodeNumber}`;
              const node = makeNode(id, {
                parentId: "window:10",
                url: `https://example.test/${id}`
              });
              const windowNode = { ...w10, childIds: [...w10.childIds, id] };
              model = { ...model, nodes: { ...model.nodes, [id]: node, "window:10": windowNode } };
              await journalAppend({ updatedNodes: [node, windowNode] }, kind);
            };
            if (action < 0.3) {
              await addUnderPrimary();
            } else if (action < 0.45 && w10.childIds.length > 0) {
              // Single rename of a window:10 child (one dirty shard).
              const id = w10.childIds[Math.floor(random() * w10.childIds.length)]!;
              const renamed = { ...model.nodes[id]!, title: `Renamed ${step}` };
              model = { ...model, nodes: { ...model.nodes, [id]: renamed } };
              await journalAppend({ updatedNodes: [renamed] }, kind);
            } else if (action < 0.6 && w10.childIds.length > 0) {
              // Single delete of a window:10 child.
              const id = w10.childIds[Math.floor(random() * w10.childIds.length)]!;
              const windowNode = {
                ...w10,
                childIds: w10.childIds.filter((childId) => childId !== id)
              };
              const nodes: Record<NodeId, OutlineNode> = {
                ...model.nodes,
                "window:10": windowNode
              };
              delete nodes[id];
              model = { ...model, nodes };
              await journalAppend({ deletedNodeIds: [id], updatedNodes: [windowNode] }, kind);
            } else if (action < 0.85) {
              // Bulk add: a new root window with several tabs in ONE delta -> the dirty set spans
              // many shards and rootIds grows (multi-shard incremental compaction + root churn).
              rootWindowNumber += 1;
              const windowId = `window:${rootWindowNumber}`;
              const childCount = 4 + Math.floor(random() * 12);
              const children = Array.from({ length: childCount }, () => {
                nextNodeNumber += 1;
                return makeNode(`tab:${nextNodeNumber}`, {
                  parentId: windowId,
                  url: `https://example.test/tab:${nextNodeNumber}`
                });
              });
              const windowNode = makeNode(windowId, {
                kind: "window",
                childIds: children.map((child) => child.id)
              });
              const rootIds = [...model.rootIds, windowId];
              model = {
                ...model,
                rootIds,
                nodes: {
                  ...model.nodes,
                  [windowId]: windowNode,
                  ...Object.fromEntries(children.map((child) => [child.id, child]))
                }
              };
              await journalAppend({ updatedNodes: [windowNode, ...children], rootIds }, kind);
            } else {
              const extraRoots = model.rootIds.filter((id) => id !== "window:10");
              if (extraRoots.length === 0) {
                await addUnderPrimary();
              } else if (random() < 0.6) {
                // Bulk delete: remove a root window and all its tabs in ONE delta (multi-shard
                // delete + rootIds shrinks).
                const windowId = extraRoots[Math.floor(random() * extraRoots.length)]!;
                const subtreeIds = [windowId, ...model.nodes[windowId]!.childIds];
                const rootIds = model.rootIds.filter((id) => id !== windowId);
                const nodes: Record<NodeId, OutlineNode> = { ...model.nodes };
                for (const id of subtreeIds) {
                  delete nodes[id];
                }
                model = { ...model, rootIds, nodes };
                await journalAppend({ deletedNodeIds: subtreeIds, rootIds }, kind);
              } else {
                // Pure root reorder: rootIds changes with NO node delta -> the next compaction bumps
                // a generation and rewrites only the manifest's rootIds (no dirty shards).
                const rootIds = [...model.rootIds].reverse();
                model = { ...model, rootIds };
                await journalAppend({ rootIds }, kind);
              }
            }
          } else if (roll < 0.65) {
            await compact("ok");
          } else if (roll < 0.75) {
            await compact("fail");
          } else if (roll < 0.85) {
            const outcome = await compact("crash");
            if (outcome === "crashed") {
              await restart();
            }
          } else {
            await restart();
          }
        }

        await restart();
      }
    },
    generatedTraceTimeoutMs(30000, 300000)
  );

  it("sweeps orphaned shard generations the GC never collected, preserving both stored slots", async () => {
    const state = makeTree(300);
    const faulty = createFaultyStorage();
    const full = outlineStateV4Snapshot(state, { epoch: 1, journalSeqIncluded: 0, savedAt: 5 });
    await applySnapshot(faulty, full);
    const next: OutlineState = {
      ...state,
      nodes: { ...state.nodes, "tab:7": { ...state.nodes["tab:7"]!, title: "Renamed" } }
    };
    const incremental = outlineStateV4Snapshot(next, {
      epoch: 1,
      journalSeqIncluded: 9,
      savedAt: 6,
      previous: { manifest: full.manifest, slot: full.slot },
      dirtyShardIndexes: new Set([stateV4ShardIndexForNodeId("tab:7")])
    });
    await applySnapshot(faulty, incremental);

    // Simulate the leak: orphaned shard keys from old generations no stored manifest references.
    const orphanKeys = [
      stateV4NodeShardKey(0, 90),
      stateV4NodeShardKey(0, 91),
      stateV4NodeShardKey(5, 92),
      stateV4NodeShardKey(31, 93)
    ];
    await faulty.api.storage.local.set(
      Object.fromEntries(
        orphanKeys.map((key) => [key, { version: 4, shardIndex: 0, generation: 90, nodes: [] }])
      )
    );

    const result = await sweepOrphanedV4Shards(faulty.api);

    expect(result.removed).toBe(orphanKeys.length);
    const after = await faulty.api.storage.local.get(null);
    expect(orphanKeys.some((key) => key in after)).toBe(false);

    // The exact model state still loads, and the R1 fallback slot (a, gen 1) stays fully present.
    const loaded = await loadStateV4(faulty.api);
    expect(loaded?.recovery).toBe("r0");
    expect(loaded?.state).toEqual(next);
    const aManifest = (await faulty.api.storage.local.get(STATE_V4_MANIFEST_A_KEY))[
      STATE_V4_MANIFEST_A_KEY
    ] as StateV4Manifest;
    for (let shardIndex = 0; shardIndex < STATE_V4_NODE_SHARD_COUNT; shardIndex += 1) {
      expect(
        stateV4NodeShardKey(shardIndex, aManifest.shardGenerations[shardIndex]!) in after
      ).toBe(true);
    }
  });

  it("removes nothing when every node-shard key is still referenced", async () => {
    const state = makeTree(50);
    const faulty = createFaultyStorage();
    await applySnapshot(
      faulty,
      outlineStateV4Snapshot(state, { epoch: 1, journalSeqIncluded: 0, savedAt: 5 })
    );

    const result = await sweepOrphanedV4Shards(faulty.api);

    expect(result.removed).toBe(0);
    expect((await loadStateV4(faulty.api))?.state).toEqual(state);
  });

  it("re-shards a store written at a different shard count, preserving the exact state", async () => {
    const state = makeTree(300);
    const faulty = createFaultyStorage();
    const oldCount = 32;
    expect(oldCount).not.toBe(STATE_V4_NODE_SHARD_COUNT);

    await faulty.api.storage.local.set(oldCountStoreItems(state, oldCount, 1, "a").items);

    // Loads fine at the old shard count (load reads whatever the manifest lists).
    const loaded = await loadStateV4(faulty.api);
    expect(loaded?.recovery).toBe("r0");
    expect(loaded?.manifest.shardGenerations).toHaveLength(oldCount);
    expect(loaded?.state).toEqual(state);

    // A full compaction (what the coordinator forces on a shard-count mismatch) re-shards to the
    // current count and reloads to the exact state.
    const snapshot = outlineStateV4Snapshot(loaded!.state, {
      epoch: 0,
      journalSeqIncluded: 0,
      savedAt: 2,
      previous: { manifest: loaded!.manifest, slot: loaded!.slot }
    });
    expect(snapshot.manifest.shardGenerations).toHaveLength(STATE_V4_NODE_SHARD_COUNT);
    await applySnapshot(faulty, snapshot);

    const reloaded = await loadStateV4(faulty.api);
    expect(reloaded?.recovery).toBe("r0");
    expect(reloaded?.manifest.shardGenerations).toHaveLength(STATE_V4_NODE_SHARD_COUNT);
    expect(reloaded?.state).toEqual(state);
  });

  it("falls back to the intact old-count slot when the first re-shard compaction is torn", async () => {
    const state = makeTree(120);
    const faulty = createFaultyStorage();
    const oldCount = 32;
    expect(oldCount).not.toBe(STATE_V4_NODE_SHARD_COUNT);

    // Pre-upgrade store: slot a = gen 10 (current, intact), slot b = gen 9 (the R1 fallback).
    const slotA = oldCountStoreItems(state, oldCount, 10, "a");
    const slotB = oldCountStoreItems(state, oldCount, 9, "b");
    await faulty.api.storage.local.set({ ...slotB.items, ...slotA.items });

    // The coordinator forces a full re-shard compaction on the count mismatch: previous = the
    // current slot a (gen 10), collect = the fallback it evicts (slot b gen 9). The new 256-shard
    // write targets slot b.
    const reshard = outlineStateV4Snapshot(state, {
      epoch: 0,
      journalSeqIncluded: 0,
      savedAt: 11,
      previous: { manifest: slotA.manifest, slot: "a" },
      collect: slotB.manifest
    });
    expect(reshard.slot).toBe("b");
    expect(reshard.manifest.shardGenerations).toHaveLength(STATE_V4_NODE_SHARD_COUNT);
    // It must never collect a surviving slot-a (gen 10) shard key -- that is the R1 fallback.
    for (let shardIndex = 0; shardIndex < oldCount; shardIndex += 1) {
      expect(reshard.removeKeysAfterCommit).not.toContain(stateV4NodeShardKey(shardIndex, 10));
    }

    // Tear the write: only the new manifest lands; its 256 shards do not. The GC of the evicted
    // gen-9 keys still runs (models the post-resolve remove).
    await faulty.api.storage.local.set({
      [reshard.manifestKey]: reshard.setItems[reshard.manifestKey]
    });
    if (reshard.removeKeysAfterCommit.length > 0) {
      await faulty.api.storage.local.remove(reshard.removeKeysAfterCommit);
    }

    // The torn 256-shard slot is rejected; the intact 32-shard slot a loads at r1, state exact.
    const loaded = await loadStateV4(faulty.api);
    expect(loaded?.recovery).toBe("r1");
    expect(loaded?.slot).toBe("a");
    expect(loaded?.manifest.shardGenerations).toHaveLength(oldCount);
    expect(loaded?.state).toEqual(state);
  });

  it("never sweeps blind when no manifest is parseable", async () => {
    const faulty = createFaultyStorage();
    const orphan = stateV4NodeShardKey(0, 1);
    await faulty.api.storage.local.set({
      [orphan]: { version: 4, shardIndex: 0, generation: 1, nodes: [] }
    });

    const result = await sweepOrphanedV4Shards(faulty.api);

    expect(result.removed).toBe(0);
    expect(orphan in (await faulty.api.storage.local.get(null))).toBe(true);
  });
});

function seededRandom(seed: number): () => number {
  // Coerce to uint32 and multiply with Math.imul so large soak seeds cannot
  // overflow MAX_SAFE_INTEGER (raw `seed * 2654435761` lost precision past ~3.4M).
  // `|| 1` keeps the Park-Miller state out of its 0 fixed point.
  let value = (Math.imul(seed >>> 0, 2654435761) >>> 0) % 2147483647 || 1;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}
