import { cloneOutlineNode } from "./history.js";
import { repairState } from "../model/outline.js";
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

  const mutable = (): OutlineState => {
    guarded ??= cloneOutlineStateShallow(next);
    return guarded;
  };

  for (const [nodeId, previousNode] of Object.entries(previous.nodes)) {
    if (previousNode.status !== "closed" || allowDeletedNodeIds.has(nodeId)) {
      continue;
    }
    const nextNode = next.nodes[nodeId];
    if (nextNode?.status === "live") {
      continue;
    }
    if (nextNode && nodeIsReachableFromRoot(next, nodeId)) {
      continue;
    }

    copyClosedSubtree(previous, mutable(), closedAncestorRoot(previous, nodeId), allowDeletedNodeIds, restoredNodeIds);
  }

  return restoredNodeIds.size > 0
    ? {
        state: repairState(mutable()),
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
  if (allowDeletedNodeIds.has(nodeId)) {
    return undefined;
  }
  const previousNode = previous.nodes[nodeId];
  if (!previousNode || previousNode.status !== "closed") {
    return undefined;
  }
  const targetNode = target.nodes[nodeId];
  if (targetNode?.status === "live") {
    return nodeId;
  }

  const copied = cloneOutlineNode(previousNode);
  copied.childIds = previousNode.childIds.flatMap((childId) => {
    const copiedChildId = copyClosedSubtree(previous, target, childId, allowDeletedNodeIds, restoredNodeIds);
    return copiedChildId ? [copiedChildId] : [];
  });
  target.nodes[nodeId] = copied;
  restoredNodeIds.add(nodeId);
  return nodeId;
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

function nodeIsReachableFromRoot(state: OutlineState, nodeId: NodeId): boolean {
  const visited = new Set<NodeId>();
  const stack = [...state.rootIds];
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (currentId === nodeId) {
      return true;
    }
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    const node = state.nodes[currentId];
    if (!node) {
      continue;
    }
    for (const childId of node.childIds) {
      stack.push(childId);
    }
  }
  return false;
}

function cloneOutlineStateShallow(state: OutlineState): OutlineState {
  return {
    version: state.version,
    rootIds: [...state.rootIds],
    nodes: { ...state.nodes }
  };
}
