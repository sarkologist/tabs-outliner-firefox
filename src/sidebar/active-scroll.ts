import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";

export type ActiveTabScrollTracker = {
  observedActiveNodeId?: NodeId;
};

export function createActiveTabScrollTracker(): ActiveTabScrollTracker {
  return {};
}

export function findActiveTabNodeId(state: OutlineState): NodeId | undefined {
  for (const rootId of state.rootIds) {
    const activeNodeId = findActiveTabInSubtree(state, rootId, false);
    if (activeNodeId) {
      return activeNodeId;
    }
  }

  return undefined;
}

export function observeActiveTabScrollTarget(
  tracker: ActiveTabScrollTracker,
  state: OutlineState,
  options: { hasRenderedNode?: (nodeId: NodeId) => boolean } = {}
): NodeId | undefined {
  const activeNodeId = findActiveTabNodeId(state);
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

function findActiveTabInSubtree(
  state: OutlineState,
  nodeId: NodeId,
  insideActiveWindow: boolean
): NodeId | undefined {
  const node = state.nodes[nodeId];
  if (!node) {
    return undefined;
  }

  if (isRenderedActiveTab(node, insideActiveWindow)) {
    return node.id;
  }

  const childInsideActiveWindow = insideActiveWindow || isActiveWindow(node);
  for (const childId of node.childIds) {
    const activeNodeId = findActiveTabInSubtree(state, childId, childInsideActiveWindow);
    if (activeNodeId) {
      return activeNodeId;
    }
  }

  return undefined;
}

function isActiveWindow(node: OutlineNode): boolean {
  return node.kind === "window" && Boolean(node.active);
}

function isRenderedActiveTab(node: OutlineNode, insideActiveWindow: boolean): boolean {
  return node.kind === "tab" && Boolean(node.active) && insideActiveWindow;
}
