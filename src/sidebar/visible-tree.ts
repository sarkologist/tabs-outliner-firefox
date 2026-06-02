import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import { isOutlinerSidebarNode } from "../model/outliner-page.js";

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
  totalRowCount?: number;
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

export type SameParentReorderPatchInfo = {
  parentId: NodeId;
  parentRowIndex: number;
  movedNodeId: NodeId;
  movedStart: number;
  movedEnd: number;
  movedSize: number;
  insertionIndex: number;
};

export type DeleteTreeStructurePatch = {
  deletedNodeIds: NodeId[];
  updatedNodes: OutlineNode[];
  rootIds: NodeId[];
  deletedClosedCount: number;
};

export type InsertTreeStructurePatch = DeleteTreeStructurePatch;

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

type RowRemovalRange = {
  start: number;
  end: number;
};

type InsertedRowsPlan = {
  rows: VisibleTreeRow[];
  removedRanges: RowRemovalRange[];
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
    if (
      !activeTabNodeId &&
      node.kind === "tab" &&
      node.active &&
      entry.insideActiveWindow &&
      !isOutlinerSidebarNode(node)
    ) {
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
  if (applyTrailingLeafDeletePatchToProjection(state, projection, patch, deletedNodeIds)) {
    return true;
  }

  const affectedNodeIds = new Set(patch.updatedNodes.map((node) => node.id));
  const deletedRows: VisibleTreeRow[] = [];
  const rowsByNodeIdBeforeDelete = new Map(projection.rows.map((row) => [row.nodeId, row]));
  if (deletePatchRelocatesVisibleRows(projection, patch, rowsByNodeIdBeforeDelete)) {
    return false;
  }

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

export function applySameParentReorderTreeStructurePatchToProjection(
  state: OutlineState,
  projection: VisibleTreeProjection,
  patch: InsertTreeStructurePatch
): boolean {
  const info = sameParentReorderTreeStructurePatchInfo(state, projection, patch);
  if (!info) {
    return false;
  }

  const movedRows = projection.rows.splice(info.movedStart, info.movedSize);
  projection.rows.splice(info.insertionIndex, 0, ...movedRows);
  const movedVisibleNodeIds = projection.visibleNodeIds.splice(info.movedStart, info.movedSize);
  projection.visibleNodeIds.splice(info.insertionIndex, 0, ...movedVisibleNodeIds);
  if (!refreshLeafSameParentReorderRows(projection.rows, info)) {
    refreshVisibleRowStructure(projection.rows);
  }
  refreshRowsFromUpdatedNodes(state, projection, patch.updatedNodes);
  return true;
}

export function sameParentReorderTreeStructurePatchInfo(
  state: OutlineState,
  projection: VisibleTreeProjection,
  patch: InsertTreeStructurePatch
): SameParentReorderPatchInfo | undefined {
  if (projection.isSearchActive || patch.deletedNodeIds.length > 0) {
    return undefined;
  }

  const updatedNodeIds = new Set(patch.updatedNodes.map((node) => node.id));
  const movedNodes = patch.updatedNodes.filter((node) => node.parentId && updatedNodeIds.has(node.parentId));
  if (movedNodes.length !== 1) {
    return undefined;
  }

  const movedNode = movedNodes[0];
  const parentId = movedNode?.parentId;
  const parentNode = parentId ? state.nodes[parentId] : undefined;
  if (!movedNode || !parentId || !parentNode) {
    return undefined;
  }

  const parentRow = projection.rows.find((row) => row.nodeId === parentId);
  const movedRow = projection.rows.find((row) => row.nodeId === movedNode.id);
  if (!parentRow || !movedRow || !parentRow.expanded || movedRow.parentRowIndex !== parentRow.index) {
    return undefined;
  }

  const targetChildOffset = parentNode.childIds.indexOf(movedNode.id);
  if (targetChildOffset < 0 || !projectionHasAllDirectChildren(projection, parentRow, parentNode.childIds.length)) {
    return undefined;
  }

  const movedStart = movedRow.index;
  const movedEnd = movedRow.subtreeEndIndex;
  const movedSize = movedEnd - movedStart;
  let insertionIndex = parentRow.index + 1;
  if (targetChildOffset > 0) {
    const previousSiblingId = parentNode.childIds[targetChildOffset - 1];
    const previousSiblingRow = previousSiblingId
      ? projection.rows.find((row) => row.nodeId === previousSiblingId)
      : undefined;
    if (!previousSiblingRow || previousSiblingRow.parentRowIndex !== parentRow.index) {
      return undefined;
    }
    insertionIndex = previousSiblingRow.subtreeEndIndex;
  }
  if (insertionIndex > movedStart) {
    insertionIndex -= movedSize;
  }

  return {
    parentId,
    parentRowIndex: parentRow.index,
    movedNodeId: movedNode.id,
    movedStart,
    movedEnd,
    movedSize,
    insertionIndex
  };
}

function refreshLeafSameParentReorderRows(
  rows: VisibleTreeRow[],
  info: SameParentReorderPatchInfo
): boolean {
  if (info.movedSize !== 1) {
    return false;
  }

  const parentRow = rows[info.parentRowIndex];
  if (!parentRow || parentRow.nodeId !== info.parentId) {
    return false;
  }

  const changedStart = Math.min(info.movedStart, info.insertionIndex);
  const changedEnd = Math.max(info.movedEnd, info.insertionIndex + info.movedSize);
  const childDepth = parentRow.depth + 1;
  for (let index = changedStart; index < changedEnd; index += 1) {
    const row = rows[index];
    if (
      !row ||
      row.depth !== childDepth ||
      row.parentRowIndex !== parentRow.index ||
      row.subtreeEndIndex !== row.index + 1
    ) {
      return false;
    }
  }

  for (let index = changedStart; index < changedEnd; index += 1) {
    const row = rows[index]!;
    row.index = index;
    row.parentRowIndex = parentRow.index;
    row.subtreeEndIndex = index + 1;
  }
  return true;
}

function projectionHasAllDirectChildren(
  projection: VisibleTreeProjection,
  parentRow: VisibleTreeRow,
  childCount: number
): boolean {
  if (typeof projection.totalRowCount !== "number" || projection.totalRowCount === projection.rows.length) {
    return parentRow.visibleChildCount === childCount;
  }
  return directChildCountForRow(projection.rows, parentRow) === childCount;
}

function directChildCountForRow(rows: readonly VisibleTreeRow[], parentRow: VisibleTreeRow): number {
  const childDepth = parentRow.depth + 1;
  let count = 0;
  let index = parentRow.index + 1;

  while (index < parentRow.subtreeEndIndex) {
    const row = rows[index];
    if (!row) {
      break;
    }
    if (row.depth !== childDepth) {
      index += 1;
      continue;
    }

    count += 1;
    index = row.subtreeEndIndex;
  }

  return count;
}

function refreshRowsFromUpdatedNodes(
  state: OutlineState,
  projection: VisibleTreeProjection,
  updatedNodes: readonly OutlineNode[]
): void {
  for (const node of updatedNodes) {
    const row = projection.rows.find((candidate) => candidate.nodeId === node.id);
    if (!row) {
      continue;
    }

    row.childCount = node.childIds.length;
    row.visibleChildCount = node.collapsed ? 0 : node.childIds.length;
    row.expanded = !node.collapsed;
    row.insideActiveWindow = isRowInsideActiveWindow(state, projection.rows, row);
  }
}

function isRowInsideActiveWindow(
  state: OutlineState,
  rows: readonly VisibleTreeRow[],
  row: VisibleTreeRow
): boolean {
  if (row.depth === 0) {
    return false;
  }

  let parentRowIndex = row.parentRowIndex;
  while (typeof parentRowIndex === "number") {
    const parentRow = rows[parentRowIndex];
    const parentNode = parentRow ? state.nodes[parentRow.nodeId] : undefined;
    if (parentNode?.kind === "window" && parentNode.active) {
      return true;
    }
    parentRowIndex = parentRow?.parentRowIndex;
  }

  return false;
}

function applyTrailingLeafDeletePatchToProjection(
  state: OutlineState,
  projection: VisibleTreeProjection,
  patch: DeleteTreeStructurePatch,
  deletedNodeIds: ReadonlySet<NodeId>
): boolean {
  if (
    projection.isSearchActive ||
    deletedNodeIds.size !== patch.deletedNodeIds.length ||
    projection.rows.length === 0 ||
    projection.visibleNodeIds.length !== projection.rows.length ||
    !sameNodeIdList(patch.rootIds, state.rootIds)
  ) {
    return false;
  }

  const deletedRows: VisibleTreeRow[] = [];
  let startIndex = projection.rows.length;
  for (let index = projection.rows.length - 1; index >= 0; index -= 1) {
    const row = projection.rows[index]!;
    if (!deletedNodeIds.has(row.nodeId)) {
      break;
    }
    if (
      projection.visibleNodeIds[index] !== row.nodeId ||
      row.subtreeEndIndex !== row.index + 1 ||
      typeof row.parentRowIndex !== "number" ||
      Boolean(state.nodes[row.nodeId])
    ) {
      return false;
    }
    deletedRows.push(row);
    startIndex = index;
  }

  if (deletedRows.length === 0 || deletedRows.length !== deletedNodeIds.size) {
    return false;
  }

  if (
    projection.activeTabNodeId &&
    (deletedNodeIds.has(projection.activeTabNodeId) || !state.nodes[projection.activeTabNodeId])
  ) {
    return false;
  }
  if (typeof projection.activeTabRowIndex === "number" && projection.activeTabRowIndex >= startIndex) {
    return false;
  }

  const removedCountByAncestorIndex = new Map<number, number>();
  const refreshRowIndexes = new Set<number>();
  for (const row of deletedRows) {
    let parentRowIndex = row.parentRowIndex;
    while (typeof parentRowIndex === "number") {
      if (parentRowIndex >= startIndex) {
        return false;
      }
      const parentRow = projection.rows[parentRowIndex];
      if (!parentRow) {
        return false;
      }
      removedCountByAncestorIndex.set(parentRowIndex, (removedCountByAncestorIndex.get(parentRowIndex) ?? 0) + 1);
      refreshRowIndexes.add(parentRowIndex);
      parentRowIndex = parentRow.parentRowIndex;
    }
  }

  const refreshRowIndexByNodeId = new Map<NodeId, number>();
  for (const rowIndex of refreshRowIndexes) {
    const row = projection.rows[rowIndex];
    if (row) {
      refreshRowIndexByNodeId.set(row.nodeId, rowIndex);
    }
  }

  for (const node of patch.updatedNodes) {
    if (deletedNodeIds.has(node.id) || !state.nodes[node.id] || !refreshRowIndexByNodeId.has(node.id)) {
      return false;
    }
  }

  let deletedMatches = 0;
  for (const nodeId of deletedNodeIds) {
    projection.visibleNodeIdSet.delete(nodeId);
    if (projection.matchingNodeIds.delete(nodeId)) {
      deletedMatches += 1;
    }
  }

  projection.rows.splice(startIndex);
  projection.visibleNodeIds.splice(startIndex);
  for (const [rowIndex, removedCount] of removedCountByAncestorIndex) {
    const row = projection.rows[rowIndex];
    if (row) {
      row.subtreeEndIndex = Math.max(row.index + 1, row.subtreeEndIndex - removedCount);
    }
  }
  for (const rowIndex of refreshRowIndexes) {
    const row = projection.rows[rowIndex];
    if (row) {
      refreshRowFromState(state, projection, row);
    }
  }

  projection.nodeCount = Math.max(0, projection.nodeCount - patch.deletedNodeIds.length);
  projection.closedCount = Math.max(0, projection.closedCount - patch.deletedClosedCount);
  projection.matchCount = Math.max(0, projection.matchCount - deletedMatches);
  return true;
}

function sameNodeIdList(left: readonly NodeId[], right: readonly NodeId[]): boolean {
  return left.length === right.length && left.every((nodeId, index) => nodeId === right[index]);
}

function deletePatchRelocatesVisibleRows(
  projection: VisibleTreeProjection,
  patch: DeleteTreeStructurePatch,
  rowsByNodeId: ReadonlyMap<NodeId, VisibleTreeRow>
): boolean {
  for (const node of patch.updatedNodes) {
    const row = rowsByNodeId.get(node.id);
    if (!row) {
      continue;
    }

    const previousParentId = typeof row.parentRowIndex === "number"
      ? projection.rows[row.parentRowIndex]?.nodeId
      : undefined;
    if (previousParentId !== node.parentId) {
      return true;
    }
  }
  return false;
}

export function applyInsertTreeStructurePatchToProjection(
  state: OutlineState,
  projection: VisibleTreeProjection,
  patch: InsertTreeStructurePatch
): boolean {
  if (projection.isSearchActive || patch.deletedNodeIds.length > 0 || patch.deletedClosedCount !== 0) {
    return false;
  }

  const existingVisibleNodeIds = new Set(projection.visibleNodeIds);
  const insertedNodeIds = new Set(
    patch.updatedNodes
      .map((node) => node.id)
      .filter((nodeId) => !existingVisibleNodeIds.has(nodeId) && Boolean(state.nodes[nodeId]))
  );
  if (insertedNodeIds.size === 0) {
    return false;
  }

  const insertedRowsByRoot = new Map<NodeId, InsertedRowsPlan>();
  const insertionRoots = [...insertedNodeIds].filter((nodeId) => {
    const parentId = state.nodes[nodeId]?.parentId;
    return !parentId || !insertedNodeIds.has(parentId);
  });

  for (const rootNodeId of insertionRoots) {
    const insertionContext = insertionContextForNode(state, projection, rootNodeId, insertedNodeIds);
    if (!insertionContext) {
      return false;
    }

    const insertedRows = rowsForInsertedSubtree(
      state,
      rootNodeId,
      insertedNodeIds,
      insertionContext.depth,
      insertionContext.insideActiveWindow
    );
    if (insertedRows) {
      insertedRowsByRoot.set(rootNodeId, { rows: insertedRows, removedRanges: [] });
      continue;
    }

    const wrappedRows = rowsForInsertedExistingSubtreeWrapper(
      state,
      projection,
      rootNodeId,
      insertedNodeIds,
      insertionContext.depth,
      insertionContext.insideActiveWindow
    );
    if (!wrappedRows) {
      return false;
    }
    insertedRowsByRoot.set(rootNodeId, wrappedRows);
  }

  const orderedInsertions = insertionRoots
    .map((nodeId) => {
      const insertionContext = insertionContextForNode(state, projection, nodeId, insertedNodeIds);
      const plan = insertedRowsByRoot.get(nodeId);
      return insertionContext && plan
        ? {
            nodeId,
            index: insertionContext.index,
            rows: plan.rows,
            removedRanges: plan.removedRanges
          }
        : undefined;
    })
    .filter((entry): entry is {
      nodeId: NodeId;
      index: number;
      rows: VisibleTreeRow[];
      removedRanges: RowRemovalRange[];
    } => Boolean(entry))
    .sort((left, right) => left.index - right.index);

  if (orderedInsertions.length !== insertionRoots.length) {
    return false;
  }

  const removalRanges = normalizedRemovalRanges(orderedInsertions.flatMap((insertion) => insertion.removedRanges));
  if (!removalRanges) {
    return false;
  }
  if (!projectionPatchIndexesFitRenderedRows(projection, orderedInsertions, removalRanges)) {
    return false;
  }

  for (const insertion of orderedInsertions) {
    if (insertionIndexSplitsRemovalRange(insertion.index, removalRanges)) {
      return false;
    }
  }

  for (let index = removalRanges.length - 1; index >= 0; index -= 1) {
    const range = removalRanges[index]!;
    projection.rows.splice(range.start, range.end - range.start);
  }

  let insertedBefore = 0;
  for (const insertion of orderedInsertions) {
    const index = insertion.index - removedRowCountBeforeIndex(removalRanges, insertion.index) + insertedBefore;
    projection.rows.splice(index, 0, ...insertion.rows);
    insertedBefore += insertion.rows.length;
  }

  projection.nodeCount += insertedNodeIds.size;
  projection.closedCount += [...insertedNodeIds].filter((nodeId) => state.nodes[nodeId]?.status === "closed").length;
  projection.matchCount = 0;
  projection.matchingNodeIds.clear();
  refreshVisibleRowStructure(projection.rows);
  refreshRowsFromPatchNodes(state, projection, patch.updatedNodes);
  refreshProjectionActiveWindowFlags(state, projection);
  refreshProjectionActiveTabTarget(state, projection);
  projection.visibleNodeIds = projection.rows.map((row) => row.nodeId);
  projection.visibleNodeIdSet = new Set(projection.visibleNodeIds);
  return true;
}

function projectionPatchIndexesFitRenderedRows(
  projection: VisibleTreeProjection,
  insertions: readonly { index: number }[],
  removalRanges: readonly RowRemovalRange[]
): boolean {
  if (!projection.rows.every((row, index) => row.index === index)) {
    return false;
  }

  const rowCount = projection.rows.length;
  return insertions.every((insertion) => insertion.index >= 0 && insertion.index <= rowCount) &&
    removalRanges.every((range) => range.start >= 0 && range.end <= rowCount);
}

function normalizedRemovalRanges(ranges: RowRemovalRange[]): RowRemovalRange[] | undefined {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const normalized: RowRemovalRange[] = [];

  for (const range of sorted) {
    if (range.start < 0 || range.end > Number.MAX_SAFE_INTEGER) {
      return undefined;
    }
    const previous = normalized.at(-1);
    if (previous && previous.end > range.start) {
      return undefined;
    }
    normalized.push(range);
  }

  return normalized;
}

function insertionIndexSplitsRemovalRange(index: number, ranges: readonly RowRemovalRange[]): boolean {
  return ranges.some((range) => range.start < index && index < range.end);
}

function removedRowCountBeforeIndex(ranges: readonly RowRemovalRange[], index: number): number {
  let count = 0;
  for (const range of ranges) {
    if (range.end <= index) {
      count += range.end - range.start;
    }
  }
  return count;
}

function insertionContextForNode(
  state: OutlineState,
  projection: VisibleTreeProjection,
  nodeId: NodeId,
  insertedNodeIds: Set<NodeId>
): { index: number; depth: number; insideActiveWindow: boolean } | undefined {
  const node = state.nodes[nodeId];
  if (!node) {
    return undefined;
  }

  if (!node.parentId) {
    const rootIndex = state.rootIds.indexOf(nodeId);
    if (rootIndex < 0) {
      return undefined;
    }
    const previousRootId = previousExistingSiblingId(state.rootIds, rootIndex, insertedNodeIds);
    if (!previousRootId) {
      return {
        index: 0,
        depth: 0,
        insideActiveWindow: false
      };
    }
    const previousRootRow = projection.rows.find((row) => row.nodeId === previousRootId);
    return previousRootRow
      ? {
          index: previousRootRow.subtreeEndIndex,
          depth: 0,
          insideActiveWindow: false
        }
      : undefined;
  }

  const parent = state.nodes[node.parentId];
  const parentRow = projection.rows.find((row) => row.nodeId === node.parentId);
  if (!parent || !parentRow || !parentRow.expanded) {
    return undefined;
  }

  const childIndex = parent.childIds.indexOf(nodeId);
  if (childIndex < 0) {
    return undefined;
  }
  const previousSiblingId = previousExistingSiblingId(parent.childIds, childIndex, insertedNodeIds);
  const insideActiveWindow = parentRow.insideActiveWindow || Boolean(parent.kind === "window" && parent.active);
  if (!previousSiblingId) {
    return {
      index: parentRow.index + 1,
      depth: parentRow.depth + 1,
      insideActiveWindow
    };
  }

  const previousSiblingRow = projection.rows.find((row) => row.nodeId === previousSiblingId);
  return previousSiblingRow
    ? {
        index: previousSiblingRow.subtreeEndIndex,
        depth: parentRow.depth + 1,
        insideActiveWindow
      }
    : undefined;
}

function previousExistingSiblingId(
  siblingIds: readonly NodeId[],
  beforeIndex: number,
  insertedNodeIds: Set<NodeId>
): NodeId | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const siblingId = siblingIds[index];
    if (siblingId && !insertedNodeIds.has(siblingId)) {
      return siblingId;
    }
  }
  return undefined;
}

function rowsForInsertedSubtree(
  state: OutlineState,
  rootNodeId: NodeId,
  insertedNodeIds: Set<NodeId>,
  rootDepth: number,
  rootInsideActiveWindow: boolean
): VisibleTreeRow[] | undefined {
  const rows: VisibleTreeRow[] = [];
  const stack: StackEntry[] = [{
    nodeId: rootNodeId,
    depth: rootDepth,
    hiddenByCollapse: false,
    insideActiveWindow: rootInsideActiveWindow
  }];

  while (stack.length > 0) {
    const entry = stack.pop()!;
    const node = state.nodes[entry.nodeId];
    if (!node || !insertedNodeIds.has(node.id) || entry.hiddenByCollapse) {
      return undefined;
    }

    const childIds = node.childIds.filter((childId) => {
      if (!insertedNodeIds.has(childId)) {
        return false;
      }
      return Boolean(state.nodes[childId]);
    });
    if (childIds.length !== node.childIds.length) {
      return undefined;
    }

    rows.push({
      nodeId: node.id,
      depth: entry.depth,
      index: rows.length,
      subtreeEndIndex: rows.length + 1,
      childCount: node.childIds.length,
      visibleChildCount: node.childIds.length,
      expanded: !node.collapsed,
      searchRevealsCollapsedChildren: false,
      isSearchMatch: false,
      isSearchPath: false,
      insideActiveWindow: entry.insideActiveWindow
    });

    const childInsideActiveWindow = entry.insideActiveWindow || Boolean(node.kind === "window" && node.active);
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      stack.push({
        nodeId: childIds[index]!,
        depth: entry.depth + 1,
        hiddenByCollapse: node.collapsed,
        insideActiveWindow: childInsideActiveWindow
      });
    }
  }

  refreshVisibleRowStructure(rows);
  return rows;
}

function rowsForInsertedExistingSubtreeWrapper(
  state: OutlineState,
  projection: VisibleTreeProjection,
  rootNodeId: NodeId,
  insertedNodeIds: Set<NodeId>,
  rootDepth: number,
  rootInsideActiveWindow: boolean
): InsertedRowsPlan | undefined {
  const node = state.nodes[rootNodeId];
  if (!node || !insertedNodeIds.has(node.id) || node.collapsed || node.childIds.length === 0) {
    return undefined;
  }

  const rowsByNodeId = new Map(projection.rows.map((row) => [row.nodeId, row]));
  const removedRanges: RowRemovalRange[] = [];
  const movedRows: VisibleTreeRow[] = [];
  let previousEndIndex: number | undefined;
  let depthDelta: number | undefined;

  for (const childId of node.childIds) {
    if (insertedNodeIds.has(childId)) {
      return undefined;
    }

    const childRow = rowsByNodeId.get(childId);
    if (!childRow) {
      return undefined;
    }
    if (typeof previousEndIndex === "number" && childRow.index !== previousEndIndex) {
      return undefined;
    }

    const nextDepthDelta = rootDepth + 1 - childRow.depth;
    if (typeof depthDelta === "number" && depthDelta !== nextDepthDelta) {
      return undefined;
    }
    depthDelta = nextDepthDelta;

    const range = {
      start: childRow.index,
      end: childRow.subtreeEndIndex
    };
    removedRanges.push(range);
    previousEndIndex = range.end;

    for (let index = range.start; index < range.end; index += 1) {
      const row = projection.rows[index];
      if (!row) {
        return undefined;
      }
      const depth = row.depth + nextDepthDelta;
      if (depth < 0) {
        return undefined;
      }
      movedRows.push({
        ...row,
        depth
      });
    }
  }

  const wrapperRow: VisibleTreeRow = {
    nodeId: node.id,
    depth: rootDepth,
    index: 0,
    subtreeEndIndex: movedRows.length + 1,
    childCount: node.childIds.length,
    visibleChildCount: node.childIds.length,
    expanded: true,
    searchRevealsCollapsedChildren: false,
    isSearchMatch: false,
    isSearchPath: false,
    insideActiveWindow: rootInsideActiveWindow
  };
  const rows = [wrapperRow, ...movedRows];
  refreshVisibleRowStructure(rows);
  return { rows, removedRanges };
}

function refreshRowsFromPatchNodes(
  state: OutlineState,
  projection: VisibleTreeProjection,
  updatedNodes: readonly OutlineNode[]
): void {
  const updatedNodeIds = new Set(updatedNodes.map((node) => node.id));
  for (const row of projection.rows) {
    if (!updatedNodeIds.has(row.nodeId)) {
      continue;
    }
    const node = state.nodes[row.nodeId];
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
}

function refreshProjectionActiveWindowFlags(state: OutlineState, projection: VisibleTreeProjection): void {
  const activeByDepth: boolean[] = [];

  for (const row of projection.rows) {
    activeByDepth.length = row.depth;
    const parentInsideActiveWindow = row.depth > 0 ? activeByDepth[row.depth - 1] === true : false;
    const node = state.nodes[row.nodeId];
    row.insideActiveWindow = parentInsideActiveWindow;
    activeByDepth[row.depth] = parentInsideActiveWindow || Boolean(node?.kind === "window" && node.active);
  }
}

function refreshProjectionActiveTabTarget(state: OutlineState, projection: VisibleTreeProjection): void {
  delete projection.activeTabNodeId;
  delete projection.activeTabRowIndex;

  for (const row of projection.rows) {
    const node = state.nodes[row.nodeId];
    if (
      node?.kind === "tab" &&
      node.active &&
      row.insideActiveWindow &&
      !isOutlinerSidebarNode(node)
    ) {
      projection.activeTabNodeId = node.id;
      projection.activeTabRowIndex = row.index;
      return;
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
