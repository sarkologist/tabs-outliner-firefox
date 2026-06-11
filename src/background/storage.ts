import type { OutlineState } from "../model/types.js";
import type { NodeId, OutlineNode } from "../model/types.js";
import { DEFAULT_HISTORY_LIMIT, normalizeHistoryState, type HistoryState } from "./history.js";
import {
  cloneInitialTreeSnapshot,
  initialTreeSnapshotForState,
  isInitialTreeSnapshot,
  isOutlineState,
  type InitialTreeSnapshot
} from "./initial-tree-snapshot.js";

// v3 is a read-only legacy format: the live store is v4 (storage-v4.ts plus
// outline-journal.ts), and these keys/types/sizes survive only for the one-time
// startup migration read. v1/v2 keys are no longer readable - they exist below only
// so startup can detect (and migration cleanup can delete) abandoned stores. The
// matching v3 writer lives in storage-legacy-write.test-support.ts for
// migration-fixture tests.
export const STATE_KEY = "outlineState";
export const HISTORY_KEY = "outlineHistory";
export const STATE_V2_MANIFEST_KEY = "outlineState:v2:manifest";
export const STATE_V3_MANIFEST_KEY = "outlineState:v3:manifest";
const STATE_V3_ORDER_PAGE_PREFIX = "outlineState:v3:order:";
export const STATE_V3_BOOT_SNAPSHOT_KEY = "outlineState:v3:bootSnapshot";
export const STATE_V4_BOOT_SNAPSHOT_KEY = "outline:v4:bootSnapshot";
export const STATE_V3_NODE_SHARD_COUNT = 32;
export const STATE_V3_ORDER_PAGE_SIZE = 1024;

export type StoredOutlineNode = Omit<OutlineNode, "childIds"> & {
  childCount: number;
};

export type StateV3NodeShard = {
  version: 3;
  shardIndex: number;
  nodes: StoredOutlineNode[];
};

export type StateV3OrderPage = {
  version: 3;
  parentId: NodeId;
  pageIndex: number;
  childIds: NodeId[];
};

export type StateV3Manifest = {
  version: 3;
  revision: number;
  rootIds: NodeId[];
  nodeCount: number;
  closedCount: number;
  nodeShardCount: number;
  nodeShardKeys: string[];
  orderPageSize: number;
  // Highest v4 journal seq reflected in this snapshot. The loader replays journal entries
  // with seq > this value on top of the loaded state (Phase 2 double-write durability).
  journalSeqIncluded?: number;
  // Revision of the separately-stored boot snapshot (STATE_V3_BOOT_SNAPSHOT_KEY).
  bootSnapshotRevision?: number;
  // Only older manifests embed the snapshot inline; new saves write it to its own key so
  // a one-node change no longer reserializes the whole 256-row snapshot per flush.
  initialSnapshot?: InitialTreeSnapshot;
};

type StateV3BootSnapshot = {
  version: 3;
  revision: number;
  snapshot: InitialTreeSnapshot;
};

export type LoadedOutlineState = {
  state: OutlineState;
  format: "v3" | "v4";
  requiresFullSave?: boolean;
  // Highest journal seq already reflected in the loaded snapshot; the controller replays
  // journal entries with seq greater than this on top of `state`.
  journalSeqIncluded?: number;
  // True when the v3 load skipped unparseable shards or accepted partial order pages.
  salvaged?: boolean;
  repair?: StateStructureRepair;
};

type StateV3LoadOutcome = {
  state: OutlineState;
  salvaged: boolean;
  repair?: StateStructureRepair;
};

export type StateLoadPhase = {
  name: string;
  durationMs: number;
  detail?: Record<string, string | number | boolean>;
};

export type StateStructureRepair = {
  source: "v3" | "v4";
  rootCountBefore: number;
  rootCountAfter: number;
  parentMismatchCount: number;
  staleRootParentCount: number;
  missingChildCount: number;
  duplicateChildCount: number;
  extraRootCount: number;
  unreachableNodeCount: number;
};

export type LoadStateOptions = {
  onPhase?: (phase: StateLoadPhase) => void;
  onStructureRepair?: (repair: StateStructureRepair) => void | Promise<void>;
};

async function measureLoadPhase<T>(
  options: LoadStateOptions,
  name: string,
  fn: () => T | Promise<T>,
  detail: StateLoadPhase["detail"] = {}
): Promise<T> {
  const startMs = currentMs();
  try {
    return await fn();
  } finally {
    options.onPhase?.({
      name,
      durationMs: currentMs() - startMs,
      ...(Object.keys(detail).length > 0 ? { detail } : {})
    });
  }
}

function currentMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export async function loadStateWithMetadata(
  api: WebExtensionBrowser = browser,
  options: LoadStateOptions = {}
): Promise<LoadedOutlineState | undefined> {
  const stored = await measureLoadPhase(options, "manifestRead", () =>
    api.storage.local.get(STATE_V3_MANIFEST_KEY)
  );
  const v3Manifest = stored[STATE_V3_MANIFEST_KEY];
  if (!isStateV3Manifest(v3Manifest)) {
    return undefined;
  }
  const outcome = await loadStateV3FromManifest(v3Manifest, api, options);
  if (outcome) {
    return {
      state: outcome.state,
      format: "v3",
      ...(stateV3ManifestRequiresFullSave(v3Manifest) || outcome.salvaged ? { requiresFullSave: true } : {}),
      ...(outcome.salvaged ? { salvaged: true } : {}),
      ...(outcome.repair ? { repair: outcome.repair } : {}),
      ...(typeof v3Manifest.journalSeqIncluded === "number" ? { journalSeqIncluded: v3Manifest.journalSeqIncluded } : {})
    };
  }

  // A v3 manifest exists but its shards did not load. Return an empty salvaged v3 state so
  // the caller reconciles from runtime rather than silently bootstrapping a fresh tree on
  // top of (now unreadable) stored data.
  return {
    state: { version: 1, rootIds: [], nodes: {} },
    format: "v3",
    requiresFullSave: true,
    salvaged: true
  };
}

export async function loadHistory(
  api: WebExtensionBrowser = browser,
  limit = DEFAULT_HISTORY_LIMIT
): Promise<HistoryState> {
  const stored = await api.storage.local.get(HISTORY_KEY);
  return normalizeHistoryState(stored[HISTORY_KEY], limit);
}


export async function loadInitialTreeSnapshot(
  api: WebExtensionBrowser = browser
): Promise<InitialTreeSnapshot | undefined> {
  const stored = await api.storage.local.get([
    STATE_V4_BOOT_SNAPSHOT_KEY,
    STATE_V3_BOOT_SNAPSHOT_KEY,
    STATE_V3_MANIFEST_KEY
  ]);
  const bootSnapshot = stored[STATE_V4_BOOT_SNAPSHOT_KEY] ?? stored[STATE_V3_BOOT_SNAPSHOT_KEY];
  if (isStateV3BootSnapshot(bootSnapshot)) {
    return { ...cloneInitialTreeSnapshot(bootSnapshot.snapshot, true), fromStorage: true };
  }

  // Back-compat: older manifests embed the snapshot inline.
  const v3Manifest = stored[STATE_V3_MANIFEST_KEY];
  if (isStateV3Manifest(v3Manifest) && v3Manifest.initialSnapshot) {
    return { ...cloneInitialTreeSnapshot(v3Manifest.initialSnapshot, true), fromStorage: true };
  }

  return undefined;
}

export async function loadStateV3(api: WebExtensionBrowser = browser): Promise<OutlineState | undefined> {
  const stored = await api.storage.local.get(STATE_V3_MANIFEST_KEY);
  const manifest = stored[STATE_V3_MANIFEST_KEY];
  if (!isStateV3Manifest(manifest)) {
    return undefined;
  }

  return (await loadStateV3FromManifest(manifest, api))?.state;
}

async function loadStateV3FromManifest(
  manifest: StateV3Manifest,
  api: WebExtensionBrowser,
  options: LoadStateOptions = {}
): Promise<StateV3LoadOutcome | undefined> {
  const shardItems: Record<string, unknown> = await measureLoadPhase(
    options,
    "v3.nodeShardRead",
    () => manifest.nodeShardKeys.length > 0
      ? api.storage.local.get(manifest.nodeShardKeys)
      : Promise.resolve({}),
    { keys: manifest.nodeShardKeys.length }
  );
  const nodes: OutlineState["nodes"] = {};
  const storedNodesWithChildren: StoredOutlineNode[] = [];
  let parsedShardCount = 0;
  let shardParseFailureCount = 0;
  await measureLoadPhase(
    options,
    "v3.nodeMaterialize",
    () => {
      for (const key of manifest.nodeShardKeys) {
        const shard = shardItems[key];
        if (!isStateV3NodeShard(shard)) {
          // Salvage: skip an unparseable shard rather than failing the whole load.
          shardParseFailureCount += 1;
          continue;
        }
        parsedShardCount += 1;
        for (const storedNode of shard.nodes) {
          if (storedNode.childCount > 0) {
            storedNodesWithChildren.push(storedNode);
          }
          nodes[storedNode.id] = storedNodeToNode(storedNode);
        }
      }
    },
    { shards: manifest.nodeShardKeys.length }
  );
  // If shards were expected but none parsed, the node table is unrecoverable from v3.
  if (manifest.nodeShardKeys.length > 0 && parsedShardCount === 0) {
    return undefined;
  }

  const orderPageKeys = await measureLoadPhase(
    options,
    "v3.orderPageKeys",
    () => storedNodesWithChildren.flatMap((node) => orderPageKeysForStoredNode(node, manifest.orderPageSize)),
    { parents: storedNodesWithChildren.length }
  );
  const orderPageItems: Record<string, unknown> = await measureLoadPhase(
    options,
    "v3.orderPageRead",
    () => orderPageKeys.length > 0 ? api.storage.local.get(orderPageKeys) : Promise.resolve({}),
    { keys: orderPageKeys.length }
  );
  let orderSalvageCount = 0;
  await measureLoadPhase(
    options,
    "v3.orderAttach",
    () => {
      for (const storedNode of storedNodesWithChildren) {
        const node = nodes[storedNode.id];
        if (!node) {
          continue;
        }
        const childIds: NodeId[] = [];
        const pageCount = Math.ceil(storedNode.childCount / manifest.orderPageSize);
        let truncated = false;
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
          const page = orderPageItems[stateV3OrderPageKey(storedNode.id, pageIndex)];
          if (!isStateV3OrderPage(page) || page.parentId !== storedNode.id || page.pageIndex !== pageIndex) {
            // Salvage: keep the valid prefix of the child order; structure repair re-roots
            // the children we could not place.
            truncated = true;
            break;
          }
          childIds.push(...page.childIds);
        }
        if (truncated || childIds.length !== storedNode.childCount) {
          orderSalvageCount += 1;
        }
        node.childIds = childIds;
      }
    },
    { pages: orderPageKeys.length }
  );

  const state: OutlineState = {
    version: 1,
    rootIds: [...manifest.rootIds],
    nodes
  };
  const repair = normalizeLoadedOutlineStructure(state, "v3");
  if (repair) {
    await options.onStructureRepair?.(repair);
  }
  if (!(await measureLoadPhase(options, "v3.validation", () => isOutlineState(state)))) {
    return undefined;
  }
  return {
    state,
    salvaged: shardParseFailureCount > 0 || orderSalvageCount > 0,
    ...(repair ? { repair } : {})
  };
}

// Load-time structural repair: re-roots unreachable nodes, drops dangling child refs, and
// reconciles parent pointers against the reachable tree. Generic over the storage format
// that produced the state (v3 load and v4 R2 salvage both use it).
export function normalizeLoadedOutlineStructure(
  state: OutlineState,
  source: StateStructureRepair["source"]
): StateStructureRepair | undefined {
  const originalRootIds = [...state.rootIds];
  const originalParentIds = new Map<NodeId, NodeId | undefined>();
  const referencedChildIds = new Set<NodeId>();
  for (const nodeId in state.nodes) {
    const node = state.nodes[nodeId];
    if (!node) {
      continue;
    }
    originalParentIds.set(nodeId, node.parentId);
    for (const childId of node.childIds) {
      if (state.nodes[childId]) {
        referencedChildIds.add(childId);
      }
    }
  }
  const rootIds: NodeId[] = [];
  const rootIdSet = new Set<NodeId>();
  const manifestRootIds = uniqueNodeIds(originalRootIds);
  const manifestRootIdSet = new Set<NodeId>(manifestRootIds.filter((nodeId) => Boolean(state.nodes[nodeId])));
  const reached = new Set<NodeId>();
  let parentMismatchCount = 0;
  let staleRootParentCount = 0;
  let missingChildCount = 0;
  let duplicateChildCount = 0;
  let extraRootCount = 0;
  let unreachableNodeCount = 0;

  const assignParent = (node: OutlineNode, parentId: NodeId | undefined): void => {
    const previousParentId = originalParentIds.get(node.id);
    if (previousParentId !== parentId) {
      parentMismatchCount += 1;
    }
    if (parentId === undefined) {
      if (previousParentId !== undefined) {
        staleRootParentCount += 1;
      }
      delete node.parentId;
    } else {
      node.parentId = parentId;
    }
  };

  const visit = (nodeId: NodeId, parentId: NodeId | undefined): boolean => {
    const node = state.nodes[nodeId];
    if (!node || reached.has(nodeId)) {
      duplicateChildCount += reached.has(nodeId) ? 1 : 0;
      missingChildCount += !node ? 1 : 0;
      return false;
    }

    reached.add(nodeId);
    assignParent(node, parentId);

    const childIds: NodeId[] = [];
    for (const childId of node.childIds) {
      if (!state.nodes[childId]) {
        missingChildCount += 1;
        continue;
      }
      if (manifestRootIdSet.has(childId) || reached.has(childId)) {
        duplicateChildCount += 1;
        continue;
      }
      if (visit(childId, nodeId)) {
        childIds.push(childId);
      }
    }
    node.childIds = childIds;
    return true;
  };

  for (const rootId of manifestRootIds) {
    if (!state.nodes[rootId]) {
      missingChildCount += 1;
      continue;
    }
    if (rootIdSet.has(rootId)) {
      duplicateChildCount += 1;
      continue;
    }
    if (visit(rootId, undefined)) {
      rootIds.push(rootId);
      rootIdSet.add(rootId);
    }
  }

  for (const nodeId in state.nodes) {
    if (reached.has(nodeId) || referencedChildIds.has(nodeId)) {
      continue;
    }
    const reachedBefore = reached.size;
    if (visit(nodeId, undefined)) {
      rootIds.push(nodeId);
      rootIdSet.add(nodeId);
      extraRootCount += 1;
      unreachableNodeCount += reached.size - reachedBefore;
    }
  }

  for (const nodeId in state.nodes) {
    if (reached.has(nodeId)) {
      continue;
    }
    const reachedBefore = reached.size;
    if (visit(nodeId, undefined)) {
      rootIds.push(nodeId);
      rootIdSet.add(nodeId);
      extraRootCount += 1;
      unreachableNodeCount += reached.size - reachedBefore;
    }
  }

  state.rootIds = rootIds;
  const rootCountBefore = originalRootIds.length;
  const rootCountAfter = rootIds.length;
  const rootIdsChanged = !sameNodeIdList(originalRootIds, rootIds);
  if (
    parentMismatchCount === 0 &&
    missingChildCount === 0 &&
    duplicateChildCount === 0 &&
    extraRootCount === 0 &&
    unreachableNodeCount === 0 &&
    !rootIdsChanged
  ) {
    return undefined;
  }

  return {
    source,
    rootCountBefore,
    rootCountAfter,
    parentMismatchCount,
    staleRootParentCount,
    missingChildCount,
    duplicateChildCount,
    extraRootCount,
    unreachableNodeCount
  };
}

function storedNodeToNode(node: StoredOutlineNode): OutlineNode {
  const outlineNode: OutlineNode = {
    id: node.id,
    kind: node.kind,
    status: node.status,
    childIds: [],
    title: node.title,
    collapsed: node.collapsed,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt
  };
  if (node.parentId !== undefined) {
    outlineNode.parentId = node.parentId;
  }
  if (node.customTitle !== undefined) {
    outlineNode.customTitle = node.customTitle;
  }
  if (node.url !== undefined) {
    outlineNode.url = node.url;
  }
  if (node.favIconUrl !== undefined) {
    outlineNode.favIconUrl = node.favIconUrl;
  }
  if (node.active !== undefined) {
    outlineNode.active = node.active;
  }
  if (node.closedAt !== undefined) {
    outlineNode.closedAt = node.closedAt;
  }
  if (node.live !== undefined) {
    outlineNode.live = node.live;
  }
  if (node.restore !== undefined) {
    outlineNode.restore = node.restore;
  }
  if (node.restoredFromClosed !== undefined) {
    outlineNode.restoredFromClosed = node.restoredFromClosed;
  }
  if (node.runtimeProvenance !== undefined) {
    outlineNode.runtimeProvenance = node.runtimeProvenance;
  }
  return outlineNode;
}

// The boot snapshot is a cold-start-only sparse first-paint cache (Class C). It is written
// to its own key on a debounce rather than embedded in every save's manifest.
export function outlineBootSnapshotItem(
  state: OutlineState,
  revision: number = Date.now()
): Record<string, StateV3BootSnapshot> {
  return {
    [STATE_V4_BOOT_SNAPSHOT_KEY]: {
      version: 3,
      revision,
      snapshot: initialTreeSnapshotForState(state, { revision, hydrating: true })
    }
  };
}

function stateV3ManifestRequiresFullSave(manifest: StateV3Manifest): boolean {
  return manifest.nodeShardCount !== STATE_V3_NODE_SHARD_COUNT ||
    manifest.orderPageSize !== STATE_V3_ORDER_PAGE_SIZE;
}








function uniqueNodeIds(nodeIds: readonly NodeId[]): NodeId[] {
  return [...new Set(nodeIds.filter(Boolean))];
}

function orderPageKeysForStoredNode(node: StoredOutlineNode, orderPageSize: number): string[] {
  const keys: string[] = [];
  const pageCount = Math.ceil(node.childCount / orderPageSize);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    keys.push(stateV3OrderPageKey(node.id, pageIndex));
  }
  return keys;
}

// One FNV-1a shard hash shared by the v3 and v4 stores: node-to-shard assignment must stay
// byte-identical across formats (migration re-shards by id; a silent divergence would make
// dirty-shard compaction write the wrong shard).
export function outlineNodeShardIndex(nodeId: NodeId, shardCount: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < nodeId.length; index += 1) {
    hash ^= nodeId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % shardCount;
}



export function stateV3OrderPageKey(parentId: NodeId, pageIndex: number): string {
  return `${STATE_V3_ORDER_PAGE_PREFIX}${encodeURIComponent(parentId)}:${pageIndex}`;
}






function isStateV3Manifest(value: unknown): value is StateV3Manifest {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as StateV3Manifest).version === 3 &&
      typeof (value as StateV3Manifest).revision === "number" &&
      Array.isArray((value as StateV3Manifest).rootIds) &&
      typeof (value as StateV3Manifest).nodeCount === "number" &&
      typeof (value as StateV3Manifest).closedCount === "number" &&
      typeof (value as StateV3Manifest).nodeShardCount === "number" &&
      Array.isArray((value as StateV3Manifest).nodeShardKeys) &&
      typeof (value as StateV3Manifest).orderPageSize === "number" &&
      // New manifests store the snapshot in its own key; older ones embed it inline. Accept
      // either, but if an inline snapshot is present it must be well-formed.
      ((value as StateV3Manifest).initialSnapshot === undefined ||
        isInitialTreeSnapshot((value as StateV3Manifest).initialSnapshot))
  );
}

function isStateV3BootSnapshot(value: unknown): value is StateV3BootSnapshot {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as StateV3BootSnapshot).version === 3 &&
      typeof (value as StateV3BootSnapshot).revision === "number" &&
      isInitialTreeSnapshot((value as StateV3BootSnapshot).snapshot)
  );
}



function isStateV3NodeShard(value: unknown): value is StateV3NodeShard {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as StateV3NodeShard).version === 3 &&
      typeof (value as StateV3NodeShard).shardIndex === "number" &&
      Array.isArray((value as StateV3NodeShard).nodes)
  );
}

function isStateV3OrderPage(value: unknown): value is StateV3OrderPage {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as StateV3OrderPage).version === 3 &&
      typeof (value as StateV3OrderPage).parentId === "string" &&
      typeof (value as StateV3OrderPage).pageIndex === "number" &&
      Array.isArray((value as StateV3OrderPage).childIds)
  );
}

function sameNodeIdList(previous: readonly NodeId[], next: readonly NodeId[]): boolean {
  return previous.length === next.length && previous.every((nodeId, index) => nodeId === next[index]);
}
