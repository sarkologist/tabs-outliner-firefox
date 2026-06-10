import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import { cloneOutlineNode } from "./history.js";
import { normalizeLoadedOutlineStructure, type StateStructureRepair } from "./storage.js";

// v4 snapshot store: 32 generation-stamped node shards (childIds inline -- no order pages)
// plus double-buffered manifests. Consistency is verifiable from storage alone: a shard is
// valid for a manifest only when its embedded generation matches the manifest's
// shardGenerations entry, so a torn compaction can never be half-trusted. See
// docs/storage-rearchitecture/01-TARGET-ARCHITECTURE.md sections 2-4.

export const STATE_V4_MANIFEST_A_KEY = "outline:v4:manifest:a";
export const STATE_V4_MANIFEST_B_KEY = "outline:v4:manifest:b";
export const STATE_V4_NODE_SHARD_PREFIX = "outline:v4:nodes:";
export const STATE_V4_NODE_SHARD_COUNT = 32;
export const STATE_V4_MIGRATION_BACKUP_KEY = "outline:v4:migrationBackup";

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
  // Old-generation shard keys superseded by this write; remove only after the set commits.
  // A failed remove leaves harmless unreferenced garbage.
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
};

export function stateV4ShardIndexForNodeId(nodeId: NodeId): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < nodeId.length; index += 1) {
    hash ^= nodeId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % STATE_V4_NODE_SHARD_COUNT;
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
    const previousGeneration = previous?.manifest.shardGenerations[shardIndex];
    if (previousGeneration !== undefined && previousGeneration !== generation) {
      removeKeysAfterCommit.push(stateV4NodeShardKey(shardIndex, previousGeneration));
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
      return {
        state: loaded.state,
        manifest: candidate.manifest,
        slot: candidate.slot,
        recovery: index === 0 ? "r0" : "r1",
        ...(loaded.repair ? { repair: loaded.repair } : {}),
        journalSeqIncluded: candidate.manifest.journalSeqIncluded
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
    manifest.shardGenerations.length === STATE_V4_NODE_SHARD_COUNT &&
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
