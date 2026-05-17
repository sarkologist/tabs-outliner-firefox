import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";

export type VisibleTreeRow = {
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

export type VisibleTreeProjection = {
  query: string;
  isSearchActive: boolean;
  rows: VisibleTreeRow[];
  matchingNodeIds: Set<NodeId>;
  visibleNodeIds: NodeId[];
  visibleNodeIdSet: Set<NodeId>;
  activeTabNodeId?: NodeId;
  activeTabRowIndex?: number;
  nodeCount: number;
  closedCount: number;
  matchCount: number;
};

export type VirtualRange = {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
};

export type DeleteTreeStructurePatch = {
  deletedNodeIds: NodeId[];
  updatedNodes: OutlineNode[];
  rootIds: NodeId[];
  deletedClosedCount: number;
};

type OutlineOrderEntry = {
  nodeId: NodeId;
  depth: number;
  hiddenByCollapse: boolean;
  insideActiveWindow: boolean;
};

type StackEntry = {
  nodeId: NodeId;
  depth: number;
  hiddenByCollapse: boolean;
  insideActiveWindow: boolean;
};

export function buildVisibleTreeProjection(state: OutlineState, rawQuery: string): VisibleTreeProjection {
  const query = normalizeSearchQuery(rawQuery);
  const entries = collectOutlineOrderEntries(state);
  const matchingNodeIds = new Set<NodeId>();
  const visibleNodeIdSet = new Set<NodeId>();
  let activeTabNodeId: NodeId | undefined;
  let activeTabRowIndex: number | undefined;
  let closedCount = 0;

  for (const entry of entries) {
    const node = state.nodes[entry.nodeId];
    if (!node) {
      continue;
    }
    if (node.status === "closed") {
      closedCount += 1;
    }
    if (!activeTabNodeId && node.kind === "tab" && node.active && entry.insideActiveWindow) {
      activeTabNodeId = node.id;
    }
    if (query && nodeMatchesQuery(node, query)) {
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

  const rows: VisibleTreeRow[] = [];
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
      : node.childIds.length;
    const isSearchMatch = query ? matchingNodeIds.has(node.id) : false;
    const rowIndex = rows.length;
    if (node.id === activeTabNodeId) {
      activeTabRowIndex = rowIndex;
    }
    rows.push({
      nodeId: node.id,
      depth: entry.depth,
      index: rowIndex,
      subtreeEndIndex: rowIndex + 1,
      childCount: node.childIds.length,
      visibleChildCount,
      expanded: query ? visibleChildCount > 0 : !node.collapsed,
      searchRevealsCollapsedChildren: Boolean(query && node.collapsed && visibleChildCount > 0),
      isSearchMatch,
      isSearchPath: Boolean(query && !isSearchMatch),
      insideActiveWindow: entry.insideActiveWindow
    });
  }
  refreshVisibleRowStructure(rows);

  return {
    query,
    isSearchActive: Boolean(query),
    rows,
    matchingNodeIds,
    visibleNodeIds: rows.map((row) => row.nodeId),
    visibleNodeIdSet: query ? visibleNodeIdSet : new Set(rows.map((row) => row.nodeId)),
    ...(activeTabNodeId ? { activeTabNodeId } : {}),
    ...(typeof activeTabRowIndex === "number" ? { activeTabRowIndex } : {}),
    nodeCount: entries.length,
    closedCount,
    matchCount: matchingNodeIds.size
  };
}

export function refreshVisibleRowStructure(rows: VisibleTreeRow[]): void {
  const openRowIndexesByDepth: number[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const depth = Math.max(0, Math.floor(row.depth));

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

  for (const openRowIndex of openRowIndexesByDepth) {
    if (typeof openRowIndex === "number") {
      rows[openRowIndex]!.subtreeEndIndex = rows.length;
    }
  }
}

export function applyDeleteTreeStructurePatchToProjection(
  state: OutlineState,
  projection: VisibleTreeProjection,
  patch: DeleteTreeStructurePatch
): boolean {
  if (patch.deletedNodeIds.length === 0) {
    return false;
  }

  const deletedNodeIds = new Set(patch.deletedNodeIds);
  const affectedNodeIds = new Set(patch.updatedNodes.map((node) => node.id));
  const deletedRows: VisibleTreeRow[] = [];
  let deletedMatches = 0;
  for (const row of projection.rows) {
    if (!deletedNodeIds.has(row.nodeId)) {
      continue;
    }
    deletedRows.push(row);
    if (typeof row.parentRowIndex === "number") {
      const parentRow = projection.rows[row.parentRowIndex];
      if (parentRow && !deletedNodeIds.has(parentRow.nodeId)) {
        affectedNodeIds.add(parentRow.nodeId);
      }
    }
  }

  for (const nodeId of deletedNodeIds) {
    projection.visibleNodeIdSet.delete(nodeId);
    if (projection.matchingNodeIds.delete(nodeId)) {
      deletedMatches += 1;
    }
  }

  projection.rows = projection.rows.filter((row) => !deletedNodeIds.has(row.nodeId) && Boolean(state.nodes[row.nodeId]));
  projection.nodeCount = Math.max(0, projection.nodeCount - patch.deletedNodeIds.length);
  projection.closedCount = Math.max(0, projection.closedCount - patch.deletedClosedCount);
  projection.matchCount = Math.max(0, projection.matchCount - deletedMatches);

  if (!projection.isSearchActive) {
    refreshNonSearchDeleteProjection(state, projection, patch, deletedNodeIds, deletedRows);
    return true;
  }

  const rowsByNodeId = new Map(projection.rows.map((row) => [row.nodeId, row]));
  for (const nodeId of affectedNodeIds) {
    const row = rowsByNodeId.get(nodeId);
    if (row) {
      refreshRowFromState(state, projection, row);
    }
  }

  const prunedRows = pruneEmptySearchPathRows(state, projection, rowsByNodeId, affectedNodeIds);

  refreshVisibleRowStructureAfterDelete(projection.rows, [...deletedRows, ...prunedRows]);
  projection.visibleNodeIds = projection.rows.map((row) => row.nodeId);
  projection.visibleNodeIdSet = new Set(projection.visibleNodeIds);
  refreshProjectionActiveTabTargetAfterDelete(state, projection, rowsByNodeId);
  return true;
}

export function calculateVirtualRange(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number
): VirtualRange {
  const boundedRowCount = Math.max(0, rowCount);
  const effectiveRowHeight = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 1;
  const effectiveViewportHeight = Math.max(0, viewportHeight);
  const effectiveOverscan = Math.max(0, Math.floor(overscan));
  const firstVisible = Math.floor(Math.max(0, scrollTop) / effectiveRowHeight);
  const visibleCount = Math.ceil(effectiveViewportHeight / effectiveRowHeight);
  const start = Math.max(0, firstVisible - effectiveOverscan);
  const end = Math.min(boundedRowCount, firstVisible + visibleCount + effectiveOverscan);

  return {
    start,
    end: Math.max(start, end),
    offsetTop: start * effectiveRowHeight,
    totalHeight: boundedRowCount * effectiveRowHeight
  };
}

export function normalizeSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function collectOutlineOrderEntries(state: OutlineState): OutlineOrderEntry[] {
  const result: OutlineOrderEntry[] = [];
  const visited = new Set<NodeId>();
  const stack: StackEntry[] = [];

  for (let index = state.rootIds.length - 1; index >= 0; index -= 1) {
    stack.push({
      nodeId: state.rootIds[index]!,
      depth: 0,
      hiddenByCollapse: false,
      insideActiveWindow: false
    });
  }

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

    result.push(entry);
    const childInsideActiveWindow = entry.insideActiveWindow || Boolean(node.kind === "window" && node.active);
    const childrenHiddenByCollapse = entry.hiddenByCollapse || node.collapsed;
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push({
        nodeId: node.childIds[index]!,
        depth: entry.depth + 1,
        hiddenByCollapse: childrenHiddenByCollapse,
        insideActiveWindow: childInsideActiveWindow
      });
    }
  }

  return result;
}

function nodeMatchesQuery(node: OutlineNode, query: string): boolean {
  return textMatchesQuery(node.title, query) || textMatchesQuery(node.url, query);
}

function textMatchesQuery(value: string | undefined, query: string): boolean {
  return Boolean(value?.toLocaleLowerCase().includes(query));
}

function refreshNonSearchDeleteProjection(
  state: OutlineState,
  projection: VisibleTreeProjection,
  patch: DeleteTreeStructurePatch,
  deletedNodeIds: Set<NodeId>,
  deletedRows: VisibleTreeRow[]
): void {
  const updatedNodes = new Map(patch.updatedNodes.map((node) => [node.id, node]));
  const activeNodeId = projection.activeTabNodeId;
  const activeRowIndex = projection.activeTabRowIndex;

  refreshVisibleRowStructureAfterDelete(projection.rows, deletedRows);
  projection.visibleNodeIds = projection.rows.map((row) => row.nodeId);
  projection.visibleNodeIdSet = new Set(projection.visibleNodeIds);

  for (const row of projection.rows) {
    const node = updatedNodes.get(row.nodeId);
    if (!node) {
      continue;
    }
    row.childCount = node.childIds.length;
    row.visibleChildCount = node.childIds.length;
    row.expanded = !node.collapsed;
    row.searchRevealsCollapsedChildren = false;
    row.isSearchMatch = false;
    row.isSearchPath = false;
  }

  delete projection.activeTabNodeId;
  delete projection.activeTabRowIndex;
  if (!activeNodeId || deletedNodeIds.has(activeNodeId) || !state.nodes[activeNodeId]) {
    return;
  }
  projection.activeTabNodeId = activeNodeId;
  if (typeof activeRowIndex === "number") {
    const deletedRowsBeforeActive = deletedRows.filter((row) => row.index < activeRowIndex).length;
    projection.activeTabRowIndex = Math.max(0, activeRowIndex - deletedRowsBeforeActive);
  }
}

function pruneEmptySearchPathRows(
  state: OutlineState,
  projection: VisibleTreeProjection,
  rowsByNodeId: Map<NodeId, VisibleTreeRow>,
  affectedNodeIds: Set<NodeId>
): VisibleTreeRow[] {
  const queue = [...affectedNodeIds];
  const queued = new Set(queue);
  const prunedNodeIds = new Set<NodeId>();
  const prunedRows: VisibleTreeRow[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const row = rowsByNodeId.get(nodeId);
    if (!row) {
      continue;
    }

    refreshRowFromState(state, projection, row);
    if (!row.isSearchPath || row.visibleChildCount > 0) {
      continue;
    }

    prunedNodeIds.add(nodeId);
    prunedRows.push(row);
    rowsByNodeId.delete(nodeId);
    projection.visibleNodeIdSet.delete(nodeId);

    const parentId = state.nodes[nodeId]?.parentId;
    if (parentId && !queued.has(parentId)) {
      queued.add(parentId);
      queue.push(parentId);
    }
  }

  if (prunedNodeIds.size > 0) {
    projection.rows = projection.rows.filter((row) => !prunedNodeIds.has(row.nodeId));
  }
  return prunedRows;
}

function refreshRowFromState(state: OutlineState, projection: VisibleTreeProjection, row: VisibleTreeRow): void {
  const node = state.nodes[row.nodeId];
  if (!node) {
    return;
  }

  row.childCount = node.childIds.length;
  row.visibleChildCount = projection.isSearchActive
    ? node.childIds.filter((childId) => projection.visibleNodeIdSet.has(childId)).length
    : node.childIds.length;
  row.expanded = projection.isSearchActive ? row.visibleChildCount > 0 : !node.collapsed;
  row.searchRevealsCollapsedChildren = Boolean(
    projection.isSearchActive &&
      node.collapsed &&
      row.visibleChildCount > 0
  );
  row.isSearchMatch = projection.isSearchActive && projection.matchingNodeIds.has(row.nodeId);
  row.isSearchPath = projection.isSearchActive && !row.isSearchMatch;
}

function refreshVisibleRowStructureAfterDelete(rows: VisibleTreeRow[], removedRows: VisibleTreeRow[]): void {
  if (removedRows.length === 0) {
    return;
  }

  const removedIndexes = removedRows
    .map((row) => row.index)
    .sort((left, right) => left - right);
  const firstRemovedIndex = removedIndexes[0]!;
  for (const row of rows) {
    if (
      row.index < firstRemovedIndex &&
      row.subtreeEndIndex <= firstRemovedIndex &&
      (typeof row.parentRowIndex !== "number" || row.parentRowIndex < firstRemovedIndex)
    ) {
      continue;
    }

    const previousIndex = row.index;
    row.index = previousIndex - countLessThan(removedIndexes, previousIndex);
    row.subtreeEndIndex -= countLessThan(removedIndexes, row.subtreeEndIndex);
    if (typeof row.parentRowIndex === "number") {
      row.parentRowIndex -= countLessThan(removedIndexes, row.parentRowIndex);
    }
  }
}

function countLessThan(sortedValues: number[], target: number): number {
  let low = 0;
  let high = sortedValues.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (sortedValues[mid]! < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function refreshProjectionActiveTabTargetAfterDelete(
  state: OutlineState,
  projection: VisibleTreeProjection,
  rowsByNodeId: Map<NodeId, VisibleTreeRow>
): void {
  const currentActiveNodeId = projection.activeTabNodeId;
  delete projection.activeTabNodeId;
  delete projection.activeTabRowIndex;

  if (!currentActiveNodeId || !state.nodes[currentActiveNodeId]) {
    return;
  }

  projection.activeTabNodeId = currentActiveNodeId;
  const activeRow = rowsByNodeId.get(currentActiveNodeId);
  if (activeRow?.insideActiveWindow) {
    const node = state.nodes[currentActiveNodeId];
    if (node?.kind === "tab" && node.active) {
      projection.activeTabRowIndex = activeRow.index;
    }
  }
}
