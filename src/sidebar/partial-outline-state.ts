import type { NodeId, OutlineState } from "../model/types.js";

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
    nodes[nodeId] = currentNode && !completeSiblingParentIds.has(nodeId)
      ? {
          ...node,
          childIds: mergeKnownNodeIds(currentNode.childIds, node.childIds)
        }
      : node;
  }

  return {
    version: current.version,
    rootIds: mergeKnownNodeIds(current.rootIds, incoming.rootIds),
    nodes
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
