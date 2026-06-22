import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import { isLiveTabNode } from "../model/live-nodes.js";
import { isOutlinerSidebarNode } from "../model/outliner-page.js";

// The sparse first-paint projection: a bounded (256-row) slice of the outline
// with search/centering/coverage metadata, shared by the background (boot
// snapshot key, getInitialTreeSnapshot) and the sidebar boot path. Pure over
// OutlineState - persistence lives in storage.ts.

export const INITIAL_TREE_SNAPSHOT_ROW_LIMIT = 256;

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

type InitialSnapshotOrderEntry = {
  nodeId: NodeId;
  depth: number;
  hiddenByCollapse: boolean;
  insideActiveWindow: boolean;
};

export type ProjectionSliceCoverage = {
  startRowIndex: number;
  endRowIndex: number;
  editableNodeIds: NodeId[];
  completeSubtreeNodeIds: NodeId[];
  completeSiblingParentIds: NodeId[];
};

export type InitialTreeSnapshot = {
  type: "initialTreeSnapshot";
  version: 1;
  revision: number;
  state: OutlineState;
  projection: {
    query: string;
    isSearchActive: boolean;
    rows: InitialTreeRow[];
    matchingNodeIds: NodeId[];
    visibleNodeIds: NodeId[];
    activeTabNodeId?: NodeId;
    activeTabRowIndex?: number;
    totalRowCount: number;
    nodeCount: number;
    liveTabCount: number;
    matchCount: number;
  };
  coverage?: ProjectionSliceCoverage;
  hydrating: boolean;
  // Set when the snapshot was served from the persisted boot-snapshot key because the
  // background's own state load had not finished: it can predate journal-replayed changes,
  // so the sidebar must converge on background truth without waiting for interaction.
  fromStorage?: true;
};

export type InitialTreeSnapshotOptions = {
  revision?: number;
  rowLimit?: number;
  hydrating?: boolean;
  centerRowIndex?: number;
  targetNodeId?: NodeId;
  query?: string;
};

type InitialTreeProjection = {
  query: string;
  rows: InitialTreeRow[];
  matchingNodeIds: Set<NodeId>;
  activeTabNodeId?: NodeId;
  activeTabRowIndex?: number;
  nodeCount: number;
  liveTabCount: number;
};

export type InitialTreeSnapshotProjector = {
  snapshotForState(state: OutlineState, options?: InitialTreeSnapshotOptions): InitialTreeSnapshot;
  clear(): void;
};

export type InitialTreeSnapshotProjectorOptions = {
  onProjectionBuilt?: (detail: {
    query: string;
    rowCount: number;
    nodeCount: number;
    matchCount: number;
  }) => void;
};

export function initialTreeSnapshotForState(
  state: OutlineState,
  options: InitialTreeSnapshotOptions = {}
): InitialTreeSnapshot {
  const query = normalizeInitialSnapshotQuery(options.query ?? "");
  return initialTreeSnapshotFromProjection(
    state,
    buildInitialTreeProjection(state, query),
    options
  );
}

export function createInitialTreeSnapshotProjector(
  options: InitialTreeSnapshotProjectorOptions = {}
): InitialTreeSnapshotProjector {
  let cachedSearchProjection:
    | {
        state: OutlineState;
        query: string;
        projection: InitialTreeProjection;
      }
    | undefined;

  const projectionForState = (state: OutlineState, rawQuery: string): InitialTreeProjection => {
    const query = normalizeInitialSnapshotQuery(rawQuery);
    if (
      query &&
      cachedSearchProjection?.state === state &&
      cachedSearchProjection.query === query
    ) {
      return cachedSearchProjection.projection;
    }

    const projection = buildInitialTreeProjection(state, query);
    options.onProjectionBuilt?.({
      query,
      rowCount: projection.rows.length,
      nodeCount: projection.nodeCount,
      matchCount: projection.matchingNodeIds.size
    });
    if (query) {
      cachedSearchProjection = {
        state,
        query,
        projection
      };
    }
    return projection;
  };

  return {
    snapshotForState(state: OutlineState, snapshotOptions: InitialTreeSnapshotOptions = {}) {
      return initialTreeSnapshotFromProjection(
        state,
        projectionForState(state, snapshotOptions.query ?? ""),
        snapshotOptions
      );
    },
    clear() {
      cachedSearchProjection = undefined;
    }
  };
}

function buildInitialTreeProjection(state: OutlineState, query: string): InitialTreeProjection {
  const allRows: InitialTreeRow[] = [];
  const entries = collectInitialSnapshotOrderEntries(state);
  const matchingNodeIds = new Set<NodeId>();
  const visibleNodeIdSet = new Set<NodeId>();
  let activeTabNodeId: NodeId | undefined;
  let activeTabRowIndex: number | undefined;

  for (const entry of entries) {
    const node = state.nodes[entry.nodeId];
    if (!node) {
      continue;
    }
    if (
      !activeTabNodeId &&
      node.kind === "tab" &&
      node.active &&
      entry.insideActiveWindow &&
      !isOutlinerSidebarNode(node)
    ) {
      activeTabNodeId = node.id;
    }
    if (query && initialSnapshotNodeMatchesQuery(node, query)) {
      matchingNodeIds.add(node.id);
      visibleNodeIdSet.add(node.id);
    }
  }

  if (query) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (!visibleNodeIdSet.has(entry.nodeId)) {
        continue;
      }

      const parentId = state.nodes[entry.nodeId]?.parentId;
      if (parentId) {
        visibleNodeIdSet.add(parentId);
      }
    }
  }

  for (const entry of entries) {
    const node = state.nodes[entry.nodeId];
    if (!node) {
      continue;
    }

    const isVisible = query ? visibleNodeIdSet.has(node.id) : !entry.hiddenByCollapse;
    if (!isVisible) {
      continue;
    }

    const visibleChildCount = query
      ? node.childIds.filter((childId) => visibleNodeIdSet.has(childId)).length
      : node.collapsed
        ? 0
        : node.childIds.length;
    const isSearchMatch = query ? matchingNodeIds.has(node.id) : false;
    const index = allRows.length;
    if (node.id === activeTabNodeId) {
      activeTabRowIndex = index;
    }

    allRows.push({
      nodeId: node.id,
      depth: entry.depth,
      index,
      subtreeEndIndex: index + 1,
      childCount: node.childIds.length,
      visibleChildCount,
      expanded: query ? visibleChildCount > 0 : !node.collapsed,
      searchRevealsCollapsedChildren: Boolean(query && node.collapsed && visibleChildCount > 0),
      isSearchMatch,
      isSearchPath: Boolean(query && !isSearchMatch),
      insideActiveWindow: entry.insideActiveWindow
    });
  }

  refreshInitialRowStructure(allRows);
  const nodeValues = Object.values(state.nodes);
  return {
    query,
    rows: allRows,
    matchingNodeIds,
    ...(activeTabNodeId ? { activeTabNodeId } : {}),
    ...(typeof activeTabRowIndex === "number" ? { activeTabRowIndex } : {}),
    nodeCount: nodeValues.length,
    liveTabCount: nodeValues.filter((node) => isLiveTabNode(node)).length
  };
}

function initialTreeSnapshotFromProjection(
  state: OutlineState,
  projection: InitialTreeProjection,
  options: InitialTreeSnapshotOptions
): InitialTreeSnapshot {
  const revision = options.revision ?? Date.now();
  const rowLimit = options.rowLimit ?? INITIAL_TREE_SNAPSHOT_ROW_LIMIT;
  const targetRowIndex = options.targetNodeId
    ? projection.rows.find((row) => row.nodeId === options.targetNodeId)?.index
    : undefined;
  const rows = initialSnapshotRows(
    projection.rows,
    rowLimit,
    projection.query ? undefined : projection.activeTabRowIndex,
    targetRowIndex ?? options.centerRowIndex
  );
  const loadedNodeIds = new Set<NodeId>();
  for (const row of rows) {
    loadedNodeIds.add(row.nodeId);
  }
  const coverage = projectionSliceCoverageForRows(state, rows, loadedNodeIds);
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
      query: projection.query,
      isSearchActive: Boolean(projection.query),
      rows,
      matchingNodeIds: rows
        .filter((row) => projection.matchingNodeIds.has(row.nodeId))
        .map((row) => row.nodeId),
      visibleNodeIds: rows.map((row) => row.nodeId),
      ...(projection.activeTabNodeId ? { activeTabNodeId: projection.activeTabNodeId } : {}),
      ...(typeof projection.activeTabRowIndex === "number"
        ? { activeTabRowIndex: projection.activeTabRowIndex }
        : {}),
      totalRowCount: projection.rows.length,
      nodeCount: projection.nodeCount,
      liveTabCount: projection.liveTabCount,
      matchCount: projection.matchingNodeIds.size
    },
    coverage,
    hydrating: options.hydrating ?? true
  };
}

function collectInitialSnapshotOrderEntries(state: OutlineState): InitialSnapshotOrderEntry[] {
  const entries: InitialSnapshotOrderEntry[] = [];
  const visited = new Set<NodeId>();
  const stack = state.rootIds
    .slice()
    .reverse()
    .map((nodeId) => ({
      nodeId,
      depth: 0,
      hiddenByCollapse: false,
      insideActiveWindow: false
    }));

  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (visited.has(entry.nodeId)) {
      continue;
    }
    visited.add(entry.nodeId);

    const node = state.nodes[entry.nodeId];
    if (!node) {
      continue;
    }

    const insideActiveWindow =
      entry.insideActiveWindow || Boolean(node.kind === "window" && node.active);
    entries.push({
      ...entry,
      insideActiveWindow
    });
    const childrenHiddenByCollapse = entry.hiddenByCollapse || node.collapsed;
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push({
        nodeId: node.childIds[index]!,
        depth: entry.depth + 1,
        hiddenByCollapse: childrenHiddenByCollapse,
        insideActiveWindow
      });
    }
  }

  return entries;
}

function normalizeInitialSnapshotQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function initialSnapshotNodeMatchesQuery(node: OutlineNode, query: string): boolean {
  return (
    initialSnapshotTextMatchesQuery(node.title, query) ||
    initialSnapshotTextMatchesQuery(node.url, query)
  );
}

function initialSnapshotTextMatchesQuery(value: string | undefined, query: string): boolean {
  return Boolean(value?.toLocaleLowerCase().includes(query));
}

function projectionSliceCoverageForRows(
  state: OutlineState,
  rows: InitialTreeRow[],
  loadedNodeIds: ReadonlySet<NodeId>
): ProjectionSliceCoverage {
  const startRowIndex = rows[0]?.index ?? 0;
  const endRowIndex = rows.length > 0 ? (rows.at(-1)?.index ?? startRowIndex) + 1 : startRowIndex;
  const editableNodeIds: NodeId[] = [];
  const completeSubtreeNodeIds: NodeId[] = [];
  const completeSiblingParentIds: NodeId[] = [];

  for (const row of rows) {
    const node = state.nodes[row.nodeId];
    if (!node) {
      continue;
    }
    editableNodeIds.push(node.id);
    if (row.index >= startRowIndex && row.subtreeEndIndex <= endRowIndex) {
      completeSubtreeNodeIds.push(node.id);
    }
    if (node.childIds.every((childId) => loadedNodeIds.has(childId))) {
      completeSiblingParentIds.push(node.id);
    }
  }

  return {
    startRowIndex,
    endRowIndex,
    editableNodeIds,
    completeSubtreeNodeIds,
    completeSiblingParentIds
  };
}

function initialSnapshotRows(
  rows: InitialTreeRow[],
  rowLimit: number,
  activeTabRowIndex: number | undefined,
  centerRowIndex?: number
): InitialTreeRow[] {
  if (typeof centerRowIndex === "number" && Number.isFinite(centerRowIndex)) {
    return centeredInitialSnapshotRows(rows, rowLimit, centerRowIndex);
  }

  if (typeof activeTabRowIndex !== "number" || activeTabRowIndex < rowLimit) {
    return rows.slice(0, rowLimit).map((row) => ({ ...row }));
  }

  return centeredInitialSnapshotRows(rows, rowLimit, activeTabRowIndex);
}

function centeredInitialSnapshotRows(
  rows: InitialTreeRow[],
  rowLimit: number,
  centerRowIndex: number
): InitialTreeRow[] {
  const halfWindow = Math.floor(rowLimit / 2);
  const center = Math.max(0, Math.min(rows.length - 1, Math.floor(centerRowIndex)));
  const end = Math.min(rows.length, center + halfWindow);
  const start = Math.max(0, Math.min(center - halfWindow, end - rowLimit));
  return rows.slice(start, Math.min(rows.length, start + rowLimit)).map((row) => ({ ...row }));
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

export function cloneInitialTreeSnapshot(
  snapshot: InitialTreeSnapshot,
  hydrating: boolean
): InitialTreeSnapshot {
  return {
    ...snapshot,
    hydrating,
    state: {
      version: 1,
      rootIds: [...snapshot.state.rootIds],
      nodes: Object.fromEntries(
        Object.entries(snapshot.state.nodes).map(([nodeId, node]) => [
          nodeId,
          { ...node, childIds: [...node.childIds] }
        ])
      )
    },
    projection: {
      ...snapshot.projection,
      rows: snapshot.projection.rows.map((row) => ({ ...row })),
      matchingNodeIds: [...snapshot.projection.matchingNodeIds],
      visibleNodeIds: [...snapshot.projection.visibleNodeIds]
    },
    ...(snapshot.coverage
      ? {
          coverage: {
            startRowIndex: snapshot.coverage.startRowIndex,
            endRowIndex: snapshot.coverage.endRowIndex,
            editableNodeIds: [...snapshot.coverage.editableNodeIds],
            completeSubtreeNodeIds: [...snapshot.coverage.completeSubtreeNodeIds],
            completeSiblingParentIds: [...snapshot.coverage.completeSiblingParentIds]
          }
        }
      : {})
  };
}

export function isOutlineState(value: unknown): value is OutlineState {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as OutlineState).version === 1 &&
    Array.isArray((value as OutlineState).rootIds) &&
    typeof (value as OutlineState).nodes === "object"
  );
}

export function isInitialTreeSnapshot(value: unknown): value is InitialTreeSnapshot {
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
