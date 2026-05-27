import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";

export function mergePartialOutlineState(
  current: OutlineState | undefined,
  incoming: OutlineState,
  options: { completeSiblingParentIds?: ReadonlySet<NodeId> } = {}
): OutlineState {
  if (!current) {
    return incoming;
  }

  const completeSiblingParentIds = options.completeSiblingParentIds ?? new Set<NodeId>();
  const nodes: OutlineState["nodes"] = { ...current.nodes };
  for (const [nodeId, node] of Object.entries(incoming.nodes)) {
    const currentNode = current.nodes[nodeId];
    nodes[nodeId] = mergePartialOutlineNode(currentNode, node, completeSiblingParentIds.has(nodeId));
  }

  return {
    version: current.version,
    rootIds: mergeKnownNodeIds(current.rootIds, incoming.rootIds),
    nodes
  };
}

function mergePartialOutlineNode(
  currentNode: OutlineNode | undefined,
  incomingNode: OutlineNode,
  incomingSiblingsComplete: boolean
): OutlineNode {
  if (!currentNode) {
    return incomingNode;
  }

  const baseNode = currentNode.updatedAt > incomingNode.updatedAt ? currentNode : incomingNode;
  if (incomingSiblingsComplete) {
    return baseNode;
  }

  return {
    ...baseNode,
    childIds: mergeKnownNodeIds(currentNode.childIds, incomingNode.childIds)
  };
}

function mergeKnownNodeIds(current: readonly NodeId[], incoming: readonly NodeId[]): NodeId[] {
  const known = new Set<NodeId>();
  const merged: NodeId[] = [];

  for (const nodeId of current) {
    if (!known.has(nodeId)) {
      known.add(nodeId);
      merged.push(nodeId);
    }
  }
  for (const nodeId of incoming) {
    if (!known.has(nodeId)) {
      known.add(nodeId);
      merged.push(nodeId);
    }
  }

  return merged;
}
