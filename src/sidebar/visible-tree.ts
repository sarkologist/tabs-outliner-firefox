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
