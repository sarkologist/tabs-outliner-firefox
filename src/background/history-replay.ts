import { cloneOutlineNode } from "../model/outline.js";
import { isLiveWindowNode, liveWindowNodes } from "../model/live-nodes.js";
import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import { normalizeBrowserCreateUrl } from "./browser-create-url.js";
import { addSubtreeNodeIds, liveTabNodesInSubtree } from "./live-node-queries.js";

// In-place outline mutations used when replaying history (undo/redo) deltas, extracted from
// controller.ts (no behavior change). These mutate the passed OutlineState directly; callers
// pass a state they own. Depends only on model helpers + the live-node-queries leaf cluster.

export function deleteHistoryReplayTabNode(state: OutlineState, nodeId: NodeId): void {
  const node = state.nodes[nodeId];
  if (!node) {
    return;
  }

  const promotedChildIds = [...node.childIds];
  const siblings = node.parentId ? state.nodes[node.parentId]?.childIds : state.rootIds;
  if (siblings) {
    const index = siblings.indexOf(nodeId);
    if (index >= 0) {
      siblings.splice(index, 1, ...promotedChildIds);
    }
  }

  for (const childId of promotedChildIds) {
    const child = state.nodes[childId];
    if (!child) {
      continue;
    }
    if (node.parentId) {
      child.parentId = node.parentId;
    } else {
      delete child.parentId;
    }
  }

  delete state.nodes[nodeId];
}

export function moveHistoryReplayNodeToParent(state: OutlineState, nodeId: NodeId, parentId: NodeId): void {
  const node = cloneNodeForHistoryMutation(state, nodeId);
  const parent = cloneNodeForHistoryMutation(state, parentId);
  if (!node || !parent) {
    return;
  }

  if (node.parentId) {
    const previousParent = cloneNodeForHistoryMutation(state, node.parentId);
    if (previousParent) {
      previousParent.childIds = previousParent.childIds.filter((childId) => childId !== nodeId);
    }
  } else {
    state.rootIds = state.rootIds.filter((rootId) => rootId !== nodeId);
  }

  node.parentId = parentId;
  node.updatedAt = Date.now();
  if (!parent.childIds.includes(nodeId)) {
    parent.childIds = [...parent.childIds, nodeId];
  }
}

export function deleteHistoryReplayContainerNode(state: OutlineState, nodeId: NodeId): void {
  const node = state.nodes[nodeId];
  if (!node || node.childIds.length > 0) {
    return;
  }

  if (node.parentId) {
    const parent = cloneNodeForHistoryMutation(state, node.parentId);
    if (parent) {
      parent.childIds = parent.childIds.filter((childId) => childId !== nodeId);
    }
  } else {
    state.rootIds = state.rootIds.filter((rootId) => rootId !== nodeId);
  }

  delete state.nodes[nodeId];
}

export function deleteHistoryReplaySubtree(state: OutlineState, nodeId: NodeId): void {
  const node = state.nodes[nodeId];
  if (!node) {
    return;
  }

  if (node.parentId) {
    const parent = cloneNodeForHistoryMutation(state, node.parentId);
    if (parent) {
      parent.childIds = parent.childIds.filter((childId) => childId !== nodeId);
    }
  } else {
    state.rootIds = state.rootIds.filter((rootId) => rootId !== nodeId);
  }

  const deletedNodeIds = new Set<NodeId>();
  addSubtreeNodeIds(state, nodeId, deletedNodeIds);
  for (const deletedNodeId of deletedNodeIds) {
    delete state.nodes[deletedNodeId];
  }
}

export function replaceLiveWindowIdInSubtree(state: OutlineState, windowNodeId: NodeId, windowId: number): void {
  const windowNode = cloneNodeForHistoryMutation(state, windowNodeId);
  if (isLiveWindowNode(windowNode)) {
    windowNode.live = { windowId };
  }

  for (const tabNode of liveTabNodesInSubtree(state, windowNodeId)) {
    updateLiveTabRef(state, tabNode.id, tabNode.live.tabId, windowId);
  }
}

export function updateLiveTabRef(state: OutlineState, nodeId: NodeId, tabId: number, windowId: number): void {
  const node = cloneNodeForHistoryMutation(state, nodeId);
  if (!node || node.kind !== "tab") {
    return;
  }
  node.status = "live";
  node.live = { tabId, windowId };
  node.updatedAt = Date.now();
  delete node.closedAt;
  delete node.restore;
}

export function cloneNodeForHistoryMutation(state: OutlineState, nodeId: NodeId): OutlineNode | undefined {
  const node = state.nodes[nodeId];
  if (!node) {
    return undefined;
  }
  const cloned = cloneOutlineNode(node);
  state.nodes[nodeId] = cloned;
  return cloned;
}

export function nearestLiveWindowId(state: OutlineState, nodeId: NodeId): number | undefined {
  const seen = new Set<NodeId>();
  let current = state.nodes[nodeId];

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (isLiveWindowNode(current)) {
      return current.live.windowId;
    }
    current = current.parentId ? state.nodes[current.parentId] : undefined;
  }

  return liveWindowNodes(state)[0]?.live.windowId;
}

export function historyNodeUrl(node: OutlineNode): string {
  return normalizeBrowserCreateUrl(node.url ?? node.restore?.url);
}
