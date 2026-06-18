import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import {
  STATE_V2_MANIFEST_KEY,
  STATE_V3_MANIFEST_KEY,
  STATE_V3_NODE_SHARD_COUNT,
  STATE_V3_ORDER_PAGE_SIZE,
  outlineNodeShardIndex,
  stateV3OrderPageKey,
  type StateV3Manifest,
  type StateV3NodeShard,
  type StateV3OrderPage,
  type StoredOutlineNode
} from "./storage.js";
import { initialTreeSnapshotForState, type InitialTreeSnapshot } from "./initial-tree-snapshot.js";

// The v2 record shapes live only here now: production neither reads nor writes
// v2, and these fixtures exist to seed tests that prove leftover v2 keys are
// detected, retained, and cleaned up without being interpreted.
type StateV2NodeChunk = {
  version: 2;
  nodes: StoredOutlineNode[];
};

type StateV2OrderPage = {
  version: 2;
  parentId: string;
  pageIndex: number;
  childIds: string[];
};

type StateV2Manifest = {
  version: 2;
  revision: number;
  rootIds: string[];
  nodeCount: number;
  closedCount: number;
  nodeChunkSize: number;
  orderPageSize: number;
  nodeChunkKeys: string[];
  orderPageKeys: string[];
  initialSnapshot: InitialTreeSnapshot;
};

// Test-only writers for the legacy v2/v3 storage formats. Production stopped
// writing these formats when the v4 journal+snapshot store became the live
// store; the read/migration paths in storage.ts remain live, and these
// builders exist so tests can construct storage states that real legacy
// versions used to write (full saves only - the old incremental save path is
// gone).

const STATE_V2_NODE_CHUNK_PREFIX = "outlineState:v2:nodes:";
const STATE_V2_ORDER_PAGE_PREFIX = "outlineState:v2:order:";
const STATE_V2_NODE_CHUNK_SIZE = 512;
const STATE_V2_ORDER_PAGE_SIZE = 1024;
const STATE_V3_NODE_SHARD_PREFIX = "outlineState:v3:nodes:";

export function outlineStateV2Items(
  state: OutlineState,
  options: { revision?: number } = {}
): Record<string, unknown> {
  const revision = options.revision ?? Date.now();
  const nodes = Object.values(state.nodes).sort((left, right) => left.id.localeCompare(right.id));
  const nodeChunkKeys: string[] = [];
  const orderPageKeys: string[] = [];
  const items: Record<string, unknown> = {};

  for (let index = 0; index < nodes.length; index += STATE_V2_NODE_CHUNK_SIZE) {
    const chunkIndex = index / STATE_V2_NODE_CHUNK_SIZE;
    const key = `${STATE_V2_NODE_CHUNK_PREFIX}${chunkIndex}`;
    nodeChunkKeys.push(key);
    const chunk: StateV2NodeChunk = {
      version: 2,
      nodes: nodes.slice(index, index + STATE_V2_NODE_CHUNK_SIZE).map(nodeToStoredNode)
    };
    items[key] = chunk;
  }

  for (const node of nodes) {
    if (node.childIds.length === 0) {
      continue;
    }
    for (let index = 0; index < node.childIds.length; index += STATE_V2_ORDER_PAGE_SIZE) {
      const pageIndex = index / STATE_V2_ORDER_PAGE_SIZE;
      const key = `${STATE_V2_ORDER_PAGE_PREFIX}${orderPageKeys.length}`;
      orderPageKeys.push(key);
      const page: StateV2OrderPage = {
        version: 2,
        parentId: node.id,
        pageIndex,
        childIds: node.childIds.slice(index, index + STATE_V2_ORDER_PAGE_SIZE)
      };
      items[key] = page;
    }
  }

  const initialSnapshot = initialTreeSnapshotForState(state, { revision, hydrating: true });
  const manifest: StateV2Manifest = {
    version: 2,
    revision,
    rootIds: [...state.rootIds],
    nodeCount: nodes.length,
    closedCount: nodes.filter((node) => node.status === "closed").length,
    nodeChunkSize: STATE_V2_NODE_CHUNK_SIZE,
    orderPageSize: STATE_V2_ORDER_PAGE_SIZE,
    nodeChunkKeys,
    orderPageKeys,
    initialSnapshot
  };
  items[STATE_V2_MANIFEST_KEY] = manifest;
  return items;
}

export function outlineStateV3Items(
  state: OutlineState,
  options: { revision?: number; journalSeqIncluded?: number } = {}
): Record<string, unknown> {
  const revision = options.revision ?? Date.now();
  const items: Record<string, unknown> = {
    [STATE_V3_MANIFEST_KEY]: stateV3ManifestForState(state, revision, options.journalSeqIncluded)
  };
  for (const [key, shard] of stateV3NodeShardItems(state)) {
    items[key] = shard;
  }
  for (const [key, page] of stateV3OrderPageItems(state)) {
    items[key] = page;
  }
  return items;
}

function stateV3ManifestForState(
  state: OutlineState,
  revision: number,
  journalSeqIncluded?: number
): StateV3Manifest {
  const nodes = Object.values(state.nodes);
  return {
    version: 3,
    revision,
    rootIds: [...state.rootIds],
    nodeCount: nodes.length,
    closedCount: nodes.filter((node) => node.status === "closed").length,
    nodeShardCount: STATE_V3_NODE_SHARD_COUNT,
    nodeShardKeys: stateV3NodeShardKeys(state),
    orderPageSize: STATE_V3_ORDER_PAGE_SIZE,
    ...(journalSeqIncluded !== undefined ? { journalSeqIncluded } : {}),
    bootSnapshotRevision: revision
  };
}

function stateV3NodeShardKeys(state: OutlineState): string[] {
  const shardIndexes = new Set<number>();
  for (const node of Object.values(state.nodes)) {
    shardIndexes.add(stateV3NodeShardIndex(node.id));
  }
  return [...shardIndexes].sort((left, right) => left - right).map(stateV3NodeShardKey);
}

function stateV3NodeShardItems(state: OutlineState): Map<string, StateV3NodeShard> {
  const nodesByShard = new Map<number, StoredOutlineNode[]>();
  for (const node of Object.values(state.nodes)) {
    const shardIndex = stateV3NodeShardIndex(node.id);
    const nodes = nodesByShard.get(shardIndex) ?? [];
    nodes.push(nodeToStoredNode(node));
    nodesByShard.set(shardIndex, nodes);
  }

  const items = new Map<string, StateV3NodeShard>();
  for (const shardIndex of [...nodesByShard.keys()].sort((left, right) => left - right)) {
    items.set(stateV3NodeShardKey(shardIndex), {
      version: 3,
      shardIndex,
      nodes: nodesByShard.get(shardIndex)!.sort((left, right) => left.id.localeCompare(right.id))
    });
  }
  return items;
}

function stateV3OrderPageItems(state: OutlineState): Map<string, StateV3OrderPage> {
  const items = new Map<string, StateV3OrderPage>();
  for (const node of Object.values(state.nodes).sort((left, right) =>
    left.id.localeCompare(right.id)
  )) {
    for (let index = 0; index < node.childIds.length; index += STATE_V3_ORDER_PAGE_SIZE) {
      const pageIndex = index / STATE_V3_ORDER_PAGE_SIZE;
      items.set(stateV3OrderPageKey(node.id, pageIndex), {
        version: 3,
        parentId: node.id,
        pageIndex,
        childIds: node.childIds.slice(index, index + STATE_V3_ORDER_PAGE_SIZE)
      });
    }
  }
  return items;
}

function stateV3NodeShardIndex(nodeId: NodeId): number {
  return outlineNodeShardIndex(nodeId, STATE_V3_NODE_SHARD_COUNT);
}

function stateV3NodeShardKey(shardIndex: number): string {
  return `${STATE_V3_NODE_SHARD_PREFIX}${shardIndex.toString(16).padStart(2, "0")}`;
}

function nodeToStoredNode(node: OutlineNode): StoredOutlineNode {
  const { childIds, ...rest } = node;
  return {
    ...rest,
    childCount: childIds.length
  };
}
