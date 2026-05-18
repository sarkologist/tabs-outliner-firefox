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
  scrollHeight?: number;
};

export function createActiveTabScrollTracker(): ActiveTabScrollTracker {
  return {};
}

export function resetActiveTabScrollTracker(tracker: ActiveTabScrollTracker): void {
  delete tracker.observedActiveNodeId;
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

  if (!activeNodeId) {
    delete tracker.observedActiveNodeId;
    return undefined;
  }

  if (options.hasRenderedNode && !options.hasRenderedNode(activeNodeId)) {
    return undefined;
  }

  tracker.observedActiveNodeId = activeNodeId;
  return activeNodeId;
}

export function scrollActiveTabIntoView(
  tracker: ActiveTabScrollTracker,
  projection: ActiveTabScrollProjection,
  viewport: ActiveTabScrollViewport | undefined,
  rowHeight: number
): boolean {
  const activeNodeId = projection.activeTabNodeId;
  if (!activeNodeId) {
    resetActiveTabScrollTracker(tracker);
    return false;
  }

  if (!projection.visibleNodeIdSet.has(activeNodeId) || typeof projection.activeTabRowIndex !== "number") {
    return false;
  }

  if (
    tracker.observedActiveNodeId === activeNodeId ||
    !viewport ||
    !Number.isFinite(viewport.clientHeight) ||
    viewport.clientHeight <= 0
  ) {
    return false;
  }

  const effectiveRowHeight = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 1;
  const rowTop = projection.activeTabRowIndex * effectiveRowHeight;
  const viewportTop = viewport.scrollTop;
  const centeredScrollTop = Math.max(0, rowTop + effectiveRowHeight / 2 - viewport.clientHeight / 2);
  let nextScrollTop = centeredScrollTop;
  const scrollHeight = viewport.scrollHeight;

  if (typeof scrollHeight === "number" && Number.isFinite(scrollHeight)) {
    if (scrollHeight <= viewport.clientHeight && centeredScrollTop > 0) {
      return false;
    }
    nextScrollTop = Math.min(centeredScrollTop, Math.max(0, scrollHeight - viewport.clientHeight));
  }

  if (nextScrollTop === viewportTop) {
    tracker.observedActiveNodeId = activeNodeId;
    return false;
  }

  viewport.scrollTop = nextScrollTop;
  if (viewport.scrollTop === viewportTop) {
    return false;
  }

  tracker.observedActiveNodeId = activeNodeId;
  return true;
}

function isActiveWindow(node: OutlineNode): boolean {
  return node.kind === "window" && Boolean(node.active);
}

function isRenderedActiveTab(node: OutlineNode, insideActiveWindow: boolean): boolean {
  return node.kind === "tab" && Boolean(node.active) && insideActiveWindow;
}
