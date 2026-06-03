import { cloneOutlineNode } from "./history.js";
import type { NodeId, OutlineState } from "../model/types.js";

export type ClosedSubtreeGuardResult = {
  state: OutlineState;
  restoredNodeIds: NodeId[];
};

export function preserveClosedSubtreesAcrossNonDestructiveTransition(
  previous: OutlineState,
  next: OutlineState,
  options: { allowDeletedNodeIds?: ReadonlySet<NodeId> } = {}
): ClosedSubtreeGuardResult {
  const allowDeletedNodeIds = options.allowDeletedNodeIds ?? new Set<NodeId>();
  let guarded: OutlineState | undefined;
  const restoredNodeIds = new Set<NodeId>();
  const reachableNodeIds = reachableNodeIdsFromRoots(next);

  const mutable = (): OutlineState => {
    guarded ??= cloneOutlineStateShallow(next);
    return guarded;
  };

  for (const [nodeId, previousNode] of Object.entries(previous.nodes)) {
    if (previousNode.status !== "closed" || allowDeletedNodeIds.has(nodeId) || restoredNodeIds.has(nodeId)) {
      continue;
    }
    const nextNode = next.nodes[nodeId];
    if (nextNode?.status === "live") {
      continue;
    }
    if (nextNode && reachableNodeIds.has(nodeId)) {
      continue;
    }

    const restoreRootId = closedAncestorRoot(previous, nodeId);
    const copiedRootId = copyClosedSubtree(previous, mutable(), restoreRootId, allowDeletedNodeIds, restoredNodeIds);
    if (copiedRootId) {
      attachRestoredSubtreeRoot(previous, mutable(), copiedRootId);
    }
  }

  return restoredNodeIds.size > 0
    ? {
        state: mutable(),
        restoredNodeIds: [...restoredNodeIds]
      }
    : {
        state: next,
        restoredNodeIds: []
      };
}

function copyClosedSubtree(
  previous: OutlineState,
  target: OutlineState,
  nodeId: NodeId,
  allowDeletedNodeIds: ReadonlySet<NodeId>,
  restoredNodeIds: Set<NodeId>
): NodeId | undefined {
  const copiedNodeIds = new Set<NodeId>();
  const visitedNodeIds = new Set<NodeId>();
  const stack: Array<{ nodeId: NodeId; exiting: boolean }> = [{ nodeId, exiting: false }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (allowDeletedNodeIds.has(current.nodeId)) {
      continue;
    }
    if (restoredNodeIds.has(current.nodeId)) {
      copiedNodeIds.add(current.nodeId);
      continue;
    }
    const previousNode = previous.nodes[current.nodeId];
    if (!previousNode || previousNode.status !== "closed") {
      continue;
    }
    const targetNode = target.nodes[current.nodeId];
    if (targetNode?.status === "live") {
      copiedNodeIds.add(current.nodeId);
      continue;
    }

    if (current.exiting) {
      const copied = cloneOutlineNode(previousNode);
      copied.childIds = previousNode.childIds.filter((childId) => copiedNodeIds.has(childId));
      target.nodes[current.nodeId] = copied;
      restoredNodeIds.add(current.nodeId);
      copiedNodeIds.add(current.nodeId);
      continue;
    }

    if (visitedNodeIds.has(current.nodeId)) {
      continue;
    }
    visitedNodeIds.add(current.nodeId);
    stack.push({ nodeId: current.nodeId, exiting: true });
    for (let index = previousNode.childIds.length - 1; index >= 0; index -= 1) {
      stack.push({ nodeId: previousNode.childIds[index]!, exiting: false });
    }
  }

  return copiedNodeIds.has(nodeId) ? nodeId : undefined;
}

function attachRestoredSubtreeRoot(previous: OutlineState, target: OutlineState, nodeId: NodeId): void {
  const previousNode = previous.nodes[nodeId];
  const targetNode = target.nodes[nodeId];
  if (!previousNode || !targetNode) {
    return;
  }

  const parentId = previousNode.parentId;
  const targetParent = parentId ? target.nodes[parentId] : undefined;
  if (parentId && targetParent) {
    targetNode.parentId = parentId;
    const mutableParent = cloneTargetNodeForMutation(target, parentId);
    insertNodeIdLikePrevious(mutableParent.childIds, previous.nodes[parentId]?.childIds ?? [], nodeId);
    removeNodeId(target.rootIds, nodeId);
    return;
  }

  delete targetNode.parentId;
  insertNodeIdLikePrevious(target.rootIds, previous.rootIds, nodeId);
}

function cloneTargetNodeForMutation(state: OutlineState, nodeId: NodeId) {
  const node = state.nodes[nodeId]!;
  const cloned = cloneOutlineNode(node);
  state.nodes[nodeId] = cloned;
  return cloned;
}

function insertNodeIdLikePrevious(targetIds: NodeId[], previousIds: readonly NodeId[], nodeId: NodeId): void {
  if (targetIds.includes(nodeId)) {
    return;
  }

  const previousIndex = previousIds.indexOf(nodeId);
  if (previousIndex < 0) {
    targetIds.push(nodeId);
    return;
  }

  for (let index = previousIndex - 1; index >= 0; index -= 1) {
    const anchorIndex = targetIds.indexOf(previousIds[index]!);
    if (anchorIndex >= 0) {
      targetIds.splice(anchorIndex + 1, 0, nodeId);
      return;
    }
  }

  for (let index = previousIndex + 1; index < previousIds.length; index += 1) {
    const anchorIndex = targetIds.indexOf(previousIds[index]!);
    if (anchorIndex >= 0) {
      targetIds.splice(anchorIndex, 0, nodeId);
      return;
    }
  }

  targetIds.push(nodeId);
}

function removeNodeId(ids: NodeId[], nodeId: NodeId): void {
  const index = ids.indexOf(nodeId);
  if (index >= 0) {
    ids.splice(index, 1);
  }
}

function reachableNodeIdsFromRoots(state: OutlineState): Set<NodeId> {
  const reachableNodeIds = new Set<NodeId>();
  const stack = [...state.rootIds];
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (reachableNodeIds.has(currentId)) {
      continue;
    }
    reachableNodeIds.add(currentId);

    const node = state.nodes[currentId];
    if (!node) {
      continue;
    }
    for (const childId of node.childIds) {
      stack.push(childId);
    }
  }
  return reachableNodeIds;
}

function closedAncestorRoot(state: OutlineState, nodeId: NodeId): NodeId {
  let currentId = nodeId;
  const visited = new Set<NodeId>();
  while (!visited.has(currentId)) {
    visited.add(currentId);
    const current = state.nodes[currentId];
    const parentId = current?.parentId;
    const parent = parentId ? state.nodes[parentId] : undefined;
    if (!parentId || !parent || parent.status !== "closed") {
      return currentId;
    }
    currentId = parentId;
  }
  return nodeId;
}

function cloneOutlineStateShallow(state: OutlineState): OutlineState {
  return {
    version: state.version,
    rootIds: [...state.rootIds],
    nodes: { ...state.nodes }
  };
}
