import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";

export type ActiveTabScrollTracker = {
  observedActiveNodeId?: NodeId;
};

export type ActiveTabScrollProjection = {
  activeTabNodeId?: NodeId;
  activeTabRowIndex?: number;
  visibleNodeIdSet: Set<NodeId>;
};

export type ActiveTabScrollViewport = {
  scrollTop: number;
  clientHeight: number;
};

export function createActiveTabScrollTracker(): ActiveTabScrollTracker {
  return {};
}

export function findActiveTabNodeId(state: OutlineState): NodeId | undefined {
  const visited = new Set<NodeId>();
  const stack: Array<{ nodeId: NodeId; insideActiveWindow: boolean }> = [];

  for (let index = state.rootIds.length - 1; index >= 0; index -= 1) {
    stack.push({ nodeId: state.rootIds[index]!, insideActiveWindow: false });
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

    if (isRenderedActiveTab(node, entry.insideActiveWindow)) {
      return node.id;
    }

    const childInsideActiveWindow = entry.insideActiveWindow || isActiveWindow(node);
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push({ nodeId: node.childIds[index]!, insideActiveWindow: childInsideActiveWindow });
    }
  }

  return undefined;
}

export function observeActiveTabScrollTarget(
  tracker: ActiveTabScrollTracker,
  state: OutlineState,
  options: { hasRenderedNode?: (nodeId: NodeId) => boolean } = {}
): NodeId | undefined {
  return observeActiveTabNodeId(tracker, findActiveTabNodeId(state), options);
}

export function observeActiveTabNodeId(
  tracker: ActiveTabScrollTracker,
  activeNodeId: NodeId | undefined,
  options: { hasRenderedNode?: (nodeId: NodeId) => boolean } = {}
): NodeId | undefined {
  if (tracker.observedActiveNodeId === activeNodeId) {
    return undefined;
  }

  if (activeNodeId) {
    tracker.observedActiveNodeId = activeNodeId;
  } else {
    delete tracker.observedActiveNodeId;
  }

  if (!activeNodeId) {
    return undefined;
  }

  if (options.hasRenderedNode && !options.hasRenderedNode(activeNodeId)) {
    return undefined;
  }

  return activeNodeId;
}

export function scrollActiveTabIntoView(
  tracker: ActiveTabScrollTracker,
  projection: ActiveTabScrollProjection,
  viewport: ActiveTabScrollViewport | undefined,
  rowHeight: number
): boolean {
  const nodeId = observeActiveTabNodeId(tracker, projection.activeTabNodeId, {
    hasRenderedNode: (candidate) => projection.visibleNodeIdSet.has(candidate)
  });
  if (!nodeId || typeof projection.activeTabRowIndex !== "number" || !viewport) {
    return false;
  }

  const effectiveRowHeight = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 1;
  const rowTop = projection.activeTabRowIndex * effectiveRowHeight;
  const rowBottom = rowTop + effectiveRowHeight;
  const viewportTop = viewport.scrollTop;
  const viewportBottom = viewportTop + viewport.clientHeight;
  let nextScrollTop = viewportTop;

  if (rowTop < viewportTop) {
    nextScrollTop = rowTop;
  } else if (rowBottom > viewportBottom) {
    nextScrollTop = Math.max(0, rowBottom - viewport.clientHeight);
  }

  if (nextScrollTop === viewportTop) {
    return false;
  }

  viewport.scrollTop = nextScrollTop;
  return true;
}

function isActiveWindow(node: OutlineNode): boolean {
  return node.kind === "window" && Boolean(node.active);
}

function isRenderedActiveTab(node: OutlineNode, insideActiveWindow: boolean): boolean {
  return node.kind === "tab" && Boolean(node.active) && insideActiveWindow;
}
