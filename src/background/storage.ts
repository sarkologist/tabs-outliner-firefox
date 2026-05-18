import type { OutlineState } from "../model/types.js";
import type { NodeId, OutlineNode } from "../model/types.js";
import { normalizeHistoryState, type HistoryState } from "./history.js";

export const STATE_KEY = "outlineState";
export const HISTORY_KEY = "outlineHistory";
export const STATE_V2_MANIFEST_KEY = "outlineState:v2:manifest";
const STATE_V2_NODE_CHUNK_PREFIX = "outlineState:v2:nodes:";
const STATE_V2_ORDER_PAGE_PREFIX = "outlineState:v2:order:";
const STATE_V2_NODE_CHUNK_SIZE = 512;
const STATE_V2_ORDER_PAGE_SIZE = 1024;
export const INITIAL_TREE_SNAPSHOT_ROW_LIMIT = 256;

type StoredOutlineNode = Omit<OutlineNode, "childIds"> & {
  childCount: number;
};

type StateV2NodeChunk = {
  version: 2;
  nodes: StoredOutlineNode[];
};

type StateV2OrderPage = {
  version: 2;
  parentId: NodeId;
  pageIndex: number;
  childIds: NodeId[];
};

type InitialTreeRow = {
  nodeId: NodeId;
  depth: number;
  index: number;
  parentRowIndex?: number;
  subtreeEndIndex: number;
  childCount: number;
  visibleChildCount: number;
  expanded: boolean;
  searchRevealsCollapsedChildren: boolean;
  isSearchMatch: boolean;
  isSearchPath: boolean;
  insideActiveWindow: boolean;
};

export type InitialTreeSnapshot = {
  type: "initialTreeSnapshot";
  version: 1;
  revision: number;
  state: OutlineState;
  projection: {
    query: "";
    isSearchActive: false;
    rows: InitialTreeRow[];
    matchingNodeIds: NodeId[];
    visibleNodeIds: NodeId[];
    activeTabNodeId?: NodeId;
    activeTabRowIndex?: number;
    nodeCount: number;
    closedCount: number;
    matchCount: 0;
  };
  hydrating: boolean;
};

type StateV2Manifest = {
  version: 2;
  revision: number;
  rootIds: NodeId[];
  nodeCount: number;
  closedCount: number;
  nodeChunkSize: number;
  orderPageSize: number;
  nodeChunkKeys: string[];
  orderPageKeys: string[];
  initialSnapshot: InitialTreeSnapshot;
};

export async function loadState(api: WebExtensionBrowser = browser): Promise<OutlineState | undefined> {
  return loadStateV2(api);
}

export async function loadHistory(api: WebExtensionBrowser = browser): Promise<HistoryState> {
  const stored = await api.storage.local.get(HISTORY_KEY);
  return normalizeHistoryState(stored[HISTORY_KEY]);
}

export async function saveState(state: OutlineState, api: WebExtensionBrowser = browser): Promise<void> {
  await api.storage.local.set(outlineStateV2Items(state));
}

export async function saveStateAndHistory(
  state: OutlineState | undefined,
  history: HistoryState | undefined,
  api: WebExtensionBrowser = browser
): Promise<void> {
  const items: Record<string, unknown> = {};
  if (state) {
    Object.assign(items, outlineStateV2Items(state));
  }
  if (history) {
    items[HISTORY_KEY] = history;
  }
  if (Object.keys(items).length > 0) {
    await api.storage.local.set(items);
  }
}

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

export async function loadInitialTreeSnapshot(
  api: WebExtensionBrowser = browser
): Promise<InitialTreeSnapshot | undefined> {
  const stored = await api.storage.local.get(STATE_V2_MANIFEST_KEY);
  const manifest = stored[STATE_V2_MANIFEST_KEY];
  return isStateV2Manifest(manifest) ? cloneInitialTreeSnapshot(manifest.initialSnapshot, true) : undefined;
}

export async function loadStateV2(api: WebExtensionBrowser = browser): Promise<OutlineState | undefined> {
  const stored = await api.storage.local.get(STATE_V2_MANIFEST_KEY);
  const manifest = stored[STATE_V2_MANIFEST_KEY];
  if (!isStateV2Manifest(manifest)) {
    return undefined;
  }

  const chunkItems = await api.storage.local.get([...manifest.nodeChunkKeys, ...manifest.orderPageKeys]);
  const nodes: OutlineState["nodes"] = {};
  for (const key of manifest.nodeChunkKeys) {
    const chunk = chunkItems[key];
    if (!isStateV2NodeChunk(chunk)) {
      return undefined;
    }
    for (const storedNode of chunk.nodes) {
      nodes[storedNode.id] = storedNodeToNode(storedNode);
    }
  }

  const orderPagesByParent = new Map<NodeId, StateV2OrderPage[]>();
  for (const key of manifest.orderPageKeys) {
    const page = chunkItems[key];
    if (!isStateV2OrderPage(page)) {
      return undefined;
    }
    const pages = orderPagesByParent.get(page.parentId) ?? [];
    pages.push(page);
    orderPagesByParent.set(page.parentId, pages);
  }

  for (const [parentId, pages] of orderPagesByParent) {
    const node = nodes[parentId];
    if (!node) {
      return undefined;
    }
    node.childIds = pages
      .sort((left, right) => left.pageIndex - right.pageIndex)
      .flatMap((page) => page.childIds);
  }

  const state: OutlineState = {
    version: 1,
    rootIds: [...manifest.rootIds],
    nodes
  };
  return isOutlineState(state) ? state : undefined;
}

export function initialTreeSnapshotForState(
  state: OutlineState,
  options: { revision?: number; rowLimit?: number; hydrating?: boolean } = {}
): InitialTreeSnapshot {
  const revision = options.revision ?? Date.now();
  const rowLimit = options.rowLimit ?? INITIAL_TREE_SNAPSHOT_ROW_LIMIT;
  const rows: InitialTreeRow[] = [];
  const loadedNodeIds = new Set<NodeId>();
  const stack = state.rootIds
    .slice()
    .reverse()
    .map((nodeId) => ({
      nodeId,
      depth: 0,
      parentRowIndex: undefined as number | undefined,
      insideActiveWindow: false
    }));
  let activeTabNodeId: NodeId | undefined;
  let activeTabRowIndex: number | undefined;

  while (stack.length > 0 && rows.length < rowLimit) {
    const entry = stack.pop()!;
    const node = state.nodes[entry.nodeId];
    if (!node) {
      continue;
    }

    const index = rows.length;
    const insideActiveWindow = entry.insideActiveWindow || Boolean(node.kind === "window" && node.active);
    if (!activeTabNodeId && node.kind === "tab" && node.active && insideActiveWindow) {
      activeTabNodeId = node.id;
      activeTabRowIndex = index;
    }
    loadedNodeIds.add(node.id);
    rows.push({
      nodeId: node.id,
      depth: entry.depth,
      index,
      ...(typeof entry.parentRowIndex === "number" ? { parentRowIndex: entry.parentRowIndex } : {}),
      subtreeEndIndex: index + 1,
      childCount: node.childIds.length,
      visibleChildCount: node.collapsed ? 0 : node.childIds.length,
      expanded: !node.collapsed,
      searchRevealsCollapsedChildren: false,
      isSearchMatch: false,
      isSearchPath: false,
      insideActiveWindow
    });

    if (node.collapsed) {
      continue;
    }
    for (let childIndex = node.childIds.length - 1; childIndex >= 0; childIndex -= 1) {
      stack.push({
        nodeId: node.childIds[childIndex]!,
        depth: entry.depth + 1,
        parentRowIndex: index,
        insideActiveWindow
      });
    }
  }

  refreshInitialRowStructure(rows);
  const partialNodes: OutlineState["nodes"] = {};
  for (const nodeId of loadedNodeIds) {
    const node = state.nodes[nodeId];
    if (!node) {
      continue;
    }
    partialNodes[nodeId] = {
      ...node,
      childIds: node.childIds.filter((childId) => loadedNodeIds.has(childId))
    };
  }

  const nodeValues = Object.values(state.nodes);
  return {
    type: "initialTreeSnapshot",
    version: 1,
    revision,
    state: {
      version: 1,
      rootIds: state.rootIds.filter((nodeId) => loadedNodeIds.has(nodeId)),
      nodes: partialNodes
    },
    projection: {
      query: "",
      isSearchActive: false,
      rows,
      matchingNodeIds: [],
      visibleNodeIds: rows.map((row) => row.nodeId),
      ...(activeTabNodeId ? { activeTabNodeId } : {}),
      ...(typeof activeTabRowIndex === "number" ? { activeTabRowIndex } : {}),
      nodeCount: nodeValues.length,
      closedCount: nodeValues.filter((node) => node.status === "closed").length,
      matchCount: 0
    },
    hydrating: options.hydrating ?? true
  };
}

function refreshInitialRowStructure(rows: InitialTreeRow[]): void {
  const openRowIndexesByDepth: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const depth = Math.max(0, row.depth);
    for (let closeDepth = openRowIndexesByDepth.length - 1; closeDepth >= depth; closeDepth -= 1) {
      const openRowIndex = openRowIndexesByDepth[closeDepth];
      if (typeof openRowIndex === "number") {
        rows[openRowIndex]!.subtreeEndIndex = index;
      }
    }
    openRowIndexesByDepth.length = depth;
    row.index = index;
    row.subtreeEndIndex = rows.length;
    const parentRowIndex = depth > 0 ? openRowIndexesByDepth[depth - 1] : undefined;
    if (typeof parentRowIndex === "number") {
      row.parentRowIndex = parentRowIndex;
    } else {
      delete row.parentRowIndex;
    }
    openRowIndexesByDepth[depth] = index;
  }
}

function nodeToStoredNode(node: OutlineNode): StoredOutlineNode {
  const { childIds: _childIds, ...rest } = node;
  return {
    ...rest,
    childCount: node.childIds.length
  };
}

function storedNodeToNode(node: StoredOutlineNode): OutlineNode {
  const { childCount: _childCount, ...rest } = node;
  return {
    ...rest,
    childIds: []
  };
}

function cloneInitialTreeSnapshot(snapshot: InitialTreeSnapshot, hydrating: boolean): InitialTreeSnapshot {
  return {
    ...snapshot,
    hydrating,
    state: {
      version: 1,
      rootIds: [...snapshot.state.rootIds],
      nodes: Object.fromEntries(
        Object.entries(snapshot.state.nodes).map(([nodeId, node]) => [nodeId, { ...node, childIds: [...node.childIds] }])
      )
    },
    projection: {
      ...snapshot.projection,
      rows: snapshot.projection.rows.map((row) => ({ ...row })),
      matchingNodeIds: [...snapshot.projection.matchingNodeIds],
      visibleNodeIds: [...snapshot.projection.visibleNodeIds]
    }
  };
}

function isOutlineState(value: unknown): value is OutlineState {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as OutlineState).version === 1 &&
      Array.isArray((value as OutlineState).rootIds) &&
      typeof (value as OutlineState).nodes === "object"
  );
}

function isStateV2Manifest(value: unknown): value is StateV2Manifest {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as StateV2Manifest).version === 2 &&
      typeof (value as StateV2Manifest).revision === "number" &&
      Array.isArray((value as StateV2Manifest).rootIds) &&
      Array.isArray((value as StateV2Manifest).nodeChunkKeys) &&
      Array.isArray((value as StateV2Manifest).orderPageKeys) &&
      isInitialTreeSnapshot((value as StateV2Manifest).initialSnapshot)
  );
}

function isStateV2NodeChunk(value: unknown): value is StateV2NodeChunk {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as StateV2NodeChunk).version === 2 &&
      Array.isArray((value as StateV2NodeChunk).nodes)
  );
}

function isStateV2OrderPage(value: unknown): value is StateV2OrderPage {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as StateV2OrderPage).version === 2 &&
      typeof (value as StateV2OrderPage).parentId === "string" &&
      typeof (value as StateV2OrderPage).pageIndex === "number" &&
      Array.isArray((value as StateV2OrderPage).childIds)
  );
}

function isInitialTreeSnapshot(value: unknown): value is InitialTreeSnapshot {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as InitialTreeSnapshot).type === "initialTreeSnapshot" &&
      (value as InitialTreeSnapshot).version === 1 &&
      typeof (value as InitialTreeSnapshot).revision === "number" &&
      isOutlineState((value as InitialTreeSnapshot).state) &&
      (value as InitialTreeSnapshot).projection &&
      typeof (value as InitialTreeSnapshot).projection === "object" &&
      Array.isArray((value as InitialTreeSnapshot).projection.rows)
  );
}
