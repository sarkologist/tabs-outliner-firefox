import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import { cloneOutlineNode } from "../model/outline.js";
import { normalizeLoadedOutlineStructure, outlineNodeShardIndex, type StateStructureRepair } from "./storage.js";

// v4 snapshot store: STATE_V4_NODE_SHARD_COUNT (256) generation-stamped node shards (childIds inline -- no order pages)
// plus double-buffered manifests. Consistency is verifiable from storage alone: a shard is
// valid for a manifest only when its embedded generation matches the manifest's
// shardGenerations entry, so a torn compaction can never be half-trusted. See
// docs/storage-rearchitecture/01-TARGET-ARCHITECTURE.md sections 2-4.

export const STATE_V4_MANIFEST_A_KEY = "outline:v4:manifest:a";
export const STATE_V4_MANIFEST_B_KEY = "outline:v4:manifest:b";
export const STATE_V4_NODE_SHARD_PREFIX = "outline:v4:nodes:";
// Node count per shard ≈ total / SHARD_COUNT. A save rewrites whole dirty shards, so a single-node
// change costs one shard's worth of bytes. 256 keeps that ~100-140 nodes (tens of KB) on a 25k-node
// store instead of ~800 nodes (~1 MB at 32), cutting per-save storage cost ~8x on the interaction
// path. A store written at a different count is re-sharded by a one-time full compaction on the
// first save (the coordinator forces it when the loaded manifest's shard count differs).
export const STATE_V4_NODE_SHARD_COUNT = 256;
// Shard counts a stored manifest may legitimately have used before the current one. A store at a
// legacy count still loads cleanly (r0) -- the loader reads whatever shard keys the manifest lists
// -- and the coordinator re-shards it to the current count on the first save. Without this, a
// count change would reject every existing manifest and force the degraded r2 salvage path.
export const STATE_V4_LEGACY_SHARD_COUNTS: ReadonlySet<number> = new Set([32]);
export const STATE_V4_MIGRATION_BACKUP_KEY = "outline:v4:migrationBackup";
// Tiny side record for the multi-MB backup key: lets startup check migration evidence and
// the backup's age without deserializing the backup itself.
export const STATE_V4_MIGRATION_BACKUP_META_KEY = "outline:v4:migrationBackupMeta";

export type StateV4ManifestSlot = "a" | "b";

export type StateV4Manifest = {
  version: 4;
  generation: number;
  epoch: number;
  // All journal entries with seq <= this are reflected in the shards this manifest references.
  journalSeqIncluded: number;
  rootIds: NodeId[];
  nodeCount: number;
  closedCount: number;
  // One entry per shard index: the generation whose key last wrote that shard.
  shardGenerations: number[];
  savedAt: number;
};

type StateV4NodeShard = {
  version: 4;
  shardIndex: number;
  generation: number;
  nodes: OutlineNode[];
};

export type OutlineStateV4Snapshot = {
  setItems: Record<string, unknown>;
  // Shard keys that NEITHER stored manifest references once this write commits: keys owned
  // solely by the manifest this write evicts from its slot (options.collect). Keys the
  // still-stored other-slot manifest references are never listed, so the R1 fallback slot
  // stays loadable even if this write turns out to be torn (I-5: an old generation remains
  // loadable until the manifest that supersedes it is durably referenced). A failed remove
  // leaves harmless unreferenced garbage.
  removeKeysAfterCommit: string[];
  manifest: StateV4Manifest;
  manifestKey: string;
  slot: StateV4ManifestSlot;
};

export type LoadStateV4Result = {
  state: OutlineState;
  manifest: StateV4Manifest;
  slot: StateV4ManifestSlot;
  // r0: highest-generation manifest verified clean. r1: it failed shard verification and the
  // other slot loaded. r2: both manifests unusable; shards salvaged at their highest
  // readable generation and structurally repaired.
  recovery: "r0" | "r1" | "r2";
  repair?: StateStructureRepair;
  journalSeqIncluded: number;
  // The other stored slot's manifest, when it is a valid v4 manifest. The next save evicts this
  // slot, so seeding it as the GC baseline (previousV4Snapshot) lets the first post-startup save
  // collect the shards it supersedes instead of leaking them (the per-startup shard-GC gap).
  fallbackManifest?: StateV4Manifest;
  fallbackSlot?: StateV4ManifestSlot;
};

export function stateV4ShardIndexForNodeId(nodeId: NodeId): number {
  return outlineNodeShardIndex(nodeId, STATE_V4_NODE_SHARD_COUNT);
}

export function stateV4NodeShardKey(shardIndex: number, generation: number): string {
  return `${STATE_V4_NODE_SHARD_PREFIX}${shardIndex.toString(16).padStart(2, "0")}:${generation}`;
}

function manifestKeyForSlot(slot: StateV4ManifestSlot): string {
  return slot === "a" ? STATE_V4_MANIFEST_A_KEY : STATE_V4_MANIFEST_B_KEY;
}

export function outlineStateV4Snapshot(
  state: OutlineState,
  options: {
    epoch: number;
    journalSeqIncluded: number;
    savedAt?: number;
    // The currently-active manifest and the slot it occupies. Absent -> first full write at
    // generation 1 into slot "a".
    previous?: { manifest: StateV4Manifest; slot: StateV4ManifestSlot };
    // The manifest currently stored in the slot this write targets (the one written two
    // compactions ago). Once this write commits, that manifest is gone, so the shard keys
    // only it referenced become collectable. Absent -> nothing is collected this round.
    collect?: StateV4Manifest;
    // Shards to rewrite at the new generation. Absent -> all shards (full compaction).
    dirtyShardIndexes?: ReadonlySet<number>;
  }
): OutlineStateV4Snapshot {
  const previous = options.previous;
  const generation = (previous?.manifest.generation ?? 0) + 1;
  const dirty = previous && options.dirtyShardIndexes
    ? options.dirtyShardIndexes
    : undefined;

  const nodesByShard = new Map<number, OutlineNode[]>();
  let nodeCount = 0;
  let closedCount = 0;
  for (const nodeId in state.nodes) {
    const node = state.nodes[nodeId];
    if (!node) {
      continue;
    }
    nodeCount += 1;
    if (node.status === "closed") {
      closedCount += 1;
    }
    const shardIndex = stateV4ShardIndexForNodeId(node.id);
    if (dirty && !dirty.has(shardIndex)) {
      continue;
    }
    const bucket = nodesByShard.get(shardIndex);
    if (bucket) {
      bucket.push(node);
    } else {
      nodesByShard.set(shardIndex, [node]);
    }
  }

  const shardGenerations: number[] = [];
  const setItems: Record<string, unknown> = {};
  const removeKeysAfterCommit: string[] = [];
  for (let shardIndex = 0; shardIndex < STATE_V4_NODE_SHARD_COUNT; shardIndex += 1) {
    if (dirty && !dirty.has(shardIndex)) {
      shardGenerations.push(previous!.manifest.shardGenerations[shardIndex] ?? 0);
      continue;
    }
    shardGenerations.push(generation);
    const nodes = (nodesByShard.get(shardIndex) ?? [])
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(cloneOutlineNode);
    const shard: StateV4NodeShard = { version: 4, shardIndex, generation, nodes };
    setItems[stateV4NodeShardKey(shardIndex, generation)] = shard;
  }

  // Collect only keys that no stored manifest will reference after this commit: a key from
  // the evicted manifest (options.collect) is removable iff the surviving other-slot
  // manifest (options.previous) and this new manifest both moved that shard to a different
  // generation. Removing the previous manifest's own keys here would destroy the R1
  // fallback the moment a torn write resolves.
  if (options.collect && previous) {
    for (let shardIndex = 0; shardIndex < STATE_V4_NODE_SHARD_COUNT; shardIndex += 1) {
      const evictedGeneration = options.collect.shardGenerations[shardIndex];
      if (
        evictedGeneration !== undefined &&
        evictedGeneration !== previous.manifest.shardGenerations[shardIndex] &&
        evictedGeneration !== shardGenerations[shardIndex]
      ) {
        removeKeysAfterCommit.push(stateV4NodeShardKey(shardIndex, evictedGeneration));
      }
    }
  }

  const manifest: StateV4Manifest = {
    version: 4,
    generation,
    epoch: options.epoch,
    journalSeqIncluded: options.journalSeqIncluded,
    rootIds: [...state.rootIds],
    nodeCount,
    closedCount,
    shardGenerations,
    savedAt: options.savedAt ?? Date.now()
  };
  const slot: StateV4ManifestSlot = previous ? (previous.slot === "a" ? "b" : "a") : "a";
  const manifestKey = manifestKeyForSlot(slot);
  setItems[manifestKey] = manifest;

  return { setItems, removeKeysAfterCommit, manifest, manifestKey, slot };
}

export async function loadStateV4(api: WebExtensionBrowser): Promise<LoadStateV4Result | undefined> {
  const stored = await api.storage.local.get([STATE_V4_MANIFEST_A_KEY, STATE_V4_MANIFEST_B_KEY]);
  const candidates: Array<{ manifest: StateV4Manifest; slot: StateV4ManifestSlot }> = [];
  const manifestA = stored[STATE_V4_MANIFEST_A_KEY];
  const manifestB = stored[STATE_V4_MANIFEST_B_KEY];
  if (isStateV4Manifest(manifestA)) {
    candidates.push({ manifest: manifestA, slot: "a" });
  }
  if (isStateV4Manifest(manifestB)) {
    candidates.push({ manifest: manifestB, slot: "b" });
  }
  candidates.sort((left, right) => right.manifest.generation - left.manifest.generation);

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const loaded = await loadStateV4FromManifest(candidate.manifest, api);
    if (loaded) {
      const fallback = candidates.find((other) => other.slot !== candidate.slot);
      return {
        state: loaded.state,
        manifest: candidate.manifest,
        slot: candidate.slot,
        recovery: index === 0 ? "r0" : "r1",
        ...(loaded.repair ? { repair: loaded.repair } : {}),
        journalSeqIncluded: candidate.manifest.journalSeqIncluded,
        ...(fallback ? { fallbackManifest: fallback.manifest, fallbackSlot: fallback.slot } : {})
      };
    }
  }

  // R2 salvage: every readable shard at its highest readable generation, structurally
  // repaired. journalSeqIncluded falls back to the most conservative (lowest) parseable
  // value so the caller replays as much journal as possible; replay is an idempotent
  // overwrite, so replaying already-folded entries is harmless.
  const salvage = await salvageStateV4(api);
  if (!salvage) {
    return undefined;
  }
  const journalSeqIncluded = candidates.length > 0
    ? Math.min(...candidates.map((candidate) => candidate.manifest.journalSeqIncluded))
    : 0;
  const repair = normalizeLoadedOutlineStructure(salvage.state, "v4");
  return {
    state: salvage.state,
    manifest: salvage.manifest,
    slot: "a",
    recovery: "r2",
    ...(repair ? { repair } : {}),
    journalSeqIncluded
  };
}

const STATE_V4_ORPHAN_SWEEP_REMOVE_CHUNK = 256;

export type SweepOrphanedV4ShardsResult = {
  removed: number;
  referenced: number;
  scannedShardKeys: number;
};

// Remove node-shard keys that NO stored manifest references. v4 keeps the current generation plus
// the other-slot (R1 fallback) generation; a key from any older generation is a superseded copy of
// the tree, not data, so deleting it loses nothing. We reference the shard keys of BOTH stored
// manifests (slot a + slot b), so both slots stay fully loadable -- only keys no slot points to are
// removed. With no parseable manifest we cannot tell live from orphan, so we never sweep blind.
//
// The whole-store read mirrors the storage census and is the one expensive step; it is meant to run
// off the startup critical path (deferred, fire-and-forget). Once the backlog is cleared and the
// per-startup GC gap is closed, the store is small and this is cheap.
export async function sweepOrphanedV4Shards(api: WebExtensionBrowser): Promise<SweepOrphanedV4ShardsResult> {
  const manifestStore = await api.storage.local.get([STATE_V4_MANIFEST_A_KEY, STATE_V4_MANIFEST_B_KEY]);
  const referenced = new Set<string>();
  for (const slotKey of [STATE_V4_MANIFEST_A_KEY, STATE_V4_MANIFEST_B_KEY]) {
    const manifest = manifestStore[slotKey];
    if (isStateV4Manifest(manifest)) {
      manifest.shardGenerations.forEach((generation, shardIndex) => {
        referenced.add(stateV4NodeShardKey(shardIndex, generation));
      });
    }
  }
  if (referenced.size === 0) {
    return { removed: 0, referenced: 0, scannedShardKeys: 0 };
  }

  const everything = await api.storage.local.get(null);
  const orphanKeys: string[] = [];
  let scannedShardKeys = 0;
  for (const key of Object.keys(everything)) {
    if (!key.startsWith(STATE_V4_NODE_SHARD_PREFIX)) {
      continue;
    }
    scannedShardKeys += 1;
    if (!referenced.has(key)) {
      orphanKeys.push(key);
    }
  }

  for (let index = 0; index < orphanKeys.length; index += STATE_V4_ORPHAN_SWEEP_REMOVE_CHUNK) {
    await api.storage.local.remove(orphanKeys.slice(index, index + STATE_V4_ORPHAN_SWEEP_REMOVE_CHUNK));
  }
  return { removed: orphanKeys.length, referenced: referenced.size, scannedShardKeys };
}

async function loadStateV4FromManifest(
  manifest: StateV4Manifest,
  api: WebExtensionBrowser
): Promise<{ state: OutlineState; repair?: StateStructureRepair } | undefined> {
  const shardKeys = manifest.shardGenerations.map((generation, shardIndex) =>
    stateV4NodeShardKey(shardIndex, generation)
  );
  const shardItems = await api.storage.local.get(shardKeys);
  const nodes: OutlineState["nodes"] = {};
  for (let shardIndex = 0; shardIndex < shardKeys.length; shardIndex += 1) {
    const shard = shardItems[shardKeys[shardIndex]!];
    if (
      !isStateV4NodeShard(shard) ||
      shard.shardIndex !== shardIndex ||
      shard.generation !== manifest.shardGenerations[shardIndex]
    ) {
      // Generation or shape mismatch: this manifest's snapshot is torn -- reject it whole
      // and let the ladder try the other slot (its keys are untouched by construction).
      return undefined;
    }
    for (const node of shard.nodes) {
      nodes[node.id] = cloneOutlineNode(node);
    }
  }

  const state: OutlineState = {
    version: 1,
    rootIds: [...manifest.rootIds],
    nodes
  };
  const repair = normalizeLoadedOutlineStructure(state, "v4");
  return { state, ...(repair ? { repair } : {}) };
}

async function salvageStateV4(
  api: WebExtensionBrowser
): Promise<{ state: OutlineState; manifest: StateV4Manifest } | undefined> {
  const everything = await api.storage.local.get(null);
  const bestByShard = new Map<number, StateV4NodeShard>();
  for (const key of Object.keys(everything)) {
    if (!key.startsWith(STATE_V4_NODE_SHARD_PREFIX)) {
      continue;
    }
    const shard = everything[key];
    if (!isStateV4NodeShard(shard)) {
      continue;
    }
    const best = bestByShard.get(shard.shardIndex);
    if (!best || shard.generation > best.generation) {
      bestByShard.set(shard.shardIndex, shard);
    }
  }
  if (bestByShard.size === 0) {
    return undefined;
  }

  const nodes: OutlineState["nodes"] = {};
  const shardGenerations = Array.from({ length: STATE_V4_NODE_SHARD_COUNT }, () => 0);
  for (const shard of bestByShard.values()) {
    if (shard.shardIndex >= 0 && shard.shardIndex < STATE_V4_NODE_SHARD_COUNT) {
      shardGenerations[shard.shardIndex] = shard.generation;
    }
    for (const node of shard.nodes) {
      nodes[node.id] = cloneOutlineNode(node);
    }
  }
  const state: OutlineState = {
    version: 1,
    // Salvage has no trusted root list; structural repair re-derives roots from parent
    // pointers (nodes without parents become roots, unreachable subtrees are re-rooted).
    rootIds: [],
    nodes
  };
  const generation = Math.max(...shardGenerations);
  const manifest: StateV4Manifest = {
    version: 4,
    generation,
    epoch: 0,
    journalSeqIncluded: 0,
    rootIds: [],
    nodeCount: Object.keys(nodes).length,
    closedCount: Object.values(nodes).filter((node) => node.status === "closed").length,
    shardGenerations,
    savedAt: 0
  };
  return { state, manifest };
}

export async function hasAnyStateV4Keys(api: WebExtensionBrowser): Promise<boolean> {
  const stored = await api.storage.local.get([STATE_V4_MANIFEST_A_KEY, STATE_V4_MANIFEST_B_KEY]);
  if (stored[STATE_V4_MANIFEST_A_KEY] !== undefined || stored[STATE_V4_MANIFEST_B_KEY] !== undefined) {
    return true;
  }
  const everything = await api.storage.local.get(null);
  return Object.keys(everything).some((key) => key.startsWith(STATE_V4_NODE_SHARD_PREFIX));
}

function isStateV4Manifest(value: unknown): value is StateV4Manifest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const manifest = value as StateV4Manifest;
  return manifest.version === 4 &&
    typeof manifest.generation === "number" &&
    typeof manifest.epoch === "number" &&
    typeof manifest.journalSeqIncluded === "number" &&
    Array.isArray(manifest.rootIds) &&
    typeof manifest.nodeCount === "number" &&
    typeof manifest.closedCount === "number" &&
    Array.isArray(manifest.shardGenerations) &&
    (manifest.shardGenerations.length === STATE_V4_NODE_SHARD_COUNT ||
      STATE_V4_LEGACY_SHARD_COUNTS.has(manifest.shardGenerations.length)) &&
    manifest.shardGenerations.every((generation) => typeof generation === "number") &&
    typeof manifest.savedAt === "number";
}

function isStateV4NodeShard(value: unknown): value is StateV4NodeShard {
  if (!value || typeof value !== "object") {
    return false;
  }
  const shard = value as StateV4NodeShard;
  return shard.version === 4 &&
    typeof shard.shardIndex === "number" &&
    typeof shard.generation === "number" &&
    Array.isArray(shard.nodes) &&
    shard.nodes.every(isStoredOutlineNode);
}

function isStoredOutlineNode(value: unknown): value is OutlineNode {
  if (!value || typeof value !== "object") {
    return false;
  }
  const node = value as OutlineNode;
  return typeof node.id === "string" &&
    typeof node.kind === "string" &&
    typeof node.status === "string" &&
    Array.isArray(node.childIds) &&
    typeof node.title === "string";
}
